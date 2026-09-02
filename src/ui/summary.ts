// Summary panel: headline cards + detail tables (slowest spans, top tools,
// cost by model). All timings use union coverage, not naive sums.

import type { Session, Span, Usage } from '../model.ts';
import { durationMs, selfTimeMs, sumUsage, cacheHitRate } from '../model.ts';
import { el } from './dom.ts';
import { formatCost, formatCount, formatDuration, formatPct, formatTokens } from './format.ts';
import { icon } from './icons.ts';

export interface SummaryNumbers {
  wallMs: number;
  modelMs: number;
  toolMs: number;
  idleMs: number;
  usage: Usage;
  hitRate: number;
  costUsd: number;
}

/** Union-based timing per kind + overall usage/cost across the tree. */
export function summarize(root: Span): SummaryNumbers {
  const byKind = new Map<string, Array<[number, number]>>();
  let usage = sumUsage([]); // zero
  let costUsd = 0;
  const walk = (span: Span): void => {
    let list = byKind.get(span.kind);
    if (list === undefined) {
      list = [];
      byKind.set(span.kind, list);
    }
    list.push([span.startMs, Math.max(span.startMs, span.endMs)]);
    if (span.usage !== undefined) usage = addUsage(usage, span.usage);
    if (span.costUsd !== undefined) costUsd += span.costUsd;
    for (const child of span.children) walk(child);
  };
  walk(root);
  return {
    wallMs: durationMs(root),
    modelMs: unionMs(byKind.get('model') ?? []),
    toolMs: unionMs(byKind.get('tool') ?? []),
    idleMs: unionMs(byKind.get('idle') ?? []),
    usage,
    hitRate: cacheHitRate(usage),
    costUsd,
  };
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheWrite5m: (a.cacheWrite5m ?? 0) + (b.cacheWrite5m ?? 0),
    cacheWrite1h: (a.cacheWrite1h ?? 0) + (b.cacheWrite1h ?? 0),
    output: a.output + b.output,
    reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0),
  };
}

/** Total covered time of [start,end) intervals, merging overlaps. */
function unionMs(intervals: Array<[number, number]>): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((p, q) => p[0] - q[0]);
  let total = 0;
  let curStart = sorted[0]![0];
  let curEnd = sorted[0]![1];
  for (let i = 1; i < sorted.length; i += 1) {
    const [s, e] = sorted[i]!;
    if (s > curEnd) {
      total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else if (e > curEnd) {
      curEnd = e;
    }
  }
  return total + curEnd - curStart;
}

// Sessions whose warnings bar the user dismissed; re-renders keep it hidden.
const dismissedWarnings = new WeakSet<Session>();

export function renderSummary(
  container: HTMLElement,
  session: Session,
  numbers: SummaryNumbers,
): void {
  const all = flattenSpans(session.root).filter((s) => s !== session.root);
  const modelCalls = all.filter((s) => s.kind === 'model').length;
  const toolCalls = all.filter((s) => s.kind === 'tool').length;
  const promptTokens = numbers.usage.input + numbers.usage.cacheRead + numbers.usage.cacheWrite;
  const share = (ms: number): string => (numbers.wallMs > 0 ? `${((ms / numbers.wallMs) * 100).toFixed(0)}% of wall` : '');
  const calls = (n: number): string => `${formatCount(n)} call${n === 1 ? '' : 's'}`;

  set('s-wall', formatDuration(numbers.wallMs));
  set('s-wall-sub', `${all.length} span${all.length === 1 ? '' : 's'} · ${startLabel(session.root.startMs)}`);
  set('s-model', formatDuration(numbers.modelMs));
  set('s-model-sub', [share(numbers.modelMs), calls(modelCalls)].filter(Boolean).join(' · '));
  set('s-tool', formatDuration(numbers.toolMs));
  set('s-tool-sub', [share(numbers.toolMs), calls(toolCalls)].filter(Boolean).join(' · '));
  set('s-idle', formatDuration(numbers.idleMs));
  set('s-idle-sub', share(numbers.idleMs));
  set('s-tokens', formatTokens(numbers.usage));
  set('s-tokens-sub', 'in / cache rd / cache wr / out');
  set('s-hitrate', formatPct(numbers.hitRate));
  set('s-hitrate-sub', promptTokens > 0 ? `${formatCount(numbers.usage.cacheRead)} of ${formatCount(promptTokens)} prompt` : 'no usage recorded');
  set('s-cost', formatCost(numbers.costUsd));
  set('s-cost-sub', modelCalls > 0 ? `${formatCost(numbers.costUsd / modelCalls)} per call` : '');

  const body = container.querySelector<HTMLElement>('#details-body');
  if (body === null) return;
  body.textContent = '';

  // Top 8 slowest spans (excluding the session root).
  const slowest = [...all].sort((a, b) => durationMs(b) - durationMs(a)).slice(0, 8);
  body.append(
    el('h3', null, 'slowest spans'),
    table(
      ['span', 'kind', 'duration', 'self'],
      slowest.map((s) => [
        truncate(s.name, 48),
        s.kind,
        formatDuration(durationMs(s)),
        formatDuration(selfTimeMs(s)),
      ]),
    ),
  );

  // Top tools by count and by total time.
  const tools = new Map<string, { count: number; ms: number }>();
  for (const s of all) {
    if (s.kind !== 'tool' || s.toolName === undefined) continue;
    const cur = tools.get(s.toolName) ?? { count: 0, ms: 0 };
    cur.count += 1;
    cur.ms += durationMs(s);
    tools.set(s.toolName, cur);
  }
  const byCount = [...tools.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 8);
  const byTime = [...tools.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 8);
  body.append(
    el('h3', null, 'top tools by count'),
    table(
      ['tool', 'calls'],
      byCount.map(([name, v]) => [name, formatCount(v.count)]),
    ),
    el('h3', null, 'top tools by total time'),
    table(
      ['tool', 'total time', 'calls'],
      byTime.map(([name, v]) => [name, formatDuration(v.ms), formatCount(v.count)]),
    ),
  );

  // Cost by model.
  const costByModel = new Map<string, { cost: number; calls: number }>();
  for (const s of all) {
    if (s.kind !== 'model') continue;
    const key = s.model ?? '(unknown)';
    const cur = costByModel.get(key) ?? { cost: 0, calls: 0 };
    cur.cost += s.costUsd ?? 0;
    cur.calls += 1;
    costByModel.set(key, cur);
  }
  const costs = [...costByModel.entries()].sort((a, b) => b[1].cost - a[1].cost);
  body.append(
    el('h3', null, 'cost by model'),
    costs.length === 0
      ? el('p', { class: 'muted' }, 'no model spans')
      : table(
          ['model', 'calls', 'cost'],
          costs.map(([name, v]) => [name, formatCount(v.calls), formatCost(v.cost)]),
        ),
  );

  groupSections(body);

  // Warnings: one glass bar, dismissible per session.
  const warnings = container.querySelector<HTMLElement>('#warnings');
  if (warnings !== null) {
    warnings.textContent = '';
    const n = session.warnings.length;
    if (n > 0 && !dismissedWarnings.has(session)) {
      warnings.hidden = false;
      warnings.append(
        icon('circle-alert', 14),
        el('span', { class: 'warn-count' }, `${n} warning${n === 1 ? '' : 's'}`),
        el('span', { class: 'warn-text footnote', title: session.warnings.join('\n') }, session.warnings.join(' · ')),
        el(
          'button',
          {
            type: 'button',
            class: 'vt-btn vt-btn--plain vt-btn--s',
            onclick: (() => {
              dismissedWarnings.add(session);
              warnings.hidden = true;
            }) as EventListener,
          },
          'Dismiss',
        ),
      );
    } else {
      warnings.hidden = true;
    }
  }
}

function startLabel(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function set(id: string, value: string): void {
  const node = document.getElementById(id);
  if (node !== null) node.textContent = value;
}

function table(headers: string[], rows: string[][]): HTMLElement {
  const thead = el(
    'thead',
    null,
    el('tr', null, ...headers.map((h) => el('th', null, h))),
  );
  const tbody = el(
    'tbody',
    null,
    ...rows.map((row) => el('tr', null, ...row.map((cell) => el('td', null, cell)))),
  );
  return el('table', { class: 'detail-table' }, thead, tbody);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function flattenSpans(root: Span): Span[] {
  const out: Span[] = [];
  const walk = (span: Span): void => {
    out.push(span);
    for (const child of span.children) walk(child);
  };
  walk(root);
  return out;
}

/**
 * Wrap each `h3` and the nodes that follow it (until the next `h3`) in a
 * `<section>`, so the grid lays out heading+table as one cell.
 */
function groupSections(body: HTMLElement): void {
  const nodes = Array.from(body.childNodes);
  body.textContent = '';
  let current: HTMLElement | null = null;
  for (const node of nodes) {
    if (node instanceof HTMLHeadingElement) {
      current = document.createElement('section');
      body.append(current);
    }
    (current ?? body).append(node);
  }
}
