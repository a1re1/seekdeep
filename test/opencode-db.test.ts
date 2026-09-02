// OpenCode source: WAL folding + sql.js reading + virtual transcripts. A
// small database in OpenCode's 1.x schema is written with bun:sqlite; the
// rows added after the checkpoint live only in the write-ahead log, which
// is exactly the state a live OpenCode install leaves its store in.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import initSqlJs from 'sql.js';
import type { SourceFile } from '../src/index/fs.ts';
import { applyWal, opencodeDbFiles, setSqlJsLoader } from '../src/index/opencode-db.ts';
import { scanOpencode } from '../src/index/scan.ts';
import { buildIndex } from '../src/index/link.ts';
import type { SessionEntry } from '../src/index/scan.ts';
import { parseTranscript } from '../src/parsers/index.ts';
import { flatten } from '../src/model.ts';

const ROOT = 'ses_root';
const CHILD = 'ses_child';
const CWD = '/Users/t/proj';

let dir: string;
let dbBytes: Uint8Array;
let walBytes: Uint8Array;

beforeAll(() => {
  setSqlJsLoader(() => initSqlJs() as never);
  dir = mkdtempSync(join(tmpdir(), 'seekdeep-oc-'));
  const path = join(dir, 'opencode.db');
  const db = new Database(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  db.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, name TEXT);
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL,
      directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL, model TEXT, cost REAL DEFAULT 0 NOT NULL, tokens_input INTEGER DEFAULT 0 NOT NULL,
      tokens_output INTEGER DEFAULT 0 NOT NULL, tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_read INTEGER DEFAULT 0 NOT NULL, tokens_cache_write INTEGER DEFAULT 0 NOT NULL);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
  `);
  const t0 = Date.parse('2026-09-02T10:00:00Z');
  const session = db.prepare(
    'INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const message = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
  const part = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)');
  db.exec("INSERT INTO project VALUES ('p1', '/Users/t/proj', 'proj')");
  session.run(ROOT, 'p1', null, 'calm-river', CWD, 'Run lci', '1.18.26', t0, t0 + 60_000, '{"providerID":"openai","modelID":"gpt-5.4"}');
  message.run('msg_u1', ROOT, t0, t0, JSON.stringify({ role: 'user', time: { created: t0 }, agent: 'build' }));
  part.run('prt_u1', 'msg_u1', ROOT, t0, t0, JSON.stringify({ type: 'text', text: 'run lci please' }));
  message.run(
    'msg_a1',
    ROOT,
    t0 + 1000,
    t0 + 9000,
    JSON.stringify({
      role: 'assistant',
      parentID: 'msg_u1',
      modelID: 'gpt-5.4',
      providerID: 'openai',
      time: { created: t0 + 1000, completed: t0 + 9000 },
      tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 50, write: 0 } },
      cost: 0,
      finish: 'stop',
    }),
  );
  part.run('prt_a1', 'msg_a1', ROOT, t0 + 1000, t0 + 1000, JSON.stringify({ type: 'step-start' }));
  part.run(
    'prt_a2',
    'msg_a1',
    ROOT,
    t0 + 2000,
    t0 + 8000,
    JSON.stringify({
      type: 'tool',
      tool: 'bash',
      callID: 'call_1',
      state: { status: 'completed', input: { command: 'lci --version' }, output: 'lci 0.97.0\n', time: { start: t0 + 2000, end: t0 + 8000 } },
    }),
  );
  part.run(
    'prt_a3',
    'msg_a1',
    ROOT,
    t0 + 9000,
    t0 + 9000,
    JSON.stringify({ type: 'step-finish', reason: 'stop', tokens: { total: 170, input: 100, output: 20, reasoning: 5, cache: { read: 50, write: 0 } }, cost: 0 }),
  );
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  // Everything below is committed only to the WAL.
  session.run(CHILD, 'p1', ROOT, 'quiet-fern', CWD, 'subagent: explore', '1.18.26', t0 + 3000, t0 + 4000, null);
  message.run('msg_c1', CHILD, t0 + 3000, t0 + 3000, JSON.stringify({ role: 'user', time: { created: t0 + 3000 } }));
  part.run('prt_c1', 'msg_c1', CHILD, t0 + 3000, t0 + 3000, JSON.stringify({ type: 'text', text: 'explore the repo' }));
  db.exec(`UPDATE session SET title = 'Run lci (renamed in WAL)' WHERE id = '${ROOT}'`);
  dbBytes = new Uint8Array(readFileSync(path));
  walBytes = new Uint8Array(readFileSync(`${path}-wal`));
  db.close();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const bin = (path: string, bytes: Uint8Array): SourceFile => ({
  path,
  name: path.slice(path.lastIndexOf('/') + 1),
  size: bytes.length,
  lastModified: 1,
  text: async () => new TextDecoder('latin1').decode(bytes),
  bytes: async () => bytes,
});

const files = (): SourceFile[] => [bin('opencode.db', dbBytes), bin('opencode.db-wal', walBytes), bin('log/x.log', new Uint8Array())];

describe('applyWal', () => {
  test('folds committed WAL frames in; rows only in the WAL become visible', async () => {
    expect(walBytes.length).toBeGreaterThan(32);
    const SQL = await initSqlJs();
    const stale = new SQL.Database(applyWal(dbBytes, null));
    expect(stale.exec('SELECT COUNT(*) FROM session')[0]?.values[0]?.[0]).toBe(1);
    const fresh = new SQL.Database(applyWal(dbBytes, walBytes));
    expect(fresh.exec('SELECT COUNT(*) FROM session')[0]?.values[0]?.[0]).toBe(2);
    expect(fresh.exec(`SELECT title FROM session WHERE id = '${ROOT}'`)[0]?.values[0]?.[0]).toBe('Run lci (renamed in WAL)');
  });

  test('garbage or truncated logs leave the image untouched', () => {
    expect(applyWal(dbBytes, new Uint8Array([1, 2, 3])).length).toBe(dbBytes.length);
    expect(applyWal(dbBytes, walBytes.subarray(0, 40)).length).toBe(dbBytes.length);
    const corrupt = new Uint8Array(walBytes);
    corrupt[100] = (corrupt[100] ?? 0) ^ 0xff; // inside the first frame's page → checksum fails → nothing applied
    expect(applyWal(dbBytes, corrupt).length).toBe(dbBytes.length);
  });

  test('the folded image reads as a rollback-journal database', () => {
    const out = applyWal(dbBytes, walBytes);
    expect(out[18]).toBe(1);
    expect(out[19]).toBe(1);
  });
});

describe('scanOpencode', () => {
  test('finds the database (and WAL) among the picked files', () => {
    const found = opencodeDbFiles(files());
    expect(found?.db.path).toBe('opencode.db');
    expect(found?.wal?.path).toBe('opencode.db-wal');
    expect(opencodeDbFiles([bin('log/x.log', new Uint8Array())])).toBeNull();
  });

  test('one entry per root session; children fold into it; WAL rows count', async () => {
    const entries = await scanOpencode(files());
    expect(entries.map((e) => e.id)).toEqual([ROOT]);
    const e = entries[0]!;
    expect(e.kind).toBe('opencode');
    expect(e.cwd).toBe(CWD);
    expect(e.title).toBe('Run lci (renamed in WAL)');
    expect(e.startMs).toBe(Date.parse('2026-09-02T10:00:00Z'));
    expect(e.endMs).toBe(Date.parse('2026-09-02T10:01:00Z'));
    expect(e.path).toBe(`opencode.db#${ROOT}`);
    expect(e.sizeBytes).toBeGreaterThan(0);
  });

  test('the virtual transcript is flattened JSONL the opencode parser accepts', async () => {
    const [e] = await scanOpencode(files());
    const text = await e!.file.text();
    const types = text.trim().split('\n').map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types.filter((t) => t === 'opencode.session')).toHaveLength(2);
    expect(types.filter((t) => t === 'opencode.message')).toHaveLength(3);
    expect(types.filter((t) => t === 'opencode.part')).toHaveLength(5);
    // Session records come first, root before child; parts follow their message.
    expect(types.slice(0, 3)).toEqual(['opencode.session', 'opencode.session', 'opencode.message']);
    const session = parseTranscript(text, e!.path);
    expect(session.format).toBe('opencode');
    expect(flatten(session.root).length).toBeGreaterThan(1);
  });
});

describe('buildIndex with OpenCode hosts', () => {
  test('an lci run in the same cwd during the session nests under it', async () => {
    const [host] = await scanOpencode(files());
    const lci: SessionEntry = {
      kind: 'lci',
      id: 'lci-1',
      path: 'projects/x/sessions/lci-1/transcript.jsonl',
      slug: 'x',
      cwd: CWD,
      branch: null,
      title: 'lci child',
      startMs: host!.startMs + 5000,
      endMs: host!.startMs + 30_000,
      sizeBytes: 1,
      file: bin('projects/x/sessions/lci-1/transcript.jsonl', new Uint8Array()),
    };
    const projects = buildIndex([host!, lci]);
    expect(projects).toHaveLength(1);
    const roots = projects[0]!.worktrees.flatMap((g) => g.sessions);
    expect(roots.map((n) => n.entry.id)).toEqual([ROOT]);
    expect(roots[0]!.children.map((n) => n.entry.id)).toEqual(['lci-1']);
  });
});
