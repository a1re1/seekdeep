// Summary panel: headline cards + detail tables (slowest spans, top tools,
// cost by model). All timings use union coverage, not naive sums.

import type { Session, Span, Usage } from '../model.ts';
import { durationMs, selfTimeMs, sumUsage, cacheHitRate } from '../model.ts';
import { el } from './dom.ts';
import { formatCost, formatCount, formatDuration, formatPct, formatTokens } from './format.ts';

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

export function renderSummary(
  container: HTMLElement,
  session: Session,
  numbers: SummaryNumbers,
): void {
  set('s-wall', formatDuration(numbers.wallMs));
  set('s-model', formatDuration(numbers.modelMs));
  set('s-tool', formatDuration(numbers.toolMs));
  set('s-idle', formatDuration(numbers.idleMs));
  set('s-tokens', formatTokens(numbers.usage));
  set('s-hitrate', formatPct(numbers.hitRate));
  set('s-cost', formatCost(numbers.costUsd));

  const body = container.querySelector<HTMLElement>('#details-body');
  if (body === null) return;
  body.textContent = '';

  // Top 8 slowest spans (excluding the session root).
  const all = flattenSpans(session.root).filter((s) => s !== session.root);
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

  // Warnings.
  groupSections(body);

  const warnings = container.querySelector<HTMLElement>('#warnings');
  if (warnings !== null) {
    warnings.textContent = '';
    if (session.warnings.length > 0) {
      warnings.hidden = false;
      // Collapsed by default: the list can run long and the trace needs the room.
      warnings.append(
        el(
          'details',
          null,
          el('summary', null, el('strong', null, `warnings (${session.warnings.length})`)),
          el('ul', null, ...session.warnings.map((w) => el('li', null, w))),
        ),
      );
    } else {
      warnings.hidden = true;
    }
  }
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
