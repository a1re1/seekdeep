// Pure, testable scanning of Claude Code, lci, pi and OpenCode sources into
// SessionEntry records. Only the first 64 KiB (head) and last 16 KiB (tail)
// of each transcript are read: the head carries cwd/branch/title/start, the
// tail the last timestamp. Files are scanned in small batches so large
// directories stay responsive; onProgress reports (done, total).
//
// The lci head walk additionally reads the first transcript line (the goal
// prompt title) before any other file I/O, so the very first read returns
// the header records needed to decide whether the file is worth scanning.

import type { SourceFile, SourceKind } from './fs.ts';
import { openOpencodeDb } from './opencode-db.ts';
import type { OcSession } from './opencode-db.ts';
import { parseTs, tryParse } from '../parsers/util.ts';

export interface SessionEntry {
  kind: SourceKind;
  id: string;
  path: string;
  slug: string;
  cwd: string | null;
  branch: string | null;
  title: string;
  startMs: number;
  endMs: number;
  sizeBytes: number;
  file: SourceFile;
}

/** A SessionEntry without its live file handle — the cacheable part. */
export type CachedEntry = Omit<SessionEntry, 'file'>;

const HEAD_BYTES = 64 * 1024;
const BIG_HEAD_BYTES = 4 * 1024 * 1024; // fallback when the head is one giant record
const TAIL_BYTES = 16 * 1024;
const BIG_TAIL_BYTES = 1024 * 1024; // fallback when the last record is one giant line
const BATCH_SIZE = 16;

// ---- public API ----------------------------------------------------------

export async function scanClaude(
  files: SourceFile[],
  onProgress?: (done: number, total: number) => void,
): Promise<SessionEntry[]> {
  const entries = await mapBatched(claudeTranscripts(files), scanClaudeFile, onProgress);
  return keepScanned(entries);
}

export async function scanLci(
  files: SourceFile[],
  onProgress?: (done: number, total: number) => void,
): Promise<SessionEntry[]> {
  const byPath = new Map<string, SourceFile>();
  for (const f of files) byPath.set(f.path, f);
  const entries = await mapBatched(lciTranscripts(files), (f) => scanLciFile(f, byPath), onProgress);
  return keepScanned(entries);
}

export async function scanPi(
  files: SourceFile[],
  onProgress?: (done: number, total: number) => void,
): Promise<SessionEntry[]> {
  const entries = await mapBatched(piTranscripts(files), scanPiFile, onProgress);
  return keepScanned(entries);
}

/**
 * OpenCode sessions come from one SQLite database rather than files: every
 * root session becomes an entry whose `file` is a virtual transcript built
 * from the database on demand (child sessions fold into their root).
 */
export async function scanOpencode(
  files: SourceFile[],
  onProgress?: (done: number, total: number) => void,
): Promise<SessionEntry[]> {
  const db = await openOpencodeDb(files);
  if (db === null) {
    onProgress?.(0, 0);
    return [];
  }
  const sessions = db.sessions();
  const byId = new Map(sessions.map((s) => [s.id, s] as const));
  // A child whose parent row is gone is still worth opening: treat it as a root.
  const roots = sessions.filter((s) => s.parentId === null || !byId.has(s.parentId));
  onProgress?.(0, roots.length);
  const dbPath = files.find((f) => f.name === 'opencode.db')?.path ?? 'opencode.db';
  // Subtree size / last update: children count toward their root.
  const sizes = db.sizes();
  const rootOf = (s: OcSession): string => {
    let cur = s;
    for (let hops = 0; cur.parentId !== null && hops < 32; hops++) {
      const parent = byId.get(cur.parentId);
      if (parent === undefined) break;
      cur = parent;
    }
    return cur.id;
  };
  const subtreeSize = new Map<string, number>();
  const subtreeEnd = new Map<string, number>();
  for (const s of sessions) {
    const root = rootOf(s);
    subtreeSize.set(root, (subtreeSize.get(root) ?? 0) + (sizes.get(s.id) ?? 0));
    subtreeEnd.set(root, Math.max(subtreeEnd.get(root) ?? 0, s.updatedMs, s.createdMs));
  }
  const entries = roots.map((s): SessionEntry => {
    const path = `${dbPath}#${s.id}`;
    const sizeBytes = subtreeSize.get(s.id) ?? 0;
    const endMs = subtreeEnd.get(s.id) ?? s.createdMs;
    let text: string | null = null;
    const file: SourceFile = {
      path,
      name: `${s.id}.jsonl`,
      size: sizeBytes,
      lastModified: endMs,
      text: async (range) => {
        if (text === null) text = db.transcript(s.id);
        return text.slice(range?.start ?? 0, range?.end ?? text.length);
      },
    };
    return {
      kind: 'opencode',
      id: s.id,
      path,
      slug: s.slug,
      cwd: s.directory.length > 0 ? s.directory : null,
      branch: null,
      title: clip(s.title),
      startMs: s.createdMs,
      endMs: Math.max(endMs, s.createdMs),
      sizeBytes,
      file,
    };
  });
  onProgress?.(roots.length, roots.length);
  return entries;
}

// ---- file selection ------------------------------------------------------

/** `<projects>/<slug>/<id>.jsonl` — only files directly inside a slug dir. */
export function claudeTranscripts(files: SourceFile[]): SourceFile[] {
  return files.filter((f) => {
    if (!f.name.endsWith('.jsonl')) return false;
    const parts = f.path.split('/');
    const i = parts.lastIndexOf('projects');
    return i >= 0 && parts.length - i === 3;
  });
}

/** `<slug>/sessions/<sessionId>/transcript.jsonl`. */
export function lciTranscripts(files: SourceFile[]): SourceFile[] {
  return files.filter((f) => {
    const parts = f.path.split('/');
    const i = parts.length - 1;
    return i >= 3 && parts[i] === 'transcript.jsonl' && parts[i - 2] === 'sessions';
  });
}

/** `<sessions>/<cwd-dir>/<timestamp>_<id>.jsonl` — only files directly inside a cwd dir. */
export function piTranscripts(files: SourceFile[]): SourceFile[] {
  return files.filter((f) => {
    if (!f.name.endsWith('.jsonl')) return false;
    const parts = f.path.split('/');
    const i = parts.lastIndexOf('sessions');
    return i >= 0 && parts.length - i === 3;
  });
}

function keepScanned(entries: (SessionEntry | null)[]): SessionEntry[] {
  return entries.filter((e): e is SessionEntry => e !== null);
}

// ---- claude --------------------------------------------------------------

async function scanClaudeFile(file: SourceFile): Promise<SessionEntry | null> {
  try {
    const parts = file.path.split('/');
    const slug = parts[parts.length - 2] ?? '';
    let { head, tail } = await readHeadTail(file);
    let h = claudeHead(head);
    // A first prompt with a pasted image (or a long skill body) can push the
    // first complete record past 64 KiB; retry once with a much bigger head.
    if ((Number.isNaN(h.startMs) || h.cwd === null || h.title === '') && file.size > HEAD_BYTES) {
      head = await file.text({ end: BIG_HEAD_BYTES });
      h = claudeHead(head);
    }
    if (h.cwd === null) {
      // Every record carries cwd, so the tail works when the head does not.
      const t = claudeHead(tail);
      h = { ...h, cwd: t.cwd, branch: t.branch, id: h.id ?? t.id };
    }
    let endMs = lastTs(tail, 'timestamp');
    if (Number.isNaN(endMs) && file.size > TAIL_BYTES) {
      // The last record can exceed 16 KiB (big tool output); retry once wider.
      tail = await file.text({ start: Math.max(0, file.size - BIG_TAIL_BYTES) });
      endMs = lastTs(tail, 'timestamp');
    }
    if (Number.isNaN(endMs)) endMs = lastTs(head, 'timestamp');
    let startMs = h.startMs;
    if (Number.isNaN(startMs)) startMs = endMs;
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null;
    const id = file.name.replace(/\.jsonl$/, '');
    return {
      kind: 'claude',
      id: h.id ?? id,
      path: file.path,
      slug,
      cwd: h.cwd,
      branch: h.branch,
      title: h.title,
      startMs,
      endMs: Math.max(endMs, startMs),
      sizeBytes: file.size,
      file,
    };
  } catch {
    return null; // unreadable file → skip, never throw
  }
}

interface ClaudeHead {
  cwd: string | null;
  branch: string | null;
  id: string | null;
  title: string;
  startMs: number;
}

/** Walk the head lines for cwd/branch/sessionId/title and the first timestamp. */
function claudeHead(head: string): ClaudeHead {
  const out: ClaudeHead = { cwd: null, branch: null, id: null, title: '', startMs: NaN };
  for (const line of head.split('\n')) {
    const rec = tryParse(line);
    if (rec === null) continue;
    if (Number.isNaN(out.startMs)) {
      const ts = parseTs(rec.timestamp);
      if (Number.isFinite(ts)) out.startMs = ts;
    }
    if (out.id === null && typeof rec.sessionId === 'string' && rec.sessionId.length > 0) {
      out.id = rec.sessionId;
    }
    if (out.cwd === null && typeof rec.cwd === 'string' && rec.cwd.length > 0) {
      out.cwd = rec.cwd;
      if (typeof rec.gitBranch === 'string' && rec.gitBranch.length > 0) {
        out.branch = rec.gitBranch;
      }
    }
    if (out.title === '' && rec.type === 'user') out.title = claudeTitle(rec) ?? '';
    if (out.cwd !== null && out.id !== null && out.title !== '' && !Number.isNaN(out.startMs)) break;
  }
  return out;
}

/** Title = the first real user prompt (plain string or first text block). */
function claudeTitle(rec: Record<string, unknown>): string | null {
  if (rec.isMeta === true) return null;
  const msg = rec.message;
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return null;
  const content = (msg as Record<string, unknown>).content;
  if (typeof content === 'string') return titleText(content);
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (block !== null && typeof block === 'object' && !Array.isArray(block)) {
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') return titleText(b.text);
    }
  }
  return null;
}

function titleText(text: string): string | null {
  const t = text.trim();
  if (t.length === 0) return null;
  // A skill/slash-command invocation is a fine title: "/navis add the thing".
  const cmd = /^<command-message>([^<]*)<\/command-message>\s*(?:<command-name>[^<]*<\/command-name>)?\s*(?:<command-args>([^<]*)<\/command-args>)?/.exec(t);
  if (cmd !== null) {
    const name = (cmd[1] ?? '').trim().replace(/^\/?/, '/');
    const args = (cmd[2] ?? '').trim();
    return clip(args.length > 0 ? `${name} ${args}` : name);
  }
  // Other "<"-prefixed prompts are injected system reminders/commands.
  return t.startsWith('<') ? null : clip(t);
}

const TITLE_MAX = 120;

/** First non-empty line of a prompt, capped — goals can run to many KB. */
function clip(text: string): string {
  const line = text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

// ---- lci -----------------------------------------------------------------

async function scanLciFile(
  file: SourceFile,
  byPath: Map<string, SourceFile>,
): Promise<SessionEntry | null> {
  try {
    const parts = file.path.split('/');
    const i = parts.length - 1; // index of 'transcript.jsonl'
    const slug = parts[i - 3] ?? '';
    const dir = parts.slice(0, i).join('/') + '/';
    const meta = await readSibling(byPath, `${dir}session.json`);
    const result = await readSibling(byPath, `${dir}result.json`);
    const { head, tail } = await readHeadTail(file);

    const cwd = typeof meta?.cwd === 'string' && meta.cwd.length > 0 ? meta.cwd : null;
    const id = typeof meta?.id === 'string' && meta.id.length > 0 ? meta.id : parts[i - 1] ?? file.name;

    let title = typeof result?.goal === 'string' ? clip(result.goal) : '';
    if (title === '') title = lciTitle(head);

    // Prefer the sibling metadata; fall back to transcript timestamps.
    let startMs = parseTs(meta?.createdAt);
    if (Number.isNaN(startMs)) startMs = firstTs(head, 'at');
    let endMs = parseTs(result?.endedAt);
    if (Number.isNaN(endMs)) endMs = lastTs(tail, 'at');
    if (Number.isNaN(endMs)) endMs = lastTs(head, 'at');
    if (Number.isNaN(startMs) && Number.isNaN(endMs)) return null;
    if (Number.isNaN(startMs)) startMs = endMs;
    if (Number.isNaN(endMs)) endMs = startMs;

    return {
      kind: 'lci',
      id,
      path: file.path,
      slug,
      cwd,
      branch: null,
      title,
      startMs,
      endMs: Math.max(endMs, startMs),
      sizeBytes: file.size,
      file,
    };
  } catch {
    return null; // unreadable file → skip, never throw
  }
}

/** First record carrying a non-empty string `text` field = the goal prompt. */
function lciTitle(head: string): string {
  for (const line of head.split('\n')) {
    const rec = tryParse(line);
    if (rec === null) continue;
    if (typeof rec.text === 'string' && rec.text.trim().length > 0) return clip(rec.text);
  }
  return '';
}

async function readSibling(
  byPath: Map<string, SourceFile>,
  path: string,
): Promise<Record<string, unknown> | null> {
  const f = byPath.get(path);
  if (f === undefined) return null;
  return tryParse(await f.text());
}

// ---- pi ------------------------------------------------------------------

async function scanPiFile(file: SourceFile): Promise<SessionEntry | null> {
  try {
    const parts = file.path.split('/');
    const slug = parts[parts.length - 2] ?? '';
    const { head, tail } = await readHeadTail(file);
    const h = piHead(head);
    let endMs = lastTs(tail, 'timestamp');
    if (Number.isNaN(endMs)) endMs = lastTs(head, 'timestamp');
    let startMs = h.startMs;
    if (Number.isNaN(startMs)) startMs = firstTs(head, 'timestamp');
    if (Number.isNaN(startMs)) startMs = endMs;
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null;
    // File names are `<timestamp>_<id>.jsonl`; the header id wins when present.
    const stem = file.name.replace(/\.jsonl$/, '');
    const id = h.id ?? stem.slice(stem.indexOf('_') + 1);
    return {
      kind: 'pi',
      id,
      path: file.path,
      slug,
      cwd: h.cwd,
      branch: null,
      title: h.title,
      startMs,
      endMs: Math.max(endMs, startMs),
      sizeBytes: file.size,
      file,
    };
  } catch {
    return null; // unreadable file → skip, never throw
  }
}

interface PiHead {
  id: string | null;
  cwd: string | null;
  title: string;
  startMs: number;
}

/** The `session` header (id, cwd, timestamp) and the first user prompt. */
function piHead(head: string): PiHead {
  const out: PiHead = { id: null, cwd: null, title: '', startMs: NaN };
  for (const line of head.split('\n')) {
    const rec = tryParse(line);
    if (rec === null) continue;
    if (rec.type === 'session') {
      if (typeof rec.id === 'string' && rec.id.length > 0) out.id = rec.id;
      if (typeof rec.cwd === 'string' && rec.cwd.length > 0) out.cwd = rec.cwd;
      const ts = parseTs(rec.timestamp);
      if (Number.isFinite(ts)) out.startMs = ts;
      continue;
    }
    if (out.title === '' && rec.type === 'message') {
      const msg = rec.message;
      if (msg !== null && typeof msg === 'object' && !Array.isArray(msg)) {
        const m = msg as Record<string, unknown>;
        if (m.role === 'user') out.title = piText(m.content) ?? '';
      }
    }
    if (out.title !== '' && out.id !== null) break;
  }
  return out;
}

function piText(content: unknown): string | null {
  if (typeof content === 'string') return titleText(content);
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (block !== null && typeof block === 'object' && !Array.isArray(block)) {
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') return titleText(b.text);
    }
  }
  return null;
}

// ---- shared helpers ------------------------------------------------------

/** Read at most the first HEAD_BYTES and last TAIL_BYTES of a transcript. */
async function readHeadTail(file: SourceFile): Promise<{ head: string; tail: string }> {
  if (file.size <= HEAD_BYTES) {
    return { head: await file.text({ end: HEAD_BYTES }), tail: '' };
  }
  const head = file.text({ end: HEAD_BYTES });
  const tail = file.text({ start: Math.max(0, file.size - TAIL_BYTES) });
  return { head: await head, tail: await tail };
}

function firstTs(text: string, field: string): number {
  for (const line of text.split('\n')) {
    const rec = tryParse(line);
    if (rec === null) continue;
    const ts = parseTs(rec[field]);
    if (Number.isFinite(ts)) return ts;
  }
  return NaN;
}

function lastTs(text: string, field: string): number {
  let ts = NaN;
  for (const line of text.split('\n')) {
    const rec = tryParse(line);
    if (rec === null) continue;
    const t = parseTs(rec[field]);
    if (Number.isFinite(t)) ts = t;
  }
  return ts;
}

/** Promise.all over chunks of BATCH_SIZE, reporting (done, total) per chunk. */
async function mapBatched<T, R>(
  items: readonly T[],
  run: (item: T) => Promise<R>,
  onProgress?: (done: number, total: number) => void,
): Promise<R[]> {
  const out: R[] = [];
  let done = 0;
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const chunk = items.slice(i, i + BATCH_SIZE);
    for (const r of await Promise.all(chunk.map(run))) out.push(r);
    done += chunk.length;
    onProgress?.(done, items.length);
  }
  return out;
}
