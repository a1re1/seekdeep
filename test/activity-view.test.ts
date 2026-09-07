import { describe, expect, test } from 'bun:test';
import {
  harnessMatches,
  harnessTriggerLabel,
  modelSeries,
  reconcileHarnessSelection,
  toggleHarness,
} from '../src/ui/activity-view.ts';
import { RANGE_PRESETS } from '../src/stats.ts';

describe('modelSeries', () => {
  test('gives each model its own per-column values (series is [model][column])', () => {
    const series = { costUsd: [[1, 2, 3], [10, 20, 30]], requests: [[1, 1, 1], [2, 2, 2]], tokens: [[5, 5, 5], [6, 6, 6]] };
    const out = modelSeries({ models: ['a', 'b'], series }, (s) => s.costUsd);
    expect(out.map((r) => r.name)).toEqual(['a', 'b']);
    expect(out[0]!.values).toEqual([1, 2, 3]);
    expect(out[1]!.values).toEqual([10, 20, 30]);
    expect(out[0]!.color).not.toBe(out[1]!.color);
  });
});

describe('harnessTriggerLabel', () => {
  const available = ['gauntlet', 'codex', 'other'];

  test('null selection summarizes as all harnesses', () => {
    expect(harnessTriggerLabel(null, available)).toBe('All harnesses');
  });

  test('a selection covering every available harness also reads as all', () => {
    expect(harnessTriggerLabel(['gauntlet', 'codex', 'other'], available)).toBe('All harnesses');
  });

  test('one selected harness shows its name', () => {
    expect(harnessTriggerLabel(['codex'], available)).toBe('codex');
  });

  test('multiple selected harnesses show a count', () => {
    expect(harnessTriggerLabel(['gauntlet', 'other'], available)).toBe('2 harnesses');
  });

  test('empty selection reads as none', () => {
    expect(harnessTriggerLabel([], available)).toBe('No harnesses');
  });
});

describe('toggleHarness', () => {
  const available = ['gauntlet', 'codex', 'other'];

  test('toggling within the all-selected state derives the subset without it', () => {
    expect(toggleHarness(null, 'codex', available)).toEqual(['gauntlet', 'other']);
  });

  test('toggling the only harness keeps the all-selected state', () => {
    expect(toggleHarness(null, 'gauntlet', ['gauntlet'])).toBeNull();
  });

  test('toggling a missing harness adds it', () => {
    expect(toggleHarness(['gauntlet'], 'other', available)).toEqual(['gauntlet', 'other']);
  });

  test('toggling a chosen harness removes it', () => {
    expect(toggleHarness(['gauntlet', 'other'], 'gauntlet', available)).toEqual(['other']);
  });

  test('removing the last choice normalizes back to all-selected', () => {
    expect(toggleHarness(['gauntlet'], 'gauntlet', available)).toBeNull();
  });

  test('adding every remaining harness normalizes back to all-selected', () => {
    expect(toggleHarness(['gauntlet', 'codex'], 'other', available)).toBeNull();
  });
});

describe('harnessMatches', () => {
  test('all-selected matches every bucket', () => {
    expect(harnessMatches(null, 'gauntlet')).toBe(true);
    expect(harnessMatches(null, 'codex')).toBe(true);
    expect(harnessMatches(null, undefined)).toBe(true);
  });

  test('a subset matches its own buckets with OR semantics', () => {
    const selected = ['gauntlet', 'other'];
    expect(harnessMatches(selected, 'gauntlet')).toBe(true);
    expect(harnessMatches(selected, 'other')).toBe(true);
    expect(harnessMatches(selected, 'codex')).toBe(false);
    expect(harnessMatches(selected, undefined)).toBe(true);
  });

  test('a subset without “other” rejects buckets without a harness', () => {
    expect(harnessMatches(['gauntlet'], undefined)).toBe(false);
  });
});

describe('reconcileHarnessSelection', () => {
  test('all-selected stays all-selected so newly discovered harnesses are included', () => {
    expect(reconcileHarnessSelection(null, ['gauntlet', 'fresh'])).toBeNull();
  });

  test('stale harnesses are dropped from an explicit subset, order normalized to available', () => {
    expect(reconcileHarnessSelection(['fresh', 'gauntlet', 'gone'], ['gauntlet', 'fresh', 'codex'])).toEqual(['gauntlet', 'fresh']);
  });

  test('a subset that ends up covering everything collapses back to all-selected', () => {
    expect(reconcileHarnessSelection(['gauntlet', 'gone'], ['gauntlet'])).toBeNull();
  });

  test('a subset whose harnesses all vanished collapses back to all-selected', () => {
    expect(reconcileHarnessSelection(['gone'], ['gauntlet', 'codex'])).toBeNull();
  });

  test('no available harnesses means all-selected', () => {
    expect(reconcileHarnessSelection(['gauntlet'], [])).toBeNull();
  });
});

describe('activity range presets (toolbar select options)', () => {
  test('the range select offers the eight presets in display order with the agreed labels', () => {
    const options: ReadonlyArray<readonly [string, string]> = RANGE_PRESETS.map(([preset, label]) => [preset, label]);
    expect(options).toEqual([
      ['1h', 'Past hour'],
      ['3h', 'Past 3 hours'],
      ['6h', 'Past 6 hours'],
      ['24h', 'Past 24 hours'],
      ['48h', 'Past 48 hours'],
      ['7d', 'Past 7 days'],
      ['30d', 'Past 30 days'],
      ['all', 'All time'],
    ]);
  });

  test('the toolbar default preset is among the offered options', () => {
    expect(RANGE_PRESETS.some(([preset]) => preset === '48h')).toBe(true);
  });
});
