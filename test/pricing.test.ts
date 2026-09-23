import { describe, expect, test } from 'bun:test';
import { DEFAULT_PRICING, PRICE_FIELDS, applyPricing, costOf, mergePricing, priceFor } from '../src/pricing.ts';
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
  test('gpt-6-astra matches its own row, not gpt-5', () => {
    expect(priceFor('gpt-6-astra')).toEqual(DEFAULT_PRICING['gpt-6-astra']!);
    expect(priceFor('gpt-6-astra-2026-08-01')).toEqual(DEFAULT_PRICING['gpt-6-astra']!);
    expect(priceFor('openai/gpt-6-astra')).toEqual(DEFAULT_PRICING['gpt-6-astra']!);
  });
  test('provider-prefixed model names fall back to the bare name', () => {
    expect(priceFor('anthropic/claude-opus-5')).toEqual(DEFAULT_PRICING['claude-opus-5']!);
    expect(priceFor('z-ai/glm-5.3-flash')).toEqual(DEFAULT_PRICING['glm-5.3-flash']!);
    // The non-flash row must not swallow the flash names (longest prefix wins) and vice versa.
    expect(priceFor('z-ai/glm-5.3')).toEqual(DEFAULT_PRICING['glm-5.3']!);
    expect(priceFor('glm-5-3')).toEqual(DEFAULT_PRICING['glm-5.3']!);
    expect(priceFor('z-ai/glm-5.3')!.input).toBe(1.17);
    expect(priceFor('openai/gpt-5-mini')?.input).toBe(0.25); // not the shorter 'gpt-5'
  });
  test('`.` and `-` are equivalent in keys and model names', () => {
    expect(priceFor('glm-5-3-flash')).toEqual(DEFAULT_PRICING['glm-5.3-flash']!);
    expect(priceFor('glm-5.3-flash-20260101')).toEqual(DEFAULT_PRICING['glm-5.3-flash']!);
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
  test('gpt-6-astra: $10/$50, cached input $1, cache writes billed at 1.25x input', () => {
    const K = 100_000; // under the 272K long-context threshold; rates are per 1M
    expect(costOf(u({ input: K }), 'gpt-6-astra')).toBeCloseTo(1, 9);
    expect(costOf(u({ output: M }), 'gpt-6-astra')).toBeCloseTo(50, 9); // no prompt, no tier
    expect(costOf(u({ cacheRead: K }), 'gpt-6-astra')).toBeCloseTo(0.1, 9);
    expect(costOf(u({ cacheWrite: K }), 'gpt-6-astra')).toBeCloseTo(1.25, 9);
  });
  test('unknown model costs 0', () => {
    expect(costOf(u({ input: M, output: M }), 'mystery')).toBe(0);
  });
});

describe('long-context tier', () => {
  const big = 300_000; // past Astra's 272K threshold
  test('a prompt past the threshold reprices the whole request', () => {
    expect(costOf(u({ input: big, output: 100_000 }), 'gpt-6-astra')).toBeCloseTo((big * 10 * 2 + 100_000 * 50 * 1.5) / M, 9);
  });
  test('cache tokens count toward the threshold and take the input multiplier', () => {
    expect(costOf(u({ input: 1, cacheRead: big }), 'gpt-6-astra')).toBeCloseTo(((1 * 10) + (big * 1)) * 2 / M, 9);
    expect(costOf(u({ cacheWrite: big }), 'gpt-6-astra')).toBeCloseTo(big * 12.5 * 2 / M, 9);
  });
  test('a prompt at the threshold still bills at standard rates', () => {
    expect(costOf(u({ input: 272_000, output: 1000 }), 'gpt-6-astra')).toBeCloseTo((272_000 * 10 + 1000 * 50) / M, 9);
  });
  test('the threshold is per request, so aggregates go by mean prompt size', () => {
    const usage = u({ input: M, output: 10_000 }); // 1M input over 10 calls is 100K each
    expect(costOf(usage, 'gpt-6-astra', DEFAULT_PRICING, 10)).toBeCloseTo((M * 10 + 10_000 * 50) / M, 9);
    expect(costOf(usage, 'gpt-6-astra', DEFAULT_PRICING, 1)).toBeCloseTo((M * 10 * 2 + 10_000 * 50 * 1.5) / M, 9);
  });
  test('rows without a tier ignore the request count', () => {
    expect(costOf(u({ input: M }), 'gpt-5', DEFAULT_PRICING, 7)).toBeCloseTo(1.25, 9);
    expect(DEFAULT_PRICING['gpt-5']!.longContext).toBeUndefined();
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

    const drip = parseTranscript(
      JSON.stringify({ at: '2026-01-01T00:00:01.000Z', type: 'event', kind: 'inference', iteration: 1, data: { model: 'mystery-9', promptTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0, completionTokens: 1, latencyMs: 5 } }) + '\n' +
      JSON.stringify({ at: '2026-01-01T00:00:02.000Z', type: 'event', kind: 'inference', iteration: 1, data: { model: 'mystery-9', promptTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0, completionTokens: 1, latencyMs: 5 } }),
      'x.jsonl',
    );
    applyPricing(drip, DEFAULT_PRICING);
    expect(flatten(drip.root).filter((x) => x.kind === 'model').map((m) => m.costUsd)).toEqual([0, 0]);
    expect(drip.warnings.filter((w) => w === 'no pricing for mystery-9')).toHaveLength(1);
  });
});

describe('deepseek rows', () => {
  test('deepseek-flash carries peak rates and every flash alias resolves to it', () => {
    const flash = DEFAULT_PRICING['deepseek-flash']!;
    expect(flash.input).toBeCloseTo(0.3, 9);
    expect(flash.output).toBeCloseTo(1.2, 9);
    expect(flash.cacheRead).toBeCloseTo(0.006, 9);
    expect(flash.cacheWrite5m).toBe(0);
    expect(flash.cacheWrite1h).toBe(0);
    expect(flash.longContext).toBeUndefined(); // flat rate across the 1M context
    expect(priceFor('deepseek-flash')).toEqual(flash);
    expect(priceFor('deepseek-v4.1-flash')).toEqual(flash);
    expect(priceFor('deepseek-v4-flash')).toEqual(flash); // retired name, billed as Flash
    expect(priceFor('deepseek/deepseek-flash')).toEqual(flash);
    expect(priceFor('deepseek-v4-flash-20260601')).toEqual(flash);
  });
  test('deepseek-v4-pro carries peak rates under both spellings', () => {
    const pro = DEFAULT_PRICING['deepseek-v4-pro']!;
    expect(pro.input).toBeCloseTo(1.32, 9);
    expect(pro.output).toBeCloseTo(3.96, 9);
    expect(pro.cacheRead).toBeCloseTo(0.044, 9);
    expect(priceFor('deepseek-v4.1-pro')).toEqual(pro);
    expect(priceFor('deepseek-v4-pro-0813')).toEqual(pro);
  });
  test('a Flash request bills at peak-rate arithmetic ($0.30 in / $1.20 out)', () => {
    expect(costOf(u({ input: M, output: M }), 'deepseek-flash')).toBeCloseTo(1.5, 9);
    expect(costOf(u({ cacheRead: M }), 'deepseek-flash')).toBeCloseTo(0.006, 9);
    expect(costOf(u({ cacheWrite: M }), 'deepseek-flash')).toBeCloseTo(0, 9);
  });
});

describe('user-added pricing rows', () => {
  const customRow = { input: 1, cacheRead: 0.1, cacheWrite5m: 0.5, cacheWrite1h: 1, output: 2 };
  test('a complete row for an unknown model becomes a new model', () => {
    const merged = mergePricing({ 'my-flash': customRow });
    expect(merged['my-flash']).toEqual(customRow);
    expect(priceFor('my-flash', merged)).toEqual(customRow);
    expect(priceFor('vendor/my-flash-20270101', merged)).toEqual(customRow); // prefix + provider strip
    expect(costOf(u({ input: M, output: M }), 'my-flash', merged)).toBeCloseTo(3, 9);
    expect(priceFor('my-flash', DEFAULT_PRICING)).toBeNull(); // only in the merged table
  });
  test('an incomplete patch for an unknown model is ignored', () => {
    expect(mergePricing({ ghost: { input: 9 } })['ghost']).toBeUndefined();
    expect(mergePricing({ ghost: undefined as never })['ghost']).toBeUndefined();
  });
  test('a partial edit keeps every rate it does not name, longContext included', () => {
    const merged = mergePricing({ 'gpt-6-astra': { output: 60 }, 'gpt-5': { input: 9 } });
    expect(merged['gpt-6-astra']!.output).toBe(60);
    expect(merged['gpt-6-astra']!.input).toBe(10);
    expect(merged['gpt-6-astra']!.cacheWrite5m).toBe(12.5);
    expect(merged['gpt-6-astra']!.longContext).toEqual(DEFAULT_PRICING['gpt-6-astra']!.longContext);
    expect(merged['gpt-5']!.input).toBe(9);
    expect(merged['gpt-5']!.output).toBe(DEFAULT_PRICING['gpt-5']!.output);
  });
});

describe('pricing editor', () => {
  test('the grid edits exactly the rate fields every row must carry', async () => {
    const { PRICE_EDITOR_FIELDS } = await import('../src/ui/pricing.ts');
    expect(PRICE_EDITOR_FIELDS.map(([field]) => field).sort()).toEqual([...PRICE_FIELDS].sort());
  });
});
