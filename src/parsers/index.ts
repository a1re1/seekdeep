// Format detection + dispatch for the supported transcript formats.

import type { Session } from '../model.ts';
import { parseClaudeCode } from './claude-code.ts';
import { parseCodex } from './codex.ts';
import { parseGeneric } from './generic.ts';
import { parseDrip } from './drip.ts';
import { flattenOpencodeExport, parseOpencode } from './opencode.ts';
import { parsePi } from './pi.ts';
import { tryParse } from './util.ts';

export function detectFormat(lines: string[]): Session['format'] {
  let sawClaude = false;
  let sawDrip = false;
  let sawCodex = false;
  let sawOpencode = false;
  let sawPi = false;

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

    // Flattened OpenCode records: {"type":"opencode.session"|"opencode.message"|"opencode.part","data":{…}}.
    if (type.startsWith('opencode.') && record['data'] !== null && typeof record['data'] === 'object') {
      sawOpencode = true;
    }

    // pi: a session header, or tree entries carrying id/parentId + message.
    if (
      (type === 'session' && typeof record['cwd'] === 'string' && typeof record['id'] === 'string') ||
      (type === 'message' && record['parentId'] !== undefined && record['message'] !== null && typeof record['message'] === 'object')
    ) {
      sawPi = true;
    }

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
      sawDrip = true;
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
  if (sawDrip) return 'drip';
  if (sawCodex) return 'codex';
  if (sawOpencode) return 'opencode';
  if (sawPi) return 'pi';
  return 'generic';
}

export function parseTranscript(text: string, fileName: string): Session {
  // A dropped `opencode export` JSON document becomes flattened records first.
  const flat = flattenOpencodeExport(text);
  if (flat !== null) text = flat;
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
      case 'drip':
        session = parseDrip(text, fileName);
        break;
      case 'codex':
        session = parseCodex(text, fileName);
        break;
      case 'opencode':
        session = parseOpencode(text, fileName);
        break;
      case 'pi':
        session = parsePi(text, fileName);
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
