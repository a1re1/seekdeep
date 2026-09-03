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
