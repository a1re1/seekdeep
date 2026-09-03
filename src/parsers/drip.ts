// Parser for drip transcript JSONL files.
//
// Every line is `{"at":"<ISO>","type":"event"|"goal"|"run-end", ...}`.
// Event records: `{"at":"…","type":"event","kind":"<kind>","iteration":N,
// "detail":"<text>","data":{…},"goalId":"…"}`.
//
// Kind mapping:
// - inference  → model span (ends at `at`, starts at `at - latencyMs`).
//   NOTE: `promptTokens` is the TOTAL prompt including cached tokens
//   (OpenAI-style prompt_tokens), so input = prompt − cacheRead − cacheWrite.
// - tool-call / tool-result → one tool span per callId.
// - loop-start → a `turn` span named `loop N` until the next loop-start.
// - task-finished, context-expired, context-promoted, harness-op, run-warning
//   → zero-length (1 ms) `other` spans under the current loop.
// - run-summary / run-complete / run-end → root detail (first 200 chars).
// Legacy transcripts have NO inference events → warning, zero model spans.
// Parsers NEVER throw: malformed lines are skipped and recorded as warnings.

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

interface Rec {
  at: number;
  kind: string;
  data: Record<string, unknown>;
  iteration: number | null;
  detail: string;
  goalId: string | null;
}

function readRecord(raw: Record<string, unknown>): Rec | null {
  const at = parseTs(raw.at);
  if (!Number.isFinite(at)) return null;
  const data =
    raw.data !== null && typeof raw.data === 'object' && !Array.isArray(raw.data)
      ? (raw.data as Record<string, unknown>)
      : {};
  const kind = typeof raw.kind === 'string' ? raw.kind : '';
  const iteration =
    typeof raw.iteration === 'number' && Number.isFinite(raw.iteration)
      ? raw.iteration
      : null;
  return {
    at,
    kind,
    data,
    iteration,
    detail: typeof raw.detail === 'string' ? raw.detail : '',
    goalId: typeof raw.goalId === 'string' ? raw.goalId : null,
  };
}

function num(data: Record<string, unknown>, key: string): number {
  const v = data[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function str(data: Record<string, unknown>, key: string): string {
  const v = data[key];
  return typeof v === 'string' ? v : '';
}

function stringifyInput(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return input;
  if (typeof input === 'object') {
    try {
      return JSON.stringify(input, null, 2);
    } catch {
      return '';
    }
  }
  return String(input);
}

function readInferenceUsage(data: Record<string, unknown>): Usage {
  const cacheRead = Math.max(0, num(data, 'cacheReadTokens'));
  const cacheWrite = Math.max(0, num(data, 'cacheCreationTokens'));
  const total = Math.max(0, num(data, 'promptTokens'));
  const usage: Usage = {
    input: Math.max(0, total - cacheRead - cacheWrite),
    cacheRead,
    cacheWrite,
    output: Math.max(0, num(data, 'completionTokens')),
  };
  return usage;
}

/** The event kinds that become zero-length (1 ms) `other` spans. */
const MISC_KINDS = new Set([
  'task-finished',
  'context-expired',
  'context-promoted',
  'harness-op',
  'run-warning',
]);

const SUMMARY_KINDS = new Set(['run-summary', 'run-complete']);

export function parseDrip(text: string, fileName: string): Session {
  const lines = text.split('\n');
  const session = baseSession('drip', fileName, fileName);
  const root = session.root;
  const warnings = session.warnings;

  const pendingCalls = new Map<
    string,
    { at: number; name: string; parentId: string | null; input: unknown; callDetail: string }
  >();
  const completedTools = new Map<
    string,
    { at: number; name: string; failed: boolean; detail: string }
  >();
  let currentLoop: Span | null = null;
  let firstAt = NaN;
  let lastAt = NaN;
  let inferenceCount = 0;
  let goalText = '';
  let lastInferenceEnd = NaN;
  let lastModelSpan: Span | null = null;

  const parentFor = (): string | null => (currentLoop !== null ? currentLoop.id : null);
  const parentOf = (parent: string | null): Span => {
    if (parent !== null && parent === root.id) return root;
    if (parent !== null) {
      const found = findSpan(root, parent);
      if (found) return found;
    }
    return root;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const raw = tryParse(trimmed);
    if (raw === null) continue; // malformed lines are counted by parseTranscript

    const type = typeof raw.type === 'string' ? raw.type : '';

    if (type === 'goal') {
      const text0 = typeof raw.text === 'string' ? raw.text : '';
      if (session.title === fileName && text0.length > 0) {
        session.title = text0.slice(0, 80);
      }
      if (text0.length > 0 && goalText.length === 0) goalText = text0;
      continue;
    }

    if (type === 'run-end') {
      const d = typeof raw.detail === 'string' ? raw.detail : '';
      if (d.length > 0) root.detail = truncate(d);
      const at = parseTs(raw.at);
      if (Number.isFinite(at)) {
        if (!Number.isFinite(firstAt) || at < firstAt) firstAt = at;
        if (!Number.isFinite(lastAt) || at > lastAt) lastAt = at;
      }
      continue;
    }

    if (type !== 'event') continue;

    const rec = readRecord(raw);
    if (rec === null) continue;

    if (!Number.isFinite(firstAt) || rec.at < firstAt) firstAt = rec.at;
    if (!Number.isFinite(lastAt) || rec.at > lastAt) lastAt = rec.at;

    if (rec.goalId !== null && session.id === fileName) {
      session.id = rec.goalId;
 root.id = rec.goalId;
    }

    switch (rec.kind) {
      case 'inference': {
        inferenceCount++;
        const start = rec.at - Math.max(0, num(rec.data, 'latencyMs'));
        const model = str(rec.data, 'model') || 'unknown';
        const span = makeSpan('model', model, start, rec.at, parentFor(), {
          model,
          provider: str(rec.data, 'provider') || undefined,
          usage: readInferenceUsage(rec.data),
        });
        // newContext: the tool results since the previous inference event
        // (everything seen so far for the first inference), plus the goal
        // text for the first inference of the run.
        const newContext: ContextItem[] = [];
        let payloadTruncated = false;
        if (!Number.isFinite(lastInferenceEnd) && goalText.length > 0) {
          const capped = capText(goalText);
          newContext.push({
            role: 'user',
            label: 'goal',
            text: capped.text,
            chars: goalText.length,
          });
          payloadTruncated = payloadTruncated || capped.truncated;
        }
        for (const t of completedTools.values()) {
          if (Number.isFinite(lastInferenceEnd) && !(t.at > lastInferenceEnd)) continue;
          if (t.at > rec.at) continue;
          if (t.detail.length === 0) continue;
          const capped = capText(t.detail);
          newContext.push({
            role: 'tool_result',
            label: `${t.name} result`,
            text: capped.text,
            chars: t.detail.length,
            ok: !t.failed,
          });
          payloadTruncated = payloadTruncated || capped.truncated;
        }
        const payload: SpanPayload = { newContext };
        if (payloadTruncated) payload.truncated = true;
        span.payload = payload;
        parentOf(parentFor()).children.push(span);
        lastInferenceEnd = rec.at;
        lastModelSpan = span;
        break;
      }

      case 'tool-call': {
        const callId = str(rec.data, 'callId');
        if (callId.length === 0) break;
        const toolName = str(rec.data, 'toolName') || 'tool';
        pendingCalls.set(callId, {
          at: rec.at,
          name: toolName,
          parentId: parentFor(),
          input: rec.data.input,
          callDetail: rec.detail,
        });
        break;
      }

      case 'tool-result': {
        const callId = str(rec.data, 'callId');
        if (callId.length === 0) break;
        const pending = pendingCalls.get(callId);
        pendingCalls.delete(callId);
        const toolName = str(rec.data, 'toolName') || (pending?.name ?? 'tool');
        const failed = rec.data.failed === true;
        const start =
          pending !== undefined
            ? pending.at
            : rec.at - Math.max(0, num(rec.data, 'durationMs'));
        const parent = pending !== undefined ? pending.parentId : parentFor();
        const span = makeSpan('tool', toolName, start, rec.at, parent, {
          toolName,
          ok: !failed,
          detail: failed ? truncate(rec.detail) : undefined,
        });
        // Payload for the detail pane: input from the tool-call record
        // (data.input, else its detail), output from this tool-result record.
        const payload: SpanPayload = {};
        let payloadTruncated = false;
        const rawInput = stringifyInput(pending !== undefined ? pending.input : undefined);
        const inputSource =
          rawInput.length > 0 ? rawInput : pending !== undefined ? pending.callDetail : '';
        if (inputSource.length > 0) {
          const capped = capText(inputSource);
          payload.input = capped.text;
          payloadTruncated = payloadTruncated || capped.truncated;
        }
        if (rec.detail.length > 0) {
          const capped = capText(rec.detail);
          payload.output = capped.text;
          payloadTruncated = payloadTruncated || capped.truncated;
        }
        if (payloadTruncated) payload.truncated = true;
        span.payload = payload;
        completedTools.set(callId, { at: rec.at, name: toolName, failed, detail: rec.detail });
        parentOf(parent).children.push(span);
        break;
      }

      case 'loop-start': {
        const loopNo = num(rec.data, 'loop');
        if (currentLoop !== null) {
          currentLoop.endMs = Math.max(currentLoop.startMs, rec.at);
        }
        const span = makeSpan('turn', `loop ${loopNo}`, rec.at, rec.at, root.id, {
          detail: rec.detail.length > 0 ? truncate(rec.detail) : undefined,
        });
        root.children.push(span);
        currentLoop = span;
        break;
      }

      case 'model-text': {
        // The visible model output for the most recent inference.
        if (
          lastModelSpan !== null &&
          lastModelSpan.payload !== undefined &&
          lastModelSpan.payload.output === undefined &&
          rec.detail.length > 0
        ) {
          const capped = capText(rec.detail);
          lastModelSpan.payload.output = capped.text;
          if (capped.truncated) lastModelSpan.payload.truncated = true;
        }
        break;
      }

      default:
        break;
    }

    // iteration-start → meta on the current loop (not a separate span).
    if (rec.kind === 'iteration-start') {
      const cycle = num(rec.data, 'cycle');
      if (currentLoop !== null) {
        currentLoop.meta = { ...currentLoop.meta, cycle };
        const loopNo = num(rec.data, 'loop') || Number(currentLoop.name.match(/^loop (\d+)/)?.[1] ?? 0);
        currentLoop.name = `loop ${loopNo} · ${cycle} cycle${cycle === 1 ? '' : 's'}`;
      }
      continue;
    }

    if (MISC_KINDS.has(rec.kind)) {
      const parent = parentFor();
      const span = makeSpan('other', rec.kind, rec.at, rec.at + 1, parent, {
        detail: rec.detail.length > 0 ? truncate(rec.detail) : undefined,
      });
      parentOf(parent).children.push(span);
      continue;
    }

    if (SUMMARY_KINDS.has(rec.kind)) {
      if (rec.detail.length > 0) root.detail = truncate(rec.detail);
      continue;
    }
  }

  // Close unmatched tool calls at the last observed timestamp.
  if (pendingCalls.size > 0) {
    const end = Number.isFinite(lastAt) ? lastAt : Date.now();
    for (const [callId, pending] of pendingCalls) {
      const span = makeSpan('tool', pending.name, pending.at, Math.max(pending.at + 1, end), pending.parentId, {
        toolName: pending.name,
        detail: `no tool-result for ${callId}`,
      });
      parentOf(pending.parentId).children.push(span);
    }
  }

  // Close the last loop at the end of the session.
  if (currentLoop !== null) {
    const end = Number.isFinite(lastAt) ? lastAt : currentLoop.startMs;
    currentLoop.endMs = Math.max(currentLoop.startMs, end);
  }

  if (Number.isFinite(firstAt)) {
    root.startMs = firstAt;
    root.endMs = Math.max(firstAt, Number.isFinite(lastAt) ? lastAt : firstAt);
  }

  if (inferenceCount === 0) {
    warnings.push('no inference events — token/cost data unavailable');
  }

  // warnings === session.warnings here; finishSession must not re-push them.
  return finishSession(session, []);
}

function findSpan(root: Span, id: string): Span | null {
  const stack: Span[] = [root];
  while (stack.length > 0) {
    const span = stack.pop() as Span;
    if (span.id === id) return span;
    for (let i = span.children.length - 1; i >= 0; i--) {
      stack.push(span.children[i] as Span);
    }
  }
  return null;
}
