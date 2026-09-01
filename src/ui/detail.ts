// Detail pane: what a selected span actually contained.
//
// Tool spans show their full input and output. Model spans show the token
// split of the prompt (cached prefix / newly cached / uncached), the "new
// context" appended since the previous model call — the concrete records that
// make up the uncached part — and the model's output. Container spans (turn,
// subagent, …) show rolled-up usage and their children.

import type { ContextItem, Session, Span } from '../model.ts';
import { cacheHitRate, durationMs, flatten, selfTimeMs, sumUsage } from '../model.ts';
import { el } from './dom.ts';
import { formatCost, formatCount, formatDuration, formatPct } from './format.ts';

export interface DetailActions {
  select: (span: Span) => void;
  zoom: (span: Span) => void;
  parentOf: (span: Span) => Span | null;
}

export function renderEmptyDetail(pane: HTMLElement): void {
  pane.textContent = '';
  pane.append(el('p', { class: 'muted empty' }, 'click a span to inspect it'));
}

export function renderDetail(pane: HTMLElement, span: Span, session: Session, actions: DetailActions): void {
  pane.textContent = '';
  const parent = actions.parentOf(span);
  const offset = span.startMs - session.root.startMs;

  pane.append(
    el(
      'div',
      { class: 'detail-head' },
      el('span', { class: `sw ${span.kind}` }, span.kind),
      el('h3', { title: span.name }, span.name),
    ),
    kv([
      ['duration', formatDuration(durationMs(span))],
      ['self time', formatDuration(selfTimeMs(span))],
      ['starts at', `+${formatDuration(offset)}`],
    ]),
    el(
      'div',
      { class: 'detail-actions' },
      el('button', { type: 'button', onclick: (() => actions.zoom(span)) as EventListener }, '⤵ zoom here'),
      parent !== null
        ? el('button', { type: 'button', onclick: (() => actions.select(parent)) as EventListener }, '↑ parent')
        : null,
    ),
  );

  switch (span.kind) {
    case 'model':
      renderModel(pane, span);
      break;
    case 'tool':
      renderTool(pane, span);
      break;
    default:
      renderContainer(pane, span, actions);
  }
}

// ---- model ----------------------------------------------------------------

function renderModel(pane: HTMLElement, span: Span): void {
  const u = span.usage;
  const p = span.payload;
  const rows: Array<[string, string]> = [];
  if (span.model !== undefined) rows.push(['model', span.model]);
  if (span.provider !== undefined) rows.push(['provider', span.provider]);
  if (p?.stopReason !== undefined) rows.push(['stop reason', p.stopReason]);
  if (span.costUsd !== undefined) rows.push(['est. cost', formatCost(span.costUsd)]);
  if (rows.length > 0) pane.append(kv(rows));

  if (u !== undefined) {
    const prompt = u.cacheRead + u.cacheWrite + u.input;
    pane.append(
      el('h4', null, `prompt · ${formatCount(prompt)} tokens · ${formatPct(cacheHitRate(u))} cached`),
      tokenBar([
        ['cached prefix', u.cacheRead, 'seg-read'],
        ['newly cached', u.cacheWrite, 'seg-write'],
        ['uncached', u.input, 'seg-input'],
      ]),
      kv([
        ['cached prefix (cache read)', formatCount(u.cacheRead)],
        ['newly cached (cache write)', cacheWriteText(u)],
        ['uncached input', formatCount(u.input)],
        ['output', formatCount(u.output)],
        ...(u.reasoning !== undefined && u.reasoning > 0 ? ([['of which reasoning', formatCount(u.reasoning)]] as Array<[string, string]>) : []),
      ]),
    );
  }

  if (p?.newContext === undefined) {
    pane.append(
      el('h4', null, 'new context this call'),
      el('p', { class: 'muted' }, 'this transcript format does not record the prompt contents'),
    );
  } else {
    const items = p.newContext;
    const chars = items.reduce((a, i) => a + i.chars, 0);
    pane.append(
      el(
        'h4',
        null,
        `new context this call · ${items.length} item${items.length === 1 ? '' : 's'} · ≈${formatCount(Math.round(chars / 4))} tokens`,
      ),
      el(
        'p',
        { class: 'muted small' },
        'records appended to the conversation since the previous model call — the part of the prompt that could not be served from cache. Token estimate is chars ÷ 4.',
      ),
      items.length === 0
        ? el('p', { class: 'muted' }, 'nothing new — same prompt as the previous call')
        : el('div', { class: 'context-list' }, ...items.map(contextItemEl)),
    );
  }

  if (p?.output !== undefined && p.output.length > 0) {
    pane.append(el('h4', null, 'output'), pre(p.output));
  }
  if (p?.thinking !== undefined && p.thinking.length > 0) {
    pane.append(
      el('details', null, el('summary', null, `thinking · ${formatCount(p.thinking.length)} chars`), pre(p.thinking)),
    );
  }
  if (p?.truncated === true) pane.append(truncatedNote());
}

function cacheWriteText(u: NonNullable<Span['usage']>): string {
  const parts: string[] = [];
  if (u.cacheWrite5m !== undefined && u.cacheWrite5m > 0) parts.push(`${formatCount(u.cacheWrite5m)} @5m`);
  if (u.cacheWrite1h !== undefined && u.cacheWrite1h > 0) parts.push(`${formatCount(u.cacheWrite1h)} @1h`);
  return parts.length > 0 ? `${formatCount(u.cacheWrite)} (${parts.join(', ')})` : formatCount(u.cacheWrite);
}

function contextItemEl(item: ContextItem): HTMLElement {
  const status = item.ok === false ? el('span', { class: 'badge failed' }, 'error') : null;
  return el(
    'details',
    { class: `context-item role-${item.role}` },
    el(
      'summary',
      null,
      el('span', { class: 'role' }, item.role.replace('_', ' ')),
      ' ',
      el('span', { class: 'label' }, item.label),
      ' ',
      status,
      el('span', { class: 'muted small' }, ` ${formatCount(item.chars)} chars · ≈${formatCount(Math.round(item.chars / 4))} tok`),
    ),
    pre(item.text),
  );
}

// ---- tool -----------------------------------------------------------------

function renderTool(pane: HTMLElement, span: Span): void {
  const p = span.payload;
  pane.append(
    kv([
      ['tool', span.toolName ?? span.name],
      ['status', span.ok === false ? 'failed' : span.ok === true ? 'ok' : 'unknown'],
    ]),
  );
  const input = p?.input ?? span.toolInput;
  pane.append(el('h4', null, 'input'), input !== undefined && input.length > 0 ? pre(input) : el('p', { class: 'muted' }, 'not recorded'));
  pane.append(
    el('h4', null, 'output'),
    p?.output !== undefined && p.output.length > 0 ? pre(p.output) : el('p', { class: 'muted' }, 'not recorded'),
  );
  if (p?.truncated === true) pane.append(truncatedNote());
}

// ---- containers -----------------------------------------------------------

function renderContainer(pane: HTMLElement, span: Span, actions: DetailActions): void {
  const all = flatten(span).filter((s) => s !== span);
  const models = all.filter((s) => s.kind === 'model');
  const tools = all.filter((s) => s.kind === 'tool');
  const u = sumUsage(models);
  const rollup = span.meta?.costRollupUsd;
  const rows: Array<[string, string]> = [
    ['descendants', `${all.length} (${models.length} model, ${tools.length} tool)`],
  ];
  if (models.length > 0) {
    rows.push(
      ['prompt tokens', `${formatCount(u.cacheRead)} cached · ${formatCount(u.cacheWrite)} written · ${formatCount(u.input)} uncached`],
      ['output tokens', formatCount(u.output)],
      ['cache hit', formatPct(cacheHitRate(u))],
    );
  }
  if (rollup !== undefined && Number(rollup) > 0) rows.push(['est. cost (incl. children)', formatCost(Number(rollup))]);
  pane.append(kv(rows));
  if (span.detail !== undefined && span.detail.length > 0) pane.append(el('h4', null, 'detail'), pre(span.detail));

  const kids = [...span.children].sort((a, b) => a.startMs - b.startMs);
  if (kids.length > 0) {
    pane.append(
      el('h4', null, `children · ${kids.length}`),
      el(
        'ul',
        { class: 'child-list' },
        ...kids.slice(0, 200).map((c) =>
          el(
            'li',
            null,
            el(
              'button',
              { type: 'button', class: 'link', onclick: (() => actions.select(c)) as EventListener },
              el('span', { class: `dot k-${c.kind}` }),
              c.name,
            ),
            el('span', { class: 'muted small' }, ` ${formatDuration(durationMs(c))}`),
          ),
        ),
        kids.length > 200 ? el('li', { class: 'muted' }, `… ${kids.length - 200} more`) : null,
      ),
    );
  }
}

// ---- bits -----------------------------------------------------------------

function kv(rows: Array<[string, string]>): HTMLElement {
  return el(
    'dl',
    { class: 'kv' },
    ...rows.flatMap(([k, v]) => [el('dt', null, k), el('dd', null, v)]),
  );
}

function tokenBar(segments: Array<[string, number, string]>): HTMLElement {
  const total = segments.reduce((a, [, n]) => a + n, 0);
  const bar = el('div', { class: 'token-bar' });
  if (total <= 0) return bar;
  for (const [label, n, cls] of segments) {
    if (n <= 0) continue;
    bar.append(el('span', { class: `seg ${cls}`, style: `width:${(n / total) * 100}%`, title: `${label}: ${formatCount(n)}` }));
  }
  return bar;
}

function pre(text: string): HTMLElement {
  return el('pre', { class: 'payload' }, text);
}

function truncatedNote(): HTMLElement {
  return el('p', { class: 'muted small' }, '(long content truncated for display)');
}
