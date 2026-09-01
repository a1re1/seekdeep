// Fallback parser: best-effort extraction from any unknown JSONL format.
// Never throws; anything it cannot use is skipped.

import type { Session, Span } from '../model.ts';
import {
  baseSession,
  finishSession,
  parseTs,
  truncate,
  tryParse,
} from './util.ts';

const TS_KEYS = ['timestamp', 'ts', 'at', 'time'] as const;
const NAME_KEYS = ['name', 'kind', 'type', 'event', 'action', 'label', 'id'] as const;

function pick(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

/** Extract a token-usage object from any `*_tokens` shaped record. */
function extractUsage(record: Record<string, unknown>):
  | { input: number; cacheRead: number; cacheWrite: number; output: number }
  | null {
  const raw = record.usage ?? record.token_usage ?? record.tokens;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const usage = raw as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const cacheRead = num(usage.cache_read_input_tokens) + num(usage.cached_input_tokens) + num(usage.cached_tokens);
  const cacheWrite = num(usage.cache_creation_input_tokens) + num(usage.cache_write_tokens);
  // Anthropic `input_tokens` excludes cached tokens; OpenAI `prompt_tokens`
  // includes them, so subtract the cached portion back out of that shape.
  const promptTokens = num(usage.prompt_tokens);
  const input =
    num(usage.input_tokens) + (promptTokens > 0 ? Math.max(0, promptTokens - cacheRead - cacheWrite) : 0);
  const output = num(usage.output_tokens) + num(usage.completion_tokens);
  if (input === 0 && cacheRead === 0 && cacheWrite === 0 && output === 0) return null;
  return { input, cacheRead, cacheWrite, output };
}

export function parseGeneric(text: string, fileName: string): Session {
  const session = baseSession('generic', fileName, fileName);
  const lines = text.split('\n');
  const spans: Span[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const record = tryParse(trimmed);
    if (record === null) continue; // skip junk silently; index.ts warns

    const ts = parseTs(pick(record, TS_KEYS));
    if (!Number.isFinite(ts)) continue;

    const rawName = pick(record, NAME_KEYS);
    const name = truncate(typeof rawName === 'string' ? rawName : 'record', 80);

    const usage = extractUsage(record);
    if (usage !== null) {
      const model = typeof record.model === 'string' ? record.model : undefined;
      spans.push({
        id: '',
        parentId: null,
        kind: 'model',
        name: model ?? 'model',
        startMs: ts,
        endMs: ts + 1,
        usage,
        model,
        children: [],
      });
    } else {
      spans.push({
        id: '',
        parentId: null,
        kind: 'other',
        name,
        startMs: ts,
        endMs: ts + 1,
        detail: truncate(JSON.stringify(record)),
        children: [],
      });
    }
  }

  spans.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  if (spans.length > 0) {
    session.root.startMs = spans[0]!.startMs;
    session.root.endMs = spans[spans.length - 1]!.endMs;
  }
  for (const span of spans) session.root.children.push(span);
  return finishSession(session, []);
}
