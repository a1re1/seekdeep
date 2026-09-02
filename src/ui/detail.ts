// Inspector pane: what a selected span actually contained.
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
import { icon } from './icons.ts';

export interface DetailActions {
  select: (span: Span | null) => void;
  zoom: (span: Span) => void;
  parentOf: (span: Span) => Span | null;
  /** Open a grafted child-harness session (lci) in its own tab. */
  openSession?: (span: Span) => void;
}

export function renderEmptyDetail(pane: HTMLElement): void {
  pane.textContent = '';
  pane.append(el('p', { class: 'muted empty' }, 'Click a span to inspect it'));
}

export function renderDetail(pane: HTMLElement, span: Span, session: Session, actions: DetailActions): void {
  pane.textContent = '';
  const parent = actions.parentOf(span);
  const offset = span.startMs - session.root.startMs;
  const kind = span.meta?.harness === 'lci' ? 'session' : span.kind;

  const head = el(
    'div',
    { class: 'detail-head' },
    el('span', { class: `vt-tag tag-${kind}` }, kind === 'session' ? 'lci' : span.kind),
    el('span', { class: 'detail-title', title: span.name }, span.name),
    el(
      'button',
      { type: 'button', class: 'vt-btn vt-btn--plain vt-iconbtn vt-btn--s', 'aria-label': 'Clear selection', title: 'clear selection (Esc)', onclick: (() => actions.select(null)) as EventListener },
      icon('x', 13),
    ),
  );
  const body = el('div', { class: 'detail-body' });
  pane.append(head, body);

  body.append(
    kv([
      ['Duration', formatDuration(durationMs(span))],
      ['Self time', formatDuration(selfTimeMs(span))],
      ['Starts at', `+${formatDuration(offset)}`],
    ]),
    el(
      'div',
      { class: 'detail-actions' },
      btn('Zoom Here', () => actions.zoom(span)),
      btn('Parent', () => {
        if (parent !== null) actions.select(parent);
      }, parent === null),
      span.meta?.harness === 'lci' && actions.openSession !== undefined
        ? btn('Open lci session', () => actions.openSession?.(span))
        : null,
    ),
  );
  if (span.meta?.harness === 'lci') {
    body.append(
      kv([
        ['Harness', 'lci'],
        ['Session', String(span.meta.lciSessionId ?? '')],
        ['Launched by', String(span.meta.launchedBy ?? '')],
      ]),
    );
  }

  switch (span.kind) {
    case 'model':
      renderModel(body, span);
      break;
    case 'tool':
      renderTool(body, span);
      break;
    default:
      renderContainer(body, span, actions);
  }
}

function btn(label: string, onclick: () => void, disabled = false): HTMLElement {
  return el('button', { type: 'button', class: 'vt-btn vt-btn--glass vt-btn--s', disabled, onclick: onclick as EventListener }, label);
}

// ---- model ----------------------------------------------------------------

function renderModel(pane: HTMLElement, span: Span): void {
  const u = span.usage;
  const p = span.payload;
  const rows: Array<[string, string]> = [];
  if (span.model !== undefined) rows.push(['Model', span.model]);
  if (span.provider !== undefined) rows.push(['Provider', span.provider]);
  if (p?.stopReason !== undefined) rows.push(['Stop reason', p.stopReason]);
  if (span.costUsd !== undefined) rows.push(['Est. cost', formatCost(span.costUsd)]);
  if (rows.length > 0) pane.append(kv(rows));

  if (u !== undefined) {
    const prompt = u.cacheRead + u.cacheWrite + u.input;
    pane.append(
      section(
        'Cache',
        tokenBar([
          ['cached prefix', u.cacheRead, 'seg-read'],
          ['newly cached', u.cacheWrite, 'seg-write'],
          ['uncached', u.input, 'seg-input'],
        ]),
        el('span', { class: 'caption muted' }, `${formatCount(prompt)} prompt tokens · ${formatPct(cacheHitRate(u))} served from cache`),
        kv([
          ['Cached prefix', formatCount(u.cacheRead)],
          ['Newly cached', cacheWriteText(u)],
          ['Uncached input', formatCount(u.input)],
          ['Output', formatCount(u.output)],
          ...(u.reasoning !== undefined && u.reasoning > 0 ? ([['of which reasoning', formatCount(u.reasoning)]] as Array<[string, string]>) : []),
        ]),
      ),
    );
  }

  if (p?.newContext === undefined) {
    pane.append(section('New context this call', el('p', { class: 'muted caption' }, 'this transcript format does not record the prompt contents')));
  } else {
    const items = p.newContext;
    const chars = items.reduce((a, i) => a + i.chars, 0);
    pane.append(
      section(
        `New context · ${items.length} item${items.length === 1 ? '' : 's'} · ≈${formatCount(Math.round(chars / 4))} tokens`,
        el(
          'p',
          { class: 'muted caption' },
          'records appended since the previous model call — the part of the prompt that could not be served from cache. Token estimate is chars ÷ 4.',
        ),
        items.length === 0
          ? el('p', { class: 'muted caption' }, 'nothing new — same prompt as the previous call')
          : el('div', { class: 'context-list' }, ...items.map(contextItemEl)),
      ),
    );
  }

  if (p?.output !== undefined && p.output.length > 0) pane.append(section('Output', pre(p.output)));
  if (p?.thinking !== undefined && p.thinking.length > 0) {
    pane.append(
      el('details', { class: 'detail-fold' }, el('summary', { class: 'section-cap' }, `Thinking · ${formatCount(p.thinking.length)} chars`), pre(p.thinking)),
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
  const status = item.ok === false ? el('span', { class: 'vt-tag tag-failed' }, 'error') : null;
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
      el('span', { class: 'muted caption' }, ` ${formatCount(item.chars)} chars · ≈${formatCount(Math.round(item.chars / 4))} tok`),
    ),
    pre(item.text),
  );
}

// ---- tool -----------------------------------------------------------------

function renderTool(pane: HTMLElement, span: Span): void {
  const p = span.payload;
  const rows: Array<[string, string]> = [
    ['Tool', span.toolName ?? span.name],
    ['Status', span.ok === false ? 'failed' : span.ok === true ? 'ok' : 'unknown'],
  ];
  if (span.meta?.background === true) {
    rows.push([
      'Background task',
      span.meta.finishedMs !== undefined
        ? `${String(span.meta.taskId ?? '')} · ran ${formatDuration(durationMs(span))} until its notification`
        : `${String(span.meta.taskId ?? '')} · no completion notification seen`,
    ]);
  }
  if (span.meta?.spawned === 'lci') rows.push(['Spawned', 'an lci session (nested below)']);
  pane.append(kv(rows));
  const input = p?.input ?? span.toolInput;
  pane.append(section('Input', input !== undefined && input.length > 0 ? pre(input) : el('p', { class: 'muted caption' }, 'not recorded')));
  pane.append(section('Output', p?.output !== undefined && p.output.length > 0 ? pre(p.output) : el('p', { class: 'muted caption' }, 'not recorded')));
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
    ['Descendants', `${all.length} (${models.length} model, ${tools.length} tool)`],
  ];
  if (models.length > 0) rows.push(['Output tokens', formatCount(u.output)]);
  if (rollup !== undefined && Number(rollup) > 0) rows.push(['Est. cost (incl. children)', formatCost(Number(rollup))]);
  pane.append(kv(rows));
  if (models.length > 0) {
    pane.append(
      section(
        'Cache',
        tokenBar([
          ['cached prefix', u.cacheRead, 'seg-read'],
          ['newly cached', u.cacheWrite, 'seg-write'],
          ['uncached', u.input, 'seg-input'],
        ]),
        el(
          'span',
          { class: 'caption muted' },
          `${formatCount(u.cacheRead)} cached · ${formatCount(u.cacheWrite)} written · ${formatCount(u.input)} uncached · ${formatPct(cacheHitRate(u))} hit`,
        ),
      ),
    );
  }
  if (span.detail !== undefined && span.detail.length > 0) pane.append(section('Detail', pre(span.detail)));

  const kids = [...span.children].sort((a, b) => a.startMs - b.startMs);
  if (kids.length > 0) {
    pane.append(
      section(
        `Children · ${kids.length}`,
        el(
          'div',
          { class: 'child-list' },
          ...kids.slice(0, 200).map((c) =>
            el(
              'button',
              { type: 'button', class: 'child-row', onclick: (() => actions.select(c)) as EventListener },
              el('span', { class: `dot k-${c.meta?.harness === 'lci' ? 'session' : c.kind}` }),
              el('span', { class: 'child-name' }, c.name),
              el('span', { class: 'child-dur footnote tabular' }, formatDuration(durationMs(c))),
            ),
          ),
          kids.length > 200 ? el('span', { class: 'muted caption' }, `… ${kids.length - 200} more`) : null,
        ),
      ),
    );
  }
}

// ---- bits -----------------------------------------------------------------

function section(title: string, ...children: Array<HTMLElement | null>): HTMLElement {
  return el('div', { class: 'detail-section' }, el('span', { class: 'section-cap' }, title), ...children);
}

function kv(rows: Array<[string, string]>): HTMLElement {
  return el(
    'dl',
    { class: 'kv' },
    ...rows.flatMap(([k, v]) => [el('dt', null, k), el('dd', { title: v }, v)]),
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
  return el('p', { class: 'muted caption' }, '(long content truncated for display)');
}
