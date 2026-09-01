import { describe, expect, test } from 'bun:test';
import type { Span } from '../src/model.ts';
import { autoCollapsed, flattenRows, tickStep } from '../src/ui/trace.ts';

const span = (id: string, startMs: number, endMs: number, children: Span[] = []): Span => ({
  id, parentId: null, kind: 'other', name: id, startMs, endMs, children,
});

describe('flattenRows', () => {
  const tree = span('root', 0, 100, [
    span('b', 50, 60, [span('b1', 52, 54)]),
    span('a', 10, 40, [span('a2', 30, 35), span('a1', 12, 20)]),
    span('c', 70, 80),
  ]);

  test('pre-order, siblings sorted by start time, depth tracked', () => {
    const rows = flattenRows(tree, new Set());
    expect(rows.map((r) => r.span.id)).toEqual(['root', 'a', 'a1', 'a2', 'b', 'b1', 'c']);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 2, 1, 2, 1]);
    expect(rows.map((r) => r.hasChildren)).toEqual([true, true, false, false, true, false, false]);
  });

  test('collapsed spans hide their descendants but stay listed', () => {
    const rows = flattenRows(tree, new Set(['a']));
    expect(rows.map((r) => r.span.id)).toEqual(['root', 'a', 'b', 'b1', 'c']);
  });

  test('collapsing the root leaves a single row', () => {
    expect(flattenRows(tree, new Set(['root']))).toHaveLength(1);
  });
});

describe('autoCollapsed', () => {
  test('only spans with more than 300 direct children start collapsed', () => {
    const many = span('many', 0, 1000, Array.from({ length: 301 }, (_, i) => span(`k${i}`, i, i + 1)));
    const few = span('few', 0, 10, [span('x', 1, 2)]);
    const root = span('root', 0, 1000, [many, few]);
    expect([...autoCollapsed(root)]).toEqual(['many']);
  });
});

describe('tickStep', () => {
  test('picks a nice step yielding at most ~8 ticks', () => {
    expect(tickStep(20_000)).toBe(5_000);
    expect(tickStep(17 * 60_000)).toBe(5 * 60_000);
    expect(tickStep(500)).toBe(100);
    for (const spanMs of [1, 999, 60_000, 3_600_000, 86_400_000 * 3]) {
      expect(spanMs / tickStep(spanMs)).toBeLessThanOrEqual(8);
    }
  });
});
