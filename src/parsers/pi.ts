// Parser for pi (pi-coding-agent) session JSONL files.
//
// Line 1 is the header `{"type":"session","version":3,"id","timestamp","cwd"}`;
// every other line is a tree entry `{"type","id","parentId","timestamp",…}`
// appended in chronological order:
// - message (message.role user)      → a `turn` span until the next prompt;
//   gaps > 2 s before a prompt become `idle` spans.
// - message (role assistant)         → a `model` span ending at the entry's
//   timestamp and starting at the previous entry's (the prompt or the last
//   tool result), so it covers the real API latency. `usage` maps 1:1
//   (input excludes cached tokens; `reasoning` is a subset of output).
//   Each `toolCall` content block → a `tool` span from the assistant entry
//   to the matching `toolResult` message (toolCallId). For `bash` the tool
//   payload input is the raw command string so drip launches are detectable.
// - model_change                     → provider/model for later messages.
// - compaction / branch_summary      → a `model` span when they carry usage.
// - thinking_level_change, custom, custom_message, label → ignored;
//   session_info.name becomes the session title.
// Parsers NEVER throw: malformed lines are skipped and recorded as warnings.

import type { ContextItem, Session, Span, SpanPayload, Usage } from '../model.ts';
import { baseSession, capText, finishSession, makeSpan, parseTs, truncate, tryParse } from './util.ts';

const IDLE_THRESHOLD_MS = 2000;

interface Prompt {
  ts: number;
  text: string;
}

interface ToolCall {
  id: string;
  name: string;
  input: string; // full input text (command for bash, JSON otherwise)
  ts: number; // the assistant entry that issued it
}

interface ToolResult {
  ts: number;
  text: string;
  isError: boolean;
  name: string;
}

interface ModelGroup {
  start: number;
  end: number;
  name: string;
  model: string | undefined;
  provider: string | undefined;
  usage: Usage | undefined;
  text: string;
  thinking: string;
  stopReason: string | undefined;
  ok: boolean | undefined;
  toolCalls: ToolCall[];
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Text of a content field: a plain string or the text blocks of an array. */
function contentText(content: unknown, key: 'text' | 'thinking' = 'text'): string {
  if (typeof content === 'string') return key === 'text' ? content : '';
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    const b = asObject(block);
    if (b === null) continue;
    if (b.type === key && typeof b[key] === 'string') parts.push(b[key] as string);
  }
  return parts.join('\n');
}

function readUsage(raw: unknown): Usage | undefined {
  const u = asObject(raw);
  if (u === null) return undefined;
  const usage: Usage = {
    input: finite(u.input) ?? 0,
    cacheRead: finite(u.cacheRead) ?? 0,
    cacheWrite: finite(u.cacheWrite) ?? 0,
    output: finite(u.output) ?? 0,
  };
  const oneHour = finite(u.cacheWrite1h);
  if (oneHour !== undefined) usage.cacheWrite1h = oneHour;
  const reasoning = finite(u.reasoning);
  if (reasoning !== undefined) usage.reasoning = reasoning;
  return usage;
}

/** Tool input text: the raw shell command for bash, pretty JSON otherwise. */
function toolInputText(name: string, args: unknown): string {
  const a = asObject(args);
  if (name === 'bash' && a !== null && typeof a.command === 'string') return a.command;
  try {
    return JSON.stringify(args ?? {}, null, 2);
  } catch {
    return '';
  }
}

export function parsePi(text: string, fileName: string): Session {
  const warnings: string[] = [];
  const session = baseSession('pi', fileName, fileName);
  const root = session.root;

  let headerStart = NaN;
  let currentModel: string | undefined;
  let currentProvider: string | undefined;
  let prevTs = NaN; // timestamp of the previous entry (any type)
  let firstTs = NaN;
  let lastTs = NaN;
  let sessionName = '';
  const prompts: Prompt[] = [];
  const groups: ModelGroup[] = [];
  const results = new Map<string, ToolResult>();

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue;
    const rec = tryParse(line);
    if (rec === null) continue; // counted by the dispatcher
    const type = str(rec.type);

    if (type === 'session') {
      if (typeof rec.id === 'string' && rec.id.length > 0) session.id = rec.id;
      headerStart = parseTs(rec.timestamp);
      const meta: Record<string, string | number> = {};
      if (typeof rec.cwd === 'string') meta.cwd = rec.cwd;
      if (typeof rec.version === 'number') meta.version = rec.version;
      root.meta = { ...root.meta, ...meta };
      if (Number.isFinite(headerStart)) prevTs = headerStart;
      continue;
    }

    const ts = parseTs(rec.timestamp);
    if (!Number.isFinite(ts)) {
      warnings.push(`line ${i + 1}: entry without a timestamp skipped`);
      continue;
    }
    if (Number.isNaN(firstTs)) firstTs = ts;
    if (Number.isNaN(lastTs) || ts > lastTs) lastTs = ts;
    const before = Number.isFinite(prevTs) ? Math.min(prevTs, ts) : ts;
    prevTs = ts;

    switch (type) {
      case 'model_change':
        if (typeof rec.modelId === 'string') currentModel = rec.modelId;
        if (typeof rec.provider === 'string') currentProvider = rec.provider;
        break;
      case 'session_info':
        if (typeof rec.name === 'string' && rec.name.trim().length > 0) sessionName = rec.name.trim();
        break;
      case 'compaction':
      case 'branch_summary': {
        const usage = readUsage(rec.usage);
        if (usage === undefined) break;
        groups.push({
          start: before,
          end: ts,
          name: type === 'compaction' ? 'compaction' : 'branch summary',
          model: currentModel,
          provider: currentProvider,
          usage,
          text: str(rec.summary),
          thinking: '',
          stopReason: undefined,
          ok: undefined,
          toolCalls: [],
        });
        break;
      }
      case 'message': {
        const msg = asObject(rec.message);
        if (msg === null) {
          warnings.push(`line ${i + 1}: message entry without a message skipped`);
          break;
        }
        const role = str(msg.role);
        if (role === 'user') {
          const promptText = contentText(msg.content);
          prompts.push({ ts, text: promptText });
        } else if (role === 'assistant') {
          const model = str(msg.model) || currentModel;
          const provider = str(msg.provider) || currentProvider;
          const stopReason = typeof msg.stopReason === 'string' ? msg.stopReason : undefined;
          const errorMessage = typeof msg.errorMessage === 'string' && msg.errorMessage.length > 0 ? msg.errorMessage : undefined;
          if (errorMessage !== undefined) warnings.push(`model call failed: ${truncate(errorMessage, 160)}`);
          const toolCalls: ToolCall[] = [];
          if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              const b = asObject(block);
              if (b === null || b.type !== 'toolCall') continue;
              const name = str(b.name) || 'tool';
              toolCalls.push({ id: str(b.id), name, input: toolInputText(name, b.arguments), ts });
            }
          }
          groups.push({
            start: before,
            end: ts,
            name: model ?? 'model',
            model,
            provider,
            usage: readUsage(msg.usage),
            text: contentText(msg.content),
            thinking: contentText(msg.content, 'thinking'),
            stopReason,
            ok: errorMessage !== undefined || stopReason === 'error' || stopReason === 'aborted' ? false : undefined,
            toolCalls,
          });
        } else if (role === 'toolResult') {
          const id = str(msg.toolCallId);
          results.set(id, {
            ts,
            text: contentText(msg.content),
            isError: msg.isError === true,
            name: str(msg.toolName),
          });
        }
        break;
      }
      default:
        break; // thinking_level_change, custom, custom_message, label, …
    }
  }

  // Root window.
  const start = Number.isFinite(headerStart) ? headerStart : firstTs;
  if (Number.isFinite(start)) {
    root.startMs = start;
    root.endMs = Math.max(Number.isFinite(lastTs) ? lastTs : start, start);
  }
  if (groups.length === 0 && prompts.length === 0) {
    warnings.push('no pi messages found');
  }

  // Every timestamp that can extend a turn: model ends, tool results.
  const activity: number[] = [];
  for (const g of groups) activity.push(g.end);
  for (const r of results.values()) activity.push(r.ts);
  activity.sort((a, b) => a - b);

  // Turn spans: one per prompt, running until the next prompt (idle gaps > 2 s
  // become idle spans); the last turn runs to the end of the transcript.
  const turns: { span: Span; start: number; end: number }[] = [];
  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i]!;
    const windowEnd = i + 1 < prompts.length ? prompts[i + 1]!.ts : Infinity;
    let activeEnd = prompt.ts;
    for (const t of activity) {
      if (t <= prompt.ts) continue;
      if (t >= windowEnd) break;
      if (t > activeEnd) activeEnd = t;
    }
    const span = makeSpan('turn', turnName(prompt.text), prompt.ts, Math.max(activeEnd, prompt.ts), 'root', {
      detail: truncate(prompt.text),
    });
    root.children.push(span);
    turns.push({ span, start: prompt.ts, end: Math.max(activeEnd, prompt.ts) });
    if (i + 1 < prompts.length && windowEnd - activeEnd > IDLE_THRESHOLD_MS) {
      root.children.push(makeSpan('idle', 'idle', activeEnd, windowEnd, 'root'));
    }
  }
  const turnFor = (ts: number): Span => {
    for (const turn of turns) if (ts >= turn.start && ts <= turn.end) return turn.span;
    if (turns.length === 0 || ts < turns[0]!.start) return root;
    return turns[turns.length - 1]!.span;
  };

  // Model spans (with newContext since the previous model call) and their tool spans.
  let prevEnd: number | undefined;
  for (const group of groups) {
    const parent = turnFor(group.start);
    const payload = modelPayload(group, prevEnd, prompts, results, groups);
    const span = makeSpan('model', group.name, group.start, Math.max(group.end, group.start + 1), parent.id, {
      model: group.model,
      provider: group.provider,
      usage: group.usage,
      detail: truncate(group.text),
      payload,
      ...(group.ok === false ? { ok: false } : {}),
    });
    parent.children.push(span);
    prevEnd = group.end;
    for (const call of group.toolCalls) {
      const result = results.get(call.id);
      const end = result !== undefined && result.ts >= call.ts ? result.ts : nextEntryAfter(call.ts, activity, root.endMs);
      const output = capText(result?.text);
      const input = capText(call.input);
      const tool = makeSpan('tool', call.name, call.ts, Math.max(end, call.ts + 1), parent.id, {
        toolName: call.name,
        toolInput: truncate(call.input),
        ok: result === undefined ? undefined : !result.isError,
        detail: truncate(call.input),
        payload: {
          input: input.text,
          output: output.text.length > 0 ? output.text : undefined,
          truncated: input.truncated || output.truncated || undefined,
        },
      });
      parent.children.push(tool);
      if (result === undefined) warnings.push(`tool call ${call.name} (${call.id || 'no id'}) has no result`);
    }
  }
  for (const turn of turns) turn.span.children.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  root.children.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  for (const child of root.children) if (child.endMs > root.endMs) root.endMs = child.endMs;

  session.title = sessionName.length > 0 ? sessionName : prompts.length > 0 ? truncate(firstLine(prompts[0]!.text), 80) : fileName;
  return finishSession(session, warnings);
}

/** The next activity timestamp after `ts`, or `fallback` — closes unmatched tool calls. */
function nextEntryAfter(ts: number, activity: number[], fallback: number): number {
  for (const t of activity) if (t > ts) return t;
  return fallback;
}

function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
}

function turnName(text: string): string {
  const line = firstLine(text);
  return line.length > 0 ? truncate(line, 80) : 'prompt';
}

/**
 * Model payload: response text/thinking/stop reason plus newContext — the
 * prompts and tool results appended since the previous model call.
 */
function modelPayload(
  group: ModelGroup,
  prevEnd: number | undefined,
  prompts: Prompt[],
  results: Map<string, ToolResult>,
  groups: ModelGroup[],
): SpanPayload {
  const output = capText(group.text.length > 0 ? group.text : undefined);
  const thinking = group.thinking.length > 0 ? capText(group.thinking) : undefined;
  let truncated = output.truncated || (thinking?.truncated ?? false);
  const windowStart = prevEnd ?? -Infinity;
  const items: ContextItem[] = [];
  for (const prompt of prompts) {
    if (prompt.ts <= windowStart || prompt.ts > group.start || prompt.text.length === 0) continue;
    const capped = capText(prompt.text);
    truncated = truncated || capped.truncated;
    items.push({ role: 'user', label: 'user prompt', text: capped.text, chars: prompt.text.length });
  }
  const nameOf = new Map<string, string>();
  for (const g of groups) for (const call of g.toolCalls) nameOf.set(call.id, call.name);
  for (const [id, result] of results) {
    if (result.ts <= windowStart || result.ts > group.start || result.text.length === 0) continue;
    const capped = capText(result.text);
    truncated = truncated || capped.truncated;
    items.push({
      role: 'tool_result',
      label: `${result.name || nameOf.get(id) || 'tool'} result`,
      text: capped.text,
      chars: result.text.length,
      ok: !result.isError,
    });
  }
  items.sort((a, b) => (a.role === b.role ? 0 : a.role === 'user' ? -1 : 1));
  return {
    output: output.text.length > 0 ? output.text : undefined,
    thinking: thinking?.text,
    stopReason: group.stopReason,
    newContext: items,
    truncated: truncated || undefined,
  };
}
