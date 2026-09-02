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
  preset: string;
  /** Shown instead of the dashboard when there is nothing to aggregate. */
  empty: string | null;
}

export interface ActivityActions {
  onRange(preset: string): void;
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
  subtitle.textContent = 'Your usage across models from ~/.claude and ~/.lci';
  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  const status = document.createElement('span');
  status.className = 'footnote activity-status';
  status.textContent = model.progress ?? '';
  toolbar.append(title, subtitle, spacer, status, selectWrap, rescan);
  return toolbar;
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
  for (const spec of charts) {
    const panel = document.createElement('div');
    panel.className = 'card chart-panel';
    const h = document.createElement('h3');
    h.textContent = spec.title;
    panel.append(h, stackedBars(spec.columns, spec.series, { unit: spec.unit, format: spec.unit === '$' ? formatCost : formatCount }), legendRow(spec.series));
    grid.append(panel);
  }
  return grid;
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
  opts: { unit?: string; format?: (v: number) => string } = {},
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
      const title = document.createElementNS(SVG_NS, 'title');
      title.textContent = `${axisLabel(columns, i)} · ${s.name}: ${format(v)}`;
      rect.append(title);
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
