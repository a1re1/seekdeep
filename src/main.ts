// seekdeep entry point: file loading, session picker, trace waterfall +
// inspector + cache trace, summary cards, activity and settings pages. All
// state lives in the browser; nothing is uploaded anywhere.

import { clearActivityCache, collectBuckets } from './index/activity-cache.ts';
import { clearScanCache, scanWithCache } from './index/cache.ts';
import { SOURCES, SOURCE_KINDS, forgetDirectory, isHostKind, pickDirectory, restoreDirectory, storedState } from './index/fs.ts';
import type { SourceFile, SourceKind } from './index/fs.ts';
import { buildIndex, splitWorktree } from './index/link.ts';
import type { ProjectGroup, SessionNode } from './index/link.ts';
import type { SessionEntry } from './index/scan.ts';
import { renderIndex } from './ui/index-view.ts';
import type { IndexActions, IndexModel, IndexProgress, IndexSourceState } from './ui/index-view.ts';
import type { Session, Span } from './model.ts';
import { flatten } from './model.ts';
import { findLaunchSpan, graftSession, graftedIds, isEmptySession, isHostFormat } from './graft.ts';
import { parseTranscript } from './parsers/index.ts';
import { applyPricing, effectivePricing } from './pricing.ts';
import {
  bindCacheStrip,
  cacheSpanAt,
  cacheTooltipText,
  collectCacheBars,
  drawCacheTrace,
  freshCacheStripState,
} from './ui/cache-trace.ts';
import { renderDetail, renderEmptyDetail } from './ui/detail.ts';
import { byId, el, sizeCanvas } from './ui/dom.ts';
import { icon } from './ui/icons.ts';
import { readFiles } from './ui/loader.ts';
import { renderPricingEditor } from './ui/pricing.ts';
import { cleanupActivityView, harnessMatches, reconcileHarnessSelection, renderActivity } from './ui/activity-view.ts';
import { aggregate, bucketSession, mergeBuckets, rangeFor } from './stats.ts';
import type { RangePreset, UsageBucket } from './stats.ts';
import { renderSummary, summarize } from './ui/summary.ts';
import { initTheme, toggleTheme, type Theme } from './ui/theme.ts';
import { TraceView } from './ui/trace.ts';

type Page = 'trace' | 'activity' | 'settings';

interface Loaded {
  session: Session;
  fileName: string;
  /** The index entry this session was opened from, when it came from the picker. */
  entry: SessionEntry | undefined;
  parents: Map<string, Span>; // child id → parent span
  /** drip sessions grafted into this tree, by grafted span id. */
  dripChildren: Map<string, SessionEntry>;
  grafting: boolean;
}

const state = {
  sessions: [] as Loaded[],
  active: -1,
  zoomNode: null as Span | null,
  trace: null as TraceView | null,
  t0: 0,
  t1: 0,
  /** Live cache-strip hit-test geometry, rebound on every render so a queued
   *  event from an earlier paint can never select a stale span. */
  cacheStrip: freshCacheStripState(),
  /** The picker is shown instead of the open session ("‹ Sessions"). */
  picker: true,
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
  // The glass panel's backdrop filter makes it a containing block for fixed
  // descendants. Keep the shared tooltip at viewport level instead.
  document.body.append(tooltip);
  const zoomOut = byId<HTMLButtonElement>('zoom-out');
  const breadcrumb = byId<HTMLElement>('breadcrumb');
  const spanCount = byId<HTMLElement>('span-count');

  const trace = new TraceView(traceHost, tooltip);
  state.trace = trace;

  // Activity page state (declared early: scans and drops invalidate it).
  const activity = {
    page: 'trace' as Page,
    preset: '48h' as RangePreset,
    harness: null as string[] | null, // null = every harness (all-selected default)
    harnessOpen: false,
    buckets: null as UsageBucket[] | null, // null until the first collection
    collecting: false,
    progress: null as string | null,
    skipped: [] as string[], // transcript paths the last collection could not read
  };

  trace.onSelect = (span) => renderDetailFor(span);
  trace.onZoom = (span) => zoomTo(span);

  // Cache strip interactions: hover shows a bounded plain-text preview via the
  // shared tooltip (textContent only, like TraceView); click selects the exact
  // call under the bar. Bars are rebound on every render, so stale events can
  // never select; leaving the strip always hides the tooltip.
  cacheCanvas.addEventListener('pointermove', onCacheHover);
  cacheCanvas.addEventListener('pointerleave', hideCacheTooltip);
  cacheCanvas.addEventListener('click', onCacheClick);
  trace.onRows = (n) => {
    spanCount.textContent = `${n.toLocaleString()} span${n === 1 ? '' : 's'}`;
  };

  const detailActions = {
    select: (span: Span | null) => trace.select(span),
    zoom: (span: Span) => zoomTo(span),
    parentOf: (span: Span) => current()?.parents.get(span.id) ?? null,
    openSession: (span: Span) => {
      const entry = current()?.dripChildren.get(span.id);
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
  // The whole window accepts drops; the pill in the toolbar is the visible target.
  for (const target of [dropZone, document.body]) {
    target.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });
    // relatedTarget is null when the drag leaves the window (or is cancelled).
    target.addEventListener('dragleave', (e) => {
      if (e.target === target || e.relatedTarget === null) dropZone.classList.remove('dragover');
    });
    target.addEventListener('dragend', () => dropZone.classList.remove('dragover'));
    target.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      if (e.dataTransfer?.files.length) void handleFiles(e.dataTransfer.files);
    });
  }

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
  const indexPanel = byId<HTMLElement>('index-panel');
  const sourcesSummary = byId<HTMLElement>('sources-summary');
  const emptySource = (): IndexSourceState => ({ connected: false, stored: false, sessions: 0 });
  const index = {
    sources: Object.fromEntries(SOURCE_KINDS.map((k) => [k, emptySource()])) as Record<SourceKind, IndexSourceState>,
    entries: Object.fromEntries(SOURCE_KINDS.map((k) => [k, [] as SessionEntry[]])) as Record<SourceKind, SessionEntry[]>,
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
    const label = SOURCES[kind].label;
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
    for (const loaded of state.sessions) void graftDripChildren(loaded);
    activity.buckets = null; // re-collect (cache hits make it cheap) next time the page shows
    if (activity.page === 'activity') void collectActivity();
  }

  async function forgetSource(kind: SourceKind): Promise<void> {
    try {
      await Promise.all([forgetDirectory(kind), clearScanCache(kind), clearActivityCache(kind)]);
    } catch (err) {
      setStatus(`failed to forget directory: ${err instanceof Error ? err.message : String(err)}`, true);
    }
    index.entries[kind] = [];
    index.sources[kind] = { connected: false, stored: false, sessions: 0 };
    index.filter = '';
    rebuildIndex();
    renderIndexPanel();
    activity.buckets = null; // that source's usage must leave the page too
    if (activity.page === 'activity') void collectActivity();
  }

  /** Re-read every connected source (picks up transcripts written since the last scan). */
  async function rescanSources(): Promise<void> {
    if (index.busy) return; // a scan is already running; let it finish
    const kinds = SOURCE_KINDS.filter((k) => index.sources[k].connected);
    if (kinds.length === 0) {
      setStatus('nothing connected yet — connect a source from the session picker');
      return;
    }
    for (const kind of kinds) {
      try {
        const files = await restoreDirectory(kind);
        if (files === null) {
          index.sources[kind] = { connected: false, stored: true, sessions: 0 };
          renderIndexPanel();
          continue;
        }
        await scanSource(kind, files);
      } catch (err) {
        setStatus(`failed to rescan: ${err instanceof Error ? err.message : String(err)}`, true);
      }
    }
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
    } catch (err) {
      setStatus(`failed to open session: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }

  function rebuildIndex(): void {
    index.projects = buildIndex(SOURCE_KINDS.flatMap((k) => index.entries[k]));
  }

  function renderIndexPanel(): void {
    const model: IndexModel = {
      sources: index.sources,
      projects: index.projects,
      filter: index.filter,
      progress: index.progress,
      busy: index.busy,
    };
    renderIndex(indexPanel, model, indexActions);
    sourcesSummary.textContent = SOURCE_KINDS
      .map((k) => {
        const s = index.sources[k];
        const label = SOURCES[k].label;
        return `${label} · ${s.connected ? `${s.sessions} session${s.sessions === 1 ? '' : 's'}` : s.stored ? 'reconnect needed' : 'not connected'}`;
      })
      .join('   ');
  }

  // On load, silently rescan directories the browser still lets us read;
  // ones that need a permission prompt show as "reconnect" (prompts require
  // a user gesture, so we cannot ask here).
  async function restoreSources(): Promise<void> {
    for (const kind of SOURCE_KINDS) {
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
    const loaded: Loaded = { session, fileName, entry, parents: new Map(), dripChildren: new Map(), grafting: false };
    reindexParents(loaded);
    state.sessions.push(loaded);
    state.active = state.sessions.length - 1;
    state.zoomNode = null;
    state.picker = false;
    activity.buckets = null; // a dropped transcript may add usage the index lacks
    showPage('trace');
    renderTabs();
    render(true);
    if (isHostFormat(session.format)) void graftDripChildren(loaded, entry);
  }

  function reindexParents(loaded: Loaded): void {
    loaded.parents.clear();
    for (const span of flatten(loaded.session.root)) for (const c of span.children) loaded.parents.set(c.id, span);
  }

  // ---- drip children -------------------------------------------------------
  /** The index node for a loaded host session, if the index knows it. */
  function indexNodeFor(session: Session, entry?: SessionEntry): SessionNode | null {
    for (const project of index.projects) {
      for (const group of project.worktrees) {
        for (const node of group.sessions) {
          if (!isHostKind(node.entry.kind)) continue;
          if (entry !== undefined ? node.entry.path === entry.path : node.entry.id === session.id) return node;
        }
      }
    }
    return null;
  }

  /**
   * Read every drip session the index nests under this host session (Claude
   * Code, Codex, OpenCode or pi) and graft it under the shell call that launched it
   * (or the active turn), so the waterfall shows the whole multi-harness
   * journey. Runs after the first paint; the trace refreshes in place when
   * it is done.
   */
  async function graftDripChildren(loaded: Loaded, entry?: SessionEntry): Promise<void> {
    if (!isHostFormat(loaded.session.format) || loaded.grafting) return;
    const node = indexNodeFor(loaded.session, entry);
    if (node === null) return;
    const have = graftedIds(loaded.session.root);
    const todo = node.children.filter((c) => c.entry.kind === 'drip' && !have.has(c.entry.id));
    if (todo.length === 0) return;
    loaded.grafting = true;
    setStatus(`nesting ${todo.length} drip session${todo.length === 1 ? '' : 's'}…`);
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
          loaded.dripChildren.set(grafted.id, e);
          added += 1;
        } catch (err) {
          loaded.session.warnings.push(`could not nest drip session ${e.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      loaded.grafting = false;
    }
    setStatus('');
    if (empty > 0) loaded.session.warnings.push(`${empty} empty drip session${empty === 1 ? '' : 's'} (no events) not nested`);
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
            type: 'button',
            'aria-selected': i === state.active ? 'true' : 'false',
            title: loaded.fileName,
            onclick: () => {
              state.active = i;
              state.zoomNode = null;
              renderTabs();
              render(true);
            },
          },
          loaded.session.title || loaded.fileName,
          el('span', {
            class: 'session-tab-close',
            role: 'button',
            'aria-label': 'Close session',
            title: 'Close session',
            onclick: (e) => {
              e.stopPropagation();
              closeSession(i);
            },
          }, icon('x', 12)),
        ),
      );
    });
  }

  /** Close tab i: splice it out, fix the active index, and refresh the trace. */
  function closeSession(i: number): void {
    state.sessions.splice(i, 1);
    if (state.sessions.length === 0) {
      state.active = -1;
      state.zoomNode = null;
      state.picker = true; // same screen the "‹ Sessions" breadcrumb shows
      syncTraceScreens();
      return;
    }
    if (i === state.active) state.active = Math.max(0, i - 1);
    else if (i < state.active) state.active -= 1;
    state.zoomNode = null;
    renderTabs();
    render(true);
  }

  // ---- rendering ----------------------------------------------------------
  /** Which of picker / trace is visible on the Trace page. */
  function syncTraceScreens(): void {
    const onTrace = activity.page === 'trace';
    const showTrace = onTrace && current() !== undefined && !state.picker;
    app.hidden = !showTrace;
    indexPanel.hidden = !(onTrace && !showTrace);
  }

  /** Hover: bounded plain-text preview of the exact call under the cursor. */
  function onCacheHover(e: MouseEvent): void {
    const span = cacheSpanAt(state.cacheStrip, e.offsetX);
    if (span === null) {
      hideCacheTooltip();
      return;
    }
    tooltip.textContent = cacheTooltipText(span);
    tooltip.hidden = false;
    positionTooltip(e);
  }

  /** Cursor-anchored placement, flipped at the viewport edges (TraceView pattern). */
  function positionTooltip(e: MouseEvent): void {
    const pad = 14;
    const w = tooltip.offsetWidth;
    const h = tooltip.offsetHeight;
    let x = e.clientX + pad;
    let y = e.clientY + pad;
    if (x + w > window.innerWidth - 8) x = e.clientX - w - pad;
    if (y + h > window.innerHeight - 8) y = e.clientY - h - pad;
    tooltip.style.left = `${Math.max(4, Math.min(x, window.innerWidth - w - 4))}px`;
    tooltip.style.top = `${Math.max(4, Math.min(y, window.innerHeight - h - 4))}px`;
  }

  function hideCacheTooltip(): void {
    tooltip.hidden = true;
  }

  /** Click: select the exact call — collapsed ancestors expand, the row
   *  scrolls into view, the detail pane updates; the zoom window is untouched. */
  function onCacheClick(e: MouseEvent): void {
    const span = cacheSpanAt(state.cacheStrip, e.offsetX);
    if (span === null) return;
    hideCacheTooltip();
    trace.select(span, { scroll: true });
  }

  /** `newTree` = a different session or zoom root: rebuild rows and clear selection. */
  function render(newTree: boolean): void {
    const loaded = current();
    syncTraceScreens();
    if (loaded === undefined || app.hidden) {
      // Nothing is painted (no session, or not on the trace page): the strip
      // must keep neither hit geometry nor a hover tooltip from before.
      bindCacheStrip(state.cacheStrip, [], 0);
      hideCacheTooltip();
      return;
    }
    const sessionRoot = loaded.session.root;
    const root = state.zoomNode ?? sessionRoot;

    const pad = Math.max(1, (root.endMs - root.startMs) * 0.01);
    state.t0 = root.startMs;
    state.t1 = Math.max(root.endMs, root.startMs + 1) + pad;

    if (newTree) {
      trace.setRoot(root, sessionRoot.startMs);
      renderEmptyDetail(detailPane);
      setExpandMode('default');
    }
    trace.setWindow(state.t0, state.t1);

    sizeCanvas(cacheCanvas);
    const bars = collectCacheBars(root, state.t0, state.t1);
    drawCacheTrace(cacheCanvas, bars, state.t0, state.t1);
    // Rebind hit-test geometry on every paint (covers resize, zoom and session
    // changes) and drop any hover tooltip left over from the previous content.
    bindCacheStrip(
      state.cacheStrip,
      bars,
      cacheCanvas.getBoundingClientRect().width || cacheCanvas.width,
      cacheCanvas.width / (cacheCanvas.getBoundingClientRect().width || cacheCanvas.width),
    );
    hideCacheTooltip();

    renderSummary(byId<HTMLElement>('summary-panel'), loaded.session, summarize(sessionRoot));
    renderCrumbs(loaded);
    breadcrumb.textContent = breadcrumbText(loaded, state.zoomNode);
    zoomOut.disabled = state.zoomNode === null;
  }

  function renderCrumbs(loaded: Loaded): void {
    const entry = loaded.entry;
    const cwd = entry?.cwd ?? null;
    const wt = cwd !== null ? (splitWorktree(cwd).worktree ?? 'main') : null;
    const branch = entry?.branch ?? null;
    byId<HTMLElement>('crumb-project').textContent = entry !== undefined ? projectLabelFor(entry) : loaded.fileName;
    byId<HTMLElement>('crumb-title').textContent = loaded.session.title || loaded.fileName;
    byId<HTMLElement>('crumb-meta').textContent = [wt, branch].filter((s): s is string => s !== null && s !== '').join(' · ');
  }

  function projectLabelFor(entry: SessionEntry): string {
    for (const project of index.projects) {
      for (const group of project.worktrees) {
        for (const node of group.sessions) {
          if (node.entry.path === entry.path || node.children.some((c) => c.entry.path === entry.path)) return project.label;
        }
      }
    }
    return entry.slug;
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
    renderActivityPage(); // charts re-price from the cached buckets, no rescan
    const loaded = current();
    if (loaded === undefined) return;
    renderSummary(byId<HTMLElement>('summary-panel'), loaded.session, summarize(loaded.session.root));
    if (trace.selected !== null) renderDetailFor(trace.selected);
  });

  // ---- theme ---------------------------------------------------------------
  const themeToggle = byId<HTMLButtonElement>('theme-toggle');
  const themeSwitch = byId<HTMLInputElement>('theme-switch');
  const syncTheme = (t: Theme): void => {
    themeToggle.replaceChildren(icon(t === 'dark' ? 'moon' : 'sun', 16));
    themeToggle.title = t === 'dark' ? 'switch to light theme' : 'switch to dark theme';
    themeSwitch.checked = t === 'dark';
  };
  syncTheme(initTheme()); // reflects the pre-paint choice onto <html> too
  themeToggle.addEventListener('click', () => syncTheme(toggleTheme()));
  themeSwitch.addEventListener('change', () => syncTheme(toggleTheme()));

  // ---- pages ---------------------------------------------------------------
  const activitySection = byId<HTMLElement>('activity');
  const activityHost = byId<HTMLElement>('activity-host');
  const settingsSection = byId<HTMLElement>('settings');
  const navTrace = byId<HTMLButtonElement>('nav-trace');
  const navActivity = byId<HTMLButtonElement>('nav-activity');
  const navSettings = byId<HTMLButtonElement>('nav-settings');
  navSettings.replaceChildren(icon('settings', 16));

  function showPage(page: Page): void {
    bindCacheStrip(state.cacheStrip, [], 0);
    hideCacheTooltip();
    if (activity.page === 'activity' && page !== 'activity') {
      activity.harnessOpen = false;
      cleanupActivityView();
    }
    activity.page = page;
    navTrace.setAttribute('aria-pressed', page === 'trace' ? 'true' : 'false');
    navActivity.setAttribute('aria-pressed', page === 'activity' ? 'true' : 'false');
    navSettings.setAttribute('aria-pressed', page === 'settings' ? 'true' : 'false');
    navSettings.classList.toggle('vt-btn--glass', page === 'settings');
    navSettings.classList.toggle('vt-btn--plain', page !== 'settings');
    activitySection.hidden = page !== 'activity';
    settingsSection.hidden = page !== 'settings';
    if (page === 'activity') {
      syncTraceScreens();
      renderActivityPage();
      if (activity.buckets === null) void collectActivity();
    } else {
      render(false);
    }
  }
  navTrace.addEventListener('click', () => showPage('trace'));
  navActivity.addEventListener('click', () => showPage('activity'));
  navSettings.addEventListener('click', () => showPage(activity.page === 'settings' ? 'trace' : 'settings'));
  byId<HTMLButtonElement>('back-to-sessions').addEventListener('click', () => {
    state.picker = true;
    setFocus(false);
  });
  byId<HTMLButtonElement>('sources-rescan').addEventListener('click', () => void rescanSources());

  /** Index entries plus sessions that were dropped in and are not in the index. */
  function activitySources(): { entries: SessionEntry[]; extra: Session[] } {
    const entries = [...index.entries.claude, ...index.entries.codex, ...index.entries.drip];
    const known = new Set(entries.map((e) => e.id));
    const extra = state.sessions.map((l) => l.session).filter((s) => !known.has(s.id));
    return { entries, extra };
  }

  async function collectActivity(): Promise<void> {
    if (activity.collecting) return;
    const { entries, extra } = activitySources();
    activity.collecting = true;
    activity.skipped = []; // a warning must describe this run, not the last one
    activity.progress = entries.length > 0 ? `reading 0 / ${entries.length} transcripts` : null;
    renderActivityPage();
    try {
      const { buckets: indexed, skipped } = await collectBuckets(entries, (done, total) => {
        activity.progress = `reading ${done} / ${total} transcripts`;
        renderActivityPage();
      });
      activity.buckets = mergeBuckets([indexed, ...extra.map(bucketSession)]);
      activity.skipped = skipped;
    } catch (err) {
      setStatus(`failed to read transcripts: ${err instanceof Error ? err.message : String(err)}`, true);
      activity.buckets ??= [];
    } finally {
      activity.collecting = false;
      activity.progress = null;
      renderActivityPage();
    }
  }

  function renderActivityPage(): void {
    if (activity.page !== 'activity') return;
    const { entries, extra } = activitySources();
    const nothing = entries.length === 0 && extra.length === 0;
    const preset = activity.preset;
    const all = activity.buckets;
    const harnesses = all === null ? [] : [...new Set(all.map((b) => b.harness ?? 'other'))].sort();
    if (all !== null) activity.harness = reconcileHarnessSelection(activity.harness, harnesses);
    const selected = activity.harness; // narrowed snapshot: null = all, otherwise OR-membership
    const buckets = all === null || selected === null ? all : all.filter((b) => harnessMatches(selected, b.harness));
    renderActivity(
      activityHost,
      {
        activity: buckets === null || nothing ? null : aggregate(buckets, effectivePricing(), rangeFor(preset, Date.now(), buckets)),
        progress: activity.progress,
        skipped: activity.skipped,
        preset: activity.preset,
        harnesses,
        harness: activity.harness,
        harnessOpen: activity.harnessOpen,
        empty: nothing
          ? 'Connect ~/.claude, ~/.codex, or ~/.drip from the session picker (or drop a transcript) to see your activity.'
          : buckets === null
            ? 'Reading transcripts…'
            : null,
      },
      {
        onRange: (p) => {
          activity.preset = p;
          renderActivityPage();
        },
        onHarness: (h) => {
          activity.harness = h;
          renderActivityPage();
        },
        onHarnessOpen: (open) => {
          activity.harnessOpen = open;
          renderActivityPage();
        },
        onRescan: () => {
          activity.harnessOpen = false;
          activity.buckets = null;
          void collectActivity();
        },
      },
    );
  }

  // ---- controls -----------------------------------------------------------
  zoomOut.addEventListener('click', () => {
    state.zoomNode = null;
    render(true);
  });
  type ExpandMode = 'default' | 'collapse' | 'expand';
  const expandButtons: Record<ExpandMode, HTMLButtonElement> = {
    default: byId<HTMLButtonElement>('expand-default'),
    collapse: byId<HTMLButtonElement>('collapse-all'),
    expand: byId<HTMLButtonElement>('expand-all'),
  };
  function setExpandMode(mode: ExpandMode): void {
    for (const [key, button] of Object.entries(expandButtons)) button.setAttribute('aria-pressed', key === mode ? 'true' : 'false');
  }
  expandButtons.default.addEventListener('click', () => {
    trace.resetCollapse();
    setExpandMode('default');
  });
  expandButtons.collapse.addEventListener('click', () => {
    trace.collapseAll();
    setExpandMode('collapse');
  });
  expandButtons.expand.addEventListener('click', () => {
    trace.expandAll();
    setExpandMode('expand');
  });

  // Focus mode: only the waterfall (plus its inspector) stays on screen.
  const focusBtn = byId<HTMLButtonElement>('focus-toggle');
  const setFocus = (on: boolean): void => {
    document.body.classList.toggle('focus', on);
    focusBtn.textContent = on ? '⤡ Exit focus' : '⤢ Focus';
    focusBtn.title = on ? 'show the toolbar and summary again (f)' : 'give the waterfall the whole window (f)';
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

  // Draggable divider between the waterfall and the inspector.
  const layout = byId<HTMLElement>('trace-section');
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
    bindCacheStrip(state.cacheStrip, [], 0);
    hideCacheTooltip();
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
    return `zoomed: ${path.join(' › ')}`;
  }

  syncTraceScreens();
}

main();
