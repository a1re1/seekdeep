// seekdeep entry point: file loading, session tabs, trace waterfall + detail
// pane + cache trace, summary panel, pricing editor. All state lives in the
// browser; nothing is uploaded anywhere.

import type { Session, Span } from './model.ts';
import { flatten } from './model.ts';
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

  function parseAndPrice(text: string, name: string): Session {
    const session = parseTranscript(text, name);
    applyPricing(session, effectivePricing());
    return session;
  }

  function addSession(session: Session, fileName: string): void {
    const parents = new Map<string, Span>();
    for (const span of flatten(session.root)) for (const c of span.children) parents.set(c.id, span);
    state.sessions.push({ session, fileName, parents });
    state.active = state.sessions.length - 1;
    state.zoomNode = null;
    renderTabs();
    render(true);
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
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (trace.selected !== null) {
      trace.select(null);
    } else if (state.zoomNode !== null) {
      state.zoomNode = null;
      render(true);
    }
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
