// Grafting a child harness session (an drip run) into the span tree of the
// host session (Claude Code, Codex, OpenCode or pi) that launched it, so one
// waterfall shows the whole multi-harness journey. Pure: no I/O, no DOM.
//
// Host selection, in order:
//   1. the shell tool span whose command mentions `drip` and whose window
//      (± LAUNCH_SLACK_MS) contains the child's start — the latest such
//      launch that started before the child wins;
//   2. the turn active when the child started (the last turn that began
//      before it);
//   3. the session root.

import type { Session, Span } from './model.ts';
import { flatten } from './model.ts';
import { SOURCE_KINDS, isHostKind } from './index/fs.ts';
import type { SourceKind } from './index/fs.ts';
import { harnessOf } from './stats.ts';

export const LAUNCH_SLACK_MS = 5_000;

/**
 * Transcript formats whose sessions can launch drip and so host grafted
 * children: the same rule as the index's `isHostKind`, applied to the
 * format's harness label (formats the index cannot connect never host).
 */
export function isHostFormat(format: Session['format']): boolean {
  const kind = harnessOf(format);
  return (SOURCE_KINDS as string[]).includes(kind) && isHostKind(kind as SourceKind);
}

export interface ChildRef {
  id: string;
  path: string;
  title: string;
}

// `lci` is drip's TypeScript predecessor (same session format); transcripts
// recorded before the rename still launch it by that name.
const DRIP_RE = /(^|[\s;&|(`'"])(?:drip|lci)(\s|$)/;

/** Whether a tool span looks like a shell call that launched drip. */
export function isDripLaunch(span: Span): boolean {
  if (span.kind !== 'tool') return false;
  const text = span.payload?.input ?? span.toolInput ?? '';
  return DRIP_RE.test(text);
}

/** The span an drip session starting at `startMs` should nest under. */
export function findLaunchSpan(root: Span, startMs: number): Span {
  let best: Span | null = null;
  for (const span of flatten(root)) {
    if (!isDripLaunch(span)) continue;
    if (startMs < span.startMs - LAUNCH_SLACK_MS || startMs > span.endMs + LAUNCH_SLACK_MS) continue;
    if (best === null || betterLaunch(span, best, startMs)) best = span;
  }
  if (best !== null) return best;
  let turn: Span | null = null;
  for (const child of root.children) {
    if (child.kind !== 'turn' || child.startMs > startMs) continue;
    if (turn === null || child.startMs >= turn.startMs) turn = child;
  }
  return turn ?? root;
}

function betterLaunch(a: Span, b: Span, childStart: number): boolean {
  const aBefore = a.startMs <= childStart;
  const bBefore = b.startMs <= childStart;
  if (aBefore !== bBefore) return aBefore;
  return aBefore ? a.startMs > b.startMs : a.startMs < b.startMs;
}

/**
 * Attach `child`'s root under `host` as a `session` span tagged with the
 * child harness. Ancestors are NOT clamped: the child keeps its true window,
 * and only the tree root is widened so the trace window covers it.
 */
export function graftSession(root: Span, host: Span, child: Session, ref: ChildRef): Span {
  const grafted = child.root;
  grafted.id = `drip:${ref.id}`;
  grafted.parentId = host.id;
  grafted.name = `drip · ${ref.title.length > 0 ? ref.title : child.title}`;
  grafted.meta = {
    ...grafted.meta,
    harness: 'drip',
    dripSessionId: ref.id,
    dripPath: ref.path,
    launchedBy: host.name,
  };
  host.children.push(grafted);
  host.children.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  if (host.kind === 'tool') host.meta = { ...host.meta, spawned: 'drip' };
  if (grafted.endMs > root.endMs) root.endMs = grafted.endMs;
  if (grafted.startMs < root.startMs) root.startMs = grafted.startMs;
  return grafted;
}

/** A child session whose transcript produced nothing but its root: nothing to trace. */
export function isEmptySession(child: Session): boolean {
  return child.root.children.length === 0;
}

/** Span ids present in a tree that came from grafting (for de-duplication). */
export function graftedIds(root: Span): Set<string> {
  const out = new Set<string>();
  for (const span of flatten(root)) {
    const id = span.meta?.dripSessionId;
    if (typeof id === 'string') out.add(id);
  }
  return out;
}
