// Tests for the session index: pure scanning (scan.ts) and pure
// grouping/nesting (link.ts) over fake in-memory SourceFiles. No real
// directories or IndexedDB are touched.

import { describe, expect, test } from 'bun:test';
import type { SourceFile, SourceKind } from '../src/index/fs.ts';
import { scanClaude, scanLci, scanPi, type SessionEntry } from '../src/index/scan.ts';
import { buildIndex, parseScratchpadCwd, splitWorktree } from '../src/index/link.ts';

const ms = (iso: string) => Date.parse(iso);

/** A SourceFile served from an in-memory string. */
const mem = (path: string, text: string): SourceFile => ({
  path,
  name: path.slice(path.lastIndexOf('/') + 1),
  size: text.length,
  lastModified: 0,
  text: async (range) => text.slice(range?.start ?? 0, Math.min(range?.end ?? text.length, text.length)),
});

/** One JSON object per line, like a real transcript. */
const lines = (...recs: unknown[]) => recs.map((r) => JSON.stringify(r)).join('\n');

/** A minimal SessionEntry for buildIndex tests (no scanning involved). */
const ent = (
  kind: SourceKind,
  id: string,
  cwd: string | null,
  startMs: number,
  endMs: number,
  slug = '-t-proj',
): SessionEntry => ({
  kind,
  id,
  path: `${kind}/${id}.jsonl`,
  slug,
  cwd,
  branch: kind === 'claude' ? 'main' : null,
  title: `${kind} ${id}`,
  startMs,
  endMs,
  sizeBytes: 1,
  file: mem(`${kind}/${id}.jsonl`, ''),
});

describe('scanClaude', () => {
  test('scans only top-level <slug>/<id>.jsonl and extracts cwd/branch/title/start/end', async () => {
    const files = [
      mem('projects/-Users-x-src-app/c0ffee00-0000-4000-8000-000000000001.jsonl', lines(
        // Header record without cwd/timestamp.
        { type: 'mode' },
        // Injected prompt: never a title.
        { type: 'user', isMeta: true, message: { content: '<command-name>/clear</command-name>' } },
        { type: 'user', sessionId: 'c0ffee00-0000-4000-8000-000000000001', cwd: '/Users/x/src/app', gitBranch: 'feat/index', timestamp: '2026-08-30T10:00:00.000Z', message: { content: 'list the files' } },
        { type: 'assistant', timestamp: '2026-08-30T10:05:00.000Z' },
      )),
      // Session file nested in a per-session dir: not a top-level session.
      mem('projects/-Users-x-src-app/c0ffee00-0000-4000-8000-000000000002/memory/deep.jsonl', lines({ timestamp: '2026-08-30T10:00:00.000Z' })),
      // memory/ holds no sessions.
      mem('projects/-Users-x-src-app/memory/keep.jsonl', lines({ timestamp: '2026-08-30T10:00:00.000Z' })),
      // Non-transcript clutter.
      mem('projects/-Users-x-src-app/notes.txt', 'not a transcript'),
    ];
    const progress: Array<[number, number]> = [];
    const sessions = await scanClaude(files, (done, total) => progress.push([done, total]));
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.kind).toBe('claude');
    expect(s.id).toBe('c0ffee00-0000-4000-8000-000000000001');
    expect(s.slug).toBe('-Users-x-src-app');
    expect(s.cwd).toBe('/Users/x/src/app');
    expect(s.branch).toBe('feat/index');
    expect(s.title).toBe('list the files');
    expect(s.startMs).toBe(ms('2026-08-30T10:00:00.000Z'));
    expect(s.endMs).toBe(ms('2026-08-30T10:05:00.000Z'));
    expect(s.file).toBe(files[0]!);
    expect(progress[progress.length - 1]).toEqual([1, 1]);
  });

  test('title skips <-prefixed prompts and takes the next user prompt (string or text block)', async () => {
    const files = [
      mem('projects/p/s1.jsonl', lines(
        { type: 'user', sessionId: 's1', cwd: '/w/app', timestamp: '2026-08-30T10:00:00.000Z', message: { content: '<system-reminder>injected</system-reminder>' } },
        { type: 'user', timestamp: '2026-08-30T10:00:05.000Z', message: { content: [{ type: 'text', text: 'now really run it' }] } },
      )),
    ];
    const sessions = await scanClaude(files);
    expect(sessions[0]!.title).toBe('now really run it');
  });
});

describe('scanLci', () => {
  test('prefers session.json/result.json metadata when both are present', async () => {
    const dir = 'projects/-Users-x-src-app/sessions/22222222-2222-4222-8222-222222222222/';
    const transcript = mem(`${dir}transcript.jsonl`, lines(
      { at: '2026-08-30T12:00:01.000Z', text: 'fix the bug' },
      { at: '2026-08-30T12:10:00.000Z' },
    ));
    const files = [
      mem(`${dir}session.json`, JSON.stringify({ createdAt: '2026-08-30T12:00:00.000Z', cwd: '/Users/x/src/app/.worktrees/idx', id: '22222222-2222-4222-8222-222222222222', projectSlug: '-Users-x-src-app' })),
      mem(`${dir}result.json`, JSON.stringify({ endedAt: '2026-08-30T12:30:00.000Z', goal: 'ship the index', reason: 'done' })),
      transcript,
    ];
    const sessions = await scanLci(files);
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.kind).toBe('lci');
    expect(s.id).toBe('22222222-2222-4222-8222-222222222222');
    expect(s.slug).toBe('-Users-x-src-app');
    expect(s.cwd).toBe('/Users/x/src/app/.worktrees/idx');
    expect(s.title).toBe('ship the index');
    expect(s.startMs).toBe(ms('2026-08-30T12:00:00.000Z'));
    expect(s.endMs).toBe(ms('2026-08-30T12:30:00.000Z'));
    expect(s.file).toBe(transcript);
  });

  test('session.json without result.json: title from the first text, end from the transcript', async () => {
    const files = [
      mem('projects/-l-proj/sessions/sess-3/session.json', JSON.stringify({ createdAt: '2026-08-30T13:00:00.000Z', cwd: '/w/app', id: 'sess-3' })),
      mem('projects/-l-proj/sessions/sess-3/transcript.jsonl', lines(
        { at: '2026-08-30T13:00:05.000Z', text: 'do the thing' },
        { at: '2026-08-30T13:15:00.000Z' },
      )),
    ];
    const sessions = await scanLci(files);
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.id).toBe('sess-3');
    expect(s.cwd).toBe('/w/app');
    expect(s.title).toBe('do the thing');
    expect(s.startMs).toBe(ms('2026-08-30T13:00:00.000Z'));
    expect(s.endMs).toBe(ms('2026-08-30T13:15:00.000Z'));
  });

  test('without session.json: cwd null, start/end/title from the transcript records', async () => {
    const files = [
      mem('projects/-l-lost/sessions/sess-2/transcript.jsonl', lines(
        { at: '2026-08-30T14:00:00.000Z', text: 'uncover the lost session' },
        { at: '2026-08-30T14:20:00.000Z', other: 1 },
      )),
      // Not a transcript: never picked up.
      mem('projects/-l-lost/sessions/sess-2/notes.txt', 'nope'),
      // Nested too deep to be a session transcript.
      mem('projects/-l-lost/sessions/sess-2/nested/transcript.jsonl', lines({ at: '2026-08-30T15:00:00.000Z' })),
    ];
    const sessions = await scanLci(files);
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.id).toBe('sess-2');
    expect(s.cwd).toBeNull();
    expect(s.title).toBe('uncover the lost session');
    expect(s.startMs).toBe(ms('2026-08-30T14:00:00.000Z'));
    expect(s.endMs).toBe(ms('2026-08-30T14:20:00.000Z'));
  });

  test('skips files with no parseable timestamp', async () => {
    const files = [
      mem('projects/-l-proj/sessions/broken/transcript.jsonl', lines({ hello: 'world' }, { text: 'no at field' })),
    ];
    expect(await scanLci(files)).toHaveLength(0);
  });
});

describe('parseScratchpadCwd', () => {
  test('extracts slug + session id from /tmp and /private/tmp scratchpads', () => {
    expect(parseScratchpadCwd('/tmp/claude-99/-Users-x-src-app/11111111-1111-4111-8111-111111111111/scratchpad'))
      .toEqual({ slug: '-Users-x-src-app', sessionId: '11111111-1111-4111-8111-111111111111' });
    expect(parseScratchpadCwd('/private/tmp/claude-1/slug/22222222-2222-4222-8222-222222222222/scratchpad/sub/dir'))
      .toEqual({ slug: 'slug', sessionId: '22222222-2222-4222-8222-222222222222' });
  });

  test('other cwds are not scratchpads', () => {
    expect(parseScratchpadCwd('/w/app')).toBeNull();
    expect(parseScratchpadCwd('/tmp/claude-99/slug/not-a-uuid/worktree')).toBeNull();
    expect(parseScratchpadCwd('/tmp/not-claude/slug/11111111-1111-4111-8111-111111111111/scratchpad')).toBeNull();
  });
});

describe('splitWorktree', () => {
  test('splits /.worktrees/<name> cwds; other cwds are main', () => {
    expect(splitWorktree('/a/app/.worktrees/x')).toEqual({ root: '/a/app', worktree: 'x' });
    expect(splitWorktree('/a/app')).toEqual({ root: '/a/app', worktree: null });
  });
});

describe('buildIndex', () => {
  test('nests an lci session under the Claude session named by its scratchpad cwd (rule 1)', async () => {
    const parent = '11111111-1111-4111-8111-111111111111';
    const child = '22222222-2222-4222-8222-222222222222';
    const claude = await scanClaude([mem(`projects/-Users-x-src-app/${parent}.jsonl`, lines(
      { type: 'user', sessionId: parent, cwd: '/Users/x/src/app', gitBranch: 'main', timestamp: '2026-08-30T10:00:00.000Z', message: { content: 'spawn some subagents' } },
      { type: 'assistant', timestamp: '2026-08-30T10:30:00.000Z' },
    ))]);
    const lci = await scanLci([
      mem(`projects/-Users-x-src-app/sessions/${child}/transcript.jsonl`, lines({ at: '2026-08-30T10:05:00.000Z', text: 'child goal' })),
      mem(`projects/-Users-x-src-app/sessions/${child}/session.json`, JSON.stringify({
        createdAt: '2026-08-30T10:01:00.000Z',
        cwd: `/tmp/claude-4242/-Users-x-src-app/${parent}/scratchpad`,
        id: child,
      })),
    ]);
    const index = buildIndex([...claude, ...lci]);
    expect(index).toHaveLength(1);
    const project = index[0]!;
    expect(project.root).toBe('/Users/x/src/app');
    expect(project.label).toBe('app');
    expect(project.worktrees).toHaveLength(1);
    const tops = project.worktrees[0]!.sessions;
    expect(tops).toHaveLength(1);
    expect(tops[0]!.entry.id).toBe(parent);
    expect(tops[0]!.children.map((c) => c.entry.id)).toEqual([child]);
  });

  test('nests via the same-cwd time-window rule, picking the latest overlapping Claude session (rule 2)', () => {
    const t = (hhmmss: string) => ms(`2026-08-30T${hhmmss}Z`);
    const a = ent('claude', 'claude-a', '/w/app', t('11:04:10'), t('11:40:00'));
    const b = ent('claude', 'claude-b', '/w/app', t('11:04:30'), t('11:55:00'));
    const other = ent('claude', 'claude-c', '/w/other', t('11:05:00'), t('11:30:00'));
    const lci = ent('lci', 'lci-1', '/w/app', t('11:05:00'), t('11:06:00'));
    const project = buildIndex([a, b, other, lci]).find((p) => p.root === '/w/app')!;
    const tops = project.worktrees[0]!.sessions;
    // Newest first; the child sits under the latest matching parent only.
    expect(tops.map((n) => n.entry.id)).toEqual(['claude-b', 'claude-a']);
    expect(tops[0]!.children.map((c) => c.entry.id)).toEqual(['lci-1']);
    expect(tops[1]!.children).toHaveLength(0);
  });

  test('rule 2 accepts a long-running parent that started hours before the lci run', () => {
    const t = (hhmmss: string) => ms(`2026-08-30T${hhmmss}Z`);
    const early = ent('claude', 'claude-early', '/w/app', t('08:00:00'), t('12:30:00'));
    const ended = ent('claude', 'claude-ended', '/w/app', t('09:00:00'), t('10:00:00')); // ended > 10 min before
    const later = ent('claude', 'claude-later', '/w/app', t('11:30:00'), t('12:00:00')); // starts > 60 s after
    const lci = ent('lci', 'lci-1', '/w/app', t('11:05:00'), t('11:20:00'));
    const project = buildIndex([early, ended, later, lci]).find((p) => p.root === '/w/app')!;
    const byId = new Map(project.worktrees[0]!.sessions.map((n) => [n.entry.id, n]));
    expect(byId.get('claude-early')!.children.map((c) => c.entry.id)).toEqual(['lci-1']);
    expect(byId.get('claude-ended')!.children).toHaveLength(0);
    expect(byId.get('claude-later')!.children).toHaveLength(0);
  });

  test('an orphaned scratchpad lci session lands in the project its slug names', () => {
    const claude = ent('claude', 'claude-x', '/w/app/.worktrees/x', 0, 1000, '-w-app--worktrees-x');
    const orphan = ent(
      'lci',
      'lci-orphan',
      '/private/tmp/claude-501/-w-app--worktrees-x/00000000-0000-0000-0000-000000000000/scratchpad/run',
      5000,
      6000,
    );
    const index = buildIndex([claude, orphan]);
    expect(index.map((p) => p.root)).toEqual(['/w/app']);
    const group = index[0]!.worktrees[0]!;
    expect(group.label).toBe('x');
    expect(group.sessions.map((n) => n.entry.id)).toEqual(['lci-orphan', 'claude-x']);
  });

  test('a cwd-less entry is placed by decoding its slug against known cwds (both dialects)', () => {
    const claude = ent('claude', 'claude-x', '/w/app/.worktrees/x', 0, 1000, '-w-app--worktrees-x');
    const oldLci = ent('lci', 'lci-old', null, 2000, 3000, '-w-app-worktrees-x'); // lci drops the dot
    const sibling = ent('claude', 'claude-nocwd', null, 4000, 5000, '-w-app--worktrees-x');
    const index = buildIndex([claude, oldLci, sibling]);
    expect(index.map((p) => p.root)).toEqual(['/w/app']);
    expect(index[0]!.worktrees.map((g) => g.label)).toEqual(['x']);
    expect(index[0]!.worktrees[0]!.sessions.map((n) => n.entry.id)).toEqual(['claude-nocwd', 'lci-old', 'claude-x']);
  });

  test('leaves lci sessions top-level when no parent matches (rule 3)', () => {
    const claude = ent('claude', 'claude-far', '/w/app', 0, 10_000);
    const orphan = ent('lci', 'lci-orphan', '/else/where', 1000, 2000);
    const lost = ent('lci', 'lci-lost', null, 1500, 2500, '-l-lost');
    const index = buildIndex([claude, orphan, lost]);
    expect(index.map((p) => p.root).sort()).toEqual(['/else/where', '/w/app', 'slug:-l-lost']);
    const orphanProject = index.find((p) => p.root === '/else/where')!;
    expect(orphanProject.worktrees).toHaveLength(1);
    const node = orphanProject.worktrees[0]!.sessions[0]!;
    expect(node.entry.id).toBe('lci-orphan');
    expect(node.children).toHaveLength(0);
    // A cwd-less lci session groups by slug instead.
    const lostProject = index.find((p) => p.root === 'slug:-l-lost')!;
    expect(lostProject.worktrees[0]!.sessions[0]!.entry.id).toBe('lci-lost');
  });

  test('groups /a/app and /a/app/.worktrees/x under one project with labels main and x', () => {
    const main = ent('claude', 'claude-main', '/a/app', 3000, 4000);
    const wt = ent('claude', 'claude-wt', '/a/app/.worktrees/x', 1000, 2000);
    const index = buildIndex([main, wt]);
    expect(index).toHaveLength(1);
    const project = index[0]!;
    expect(project.root).toBe('/a/app');
    expect(project.label).toBe('app');
    expect(project.latestMs).toBe(4000);
    expect(project.worktrees.map((g) => g.label)).toEqual(['main', 'x']);
    expect(project.worktrees.map((g) => g.cwd)).toEqual(['/a/app', '/a/app/.worktrees/x']);
  });
});

// ---- pi ------------------------------------------------------------------

describe('scanPi', () => {
  const piFixture = async () => await Bun.file(new URL('./fixtures/pi.jsonl', import.meta.url)).text();

  test('reads id/cwd/start from the session header and the title from the first prompt', async () => {
    const text = await piFixture();
    const path = 'sessions/--Users-tylerwhitehurst-src-seekdeep-.worktrees-72286388--/2026-09-02T11-22-50-782Z_01a061db-821d-75d1-9c81-12645c109194.jsonl';
    const [e] = await scanPi([mem(path, text), mem('sessions/x/nested/deeper.jsonl', text), mem('README.md', 'x')]);
    expect(e).toBeDefined();
    expect(e!.kind).toBe('pi');
    expect(e!.id).toBe('01a061db-821d-75d1-9c81-12645c109194');
    expect(e!.cwd).toBe('/Users/tylerwhitehurst/src/seekdeep/.worktrees/72286388');
    expect(e!.slug).toBe('--Users-tylerwhitehurst-src-seekdeep-.worktrees-72286388--');
    expect(e!.title.startsWith('Run the shell command')).toBe(true);
    expect(e!.startMs).toBe(ms('2026-09-02T11:22:50.782Z'));
    expect(e!.endMs).toBeGreaterThan(e!.startMs);
    expect(e!.branch).toBeNull();
  });

  test('only files directly inside a cwd directory under sessions/ are transcripts', async () => {
    const text = await piFixture();
    const entries = await scanPi([mem('sessions/--a--/one.jsonl', text), mem('sessions/loose.jsonl', text), mem('other/--a--/two.jsonl', text)]);
    expect(entries.map((e) => e.path)).toEqual(['sessions/--a--/one.jsonl']);
  });

  test('falls back to the file name id and first timestamps when the header is missing', async () => {
    const text = lines(
      { type: 'message', id: 'a', parentId: null, timestamp: '2026-09-02T10:00:00Z', message: { role: 'user', content: 'hi', timestamp: 1 } },
      { type: 'message', id: 'b', parentId: 'a', timestamp: '2026-09-02T10:00:05Z', message: { role: 'assistant', content: [], timestamp: 2 } },
    );
    const [e] = await scanPi([mem('sessions/--x--/2026-09-02T10-00-00-000Z_abc-123.jsonl', text)]);
    expect(e!.id).toBe('abc-123');
    expect(e!.cwd).toBeNull();
    expect(e!.title).toBe('hi');
    expect(e!.startMs).toBe(ms('2026-09-02T10:00:00Z'));
    expect(e!.endMs).toBe(ms('2026-09-02T10:00:05Z'));
  });
});

describe('buildIndex with pi hosts', () => {
  const T = ms('2026-09-02T10:00:00Z');

  test('an lci run in the same cwd during a pi session nests under it (rule 2)', () => {
    const pi = ent('pi', 'pi-1', '/Users/t/proj', T, T + 60_000);
    const lci = ent('lci', 'lci-1', '/Users/t/proj', T + 10_000, T + 40_000);
    const projects = buildIndex([pi, lci]);
    const roots = projects.flatMap((p) => p.worktrees.flatMap((g) => g.sessions));
    expect(roots.map((n) => n.entry.id)).toEqual(['pi-1']);
    expect(roots[0]!.children.map((n) => n.entry.id)).toEqual(['lci-1']);
  });

  test('the latest host that started before the lci run wins across harnesses', () => {
    const claude = ent('claude', 'c-1', '/Users/t/proj', T, T + 3_600_000);
    const pi = ent('pi', 'pi-1', '/Users/t/proj', T + 30_000, T + 120_000);
    const lci = ent('lci', 'lci-1', '/Users/t/proj', T + 40_000, T + 50_000);
    const roots = buildIndex([claude, pi, lci]).flatMap((p) => p.worktrees.flatMap((g) => g.sessions));
    const host = roots.find((n) => n.children.length > 0);
    expect(host?.entry.id).toBe('pi-1');
  });

  test('the scratchpad rule only names Claude sessions', () => {
    const scratch = '/private/tmp/claude-501/-Users-t-proj/11111111-2222-3333-4444-555555555555/scratchpad';
    const pi = ent('pi', '11111111-2222-3333-4444-555555555555', '/Users/t/other', T, T + 1000);
    const lci = ent('lci', 'lci-1', scratch, T + 3_600_000, T + 3_601_000);
    const roots = buildIndex([pi, lci]).flatMap((p) => p.worktrees.flatMap((g) => g.sessions));
    expect(roots.every((n) => n.children.length === 0)).toBe(true);
    const claude = ent('claude', '11111111-2222-3333-4444-555555555555', '/Users/t/other', T, T + 1000);
    const nested = buildIndex([claude, lci]).flatMap((p) => p.worktrees.flatMap((g) => g.sessions));
    expect(nested.find((n) => n.entry.id === claude.id)?.children.map((n) => n.entry.id)).toEqual(['lci-1']);
  });
});
