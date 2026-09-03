// Pure grouping/nesting of scanned SessionEntries into the session index
// tree: projects → worktree groups → sessions, with lci sessions nested
// under the host session (Claude Code, OpenCode or pi) that spawned them.
// No I/O; fully testable.

import { isHostKind } from './fs.ts';
import type { SessionEntry } from './scan.ts';

// ---- shapes ---------------------------------------------------------------

export interface SessionNode {
  entry: SessionEntry;
  children: SessionNode[];
}

export interface WorktreeGroup {
  /** Repo root cwd of the group; null when only the slug is known. */
  cwd: string | null;
  label: string;
  sessions: SessionNode[];
}

export interface ProjectGroup {
  root: string;
  label: string;
  latestMs: number;
  worktrees: WorktreeGroup[];
}

// ---- cwd parsing ----------------------------------------------------------

const SCRATCHPAD_RE =
  /^\/(?:private\/)?tmp\/claude-\d+\/([^/]+)\/([0-9a-fA-F-]{36})\/scratchpad(?:\/.*)?$/;

/** `/tmp/claude-<pid>/<slug>/<uuid>/scratchpad[/…]` → { slug, sessionId }. */
export function parseScratchpadCwd(cwd: string): { slug: string; sessionId: string } | null {
  const m = SCRATCHPAD_RE.exec(cwd);
  if (m === null) return null;
  return { slug: m[1] ?? '', sessionId: m[2] ?? '' };
}

/** Repo root and worktree name for a cwd; `main` when not a worktree. */
export function splitWorktree(cwd: string): { root: string; worktree: string | null } {
  const m = /^(.*)\/\.worktrees\/([^/]+)$/.exec(cwd);
  if (m === null) return { root: cwd, worktree: null };
  return { root: m[1] ?? cwd, worktree: m[2] ?? null };
}

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

// ---- index building -------------------------------------------------------

const RULE2_BEFORE_MS = 60_000; // lci may start up to 60 s before its parent
const RULE2_AFTER_MS = 600_000; // parent may run up to 10 min past the start

/**
 * Group entries into projects → worktree groups → session nodes, nesting
 * lci sessions under the host session (Claude Code, OpenCode, pi) that
 * spawned them when one can be found:
 *   1. exact — lci cwd is a scratchpad of a known Claude session id
 *      (only Claude Code runs shell commands from a per-session scratchpad);
 *   2. heuristic — same cwd and [start − 60 s, end + 10 min] ⊇ lci start,
 *      latest such host start winning, whatever its harness;
 *   3. otherwise the lci session stays a top-level row of its group.
 */
export function buildIndex(entries: SessionEntry[]): ProjectGroup[] {
  const hosts = entries.filter((e) => isHostKind(e.kind));
  const lci = entries.filter((e) => e.kind === 'lci');

  // Every session becomes a node exactly once; parents are linked after.
  const nodes = new Map<string, SessionNode>();
  for (const entry of [...hosts, ...lci]) {
    nodes.set(nodeKey(entry), { entry, children: [] });
  }
  const children = new Set<string>();
  for (const entry of lci) attachToParent(nodes, children, entry, hosts);

  const slugCwd = slugMap(entries);

  // Group every node by its cwd's worktree; lci children stay with their
  // parent, so only root-level nodes are placed.
  const projects = new Map<string, ProjectGroup>();
  for (const [key, node] of nodes) {
    if (children.has(key)) continue;
    const { root, label, cwd } = groupOf(node.entry, slugCwd);
    addNode(projects, root, label, cwd, node);
  }
  return sortProjects(projects);
}

function nodeKey(entry: SessionEntry): string {
  return `${entry.kind}:${entry.path}`;
}

/** Claude Code's project slug for a cwd: `/` and `.` become `-`. */
export function claudeSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

/** lci's project slug for a cwd: `/` becomes `-` and `.` is dropped. */
export function lciSlug(cwd: string): string {
  return cwd.replace(/\./g, '').replace(/\//g, '-');
}

/**
 * slug → cwd for every cwd we know, under both slug dialects, so entries
 * that lack a cwd (old lci sessions without session.json, orphaned
 * scratchpad runs) can still be placed in the right project.
 */
function slugMap(entries: SessionEntry[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of entries) {
    if (e.cwd === null || parseScratchpadCwd(e.cwd) !== null) continue;
    for (const slug of [e.slug, claudeSlug(e.cwd), lciSlug(e.cwd)]) if (!out.has(slug)) out.set(slug, e.cwd);
  }
  return out;
}

/**
 * Find `entry`'s parent by rule 1 (exact scratchpad id) then rule 2 (same
 * cwd, and the parent's window [start − 60 s, end + 10 min] contains the
 * lci start — a long-running host session that began hours earlier still
 * qualifies).
 */
function attachToParent(
  nodes: Map<string, SessionNode>,
  children: Set<string>,
  entry: SessionEntry,
  hosts: SessionEntry[],
): void {
  // Rule 1: the scratchpad uuid names the parent Claude session exactly.
  const scratch = entry.cwd === null ? null : parseScratchpadCwd(entry.cwd);
  if (scratch !== null) {
    const parent = hosts.find((c) => c.kind === 'claude' && c.id === scratch.sessionId);
    if (parent !== undefined) {
      link(nodes, children, entry, parent);
      return;
    }
  }
  // Rule 2: keep the candidate with the latest start ≤ lci start; a parent
  // that started (slightly) after the child only wins when nothing else does.
  if (entry.cwd === null) return;
  let best: SessionEntry | null = null;
  for (const c of hosts) {
    if (c.cwd !== entry.cwd) continue;
    if (entry.startMs < c.startMs - RULE2_BEFORE_MS || entry.startMs > c.endMs + RULE2_AFTER_MS) continue;
    if (best === null || betterParent(c, best, entry.startMs)) best = c;
  }
  if (best !== null) link(nodes, children, entry, best);
}

function betterParent(a: SessionEntry, b: SessionEntry, childStart: number): boolean {
  const aBefore = a.startMs <= childStart;
  const bBefore = b.startMs <= childStart;
  if (aBefore !== bBefore) return aBefore;
  return aBefore ? a.startMs > b.startMs : a.startMs < b.startMs;
}

function link(
  nodes: Map<string, SessionNode>,
  children: Set<string>,
  child: SessionEntry,
  parent: SessionEntry,
): void {
  const key = nodeKey(child);
  const node = nodes.get(key);
  const host = nodes.get(nodeKey(parent));
  if (node === undefined || host === undefined) return;
  host.children.push(node);
  children.add(key);
}

interface Placement {
  root: string; // project key
  label: string; // worktree label
  cwd: string | null; // worktree cwd (null when only a slug is known)
}

/** Project key + worktree placement for a top-level entry. */
function groupOf(entry: SessionEntry, slugCwd: Map<string, string>): Placement {
  const scratch = entry.cwd === null ? null : parseScratchpadCwd(entry.cwd);
  const slug = scratch?.slug ?? entry.slug;
  const cwd = entry.cwd !== null && scratch === null ? entry.cwd : slugCwd.get(slug);
  if (cwd === undefined) return { root: `slug:${slug}`, label: scratch === null ? 'unknown' : 'scratchpad', cwd: null };
  const { root, worktree } = splitWorktree(cwd);
  return { root, label: worktree ?? 'main', cwd };
}

function addNode(
  projects: Map<string, ProjectGroup>,
  root: string,
  label: string,
  cwd: string | null,
  node: SessionNode,
): void {
  let project = projects.get(root);
  if (project === undefined) {
    project = { root, label: root.startsWith('slug:') ? root.slice(5) : basename(root), latestMs: 0, worktrees: [] };
    projects.set(root, project);
  }
  let group = project.worktrees.find((g) => g.label === label);
  if (group === undefined) {
    group = { cwd, label, sessions: [] };
    project.worktrees.push(group);
  }
  group.sessions.push(node);
}

/** Projects by most recent session; sessions newest first; children too. */
function sortProjects(projects: Map<string, ProjectGroup>): ProjectGroup[] {
  const list = [...projects.values()];
  for (const project of list) {
    for (const group of project.worktrees) {
      sortNodes(group.sessions);
      for (const node of group.sessions) sortNodes(node.children);
    }
    project.latestMs = latestOf(project);
    project.worktrees.sort((a, b) => latestMsOfGroup(b) - latestMsOfGroup(a));
  }
  return list.sort((a, b) => b.latestMs - a.latestMs);
}

function sortNodes(nodes: SessionNode[]): void {
  nodes.sort((a, b) => b.entry.startMs - a.entry.startMs);
}

function latestOf(project: ProjectGroup): number {
  return Math.max(...project.worktrees.map(latestMsOfGroup), 0);
}

function latestMsOfGroup(group: WorktreeGroup): number {
  return Math.max(...group.sessions.map((n) => n.entry.endMs), 0);
}
