// Session picker: a glass panel with a sidebar (sources to connect, projects
// to filter by) and a flat, sortable list of sessions with drip children
// nested under the host session (Claude Code, OpenCode, pi) that ran them. Pure rendering: state lives in the
// caller-provided model and every user action is delegated to the actions
// callbacks, so main.ts owns connections, scanning and opening.

import { el } from './dom.ts';
import { formatDuration } from './format.ts';
import { icon } from './icons.ts';
import { splitWorktree } from '../index/link.ts';
import type { ProjectGroup, SessionNode } from '../index/link.ts';
import type { SessionEntry } from '../index/scan.ts';
import { SOURCES, SOURCE_KINDS } from '../index/fs.ts';
import type { SourceKind } from '../index/fs.ts';

// ---- model / actions -------------------------------------------------------

export interface IndexSourceState {
  connected: boolean;
  /** A directory handle is stored but the browser needs a click to re-grant access. */
  stored: boolean;
  sessions: number;
}

export interface IndexProgress {
  label: string;
  done: number;
  total: number;
}

export interface IndexModel {
  sources: Record<SourceKind, IndexSourceState>;
  projects: ProjectGroup[];
  filter: string;
  progress: IndexProgress | null;
  busy: boolean;
}

export interface IndexActions {
  connect(kind: SourceKind): void;
  forget(kind: SourceKind): void;
  setFilter(text: string): void;
  open(entry: SessionEntry): void;
}

export type SortKey = 'recent' | 'longest' | 'largest';

const SORTS: Array<[SortKey, string]> = [
  ['recent', 'Recent'],
  ['longest', 'Longest'],
  ['largest', 'Largest'],
];

// UI choices that should survive re-renders: the project/source filter, the
// sort order, and which parents have their drip children expanded.
const ui = {
  project: null as string | null, // ProjectGroup.root
  source: null as SourceKind | null,
  sort: 'recent' as SortKey,
};
const expandedKids = new Set<string>();

// ---- entry point -----------------------------------------------------------

export function renderIndex(host: HTMLElement, model: IndexModel, actions: IndexActions): void {
  const prev = host.querySelector<HTMLInputElement>('input.index-filter');
  const refocus = prev !== null && prev === document.activeElement;
  const scrollTop = host.querySelector<HTMLElement>('.picker-rows')?.scrollTop ?? 0;
  if (ui.project !== null && !model.projects.some((p) => p.root === ui.project)) ui.project = null;

  host.textContent = '';
  host.append(sidebar(model, actions), mainColumn(model, actions));

  const rows = host.querySelector<HTMLElement>('.picker-rows');
  if (rows !== null) rows.scrollTop = scrollTop;
  if (refocus) {
    const filter = host.querySelector<HTMLInputElement>('input.index-filter');
    if (filter !== null) {
      filter.focus();
      filter.setSelectionRange(filter.value.length, filter.value.length);
    }
  }
}

/** One-line summary: "N projects · M sessions". */
export function indexSummary(model: IndexModel): string {
  const projects = model.projects.length;
  let sessions = 0;
  for (const p of model.projects) for (const w of p.worktrees) for (const s of w.sessions) sessions += countNodes(s);
  const fmt = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
  return `${fmt(projects, 'project')} · ${fmt(sessions, 'session')}`;
}

function countNodes(node: SessionNode): number {
  return 1 + node.children.reduce((sum, c) => sum + countNodes(c), 0);
}

/** Total sessions (parents + nested children) in a project. */
function projectCount(group: ProjectGroup): number {
  let n = 0;
  for (const w of group.worktrees) for (const s of w.sessions) n += countNodes(s);
  return n;
}

// ---- sidebar ---------------------------------------------------------------

function sidebar(model: IndexModel, actions: IndexActions): HTMLElement {
  const projects = el('div', { class: 'picker-projects' });
  if (model.projects.length > 0) {
    projects.append(projectRow('All projects', model.projects.reduce((n, p) => n + projectCount(p), 0), ui.project === null, () => {
      ui.project = null;
      rerender(actions);
    }));
    for (const group of model.projects) {
      projects.append(projectRow(group.label, projectCount(group), ui.project === group.root, () => {
        ui.project = ui.project === group.root ? null : group.root;
        rerender(actions);
      }));
    }
  } else {
    projects.append(
      el('p', { class: 'picker-note footnote' },
        SOURCE_KINDS.some((k) => model.sources[k].connected)
          ? 'Connected, but no transcripts found yet.'
          : 'Connect a harness directory (~/.claude, ~/.drip, ~/.local/share/opencode, ~/.pi/agent) to index your agent sessions. Directories are read locally; nothing is uploaded.',
      ),
    );
  }

  return el(
    'aside',
    { class: 'picker-side' },
    el('span', { class: 'section-cap' }, 'Sources'),
    ...SOURCE_KINDS.map((kind) => sourceItem(kind, SOURCES[kind].label, model.sources[kind], actions, model.busy)),
    el('span', { class: 'section-cap section-cap--gap' }, 'Projects'),
    projects,
    footer(model),
  );
}

function projectRow(label: string, count: number, selected: boolean, onclick: () => void): HTMLElement {
  return el(
    'div',
    { class: 'picker-project', role: 'button', tabindex: '0', 'aria-selected': selected ? 'true' : 'false', onclick, onkeydown: keyActivate(onclick) },
    el('span', { class: 'picker-project-name' }, label),
    el('span', { class: 'picker-project-n caption tabular' }, String(count)),
  );
}

function sourceItem(
  kind: SourceKind,
  label: string,
  state: IndexSourceState,
  actions: IndexActions,
  busy: boolean,
): HTMLElement {
  if (!state.connected) {
    const verb = state.stored ? 'Reconnect' : 'Connect';
    return el(
      'button',
      {
        class: 'vt-sideitem picker-source',
        type: 'button',
        disabled: busy,
        title: state.stored ? `re-grant read access to ${label} (remembered from last time)` : `pick your ${label} directory`,
        onclick: () => actions.connect(kind),
      },
      icon('folder', 14),
      el('span', { class: 'picker-source-label' }, label),
      el('span', { class: 'picker-source-action caption' }, verb),
    );
  }
  const selected = ui.source === kind;
  const forget = el(
    'button',
    {
      class: 'picker-forget',
      type: 'button',
      title: `disconnect ${label}`,
      'aria-label': `disconnect ${label}`,
      onclick: ((e: Event) => {
        e.stopPropagation();
        if (ui.source === kind) ui.source = null;
        actions.forget(kind);
      }) as EventListener,
    },
    icon('x', 11),
  );
  const toggle = (): void => {
    ui.source = selected ? null : kind;
    rerender(actions);
  };
  return el(
    'div',
    {
      class: 'vt-sideitem picker-source',
      role: 'button',
      tabindex: '0',
      'aria-selected': selected ? 'true' : 'false',
      title: selected ? 'show all sources' : `show only ${label} sessions`,
      onclick: toggle,
      onkeydown: keyActivate(toggle),
    },
    icon('folder', 14),
    el('span', { class: 'picker-source-label' }, label),
    el('span', { class: 'vt-badge vt-badge--neutral picker-source-n' }, String(state.sessions)),
    forget,
  );
}

function footer(model: IndexModel): HTMLElement {
  const parts: string[] = [];
  for (const kind of SOURCE_KINDS) {
    if (model.sources[kind].connected) parts.push(`${model.sources[kind].sessions.toLocaleString()} ${kind}`);
  }
  const text =
    model.progress !== null
      ? `${model.progress.label} ${model.progress.done}/${model.progress.total}`
      : parts.length > 0
        ? parts.join(' · ')
        : 'nothing connected';
  return el('div', { class: 'picker-foot caption' }, el('span', { role: 'status' }, text));
}

// ---- main column -----------------------------------------------------------

function mainColumn(model: IndexModel, actions: IndexActions): HTMLElement {
  const group = ui.project === null ? null : (model.projects.find((p) => p.root === ui.project) ?? null);
  const q = normalize(model.filter);
  const nodes = collectNodes(model, group).filter((n) => n.self || n.kids.length > 0);
  const sorted = sortNodes(nodes, ui.sort);
  const total = sorted.reduce((n, item) => n + 1 + item.node.children.length, 0);

  const sortSeg = el(
    'nav',
    { class: 'vt-seg', 'aria-label': 'sort sessions' },
    ...SORTS.map(([key, label]) =>
      el(
        'button',
        {
          type: 'button',
          'aria-pressed': ui.sort === key ? 'true' : 'false',
          onclick: () => {
            ui.sort = key;
            rerender(actions);
          },
        },
        label,
      ),
    ),
  );

  const filter = el(
    'label',
    { class: 'vt-input vt-input--capsule picker-filter' },
    icon('search', 13),
    el('input', {
      class: 'index-filter',
      type: 'search',
      placeholder: 'Filter sessions',
      'aria-label': 'Filter sessions',
      value: model.filter,
      oninput: () => actions.setFilter((document.activeElement as HTMLInputElement | null)?.value ?? model.filter),
    }),
  );

  const head = el(
    'div',
    { class: 'picker-head' },
    el('span', { class: 'picker-title' }, group === null ? 'All sessions' : group.label),
    el('span', { class: 'footnote' }, `${total} session${total === 1 ? '' : 's'}`),
    el('span', { class: 'spacer' }),
    sortSeg,
    filter,
  );

  const rows = el('div', { class: 'picker-rows' });
  if (sorted.length === 0) {
    rows.append(
      el(
        'div',
        { class: 'picker-empty footnote' },
        model.projects.length === 0
          ? 'No sessions indexed yet. Connect a source on the left, or drop a transcript on the toolbar.'
          : q !== ''
            ? `No sessions match “${model.filter.trim()}”.`
            : 'No sessions match.',
      ),
    );
  } else {
    for (const item of sorted) rows.append(sessionBlock(item, q, actions));
  }
  return el('div', { class: 'picker-main' }, head, rows);
}

interface Candidate {
  node: SessionNode;
  project: string;
  self: boolean;
  kids: SessionNode[];
}

/** Every top-level node under the project filter, with the text filter applied. */
function collectNodes(model: IndexModel, only: ProjectGroup | null): Candidate[] {
  const q = normalize(model.filter);
  const out: Candidate[] = [];
  const groups = only === null ? model.projects : [only];
  for (const group of groups) {
    for (const wt of group.worktrees) {
      for (const node of wt.sessions) {
        if (ui.source !== null && node.entry.kind !== ui.source && !node.children.some((c) => c.entry.kind === ui.source)) continue;
        const self = q === '' || entryMatches(node.entry, q, group.label);
        const kids = node.children.filter((k) => (q === '' || entryMatches(k.entry, q, group.label)) && (ui.source === null || k.entry.kind === ui.source || self));
        out.push({ node, project: group.label, self, kids });
      }
    }
  }
  return out;
}

function sortNodes(items: Candidate[], sort: SortKey): Candidate[] {
  const dur = (e: SessionEntry) => Math.max(0, e.endMs - e.startMs);
  const by: Record<SortKey, (a: Candidate, b: Candidate) => number> = {
    recent: (a, b) => b.node.entry.startMs - a.node.entry.startMs,
    longest: (a, b) => dur(b.node.entry) - dur(a.node.entry) || b.node.entry.startMs - a.node.entry.startMs,
    largest: (a, b) => b.node.entry.sizeBytes - a.node.entry.sizeBytes || b.node.entry.startMs - a.node.entry.startMs,
  };
  return [...items].sort(by[sort]);
}

/** One session row plus its nested drip children. */
function sessionBlock(item: Candidate, q: string, actions: IndexActions): HTMLElement {
  const { node, kids } = item;
  const entry = node.entry;
  const hasKids = node.children.length > 0;
  const open = hasKids && (expandedKids.has(entry.id) || (q !== '' && kids.length > 0));

  const kidsBox = el('div', { class: 'picker-children' });
  kidsBox.hidden = !open;
  for (const k of open ? kids : node.children) kidsBox.append(sessionRow(k, item.project, actions, true));

  const chevron = el(
    'span',
    {
      class: `picker-chevron${hasKids ? '' : ' picker-chevron--none'}`,
      ...(hasKids ? { role: 'button', title: 'toggle nested drip sessions' } : {}),
      onclick: ((e: Event) => {
        if (!hasKids) return;
        e.stopPropagation();
        const show = kidsBox.hidden;
        kidsBox.hidden = !show;
        chevron.replaceChildren(icon(show ? 'chevron-down' : 'chevron-right', 12));
        if (show) expandedKids.add(entry.id);
        else expandedKids.delete(entry.id);
      }) as EventListener,
    },
    icon(open ? 'chevron-down' : 'chevron-right', 12),
  );

  return el('div', { class: 'picker-block' }, sessionRow(node, item.project, actions, false, chevron), kidsBox);
}

function sessionRow(
  node: SessionNode,
  project: string,
  actions: IndexActions,
  child: boolean,
  chevron?: HTMLElement,
): HTMLElement {
  const e = node.entry;
  const wt = e.cwd !== null ? (splitWorktree(e.cwd).worktree ?? 'main') : null;
  const meta = [ui.project === null ? project : null, wt, e.branch].filter((s): s is string => s !== null && s !== '').join(' · ');
  const dripCount = node.children.length;
  const open = (): void => actions.open(e);
  return el(
    'div',
    {
      class: `picker-session${child ? ' picker-session--child' : ''}`,
      role: 'button',
      tabindex: '0',
      title: `${e.title === '' ? e.id : e.title} — ${e.path}`,
      onclick: open,
      onkeydown: keyActivate(open),
    },
    chevron ?? null,
    kindTag(e.kind),
    el(
      'div',
      { class: 'picker-session-text' },
      el('span', { class: 'picker-session-title' }, e.title === '' ? e.id : e.title),
      meta !== '' ? el('span', { class: 'picker-session-meta caption mono' }, meta) : null,
    ),
    el(
      'div',
      { class: 'picker-session-cols footnote tabular' },
      dripCount > 0 ? el('span', { class: 'picker-drip-count' }, `${dripCount} drip`) : el('span', { class: 'picker-drip-count' }),
      el('span', { class: 'picker-col picker-col--size' }, formatBytes(e.sizeBytes)),
      el('span', { class: 'picker-col picker-col--dur' }, formatDuration(Math.max(0, e.endMs - e.startMs))),
      el('span', { class: 'picker-col picker-col--when' }, dateLabel(e.startMs)),
      el('span', { class: 'picker-go' }, child ? null : icon('chevron-right', 12)),
    ),
  );
}

export function kindTag(kind: string): HTMLElement {
  return el('span', { class: `vt-tag tag-${kind}` }, kind);
}

// ---- helpers ---------------------------------------------------------------

/** Re-render through the owner: setFilter with the unchanged text repaints the panel. */
function rerender(actions: IndexActions): void {
  const input = document.querySelector<HTMLInputElement>('#index-panel input.index-filter');
  actions.setFilter(input?.value ?? '');
}

function keyActivate(fn: () => void): EventListener {
  return ((e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fn();
    }
  }) as EventListener;
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

/** Case-insensitive match over title, id, branch, worktree, project, paths. */
function entryMatches(entry: SessionEntry, q: string, projectLabel: string): boolean {
  if (q === '') return true;
  const wt = entry.cwd !== null ? (splitWorktree(entry.cwd).worktree ?? 'main') : '';
  const hay = [entry.title, entry.id, entry.branch ?? '', entry.slug, entry.cwd ?? '', projectLabel, wt, entry.kind];
  return hay.some((field) => field.toLowerCase().includes(q));
}

function dateLabel(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '–';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
