// OpenTelemetry / Jaeger-style trace waterfall.
//
// One row per span in depth-first pre-order (parents before children, siblings
// by start time), indented by depth, with a bar on a shared time axis. Rows
// are windowed: only the slice inside the scroll viewport (± a buffer) exists
// in the DOM, so sessions with thousands of spans stay cheap.

import type { Span } from '../model.ts';
import { cacheHitRate, durationMs, selfTimeMs } from '../model.ts';
import { el } from './dom.ts';
import { formatCost, formatCount, formatDuration, formatPct, formatTokens } from './format.ts';

export interface TraceRow {
  span: Span;
  depth: number;
  hasChildren: boolean;
}

export const ROW_HEIGHT = 24;
const BUFFER_ROWS = 40;
/** Turns with more direct children than this start collapsed. */
export const AUTO_COLLAPSE_CHILDREN = 300;

/** Pre-order rows for `root`; collapsed spans hide their descendants. */
export function flattenRows(root: Span, collapsed: Set<string>): TraceRow[] {
  const rows: TraceRow[] = [];
  const walk = (span: Span, depth: number): void => {
    rows.push({ span, depth, hasChildren: span.children.length > 0 });
    if (collapsed.has(span.id)) return;
    const kids = [...span.children].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    for (const child of kids) walk(child, depth + 1);
  };
  walk(root, 0);
  return rows;
}

/** Spans whose children are numerous enough to start collapsed. */
export function autoCollapsed(root: Span): Set<string> {
  const out = new Set<string>();
  const walk = (span: Span): void => {
    if (span.children.length > AUTO_COLLAPSE_CHILDREN) out.add(span.id);
    for (const child of span.children) walk(child);
  };
  walk(root);
  return out;
}

/** Pick a "nice" tick step (ms) giving roughly `target` ticks across `spanMs`. */
export function tickStep(spanMs: number, target = 8): number {
  const s = 1000;
  const m = 60 * s;
  const h = 60 * m;
  const candidates = [
    1, 2, 5, 10, 20, 50, 100, 200, 500,
    s, 2 * s, 5 * s, 10 * s, 15 * s, 30 * s,
    m, 2 * m, 5 * m, 10 * m, 15 * m, 30 * m,
    h, 2 * h, 6 * h, 12 * h, 24 * h,
  ];
  for (const c of candidates) if (spanMs / c <= target) return c;
  return candidates[candidates.length - 1]!;
}

export function tooltipText(span: Span): string {
  const u = span.usage;
  const lines = [
    span.name,
    `kind: ${span.kind}   duration: ${formatDuration(durationMs(span))}`,
    `self: ${formatDuration(selfTimeMs(span))}`,
  ];
  if (span.model !== undefined) lines.push(`model: ${span.model}`);
  if (u !== undefined) {
    lines.push(
      `tokens (in/cache rd/cache wr/out): ${formatTokens(u)}`,
      `cache hit rate: ${formatPct(cacheHitRate(u))}`,
    );
    if (span.costUsd !== undefined) lines.push(`cost: ${formatCost(span.costUsd)}`);
  } else if (span.meta?.costRollupUsd !== undefined && Number(span.meta.costRollupUsd) > 0) {
    lines.push(`cost (incl. children): ${formatCost(Number(span.meta.costRollupUsd))}`);
  }
  if (span.toolName !== undefined) lines.push(`tool: ${span.toolName}`);
  if (span.ok === false) lines.push('status: failed');
  if (span.detail !== undefined && span.detail.length > 0) lines.push(span.detail);
  lines.push('click: inspect · double-click: zoom');
  return lines.join('\n');
}

export class TraceView {
  onSelect: (span: Span | null) => void = () => {};
  onZoom: (span: Span) => void = () => {};

  collapsed = new Set<string>();
  selected: Span | null = null;

  private root: Span | null = null;
  private rows: TraceRow[] = [];
  private t0 = 0;
  private t1 = 1;
  private origin = 0; // session start, so axis labels stay absolute when zoomed
  private raf = 0;

  private readonly header: HTMLElement;
  private readonly axis: HTMLElement;
  private readonly body: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly rowsHost: HTMLElement;
  private readonly namesHeader: HTMLElement;

  constructor(
    private readonly container: HTMLElement,
    private readonly tooltip: HTMLElement,
  ) {
    this.namesHeader = el('div', { class: 'trace-names trace-names-h' }, 'span');
    this.axis = el('div', { class: 'trace-track trace-axis' });
    this.header = el('div', { class: 'trace-header' }, this.namesHeader, this.axis);
    this.grid = el('div', { class: 'trace-grid' });
    this.rowsHost = el('div', { class: 'trace-rows' });
    this.body = el('div', { class: 'trace-body' }, this.grid, this.rowsHost);
    container.textContent = '';
    container.append(this.header, this.body);
    container.tabIndex = 0;

    container.addEventListener('scroll', () => this.schedule());
    // Bar labels are gated on pixel width, so re-measure when the track resizes
    // (window resize, detail pane collapsing, first layout after unhide).
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => this.schedule()).observe(this.axis);
    }
    container.addEventListener('keydown', (e) => this.onKey(e));
    container.addEventListener('mouseleave', () => this.hideTooltip());
  }

  /** Install a new tree (new session or zoom root). Resets collapse state. */
  setRoot(root: Span, origin: number): void {
    this.root = root;
    this.origin = origin;
    this.collapsed = autoCollapsed(root);
    this.selected = null;
    this.container.scrollTop = 0;
    this.rebuild();
  }

  setWindow(t0: number, t1: number): void {
    this.t0 = t0;
    this.t1 = Math.max(t1, t0 + 1);
    this.renderAxis();
    this.schedule();
  }

  select(span: Span | null, opts: { scroll?: boolean; notify?: boolean } = {}): void {
    this.selected = span;
    if (span !== null) {
      // Expand ancestors so the selection is visible.
      let changed = false;
      for (const r of this.ancestorsOf(span)) {
        if (this.collapsed.delete(r.id)) changed = true;
      }
      if (changed) this.rebuild();
      if (opts.scroll !== false) this.scrollTo(span);
    }
    this.schedule();
    if (opts.notify !== false) this.onSelect(span);
  }

  collapseAll(): void {
    if (this.root === null) return;
    this.collapsed = new Set<string>();
    const walk = (s: Span): void => {
      if (s.children.length > 0 && s !== this.root) this.collapsed.add(s.id);
      for (const c of s.children) walk(c);
    };
    walk(this.root);
    this.rebuild();
  }

  expandAll(): void {
    this.collapsed.clear();
    this.rebuild();
  }

  toggle(span: Span): void {
    if (!this.collapsed.delete(span.id)) this.collapsed.add(span.id);
    this.rebuild();
  }

  rowCount(): number {
    return this.rows.length;
  }

  /** Re-derive rows after the tree changed in place (e.g. a grafted child). */
  refresh(): void {
    this.rebuild();
  }

  private rebuild(): void {
    this.rows = this.root === null ? [] : flattenRows(this.root, this.collapsed);
    this.body.style.height = `${this.rows.length * ROW_HEIGHT}px`;
    this.namesHeader.textContent = `${this.rows.length} span${this.rows.length === 1 ? '' : 's'}`;
    this.schedule();
  }

  private schedule(): void {
    if (this.raf !== 0) return;
    this.raf = window.requestAnimationFrame(() => {
      this.raf = 0;
      this.renderRows();
    });
  }

  private renderAxis(): void {
    this.axis.textContent = '';
    this.grid.textContent = '';
    const span = this.t1 - this.t0;
    const step = tickStep(span);
    const first = Math.ceil((this.t0 - this.origin) / step) * step + this.origin;
    for (let t = first; t <= this.t1; t += step) {
      const x = ((t - this.t0) / span) * 100;
      // The first tick sits on the left edge: left-align it so it isn't clipped.
      const edge = x < 1 ? ' edge' : '';
      this.axis.append(
        el('span', { class: `tick${edge}`, style: `left:${x}%` }, formatDuration(t - this.origin)),
      );
      this.grid.append(el('span', { class: 'gridline', style: `left:${x}%` }));
    }
  }

  private renderRows(): void {
    const viewTop = this.container.scrollTop;
    const viewH = this.container.clientHeight || 400;
    const first = Math.max(0, Math.floor(viewTop / ROW_HEIGHT) - BUFFER_ROWS);
    const last = Math.min(this.rows.length, Math.ceil((viewTop + viewH) / ROW_HEIGHT) + BUFFER_ROWS);
    const frag = document.createDocumentFragment();
    const trackW = this.axis.clientWidth || 600;
    const span = this.t1 - this.t0;
    for (let i = first; i < last; i++) {
      const row = this.rows[i]!;
      frag.append(this.renderRow(row, i, trackW, span));
    }
    this.rowsHost.textContent = '';
    this.rowsHost.append(frag);
  }

  private renderRow(row: TraceRow, index: number, trackW: number, windowMs: number): HTMLElement {
    const { span, depth } = row;
    const a = Math.max(span.startMs, this.t0);
    const b = Math.min(span.endMs, this.t1);
    const leftFrac = (a - this.t0) / windowMs;
    const widthFrac = Math.max(0, (b - a) / windowMs);
    const widthPx = widthFrac * trackW;
    const visible = b >= a;

    const caret = row.hasChildren
      ? el(
          'button',
          {
            class: `caret${this.collapsed.has(span.id) ? ' closed' : ''}`,
            type: 'button',
            title: this.collapsed.has(span.id) ? 'expand' : 'collapse',
            onclick: ((e: Event) => {
              e.stopPropagation();
              this.toggle(span);
            }) as EventListener,
          },
          '▾',
        )
      : el('span', { class: 'caret-spacer' });

    const names = el(
      'div',
      { class: 'trace-names', style: `padding-left:${8 + depth * 14}px` },
      caret,
      el('span', { class: `dot k-${span.kind}` }),
      el('span', { class: 'name', title: span.name }, span.name),
      el('span', { class: 'dur' }, formatDuration(durationMs(span))),
    );

    const bar = el('div', {
      class: `bar k-${span.kind}${span.ok === false ? ' failed' : ''}`,
      style: `left:${leftFrac * 100}%;width:max(2px,${widthFrac * 100}%)`,
    });
    if (!visible) bar.style.display = 'none';
    if (span.kind === 'model' && span.usage !== undefined && widthPx > 64) {
      const u = span.usage;
      const ctx = u.input + u.cacheRead + u.cacheWrite;
      bar.append(
        el('span', { class: 'bar-label' }, `${formatCount(ctx)} ctx · ${formatPct(cacheHitRate(u))}`),
      );
    } else if (span.kind === 'tool' && widthPx > 48 && span.toolInput !== undefined) {
      bar.append(el('span', { class: 'bar-label' }, span.toolInput));
    }

    const rowEl = el(
      'div',
      {
        class: `trace-row${this.selected === span ? ' selected' : ''}`,
        style: `top:${index * ROW_HEIGHT}px`,
        onclick: (() => this.select(span, { scroll: false })) as EventListener,
        ondblclick: (() => this.onZoom(span)) as EventListener,
        onmouseenter: ((e: Event) => this.showTooltip(span, e as MouseEvent)) as EventListener,
        onmousemove: ((e: Event) => this.moveTooltip(e as MouseEvent)) as EventListener,
        onmouseleave: (() => this.hideTooltip()) as EventListener,
      },
      names,
      el('div', { class: 'trace-track' }, bar),
    );
    rowEl.dataset.index = String(index);
    return rowEl;
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (this.rows.length === 0) return;
    e.preventDefault();
    const idx = this.selected === null ? -1 : this.rows.findIndex((r) => r.span === this.selected);
    const next = e.key === 'ArrowDown' ? Math.min(this.rows.length - 1, idx + 1) : Math.max(0, idx - 1);
    this.select(this.rows[next]!.span);
  }

  private scrollTo(span: Span): void {
    const idx = this.rows.findIndex((r) => r.span === span);
    if (idx < 0) return;
    const top = idx * ROW_HEIGHT;
    const headerH = this.header.offsetHeight;
    const viewTop = this.container.scrollTop;
    const viewBottom = viewTop + this.container.clientHeight - headerH;
    if (top < viewTop) this.container.scrollTop = top;
    else if (top + ROW_HEIGHT > viewBottom) {
      this.container.scrollTop = top + ROW_HEIGHT + headerH - this.container.clientHeight;
    }
  }

  private ancestorsOf(target: Span): Span[] {
    if (this.root === null) return [];
    const path: Span[] = [];
    const walk = (s: Span): boolean => {
      if (s === target) return true;
      for (const c of s.children) {
        if (walk(c)) {
          path.push(s);
          return true;
        }
      }
      return false;
    };
    walk(this.root);
    return path;
  }

  private showTooltip(span: Span, e: MouseEvent): void {
    this.tooltip.textContent = tooltipText(span);
    this.tooltip.hidden = false;
    this.moveTooltip(e);
  }

  private moveTooltip(e: MouseEvent): void {
    if (this.tooltip.hidden) return;
    const pad = 14;
    const w = this.tooltip.offsetWidth;
    const h = this.tooltip.offsetHeight;
    let x = e.clientX + pad;
    let y = e.clientY + pad;
    if (x + w > window.innerWidth - 8) x = e.clientX - w - pad;
    if (y + h > window.innerHeight - 8) y = e.clientY - h - pad;
    this.tooltip.style.left = `${Math.max(4, x)}px`;
    this.tooltip.style.top = `${Math.max(4, y)}px`;
  }

  private hideTooltip(): void {
    this.tooltip.hidden = true;
  }
}
