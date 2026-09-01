// Shared helpers for the transcript parsers.
// Parsers NEVER throw: malformed lines are skipped and recorded as warnings.

import { PAYLOAD_CAP, type Session, type Span, type SpanKind } from '../model.ts';

export function makeRoot(id: string, title: string, startMs: number): Span {
  return {
    id: 'root',
    parentId: null,
    kind: 'session',
    name: title,
    startMs,
    endMs: startMs,
    children: [],
  };
}

let uidCounter = 0;
export function nextSpanId(prefix: string): string {
  uidCounter += 1;
  return `${prefix}-${uidCounter}`;
}

export function makeSpan(
  kind: SpanKind,
  name: string,
  startMs: number,
  endMs: number,
  parentId: string | null,
  extra?: Partial<Span>,
): Span {
  const span: Span = {
    id: nextSpanId(kind),
    parentId,
    kind,
    name,
    startMs,
    endMs,
    children: [],
    ...extra,
  };
  normalizeSpan(span);
  return span;
}

/**
 * Enforce the invariants: endMs >= startMs, finite timestamps, and child
 * spans nested within their parent's window (clamped, with a warning) with
 * `parentId` pointing at the actual parent (the tree is the source of truth).
 * Returns the number of adjustments made.
 */
export function normalizeSpan(span: Span, warnings?: string[]): number {
  let fixes = 0;
  if (!Number.isFinite(span.startMs)) {
    span.startMs = 0;
    fixes++;
  }
  if (!Number.isFinite(span.endMs) || span.endMs < span.startMs) {
    span.endMs = span.startMs;
    fixes++;
  }
  if (span.detail !== undefined && span.detail.length > 200) {
    span.detail = span.detail.slice(0, 200);
  }
  for (const child of span.children) {
    child.parentId = span.id;
    if (child.startMs < span.startMs) {
      child.startMs = span.startMs;
      if (child.endMs < child.startMs) child.endMs = span.startMs;
      fixes++;
      warnings?.push(`span "${child.name}" clamped to parent start`);
    } else if (child.endMs > span.endMs) {
      child.endMs = span.endMs;
      if (child.endMs < child.startMs) child.startMs = child.endMs;
      fixes++;
      warnings?.push(`span "${child.name}" clamped to parent end`);
    }
    fixes += normalizeSpan(child, warnings);
  }
  return fixes;
}

/** Truncate long text fields to the spec's 200-char limit. */
export function truncate(text: string | undefined | null, max = 200): string {
  const s = text ?? '';
  return s.length > max ? s.slice(0, max) : s;
}

/** Cap a payload string to PAYLOAD_CAP chars, reporting whether it was cut. */
export function capText(
  s: string | undefined,
  cap: number = PAYLOAD_CAP,
): { text: string; truncated: boolean } {
  const text = s ?? '';
  return text.length > cap
    ? { text: text.slice(0, cap), truncated: true }
    : { text, truncated: false };
}

/** Parse a line of JSON, returning null (never throwing) on failure. */
export function tryParse(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** Parse an ISO-ish timestamp; NaN when absent or unparseable. */
export function parseTs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return NaN;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? NaN : ms;
}

export function finishSession(
  session: Session,
  extraWarnings: string[],
): Session {
  session.warnings.push(...extraWarnings);
  session.root.name = session.title || session.root.name;
  normalizeSpan(session.root, session.warnings);
  return session;
}

export function baseSession(
  format: Session['format'],
  id: string,
  title: string,
): Session {
  return { format, id, title, root: makeRoot(id, title, Date.now()), warnings: [] };
}
