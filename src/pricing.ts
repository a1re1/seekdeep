// Token pricing: default table, prefix matching, cost computation, and
// localStorage-backed user overrides. Pure math lives here; the DOM layer
// (src/ui/) calls loadOverrides/saveOverrides to persist edits.

import type { Session, Span, Usage } from './model.ts';

/**
 * Long-context repricing. A request whose prompt exceeds `thresholdTokens` is
 * billed for the *whole* request at these multipliers, not just the overflow.
 */
export interface LongContextTier {
  thresholdTokens: number;
  inputMultiplier: number; // applies to input, cache reads, and cache writes
  outputMultiplier: number;
}

export interface PriceRow {
  input: number; // USD per 1M tokens
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  longContext?: LongContextTier;
}

/** The per-1M-token rate fields of a PriceRow — the ones the UI grid edits. */
export type NumericPriceField = {
  [K in keyof PriceRow]-?: PriceRow[K] extends number ? K : never;
}[keyof PriceRow];

export type PricingTable = Record<string, PriceRow>;

const anthropicRow = (input: number, output: number): PriceRow => ({
  input,
  output,
  cacheRead: input * 0.1,
  cacheWrite5m: input * 1.25,
  cacheWrite1h: input * 2,
});

// OpenAI-style: cached input reads cost 10%, no cache-write premium.
const openaiRow = (input: number, output: number): PriceRow => ({
  input,
  output,
  cacheRead: input * 0.1,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
});

// Generic "cheap provider" rows: same read-discount convention, no writes.
const otherRow = (input: number, output: number): PriceRow => openaiRow(input, output);

export const DEFAULT_PRICING: PricingTable = {
  // Anthropic
  'claude-fable-5': anthropicRow(10, 50),
  'claude-mythos-5': anthropicRow(10, 50),
  'claude-opus-5': anthropicRow(5, 25),
  'claude-opus-4-8': anthropicRow(5, 25),
  'claude-opus-4-7': anthropicRow(5, 25),
  'claude-opus-4-6': anthropicRow(5, 25),
  'claude-opus-4-5': anthropicRow(5, 25),
  'claude-sonnet-5': anthropicRow(2, 10),
  'claude-sonnet-4-6': anthropicRow(3, 15),
  'claude-sonnet-4-5': anthropicRow(3, 15),
  'claude-haiku-4-5': anthropicRow(1, 5),
  // OpenAI
  // GPT-6 Astra: $10 in / $50 out, cached input $1, cache writes $12.50 (1.25x input).
  // Unlike the other OpenAI rows Astra bills cache writes, and it has no separate 1h
  // tier, so both write fields carry the single rate. Past 272K prompt tokens the
  // whole request reprices at 2x input/cache rates and 1.5x output.
  'gpt-6-astra': {
    input: 10,
    output: 50,
    cacheRead: 1,
    cacheWrite5m: 12.5,
    cacheWrite1h: 12.5,
    longContext: { thresholdTokens: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
  },
  'gpt-5': openaiRow(1.25, 10),
  'gpt-5-mini': openaiRow(0.25, 2),
  'gpt-5-codex': openaiRow(1.25, 10),
  'o3': openaiRow(2, 8),
  // Others
  // GLM 5.3 (non-flash) via OpenRouter: $1.17 in, $3.96 out, cache reads at 20% ($0.234).
  'glm-5.3': { input: 1.17, output: 3.96, cacheRead: 0.234, cacheWrite5m: 0, cacheWrite1h: 0 },
  'glm-5-3': { input: 1.17, output: 3.96, cacheRead: 0.234, cacheWrite5m: 0, cacheWrite1h: 0 },
  'glm-5.3-flash': otherRow(0.07, 0.4),
  'glm-5-3-flash': otherRow(0.07, 0.4),
  'kimi-k3': otherRow(0.6, 2.5),
  'gpt-oss-120b': otherRow(0.15, 0.6),
};

/** `.` and `-` are equivalent in table keys and model names (glm-5.3-flash ≡ glm-5-3-flash). */
const canon = (s: string): string => s.replace(/\./g, '-');

/** Model name without a `provider/` prefix: `z-ai/glm-5.3-flash` → `glm-5.3-flash`. */
const bareModel = (model: string): string => {
  const slash = model.lastIndexOf('/');
  return slash >= 0 ? model.slice(slash + 1) : model;
};

/**
 * Longest-prefix match: `claude-opus-4-6-20260101` resolves to the
 * `claude-opus-4-6` row. A `provider/` prefix on the model name is ignored
 * when matching (`anthropic/claude-opus-5` → `claude-opus-5`), and `.` and
 * `-` are treated as equivalent (`glm-5-3-flash` matches key `glm-5.3-flash`).
 */
function lookup(table: PricingTable, model: string): PriceRow | null {
  const candidates = [canon(model), canon(bareModel(model))];
  let best: string | null = null;
  for (const key of Object.keys(table)) {
    const ck = canon(key);
    if (candidates.some((c) => c === ck || c.startsWith(ck))) {
      if (best === null || key.length > best.length) best = key;
    }
  }
  return best !== null ? table[best]! : null;
}

/** Longest-prefix match against `table` (default: the built-in table; see `lookup`). */
export function priceFor(model: string, table: PricingTable = DEFAULT_PRICING): PriceRow | null {
  return lookup(table, model);
}

const PER = 1_000_000;

/**
 * Cost of one usage record under the row for `model`.
 * Unknown model → 0 (the caller is responsible for warning).
 * Plain `cacheWrite` tokens not broken out by 5m/1h are charged at the
 * 5m rate; explicit `cacheWrite5m`/`cacheWrite1h` are charged at theirs.
 * `requests` is how many API calls `usage` covers — see `costWith`.
 */
export function costOf(
  usage: Usage,
  model: string,
  table: PricingTable = DEFAULT_PRICING,
  requests = 1,
): number {
  const row = priceFor(model, table);
  return row === null ? 0 : costWith(row, usage, requests);
}

/**
 * Fill `costUsd` on every model span and roll the sums up to ancestors via
 * `meta.costRollupUsd` (a span's rollup includes its own cost). Adds one
 * warning per unknown model name.
 */
export function applyPricing(session: Session, table: PricingTable): void {
  const warned = new Set<string>();
  const warn = (model: string) => {
    if (warned.has(model)) return;
    warned.add(model);
    session.warnings.push(`no pricing for ${model}`);
  };

  const rollup = (span: Span): number => {
    let total = 0;
    for (const child of span.children) total += rollup(child);
    if (span.kind === 'model' && span.usage) {
      const model = span.model ?? '';
      const row = lookup(table, model);
      if (row === null) {
        span.costUsd = 0;
        if (model.length > 0) warn(model);
      } else {
        span.costUsd = costWith(row, span.usage);
      }
      total += span.costUsd;
    }
    span.meta = { ...(span.meta ?? {}), costRollupUsd: total };
    return total;
  };
  rollup(session.root);
}

/**
 * Cost of `usage` under an explicit row.
 *
 * `requests` is how many API calls `usage` covers: 1 for a single model span,
 * the bucket's request count for an hourly aggregate. It matters only for rows
 * with a `longContext` tier, whose threshold is per request — an aggregate is
 * judged on its mean prompt size so that many small calls in one hour don't
 * add up to a false long-context hit.
 */
function costWith(row: PriceRow, usage: Usage, requests = 1): number {
  const input = usage.input || 0;
  const cacheRead = usage.cacheRead || 0;
  const cacheWrite = usage.cacheWrite || 0;
  const w5m = usage.cacheWrite5m ?? 0;
  const w1h = usage.cacheWrite1h ?? 0;
  const wOther = Math.max(0, cacheWrite - w5m - w1h);
  const promptCost =
    input * row.input +
    cacheRead * row.cacheRead +
    w5m * row.cacheWrite5m +
    w1h * row.cacheWrite1h +
    wOther * row.cacheWrite5m;
  const outputCost = (usage.output || 0) * row.output;

  const tier = row.longContext;
  if (tier !== undefined) {
    const promptPerRequest = (input + cacheRead + cacheWrite) / Math.max(1, requests);
    if (promptPerRequest > tier.thresholdTokens) {
      return (promptCost * tier.inputMultiplier + outputCost * tier.outputMultiplier) / PER;
    }
  }
  return (promptCost + outputCost) / PER;
}

// ---------------------------------------------------------------------------
// localStorage-backed overrides (key `seekdeep.pricing`). Every access is
// wrapped in try/catch: private-mode browsers, disabled storage, and
// non-DOM runtimes (bun test) all degrade to defaults.

export const PRICING_STORAGE_KEY = 'seekdeep.pricing';

export type PricingOverrides = Partial<Record<string, Partial<PriceRow>>>;

function getStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function loadPricingOverrides(): PricingOverrides {
  const storage = getStorage();
  if (storage === null) return {};
  try {
    const raw = storage.getItem(PRICING_STORAGE_KEY);
    if (raw === null) return {};
    const value: unknown = JSON.parse(raw);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as PricingOverrides;
    }
    return {};
  } catch {
    return {};
  }
}

export function savePricingOverrides(overrides: PricingOverrides): void {
  const storage = getStorage();
  if (storage === null) return;
  try {
    storage.setItem(PRICING_STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    /* ignore: storage unavailable or quota exceeded */
  }
}

export function clearPricingOverrides(): void {
  const storage = getStorage();
  if (storage === null) return;
  try {
    storage.removeItem(PRICING_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** DEFAULT_PRICING merged with the stored overrides (replaces whole rows). */
export function effectivePricing(): PricingTable {
  const overrides = loadPricingOverrides();
  const table: PricingTable = { ...DEFAULT_PRICING };
  for (const [key, patch] of Object.entries(overrides)) {
    const base = table[key];
    if (base === undefined) continue;
    table[key] = { ...base, ...(patch as Partial<PriceRow>) };
  }
  return table;
}
