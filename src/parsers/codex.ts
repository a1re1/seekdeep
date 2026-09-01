// Parser for Codex rollout JSONL files.
//
// Every line is `{"timestamp":"<ISO>","type":"<t>","payload":{…}}`:
// - session_meta  → payload.id / cwd / cli_version / model_provider → session
//   id + root meta.
// - turn_context  → payload.turn_id (+ optional payload.model) → a `turn`
//   span, closed by the matching event_msg task_complete / turn_aborted
//   (payload.turn_id, payload.duration_ms).
// - event_msg token_count → payload.info.last_token_usage → a `model` span
//   (1 ms wide unless a preceding response_item message/function_call
//   timestamp gives a start): input = input_tokens − cached_input_tokens,
//   cacheRead = cached_input_tokens, cacheWrite = 0, output = output_tokens,
//   reasoning = reasoning_output_tokens. Model name = the most recent
//   turn_context payload.model, else "codex".
// - response_item function_call / function_call_output → `tool` spans paired
//   by call_id.
// - response_item message (role user) / event_msg user_message → turn title;
//   event_msg agent_message → turn detail.
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

interface TurnState {
  span: Span;
  turnId: string;
  titled: boolean;
}

interface PendingCall {
  at: number;
  name: string;
  args?: string;
  argsFull: string;
  parent: Span;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/** Extract the prompt text from a response_item message payload. */
function messageText(payload: Record<string, unknown>): string {
  const content = payload['content'];
  if (typeof content === 'string') return content;
  const list = Array.isArray(content) ? content : [];
  const parts: string[] = [];
  for (const item of list) {
    const obj = asObject(item);
    if (obj === null) continue;
    const text = obj['text'];
    if (typeof text === 'string' && text.length > 0) parts.push(text);
  }
  return parts.join(' ');
}

function closeTurn(turn: TurnState, endMs: number): void {
  turn.span.endMs = Math.max(turn.span.startMs, endMs);
}

export function parseCodex(text: string, fileName: string): Session {
  const session = baseSession('codex', fileName, fileName);
  const root = session.root;

  let openTurn: TurnState | null = null;
  const turnsById = new Map<string, TurnState>();
  const pendingCalls = new Map<string, PendingCall>();
  let currentModel = 'codex';
  let lastItemTs: number | null = null;
  // Conversation items appended since the previous token_count: they are the
  // uncached, new part of the next model call's prompt.
  let newItems: ContextItem[] = [];
  let lastModelSpan: Span | null = null;
  let firstAt = NaN;
  let lastAt = NaN;
  let sawUserPrompt = false;

  const applyUserPrompt = (text: string): void => {
    if (!sawUserPrompt) {
      session.title = truncate(text, 80);
      sawUserPrompt = true;
    }
    if (openTurn !== null && !openTurn.titled) {
      openTurn.span.name = truncate(text, 80);
      openTurn.titled = true;
    }
  };

  const attachModelOutput = (text: string): void => {
    if (lastModelSpan === null) return;
    const payload = lastModelSpan.payload ?? {};
    if (payload.output !== undefined) return;
    const capped = capText(text);
    payload.output = capped.text;
    if (capped.truncated) payload.truncated = true;
    lastModelSpan.payload = payload;
  };

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const raw = tryParse(trimmed);
    if (raw === null) continue;

    const ts = parseTs(raw['timestamp']);
    if (!Number.isFinite(ts)) continue;
    const payload = asObject(raw['payload']);
    if (payload === null) continue;
    const type = typeof raw['type'] === 'string' ? raw['type'] : '';

    if (!Number.isFinite(firstAt) || ts < firstAt) firstAt = ts;
    if (!Number.isFinite(lastAt) || ts > lastAt) lastAt = ts;

    if (type === 'session_meta') {
      const id = payload['id'];
      if (typeof id === 'string' && id.length > 0 && session.id === fileName) {
        session.id = id;
        root.id = id;
      }
      const meta: Record<string, string | number | boolean> = {};
      const cwd = payload['cwd'];
      if (typeof cwd === 'string') meta.cwd = cwd;
      const cli = payload['cli_version'];
      if (typeof cli === 'string') meta.cliVersion = cli;
      const provider = payload['model_provider'];
      if (typeof provider === 'string') meta.modelProvider = provider;
      if (Object.keys(meta).length > 0) root.meta = { ...root.meta, ...meta };
      continue;
    }

    if (type === 'turn_context') {
      const model = payload['model'];
      if (typeof model === 'string' && model.length > 0) currentModel = model;
      const turnId = str(payload['turn_id']);
      if (openTurn !== null) closeTurn(openTurn, ts);
      const span = makeSpan('turn', `turn ${shortId(turnId)}`.trim(), ts, ts, root.id);
      const state: TurnState = { span, turnId, titled: false };
      if (turnId.length > 0) turnsById.set(turnId, state);
      openTurn = state;
      root.children.push(span);
      continue;
    }

    if (type === 'event_msg') {
      const evt = str(payload['type']);
      if (evt === 'token_count') {
        const info = asObject(payload['info']);
        const last = info !== null ? asObject(info['last_token_usage']) : null;
        if (last === null) continue;
        const cached = Math.max(0, num(last['cached_input_tokens']));
        const reasoning = Math.max(0, num(last['reasoning_output_tokens']));
        const usage: Usage = {
          input: Math.max(0, num(last['input_tokens']) - cached),
          cacheRead: cached,
          cacheWrite: 0,
          output: Math.max(0, num(last['output_tokens'])),
        };
        if (reasoning > 0) usage.reasoning = reasoning;
        const parent = openTurn !== null ? openTurn.span : root;
        const start = lastItemTs !== null && lastItemTs <= ts ? lastItemTs : ts;
        const span = makeSpan('model', currentModel, start, Math.max(ts, start + 1), parent.id, {
          model: currentModel,
          usage,
          payload: { newContext: newItems },
        });
        newItems = [];
        lastModelSpan = span;
        parent.children.push(span);
        continue;
      }

      if (evt === 'task_complete' || evt === 'turn_aborted') {
        const turnId = str(payload['turn_id']);
        const target: TurnState | null =
          turnId.length > 0 ? (turnsById.get(turnId) ?? openTurn) : openTurn;
        if (target !== null && target !== undefined) {
          closeTurn(target, ts);
          const durationMs = num(payload['duration_ms']);
          if (durationMs > 0) {
            target.span.meta = { ...target.span.meta, durationMs };
          }
          if (openTurn === target) openTurn = null;
        }
        continue;
      }

      if (evt === 'user_message') {
        const text = str(payload['message']) || str(payload['text']);
        if (text.length > 0) {
          applyUserPrompt(text);
          newItems.push(contextItem('user', 'user prompt', text));
        }
        continue;
      }

      if (evt === 'agent_message') {
        const text = str(payload['message']) || str(payload['text']);
        if (text.length > 0 && openTurn !== null && openTurn.span.detail === undefined) {
          openTurn.span.detail = truncate(text);
        }
        if (text.length > 0) attachModelOutput(text);
        continue;
      }
      continue;
    }

    if (type === 'response_item') {
      const itemType = str(payload['type']);
      // Only message/function_call items give a model span its start
      // timestamp (per spec).
      if (itemType === 'message' || itemType === 'function_call') lastItemTs = ts;

      if (itemType === 'message') {
        const text = messageText(payload);
        if (str(payload['role']) === 'user') {
          if (text.length > 0) {
            applyUserPrompt(text);
            newItems.push(contextItem('user', 'user prompt', text));
          }
        } else if (str(payload['role']) === 'assistant' && text.length > 0) {
          attachModelOutput(text);
        }
        continue;
      }

      const parent = openTurn !== null ? openTurn.span : root;

      if (itemType === 'function_call') {
        const callId = str(payload['call_id']);
        if (callId.length === 0) continue;
        const args = payload['arguments'];
        // Codex re-issues the same call_id when it retries after an error;
        // emit the earlier call as an unmatched span instead of dropping it.
        const dup = pendingCalls.get(callId);
        if (dup !== undefined) {
          pendingCalls.delete(callId);
          const dupSpan = makeSpan('tool', dup.name, dup.at, Math.max(dup.at + 1, ts), dup.parent.id, {
            toolName: dup.name,
            toolInput: dup.args,
            detail: `superseded by a retry of ${shortId(callId)}`,
          });
          dup.parent.children.push(dupSpan);
        }
        pendingCalls.set(callId, {
          at: ts,
          name: str(payload['name']) || 'tool',
          args: typeof args === 'string' ? truncate(args) : undefined,
          argsFull: typeof args === 'string' ? args : '',
          parent,
        });
        continue;
      }

      if (itemType === 'function_call_output') {
        const callId = str(payload['call_id']);
        if (callId.length === 0) continue;
        const pending = pendingCalls.get(callId);
        pendingCalls.delete(callId);
        const name = pending !== undefined ? pending.name : `tool ${shortId(callId)}`;
        const start = pending !== undefined ? pending.at : ts;
        const output = typeof payload['output'] === 'string' ? payload['output'] : '';
        const inp = capText(pending?.argsFull);
        const out = capText(output);
        const toolPayload: SpanPayload = { input: inp.text, output: out.text };
        if (inp.truncated || out.truncated) toolPayload.truncated = true;
        const span = makeSpan('tool', name, start, Math.max(ts, start + 1), parent.id, {
          toolName: name,
          toolInput: pending?.args,
          ok: true,
          payload: toolPayload,
        });
        parent.children.push(span);
        newItems.push(contextItem('tool_result', `${name} result`, output, true));
        continue;
      }
      continue;
    }
  }

  // Close unmatched function calls (no function_call_output arrived).
  const lastFinite = Number.isFinite(lastAt);
  for (const [callId, pending] of pendingCalls) {
    const ceiling = Math.max(pending.parent.endMs, pending.at + 1);
    const desired = lastFinite ? lastAt : pending.at + 1;
    const span = makeSpan(
      'tool',
      pending.name,
      pending.at,
      Math.max(pending.at + 1, Math.min(desired, ceiling)),
      pending.parent.id,
      {
        toolName: pending.name,
        toolInput: pending.args,
        detail: `no function_call_output for ${shortId(callId)}`,
      },
    );
    if (pending.argsFull.length > 0) {
      const capped = capText(pending.argsFull);
      const unmatchedPayload: SpanPayload = { input: capped.text };
      if (capped.truncated) unmatchedPayload.truncated = true;
      span.payload = unmatchedPayload;
    }
    pending.parent.children.push(span);
  }
  pendingCalls.clear();

  // Close a turn that never saw task_complete / turn_aborted.
  if (openTurn !== null) {
    closeTurn(openTurn, lastFinite ? lastAt : openTurn.span.startMs);
    openTurn = null;
  }

  if (Number.isFinite(firstAt)) {
    root.startMs = firstAt;
    root.endMs = Math.max(firstAt, lastFinite ? lastAt : firstAt);
  }

  return finishSession(session, []);
}

function contextItem(role: ContextItem['role'], label: string, text: string, ok?: boolean): ContextItem {
  const capped = capText(text);
  const item: ContextItem = { role, label, text: capped.text, chars: text.length };
  if (ok !== undefined) item.ok = ok;
  return item;
}
