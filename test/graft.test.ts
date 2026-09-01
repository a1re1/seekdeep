import { describe, expect, test } from 'bun:test';
import { findLaunchSpan, graftSession, graftedIds, isEmptySession, isLciLaunch } from '../src/graft.ts';
import type { Session, Span } from '../src/model.ts';
import { flatten } from '../src/model.ts';
import { makeRoot, makeSpan } from '../src/parsers/util.ts';

const T0 = Date.parse('2026-09-01T10:00:00Z');
const at = (s: number) => T0 + s * 1000;

function tree(): { root: Span; turn1: Span; turn2: Span; launch: Span; other: Span } {
  const root = makeRoot('c', 'claude', at(0));
  root.endMs = at(600);
  const turn1 = makeSpan('turn', 'do the thing', at(0), at(100), 'root');
  const other = makeSpan('tool', 'Bash', at(5), at(6), null, { toolName: 'Bash', toolInput: '{"command":"ls -la"}' });
  const launch = makeSpan('tool', 'Bash', at(10), at(400), null, {
    toolName: 'Bash',
    toolInput: '{"command":"lci --goal-file goal.md"}',
    payload: { input: '{\n  "command": "lci --goal-file goal.md"\n}' },
    meta: { background: true },
  });
  const turn2 = makeSpan('turn', 'task: lci completed', at(400), at(410), 'root');
  turn1.children.push(other, launch);
  root.children.push(turn1, turn2);
  return { root, turn1, turn2, launch, other };
}

function child(id: string, start: number, end: number): Session {
  const root = makeRoot(id, `goal ${id}`, at(start));
  root.endMs = at(end);
  root.children.push(makeSpan('model', 'glm-5', at(start + 1), at(start + 2), 'root'));
  return { format: 'lci', id, title: `goal ${id}`, root, warnings: [] };
}

describe('isLciLaunch', () => {
  test('matches lci as a command word, not as a substring', () => {
    const { launch, other } = tree();
    expect(isLciLaunch(launch)).toBe(true);
    expect(isLciLaunch(other)).toBe(false);
    const sub = makeSpan('tool', 'Bash', 0, 1, null, { toolInput: '{"command":"cat calcify.ts"}' });
    expect(isLciLaunch(sub)).toBe(false);
    const piped = makeSpan('tool', 'Bash', 0, 1, null, { toolInput: '{"command":"cd x && lci --resume abc"}' });
    expect(isLciLaunch(piped)).toBe(true);
  });
});

describe('findLaunchSpan', () => {
  test('prefers the lci Bash call whose window contains the child start', () => {
    const { root, launch } = tree();
    expect(findLaunchSpan(root, at(12))).toBe(launch);
    // a child that started a hair before the tool record still counts
    expect(findLaunchSpan(root, at(8))).toBe(launch);
  });

  test('falls back to the active turn, then the root', () => {
    const { root, turn2, turn1, launch } = tree();
    expect(findLaunchSpan(root, at(420))).toBe(turn2);
    expect(findLaunchSpan(root, at(-100))).toBe(root);
    turn1.children.splice(turn1.children.indexOf(launch), 1);
    expect(findLaunchSpan(root, at(50))).toBe(turn1);
  });

  test('with two launches, the latest one that started before the child wins', () => {
    const { root, turn1 } = tree();
    const later = makeSpan('tool', 'Bash', at(20), at(300), null, { toolInput: '{"command":"lci --review"}' });
    turn1.children.push(later);
    expect(findLaunchSpan(root, at(25))).toBe(later);
    expect(findLaunchSpan(root, at(15))).not.toBe(later);
  });
});

describe('isEmptySession', () => {
  test('a root-only tree is empty; one with any span is not', () => {
    expect(isEmptySession(child('x', 0, 1))).toBe(false);
    const bare = child('y', 0, 1);
    bare.root.children = [];
    expect(isEmptySession(bare)).toBe(true);
  });
});

describe('graftSession', () => {
  test('nests the child root under the host with a unique id and harness meta', () => {
    const { root, launch } = tree();
    const c = child('abc', 11, 390);
    const grafted = graftSession(root, launch, c, { id: 'abc', path: 'p/transcript.jsonl', title: 'build it' });
    expect(launch.children).toContain(grafted);
    expect(grafted.id).toBe('lci:abc');
    expect(grafted.parentId).toBe(launch.id);
    expect(grafted.kind).toBe('session');
    expect(grafted.name).toBe('lci · build it');
    expect(grafted.meta?.harness).toBe('lci');
    expect(launch.meta?.spawned).toBe('lci');
    expect(flatten(root).some((s) => s.kind === 'model' && s.name === 'glm-5')).toBe(true);
    expect(graftedIds(root)).toEqual(new Set(['abc']));
  });

  test('widens only the root when the child outruns its host', () => {
    const { root, turn2 } = tree();
    const c = child('late', 405, 900);
    graftSession(root, turn2, c, { id: 'late', path: 'p', title: '' });
    expect(root.endMs).toBe(at(900));
    expect(turn2.endMs).toBe(at(410));
    expect(c.root.name).toBe('lci · goal late');
  });
});
