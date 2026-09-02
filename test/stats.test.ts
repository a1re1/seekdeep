import { describe, expect, test } from 'bun:test';
import type { Session, Span } from '../src/model.ts';
import { DEFAULT_PRICING } from '../src/pricing.ts';
import { makeRoot, makeSpan } from '../src/parsers/util.ts';
import { aggregate, bucketSession, mergeBuckets, rangeFor } from '../src/stats.ts';
import type { UsageBucket } from '../src/stats.ts';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-09-01T15:30:00Z');

function modelSpan(model: string, startMs: number, durMs: number, usage: Span['usage']): Span {
  return makeSpan('model', model, startMs, startMs + durMs, 'root', { model, usage });
}

function session(spans: Span[]): Session {
  const root = makeRoot('s', 's', spans[0]?.startMs ?? 0);
  root.children.push(...spans);
  root.endMs = Math.max(...spans.map((s) => s.endMs), root.startMs);
  return { format: 'generic', id: 's', title: 's', root, warnings: [] };
}

function bucket(hourMs: number, model: string, over: Partial<UsageBucket> = {}): UsageBucket {
  return { hourMs, model, requests: 1, input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, reasoning: 0, latencyMs: 0, ...over };
}

describe('bucketSession', () => {
  test('sums usage per (UTC hour, model) and counts requests', () => {
    const t = Date.parse('2026-09-01T10:15:00Z');
    const s = session([
      modelSpan('claude-opus-5', t, 1000, { input: 10, cacheRead: 100, cacheWrite: 5, output: 20, reasoning: 4 }),
      modelSpan('claude-opus-5', t + 20 * 60_000, 3000, { input: 1, cacheRead: 200, cacheWrite: 0, output: 30 }),
      modelSpan('glm-5.3-flash', t + HOUR, 500, { input: 50, cacheRead: 0, cacheWrite: 0, output: 5 }),
    ]);
    const buckets = bucketSession(s).sort((a, b) => a.hourMs - b.hourMs);
    expect(buckets).toHaveLength(2);
    const opus = buckets[0]!;
    expect(opus.hourMs).toBe(Math.floor(t / HOUR) * HOUR);
    expect(opus.requests).toBe(2);
    expect(opus.input).toBe(11);
    expect(opus.cacheRead).toBe(300);
    expect(opus.output).toBe(50);
    expect(opus.reasoning).toBe(4);
    expect(opus.latencyMs).toBe(4000);
    expect(buckets[1]!.model).toBe('glm-5.3-flash');
  });

  test('keeps the 5m/1h cache-write split and the first provider seen', () => {
    const t = Date.parse('2026-09-01T10:15:00Z');
    const a = modelSpan('claude-opus-5', t, 1000, { input: 0, cacheRead: 0, cacheWrite: 300, cacheWrite5m: 100, cacheWrite1h: 200, output: 0 });
    a.provider = 'anthropic';
    const b = modelSpan('claude-opus-5', t + 1000, 1000, { input: 0, cacheRead: 0, cacheWrite: 50, output: 0 });
    b.provider = 'bedrock';
    const [bucket] = bucketSession(session([a, b]));
    expect(bucket!.cacheWrite).toBe(350);
    expect(bucket!.cacheWrite5m).toBe(100);
    expect(bucket!.cacheWrite1h).toBe(200);
    expect(bucket!.provider).toBe('anthropic');
    const merged = mergeBuckets([[bucket!], [{ ...bucket!, provider: 'other', cacheWrite1h: 5 }]]);
    expect(merged[0]!.cacheWrite1h).toBe(205);
    expect(merged[0]!.provider).toBe('anthropic');
  });

  test('mergeBuckets sums matching keys across sessions', () => {
    const h = Math.floor(NOW / HOUR) * HOUR;
    const merged = mergeBuckets([[bucket(h, 'm', { input: 1 })], [bucket(h, 'm', { input: 2 }), bucket(h, 'n')]]);
    expect(merged).toHaveLength(2);
    expect(merged.find((b) => b.model === 'm')?.input).toBe(3);
    expect(merged.find((b) => b.model === 'm')?.requests).toBe(2);
  });
});

describe('rangeFor', () => {
  test('48h gives 48 hourly columns ending after the current hour', () => {
    const r = rangeFor('48h', NOW, []);
    expect(r.stepMs).toBe(HOUR);
    expect(r.endMs).toBe(Math.floor(NOW / HOUR) * HOUR + HOUR);
    expect((r.endMs - r.startMs) / HOUR).toBe(48);
    expect(aggregate([], DEFAULT_PRICING, r).columns).toHaveLength(48);
  });

  test('7d and all use local-day steps; all starts at the earliest bucket', () => {
    const r7 = rangeFor('7d', NOW, []);
    expect(aggregate([], DEFAULT_PRICING, r7).columns).toHaveLength(7);
    const early = NOW - 20 * 24 * HOUR;
    const all = rangeFor('all', NOW, [bucket(Math.floor(early / HOUR) * HOUR, 'm')]);
    expect(all.startMs).toBeLessThanOrEqual(early);
    expect(aggregate([], DEFAULT_PRICING, all).columns.length).toBeGreaterThanOrEqual(20);
  });
});

describe('aggregate', () => {
  const r = rangeFor('48h', NOW, []);
  const h = Math.floor(NOW / HOUR) * HOUR;

  test('places buckets in the right column, sorts models by cost, and prices them', () => {
    const buckets = [
      bucket(h - 5 * HOUR, 'claude-haiku-4-5', { input: 1_000_000 }), // $1
      bucket(h - 2 * HOUR, 'claude-opus-5', { input: 1_000_000, requests: 3 }), // $5
    ];
    const a = aggregate(buckets, DEFAULT_PRICING, r);
    expect(a.models).toEqual(['claude-opus-5', 'claude-haiku-4-5']);
    const col = a.columns.indexOf(h - 2 * HOUR);
    expect(col).toBeGreaterThan(0);
    expect(a.series.costUsd[0]![col]).toBeCloseTo(5, 6);
    expect(a.series.requests[0]![col]).toBe(3);
    expect(a.totals.costUsd).toBeCloseTo(6, 6);
    expect(a.totals.requests).toBe(4);
    expect(a.sparkline.costUsd).toHaveLength(48);
  });

  test('token volume counts reasoning inside output, not on top of it', () => {
    const a = aggregate([bucket(h, 'claude-opus-5', { input: 100, output: 50, reasoning: 20 })], DEFAULT_PRICING, r);
    expect(a.totals.tokens).toBe(150);
    const col = a.columns.indexOf(h);
    expect(a.tokens.completion[col]).toBe(30);
    expect(a.tokens.reasoning[col]).toBe(20);
    expect(a.perModel[0]!.outputTokens).toBe(50);
  });

  test('cacheHit, blendedPerM, effectivePerM and previous-period delta', () => {
    const cur = bucket(h - HOUR, 'claude-opus-5', { input: 250_000, cacheRead: 750_000, output: 0 });
    const prev = bucket(h - 60 * HOUR, 'claude-opus-5', { input: 500_000 });
    const a = aggregate([cur, prev], DEFAULT_PRICING, r);
    expect(a.totals.cacheHit).toBeCloseTo(0.75, 6);
    // opus: $5/M input, $0.50/M cache read → 0.25*5 + 0.75*0.5 = 1.625 for 1M tokens
    expect(a.totals.costUsd).toBeCloseTo(1.625, 6);
    expect(a.totals.blendedPerM).toBeCloseTo(1.625, 6);
    expect(a.perModel[0]!.effectivePerM).toBeCloseTo(a.perModel[0]!.costUsd / (a.perModel[0]!.tokens / 1e6), 9);
    expect(a.previous.costUsd).toBeCloseTo(2.5, 6);
    expect(a.delta.costUsd).toBeCloseTo((1.625 - 2.5) / 2.5, 6);
    expect(a.delta.requests).toBe(0);
    expect(Number.isNaN(aggregate([cur], DEFAULT_PRICING, r).delta.costUsd)).toBe(true);
  });

  test('prices with the table it is given, including 1h cache writes', () => {
    const b = bucket(h, 'claude-opus-5', { cacheWrite: 1_000_000, cacheWrite1h: 1_000_000 });
    const byDefault = aggregate([b], DEFAULT_PRICING, r);
    expect(byDefault.totals.costUsd).toBeCloseTo(DEFAULT_PRICING['claude-opus-5']!.cacheWrite1h, 6);
    const custom = { ...DEFAULT_PRICING, 'claude-opus-5': { ...DEFAULT_PRICING['claude-opus-5']!, cacheWrite1h: 1, input: 42 } };
    const byCustom = aggregate([b], custom, r);
    expect(byCustom.totals.costUsd).toBeCloseTo(1, 6);
    expect(byCustom.perModel[0]!.inputPrice).toBe(42);
  });

  test('per-model rows carry latency and throughput', () => {
    const a = aggregate([bucket(h, 'claude-opus-5', { requests: 2, output: 400, latencyMs: 4000 })], DEFAULT_PRICING, r);
    expect(a.perModel[0]!.avgLatencyMs).toBe(2000);
    expect(a.perModel[0]!.outputTokSec).toBe(100);
    expect(a.perModel[0]!.inputPrice).toBe(5);
    expect(a.perModel[0]!.outputPrice).toBe(25);
  });
});
