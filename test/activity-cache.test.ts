import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectBuckets, readRecord } from '../src/index/activity-cache.ts';
import type { SourceFile } from '../src/index/fs.ts';
import type { SessionEntry } from '../src/index/scan.ts';

const CLAUDE = readFileSync(join(import.meta.dir, 'fixtures', 'claude-code.jsonl'), 'utf8');

/** A SourceFile whose text() either yields `text` or throws like a changed File snapshot. */
function fakeFile(opts: { text: string | null; size: number; lastModified: number; refresh?: () => Promise<SourceFile> }): SourceFile {
  const file: SourceFile = {
    path: 'a/session.jsonl',
    name: 'session.jsonl',
    size: opts.size,
    lastModified: opts.lastModified,
    text: async () => {
      if (opts.text === null) throw new DOMException('file changed since it was read', 'NotReadableError');
      return opts.text;
    },
  };
  if (opts.refresh !== undefined) file.refresh = opts.refresh;
  return file;
}

function entryFor(file: SourceFile): SessionEntry {
  return {
    kind: 'claude',
    id: 'session',
    path: file.path,
    slug: 'proj',
    cwd: null,
    branch: null,
    title: 't',
    startMs: 0,
    endMs: 0,
    sizeBytes: file.size,
    file,
  };
}

describe('readRecord', () => {
  test('reads a stable snapshot directly', async () => {
    const rec = await readRecord(entryFor(fakeFile({ text: CLAUDE, size: 10, lastModified: 1 })));
    expect(rec).not.toBeNull();
    expect(rec!.size).toBe(10);
    expect(rec!.buckets.length).toBeGreaterThan(0);
  });

  test('re-snapshots a changed file and stamps the record with the fresh size/mtime', async () => {
    let refreshed = 0;
    const stale = fakeFile({
      text: null,
      size: 10,
      lastModified: 1,
      refresh: async () => {
        refreshed += 1;
        return fakeFile({ text: CLAUDE, size: 20, lastModified: 2 });
      },
    });
    const rec = await readRecord(entryFor(stale));
    expect(refreshed).toBe(1);
    expect(rec).not.toBeNull();
    expect(rec!.size).toBe(20);
    expect(rec!.lastModified).toBe(2);
    expect(rec!.buckets.length).toBeGreaterThan(0);
  });

  test('gives up (null) without a handle to refresh from', async () => {
    expect(await readRecord(entryFor(fakeFile({ text: null, size: 10, lastModified: 1 })))).toBeNull();
  });

  test('gives up after one retry when the fresh snapshot is unreadable too', async () => {
    let refreshed = 0;
    const stale = fakeFile({
      text: null,
      size: 10,
      lastModified: 1,
      refresh: async () => {
        refreshed += 1;
        return fakeFile({ text: null, size: 20, lastModified: 2, refresh: async () => fakeFile({ text: CLAUDE, size: 30, lastModified: 3 }) });
      },
    });
    expect(await readRecord(entryFor(stale))).toBeNull();
    expect(refreshed).toBe(1);
  });
});

describe('collectBuckets', () => {
  test('reports the paths it could not read and keeps the rest (no IndexedDB here, so every entry is a cache miss)', async () => {
    const good = entryFor(fakeFile({ text: CLAUDE, size: 10, lastModified: 1 }));
    const bad = { ...entryFor(fakeFile({ text: null, size: 10, lastModified: 1 })), id: 'bad', path: 'b/changed.jsonl' };
    const progress: Array<[number, number]> = [];
    const { buckets, skipped } = await collectBuckets([good, bad], (done, total) => progress.push([done, total]));
    expect(skipped).toEqual(['b/changed.jsonl']);
    expect(buckets.length).toBeGreaterThan(0);
    expect(progress.at(-1)).toEqual([2, 2]);
  });
});

import { mergeBuckets } from '../src/stats.ts';

describe('session identity and duration in cached records', () => {
  test('a record carries its source-qualified session identity and one duration marker', async () => {
    const rec = await readRecord(entryFor(fakeFile({ text: CLAUDE, size: 10, lastModified: 1 })));
    expect(rec).not.toBeNull();
    expect(rec!.sessionId).toBe('claude:a/session.jsonl');
    const marked = rec!.buckets.filter((b) => b.sessionDurationMs !== undefined);
    expect(marked).toHaveLength(1);
    expect(rec!.sessionDurationMs).toBe(marked[0]!.sessionDurationMs);
    expect(rec!.buckets.every((b) => b.sessionId === 'claude:a/session.jsonl')).toBe(true);
  });

  test('the same transcript seen twice contributes once (no double counting)', async () => {
    const file = fakeFile({ text: CLAUDE, size: 10, lastModified: 1 });
    const entry = entryFor(file);
    const { buckets, skipped } = await collectBuckets([entry, { ...entry }]);
    expect(skipped).toEqual([]);
    const ids = buckets.map((b) => b.sessionId);
    expect(new Set(ids).size).toBe(1);
    expect(new Set(ids)).toEqual(new Set(['claude:a/session.jsonl']));
    const merged = mergeBuckets([buckets]);
    expect(merged.length).toBe(buckets.length);
    const requests = merged.reduce((acc, b) => acc + b.requests, 0);
    expect(requests).toBe(buckets.reduce((acc, b) => acc + b.requests, 0));
  });
});

import { ACTIVITY_SCHEMA, sessionIdentity } from '../src/index/activity-cache.ts';

describe('cache key shape and schema bump', () => {
  test('the schema was bumped past the pre-session-identity records', () => {
    // 2 is the schema of records written before buckets carried per-session
    // identity and elapsed duration. loadActivityCache trusts nothing but the
    // current schema, so a 2-record is re-read instead of served stale — which
    // is what this 3 buys. Pinned exactly, not as a lower bound: the next bump
    // has to come here and say what it invalidates.
    expect(ACTIVITY_SCHEMA).toBe(3);
  });

  test('a fresh record is stamped with the current schema, so older ones fail the freshness guard', async () => {
    const rec = await readRecord(entryFor(fakeFile({ text: CLAUDE, size: 10, lastModified: 1 })));
    expect(rec).not.toBeNull();
    expect(rec!.schema).toBe(ACTIVITY_SCHEMA);
    expect(rec!.schema).not.toBe(ACTIVITY_SCHEMA - 1);
  });

  test('clearActivityCache\'s prefix still matches the key shape', () => {
    // clearActivityCache deletes every key starting with `${kind}:`; the record
    // key is the source-qualified identity, so the prefix must still hold.
    expect(sessionIdentity('claude', 'a/session.jsonl')).toBe('claude:a/session.jsonl');
    expect(sessionIdentity('claude', 'a/session.jsonl').startsWith('claude:')).toBe(true);
    // An uploaded/sample identity uses a distinct prefix and can never collide
    // with an indexed transcript of the same path or display name.
    expect(sessionIdentity('claude', 'a/session.jsonl').startsWith('upload:')).toBe(false);
  });
});

describe('duplicate snapshots of one transcript', () => {
  test('two conflicting snapshots read fresh in one batch still count once', async () => {
    // Same transcript identity with different freshness stamps: neither can be a
    // cache hit, so both land in the same read batch — the second read must not
    // add a second copy of that session's spend or a second duration marker.
    const a = entryFor(fakeFile({ text: CLAUDE, size: 10, lastModified: 1 }));
    const b = entryFor(fakeFile({ text: CLAUDE, size: 20, lastModified: 2 }));
    const { buckets, skipped } = await collectBuckets([a, b]);
    expect(skipped).toEqual([]);
    expect(new Set(buckets.map((x) => x.sessionId))).toEqual(new Set(['claude:a/session.jsonl']));
    expect(buckets.filter((x) => x.sessionDurationMs !== undefined)).toHaveLength(1);
    // Merged requests equal a single read of the same transcript: one copy.
    const single = await collectBuckets([a]);
    expect(buckets.reduce((acc, x) => acc + x.requests, 0)).toBe(single.buckets.reduce((acc, x) => acc + x.requests, 0));
  });
});
