// Parser for OpenCode sessions.
//
// Input is flattened JSONL — one record per row of OpenCode's store, as
// produced by src/index/opencode-db.ts from the SQLite database or by
// `flattenOpencodeExport` from an `opencode export` JSON document:
//   {"type":"opencode.session","data":{id, slug, projectID, directory, title,
//     version, parentID?, model, tokens, cost, time:{created, updated}}}
//   {"type":"opencode.message","data":{id, sessionID, role, time:{created,
//     completed?}, modelID?, providerID?, tokens?, error?, finish?}}
//   {"type":"opencode.part","data":{id, sessionID, messageID, type, …}}
// Mapping:
// - the first session record is the session; later ones (parentID set) are
//   sub-agent sessions, drawn as `subagent` spans under the turn active when
//   they were created, holding their own model/tool spans.
// - user messages → `turn` spans (title from their text parts) until the
//   next prompt; gaps > 2 s become `idle` spans.
// - assistant messages → one `model` span per `step-finish` part (one step =
//   one API call): usage from its `tokens` (input already excludes cached
//   tokens; cache.read/write; reasoning), window from the previous step's
//   end (or message time.created) to the latest `time.end` of the step's
//   parts (else time.completed). A message without step-finish (an API
//   error) is one model span with the message's tokens and ok=false.
// - `tool` parts → `tool` spans (state.time.start/end, state.status); for
//   `bash` the payload input is the raw command so lci launches are
//   detectable; other tools get their input as JSON.
// - text parts → model output, reasoning parts → thinking.
// Parsers NEVER throw: malformed lines are skipped and recorded as warnings.

import type { ContextItem, Session, Span, SpanPayload, Usage } from '../model.ts';
import { baseSession, capText, finishSession, makeSpan, truncate, tryParse } from './util.ts';

const IDLE_THRESHOLD_MS = 2000;

interface OcSession {
  id: string;
  parentId: string | null;
  title: string;
  directory: string;
  createdMs: number;
  updatedMs: number;
  data: Record<string, unknown>;
}

interface OcMessage {
  id: string;
  sessionId: string;
  role: string;
  createdMs: number;
  completedMs: number | undefined;
  model: string | undefined;
  provider: string | undefined;
  tokens: Usage | undefined;
  error: string | undefined;
  finish: string | undefined;
  parts: Record<string, unknown>[];
}

interface Step {
  start: number;
  end: number;
  usage: Usage | undefined;
  text: string;
  thinking: string;
  stopReason: string | undefined;
  tools: ToolPart[];
  finished: boolean;
}

interface ToolPart {
  name: string;
  input: string;
  output: string;
  ok: boolean | undefined;
  start: number;
  end: number;
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

function readTokens(raw: unknown): Usage | undefined {
  const t = asObject(raw);
  if (t === null) return undefined;
  const cache = asObject(t.cache);
  const usage: Usage = {
    input: finite(t.input) ?? 0,
    cacheRead: finite(cache?.read) ?? 0,
    cacheWrite: finite(cache?.write) ?? 0,
    output: finite(t.output) ?? 0,
  };
  const reasoning = finite(t.reasoning);
  if (reasoning !== undefined) usage.reasoning = reasoning;
  return usage;
}

function timeOf(raw: unknown, key: 'created' | 'completed' | 'updated' | 'start' | 'end'): number | undefined {
  return finite(asObject(raw)?.[key]);
}

function readSession(d: Record<string, unknown>): OcSession {
  return {
    id: str(d.id),
    parentId: typeof d.parentID === 'string' && d.parentID.length > 0 ? d.parentID : null,
    title: str(d.title),
    directory: str(d.directory),
    createdMs: timeOf(d.time, 'created') ?? NaN,
    updatedMs: timeOf(d.time, 'updated') ?? NaN,
    data: d,
  };
}

function readMessage(d: Record<string, unknown>): OcMessage | null {
  const createdMs = timeOf(d.time, 'created');
  if (createdMs === undefined) return null;
  const error = asObject(d.error);
  const errorText = error === null ? undefined : str(asObject(error.data)?.message) || str(error.name) || 'error';
  return {
    id: str(d.id),
    sessionId: str(d.sessionID),
    role: str(d.role),
    createdMs,
    completedMs: timeOf(d.time, 'completed'),
    model: str(d.modelID) || undefined,
    provider: str(d.providerID) || undefined,
    tokens: readTokens(d.tokens),
    error: errorText,
    finish: str(d.finish) || undefined,
    parts: [],
  };
}

/** Tool input text: the raw shell command for bash, pretty JSON otherwise. */
function toolInputText(name: string, input: unknown): string {
  const i = asObject(input);
  if (name === 'bash' && i !== null && typeof i.command === 'string') return i.command;
  try {
    return JSON.stringify(input ?? {}, null, 2);
  } catch {
    return '';
  }
}

/** Split an assistant message's parts into API-call steps. */
function stepsOf(msg: OcMessage): Step[] {
  const steps: Step[] = [];
  let cursor = msg.createdMs;
  const fresh = (): Step => ({ start: cursor, end: cursor, usage: undefined, text: '', thinking: '', stopReason: undefined, tools: [], finished: false });
  let step = fresh();
  let sawParts = false;
  for (const part of msg.parts) {
    const type = str(part.type);
    if (type === 'step-start') continue;
    sawParts = true;
    const end = timeOf(part.time, 'end');
    if (end !== undefined && end > step.end) step.end = end;
    if (type === 'text') {
      step.text += (step.text.length > 0 ? '\n' : '') + str(part.text);
    } else if (type === 'reasoning') {
      step.thinking += (step.thinking.length > 0 ? '\n' : '') + str(part.text);
    } else if (type === 'tool') {
      const state = asObject(part.state) ?? {};
      const name = str(part.tool) || 'tool';
      const status = str(state.status);
      const start = timeOf(state.time, 'start') ?? step.start;
      const toolEnd = timeOf(state.time, 'end') ?? (status === 'completed' || status === 'error' ? start : (msg.completedMs ?? start));
      step.tools.push({
        name,
        input: toolInputText(name, state.input),
        output: str(state.output) || str(state.error),
        ok: status === 'completed' ? true : status === 'error' ? false : undefined,
        start,
        end: toolEnd,
      });
      if (toolEnd > step.end) step.end = toolEnd;
    } else if (type === 'step-finish') {
      step.usage = readTokens(part.tokens);
      step.stopReason = str(part.reason) || undefined;
      step.finished = true;
      if (step.end <= step.start && msg.completedMs !== undefined) step.end = msg.completedMs;
      steps.push(step);
      cursor = step.end;
      step = fresh();
    }
  }
  if (step.finished === false && (sawParts === false || step.text.length > 0 || step.thinking.length > 0 || step.tools.length > 0)) {
    // No step-finish: an API error, an aborted step, or a legacy row.
    if (steps.length === 0) step.usage = msg.tokens;
    step.stopReason = msg.error !== undefined ? 'error' : (msg.finish ?? (steps.length === 0 ? undefined : 'incomplete'));
    if (msg.completedMs !== undefined && msg.completedMs > step.end) step.end = msg.completedMs;
    if (sawParts || msg.error !== undefined || (msg.tokens !== undefined && (msg.tokens.input > 0 || msg.tokens.output > 0))) steps.push(step);
  }
  return steps;
}

export function parseOpencode(text: string, fileName: string): Session {
  const warnings: string[] = [];
  const session = baseSession('opencode', fileName, fileName);
  const root = session.root;

  const sessions: OcSession[] = [];
  const messages: OcMessage[] = [];
  const byMessageId = new Map<string, OcMessage>();

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue;
    const rec = tryParse(line);
    if (rec === null) continue; // counted by the dispatcher
    const data = asObject(rec.data);
    if (data === null) {
      warnings.push(`line ${i + 1}: record without data skipped`);
      continue;
    }
    switch (rec.type) {
      case 'opencode.session':
        sessions.push(readSession(data));
        break;
      case 'opencode.message': {
        const msg = readMessage(data);
        if (msg === null) {
          warnings.push(`line ${i + 1}: message without a creation time skipped`);
          break;
        }
        messages.push(msg);
        if (msg.id.length > 0) byMessageId.set(msg.id, msg);
        break;
      }
      case 'opencode.part': {
        const owner = byMessageId.get(str(data.messageID));
        if (owner === undefined) {
          warnings.push(`line ${i + 1}: part for unknown message ${str(data.messageID) || '?'} skipped`);
          break;
        }
        owner.parts.push(data);
        break;
      }
      default:
        break;
    }
  }

  const main = sessions[0];
  if (main === undefined) {
    warnings.push('no OpenCode session record found');
    return finishSession(session, warnings);
  }
  if (main.id.length > 0) session.id = main.id;
  const meta: Record<string, string | number> = {};
  if (main.directory.length > 0) meta.cwd = main.directory;
  const version = str(main.data.version);
  if (version.length > 0) meta.version = version;
  const agent = str(main.data.agent);
  if (agent.length > 0) meta.agent = agent;
  root.meta = { ...root.meta, ...meta };

  // Root window: session creation to the last known activity.
  const times: number[] = [];
  for (const m of messages) {
    times.push(m.createdMs);
    if (m.completedMs !== undefined) times.push(m.completedMs);
  }
  for (const s of sessions) {
    if (Number.isFinite(s.createdMs)) times.push(s.createdMs);
    if (Number.isFinite(s.updatedMs)) times.push(s.updatedMs);
  }
  const start = Number.isFinite(main.createdMs) ? main.createdMs : Math.min(...times);
  if (Number.isFinite(start)) {
    root.startMs = start;
    root.endMs = Math.max(start, ...times.filter((t) => Number.isFinite(t)));
  }

  const mainMessages = messages.filter((m) => m.sessionId === main.id || m.sessionId.length === 0);
  const prompts = mainMessages.filter((m) => m.role === 'user');
  const activity = times.slice().sort((a, b) => a - b);

  // Turn spans: one per prompt, until the next prompt (idle gaps > 2 s).
  const turns: { span: Span; start: number; end: number }[] = [];
  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i]!;
    const windowEnd = i + 1 < prompts.length ? prompts[i + 1]!.createdMs : Infinity;
    let activeEnd = prompt.createdMs;
    for (const t of activity) {
      if (t <= prompt.createdMs) continue;
      if (t >= windowEnd) break;
      if (t > activeEnd) activeEnd = t;
    }
    const promptText = partsText(prompt.parts);
    const span = makeSpan('turn', turnName(promptText), prompt.createdMs, Math.max(activeEnd, prompt.createdMs), 'root', {
      detail: truncate(promptText),
    });
    root.children.push(span);
    turns.push({ span, start: prompt.createdMs, end: Math.max(activeEnd, prompt.createdMs) });
    if (i + 1 < prompts.length && windowEnd - activeEnd > IDLE_THRESHOLD_MS) {
      root.children.push(makeSpan('idle', 'idle', activeEnd, windowEnd, 'root'));
    }
  }
  const turnFor = (ts: number): Span => {
    for (const turn of turns) if (ts >= turn.start && ts <= turn.end) return turn.span;
    if (turns.length === 0 || ts < turns[0]!.start) return root;
    return turns[turns.length - 1]!.span;
  };

  // Sub-agent sessions: one subagent span each, under the active turn.
  const hostFor = new Map<string, Span>(); // session id → span holding its calls
  hostFor.set(main.id, root);
  for (const child of sessions.slice(1)) {
    const childMessages = messages.filter((m) => m.sessionId === child.id);
    const childStart = Number.isFinite(child.createdMs) ? child.createdMs : (childMessages[0]?.createdMs ?? root.startMs);
    let childEnd = Number.isFinite(child.updatedMs) ? child.updatedMs : childStart;
    for (const m of childMessages) childEnd = Math.max(childEnd, m.completedMs ?? m.createdMs);
    const parentHost = hostFor.get(child.parentId ?? main.id);
    const parent = parentHost !== undefined && parentHost !== root ? parentHost : turnFor(childStart);
    const firstPrompt = childMessages.find((m) => m.role === 'user');
    const span = makeSpan('subagent', child.title.length > 0 ? `subagent · ${truncate(child.title, 80)}` : 'subagent', childStart, Math.max(childEnd, childStart + 1), parent.id, {
      detail: truncate(firstPrompt === undefined ? child.title : partsText(firstPrompt.parts)),
      meta: { sessionId: child.id },
    });
    parent.children.push(span);
    hostFor.set(child.id, span);
  }

  // Model + tool spans, per assistant message step.
  const prevEndBySession = new Map<string, number>();
  const recentResults: { ts: number; name: string; text: string; ok: boolean | undefined; sessionId: string }[] = [];
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    const host = hostFor.get(msg.sessionId) ?? root;
    if (msg.error !== undefined) warnings.push(`model call failed: ${truncate(msg.error, 160)}`);
    for (const step of stepsOf(msg)) {
      const parent = host === root ? turnFor(step.start) : host;
      const prevEnd = prevEndBySession.get(msg.sessionId);
      const payload = modelPayload(step, prevEnd, msg.sessionId, mainMessages, recentResults);
      const failed = msg.error !== undefined || step.stopReason === 'error';
      const span = makeSpan('model', msg.model ?? 'model', step.start, Math.max(step.end, step.start + 1), parent.id, {
        model: msg.model,
        provider: msg.provider,
        usage: step.usage,
        detail: truncate(failed && step.text.length === 0 ? (msg.error ?? 'error') : step.text),
        payload,
        ...(failed ? { ok: false } : {}),
      });
      parent.children.push(span);
      prevEndBySession.set(msg.sessionId, step.end);
      for (const tool of step.tools) {
        const input = capText(tool.input);
        const output = capText(tool.output);
        parent.children.push(
          makeSpan('tool', tool.name, tool.start, Math.max(tool.end, tool.start + 1), parent.id, {
            toolName: tool.name,
            toolInput: truncate(tool.input),
            ok: tool.ok,
            detail: truncate(tool.input),
            payload: {
              input: input.text,
              output: output.text.length > 0 ? output.text : undefined,
              truncated: input.truncated || output.truncated || undefined,
            },
          }),
        );
        recentResults.push({ ts: tool.end, name: tool.name, text: tool.output, ok: tool.ok, sessionId: msg.sessionId });
      }
    }
  }
  if (!messages.some((m) => m.role === 'assistant')) warnings.push('no assistant messages found');

  const sortChildren = (span: Span): void => {
    span.children.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    for (const c of span.children) sortChildren(c);
  };
  sortChildren(root);
  for (const child of root.children) if (child.endMs > root.endMs) root.endMs = child.endMs;

  const firstPrompt = prompts[0];
  session.title = main.title.length > 0 ? truncate(main.title, 80) : firstPrompt !== undefined ? turnName(partsText(firstPrompt.parts)) : fileName;
  return finishSession(session, warnings);
}

function partsText(parts: Record<string, unknown>[]): string {
  const out: string[] = [];
  for (const p of parts) if (p.type === 'text' && typeof p.text === 'string') out.push(p.text);
  return out.join('\n');
}

function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
}

function turnName(text: string): string {
  const line = firstLine(text);
  return line.length > 0 ? truncate(line, 80) : 'prompt';
}

/**
 * Model payload: the step's text/thinking/stop reason plus newContext — the
 * prompts and tool results of the same session appended since the previous
 * model call there.
 */
function modelPayload(
  step: Step,
  prevEnd: number | undefined,
  sessionId: string,
  mainMessages: OcMessage[],
  results: { ts: number; name: string; text: string; ok: boolean | undefined; sessionId: string }[],
): SpanPayload {
  const output = capText(step.text.length > 0 ? step.text : undefined);
  const thinking = step.thinking.length > 0 ? capText(step.thinking) : undefined;
  let truncated = output.truncated || (thinking?.truncated ?? false);
  const windowStart = prevEnd ?? -Infinity;
  const items: ContextItem[] = [];
  for (const m of mainMessages) {
    if (m.role !== 'user' || m.sessionId !== sessionId && m.sessionId.length > 0) continue;
    if (m.createdMs <= windowStart || m.createdMs > step.start) continue;
    const text = partsText(m.parts);
    if (text.length === 0) continue;
    const capped = capText(text);
    truncated = truncated || capped.truncated;
    items.push({ role: 'user', label: 'user prompt', text: capped.text, chars: text.length });
  }
  for (const r of results) {
    // A step's window starts where the previous step ended, which is exactly
    // when that step's last tool finished — so the boundary is inclusive.
    if (r.sessionId !== sessionId || r.ts < windowStart || r.ts > step.start || r.text.length === 0) continue;
    const capped = capText(r.text);
    truncated = truncated || capped.truncated;
    items.push({ role: 'tool_result', label: `${r.name} result`, text: capped.text, chars: r.text.length, ...(r.ok !== undefined ? { ok: r.ok } : {}) });
  }
  return {
    output: output.text.length > 0 ? output.text : undefined,
    thinking: thinking?.text,
    stopReason: step.stopReason,
    newContext: items,
    truncated: truncated || undefined,
  };
}

/**
 * `opencode export` JSON ({info, messages:[{info, parts}]}) → flattened
 * JSONL records; null when `text` is not such a document. Never throws.
 */
export function flattenOpencodeExport(text: string): string | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{')) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const d = asObject(doc);
  const info = d === null ? null : asObject(d.info);
  if (d === null || info === null || !Array.isArray(d.messages)) return null;
  const sessionId = str(info.id);
  const lines: string[] = [JSON.stringify({ type: 'opencode.session', data: info })];
  for (const entry of d.messages) {
    const e = asObject(entry);
    const mi = e === null ? null : asObject(e.info);
    if (e === null || mi === null) continue;
    const messageId = str(mi.id);
    lines.push(JSON.stringify({ type: 'opencode.message', data: { ...mi, id: messageId, sessionID: str(mi.sessionID) || sessionId } }));
    if (!Array.isArray(e.parts)) continue;
    for (const part of e.parts) {
      const p = asObject(part);
      if (p === null) continue;
      lines.push(JSON.stringify({ type: 'opencode.part', data: { ...p, sessionID: str(p.sessionID) || sessionId, messageID: str(p.messageID) || messageId } }));
    }
  }
  return lines.join('\n') + '\n';
}
