// Browser directory access for the session index. Prefers the File System
// Access API (handle persisted in IndexedDB so the connection survives
// reloads) and falls back to a hidden <input webkitdirectory> when the API
// is unavailable. Nothing is ever uploaded; files are read locally.

export interface SourceFile {
  /** Path relative to the picked directory, '/'-separated. */
  path: string;
  name: string;
  size: number;
  lastModified: number;
  /** Read a byte range (whole file when omitted) without loading it all. */
  text(range?: { start?: number; end?: number }): Promise<string>;
}

export type SourceKind = 'claude' | 'lci';

// ---- File System Access API, typed locally (no dependencies) -------------

interface FsFileHandle {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
}

interface FsDirHandle {
  kind: 'directory';
  name: string;
  values(): AsyncIterableIterator<FsFileHandle | FsDirHandle>;
  getDirectoryHandle(name: string): Promise<FsDirHandle>;
  queryPermission?(desc: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(desc: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

type PickerWindow = {
  showDirectoryPicker?(options: { id: string; mode: 'read' }): Promise<FsDirHandle>;
};

const SKIP_DIRS = new Set(['node_modules', '.git', 'outputs', 'images']);
const MAX_DEPTH = 8;
// Both layouts keep sessions under projects/; the rest of ~/.claude (caches,
// shell snapshots, plugins…) is thousands of files we never need to stat.
const SESSIONS_DIR = 'projects';
const WANTED_FILES = new Set(['session.json', 'result.json']);

function isWanted(name: string): boolean {
  return name.endsWith('.jsonl') || WANTED_FILES.has(name);
}

/** Whether a stored handle exists and what it needs before it can be read. */
export type StoredState = 'none' | 'granted' | 'prompt';

// ---- public API ----------------------------------------------------------

export async function pickDirectory(kind: SourceKind): Promise<SourceFile[] | null> {
  const w = window as unknown as PickerWindow;
  if (typeof w.showDirectoryPicker === 'function') {
    let handle: FsDirHandle;
    try {
      handle = await w.showDirectoryPicker({ id: kind, mode: 'read' });
    } catch {
      return null; // user cancelled (or the request was denied)
    }
    await saveHandle(kind, handle);
    return walkHandle(handle);
  }
  return pickWithInput();
}

/**
 * Check a stored handle without prompting: 'granted' means restoreDirectory
 * will work silently, 'prompt' means it needs a user gesture (button click).
 */
export async function storedState(kind: SourceKind): Promise<StoredState> {
  const handle = await loadHandle(kind);
  if (handle === null) return 'none';
  try {
    if (handle.queryPermission === undefined) return 'prompt';
    return (await handle.queryPermission({ mode: 'read' })) === 'granted' ? 'granted' : 'prompt';
  } catch {
    return 'none';
  }
}

export async function restoreDirectory(kind: SourceKind): Promise<SourceFile[] | null> {
  const handle = await loadHandle(kind);
  if (handle === null) return null;
  if (!(await hasReadPermission(handle))) return null;
  try {
    return await walkHandle(handle);
  } catch {
    return null; // stored directory may be gone or renamed
  }
}

export async function forgetDirectory(kind: SourceKind): Promise<void> {
  await withStore('dirs', (store) => store.delete(kind));
}

// ---- walking -------------------------------------------------------------

/**
 * Walk `<dir>/projects` when it exists, else the pick itself (the user may
 * have picked `projects/` directly — keep that segment so scan.ts's path
 * contract `projects/<slug>/…` still holds). Only transcript-related files
 * are collected.
 */
async function walkHandle(dir: FsDirHandle): Promise<SourceFile[]> {
  let root = dir;
  let prefix = dir.name === SESSIONS_DIR ? `${SESSIONS_DIR}/` : '';
  try {
    root = await dir.getDirectoryHandle(SESSIONS_DIR);
    prefix = `${SESSIONS_DIR}/`;
  } catch {
    // no projects/ subdirectory: walk what was picked
  }
  const out: SourceFile[] = [];
  await walk(root, prefix, out, 0);
  return out;
}

async function walk(
  dir: FsDirHandle,
  prefix: string,
  out: SourceFile[],
  depth: number,
): Promise<void> {
  if (depth > MAX_DEPTH) return;
  const subdirs: FsDirHandle[] = [];
  const files: Promise<SourceFile>[] = [];
  for await (const entry of dir.values()) {
    if (entry.kind === 'file') {
      if (isWanted(entry.name)) files.push(entry.getFile().then((f) => makeSourceFile(f, prefix + entry.name)));
    } else if (!SKIP_DIRS.has(entry.name)) {
      subdirs.push(entry);
    }
  }
  out.push(...(await Promise.all(files)));
  for (const sub of subdirs) await walk(sub, `${prefix}${sub.name}/`, out, depth + 1);
}

export function makeSourceFile(file: File, path: string): SourceFile {
  return {
    path,
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
    text: async (range?: { start?: number; end?: number }): Promise<string> => {
      const start = Math.max(0, Math.min(range?.start ?? 0, file.size));
      const end = Math.max(start, Math.min(range?.end ?? file.size, file.size));
      return file.slice(start, end).text();
    },
  };
}

// ---- <input webkitdirectory> fallback (nothing persisted) ----------------

function pickWithInput(): Promise<SourceFile[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('webkitdirectory', '');
    input.style.display = 'none';
    const cleanup = (): void => input.remove();
    input.addEventListener('change', () => {
      cleanup();
      const out: SourceFile[] = [];
      for (const file of input.files ?? []) {
        // webkitRelativePath is "<picked-dir>/<...>" — strip the picked dir
        // so paths stay relative to it, matching the API-based flow.
        if (!isWanted(file.name)) continue;
        const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? file.name;
        const segments = rel.split('/');
        const picked = segments.length > 1 ? segments.shift() : undefined;
        if (segments.some((s) => SKIP_DIRS.has(s))) continue;
        // Keep a leading projects/ when the user picked that directory itself.
        const path = (picked === SESSIONS_DIR ? [picked, ...segments] : segments).join('/');
        out.push(makeSourceFile(file, path));
      }
      resolve(out.length > 0 ? out : null);
    });
    input.addEventListener('cancel', () => {
      cleanup();
      resolve(null);
    });
    document.body.append(input);
    input.click();
  });
}

// ---- permissions ---------------------------------------------------------

async function hasReadPermission(handle: FsDirHandle): Promise<boolean> {
  try {
    if (handle.queryPermission !== undefined && (await handle.queryPermission({ mode: 'read' })) === 'granted') {
      return true;
    }
    if (handle.requestPermission === undefined) return false;
    return (await handle.requestPermission({ mode: 'read' })) === 'granted';
  } catch {
    return false;
  }
}

// ---- IndexedDB: db "seekdeep", stores "dirs" (handles) and "scan" (cache) -

export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('seekdeep', 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('dirs')) db.createObjectStore('dirs');
      if (!db.objectStoreNames.contains('scan')) db.createObjectStore('scan');
      if (!db.objectStoreNames.contains('activity')) db.createObjectStore('activity');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB: open failed'));
    // Another tab still on the old schema keeps the upgrade waiting; fail
    // fast (callers degrade to a plain rescan) instead of stalling boot.
    req.onblocked = () => reject(new Error('indexedDB: upgrade blocked by another open tab'));
  });
}

async function withStore<T>(
  name: 'dirs' | 'scan',
  run: (store: IDBObjectStore) => IDBRequest,
): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(name, 'readwrite');
      const req = run(tx.objectStore(name));
      req.onerror = () => reject(req.error ?? new Error('indexedDB: request failed'));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('indexedDB: transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('indexedDB: transaction aborted'));
    });
  } finally {
    db.close();
  }
}

async function saveHandle(kind: SourceKind, handle: FsDirHandle): Promise<void> {
  await withStore('dirs', (store) => store.put(handle, kind));
}

async function loadHandle(kind: SourceKind): Promise<FsDirHandle | null> {
  const db = await openDb();
  try {
    return await new Promise<FsDirHandle | null>((resolve, reject) => {
      const tx = db.transaction('dirs', 'readonly');
      const req = tx.objectStore('dirs').get(kind);
      req.onsuccess = () => resolve((req.result as FsDirHandle | undefined) ?? null);
      req.onerror = () => reject(req.error ?? new Error('indexedDB: read failed'));
    });
  } catch {
    return null;
  } finally {
    db.close();
  }
}
