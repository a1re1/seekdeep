// seekdeep entry point: file loading, session tabs, trace waterfall + detail
// pane + cache trace, summary panel, pricing editor. All state lives in the
// browser; nothing is uploaded anywhere.

import { clearScanCache, scanWithCache } from './index/cache.ts';
import { forgetDirectory, pickDirectory, restoreDirectory, storedState } from './index/fs.ts';
import type { SourceFile, SourceKind } from './index/fs.ts';
import { buildIndex } from './index/link.ts';
import type { ProjectGroup, SessionNode } from './index/link.ts';
import type { SessionEntry } from './index/scan.ts';
import { indexSummary, renderIndex } from './ui/index-view.ts';
import type { IndexActions, IndexModel, IndexProgress } from './ui/index-view.ts';
import type { Session, Span } from './model.ts';
import { flatten } from './model.ts';
import { findLaunchSpan, graftSession, graftedIds, isEmptySession } from './graft.ts';
import { parseTranscript } from './parsers/index.ts';
import { applyPricing, effectivePricing } from './pricing.ts';
import { collectCacheBars, drawCacheTrace } from './ui/cache-trace.ts';
import { renderDetail, renderEmptyDetail } from './ui/detail.ts';
import { byId, el, sizeCanvas } from './ui/dom.ts';
import { readFiles } from './ui/loader.ts';
import { renderPricingEditor } from './ui/pricing.ts';
import { renderSummary, summarize } from './ui/summary.ts';
import { TraceView } from './ui/trace.ts';

interface Loaded {
  session: Session;
  fileName: string;
  parents: Map<string, Span>; // child id → parent span
  /** lci sessions grafted into this tree, by grafted span id. */
  lciChildren: Map<string, SessionEntry>;
  grafting: boolean;
}

const state = {
  sessions: [] as Loaded[],
  active: -1,
  zoomNode: null as Span | null,
  trace: null as TraceView | null,
  t0: 0,
  t1: 0,
};

function main(): void {
  const dropZone = byId<HTMLElement>('drop-zone');
  const fileInput = byId<HTMLInputElement>('file-input');
  const tabs = byId<HTMLElement>('session-tabs');
  const app = byId<HTMLElement>('app');
  const traceHost = byId<HTMLElement>('trace');
  const detailPane = byId<HTMLElement>('detail-pane');
  const cacheCanvas = byId<HTMLCanvasElement>('cache-canvas');
  const tooltip = byId<HTMLElement>('tooltip');
  const zoomOut = byId<HTMLButtonElement>('zoom-out');
  const breadcrumb = byId<HTMLElement>('breadcrumb');

  const trace = new TraceView(traceHost, tooltip);
  state.trace = trace;
  trace.onSelect = (span) => renderDetailFor(span);
  trace.onZoom = (span) => zoomTo(span);

  const detailActions = {
    select: (span: Span) => trace.select(span),
    zoom: (span: Span) => zoomTo(span),
    parentOf: (span: Span) => current()?.parents.get(span.id) ?? null,
    openSession: (span: Span) => {
      const entry = current()?.lciChildren.get(span.id);
      if (entry !== undefined) void openEntry(entry);
    },
  };

  // ---- file loading -------------------------------------------------------
  const handleFiles = async (files: FileList | File[]): Promise<void> => {
    try {
      setStatus(`reading ${files.length} file${files.length === 1 ? '' : 's'}…`);
      const loaded = await readFiles(files);
      for (const { name, text } of loaded) addSession(parseAndPrice(text, name), name);
      setStatus('');
    } catch (err) {
      setStatus(`failed to read file: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  };

  fileInput.addEventListener('change', () => {
    if (fileInput.files !== null) void handleFiles(fileInput.files);
    fileInput.value = '';
  });
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer?.files.length) void handleFiles(e.dataTransfer.files);
  });

  byId<HTMLButtonElement>('load-sample').addEventListener('click', () => {
    void (async () => {
      try {
        const res = await fetch('./samples/claude-code.jsonl');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        addSession(parseAndPrice(text, 'sample: claude-code.jsonl'), 'claude-code.jsonl (sample)');
      } catch (err) {
        setStatus(`failed to load sample: ${err instanceof Error ? err.message : String(err)}`, true);
      }
    })();
  });

  // ---- session index ------------------------------------------------------
  const indexHost = byId<HTMLElement>('index-view');
  const indexPanel = byId<HTMLDetailsElement>('index-panel');
  const indexSummaryLabel = byId<HTMLElement>('index-summary');
  const index = {
    sources: {
      claude: { connected: false, stored: false, sessions: 0 },
      lci: { connected: false, stored: false, sessions: 0 },
    },
    entries: { claude: [] as SessionEntry[], lci: [] as SessionEntry[] },
    projects: [] as ProjectGroup[],
    filter: '',
    progress: null as IndexProgress | null,
    busy: false,
  };

  const indexActions: IndexActions = {
    connect: (kind) => void connectSource(kind),
    forget: (kind) => void forgetSource(kind),
    setFilter: (text) => {
      index.filter = text;
      renderIndexPanel();
    },
    open: (entry) => void openEntry(entry),
  };

  async function connectSource(kind: SourceKind): Promise<void> {
    index.busy = true;
    index.progress = null;
    renderIndexPanel();
    try {
      // A remembered handle only needs permission re-granted (inside this
      // click); fall back to the picker if that is refused or the dir is gone.
      const files = (index.sources[kind].stored ? await restoreDirectory(kind) : null) ?? (await pickDirectory(kind));
      if (files === null) {
        setStatus('directory pick cancelled');
        return;
      }
      await scanSource(kind, files);
    } catch (err) {
      setStatus(`failed to connect: ${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      index.busy = false;
      renderIndexPanel();
    }
  }

  async function scanSource(kind: SourceKind, files: SourceFile[]): Promise<void> {
    index.busy = true;
    const label = kind === 'claude' ? '~/.claude' : '~/.lci';
    index.progress = { label: `scanning ${label}`, done: 0, total: files.length };
    renderIndexPanel();
    const entries = await scanWithCache(kind, files, (done, total) => {
      index.progress = { label: `scanning ${label}`, done, total };
      renderIndexPanel();
    });
    index.entries[kind] = entries;
    index.sources[kind] = { connected: true, stored: true, sessions: entries.length };
    index.progress = null;
    index.busy = false;
    rebuildIndex();
    renderIndexPanel();
    // Sessions opened before this source was connected can now be grafted.
    for (const loaded of state.sessions) void graftLciChildren(loaded);
  }

  async function forgetSource(kind: SourceKind): Promise<void> {
    try {
      await Promise.all([forgetDirectory(kind), clearScanCache(kind)]);
    } catch (err) {
      setStatus(`failed to forget directory: ${err instanceof Error ? err.message : String(err)}`, true);
    }
    index.entries[kind] = [];
    index.sources[kind] = { connected: false, stored: false, sessions: 0 };
    index.filter = '';
    rebuildIndex();
    renderIndexPanel();
  }

  async function openEntry(entry: SessionEntry): Promise<void> {
    try {
      const name = entry.title === '' ? entry.id : entry.title;
      setStatus(`opening ${name}…`);
      const text = await entry.file.text();
      const session = parseAndPrice(text, entry.path);
      if (entry.title !== '') session.title = entry.title; // index title beats the parser's guess
      addSession(session, name, entry);
      setStatus('');
      indexPanel.open = false; // collapse the index so the trace is visible
    } catch (err) {
      setStatus(`failed to open session: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }

  function rebuildIndex(): void {
    index.projects = buildIndex([...index.entries.claude, ...index.entries.lci]);
  }

  function renderIndexPanel(): void {
    const model: IndexModel = {
      claude: index.sources.claude,
      lci: index.sources.lci,
      projects: index.projects,
      filter: index.filter,
      progress: index.progress,
      busy: index.busy,
    };
    renderIndex(indexHost, model, indexActions);
    indexSummaryLabel.textContent =
      index.projects.length === 0 ? 'session index' : `session index — ${indexSummary(model)}`;
  }

  // On load, silently rescan directories the browser still lets us read;
  // ones that need a permission prompt show as "reconnect" (prompts require
  // a user gesture, so we cannot ask here).
  async function restoreSources(): Promise<void> {
    for (const kind of ['claude', 'lci'] as const) {
      const stored = await storedState(kind);
      if (stored === 'none') continue;
      const files = stored === 'granted' ? await restoreDirectory(kind) : null;
      if (files !== null) {
        await scanSource(kind, files);
      } else {
        index.sources[kind] = { connected: false, stored: true, sessions: 0 };
        renderIndexPanel();
      }
    }
  }

  renderIndexPanel();
  void restoreSources();

  function parseAndPrice(text: string, name: string): Session {
    const session = parseTranscript(text, name);
    applyPricing(session, effectivePricing());
    return session;
  }

  function addSession(session: Session, fileName: string, entry?: SessionEntry): void {
    const loaded: Loaded = { session, fileName, parents: new Map(), lciChildren: new Map(), grafting: false };
    reindexParents(loaded);
    state.sessions.push(loaded);
    state.active = state.sessions.length - 1;
    state.zoomNode = null;
    renderTabs();
    indexPanel.open = false; // the index yields to the trace; reopen it from its header
    render(true);
    if (session.format === 'claude-code') void graftLciChildren(loaded, entry);
  }

  function reindexParents(loaded: Loaded): void {
    loaded.parents.clear();
    for (const span of flatten(loaded.session.root)) for (const c of span.children) loaded.parents.set(c.id, span);
  }

  // ---- lci children -------------------------------------------------------
  /** The index node for a loaded Claude session, if the index knows it. */
  function indexNodeFor(session: Session, entry?: SessionEntry): SessionNode | null {
    for (const project of index.projects) {
      for (const group of project.worktrees) {
        for (const node of group.sessions) {
          if (node.entry.kind !== 'claude') continue;
          if (entry !== undefined ? node.entry.path === entry.path : node.entry.id === session.id) return node;
        }
      }
    }
    return null;
  }

  /**
   * Read every lci session the index nests under this Claude session and
   * graft it under the Bash call that launched it (or the active turn), so
   * the waterfall shows the whole multi-harness journey. Runs after the
   * first paint; the trace refreshes in place when it is done.
   */
  async function graftLciChildren(loaded: Loaded, entry?: SessionEntry): Promise<void> {
    if (loaded.session.format !== 'claude-code' || loaded.grafting) return;
    const node = indexNodeFor(loaded.session, entry);
    if (node === null) return;
    const have = graftedIds(loaded.session.root);
    const todo = node.children.filter((c) => c.entry.kind === 'lci' && !have.has(c.entry.id));
    if (todo.length === 0) return;
    loaded.grafting = true;
    setStatus(`nesting ${todo.length} lci session${todo.length === 1 ? '' : 's'}…`);
    let added = 0;
    let empty = 0;
    try {
      for (const child of todo) {
        const e = child.entry;
        try {
          const session = parseAndPrice(await e.file.text(), e.path);
          if (isEmptySession(session)) {
            empty += 1; // e.g. review probes that never ran: nothing to draw
            continue;
          }
          const host = findLaunchSpan(loaded.session.root, e.startMs);
          const grafted = graftSession(loaded.session.root, host, session, { id: e.id, path: e.path, title: e.title });
          loaded.lciChildren.set(grafted.id, e);
          added += 1;
        } catch (err) {
          loaded.session.warnings.push(`could not nest lci session ${e.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      loaded.grafting = false;
    }
    setStatus('');
    if (empty > 0) loaded.session.warnings.push(`${empty} empty lci session${empty === 1 ? '' : 's'} (no events) not nested`);
    if (added === 0) return;
    applyPricing(loaded.session, effectivePricing()); // rollups now include the children
    reindexParents(loaded);
    if (current() === loaded) {
      trace.refresh();
      render(false);
      if (trace.selected !== null) renderDetailFor(trace.selected);
    }
  }

  function current(): Loaded | undefined {
    return state.sessions[state.active];
  }

  // ---- tabs ---------------------------------------------------------------
  function renderTabs(): void {
    tabs.textContent = '';
    tabs.hidden = state.sessions.length <= 1;
    if (state.sessions.length <= 1) return;
    state.sessions.forEach((loaded, i) => {
      tabs.append(
        el(
          'button',
          {
            class: `tab${i === state.active ? ' active' : ''}`,
            type: 'button',
            title: loaded.fileName,
            onclick: () => {
              state.active = i;
              state.zoomNode = null;
              renderTabs();
              render(true);
            },
          },
          loaded.session.title || loaded.fileName,
        ),
      );
    });
  }

  // ---- rendering ----------------------------------------------------------
  /** `newTree` = a different session or zoom root: rebuild rows and clear selection. */
  function render(newTree: boolean): void {
    const loaded = current();
    if (loaded === undefined) {
      app.hidden = true;
      return;
    }
    app.hidden = false;
    const sessionRoot = loaded.session.root;
    const root = state.zoomNode ?? sessionRoot;

    const pad = Math.max(1, (root.endMs - root.startMs) * 0.01);
    state.t0 = root.startMs;
    state.t1 = Math.max(root.endMs, root.startMs + 1) + pad;

    if (newTree) {
      trace.setRoot(root, sessionRoot.startMs);
      renderEmptyDetail(detailPane);
    }
    trace.setWindow(state.t0, state.t1);

    sizeCanvas(cacheCanvas);
    drawCacheTrace(cacheCanvas, collectCacheBars(root, state.t0, state.t1), state.t0, state.t1);

    renderSummary(byId<HTMLElement>('summary-panel'), loaded.session, summarize(sessionRoot));
    breadcrumb.textContent = breadcrumbText(loaded, state.zoomNode);
    zoomOut.disabled = state.zoomNode === null;
  }

  function renderDetailFor(span: Span | null): void {
    const loaded = current();
    if (span === null || loaded === undefined) {
      renderEmptyDetail(detailPane);
      return;
    }
    renderDetail(detailPane, span, loaded.session, detailActions);
  }

  function zoomTo(span: Span): void {
    const loaded = current();
    if (loaded === undefined) return;
    state.zoomNode = span === loaded.session.root ? null : span;
    render(true);
    if (state.zoomNode !== null) trace.select(span, { scroll: true });
  }

  // ---- pricing (re-applies to all sessions, refreshes summary + detail) ---
  renderPricingEditor(byId<HTMLElement>('pricing-table'), effectivePricing(), (table) => {
    for (const { session } of state.sessions) applyPricing(session, table);
    const loaded = current();
    if (loaded === undefined) return;
    renderSummary(byId<HTMLElement>('summary-panel'), loaded.session, summarize(loaded.session.root));
    if (trace.selected !== null) renderDetailFor(trace.selected);
  });

  // ---- controls -----------------------------------------------------------
  zoomOut.addEventListener('click', () => {
    state.zoomNode = null;
    render(true);
  });
  byId<HTMLButtonElement>('collapse-all').addEventListener('click', () => trace.collapseAll());
  byId<HTMLButtonElement>('expand-all').addEventListener('click', () => trace.expandAll());

  // Focus mode: only the waterfall (plus its detail pane) stays on screen.
  const focusBtn = byId<HTMLButtonElement>('focus-toggle');
  const setFocus = (on: boolean): void => {
    document.body.classList.toggle('focus', on);
    focusBtn.textContent = on ? '⤡ exit focus' : '⤢ focus';
    focusBtn.title = on ? 'show the summary and index again (f)' : 'give the waterfall the whole window (f)';
    render(false);
  };
  focusBtn.addEventListener('click', () => setFocus(!document.body.classList.contains('focus')));

  document.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null;
    const typing = target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    if (e.key === 'f' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey && !app.hidden) {
      e.preventDefault();
      setFocus(!document.body.classList.contains('focus'));
      return;
    }
    if (e.key !== 'Escape') return;
    if (trace.selected !== null) {
      trace.select(null);
    } else if (state.zoomNode !== null) {
      state.zoomNode = null;
      render(true);
    } else if (document.body.classList.contains('focus')) {
      setFocus(false);
    }
  });

  // Draggable divider between the waterfall and the detail pane.
  const layout = byId<HTMLElement>('trace-layout');
  const splitter = byId<HTMLElement>('trace-splitter');
  const DETAIL_KEY = 'seekdeep.detailWidth';
  const applyDetailWidth = (px: number): void => {
    const max = Math.max(240, layout.clientWidth - 360);
    const w = Math.min(max, Math.max(240, Math.round(px)));
    layout.style.setProperty('--detail-w', `${w}px`);
  };
  try {
    const saved = Number(localStorage.getItem(DETAIL_KEY));
    if (Number.isFinite(saved) && saved > 0) applyDetailWidth(saved);
  } catch {
    // storage unavailable: keep the CSS default
  }
  splitter.addEventListener('pointerdown', (down) => {
    down.preventDefault();
    splitter.setPointerCapture(down.pointerId);
    const startX = down.clientX;
    const startW = detailPane.getBoundingClientRect().width;
    document.body.classList.add('resizing');
    const move = (e: PointerEvent): void => applyDetailWidth(startW - (e.clientX - startX));
    const up = (): void => {
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', up);
      splitter.removeEventListener('pointercancel', up);
      document.body.classList.remove('resizing');
      try {
        localStorage.setItem(DETAIL_KEY, String(detailPane.getBoundingClientRect().width));
      } catch {
        // storage unavailable
      }
      render(false);
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up);
    splitter.addEventListener('pointercancel', up);
  });
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => render(false), 100);
  });

  function setStatus(message: string, isError = false): void {
    const status = document.getElementById('drop-status');
    if (status === null) return;
    status.textContent = message;
    status.classList.toggle('error', isError);
  }

  function breadcrumbText(loaded: Loaded, zoom: Span | null): string {
    if (zoom === null) return '';
    const path: string[] = [];
    let cur: Span | undefined = zoom;
    while (cur !== undefined) {
      path.unshift(cur.name.length > 40 ? `${cur.name.slice(0, 40)}…` : cur.name);
      cur = loaded.parents.get(cur.id);
    }
    return path.join(' › ');
  }
}

main();
