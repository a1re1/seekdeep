// IndexedDB cache for scanned session entries (db "seekdeep", store "scan",
// alongside the directory handles in fs.ts). Records are keyed
// `${kind}:${path}` and stamped with the size/lastModified they were scanned
// from, so repeat visits only re-read transcripts that actually changed.
// Only the cacheable part of a SessionEntry is stored; the live SourceFile
// handle is re-attached from the current file list. Best-effort: any
// IndexedDB failure degrades silently to a full rescan.

import { openDb } from './fs.ts';
import type { SourceFile, SourceKind } from './fs.ts';
import { claudeTranscripts, lciTranscripts, scanClaude, scanLci } from './scan.ts';
import type { CachedEntry, SessionEntry } from './scan.ts';

/** A cached SessionEntry plus the freshness stamps of its source files. */
export interface CacheRecord extends CachedEntry {
  size: number;
  lastModified: number;
  /** lci siblings (session.json / result.json) whose change invalidates the entry. */
  deps?: { path: string; size: number; lastModified: number }[];
}

// ---- public API ----------------------------------------------------------

/**
 * Scan a connected directory, reusing cached entries for transcripts whose
 * size/lastModified (and, for lci, sibling metadata) are unchanged; only the
 * rest is re-read. Progress counts cache hits as already done.
 */
export async function scanWithCache(
  kind: SourceKind,
  files: SourceFile[],
  onProgress?: (done: number, total: number) => void,
): Promise<SessionEntry[]> {
  const cache = await loadScanCache();
  const byPath = new Map<string, SourceFile>();
  for (const f of files) byPath.set(f.path, f);
  const transcripts = kind === 'claude' ? claudeTranscripts(files) : lciTranscripts(files);

  const fresh: SessionEntry[] = [];
  const freshPaths = new Set<string>();
  for (const file of transcripts) {
    const rec = freshRecord(cache, kind, file, byPath);
    if (rec === null) continue;
    fresh.push(toEntry(rec, file));
    freshPaths.add(file.path);
  }

  onProgress?.(fresh.length, transcripts.length);
  const stale = files.filter((f) => !freshPaths.has(f.path));
  const run = kind === 'claude' ? scanClaude : scanLci;
  const scanned = await run(stale, (done) => onProgress?.(fresh.length + done, transcripts.length));
  onProgress?.(transcripts.length, transcripts.length);

  await saveScanEntries(kind, scanned, byPath);
  await pruneScanCache(kind, (path) => byPath.has(path));
  return [...fresh, ...scanned];
}

/** Load every cached record, keyed by `${kind}:${path}`. Empty map on failure. */
export async function loadScanCache(): Promise<Map<string, CacheRecord>> {
  try {
    const db = await openDb();
    try {
      return await new Promise<Map<string, CacheRecord>>((resolve, reject) => {
        const tx = db.transaction('scan', 'readonly');
        const req = tx.objectStore('scan').getAll();
        req.onsuccess = () => {
          const out = new Map<string, CacheRecord>();
          for (const rec of req.result as CacheRecord[]) out.set(cacheKey(rec.kind, rec.path), rec);
          resolve(out);
        };
        req.onerror = () => reject(req.error ?? new Error('indexedDB: cache read failed'));
      });
    } finally {
      db.close();
    }
  } catch {
    return new Map(); // no IndexedDB (or blocked) → full rescan
  }
}

/** Upsert cache records for freshly scanned entries. */
export async function saveScanEntries(
  kind: SourceKind,
  entries: SessionEntry[],
  byPath: Map<string, SourceFile>,
): Promise<void> {
  if (entries.length === 0) return;
  try {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('scan', 'readwrite');
        const store = tx.objectStore('scan');
        for (const entry of entries) {
          const rec = toRecord(kind, entry, byPath);
          store.put(rec, cacheKey(rec.kind, rec.path));
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('indexedDB: cache write failed'));
        tx.onabort = () => reject(tx.error ?? new Error('indexedDB: cache write aborted'));
      });
    } finally {
      db.close();
    }
  } catch {
    // cache writes are best-effort; the next run just rescans
  }
}

/** Drop cached records of `kind` whose path is gone; keep the rest. */
export async function pruneScanCache(
  kind: SourceKind,
  keep: (path: string) => boolean,
): Promise<void> {
  try {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('scan', 'readwrite');
        const store = tx.objectStore('scan');
        const req = store.getAllKeys();
        req.onsuccess = () => {
          const prefix = `${kind}:`;
          for (const key of req.result) {
            if (typeof key !== 'string' || !key.startsWith(prefix)) continue;
            if (!keep(key.slice(prefix.length))) store.delete(key);
          }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('indexedDB: cache prune failed'));
        tx.onabort = () => reject(tx.error ?? new Error('indexedDB: cache prune aborted'));
      });
    } finally {
      db.close();
    }
  } catch {
    // cache maintenance is best-effort
  }
}

/** Remove every cached record of `kind` (when its directory is forgotten). */
export async function clearScanCache(kind: SourceKind): Promise<void> {
  await pruneScanCache(kind, () => false);
}

// ---- freshness -----------------------------------------------------------

function cacheKey(kind: SourceKind, path: string): string {
  return `${kind}:${path}`;
}

function freshRecord(
  cache: Map<string, CacheRecord>,
  kind: SourceKind,
  file: SourceFile,
  byPath: Map<string, SourceFile>,
): CacheRecord | null {
  const rec = cache.get(cacheKey(kind, file.path));
  if (rec === undefined) return null;
  if (rec.size !== file.size || rec.lastModified !== file.lastModified) return null;
  for (const dep of rec.deps ?? []) {
    const f = byPath.get(dep.path);
    if (f === undefined) {
      if (dep.size !== MISSING) return null; // sibling deleted since the scan
    } else if (f.size !== dep.size || f.lastModified !== dep.lastModified) {
      return null; // changed, or appeared (result.json lands when a session ends)
    }
  }
  return rec;
}

function toRecord(
  kind: SourceKind,
  entry: SessionEntry,
  byPath: Map<string, SourceFile>,
): CacheRecord {
  const file = byPath.get(entry.path);
  return {
    kind: entry.kind,
    id: entry.id,
    path: entry.path,
    slug: entry.slug,
    cwd: entry.cwd,
    branch: entry.branch,
    title: entry.title,
    startMs: entry.startMs,
    endMs: entry.endMs,
    sizeBytes: entry.sizeBytes,
    size: file?.size ?? entry.sizeBytes,
    lastModified: file?.lastModified ?? 0,
    deps: kind === 'lci' ? lciDeps(entry.path, byPath) : undefined,
  };
}

/** Stamp recorded for a sibling that did not exist at scan time. */
const MISSING = -1;

/**
 * lci entries also depend on their session.json / result.json siblings.
 * Both slots are always recorded so a sibling that appears later (result.json
 * is written when the session ends) invalidates the cached entry.
 */
function lciDeps(
  path: string,
  byPath: Map<string, SourceFile>,
): { path: string; size: number; lastModified: number }[] {
  const dir = path.slice(0, path.lastIndexOf('/') + 1);
  return ['session.json', 'result.json'].map((name) => {
    const depPath = `${dir}${name}`;
    const f = byPath.get(depPath);
    return f === undefined
      ? { path: depPath, size: MISSING, lastModified: MISSING }
      : { path: depPath, size: f.size, lastModified: f.lastModified };
  });
}

function toEntry(rec: CacheRecord, file: SourceFile): SessionEntry {
  return {
    kind: rec.kind,
    id: rec.id,
    path: rec.path,
    slug: rec.slug,
    cwd: rec.cwd,
    branch: rec.branch,
    title: rec.title,
    startMs: rec.startMs,
    endMs: rec.endMs,
    sizeBytes: rec.sizeBytes,
    file,
  };
}
