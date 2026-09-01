import { describe, expect, test } from 'bun:test';
import { cacheHitRate, durationMs, flatten, selfTimeMs, sumUsage, type Span } from '../src/model.ts';

const span = (id: string, startMs: number, endMs: number, children: Span[] = []): Span => ({
  id, parentId: null, kind: 'other', name: id, startMs, endMs, children,
});

describe('model helpers', () => {
  test('cacheHitRate', () => {
    expect(cacheHitRate({ input: 100, cacheRead: 800, cacheWrite: 100, output: 999 })).toBeCloseTo(0.8, 9);
    expect(cacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 0, output: 5 })).toBe(0);
  });
  test('selfTimeMs subtracts the union of overlapping children', () => {
    const p = span('p', 0, 100, [span('a', 10, 50), span('b', 30, 70), span('c', 60, 65)]);
    expect(selfTimeMs(p)).toBe(40);
    expect(selfTimeMs(span('leaf', 5, 9))).toBe(4);
  });
  test('selfTimeMs clamps children that spill outside the parent', () => {
    expect(selfTimeMs(span('p', 0, 100, [span('a', -50, 20), span('b', 90, 500)]))).toBe(70);
  });
  test('flatten, durationMs, sumUsage', () => {
    const p = span('p', 0, 10, [span('a', 1, 2), span('b', 3, 4, [span('c', 3, 3)])]);
    expect(flatten(p).map((s) => s.id)).toEqual(['p', 'a', 'b', 'c']);
    expect(durationMs(p)).toBe(10);
    const withUsage = [
      { ...span('x', 0, 1), usage: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4, reasoning: 1 } },
      { ...span('y', 0, 1), usage: { input: 10, cacheRead: 20, cacheWrite: 30, output: 40, cacheWrite1h: 30 } },
      span('z', 0, 1),
    ];
    expect(sumUsage(withUsage)).toMatchObject({ input: 11, cacheRead: 22, cacheWrite: 33, output: 44 });
  });
});
