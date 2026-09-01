// Format detection + dispatch for the supported transcript formats.

import type { Session } from '../model.ts';
import { parseClaudeCode } from './claude-code.ts';
import { parseCodex } from './codex.ts';
import { parseGeneric } from './generic.ts';
import { parseLci } from './lci.ts';
import { tryParse } from './util.ts';

export function detectFormat(lines: string[]): Session['format'] {
  let sawClaude = false;
  let sawLci = false;
  let sawCodex = false;

  // Inspect the first 50 non-empty, JSON-parseable lines.
  let inspected = 0;
  for (const line of lines) {
    if (inspected >= 50) break;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    inspected += 1;
    const record = tryParse(trimmed);
    if (record === null) continue;

    const type = record['type'];
    if (typeof type !== 'string') continue;

    if (
      (type === 'assistant' || type === 'user') &&
      (record['uuid'] !== undefined ||
        record['parentUuid'] !== undefined ||
        record['sessionId'] !== undefined)
    ) {
      sawClaude = true;
    }

    if (
      (type === 'event' && typeof record['kind'] === 'string') ||
      (type === 'goal' && record['goalId'] !== undefined)
    ) {
      sawLci = true;
    }

    if (
      (type === 'session_meta' ||
        type === 'turn_context' ||
        type === 'event_msg' ||
        type === 'response_item') &&
      record['payload'] !== null &&
      typeof record['payload'] === 'object' &&
      !Array.isArray(record['payload'])
    ) {
      sawCodex = true;
    }
  }

  if (sawClaude) return 'claude-code';
  if (sawLci) return 'lci';
  if (sawCodex) return 'codex';
  return 'generic';
}

export function parseTranscript(text: string, fileName: string): Session {
  const allLines = text.split('\n');
  const format = detectFormat(allLines);

  // Count malformed lines up front so they land in `warnings` no matter which
  // parser runs (parsers skip junk silently while scanning).
  const malformed = allLines.reduce(
    (count, line) =>
      line.trim().length > 0 && tryParse(line) === null ? count + 1 : count,
    0,
  );

  let session: Session;
  try {
    switch (format) {
      case 'claude-code':
        session = parseClaudeCode(text, fileName);
        break;
      case 'lci':
        session = parseLci(text, fileName);
        break;
      case 'codex':
        session = parseCodex(text, fileName);
        break;
      default:
        session = parseGeneric(text, fileName);
        break;
    }
  } catch (error) {
    // Last-resort safety net: parsers should never throw, but if one does,
    // fall back to the generic parser so the UI still shows something.
    const message = error instanceof Error ? error.message : String(error);
    session = parseGeneric(text, fileName);
    session.format = 'generic';
    session.warnings.push(`parser crashed (${message}); rendered as generic`);
  }

  if (malformed > 0) {
    session.warnings.push(
      `${malformed} malformed line${malformed === 1 ? '' : 's'} skipped`,
    );
  }
  if (format === 'generic' && session.format === 'generic') {
    session.warnings.push('unrecognized format — rendered as generic spans');
  }
  return session;
}
