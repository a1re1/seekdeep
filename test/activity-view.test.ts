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

import { columnFor, durationCohorts, sessionColorFor, sessionSpendStack } from '../src/ui/activity-view.ts';
import type { UsageBucket } from '../src/stats.ts';

function sb(hourMs: number, sessionId: string | undefined, over: Partial<UsageBucket> = {}): UsageBucket {
  return {
    hourMs,
    model: 'm',
    requests: 1,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: 0,
    reasoning: 0,
    latencyMs: 0,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...over,
  };
}

const PALETTE = ['var(--a)', 'var(--b)', 'var(--c)'];

/** Columns [0, 1000, 2000] and the window aggregate() would build for them. */
const COLS = [0, 1000, 2000];
const COLS_RANGE = { startMs: 0, endMs: 3000, stepMs: 1000 };

describe('sessionSpendStack', () => {
  const columns = COLS;

  test('stacks one segment per session per column, absent sessions contribute 0', () => {
    const stack = sessionSpendStack(
      columns,
      [sb(0, 'a', { input: 1 }), sb(0, 'b', { input: 2 }), sb(1000, 'a', { input: 5 })],
      (b) => b.input,
      COLS_RANGE,
    );
    expect(stack.sessions).toEqual(['a', 'b']);
    const a = stack.values[stack.sessions.indexOf('a')]!;
    const b = stack.values[stack.sessions.indexOf('b')]!;
    expect(a).toEqual([1, 5, 0]);
    expect(b).toEqual([2, 0, 0]); // absent from the later columns, contributes nothing
    expect(stack.totals).toEqual([3, 5, 0]);
  });

  test('column totals equal the sum of that column\'s segments (spend conservation)', () => {
    const stack = sessionSpendStack(columns, [sb(0, 'a', { input: 4 }), sb(0, 'b', { input: 6 })], (b) => b.input, COLS_RANGE);
    for (let c = 0; c < columns.length; c += 1) {
      const segs = stack.values.reduce((acc, row) => acc + (row[c] ?? 0), 0);
      expect(segs).toBeCloseTo(stack.totals[c] ?? 0, 9);
    }
  });

  test('buckets without a sessionId are not given a segment', () => {
    const stack = sessionSpendStack(columns, [sb(0, undefined, { input: 9 })], (b) => b.input, COLS_RANGE);
    expect(stack.sessions).toEqual([]);
    expect(stack.totals).toEqual([0, 0, 0]);
  });

  test('a timestamp at or past the range end is dropped, never clamped into the last column', () => {
    // 3000 is exactly range.endMs and 9999 is far past it: neither has a column
    // of its own, so columnFor alone would fold both into column 2 and that
    // column would claim spend the range does not contain.
    const stack = sessionSpendStack(
      columns,
      [sb(2000, 'a', { input: 3 }), sb(3000, 'b', { input: 7 }), sb(9999, 'b', { input: 5 })],
      (b) => b.input,
      COLS_RANGE,
    );
    expect(stack.sessions).toEqual(['a']);
    expect(stack.totals).toEqual([0, 0, 3]);
  });

  test('every timestamp the range does own still lands, the last column included', () => {
    // 2999 sits inside the final column's own hour: only the exclusive end is out.
    const stack = sessionSpendStack(columns, [sb(2000, 'a', { input: 3 }), sb(2999, 'a', { input: 4 })], (b) => b.input, COLS_RANGE);
    expect(stack.sessions).toEqual(['a']);
    expect(stack.totals).toEqual([0, 0, 7]);
  });
});

describe('sessionColorFor', () => {
  test('is stable per session and differs between sessions', () => {
    expect(sessionColorFor('claude:a', PALETTE)).toBe(sessionColorFor('claude:a', PALETTE));
    expect(sessionColorFor('claude:a', PALETTE)).not.toBe(sessionColorFor('upload:b', PALETTE));
    expect(PALETTE).toContain(sessionColorFor('anything', PALETTE));
    expect(sessionColorFor('anything', [])).toBe('currentColor');
  });
});

describe('durationCohorts', () => {
  const columns = [0, 1000, 2000];

  test('means are per start column and unknown durations are excluded but counted', () => {
    const cohorts = durationCohorts(columns, [
      sb(0, 'a', { sessionStartedMs: 10, sessionDurationMs: 100 }),
      sb(0, 'b', { sessionStartedMs: 20, sessionDurationMs: 300 }),
      sb(1000, 'c', { sessionStartedMs: 1010, sessionDurationMs: 1000 }),
      sb(1000, 'd', { sessionStartedMs: 1020 }), // no usable duration
    ], COLS_RANGE);
    expect(cohorts.perColumn).toEqual([200, 1000, null]);
    expect(cohorts.counted).toBe(3);
    expect(cohorts.excluded).toBe(1);
    expect(cohorts.overallMs).toBeCloseTo((100 + 300 + 1000) / 3, 9);
  });

  test('an empty cohort stays null so the panel can print an en dash, not a zero bar', () => {
    const cohorts = durationCohorts(columns, [sb(0, 'a', { sessionStartedMs: 0, sessionDurationMs: 42 })], COLS_RANGE);
    expect(cohorts.perColumn[1]).toBeNull();
    expect(cohorts.perColumn[2]).toBeNull();
    expect(durationCohorts(columns, [], COLS_RANGE).overallMs).toBeNull();
    expect(durationCohorts(columns, [], COLS_RANGE).counted).toBe(0);
  });

  test('a session that started past the range end contributes neither a cohort nor an exclusion', () => {
    // Its bucket has no column in this window, so it is not a session of the
    // range at all: its elapsed time must never reach the headline mean, and it
    // is not an "unmeasurable in range" exclusion either.
    const cohorts = durationCohorts(columns, [
      sb(0, 'a', { sessionStartedMs: 10, sessionDurationMs: 100 }),
      sb(3000, 'claude:future', { sessionStartedMs: 3000, sessionDurationMs: 5_000_000 }),
      sb(9999, 'claude:future', { sessionStartedMs: 9999, sessionDurationMs: 5_000_000 }),
    ], COLS_RANGE);
    expect(cohorts.counted).toBe(1);
    expect(cohorts.overallMs).toBe(100);
    expect(cohorts.excluded).toBe(0);
    expect(cohorts.perColumn).toEqual([100, null, null]);
  });

  test('the overall mean and the exclusion tally stay inside the filtered range', () => {
    // `columns` IS the filtered range: this is a 48h hourly window ending at
    // NOW. A session that ran three days ago has its buckets outside it — the
    // same ones aggregate() drops from its columns — so it contributes no
    // cohort, is never averaged into the headline, and is not tallied as an
    // excluded "unmeasurable" session either.
    const NOW = Date.parse('2026-09-01T15:30:00Z');
    const HOUR = 3_600_000;
    const h = Math.floor(NOW / HOUR) * HOUR;
    const window = Array.from({ length: 48 }, (_, i) => h - 47 * HOUR + i * HOUR);
    // The legacy 48h window ends at the NEXT hour boundary, so its exclusive end
    // is h + HOUR — the final column itself is inside it.
    const windowRange = { startMs: window[0]!, endMs: h + HOUR, stepMs: HOUR };
    const cohorts = durationCohorts(window, [
      sb(h, 'claude:today', { sessionStartedMs: NOW - 60_000, sessionDurationMs: 60_000 }),
      sb(h - 72 * HOUR, 'claude:old', { sessionStartedMs: NOW - 72 * HOUR, sessionDurationMs: 6_000_000 }),
    ], windowRange);
    expect(cohorts.counted).toBe(1); // only the in-range session
    expect(cohorts.overallMs).toBe(60_000); // the 72h-old duration is never averaged in
    expect(cohorts.excluded).toBe(0); // out of range is not "no measurable duration"
    expect(cohorts.perColumn[47]).toBe(60_000);
    expect(cohorts.perColumn.every((v, i) => i === 47 || v === null)).toBe(true);
  });
});

describe('columnFor', () => {
  test('picks the latest column at or before the timestamp', () => {
    expect(columnFor([0, 1000, 2000], 0)).toBe(0);
    expect(columnFor([0, 1000, 2000], 1500)).toBe(1);
    expect(columnFor([0, 1000, 2000], 9999)).toBe(2);
    expect(columnFor([1000, 2000], 999)).toBe(-1);
  });
});

import { bucketSpend, sessionLabel } from '../src/ui/activity-view.ts';
import { DEFAULT_PRICING } from '../src/pricing.ts';

describe('sessionLabel', () => {
  test('shortens a source-qualified id to its transcript stem', () => {
    expect(sessionLabel('claude:/a/b/session.jsonl')).toBe('session');
    expect(sessionLabel('upload:my-drop.jsonl')).toBe('my-drop');
    expect(sessionLabel('codex:plain')).toBe('plain');
    expect(sessionLabel('weird')).toBe('weird');
  });
});

describe('bucketSpend', () => {
  test('prices a bucket the way the pricing table does, per request', () => {
    // opus: $5/M input, $25/M output, 1 request.
    const b = sb(0, 'claude:a', { model: 'claude-opus-5', input: 1_000_000, output: 0 });
    expect(bucketSpend(b, DEFAULT_PRICING)).toBeCloseTo(5, 9);
    // Astra's long-context tier is judged per request, so 10 calls of 100K each
    // stay under the threshold exactly as aggregate() prices them.
    const spread = sb(0, 'claude:a', { model: 'gpt-6-astra', requests: 10, input: 1_000_000 });
    expect(bucketSpend(spread, DEFAULT_PRICING)).toBeCloseTo(10, 9);
    // One call of the same size crosses it: 2x input.
    const single = sb(0, 'claude:a', { model: 'gpt-6-astra', requests: 1, input: 1_000_000 });
    expect(bucketSpend(single, DEFAULT_PRICING)).toBeCloseTo(20, 9);
    // An unknown model prices at 0, exactly like aggregate().
    expect(bucketSpend(sb(0, 'claude:a', { model: 'no-such-model', input: 1_000_000 }), DEFAULT_PRICING)).toBe(0);
  });
});

import { aggregate, rangeFor } from '../src/stats.ts';

describe('session spend conservation against aggregate', () => {
  test('priced session segments sum to the aggregate column total, long-context tier included', () => {
    const NOW = Date.parse('2026-09-01T15:30:00Z');
    const HOUR = 3_600_000;
    const h = Math.floor(NOW / HOUR) * HOUR;
    const buckets = [
      sb(h, 'claude:a', { model: 'gpt-6-astra', requests: 10, input: 1_000_000, output: 10_000 }),
      sb(h, 'upload:b', { model: 'gpt-6-astra', requests: 1, input: 1_000_000, output: 10_000 }),
    ];
    const range = rangeFor('48h', NOW, buckets);
    const agg = aggregate(buckets, DEFAULT_PRICING, range);
    const col = agg.columns.indexOf(h);
    expect(col).toBeGreaterThanOrEqual(0);
    const stack = sessionSpendStack(agg.columns, buckets, (b) => bucketSpend(b, DEFAULT_PRICING), range);
    // 10 calls of 100K avg stay under Astra's threshold ($10.50); one 1M call
    // crosses it ($20.75) — the same per-request rule aggregate() prices with.
    expect(stack.totals[col]).toBeCloseTo(10.5 + 20.75, 9);
    const whole = agg.series.costUsd.reduce((acc, row) => acc + (row[col] ?? 0), 0);
    expect(stack.totals[col]).toBeCloseTo(whole, 9);
    expect(stack.sessions).toEqual(['claude:a', 'upload:b']);
  });
});

// The stack and aggregate() must agree on WHICH buckets the range owns: a
// future-dated bucket belongs to neither, so no column ever claims spend the
// range does not contain (the clamp regression this pins).
describe('session spend conservation against aggregate with a future bucket', () => {
  test('a future-dated bucket is dropped by both, so every column total matches aggregate', () => {
    const NOW = Date.parse('2026-09-01T15:30:00Z');
    const HOUR = 3_600_000;
    const h = Math.floor(NOW / HOUR) * HOUR;
    const buckets = [
      sb(h, 'claude:a', { model: 'claude-opus-5', input: 1_000_000 }),
      sb(h + 6 * HOUR, 'claude:future', { model: 'claude-opus-5', input: 1_000_000 }), // past the 48h window's end
    ];
    const range = rangeFor('48h', NOW, buckets);
    const agg = aggregate(buckets, DEFAULT_PRICING, range);
    const stack = sessionSpendStack(agg.columns, buckets, (b) => bucketSpend(b, DEFAULT_PRICING), range);
    expect(stack.sessions).toEqual(['claude:a']);
    for (let c = 0; c < agg.columns.length; c += 1) {
      const colCost = agg.series.costUsd.reduce((acc, row) => acc + (row[c] ?? 0), 0);
      expect(stack.totals[c]).toBeCloseTo(colCost, 9);
    }
    expect(stack.totals.reduce((acc, v) => acc + v, 0)).toBeCloseTo(agg.totals.costUsd, 9);
  });
});
