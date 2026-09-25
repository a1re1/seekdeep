// Activity dashboard view: toolbar, headline cards, stacked charts and the
// per-model usage table. Pure rendering — the caller (main.ts) owns the
// aggregation and hands in an Activity plus callbacks for range/rescan.

import type { Activity, Range as ActivityRange, RangePreset, UsageBucket } from '../stats.ts';
import { RANGE_PRESETS } from '../stats.ts';
import { costOf } from '../pricing.ts';
import type { PricingTable } from '../pricing.ts';
import { formatCount, formatCost, formatDuration, formatPct } from './format.ts';
import { icon } from './icons.ts';

export interface ActivityModel {
  activity: Activity | null;
  /** Progress line shown while transcripts are being read, or null. */
  progress: string | null;
  /** Transcript paths the last collection could not read; the totals omit them. */
  skipped: string[];
  preset: RangePreset;
  /** Harnesses present in the data (claude, drip, …); the filter offers these plus an All option. */
  harnesses: string[];
  /** Selected harnesses, or null for every harness. */
  harness: string[] | null;
  /** Whether the harness checklist is expanded. */
  harnessOpen: boolean;
  /** Shown instead of the dashboard when there is nothing to aggregate. */
  empty: string | null;
  /** Harness-filtered buckets, carrying session identity/duration for the new panels. */
  sessionBuckets: UsageBucket[];
  /** Pricing table the session panels price bucket spend with. */
  pricing: PricingTable;
  /**
   * Optional sessionId → title map (indexed entries and `upload:<id>` sessions)
   * so legend keys show a session name or first-user-message preview instead of
   * a bare file stem. Absent map = stable-id labels.
   */
  sessionTitles?: Readonly<Record<string, string>>;
}

// ---- legend interaction (pure; no DOM) ------------------------------------

/** Which keys a chart legend hides: one isolated key, or a set of muted keys. */
export interface LegendState {
  isolated: string | null;
  hidden: string[];
}

/** Longest session preview a legend key shows before the ellipsis. */
export const SESSION_LABEL_MAX = 48;

const GENERIC_SESSION_LABELS = new Set(['transcript', 'session', 'conversation', 'chat', 'unknown', 'untitled']);

/** Show-everything legend state — the reset target. */
export function resetLegend(): LegendState {
  return { isolated: null, hidden: [] };
}

/** Whether `key`'s series is drawn under `state`. */
export function legendVisible(state: LegendState, key: string): boolean {
  if (state.isolated !== null) return state.isolated === key;
  return !state.hidden.includes(key);
}

/** Whether `state` filters anything out at all (drives the reset affordance). */
export function legendFiltered(state: LegendState): boolean {
  return state.isolated !== null || state.hidden.length > 0;
}

/** How many of `keys` the state hides (the "n hidden" affordance). */
export function legendHiddenCount(state: LegendState, keys: readonly string[]): number {
  return keys.reduce((n, key) => (legendVisible(state, key) ? n : n + 1), 0);
}

/**
 * Legend-click reducer. A plain click (`exclusive`) isolates one key, and
 * clicking the isolated key again (or reset) shows all. Shift-click hides just
 * that key and clicking it again restores it. Hiding the LAST visible key would
 * blank the chart, so it falls back to show-all rather than an empty plot.
 */
export function toggleLegend(
  state: LegendState,
  key: string,
  opts: { exclusive?: boolean; keys?: readonly string[] } = {},
): LegendState {
  // A key the legend does not carry has no series to isolate or hide: ignoring
  // it keeps the "n hidden" affordance from counting a key that is not drawn.
  if (opts.keys !== undefined && !opts.keys.includes(key)) return state;
  if (opts.exclusive === true) {
    return state.isolated === key ? resetLegend() : { isolated: key, hidden: [] };
  }
  // Shift-click hides one key. While another key is isolated the isolation
  // still wins for every key, so a plain hide would look dead — leaving
  // isolation first keeps the whole legend reachable from either gesture.
  const base = state.isolated === null ? state : resetLegend();
  const hidden = base.hidden.includes(key) ? base.hidden.filter((k) => k !== key) : [...base.hidden, key];
  const next: LegendState = { isolated: base.isolated, hidden };
  if (opts.keys !== undefined && legendHiddenCount(next, opts.keys) >= opts.keys.length) return resetLegend();
  return next;
}

/** The series a chart draws under `state`; an empty result falls back to all. */
export function visibleLegendSeries<T extends { key: string }>(state: LegendState, series: readonly T[]): T[] {
  const visible = series.filter((s) => legendVisible(state, s.key));
  return visible.length === 0 ? [...series] : visible;
}

/** Full, untruncated legend text: the mapped title when meaningful, else the id. */
export function sessionHoverLabel(sessionId: string, titles?: Readonly<Record<string, string>>): string {
  const raw = titles?.[sessionId];
  const text = raw === undefined ? '' : raw.replace(/\s+/g, ' ').trim();
  if (text.length > 0 && !GENERIC_SESSION_LABELS.has(text.toLowerCase())) return text;
  return sessionId;
}

/**
 * Legend key for a session: the session's title / first user message clamped to
 * a brief preview, else the stable session id — never a bare `transcript` stem.
 * The untruncated text stays available through `sessionHoverLabel` for hover.
 */
export function sessionDisplayLabel(sessionId: string, titles?: Readonly<Record<string, string>>): string {
  const raw = titles?.[sessionId];
  const text = raw === undefined ? '' : raw.replace(/\s+/g, ' ').trim();
  // No meaningful title: the id IS the anchor, so it is never truncated.
  if (text.length === 0 || GENERIC_SESSION_LABELS.has(text.toLowerCase())) return sessionId;
  return text.length <= SESSION_LABEL_MAX ? text : `${text.slice(0, SESSION_LABEL_MAX - 1)}…`;
}

export interface ActivityActions {
  onRange(preset: RangePreset): void;
  onHarness(harness: string[] | null): void;
  onHarnessOpen(open: boolean): void;
  onRescan(): void;
  /** Drill into one session segment; carries that session's stable id. */
  onOpenSession(sessionId: string): void;
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

let clearHarnessDismiss: (() => void) | null = null;

/** Remove document-level listeners when the activity view is hidden. */
export function cleanupActivityView(): void {
  clearHarnessDismiss?.();
  clearHarnessDismiss = null;
}

function svgEl(tag: string, attrs: Record<string, string | number> = {}): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

export function renderActivity(host: HTMLElement, model: ActivityModel, actions: ActivityActions): void {
  cleanupActivityView();
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
  host.append(buildCards(model.activity), buildCharts(model.activity, model, actions), buildTable(model.activity));
}

// ---- toolbar ---------------------------------------------------------------

function buildToolbar(model: ActivityModel, actions: ActivityActions): HTMLElement {
  const select = document.createElement('select');
  select.id = 'activity-range';
  select.className = 'vt-select';
  for (const [value, label] of RANGE_PRESETS) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.append(option);
  }
  select.value = model.preset;
  select.addEventListener('change', () => actions.onRange(select.value as RangePreset));
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
  if (model.harnesses.length > 0) toolbar.append(harnessPick(model, actions));
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

/** Filters every card, chart and table row by harness: a compact multi-select checklist. */
function harnessPick(model: ActivityModel, actions: ActivityActions): HTMLElement {
  const selected = model.harness;
  const pick = document.createElement('div');
  pick.className = 'vt-multiselect';
  pick.id = 'activity-harness';
  const summary = harnessTriggerLabel(selected, model.harnesses);
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'vt-btn vt-btn--glass vt-multiselect__trigger';
  trigger.id = 'activity-harness-trigger';
  trigger.setAttribute('aria-expanded', model.harnessOpen ? 'true' : 'false');
  trigger.setAttribute('aria-controls', 'activity-harness-menu');
  trigger.setAttribute('aria-label', `filter by harness: ${summary.toLowerCase()}`);
  trigger.append(
    Object.assign(document.createElement('span'), { className: 'vt-multiselect__label', textContent: summary }),
    icon('chevron-down', 12),
  );
  const menu = document.createElement('div');
  menu.className = 'vt-multiselect__menu';
  menu.id = 'activity-harness-menu';
  menu.setAttribute('role', 'group');
  menu.setAttribute('aria-label', 'filter by harness');
  menu.hidden = !model.harnessOpen;
  trigger.addEventListener('click', () => {
    actions.onHarnessOpen(!model.harnessOpen);
    document.getElementById('activity-harness-trigger')?.focus();
  });
  // Master option: resets to every harness (selection null). Keyboard-operable
  // pressed button so the “all” state is announced like the checkboxes below.
  const all = document.createElement('button');
  all.type = 'button';
  all.id = 'activity-harness-all';
  all.className = 'vt-multiselect__option vt-multiselect__option--master';
  all.setAttribute('aria-pressed', selected === null ? 'true' : 'false');
  const mark = document.createElement('span');
  mark.className = 'vt-multiselect__check';
  mark.textContent = '✓';
  const allLabel = document.createElement('span');
  allLabel.className = 'vt-multiselect__option-label';
  allLabel.textContent = 'All harnesses';
  all.append(mark, allLabel);
  all.addEventListener('click', () => {
    actions.onHarness(null);
    document.getElementById('activity-harness-all')?.focus();
  });
  menu.append(all);
  // One checkbox per harness; native inputs keep tab/space and screen-reader
  // semantics working without custom key handling. Selection applies at once.
  for (const h of model.harnesses) {
    const opt = document.createElement('label');
    opt.className = 'vt-multiselect__option';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'vt-multiselect__box';
    box.value = h;
    box.checked = selected === null || selected.includes(h);
    const label = document.createElement('span');
    label.className = 'vt-multiselect__option-label';
    label.textContent = h;
    opt.append(box, label);
    box.addEventListener('change', () => {
      actions.onHarness(toggleHarness(selected, h, model.harnesses));
      for (const next of document.querySelectorAll<HTMLInputElement>('#activity-harness .vt-multiselect__box')) {
        if (next.value === h) {
          next.focus();
          break;
        }
      }
    });
    menu.append(opt);
  }
  pick.append(trigger, menu);
  if (model.harnessOpen) {
    const dismissOutside = (event: PointerEvent): void => {
      if (!(event.target instanceof Node) || !pick.contains(event.target)) actions.onHarnessOpen(false);
    };
    const dismissOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      actions.onHarnessOpen(false);
      document.getElementById('activity-harness-trigger')?.focus();
    };
    document.addEventListener('pointerdown', dismissOutside, true);
    document.addEventListener('keydown', dismissOnEscape);
    clearHarnessDismiss = () => {
      document.removeEventListener('pointerdown', dismissOutside, true);
      document.removeEventListener('keydown', dismissOnEscape);
    };
  }
  return pick;
}

/** “All harnesses” | one name | “N harnesses” | “None”. */
export function harnessTriggerLabel(selected: string[] | null, available: string[]): string {
  if (selected === null || selected.length === available.length) return 'All harnesses';
  if (selected.length === 0) return 'No harnesses';
  if (selected.length === 1) return selected[0] ?? '';
  return `${selected.length} harnesses`;
}

/**
 * Toggle one harness in a selection, treating null as “every harness” and
 * normalizing empty/full selections back to null (all).
 */
export function toggleHarness(selected: string[] | null, harness: string, available: string[]): string[] | null {
  if (selected === null) return available.length <= 1 ? null : available.filter((h) => h !== harness);
  const has = selected.includes(harness);
  const next = has ? selected.filter((h) => h !== harness) : [...selected, harness];
  return next.length === 0 || next.length === available.length ? null : next;
}

/** OR filter: null (all) matches every bucket; otherwise the bucket’s harness must be picked. Buckets without a harness count as “other”. */
export function harnessMatches(selected: string[] | null, bucketHarness: string | undefined): boolean {
  return selected === null || selected.includes(bucketHarness ?? 'other');
}

/**
 * Reconcile a selection with the harnesses now present in the data: null stays
 * null (all, so newly discovered harnesses are included), stale names are
 * dropped, and a selection that ends up covering every harness collapses to
 * null. Selection order is normalized to the available order.
 */
export function reconcileHarnessSelection(selected: string[] | null, available: string[]): string[] | null {
  if (selected === null || available.length === 0) return null;
  const kept = available.filter((h) => selected.includes(h));
  return kept.length === 0 || kept.length === available.length ? null : kept;
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

function buildCharts(activity: Activity | null, model: ActivityModel, actions: ActivityActions): HTMLElement {
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
    const plot = document.createElement('div');
    plot.className = 'chart-plot';
    let state: LegendState = resetLegend();
    // The chart is redrawn from the VISIBLE series, so the stack, the axis peak,
    // tooltips and percentage math all drop hidden keys together.
    const redraw = (): void => {
      plot.replaceChildren(
        stackedBars(spec.columns, visibleLegendSeries(state, spec.series), {
          unit: spec.unit,
          format: spec.unit === '$' ? formatCost : formatCount,
          tooltip: tip,
        }),
        legendRow(spec.series, state, (next) => {
          state = next;
          redraw();
        }),
      );
    };
    redraw();
    panel.append(h, plot);
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
  grid.append(spend, sessionSpendPanel(activity, model, actions, tip), sessionDurationPanel(activity, model));
  return grid;
}

/**
 * Spend by session: one stacked column per range column (the SAME columns
 * aggregate() produced), one segment per session present in that bucket,
 * priced with the buckets' own table so a column's segments sum back to it.
 * Every segment drills into its session (click, Enter or Space).
 */
function sessionSpendPanel(
  activity: Activity,
  model: ActivityModel,
  actions: ActivityActions,
  tip: ChartTooltip,
): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'card chart-panel';
  const h = document.createElement('h3');
  h.textContent = 'Spend by session';
  const stack = sessionSpendStack(activity.columns, model.sessionBuckets, (b) => bucketSpend(b, model.pricing), activity.range);
  const series = stack.sessions.map((id, row) => ({
    key: id,
    name: sessionDisplayLabel(id, model.sessionTitles), hover: sessionHoverLabel(id, model.sessionTitles),
    color: sessionColorFor(id, PALETTE),
    values: stack.values[row] ?? [],
  }));
  // Same interactive legend contract as the model charts: plain click isolates
  // one session, shift-click hides just it, Escape / the reset pill shows all,
  // and every redraw keeps each segment's drill-down into its session.
  const plot = document.createElement('div');
  plot.className = 'chart-plot';
  let state: LegendState = resetLegend();
  const redraw = (): void => {
    const visible = visibleLegendSeries(state, series);
    plot.replaceChildren(
      stackedBars(activity.columns, visible, {
        unit: '$',
        format: formatCost,
        tooltip: tip,
        activatable: {
          label: (key, col) => {
            const s = visible.find((x) => x.key === key);
            return `${s?.name ?? key} · ${formatCost(s?.values[col] ?? 0)} · ${axisLabel(activity.columns, col)}`;
          },
          activate: (key) => actions.onOpenSession(key),
        },
      }),
      legendRow(series, state, (next) => {
        state = next;
        redraw();
      }),
    );
  };
  redraw();
  panel.append(h, plot);
  return panel;
}

/**
 * Average session duration: the mean ELAPSED time of the sessions that STARTED
 * in each column (first span start .. last span end, idle gaps included) — an
 * explicit elapsed-time proxy, never a claim about PR completion. Columns with
 * no measurable session show an en dash rather than a zero bar.
 */
function sessionDurationPanel(activity: Activity, model: ActivityModel): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'card chart-panel';
  const h = document.createElement('h3');
  h.textContent = 'Average session duration';
  const cohorts = durationCohorts(activity.columns, model.sessionBuckets, activity.range);
  const headline = document.createElement('div');
  headline.className = 'chart-headline';
  headline.textContent = cohorts.overallMs === null
    ? 'Overall mean: no measurable sessions in this range'
    : `Overall mean (${formatCount(cohorts.counted)} session${cohorts.counted === 1 ? '' : 's'}): ${formatDuration(cohorts.overallMs)}`;
  const sub = document.createElement('p');
  sub.className = 'footnote chart-sub';
  sub.textContent =
    'Mean elapsed time (first span start to last span end, idle gaps included) of the sessions that STARTED in each column. Only sessions whose start falls inside the selected range are counted. This is a wall-clock proxy measured from the transcripts: a session left open shows the whole gap, and time after its last recorded activity is not counted — it is not time to a merged PR. The y-axis is labeled in human-readable durations (seconds, minutes, hours).'
    + (cohorts.excluded > 0
      ? ` ${formatCount(cohorts.excluded)} session${cohorts.excluded === 1 ? '' : 's'} excluded for having no measurable duration.`
      : '');
  panel.append(h, headline, sub, durationBars(activity.columns, cohorts.perColumn));
  return panel;
}

/**
 * Y-axis label for a duration axis: never a raw millisecond count, always the
 * human-readable minute/hour form (`45.0 s`, `12m 30s`, `1h 0m`).
 */
export function durationTickLabel(ms: number): string {
  return formatDuration(ms);
}

/**
 * Tick values for a duration axis, stepped from human units (seconds, minutes,
 * hours, days) so gridlines land on readable durations — 30m, 1h, 2h — rather
 * than raw millisecond magnitudes such as 3.6M. The last tick is at or above
 * `maxMs` so the axis always covers the data.
 */
export function niceDurationTicks(maxMs: number): number[] {
  if (!Number.isFinite(maxMs) || maxMs <= 0) return [0, 1_000];
  const MINUTE = 60_000;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  const steps = [
    1_000, 5_000, 10_000, 15_000, 30_000,
    MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE,
    HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR,
    DAY, 2 * DAY, 7 * DAY,
  ];
  const target = maxMs / 4;
  let step = steps[steps.length - 1] ?? 1_000;
  for (const s of steps) {
    if (s >= target) {
      step = s;
      break;
    }
  }
  const ticks: number[] = [];
  for (let v = 0; v <= maxMs + step * 0.001; v += step) ticks.push(v);
  return ticks;
}

/** One bar per column's mean duration; a column with no measurable session shows an en dash. */
function durationBars(columns: number[], perColumn: Array<number | null>): SVGElement {
  const W = 640;
  const H = 170;
  const M = { top: 16, right: 8, bottom: 20, left: 62 };
  const svg = svgEl('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, width: '100%' });
  if (columns.length === 0) return svg;
  const plotH = H - M.top - M.bottom;
  const plotW = W - M.left - M.right;
  const slot = plotW / Math.max(columns.length, 1);
  const barW = Math.max(1, Math.min(slot * 0.8, 40));
  const max = Math.max(...perColumn.map((v) => v ?? 0), 0) || 1;
  for (const t of niceDurationTicks(max)) {
    const y = H - M.bottom - (t / max) * plotH;
    svg.append(svgEl('line', { x1: M.left, x2: W - M.right, y1: y, y2: y, class: 'chart-gridline' }));
    const label = svgEl('text', { x: M.left - 6, y: y + 4, class: 'chart-label', 'text-anchor': 'end' });
    label.textContent = durationTickLabel(t);
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
    const v = perColumn[i];
    const x = M.left + i * slot + (slot - barW) / 2;
    if (v === null || v === undefined || !(v > 0)) {
      // No measurable session started here: an explicit marker, never a zero bar.
      const mark = svgEl('text', { x: x + barW / 2, y: H - M.bottom - 4, class: 'chart-label', 'text-anchor': 'middle' });
      mark.textContent = '–';
      svg.append(mark);
      return;
    }
    const h = (v / max) * plotH;
    const rect = svgEl('rect', {
      x,
      y: H - M.bottom - h,
      width: barW,
      height: Math.max(h, 0.5),
      rx: 2,
      'aria-label': `${axisLabel(columns, i)} · mean ${formatDuration(v)}`,
    });
    (rect as SVGElement & { style: CSSStyleDeclaration }).style.fill = 'var(--accent)';
    svg.append(rect);
  });
  return svg;
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
  opts: {
    unit?: string;
    format?: (v: number) => string;
    tooltip?: ChartTooltip;
    /** When set, every segment also becomes a clickable, keyboard-reachable button. */
    activatable?: { label: (seriesKey: string, column: number) => string; activate: (seriesKey: string, column: number) => void };
  } = {},
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
      const act = opts.activatable;
      if (act !== undefined) {
        rect.setAttribute('tabindex', '0');
        rect.setAttribute('role', 'button');
        rect.setAttribute('aria-label', act.label(s.key, i));
        rect.addEventListener('click', () => act.activate(s.key, i));
        rect.addEventListener('keydown', (e) => {
          const key = (e as KeyboardEvent).key;
          if (key === 'Enter' || key === ' ') {
            e.preventDefault();
            act.activate(s.key, i);
          }
        });
      }
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

/**
 * Interactive legend: each key is a focusable button. Plain click/Enter/Space
 * isolates the key, Shift+click/Shift+Enter/Space hides just it, Escape (and
 * the reset affordance) shows all. `hover` carries the untruncated label.
 */
function legendRow(
  series: Array<{ key: string; name: string; color: string; hover?: string }>,
  state: LegendState = resetLegend(),
  onChange?: (next: LegendState) => void,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'chart-legend';
  const keys = series.map((s) => s.key);
  for (const s of series) {
    const visible = legendVisible(state, s.key);
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'legend-item';
    if (!visible) item.classList.add('legend-item--muted');
    if (state.isolated === s.key) item.classList.add('legend-item--isolated');
    item.setAttribute('aria-pressed', String(visible));
    item.title = `${s.hover ?? s.name} — click to isolate, shift-click to hide`;
    const swatch = document.createElement('span');
    swatch.className = 'legend-swatch';
    swatch.style.background = s.color;
    const label = document.createElement('span');
    label.className = 'legend-label';
    label.textContent = s.name;
    item.append(swatch, label);
    if (onChange !== undefined) {
      const commit = (exclusive: boolean): void => onChange(toggleLegend(state, s.key, { exclusive, keys }));
      item.addEventListener('click', (e) => commit(!(e as MouseEvent).shiftKey));
      item.addEventListener('keydown', (e) => {
        const key = (e as KeyboardEvent).key;
        if (key === 'Enter' || key === ' ') {
          e.preventDefault();
          commit(!(e as KeyboardEvent).shiftKey);
        }
      });
    }
    row.append(item);
  }
  if (onChange !== undefined) {
    // Esc restores every key from anywhere inside the legend — a key or the
    // reset pill — and stays scoped to this chart so it cannot steal Escape.
    row.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key !== 'Escape') return;
      e.preventDefault();
      onChange(resetLegend());
    });
  }
  if (onChange !== undefined && legendFiltered(state)) {
    const hidden = legendHiddenCount(state, keys);
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'legend-reset';
    reset.textContent = hidden > 0 ? `${hidden} hidden · show all` : 'show all';
    reset.title = 'Show every series (Esc)';
    reset.addEventListener('click', () => onChange(resetLegend()));
    row.append(reset);
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

// ---- session drill-down: pure helpers --------------------------------------
// Session spend stacking and duration cohorts are pure over buckets so tests can
// call them directly; the renderer only wires them to the existing charts.

/**
 * Column index of `ts` in `columns` (the range's columns from aggregate()):
 * an exact match when there is one, otherwise the latest column at or before
 * it, and -1 when the timestamp precedes the whole window.
 */
export function columnFor(columns: number[], ts: number): number {
  let found = -1;
  for (let i = 0; i < columns.length; i += 1) {
    const c = columns[i];
    if (c === undefined) continue;
    if (c <= ts) found = i;
    else break;
  }
  return found;
}

/**
 * Stable colour for a session, drawn from the same palette the model series
 * use: the same session id always maps to the same swatch, in every column.
 */
export function sessionColorFor(sessionId: string, palette: readonly string[]): string {
  if (palette.length === 0) return 'currentColor';
  let h = 0;
  for (let i = 0; i < sessionId.length; i += 1) h = (h * 31 + sessionId.charCodeAt(i)) >>> 0;
  return palette[h % palette.length] ?? palette[0]!;
}

/** Short display label for a source-qualified session id (`claude:<path>` → file stem). */
export function sessionLabel(sessionId: string): string {
  const sep = sessionId.indexOf(':');
  const rest = sep >= 0 ? sessionId.slice(sep + 1) : sessionId;
  const parts = rest.split('/');
  const last = parts[parts.length - 1] ?? rest;
  const stem = last.replace(/\.(jsonl|json|db)$/i, '');
  return stem !== '' ? stem : rest !== '' ? rest : sessionId;
}

/** Priced spend of one bucket, priced exactly the way aggregate() prices it. */
export function bucketSpend(b: UsageBucket, pricing: PricingTable): number {
  return costOf(
    {
      input: b.input,
      cacheRead: b.cacheRead,
      cacheWrite: b.cacheWrite,
      cacheWrite5m: b.cacheWrite5m ?? 0,
      cacheWrite1h: b.cacheWrite1h ?? 0,
      output: b.output,
      reasoning: b.reasoning,
    },
    b.model,
    pricing,
    b.requests,
  );
}

/** Per-session priced spend per column: values[sessionIndex][column]. */
export interface SessionSpendStack {
  /** Session ids in first-seen order — a stable legend order. */
  sessions: string[];
  /** Priced spend per session and column (sessions absent from a bucket add 0). */
  values: number[][];
  /** Column totals: the sum of that column's session segments. */
  totals: number[];
}

/**
 * True when `ts` falls inside `range`, in one of `columns`. `range` is the
 * window aggregate() drops buckets by and `columns` are that window's own
 * columns, so a timestamp at or past the range end has NO column: columnFor
 * alone would clamp it into the last one, inflating that column with spend (or
 * a duration) the range does not contain.
 */
function columnInRange(columns: number[], range: ActivityRange, ts: number): boolean {
  if (!Number.isFinite(ts)) return false;
  if (ts < range.startMs || ts >= range.endMs) return false;
  return columnFor(columns, ts) >= 0;
}

/**
 * Stack one segment per session in each of the range's own columns. Column
 * total equals the priced spend recorded in that bucket, so the segments of a
 * column sum back to the bucket's spend — and never beyond it: a bucket
 * outside `range` (a future-dated timestamp, say) belongs to no column and is
 * dropped exactly as aggregate() drops it. Buckets without a sessionId are
 * ignored (they carry no identity to drill into).
 */
export function sessionSpendStack(
  columns: number[],
  buckets: UsageBucket[],
  priceOf: (bucket: UsageBucket) => number,
  range: ActivityRange,
): SessionSpendStack {
  const index = new Map<string, number>();
  const values: number[][] = [];
  const totals = columns.map(() => 0);
  for (const b of buckets) {
    const id = b.sessionId;
    if (id === undefined) continue;
    if (!columnInRange(columns, range, b.hourMs)) continue;
    const col = columnFor(columns, b.hourMs);
    let row = index.get(id);
    if (row === undefined) {
      row = values.length;
      index.set(id, row);
      values.push(columns.map(() => 0));
    }
    const spend = priceOf(b);
    const line = values[row]!;
    line[col] = (line[col] ?? 0) + spend;
    totals[col] = (totals[col] ?? 0) + spend;
  }
  return { sessions: [...index.keys()], values, totals };
}

/** Elapsed-duration cohort statistics per column plus the range-wide mean. */
export interface DurationCohorts {
  /** Mean elapsed duration (ms) of the sessions that STARTED in each column; null = no measurable session. */
  perColumn: Array<number | null>;
  /** Mean elapsed duration (ms) across the measurable sessions of the filtered range; null = none. */
  overallMs: number | null;
  /** Sessions of the filtered range that contributed to a cohort or to the overall mean. */
  counted: number;
  /** Sessions resident in the filtered range that contributed nothing (no usable duration or no in-range start). */
  excluded: number;
}

/**
 * Elapsed session duration cohorts. Each session contributes its elapsed proxy
 * (first usable span start .. last usable span end of that session, idle gaps
 * included) exactly once, to the column its session STARTED in, and exactly
 * once to the overall mean. `range` IS the filtered window and `columns` its
 * own columns (both as aggregate() built them), so a bucket outside them — a
 * future-dated one, or one from before the window — belongs to a session the
 * range does not contain: such a session is dropped outright, never clamped
 * into the last column, never averaged in, and never tallied as an exclusion,
 * since it was not measurable in this range at all. Sessions of the range with
 * no usable duration (or no in-range start) are excluded and counted. An empty
 * cohort stays null so the panel can print an en dash instead of a zero bar.
 */
export function durationCohorts(columns: number[], buckets: UsageBucket[], range: ActivityRange): DurationCohorts {
  const durationOf = new Map<string, number>();
  const startOf = new Map<string, number>();
  const seen = new Set<string>();
  for (const b of buckets) {
    const id = b.sessionId;
    if (id === undefined) continue;
    if (!columnInRange(columns, range, b.hourMs)) continue; // outside the filtered window
    seen.add(id); // the session has activity inside the range
    if (b.sessionDurationMs !== undefined && Number.isFinite(b.sessionDurationMs) && b.sessionDurationMs >= 0) {
      durationOf.set(id, b.sessionDurationMs);
    }
    if (b.sessionStartedMs !== undefined && columnInRange(columns, range, b.sessionStartedMs)) {
      startOf.set(id, b.sessionStartedMs);
    }
  }
  const sums = columns.map(() => 0);
  const counts = columns.map(() => 0);
  let total = 0;
  let counted = 0;
  for (const id of seen) {
    const ms = durationOf.get(id);
    const start = startOf.get(id);
    if (ms === undefined || start === undefined) continue; // excluded: not measurable inside this range
    total += ms;
    counted += 1;
    const col = columnFor(columns, start);
    sums[col] = (sums[col] ?? 0) + ms;
    counts[col] = (counts[col] ?? 0) + 1;
  }
  return {
    perColumn: columns.map((_, i) => ((counts[i] ?? 0) > 0 ? (sums[i] ?? 0) / (counts[i] ?? 1) : null)),
    overallMs: counted > 0 ? total / counted : null,
    counted,
    excluded: seen.size - counted,
  };
}
