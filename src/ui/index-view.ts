// Session index view: a toolbar (connect ~/.claude / ~/.lci, scan progress,
// text filter) above a collapsible project → worktree → session tree with
// lci sessions nested under their Claude Code parent. Pure rendering: state
// lives in the caller-provided model and every user action is delegated to
// the actions callbacks, so main.ts owns connections, scanning and opening.

import { el } from './dom.ts';
import { formatDuration } from './format.ts';
import { splitWorktree } from '../index/link.ts';
import type { ProjectGroup, SessionNode, WorktreeGroup } from '../index/link.ts';
import type { SessionEntry } from '../index/scan.ts';
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
  claude: IndexSourceState;
  lci: IndexSourceState;
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

// UI choices that should survive re-renders: which projects the user
// collapsed, and which parents have their lci children expanded.
const projectOpen = new Map<string, boolean>();
const expandedKids = new Set<string>();

const OPEN_PROJECTS = 3; // the three most recent projects start expanded

// ---- entry point -----------------------------------------------------------

export function renderIndex(host: HTMLElement, model: IndexModel, actions: IndexActions): void {
  const refocus = host.querySelector('input.index-filter') === document.activeElement;
  host.textContent = '';
  host.append(toolbar(model, actions), tree(model, actions));
  if (refocus) {
    const filter = host.querySelector<HTMLInputElement>('input.index-filter');
    if (filter !== null) {
      filter.focus();
      filter.setSelectionRange(filter.value.length, filter.value.length);
    }
  }
}

/** One-line summary for the collapsed index panel: "N projects · M sessions". */
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

// ---- toolbar ---------------------------------------------------------------

function toolbar(model: IndexModel, actions: IndexActions): HTMLElement {
  const progress =
    model.progress !== null
      ? el('span', { class: 'index-progress', role: 'status' }, `${model.progress.label} ${model.progress.done}/${model.progress.total}`)
      : null;
  return el(
    'div',
    { class: 'index-toolbar' },
    sourceControl('claude', '~/.claude', model.claude, actions, model.busy),
    sourceControl('lci', '~/.lci', model.lci, actions, model.busy),
    progress,
    el('input', {
      class: 'index-filter',
      type: 'text',
      placeholder: 'filter sessions…',
      value: model.filter,
      oninput: () => actions.setFilter((document.activeElement as HTMLInputElement | null)?.value ?? model.filter),
    }),
  );
}

function sourceControl(
  kind: SourceKind,
  label: string,
  state: IndexSourceState,
  actions: IndexActions,
  busy: boolean,
): HTMLElement {
  if (!state.connected) {
    return el(
      'button',
      {
        class: 'index-connect',
        type: 'button',
        disabled: busy,
        title: state.stored ? `re-grant read access to ${label} (remembered from last time)` : `pick your ${label} directory`,
        onclick: () => actions.connect(kind),
      },
      `${state.stored ? 'reconnect' : 'connect'} ${label}`,
    );
  }
  return el(
    'span',
    { class: 'index-source' },
    el('span', { class: 'index-source-label' }, `${label} · ${state.sessions} session${state.sessions === 1 ? '' : 's'}`),
    el('button', { class: 'index-forget', type: 'button', title: `disconnect ${label}`, onclick: () => actions.forget(kind) }, 'forget'),
  );
}

// ---- tree ------------------------------------------------------------------

function tree(model: IndexModel, actions: IndexActions): HTMLElement {
  const q = normalize(model.filter);
  const body = el('div', { class: 'index-tree' });
  if (model.projects.length === 0) {
    body.append(
      el(
        'p',
        { class: 'index-empty' },
        model.claude.connected || model.lci.connected
          ? 'Connected, but no transcripts found yet.'
          : 'Connect ~/.claude and/or ~/.lci above to index your agent sessions. ',
      ),
      el(
        'p',
        { class: 'index-empty muted' },
        'Clicking a session opens it in the trace viewer below. Everything stays in your browser: directories are read locally, nothing is uploaded.',
      ),
    );
    return body;
  }
  model.projects.forEach((group, rank) => {
    const block = projectBlock(group, rank, q, actions);
    if (block !== null) body.append(block);
  });
  if (body.children.length === 0) {
    body.append(el('p', { class: 'index-empty' }, `no sessions match “${model.filter.trim()}”`));
  }
  return body;
}

/** A project block, or null when the filter matches nothing inside it. `rank` = position by recency. */
function projectBlock(group: ProjectGroup, rank: number, q: string, actions: IndexActions): HTMLElement | null {
  const parts: HTMLElement[] = [];
  let shown = 0;
  let total = 0;
  for (const wt of group.worktrees) {
    total += wt.sessions.reduce((sum, s) => sum + countNodes(s), 0);
    const block = worktreeBlock(wt, q, group.label, actions);
    if (block !== null) {
      parts.push(block.header, block.body);
      shown += block.count;
    }
  }
  if (parts.length === 0 && q !== '') return null;

  const details = el(
    'details',
    {
      class: 'index-project',
      open: (q !== '' && shown > 0) || (projectOpen.get(group.root) ?? rank < OPEN_PROJECTS),
      ontoggle: () => projectOpen.set(group.root, details.open),
    },
    el('summary', { class: 'index-project-summary' },
      el('span', { class: 'index-project-label' }, group.label),
      el('span', { class: 'index-project-meta' }, `${total} session${total === 1 ? '' : 's'} · ${dateLabel(group.latestMs)}`),
    ),
    ...parts,
  );
  return details;
}

function worktreeBlock(
  wt: WorktreeGroup,
  q: string,
  projectLabel: string,
  actions: IndexActions,
): { header: HTMLElement; body: HTMLElement; count: number } | null {
  const lines: HTMLElement[] = [];
  for (const node of wt.sessions) {
    const line = sessionBlock(node, q, projectLabel, actions);
    if (line !== null) lines.push(line);
  }
  if (lines.length === 0) return null;
  return {
    header: el('div', { class: 'index-worktree' }, wt.label),
    body: el('div', { class: 'index-worktree-body' }, ...lines),
    count: lines.length,
  };
}

/** One session row plus its nested lci children; null when filtered away. */
function sessionBlock(node: SessionNode, q: string, projectLabel: string, actions: IndexActions): HTMLElement | null {
  const entry = node.entry;
  const self = q === '' || entryMatches(entry, q, projectLabel);
  const kids = node.children.filter((k) => q === '' || entryMatches(k.entry, q, projectLabel));
  if (!self && kids.length === 0) return null;

  const kidsBox = el('div', { class: 'index-children' });
  for (const k of kids) kidsBox.append(sessionLine(k, actions, true));

  const line = el('div', { class: 'index-line' }, sessionLine(node, actions, false));
  if (node.children.length > 0) {
    const open = expandedKids.has(entry.id) || (q !== '' && kids.length > 0);
    kidsBox.hidden = !open;
    const btn = el(
      'button',
      {
        class: `index-kids${open ? ' open' : ''}`,
        type: 'button',
        title: 'toggle nested lci sessions',
        onclick: () => {
          const show = kidsBox.hidden;
          kidsBox.hidden = !show;
          btn.classList.toggle('open', show);
          btn.textContent = `${show ? '▾' : '▸'} ${node.children.length} lci`;
          if (show) expandedKids.add(entry.id);
          else expandedKids.delete(entry.id);
        },
      },
      `${open ? '▾' : '▸'} ${node.children.length} lci`,
    );
    line.append(btn);
  }
  const block = el('div', { class: 'index-session-block' }, line, kidsBox);
  return block;
}

function sessionLine(node: SessionNode, actions: IndexActions, child: boolean): HTMLElement {
  const e = node.entry;
  return el(
    'button',
    {
      class: `index-session${child ? ' child' : ''}`,
      type: 'button',
      title: `${e.title} — ${e.path}`,
      onclick: () => actions.open(e),
    },
    el('span', { class: `badge badge-${e.kind}` }, e.kind),
    el('span', { class: 'index-title' }, e.title === '' ? e.id : e.title),
    e.branch !== null ? el('span', { class: 'index-branch' }, e.branch) : null,
    el('span', { class: 'index-when' }, dateLabel(e.startMs)),
    el('span', { class: 'index-dur' }, formatDuration(Math.max(0, e.endMs - e.startMs))),
  );
}

// ---- helpers ---------------------------------------------------------------

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
