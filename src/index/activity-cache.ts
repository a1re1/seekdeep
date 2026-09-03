// IndexedDB cache for activity buckets (db "seekdeep", store "activity",
// alongside the directory handles and scan cache). Bucketing requires a full
// transcript read — the one thing the scan cache deliberately avoids — so each
// record is keyed `${kind}:${path}` and stamped with the size/lastModified it
// was computed from, and repeat visits only re-read changed transcripts.
// Best-effort like cache.ts: any IndexedDB or parse failure degrades to a
// re-read (or a skipped file), never an error.

import { openDb } from './fs.ts';
import type { SourceKind } from './fs.ts';
import { bucketSession, mergeBuckets } from '../stats.ts';
import type { UsageBucket } from '../stats.ts';
import { parseTranscript } from '../parsers/index.ts';
import type { SessionEntry } from './scan.ts';

const BATCH_SIZE = 8;

/** A cached bucket list plus the freshness stamps of its source file. */
/** Bump when UsageBucket gains fields: older records are re-read, not trusted. */
export const ACTIVITY_SCHEMA = 2;

export interface ActivityRecord {
  schema: number;
  kind: SourceKind;
  path: string;
  size: number;
  lastModified: number;
  buckets: UsageBucket[];
}

/**
 * Collect UsageBuckets across every entry, reading whole transcripts only
 * where the cached record's size/lastModified no longer matches. Files are
 * processed in batches of 8 with progress reported after each batch; a bad
 * file is skipped, never thrown. Returns the merged bucket list plus the
 * paths of the transcripts that could not be read, so the page can say so.
 */
export async function collectBuckets(
  entries: SessionEntry[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ buckets: UsageBucket[]; skipped: string[] }> {
  const cache = await loadActivityCache();
  const lists: UsageBucket[][] = [];
  const skipped: string[] = [];
  const stale: SessionEntry[] = [];
  let done = 0;
  for (const entry of entries) {
    const rec = cache.get(`${entry.kind}:${entry.path}`);
    if (rec !== undefined && rec.size === entry.file.size && rec.lastModified === entry.file.lastModified) {
      lists.push(withHarness(rec.buckets, entry.kind));
      done += 1;
    } else {
      stale.push(entry);
    }
  }
  onProgress?.(done, entries.length);
  for (let i = 0; i < stale.length; i += BATCH_SIZE) {
    const batch = stale.slice(i, i + BATCH_SIZE);
    const records = await Promise.all(batch.map(readRecord));
    const fresh: ActivityRecord[] = [];
    records.forEach((rec, j) => {
      if (rec === null) skipped.push(batch[j]!.path);
      else fresh.push(rec);
    });
    for (const rec of fresh) lists.push(withHarness(rec.buckets, rec.kind));
    await saveActivityRecords(fresh);
    done += batch.length;
    onProgress?.(done, entries.length);
  }
  return { buckets: mergeBuckets(lists), skipped };
}

/** Records cached before buckets carried a harness get it from their source kind. */
function withHarness(buckets: UsageBucket[], kind: SourceKind): UsageBucket[] {
  return buckets.map((b) => (b.harness === undefined ? { ...b, harness: kind } : b));
}

/** Remove every cached activity record of `kind` (when its directory is forgotten). */
export async function clearActivityCache(kind: SourceKind): Promise<void> {
  try {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('activity', 'readwrite');
        const req = tx.objectStore('activity').getAllKeys();
        req.onsuccess = () => {
          const prefix = `${kind}:`;
          for (const key of req.result) {
            if (typeof key === 'string' && key.startsWith(prefix)) tx.objectStore('activity').delete(key);
          }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('indexedDB: cache clear failed'));
        tx.onabort = () => reject(tx.error ?? new Error('indexedDB: cache clear aborted'));
      });
    } finally {
      db.close();
    }
  } catch {
    // cache maintenance is best-effort
  }
}

// ---- internals ------------------------------------------------------------

/**
 * Full-read one transcript into a storable record; null when it fails. The
 * scan-time File snapshot throws once the transcript has changed on disk
 * (any session still being written), which used to drop exactly the busiest
 * recent sessions from the totals — so on failure re-snapshot from the
 * handle and try once more, stamping the record with the fresh size/mtime.
 */
export async function readRecord(entry: SessionEntry): Promise<ActivityRecord | null> {
  let file = entry.file;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const text = await file.text();
      return {
        schema: ACTIVITY_SCHEMA,
        kind: entry.kind,
        path: entry.path,
        size: file.size,
        lastModified: file.lastModified,
        buckets: bucketSession(parseTranscript(text, entry.path)),
      };
    } catch {
      if (attempt > 0 || file.refresh === undefined) return null; // one unreadable transcript must not sink the whole page
      try {
        file = await file.refresh();
      } catch {
        return null;
      }
    }
  }
}

async function loadActivityCache(): Promise<Map<string, ActivityRecord>> {
  try {
    const db = await openDb();
    try {
      return await new Promise<Map<string, ActivityRecord>>((resolve, reject) => {
        const tx = db.transaction('activity', 'readonly');
        const req = tx.objectStore('activity').getAll();
        req.onsuccess = () => {
          const byKey = new Map<string, ActivityRecord>();
          for (const rec of req.result as ActivityRecord[]) {
            if (
              rec?.schema === ACTIVITY_SCHEMA &&
              typeof rec?.path === 'string' &&
              typeof rec?.size === 'number' &&
              typeof rec?.lastModified === 'number' &&
              Array.isArray(rec?.buckets)
            ) {
              byKey.set(`${rec.kind}:${rec.path}`, rec);
            }
          }
          resolve(byKey);
        };
        req.onerror = () => reject(req.error ?? new Error('indexedDB: read failed'));
      });
    } finally {
      db.close();
    }
  } catch {
    // cache reads are best-effort; a miss just means re-reading everything
    return new Map();
  }
}

async function saveActivityRecords(records: ActivityRecord[]): Promise<void> {
  if (records.length === 0) return;
  try {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('activity', 'readwrite');
        const store = tx.objectStore('activity');
        for (const rec of records) store.put(rec, `${rec.kind}:${rec.path}`);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('indexedDB: cache write failed'));
        tx.onabort = () => reject(tx.error ?? new Error('indexedDB: cache write aborted'));
      });
    } finally {
      db.close();
    }
  } catch {
    // cache writes are best-effort; the next run just re-reads
  }
}
