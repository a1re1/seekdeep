// Activity dashboard view: toolbar, headline cards, stacked charts and the
// per-model usage table. Pure rendering — the caller (main.ts) owns the
// aggregation and hands in an Activity plus callbacks for range/rescan.

import type { Activity } from '../stats.ts';
import { formatCount, formatCost, formatPct } from './format.ts';

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

// Ten distinguishable hues, assigned to models in first-seen order.
const PALETTE = [
  '#f97316', '#3b82f6', '#10b981', '#a78bfa', '#f59e0b',
  '#ef4444', '#06b6d4', '#ec4899', '#84cc16', '#8b5cf6',
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
    note.className = 'muted activity-empty';
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
  for (const [value, label] of [
    ['48h', 'past 48 hours'],
    ['7d', 'past 7 days'],
    ['30d', 'past 30 days'],
    ['all', 'all time'],
  ] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.append(option);
  }
  select.value = model.preset;
  select.addEventListener('change', () => actions.onRange(select.value));
  select.disabled = model.progress !== null;

  const rescan = document.createElement('button');
  rescan.id = 'activity-rescan';
  rescan.textContent = 'rescan';
  rescan.addEventListener('click', () => actions.onRescan());

  const toolbar = document.createElement('div');
  toolbar.className = 'toolbar activity-toolbar';
  const head = document.createElement('div');
  head.className = 'activity-head';
  const title = document.createElement('h2');
  title.textContent = 'activity';
  const subtitle = document.createElement('span');
  subtitle.className = 'muted';
  subtitle.textContent = 'your usage across models from ~/.claude and ~/.lci';
  head.append(title, subtitle);
  toolbar.append(head);

  const status = document.createElement('span');
  status.className = 'muted activity-status';
  status.textContent = model.progress ?? '';
  toolbar.append(status, select, rescan);
  return toolbar;
}

// ---- headline cards ----------------------------------------------------------

function buildCards(activity: Activity | null): HTMLElement {
  const row = document.createElement('div');
  row.className = 'stat-row';
  const metrics: Array<{ key: string; label: string; value: string; series: number[]; delta: number; badWhenUp: boolean }> = activity === null
    ? []
    : [
      { key: 'cost', label: 'total spend', value: formatCost(activity.totals.costUsd), series: activity.sparkline.costUsd, delta: activity.delta.costUsd, badWhenUp: true },
      { key: 'requests', label: 'requests', value: formatCount(activity.totals.requests), series: activity.sparkline.requests, delta: activity.delta.requests, badWhenUp: false },
      { key: 'tokens', label: 'token volume', value: formatCount(activity.totals.tokens), series: activity.sparkline.tokens, delta: activity.delta.tokens, badWhenUp: false },
      { key: 'cache', label: 'cache hit rate', value: formatPct(activity.totals.cacheHit), series: activity.sparkline.cacheHit, delta: activity.delta.cacheHit, badWhenUp: false },
      { key: 'blended', label: 'blended $/1M', value: `$${activity.totals.blendedPerM.toFixed(2)}`, series: activity.sparkline.blendedPerM, delta: activity.delta.blendedPerM, badWhenUp: true },
    ];
  for (const m of metrics) {
    const card = document.createElement('div');
    card.className = 'stat-card';
    const label = document.createElement('span');
    label.className = 'stat-label muted';
    label.textContent = m.label;
    const value = document.createElement('span');
    value.className = 'stat-value';
    value.textContent = m.value;
    card.append(label, value, sparkline(m.series));
    const delta = document.createElement('span');
    const good = m.badWhenUp ? m.delta < 0 : m.delta > 0;
    const neutral = !Number.isFinite(m.delta) || m.delta === 0;
    delta.className = neutral ? 'stat-delta' : `stat-delta ${good ? 'good' : 'bad'}`;
    delta.textContent = deltaText(m.delta);
    const vs = document.createElement('span');
    vs.className = 'muted stat-vs';
    vs.textContent = 'vs prev period';
    delta.append(' ', vs);
    card.append(delta);
    row.append(card);
  }
  return row;
}

/** Compact sparkline: a filled area + line over the per-column series. */
function sparkline(series: number[]): SVGElement {
  const svg = svgEl('svg', { class: 'sparkline', viewBox: '0 0 100 24', preserveAspectRatio: 'none' });
  const max = Math.max(...series, 0);
  if (series.length > 1 && max > 0) {
    const pts = series.map((v, i) => `${((i / (series.length - 1)) * 100).toFixed(2)},${(22 - (v / max) * 20).toFixed(2)}`);
    svg.append(
      svgEl('polygon', { points: `0,24 ${pts.join(' ')} 100,24`, class: 'sparkline-area' }),
      svgEl('polyline', { points: pts.join(' '), class: 'sparkline-line' }),
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
      title: 'usage by model ($)',
      unit: '$',
      columns: activity.columns,
      series: modelSeries(activity, (s) => s.costUsd),
    },
    {
      title: 'request volume by model',
      columns: activity.columns,
      series: modelSeries(activity, (s) => s.requests),
    },
    {
      title: 'token breakdown',
      columns: activity.columns,
      series: [
        { key: 'prompt', name: 'prompt', color: '#3b82f6', values: activity.tokens.prompt },
        { key: 'completion', name: 'completion', color: '#10b981', values: activity.tokens.completion },
        { key: 'reasoning', name: 'reasoning', color: '#f59e0b', values: activity.tokens.reasoning },
      ],
    },
    {
      title: 'prompt token caching',
      columns: activity.columns,
      series: [
        { key: 'cached', name: 'cached', color: '#10b981', values: activity.caching.cached },
        { key: 'uncached', name: 'uncached', color: '#f59e0b', values: activity.caching.uncached },
      ],
    },
  ];
  for (const spec of charts) {
    const panel = document.createElement('div');
    panel.className = 'chart-panel';
    const h = document.createElement('h3');
    h.textContent = spec.title;
    panel.append(h, stackedBars(spec.columns, spec.series, { unit: spec.unit, format: spec.unit === '$' ? formatCost : formatCount }), legendRow(spec.series));
    grid.append(panel);
  }
  return grid;
}

/** Per-model cost/requests series, in the activity's model order. */
function modelSeries(
  activity: Activity,
  pick: (series: Activity['series']) => number[][],
): Array<{ key: string; name: string; color: string; values: number[] }> {
  return activity.models.map((model, i) => ({
    key: `${model}:${i}`,
    name: model,
    color: PALETTE[i % PALETTE.length] ?? '#6b7280',
    values: pick(activity.series).map((arr) => arr[i] ?? 0),
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
        fill: s.color,
      });
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
  wrap.className = 'activity-table-wrap';
  if (activity === null) return wrap;
  const table = document.createElement('table');
  table.className = 'activity-table';
  const head = document.createElement('tr');
  for (const label of [
    'model', 'provider', 'requests', 'prompt toks', 'output toks', 'cache hit',
    'avg latency', 'out tok/s', '$/1M in', '$/1M out', 'effective $/1M', 'total cost',
  ]) {
    const th = document.createElement('th');
    th.textContent = label;
    head.append(th);
  }
  table.append(head);
  if (activity.perModel.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 12;
    td.className = 'muted';
    td.textContent = 'no usage in this range';
    tr.append(td);
    table.append(tr);
  }
  for (const row of activity.perModel) {
    const tr = document.createElement('tr');
    for (const cell of [
      row.model,
      row.provider ?? '',
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
      const td = document.createElement('td');
      td.textContent = cell;
      tr.append(td);
    }
    table.append(tr);
  }
  wrap.append(table);
  return wrap;
}

function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '–';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms.toFixed(0)}ms`;
}
