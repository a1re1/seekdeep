// Parser for Claude Code transcript JSONL files.
//
// Shape notes (from real transcripts):
// - `assistant` records carry `message.id`, `message.model`, `message.content`
//   (an array of thinking/text/tool_use blocks) and `message.usage`. One API
//   response is often split across SEVERAL consecutive `assistant` records
//   sharing the same `message.id`; usage must be counted once per message id.
// - `user` records either hold a plain prompt (string content, or a list of
//   text blocks) or `tool_result` blocks keyed by `tool_use_id`.
// - Records with `isSidechain: true` belong to subagent (Task) runs.

import type { ContextItem, Session, Span, SpanPayload, Usage } from '../model.ts';
import {
  baseSession,
  capText,
  finishSession,
  makeSpan,
  parseTs,
  truncate,
  tryParse,
} from './util.ts';

const IDLE_THRESHOLD_MS = 2000;

interface Rec {
  raw: Record<string, unknown>;
  ts: number;
  sidechain: boolean;
  uuid: string;
  parentUuid: string | null;
}

interface ToolUse {
  id: string;
  name: string;
  input: string;
  /** Full pretty-printed tool input (the payload, distinct from the short label). */
  inputPretty: string;
  ts: number;
}

interface MsgGroup {
  id: string;
  model?: string;
  usage?: Usage;
  start: number;
  end: number;
  toolUses: ToolUse[];
  text: string;
  /** Non-empty `thinking` blocks joined with newlines. */
  thinking: string;
  /** `message.stop_reason` when the transcript carries it. */
  stopReason?: string;
  sidechain: boolean;
  /** The first assistant record seen for this message id (chain anchor). */
  anchor: Rec | null;
}

interface ToolResult {
  id: string;
  isError: boolean;
  text: string;
  ts: number;
}

interface Prompt {
  ts: number;
  text: string;
  /** The user record's uuid, so the prompt's own record is excluded from turn windows. */
  uuid: string;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Map a Claude `message.usage` object to the neutral Usage shape. */
function usageFromMessage(msg: Record<string, unknown>): Usage | undefined {
  const raw = asObject(msg.usage);
  if (!raw) return undefined;
  const cacheCreation = asObject(raw.cache_creation) ?? {};
  const details = asObject(raw.output_tokens_details) ?? {};
  return {
    input: num(raw.input_tokens),
    cacheRead: num(raw.cache_read_input_tokens),
    cacheWrite: num(raw.cache_creation_input_tokens),
    cacheWrite5m: num(cacheCreation.ephemeral_5m_input_tokens),
    cacheWrite1h: num(cacheCreation.ephemeral_1h_input_tokens),
    output: num(raw.output_tokens),
    reasoning: num(details.thinking_tokens),
  };
}

/** Extract plain text from a tool_result `content` (string or block list). */
function resultText(value: unknown): string {
  if (typeof value === 'string') return value;
  const parts: string[] = [];
  for (const block of asArray(value)) {
    const obj = asObject(block);
    if (obj && typeof obj.text === 'string') parts.push(obj.text);
  }
  return parts.join('\n');
}

/** Split a `user` record into (at most one) plain prompt and tool results. */
function readUserRecord(
  raw: Record<string, unknown>,
  ts: number,
  uuid: string,
): {
  prompt: Prompt | null;
  results: ToolResult[];
} {
  const msg = asObject(raw.message);
  const content = msg ? msg.content : undefined;
  if (typeof content === 'string') {
    return { prompt: { ts, text: content, uuid }, results: [] };
  }
  const blocks = asArray(content);
  const results: ToolResult[] = [];
  const textParts: string[] = [];
  for (const block of blocks) {
    const obj = asObject(block);
    if (!obj) continue;
    if (obj.type === 'tool_result') {
      results.push({
        id: typeof obj.tool_use_id === 'string' ? obj.tool_use_id : '',
        isError: obj.is_error === true,
        text: resultText(obj.content),
        ts,
      });
    } else if (obj.type === 'text' && typeof obj.text === 'string') {
      textParts.push(obj.text);
    }
  }
  const prompt =
    results.length === 0 && textParts.length > 0
      ? { ts, text: textParts.join('\n'), uuid }
      : null;
  return { prompt, results };
}

/** Group consecutive `assistant` records by `message.id` (usage counted once). */
function collectGroups(recs: Rec[]): { groups: MsgGroup[]; byId: Map<string, MsgGroup> } {
  const byId = new Map<string, MsgGroup>();
  for (const rec of recs) {
    if (rec.raw.type !== 'assistant') continue;
    const msg = asObject(rec.raw.message);
    if (!msg) continue;
    const id =
      typeof msg.id === 'string' && msg.id.length > 0
        ? msg.id
        : `anon-${rec.uuid}`;
    let group = byId.get(id);
    if (!group) {
      group = {
        id,
        model: typeof msg.model === 'string' ? msg.model : undefined,
        usage: undefined,
        start: rec.ts,
        end: rec.ts,
        toolUses: [],
        text: '',
        thinking: '',
        sidechain: rec.sidechain,
        anchor: rec,
      };
      group.usage = usageFromMessage(msg); // counted once per message id
      byId.set(id, group);
    }
    if (rec.ts < group.start) group.start = rec.ts;
    if (rec.ts > group.end) group.end = rec.ts;
    if (!group.model && typeof msg.model === 'string') group.model = msg.model;
    for (const block of asArray(msg.content)) {
      const obj = asObject(block);
      if (!obj) continue;
      if (obj.type === 'tool_use') {
        group.toolUses.push({
          id: typeof obj.id === 'string' ? obj.id : '',
          name: typeof obj.name === 'string' ? obj.name : 'tool',
          input: JSON.stringify(obj.input ?? {}),
          inputPretty: JSON.stringify(obj.input ?? {}, null, 2),
          ts: rec.ts,
        });
      } else if (obj.type === 'text' && typeof obj.text === 'string') {
        if (group.text.length > 0) group.text += '\n';
        group.text += obj.text;
      } else if (
        obj.type === 'thinking' &&
        typeof obj.thinking === 'string' &&
        obj.thinking.length > 0
      ) {
        if (group.thinking.length > 0) group.thinking += '\n';
        group.thinking += obj.thinking;
      }
    }
    if (typeof msg.stop_reason === 'string') group.stopReason = msg.stop_reason;
  }
  return { groups: [...byId.values()], byId };
}

function compareStart(a: Span, b: Span): number {
  return a.startMs - b.startMs || a.endMs - b.endMs;
}

export function parseClaudeCode(text: string, fileName: string): Session {
  const warnings: string[] = [];
  let sessionId: string | null = null;
  const recs: Rec[] = [];

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const raw = tryParse(trimmed);
    if (!raw) continue; // counted (and warned about) once by parseTranscript
    if (sessionId === null && typeof raw.sessionId === 'string') {
      sessionId = raw.sessionId;
    }
    const ts = parseTs(raw.timestamp);
    if (!Number.isFinite(ts)) continue; // timeless record — nothing to place
    recs.push({
      raw,
      ts,
      sidechain: raw.isSidechain === true,
      uuid: typeof raw.uuid === 'string' ? raw.uuid : '',
      parentUuid: typeof raw.parentUuid === 'string' ? raw.parentUuid : null,
    });
  }
  recs.sort((a, b) => a.ts - b.ts);

  const { groups } = collectGroups(recs);

  // A model span should cover the API wait, not just the spread of the split

  // records that carry one response: start it at the record the response

  // replies to (the tool_result / prompt the anchor's parentUuid points at).

  const tsByUuid = new Map<string, number>();

  for (const rec of recs) if (rec.uuid.length > 0) tsByUuid.set(rec.uuid, rec.ts);

  for (const group of groups) {

    const parentUuid = group.anchor?.parentUuid ?? null;

    const parentTs = parentUuid === null ? undefined : tsByUuid.get(parentUuid);

    if (parentTs !== undefined && parentTs < group.start) group.start = parentTs;

  }

  // Tool results from every `user` record, keyed by tool_use_id.
  const resultMap = new Map<string, ToolResult>();
  const prompts: Prompt[] = [];
  for (const rec of recs) {
    if (rec.raw.type !== 'user') continue;
    const { prompt, results } = readUserRecord(rec.raw, rec.ts, rec.uuid);
    for (const result of results) {
      if (result.id.length > 0) resultMap.set(result.id, result);
    }
    // `isMeta` user records are injected by the harness (skill bodies, image
    // attachments): they extend the current turn rather than starting one.
    if (prompt !== null && !rec.sidechain && rec.raw.isMeta !== true && prompt.text.trim().length > 0) {
      prompts.push(prompt);
    }
  }

  const session = baseSession('claude-code', sessionId ?? fileName, fileName);
  const root = session.root;
  if (recs.length > 0) {
    root.startMs = recs[0]!.ts;
    root.endMs = recs[recs.length - 1]!.ts;
  }

  // Turn spans: one per plain user prompt, ending at the next prompt (or the
  // last record). Gaps > 2 s before the next prompt become idle spans.
  const turns: { span: Span; start: number; end: number }[] = [];
  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i]!;
    // The last turn runs to the end of the transcript (Infinity, not
    // root.endMs: the final record sits exactly at root.endMs and `>=` below
    // would drop it).
    const windowEnd = i + 1 < prompts.length ? prompts[i + 1]!.ts : Infinity;
    let activeEnd = prompt.ts;
    for (const rec of recs) {
      if (rec.ts <= prompt.ts) continue;
      if (rec.ts >= windowEnd) break; // next prompt's own record ends the window
      if (rec.uuid.length > 0 && rec.uuid === prompt.uuid) continue;
      if (rec.ts > activeEnd) activeEnd = rec.ts;
    }
    const turn = {
      span: makeTurn(prompt, activeEnd),
      start: prompt.ts,
      end: Math.max(activeEnd, prompt.ts),
    };
    root.children.push(turn.span);
    turns.push(turn);
    if (i + 1 < prompts.length && windowEnd - activeEnd > IDLE_THRESHOLD_MS) {
      root.children.push(
        makeIdle(activeEnd, windowEnd),
      );
    }
  }

  const turnFor = (ts: number): Span | null => {
    if (turns.length === 0) return null;
    for (const turn of turns) {
      if (ts >= turn.start && ts <= turn.end) return turn.span;
    }
    // Before the first prompt → no turn; after the last → the final turn.
    return ts < turns[0]!.start ? null : turns[turns.length - 1]!.span;
  };

  // Subagent groups: sidechain message groups keyed by their chain root.
  const byUuid = new Map<string, Rec>();
  for (const rec of recs) {
    if (rec.sidechain && rec.uuid.length > 0) byUuid.set(rec.uuid, rec);
  }
  const sidechains = new Map<string, Span>();

  // tool_use_id → the tool_use block, for labeling tool_result context items.
  const toolUseById = new Map<string, ToolUse>();
  for (const group of groups) {
    for (const use of group.toolUses) {
      if (use.id.length > 0) toolUseById.set(use.id, use);
    }
  }

  // Conversations are separate per chain: the main thread plus one per
  // subagent (sidechain root). Parallel subagents interleave in the file, so
  // "context new since the previous model call" must be tracked per chain,
  // not per sidechain flag.
  const chainOf = (rec: Rec): string => (rec.sidechain ? chainRootOf(rec, byUuid) : 'main');
  const recsByChain = new Map<string, Rec[]>();
  for (const rec of recs) {
    const key = chainOf(rec);
    const list = recsByChain.get(key);
    if (list === undefined) recsByChain.set(key, [rec]);
    else list.push(rec);
  }
  const prevModelEnd = new Map<string, number>();

  for (const group of groups) {
    const children: Span[] = [];
    const modelName = group.model ?? 'model';
    const chainKey = group.sidechain ? groupByChainRoot(group, byUuid) : 'main';
    const prevEnd = prevModelEnd.get(chainKey);
    const modelSpan = makeModel(
      group,
      modelName,
      buildModelPayload(group, prevEnd, recsByChain.get(chainKey) ?? [], toolUseById),
    );
    prevModelEnd.set(chainKey, Math.max(prevEnd ?? -Infinity, group.end));
    children.push(modelSpan);
    for (const use of group.toolUses) {
      children.push(makeTool(use, resultMap.get(use.id)));
    }
    if (!group.sidechain) {
      const parent = turnFor(group.start);
      (parent ?? root).children.push(...children);
      continue;
    }
    // Sidechain group → its subagent span (created lazily per chain root).
    const key = groupByChainRoot(group, byUuid);
    let container = sidechains.get(key);
    if (!container) {
      container = makeSubagent(key, group.start);
      sidechains.set(key, container);
    }
    container.children.push(...children);
    if (container.endMs < group.end) container.endMs = group.end;
  }

  // Nest subagent spans under the turn active when they started.
  for (const sub of sidechains.values()) {
    sub.children.sort(compareStart);
    const parent = turnFor(sub.startMs);
    if (parent !== null && parent.endMs < sub.endMs) {
      parent.endMs = sub.endMs;
    }
    (parent ?? root).children.push(sub);
  }

  // Containers widened above may now extend past the last record's timestamp.
  for (const child of root.children) {
    if (child.endMs > root.endMs) root.endMs = child.endMs;
  }
  if (prompts.length > 0) {
    session.title = truncate(prompts[0]!.text, 80);
  }
  root.children.sort(compareStart);
  for (const turn of turns) turn.span.children.sort(compareStart);
  return finishSession(session, warnings);
}

function makeTurn(prompt: Prompt, activeEnd: number): Span {
  const text = prompt.text.trim();
  return makeSpan(
    'turn',
    text.length > 0 ? truncate(text, 80) : 'turn',
    prompt.ts,
    Math.max(activeEnd, prompt.ts),
    'root',
    { detail: truncate(text) },
  );
}

function makeIdle(start: number, end: number): Span {
  return makeSpan('idle', 'idle', start, Math.max(end, start), 'root');
}

function makeModel(
  group: MsgGroup,
  modelName: string,
  payload: SpanPayload,
): Span {
  return makeSpan(
    'model',
    modelName,
    group.start,
    Math.max(group.end, group.start + 1),
    null,
    {
      model: group.model,
      usage: group.usage,
      detail: truncate(group.text),
      payload,
    },
  );
}

function makeTool(use: ToolUse, result: ToolResult | undefined): Span {
  const start = use.ts;
  const end =
    result !== undefined && result.ts >= start ? result.ts : start + 1;
  return makeSpan('tool', use.name, start, end, null, {
    toolName: use.name,
    toolInput: truncate(use.input),
    ok: result !== undefined ? !result.isError : undefined,
    detail: result !== undefined && result.isError ? truncate(result.text) : undefined,
    payload: buildToolPayload(use, result),
  });
}

/** Tool payload: the full pretty-printed input and the flattened result text. */
function buildToolPayload(
  use: ToolUse,
  result: ToolResult | undefined,
): SpanPayload {
  const input = capText(use.inputPretty);
  const output = result !== undefined ? capText(result.text) : undefined;
  return {
    input: input.text,
    output: output?.text,
    truncated: input.truncated || (output?.truncated ?? false) || undefined,
  };
}

/**
 * Model payload: the response text/thinking/stop reason, plus newContext —
 * everything appended to the conversation since the previous model call on
 * the same (non-)sidechain: plain user prompts and tool_result blocks.
 * The first model call of a chain sees everything from the transcript start.
 */
function buildModelPayload(
  group: MsgGroup,
  prevEnd: number | undefined,
  recs: Rec[],
  toolUseById: Map<string, ToolUse>,
): SpanPayload {
  const output = capText(group.text.length > 0 ? group.text : undefined);
  const thinking = group.thinking.length > 0 ? capText(group.thinking) : undefined;
  let truncated = output.truncated || (thinking?.truncated ?? false);
  const windowStart = prevEnd ?? -Infinity;
  const items: ContextItem[] = [];
  for (const rec of recs) {
    if (rec.sidechain !== group.sidechain) continue;
    if (rec.ts <= windowStart || rec.ts > group.start) continue;
    if (rec.raw.type !== 'user') continue;
    const { prompt, results } = readUserRecord(rec.raw, rec.ts, rec.uuid);
    if (prompt !== null && prompt.text.length > 0) {
      const capped = capText(prompt.text);
      truncated = truncated || capped.truncated;
      const meta = rec.raw.isMeta === true;
      items.push({
        role: meta ? 'system' : 'user',
        label: meta ? 'injected context' : 'user prompt',
        text: capped.text,
        chars: prompt.text.length,
      });
    }
    for (const result of results) {
      if (result.text.length === 0) continue; // carries no text
      const capped = capText(result.text);
      truncated = truncated || capped.truncated;
      const use = toolUseById.get(result.id);
      items.push({
        role: 'tool_result',
        label: `${use?.name ?? 'tool'} result`,
        text: capped.text,
        chars: result.text.length,
        ok: !result.isError,
      });
    }
  }
  return {
    output: output.text.length > 0 ? output.text : undefined,
    thinking: thinking?.text,
    stopReason: group.stopReason,
    newContext: items,
    truncated: truncated || undefined,
  };
}

function makeSubagent(key: string, start: number): Span {
  return makeSpan('subagent', 'subagent', start, start + 1, null, {
    detail: `sidechain chain ${key}`,
  });
}

/**
 * Key a sidechain message group by the root uuid of its parentUuid chain.
 * Falls back to the anchor record's own uuid when the chain is broken.
 */
function groupByChainRoot(
  group: MsgGroup,
  byUuid: Map<string, Rec>,
): string {
  const anchor = group.anchor;
  if (anchor === null) return group.id;
  return chainRootOf(anchor, byUuid) || group.id;
}

/** Walk parentUuid links to the root record of `rec`'s chain; returns its uuid. */
function chainRootOf(rec: Rec, byUuid: Map<string, Rec>): string {
  let current = rec;
  const seen = new Set<string>();
  while (true) {
    if (current.uuid.length === 0 || seen.has(current.uuid)) return current.uuid;
    seen.add(current.uuid);
    if (current.parentUuid === null) return current.uuid;
    const parent = byUuid.get(current.parentUuid);
    if (!parent) return current.uuid;
    current = parent;
  }
}
