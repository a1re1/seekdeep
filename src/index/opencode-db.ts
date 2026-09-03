// Reading OpenCode's session store in the browser. OpenCode (≥ 1.x) keeps
// sessions, messages and parts in a SQLite database (`opencode.db`) that is
// usually mid-transaction: recent rows live only in its write-ahead log
// (`opencode.db-wal`). Both files are read through the directory handle, the
// committed WAL frames are folded into the database image here (sql.js has
// no WAL support), and the result is opened read-only with sql.js — loaded
// lazily, only when an OpenCode source is connected.
//
// Sessions are surfaced as virtual transcripts: one JSONL document per root
// session, in the flattened record shape src/parsers/opencode.ts consumes
// ({"type":"opencode.session"|"opencode.message"|"opencode.part","data":{…}}),
// with child sessions (sub-agents) folded into their root's document.

import type { SourceFile } from './fs.ts';
import { OPENCODE_DB } from './fs.ts';

// ---- sql.js, typed minimally (the wasm build is a script-tag global) -----

export interface SqlDatabase {
  exec(sql: string, params?: (string | number | null)[]): { columns: string[]; values: unknown[][] }[];
  close(): void;
}

export interface SqlJs {
  Database: new (data?: Uint8Array) => SqlDatabase;
}

export type SqlJsLoader = () => Promise<SqlJs>;

let loader: SqlJsLoader = browserLoader;
let loaded: Promise<SqlJs> | null = null;

/** Override how sql.js is obtained (tests import it from node_modules). */
export function setSqlJsLoader(fn: SqlJsLoader): void {
  loader = fn;
  loaded = null;
}

function loadSqlJs(): Promise<SqlJs> {
  if (loaded === null) {
    loaded = loader().catch((err: unknown) => {
      loaded = null; // let a later connect retry
      throw err;
    });
  }
  return loaded;
}

/** Load `./sql-wasm.js` (copied next to the bundle at build time) once. */
async function browserLoader(): Promise<SqlJs> {
  type Init = (config: { locateFile(file: string): string }) => Promise<SqlJs>;
  const w = globalThis as unknown as { initSqlJs?: Init };
  if (typeof w.initSqlJs !== 'function') {
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = './sql-wasm.js';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('could not load sql-wasm.js'));
      document.head.append(script);
    });
  }
  if (typeof w.initSqlJs !== 'function') throw new Error('sql.js did not initialise');
  return w.initSqlJs({ locateFile: (file) => `./${file}` });
}

// ---- WAL folding ---------------------------------------------------------

const WAL_MAGIC_LE = 0x377f0682;
const WAL_MAGIC_BE = 0x377f0683;
const WAL_HEADER = 32;
const FRAME_HEADER = 24;

/**
 * Fold the committed frames of a SQLite write-ahead log into a database
 * image. Frames are validated the way SQLite does (salts match the WAL
 * header, checksums chain); the walk stops at the first invalid frame and
 * only transactions with a commit frame are applied. Also rewrites the header
 * so the image reads as a rollback-journal database (sql.js cannot open a
 * WAL-mode file without its shared-memory sidecar). Never throws.
 */
export function applyWal(db: Uint8Array, wal: Uint8Array | null): Uint8Array {
  const image = new Uint8Array(db);
  if (wal === null || wal.length < WAL_HEADER) return legacyJournal(image);
  const view = new DataView(wal.buffer, wal.byteOffset, wal.byteLength);
  const magic = view.getUint32(0);
  if (magic !== WAL_MAGIC_LE && magic !== WAL_MAGIC_BE) return legacyJournal(image);
  const little = magic === WAL_MAGIC_LE;
  const pageSize = view.getUint32(8);
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) return legacyJournal(image);
  const salt1 = view.getUint32(16);
  const salt2 = view.getUint32(20);
  let [s0, s1] = walChecksum(wal, 0, 24, little, 0, 0);
  if (s0 !== view.getUint32(24) || s1 !== view.getUint32(28)) return legacyJournal(image);

  const frameSize = FRAME_HEADER + pageSize;
  const pending = new Map<number, number>(); // page number → offset of page data
  const committed = new Map<number, number>();
  let pages = 0;
  for (let off = WAL_HEADER; off + frameSize <= wal.length; off += frameSize) {
    const pgno = view.getUint32(off);
    const commit = view.getUint32(off + 4);
    if (view.getUint32(off + 8) !== salt1 || view.getUint32(off + 12) !== salt2) break;
    [s0, s1] = walChecksum(wal, off, 8, little, s0, s1);
    [s0, s1] = walChecksum(wal, off + FRAME_HEADER, pageSize, little, s0, s1);
    if (s0 !== view.getUint32(off + 16) || s1 !== view.getUint32(off + 20)) break;
    pending.set(pgno, off + FRAME_HEADER);
    if (commit !== 0) {
      for (const [page, at] of pending) committed.set(page, at);
      pending.clear();
      pages = commit;
    }
  }
  if (committed.size === 0) return legacyJournal(image);

  const out = new Uint8Array(pages * pageSize);
  out.set(image.subarray(0, Math.min(image.length, out.length)));
  for (const [page, at] of committed) {
    const start = (page - 1) * pageSize;
    if (start + pageSize <= out.length) out.set(wal.subarray(at, at + pageSize), start);
  }
  const header = new DataView(out.buffer, out.byteOffset, out.byteLength);
  header.setUint32(28, pages); // in-header database size…
  header.setUint32(92, header.getUint32(24)); // …is trusted only when this matches the change counter
  return legacyJournal(out);
}

/** SQLite's WAL checksum: pairs of native-endian 32-bit words folded into (s0, s1). */
function walChecksum(
  bytes: Uint8Array,
  offset: number,
  length: number,
  little: boolean,
  s0: number,
  s1: number,
): [number, number] {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, length);
  for (let i = 0; i + 8 <= length; i += 8) {
    s0 = (s0 + view.getUint32(i, little) + s1) >>> 0;
    s1 = (s1 + view.getUint32(i + 4, little) + s0) >>> 0;
  }
  return [s0, s1];
}

/** Mark the image as a rollback-journal database (bytes 18/19 = 1). */
function legacyJournal(image: Uint8Array): Uint8Array {
  if (image.length >= 100) {
    image[18] = 1;
    image[19] = 1;
  }
  return image;
}

// ---- the session store ---------------------------------------------------

export interface OcSession {
  id: string;
  parentId: string | null;
  slug: string;
  projectId: string;
  directory: string;
  title: string;
  version: string;
  createdMs: number;
  updatedMs: number;
}

type Row = Record<string, unknown>;

export class OpencodeDb {
  constructor(private readonly db: SqlDatabase) {}

  close(): void {
    this.db.close();
  }

  /** Every session row, oldest first (children included; see `parentId`). */
  sessions(): OcSession[] {
    return this.rows('SELECT * FROM session ORDER BY time_created').map((r) => ({
      id: str(r.id),
      parentId: r.parent_id === null || r.parent_id === undefined ? null : str(r.parent_id),
      slug: str(r.slug),
      projectId: str(r.project_id),
      directory: str(r.directory),
      title: str(r.title),
      version: str(r.version),
      createdMs: num(r.time_created),
      updatedMs: num(r.time_updated),
    }));
  }

  /** Bytes of message + part JSON per session id, in one pass. */
  sizes(): Map<string, number> {
    const out = new Map<string, number>();
    for (const table of ['message', 'part']) {
      for (const r of this.rows(`SELECT session_id AS id, SUM(LENGTH(CAST(data AS BLOB))) AS n FROM ${table} GROUP BY session_id`)) {
        const id = str(r.id);
        out.set(id, (out.get(id) ?? 0) + num(r.n));
      }
    }
    return out;
  }

  /** The flattened JSONL transcript of a root session and its descendants. */
  transcript(rootId: string): string {
    const tree = this.rows(
      `WITH RECURSIVE tree(id, depth) AS (
         SELECT id, 0 FROM session WHERE id = ?
         UNION ALL
         SELECT s.id, tree.depth + 1 FROM session s JOIN tree ON s.parent_id = tree.id
       )
       SELECT session.* FROM tree JOIN session ON session.id = tree.id ORDER BY tree.depth, session.time_created`,
      [rootId],
    );
    const lines: string[] = [];
    for (const s of tree) lines.push(record('opencode.session', sessionData(s)));
    for (const s of tree) {
      const id = str(s.id);
      const messages = this.rows('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id', [id]);
      const parts = new Map<string, Row[]>();
      for (const p of this.rows('SELECT id, message_id, data FROM part WHERE session_id = ? ORDER BY time_created, id', [id])) {
        const mid = str(p.message_id);
        const list = parts.get(mid);
        if (list === undefined) parts.set(mid, [p]);
        else list.push(p);
      }
      for (const m of messages) {
        const mid = str(m.id);
        lines.push(record('opencode.message', { ...json(m.data), id: mid, sessionID: id }));
        for (const p of parts.get(mid) ?? []) {
          lines.push(record('opencode.part', { ...json(p.data), id: str(p.id), sessionID: id, messageID: mid }));
        }
      }
    }
    return lines.join('\n') + '\n';
  }

  private rows(sql: string, params?: (string | number | null)[]): Row[] {
    const result = this.db.exec(sql, params)[0];
    if (result === undefined) return [];
    return result.values.map((values) => {
      const row: Row = {};
      result.columns.forEach((c, i) => {
        row[c] = values[i];
      });
      return row;
    });
  }
}

/** The session row in the shape `opencode export` uses for `info`. */
function sessionData(r: Row): Record<string, unknown> {
  return {
    id: str(r.id),
    slug: str(r.slug),
    projectID: str(r.project_id),
    directory: str(r.directory),
    title: str(r.title),
    version: str(r.version),
    ...(r.parent_id !== null && r.parent_id !== undefined ? { parentID: str(r.parent_id) } : {}),
    ...(typeof r.model === 'string' ? { model: json(r.model) } : {}),
    tokens: {
      input: num(r.tokens_input),
      output: num(r.tokens_output),
      reasoning: num(r.tokens_reasoning),
      cache: { read: num(r.tokens_cache_read), write: num(r.tokens_cache_write) },
    },
    cost: num(r.cost),
    time: { created: num(r.time_created), updated: num(r.time_updated) },
  };
}

function record(type: string, data: Record<string, unknown>): string {
  return JSON.stringify({ type, data });
}

function json(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// ---- opening from a picked directory --------------------------------------

/** The database file (and its WAL) among a source's files, if present. */
export function opencodeDbFiles(files: SourceFile[]): { db: SourceFile; wal: SourceFile | null } | null {
  const db = files.find((f) => f.name === OPENCODE_DB) ?? null;
  if (db === null) return null;
  const wal = files.find((f) => f.path === `${db.path}-wal`) ?? null;
  return { db, wal };
}

let cached: { key: string; db: OpencodeDb } | null = null;

/** Open a source's OpenCode store; one instance is kept per (db, wal) stamp. */
export async function openOpencodeDb(files: SourceFile[]): Promise<OpencodeDb | null> {
  const found = opencodeDbFiles(files);
  if (found === null) return null;
  const stamp = (f: SourceFile | null): string => (f === null ? '-' : `${f.size}:${f.lastModified}`);
  const key = `${found.db.path}|${stamp(found.db)}|${stamp(found.wal)}`;
  if (cached !== null && cached.key === key) return cached.db;
  const [dbBytes, walBytes] = await Promise.all([readBytes(found.db), found.wal === null ? null : readBytes(found.wal)]);
  const SQL = await loadSqlJs();
  const db = new OpencodeDb(new SQL.Database(applyWal(dbBytes, walBytes)));
  cached?.db.close();
  cached = { key, db };
  return db;
}

async function readBytes(file: SourceFile): Promise<Uint8Array> {
  if (file.bytes !== undefined) return file.bytes();
  // SourceFiles without bytes() (in-memory test files): recover bytes 1:1 from latin1 text.
  const text = await file.text();
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}
