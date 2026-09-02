// Format-agnostic data model for agent transcripts.
// Pure types + pure helpers: no DOM, no I/O, no parser knowledge.

export type SpanKind =
  | 'session'
  | 'turn'
  | 'model'
  | 'tool'
  | 'subagent'
  | 'idle'
  | 'other';

/** A single piece of conversation content added since the previous model call. */
export interface ContextItem {
  role: 'user' | 'tool_result' | 'assistant' | 'system';
  label: string;
  text: string;
  chars: number; // untruncated text length
  ok?: boolean; // tool_result success/failure when known
}

/** What a span actually contained, shown in the detail pane. */
export interface SpanPayload {
  input?: string; // tool: the full tool input (JSON or command text)
  output?: string; // tool: the result text; model: the assistant's visible text output
  thinking?: string; // model: thinking/reasoning text when the transcript has it
  stopReason?: string; // model: stop reason when known
  newContext?: ContextItem[]; // everything appended to the conversation since the previous model call
  truncated?: boolean; // true if any string above was cut at PAYLOAD_CAP
}

export const PAYLOAD_CAP = 20_000; // chars per string

export interface Usage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  output: number;
  reasoning?: number;
}

export interface Span {
  id: string;
  parentId: string | null;
  kind: SpanKind;
  name: string;
  startMs: number; // absolute epoch ms
  endMs: number; // absolute epoch ms; endMs >= startMs
  usage?: Usage;
  model?: string;
  provider?: string;
  costUsd?: number; // filled by pricing, not parsers
  toolName?: string;
  toolInput?: string; // truncated to 200 chars by the parser
  ok?: boolean; // tool success/failure when known
  detail?: string; // short human text (<= 200 chars)
  payload?: SpanPayload; // full contents for the detail pane
  children: Span[];
  meta?: Record<string, string | number | boolean>;
}

export interface Session {
  format: 'claude-code' | 'lci' | 'codex' | 'opencode' | 'pi' | 'generic';
  id: string;
  title: string;
  root: Span;
  warnings: string[];
}

/** Depth-first pre-order traversal (includes the root itself). */
export function flatten(root: Span): Span[] {
  const out: Span[] = [];
  const stack: Span[] = [root];
  while (stack.length > 0) {
    const span = stack.pop() as Span;
    out.push(span);
    for (let i = span.children.length - 1; i >= 0; i--) {
      stack.push(span.children[i]!);
    }
  }
  return out;
}

export function durationMs(span: Span): number {
  return Math.max(0, span.endMs - span.startMs);
}

export function sumUsage(spans: Span[]): Usage {
  const total: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const span of spans) {
    const u = span.usage;
    if (!u) continue;
    total.input += u.input || 0;
    total.cacheRead += u.cacheRead || 0;
    total.cacheWrite += u.cacheWrite || 0;
    total.output += u.output || 0;
    total.cacheWrite5m = (total.cacheWrite5m ?? 0) + (u.cacheWrite5m ?? 0);
    total.cacheWrite1h = (total.cacheWrite1h ?? 0) + (u.cacheWrite1h ?? 0);
    total.reasoning = (total.reasoning ?? 0) + (u.reasoning ?? 0);
  }
  // Leave the optional extension fields undefined when nothing contributed.
  if ((total.cacheWrite5m ?? 0) === 0) delete total.cacheWrite5m;
  if ((total.cacheWrite1h ?? 0) === 0) delete total.cacheWrite1h;
  if ((total.reasoning ?? 0) === 0) delete total.reasoning;
  return total;
}

/**
 * Time covered by the span itself: total duration minus the union of its
 * children's [startMs, endMs] intervals. Children that extend beyond the
 * parent's bounds are clamped to the parent's window.
 */
export function selfTimeMs(span: Span): number {
  const total = durationMs(span);
  if (span.children.length === 0) return total;

  const intervals = span.children
    .map((c) => {
      const start = Math.max(span.startMs, c.startMs);
      const end = Math.min(span.endMs, Math.max(c.startMs, c.endMs));
      return end > start ? { start, end } : null;
    })
    .filter((iv): iv is { start: number; end: number } => iv !== null)
    .sort((a, b) => a.start - b.start);

  let covered = 0;
  let cursor = -Infinity;
  for (const iv of intervals) {
    if (iv.start > cursor) {
      covered += iv.end - iv.start;
      cursor = iv.end;
    } else if (iv.end > cursor) {
      covered += iv.end - cursor;
      cursor = iv.end;
    }
  }
  return Math.max(0, total - covered);
}

/** cacheRead / (input + cacheRead + cacheWrite); 0 when the denominator is 0. */
export function cacheHitRate(u: Usage): number {
  const denom = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
  if (denom <= 0) return 0;
  return (u.cacheRead || 0) / denom;
}
