import { describe, expect, test } from 'bun:test';
import { DEFAULT_PRICING, applyPricing, costOf, priceFor } from '../src/pricing.ts';
import { parseTranscript } from '../src/parsers/index.ts';
import { flatten, type Usage } from '../src/model.ts';

const u = (partial: Partial<Usage>): Usage => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, ...partial });
const M = 1_000_000;

describe('priceFor', () => {
  test('longest-prefix match strips date suffixes', () => {
    expect(priceFor('claude-opus-4-6-20260101')).toEqual(DEFAULT_PRICING['claude-opus-4-6']!);
    expect(priceFor('claude-sonnet-5')).toEqual(DEFAULT_PRICING['claude-sonnet-5']!);
    expect(priceFor('gpt-5-codex')?.input).toBe(1.25);
    expect(priceFor('gpt-5-mini')?.input).toBe(0.25); // not the shorter 'gpt-5'
  });
  test('unknown model → null', () => {
    expect(priceFor('totally-unknown-model')).toBeNull();
  });
});

describe('costOf', () => {
  test('input / output rates', () => {
    expect(costOf(u({ input: M }), 'claude-sonnet-5')).toBeCloseTo(2, 9);
    expect(costOf(u({ output: M }), 'claude-opus-5')).toBeCloseTo(25, 9);
  });
  test('Anthropic cache multipliers: read 0.1×, write 5m 1.25×, write 1h 2×', () => {
    expect(costOf(u({ cacheRead: M }), 'claude-opus-5')).toBeCloseTo(0.5, 9);
    expect(costOf(u({ cacheWrite: M, cacheWrite5m: M }), 'claude-opus-5')).toBeCloseTo(6.25, 9);
    expect(costOf(u({ cacheWrite: M, cacheWrite1h: M }), 'claude-opus-5')).toBeCloseTo(10, 9);
    expect(costOf(u({ cacheWrite: M }), 'claude-fable-5')).toBeCloseTo(12.5, 9); // unsplit write → 5m rate
  });
  test('OpenAI cached input is 0.1× input and writes are free', () => {
    expect(costOf(u({ cacheRead: M }), 'gpt-5')).toBeCloseTo(0.125, 9);
    expect(costOf(u({ cacheWrite: M }), 'gpt-5')).toBeCloseTo(0, 9);
  });
  test('unknown model costs 0', () => {
    expect(costOf(u({ input: M, output: M }), 'mystery')).toBe(0);
  });
});

describe('applyPricing', () => {
  test('fills costUsd on model spans, rolls up, and warns once per unknown model', async () => {
    const text = await Bun.file(new URL('./fixtures/claude-code.jsonl', import.meta.url)).text();
    const s = parseTranscript(text, 'cc.jsonl');
    applyPricing(s, DEFAULT_PRICING);
    const models = flatten(s.root).filter((x) => x.kind === 'model');
    expect(models.every((m) => typeof m.costUsd === 'number' && Number.isFinite(m.costUsd))).toBe(true);
    const total = models.reduce((a, m) => a + (m.costUsd ?? 0), 0);
    expect(total).toBeGreaterThan(0);
    expect(s.root.meta?.costRollupUsd).toBeCloseTo(total, 9);
    expect(s.warnings.filter((w) => /no pricing/.test(w))).toHaveLength(0);

    const lci = parseTranscript(
      JSON.stringify({ at: '2026-01-01T00:00:01.000Z', type: 'event', kind: 'inference', iteration: 1, data: { model: 'mystery-9', promptTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0, completionTokens: 1, latencyMs: 5 } }) + '\n' +
      JSON.stringify({ at: '2026-01-01T00:00:02.000Z', type: 'event', kind: 'inference', iteration: 1, data: { model: 'mystery-9', promptTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0, completionTokens: 1, latencyMs: 5 } }),
      'x.jsonl',
    );
    applyPricing(lci, DEFAULT_PRICING);
    expect(flatten(lci.root).filter((x) => x.kind === 'model').map((m) => m.costUsd)).toEqual([0, 0]);
    expect(lci.warnings.filter((w) => w === 'no pricing for mystery-9')).toHaveLength(1);
  });
});
