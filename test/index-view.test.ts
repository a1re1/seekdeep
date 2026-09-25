import { describe, expect, test } from 'bun:test';
import { nodeWithinRange, rangeCutoffMs, withinRange } from '../src/ui/index-view.ts';
import type { RangeNode } from '../src/ui/index-view.ts';
import { presetStartMs, RANGE_PRESETS } from '../src/stats.ts';

// Non-hour-aligned "now" so the floored-boundary math is actually exercised.
const NOW = Date.parse('2026-09-01T15:30:00Z');

describe('picker range cutoff (rangeCutoffMs/withinRange)', () => {
  test("'all' has no cutoff and admits sessions of any age", () => {
    expect(rangeCutoffMs('all', NOW)).toBeNull();
    expect(withinRange({ startMs: 0 }, 'all', NOW)).toBe(true);
  });

  test('sub-48h presets cut off at the floored hour, N hours back', () => {
    expect(rangeCutoffMs('1h', NOW)).toBe(Date.parse('2026-09-01T14:00:00Z'));
    expect(rangeCutoffMs('3h', NOW)).toBe(Date.parse('2026-09-01T12:00:00Z'));
    expect(rangeCutoffMs('6h', NOW)).toBe(Date.parse('2026-09-01T09:00:00Z'));
    expect(rangeCutoffMs('12h', NOW)).toBe(Date.parse('2026-09-01T03:00:00Z'));
    expect(rangeCutoffMs('24h', NOW)).toBe(Date.parse('2026-08-31T15:00:00Z'));
  });

  test('the cutoff is inclusive: a session starting exactly at it matches', () => {
    const cutoff = rangeCutoffMs('1h', NOW) as number;
    expect(withinRange({ startMs: cutoff }, '1h', NOW)).toBe(true);
    expect(withinRange({ startMs: cutoff - 1 }, '1h', NOW)).toBe(false);
  });

  test('every preset delegates to presetStartMs', () => {
    for (const [preset] of RANGE_PRESETS) {
      expect(rangeCutoffMs(preset, NOW)).toBe(preset === 'all' ? null : presetStartMs(preset, NOW));
    }
  });
});

describe('picker node retention (nodeWithinRange)', () => {
  // Cutoff = rangeCutoffMs('1h', NOW) = 14:00Z; sessions at/after it are in range.
  const cutoff = Date.parse('2026-09-01T14:00:00Z');
  const node = (startMs: number, children: RangeNode[] = []): RangeNode => ({ entry: { startMs }, children });

  test('a node starting exactly at the cutoff (inclusive bound) is kept', () => {
    expect(nodeWithinRange(node(cutoff), cutoff)).toBe(true);
  });

  test('a node a hair before the cutoff with no children is dropped', () => {
    expect(nodeWithinRange(node(cutoff - 1), cutoff)).toBe(false);
  });

  test('an old parent is retained when any nested child starts in range', () => {
    expect(nodeWithinRange(node(cutoff - 1, [node(cutoff - 1), node(cutoff)]), cutoff)).toBe(true);
  });

  test('an old parent with only old children is dropped', () => {
    expect(nodeWithinRange(node(cutoff - 1, [node(cutoff - 2), node(cutoff - 3)]), cutoff)).toBe(false);
  });

  test('a new parent is retained even when every child is old', () => {
    expect(nodeWithinRange(node(cutoff, [node(cutoff - 2), node(cutoff - 3)]), cutoff)).toBe(true);
  });

  test('a null cutoff (all) keeps nodes of any age', () => {
    expect(nodeWithinRange(node(0, [node(0)]), null)).toBe(true);
  });
});
