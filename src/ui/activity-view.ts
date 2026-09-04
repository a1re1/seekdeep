// Activity dashboard view: toolbar, headline cards, stacked charts and the
// per-model usage table. Pure rendering — the caller (main.ts) owns the
// aggregation and hands in an Activity plus callbacks for range/rescan.

import type { Activity } from '../stats.ts';
import { formatCount, formatCost, formatPct } from './format.ts';
import { icon } from './icons.ts';

export interface ActivityModel {
  activity: Activity | null;
  /** Progress line shown while transcripts are being read, or null. */
  progress: string | null;
  /** Transcript paths the last collection could not read; the totals omit them. */
  skipped: string[];
  preset: string;
  /** Harnesses present in the data (claude, drip, …); the filter offers All plus each of these. */
  harnesses: string[];
  /** Selected harness, or null for all. */
  harness: string | null;
  /** Shown instead of the dashboard when there is nothing to aggregate. */
  empty: string | null;
}

export interface ActivityActions {
  onRange(preset: string): void;
  onHarness(harness: string | null): void;
  onRescan(): void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// Design-system hues, assigned to models in first-seen order. These are CSS
// variables so they follow the theme; they are applied via inline style
// (presentation attributes cannot carry var()).
const PALETTE = [
  'var(--accent)', 'var(--teal)', 'var(--green)', 'var(--purple)', 'var(--orange)',
  'var(--red)', 'var(--indigo)', 'var(--pink)', 'var(--yellow)',
  'color-mix(in oklch, var(--green) 55%, var(--yellow))',
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function svgEl(tag: string, attrs: Record<string, string | number> = {}): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

export function renderActivity(host: HTMLElement, model: ActivityModel, actions: ActivityActions): void {
  host.replaceChildren();
  host.append(buildToolbar(model, actions));
  if (model.skipped.length > 0 && model.progress === null) host.append(buildSkippedBar(model.skipped));
  if (model.empty !== null) {
    const note = document.createElement('p');
    note.className = 'card activity-empty footnote';
    note.textContent = model.empty;
    host.append(note);
    return;
  }
  host.append(buildCards(model.activity), buildCharts(model.activity), buildTable(model.activity));
}

// ---- toolbar ---------------------------------------------------------------

function buildToolbar(model: ActivityModel, actions: ActivityActions): HTMLElement {
  const select = document.createElement('select');
  select.id = 'activity-range';
  select.className = 'vt-select';
  for (const [value, label] of [
    ['48h', 'Past 48 hours'],
    ['7d', 'Past 7 days'],
    ['30d', 'Past 30 days'],
    ['all', 'All time'],
  ] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.append(option);
  }
  select.value = model.preset;
  select.addEventListener('change', () => actions.onRange(select.value));
  select.disabled = model.progress !== null;
  const selectWrap = document.createElement('span');
  selectWrap.className = 'vt-select-wrap';
  selectWrap.append(select, icon('chevron-down', 12));

  const rescan = document.createElement('button');
  rescan.id = 'activity-rescan';
  rescan.type = 'button';
  rescan.className = 'vt-btn vt-btn--glass';
  rescan.textContent = 'Rescan';
  rescan.disabled = model.progress !== null;
  rescan.addEventListener('click', () => actions.onRescan());

  const toolbar = document.createElement('div');
  toolbar.className = 'page-head activity-toolbar';
  const title = document.createElement('span');
  title.className = 'page-title';
  title.textContent = 'Activity';
  const subtitle = document.createElement('span');
  subtitle.className = 'footnote';
  subtitle.textContent = 'Your usage across models from ~/.claude, ~/.codex, and ~/.drip';
  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  const status = document.createElement('span');
  status.className = 'footnote activity-status';
  status.textContent = model.progress ?? '';
  toolbar.append(title, subtitle, spacer, status);
  if (model.harnesses.length > 0) toolbar.append(harnessSeg(model, actions));
  toolbar.append(selectWrap, rescan);
  return toolbar;
}

/** Small warning that N transcripts were unreadable, so every number below is a floor. */
export function buildSkippedBar(skipped: string[]): HTMLElement {
  const n = skipped.length;
  const bar = document.createElement('div');
  bar.className = 'warn-bar';
  const count = document.createElement('span');
  count.className = 'warn-count';
  count.textContent = `${n} transcript${n === 1 ? '' : 's'} skipped`;
  const text = document.createElement('span');
  text.className = 'warn-text footnote';
  text.title = skipped.join('\n');
  text.textContent = 'could not be read, so the totals are missing their usage · Rescan to retry';
  bar.append(icon('circle-alert', 14), count, text);
  return bar;
}

/** All | claude | drip | … — filters every card, chart and table row by harness. */
function harnessSeg(model: ActivityModel, actions: ActivityActions): HTMLElement {
  const seg = document.createElement('nav');
  seg.className = 'vt-seg';
  seg.id = 'activity-harness';
  seg.setAttribute('aria-label', 'filter by harness');
  const options: Array<[string | null, string]> = [[null, 'All'], ...model.harnesses.map((h): [string, string] => [h, h])];
  for (const [value, label] of options) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.setAttribute('aria-pressed', model.harness === value ? 'true' : 'false');
    button.addEventListener('click', () => actions.onHarness(value));
    seg.append(button);
  }
  return seg;
}

// ---- headline cards ----------------------------------------------------------

function buildCards(activity: Activity | null): HTMLElement {
  const row = document.createElement('div');
  row.className = 'stat-row';
  const metrics: Array<{ key: string; label: string; value: string; series: number[]; delta: number; badWhenUp: boolean }> = activity === null
    ? []
    : [
      { key: 'cost', label: 'Total spend', value: formatCost(activity.totals.costUsd), series: activity.sparkline.costUsd, delta: activity.delta.costUsd, badWhenUp: true },
      { key: 'requests', label: 'Requests', value: formatCount(activity.totals.requests), series: activity.sparkline.requests, delta: activity.delta.requests, badWhenUp: false },
      { key: 'tokens', label: 'Token volume', value: formatCount(activity.totals.tokens), series: activity.sparkline.tokens, delta: activity.delta.tokens, badWhenUp: false },
      { key: 'cache', label: 'Cache hit rate', value: formatPct(activity.totals.cacheHit), series: activity.sparkline.cacheHit, delta: activity.delta.cacheHit, badWhenUp: false },
      { key: 'blended', label: 'Blended $/1M', value: `$${activity.totals.blendedPerM.toFixed(2)}`, series: activity.sparkline.blendedPerM, delta: activity.delta.blendedPerM, badWhenUp: true },
    ];
  for (const m of metrics) {
    const card = document.createElement('div');
    card.className = 'stat-card';
    const label = document.createElement('span');
    label.className = 'stat-k';
    label.textContent = m.label;
    const value = document.createElement('span');
    value.className = 'stat-v';
    value.textContent = m.value;
    const text = document.createElement('div');
    text.className = 'stat-text';
    text.append(label, value);
    const delta = document.createElement('span');
    const good = m.badWhenUp ? m.delta < 0 : m.delta > 0;
    const neutral = !Number.isFinite(m.delta) || m.delta === 0;
    delta.className = neutral ? 'stat-delta' : `stat-delta ${good ? 'good' : 'bad'}`;
    delta.textContent = deltaText(m.delta);
    const vs = document.createElement('span');
    vs.className = 'muted stat-vs';
    vs.textContent = 'vs prev period';
    delta.append(' ', vs);
    text.append(delta);
    card.append(text, sparkline(m.series));
    row.append(card);
  }
  return row;
}

/** Compact sparkline: a filled area + line over the per-column series. */
function sparkline(series: number[]): SVGElement {
  const svg = svgEl('svg', { class: 'sparkline', viewBox: '0 0 100 32', preserveAspectRatio: 'none' });
  const max = Math.max(...series, 0);
  if (series.length > 1 && max > 0) {
    const pts = series.map((v, i) => `${((i / (series.length - 1)) * 100).toFixed(2)},${(30 - (v / max) * 28).toFixed(2)}`);
    svg.append(
      svgEl('polygon', { points: `0,32 ${pts.join(' ')} 100,32`, class: 'sparkline-area' }),
      svgEl('polyline', { points: pts.join(' '), class: 'sparkline-line', 'vector-effect': 'non-scaling-stroke' }),
    );
  }
  return svg;
}

function deltaText(delta: number): string {
  if (!Number.isFinite(delta)) return '–';
  const pct = Math.abs(delta * 100);
  return `${delta >= 0 ? '↑' : '↓'} ${pct >= 100 ? pct.toFixed(0) : pct.toFixed(1)}%`;
}

// ---- charts ------------------------------------------------------------------

interface ChartSpec {
  title: string;
  /** Tick prefix, e.g. '$' for the cost chart. */
  unit?: string;
  columns: number[];
  series: Array<{ key: string; name: string; color: string; values: number[] }>;
}

function buildCharts(activity: Activity | null): HTMLElement {
  const grid = document.createElement('div');
  grid.className = 'chart-grid';
  if (activity === null) return grid;
  const charts: ChartSpec[] = [
    {
      title: 'Usage by model ($)',
      unit: '$',
      columns: activity.columns,
      series: modelSeries(activity, (s) => s.costUsd),
    },
    {
      title: 'Request volume by model',
      columns: activity.columns,
      series: modelSeries(activity, (s) => s.requests),
    },
    {
      title: 'Token breakdown by model',
      columns: activity.columns,
      series: modelSeries(activity, (s) => s.tokens),
    },
    {
      title: 'Token breakdown',
      columns: activity.columns,
      series: [
        { key: 'prompt', name: 'prompt', color: 'var(--accent)', values: activity.tokens.prompt },
        { key: 'completion', name: 'completion', color: 'var(--green)', values: activity.tokens.completion },
        { key: 'reasoning', name: 'reasoning', color: 'var(--orange)', values: activity.tokens.reasoning },
      ],
    },
    {
      title: 'Prompt token caching',
      columns: activity.columns,
      series: [
        { key: 'cached', name: 'cached', color: 'var(--green)', values: activity.caching.cached },
        { key: 'uncached', name: 'uncached', color: 'var(--orange)', values: activity.caching.uncached },
      ],
    },
  ];
  const tip = chartTooltip(grid);
  for (const spec of charts) {
    const panel = document.createElement('div');
    panel.className = 'card chart-panel';
    const h = document.createElement('h3');
    h.textContent = spec.title;
    panel.append(
      h,
      stackedBars(spec.columns, spec.series, { unit: spec.unit, format: spec.unit === '$' ? formatCost : formatCount, tooltip: tip }),
      legendRow(spec.series),
    );
    grid.append(panel);
  }
  // Spend per model: one horizontal bar per model so the ranking reads at a glance.
  const spend = document.createElement('div');
  spend.className = 'card chart-panel';
  const spendTitle = document.createElement('h3');
  spendTitle.textContent = 'Spend per model';
  const colors = new Map(modelSeries(activity, (s) => s.costUsd).map((m) => [m.name, m.color]));
  spend.append(
    spendTitle,
    horizontalBars(
      activity.perModel.map((row) => ({
        name: row.model,
        color: colors.get(row.model) ?? 'var(--text-tertiary)',
        value: row.costUsd,
        detail: `${formatCount(row.requests)} requests · ${formatCount(row.tokens)} tokens`,
      })),
      { format: formatCost, tooltip: tip },
    ),
  );
  grid.append(spend);
  return grid;
}

// ---- hover tooltip -------------------------------------------------------------

export interface ChartTooltip {
  show(lines: string[], e: MouseEvent): void;
  move(e: MouseEvent): void;
  hide(): void;
}

/** One floating tooltip shared by every chart in `host`, positioned near the pointer. */
function chartTooltip(host: HTMLElement): ChartTooltip {
  const node = document.createElement('div');
  node.className = 'tooltip chart-tooltip';
  node.hidden = true;
  host.append(node);
  const move = (e: MouseEvent): void => {
    const pad = 14;
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    let x = e.clientX + pad;
    let y = e.clientY + pad;
    if (x + w > window.innerWidth - 8) x = e.clientX - w - pad;
    if (y + h > window.innerHeight - 8) y = e.clientY - h - pad;
    node.style.left = `${Math.max(4, x)}px`;
    node.style.top = `${Math.max(4, y)}px`;
  };
  return {
    show: (lines, e) => {
      node.replaceChildren();
      lines.forEach((line, i) => {
        const row = document.createElement('div');
        row.className = i === 0 ? 'chart-tooltip-title' : 'chart-tooltip-line';
        row.textContent = line;
        node.append(row);
      });
      node.hidden = false;
      move(e);
    },
    move,
    hide: () => {
      node.hidden = true;
    },
  };
}

function attachHover(target: Element, lines: () => string[], tip: ChartTooltip | undefined): void {
  if (tip === undefined) return;
  target.addEventListener('mouseenter', (e) => tip.show(lines(), e as MouseEvent));
  target.addEventListener('mousemove', (e) => tip.move(e as MouseEvent));
  target.addEventListener('mouseleave', () => tip.hide());
}

/**
 * Horizontal bars, one per row in the given order, label on the left and the
 * formatted value at the bar's end. Builds SVG; no other state.
 */
export function horizontalBars(
  rows: Array<{ name: string; color: string; value: number; detail?: string }>,
  opts: { format?: (v: number) => string; tooltip?: ChartTooltip } = {},
): SVGElement {
  const format = opts.format ?? formatCount;
  const W = 640;
  const ROW = 24;
  const M = { top: 4, right: 64, bottom: 4, left: 168 };
  const H = M.top + M.bottom + Math.max(1, rows.length) * ROW;
  const svg = svgEl('svg', { class: 'chart chart-h', viewBox: `0 0 ${W} ${H}`, width: '100%' });
  if (rows.length === 0) return svg;
  const max = Math.max(...rows.map((r) => r.value), 0) || 1;
  const total = rows.reduce((a, r) => a + r.value, 0);
  const plotW = W - M.left - M.right;
  rows.forEach((row, i) => {
    const y = M.top + i * ROW;
    const w = Math.max(row.value > 0 ? 1 : 0, (row.value / max) * plotW);
    const group = svgEl('g', { class: 'chart-hrow' });
    const label = svgEl('text', { x: M.left - 8, y: y + ROW / 2 + 4, class: 'chart-label chart-hlabel', 'text-anchor': 'end' });
    label.textContent = row.name.length > 26 ? `${row.name.slice(0, 25)}…` : row.name;
    const track = svgEl('rect', { x: M.left, y: y + 5, width: plotW, height: ROW - 10, rx: 4, class: 'chart-htrack' });
    const bar = svgEl('rect', { x: M.left, y: y + 5, width: w, height: ROW - 10, rx: 4 });
    (bar as SVGElement & { style: CSSStyleDeclaration }).style.fill = row.color;
    const value = svgEl('text', { x: M.left + w + 6, y: y + ROW / 2 + 4, class: 'chart-label chart-hvalue' });
    value.textContent = format(row.value);
    group.append(label, track, bar, value);
    attachHover(
      group,
      () => [row.name, `${format(row.value)}${total > 0 ? ` · ${((row.value / total) * 100).toFixed(1)}% of total` : ''}`, ...(row.detail !== undefined ? [row.detail] : [])],
      opts.tooltip,
    );
    svg.append(group);
  });
  return svg;
}

/** Per-model cost/requests series, in the activity's model order. */
export function modelSeries(
  activity: Pick<Activity, 'models' | 'series'>,
  pick: (series: Activity['series']) => number[][],
): Array<{ key: string; name: string; color: string; values: number[] }> {
  const rows = pick(activity.series); // [modelIndex][columnIndex]
  return activity.models.map((model, i) => ({
    key: `${model}:${i}`,
    name: model,
    color: PALETTE[i % PALETTE.length] ?? 'var(--text-tertiary)',
    values: rows[i] ?? [],
  }));
}

/**
 * One bar per column, stacked bottom-up in series order. Builds DOM (SVG),
 * so it needs a document; it has no other state.
 */
export function stackedBars(
  columns: number[],
  seriesByKey: Array<{ key: string; name: string; color: string; values: number[] }>,
  opts: { unit?: string; format?: (v: number) => string; tooltip?: ChartTooltip } = {},
): SVGElement {
  const format = opts.format ?? formatCount;
  const W = 640;
  const H = 200;
  const M = { top: 8, right: 8, bottom: 20, left: 44 };
  const svg = svgEl('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, width: '100%' });
  if (columns.length === 0) return svg;
  const peak = Math.max(...columns.map((_, i) => seriesByKey.reduce((acc, s) => acc + (s.values[i] ?? 0), 0)), 0);
  const max = peak > 0 ? peak : 1; // an empty range still draws a sane axis
  const plotH = H - M.top - M.bottom;
  const plotW = W - M.left - M.right;
  const slot = plotW / Math.max(columns.length, 1);
  const barW = Math.max(1, Math.min(slot * 0.8, 40));
  const unit = opts.unit ?? '';

  for (const t of niceTicks(max)) {
    const y = H - M.bottom - (t / max) * plotH;
    svg.append(svgEl('line', { x1: M.left, x2: W - M.right, y1: y, y2: y, class: 'chart-gridline' }));
    const label = svgEl('text', { x: M.left - 6, y: y + 4, class: 'chart-label', 'text-anchor': 'end' });
    label.textContent = formatTick(t, max, unit);
    svg.append(label);
  }

  const step = Math.max(1, Math.ceil(columns.length / 7));
  for (let i = 0; i < columns.length; i += step) {
    const label = svgEl('text', {
      x: M.left + i * slot + slot / 2,
      y: H - M.bottom + 14,
      class: 'chart-label',
      'text-anchor': 'middle',
    });
    label.textContent = axisLabel(columns, i);
    svg.append(label);
  }

  columns.forEach((_, i) => {
    let y = H - M.bottom;
    const columnTotal = seriesByKey.reduce((acc, s) => acc + (s.values[i] ?? 0), 0);
    for (const s of seriesByKey) {
      const v = s.values[i] ?? 0;
      if (v <= 0) continue;
      const h = (v / max) * plotH;
      y -= h;
      const rect = svgEl('rect', {
        x: M.left + i * slot + (slot - barW) / 2,
        y,
        width: barW,
        height: Math.max(h, 0.5),
        rx: 2,
      });
      (rect as SVGElement & { style: CSSStyleDeclaration }).style.fill = s.color;
      rect.setAttribute('aria-label', `${axisLabel(columns, i)} · ${s.name}: ${format(v)}`);
      attachHover(
        rect,
        () => [
          s.name,
          `${format(v)}${columnTotal > 0 ? ` · ${((v / columnTotal) * 100).toFixed(1)}% of ${format(columnTotal)}` : ''}`,
          axisLabel(columns, i),
        ],
        opts.tooltip,
      );
      svg.append(rect);
    }
  });
  return svg;
}

function legendRow(series: Array<{ key: string; name: string; color: string }>): HTMLElement {
  const row = document.createElement('div');
  row.className = 'chart-legend';
  for (const s of series) {
    const item = document.createElement('span');
    item.className = 'legend-item';
    const swatch = document.createElement('span');
    swatch.className = 'legend-swatch';
    swatch.style.background = s.color;
    item.append(swatch, document.createTextNode(s.name));
    row.append(item);
  }
  return row;
}

function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  return ticks;
}

function formatTick(v: number, top: number, unit: string): string {
  if (top >= 1_000_000) return `${unit}${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`;
  if (top >= 10_000) return `${unit}${(v / 1_000).toFixed(v % 1_000 === 0 ? 0 : 1)}K`;
  if (top >= 1) return `${unit}${Number.isInteger(v) ? String(v) : v.toFixed(1)}`;
  return `${unit}${v.toFixed(2)}`;
}

function axisLabel(columns: number[], i: number): string {
  const t = columns[i] ?? 0;
  const prev = i > 0 ? columns[i - 1] : undefined;
  const d = new Date(t);
  const hourly = prev !== undefined && t - prev < 20 * 3_600_000;
  return hourly
    ? `${MONTHS[d.getMonth()]} ${d.getDate()}, ${String(d.getHours()).padStart(2, '0')}:00`
    : `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

// ---- per-model table ----------------------------------------------------------

function buildTable(activity: Activity | null): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'card activity-table-wrap';
  if (activity === null) return wrap;
  const table = document.createElement('div');
  table.className = 'activity-table';
  const head = document.createElement('div');
  head.className = 'activity-row activity-row--head';
  for (const label of [
    'Model', 'Provider', 'Requests', 'Prompt', 'Output', 'Cache hit',
    'Latency', 'Tok/s', '$/1M in', '$/1M out', 'Eff. $/1M', 'Cost',
  ]) {
    const th = document.createElement('span');
    th.className = 'section-cap';
    th.textContent = label;
    head.append(th);
  }
  table.append(head);
  if (activity.perModel.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'activity-empty footnote';
    empty.textContent = 'No usage in this range.';
    table.append(empty);
  }
  activity.perModel.forEach((row, i) => {
    const tr = document.createElement('div');
    tr.className = 'activity-row footnote tabular';
    const name = document.createElement('span');
    name.className = 'activity-model';
    const swatch = document.createElement('span');
    swatch.className = 'legend-swatch';
    swatch.style.background = PALETTE[activity.models.indexOf(row.model) % PALETTE.length] ?? PALETTE[i % PALETTE.length] ?? '';
    const label = document.createElement('span');
    label.className = 'mono';
    label.textContent = row.model;
    label.title = row.model;
    name.append(swatch, label);
    tr.append(name);
    for (const cell of [
      row.provider ?? '—',
      formatCount(row.requests),
      formatCount(row.promptTokens),
      formatCount(row.outputTokens),
      formatPct(row.cacheHit),
      formatLatency(row.avgLatencyMs),
      row.outputTokSec.toFixed(1),
      `$${row.inputPrice.toFixed(2)}`,
      `$${row.outputPrice.toFixed(2)}`,
      `$${row.effectivePerM.toFixed(2)}`,
      formatCost(row.costUsd),
    ]) {
      const td = document.createElement('span');
      td.textContent = cell;
      tr.append(td);
    }
    table.append(tr);
  });
  wrap.append(table);
  return wrap;
}

function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '–';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms.toFixed(0)}ms`;
}
