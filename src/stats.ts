// Usage statistics for the activity page: pure aggregation over parsed
// sessions. No DOM, no I/O — callers produce UsageBuckets (see
// src/index/activity-cache.ts) and this module turns them into everything
// the dashboard renders: totals, per-column series, and a per-model table.

import { flatten } from './model.ts';
import type { Session, Usage } from './model.ts';
import { costOf, priceFor } from './pricing.ts';
import type { PricingTable } from './pricing.ts';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** One record per (UTC hour, model): usage summed across model spans. */
export interface UsageBucket {
  /** UTC-hour floor of the model spans' startMs. */
  hourMs: number;
  model: string;
  provider?: string;
  /** Harness that made the calls (claude, drip, codex, …); absent on records cached before it existed. */
  harness?: string;
  requests: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  /** Portions of cacheWrite priced at the 5m / 1h rates (0 when the transcript has no split). */
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
  reasoning: number;
  /** SUM of model-span durations in the bucket; averages derived later. */
  latencyMs: number;
  outputTokSec?: never;
}

/** A reporting window: columns start at startMs and advance by stepMs. */
export interface Range {
  startMs: number;
  endMs: number;
  stepMs: number;
}

export interface Totals {
  costUsd: number;
  requests: number;
  tokens: number;
  cacheHit: number;
  blendedPerM: number;
}

export interface Delta {
  costUsd: number;
  requests: number;
  tokens: number;
  cacheHit: number;
  blendedPerM: number;
}

export interface ModelRow {
  model: string;
  provider?: string;
  requests: number;
  tokens: number;
  promptTokens: number;
  outputTokens: number;
  costUsd: number;
  effectivePerM: number;
  cacheHit: number;
  avgLatencyMs: number;
  outputTokSec: number;
  inputPrice: number;
  outputPrice: number;
}

export interface Activity {
  range: Range;
  totals: Totals;
  previous: Totals;
  delta: Delta;
  columns: number[];
  models: string[];
  /** Per model (in `models` order) × per column: cost, request count, prompt+output tokens. */
  series: { costUsd: number[][]; requests: number[][]; tokens: number[][] };
  tokens: { prompt: number[]; completion: number[]; reasoning: number[] };
  caching: { cached: number[]; uncached: number[] };
  sparkline: {
    costUsd: number[];
    requests: number[];
    tokens: number[];
    cacheHit: number[];
    blendedPerM: number[];
  };
  perModel: ModelRow[];
}

/**
 * Bucket every model span of a session by (UTC hour, model). Grafted nested
 * sessions may carry spans with `meta.harness === 'drip'` — they are real
 * model calls, so they are included like any other model span.
 */
export function bucketSession(session: Session): UsageBucket[] {
  const byKey = new Map<string, UsageBucket>();
  const own = harnessOf(session.format);
  for (const span of flatten(session.root)) {
    if (span.kind !== 'model' || !span.usage) continue;
    const hourMs = Math.floor(span.startMs / HOUR_MS) * HOUR_MS;
    const model = span.model ?? '';
    const harness = typeof span.meta?.harness === 'string' ? span.meta.harness : own;
    const key = bucketKey(hourMs, model, harness);
    let bucket = byKey.get(key);
    if (bucket === undefined) {
      bucket = {
        hourMs,
        model,
        harness,
        requests: 0,
        input: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        output: 0,
        reasoning: 0,
        latencyMs: 0,
      };
      byKey.set(key, bucket);
    }
    if (span.provider !== undefined && bucket.provider === undefined) {
      bucket.provider = span.provider;
    }
    const u = span.usage;
    bucket.requests += 1;
    bucket.input += u.input || 0;
    bucket.cacheRead += u.cacheRead || 0;
    bucket.cacheWrite += u.cacheWrite || 0;
    bucket.cacheWrite5m += u.cacheWrite5m ?? 0;
    bucket.cacheWrite1h += u.cacheWrite1h ?? 0;
    bucket.output += u.output || 0;
    bucket.reasoning += u.reasoning || 0;
    bucket.latencyMs += Math.max(0, span.endMs - span.startMs);
  }
  return [...byKey.values()];
}

/** The harness label shown in the activity filter for a transcript format. */
export function harnessOf(format: Session['format']): string {
  return format === 'claude-code' ? 'claude' : format;
}

function bucketKey(hourMs: number, model: string, harness: string | undefined): string {
  return `${hourMs}\u0000${model}\u0000${harness ?? ''}`;
}

/** Sum bucket lists by (hourMs, model, harness); result sorted by hour then model. */
export function mergeBuckets(lists: UsageBucket[][]): UsageBucket[] {
  const byKey = new Map<string, UsageBucket>();
  for (const list of lists) {
    for (const b of list) {
      const key = bucketKey(b.hourMs, b.model, b.harness);
      let bucket = byKey.get(key);
      if (bucket === undefined) {
        bucket = {
          hourMs: b.hourMs,
          model: b.model,
          ...(b.harness !== undefined ? { harness: b.harness } : {}),
          requests: 0,
          input: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
          output: 0,
          reasoning: 0,
          latencyMs: 0,
        };
        byKey.set(key, bucket);
      }
      if (b.provider !== undefined && bucket.provider === undefined) {
        bucket.provider = b.provider;
      }
      bucket.requests += b.requests;
      bucket.input += b.input;
      bucket.cacheRead += b.cacheRead;
      bucket.cacheWrite += b.cacheWrite;
      bucket.cacheWrite5m += b.cacheWrite5m ?? 0;
      bucket.cacheWrite1h += b.cacheWrite1h ?? 0;
      bucket.output += b.output;
      bucket.reasoning += b.reasoning;
      bucket.latencyMs += b.latencyMs;
    }
  }
  return [...byKey.values()].sort((a, b) => a.hourMs - b.hourMs || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
}

/** Local-midnight floor of `ms` (a "day" column is the viewer's day). */
function localDayStart(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Next step edge after `ms`; daily steps follow local calendar days. */
function nextEdge(ms: number, stepMs: number): number {
  if (stepMs % DAY_MS === 0) {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  }
  return ms + stepMs;
}

/**
 * Window for a preset. `48h` uses hourly columns ending at the current
 * hour; `7d`/`30d` use local-calendar daily columns ending tomorrow
 * midnight; `all` starts at the earliest bucket's local day (or the last
 * 24 hours when there are no buckets yet).
 */
export function rangeFor(
  preset: '48h' | '7d' | '30d' | 'all',
  nowMs: number,
  buckets: UsageBucket[],
): Range {
  if (preset === '48h') {
    const endMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS + HOUR_MS;
    return { startMs: endMs - 48 * HOUR_MS, endMs, stepMs: HOUR_MS };
  }
  if (preset === '7d' || preset === '30d') {
    const days = preset === '7d' ? 7 : 30;
    const now = new Date(nowMs);
    return {
      startMs: new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)).getTime(),
      endMs: localDayStart(nowMs) + DAY_MS,
      stepMs: DAY_MS,
    };
  }
  // 'all': daily from the earliest bucket, or the last 24 hours when empty.
  let earliest = Infinity;
  for (const b of buckets) {
    if (b.hourMs < earliest) earliest = b.hourMs;
  }
  if (earliest === Infinity) {
    const endMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS + HOUR_MS;
    return { startMs: endMs - 24 * HOUR_MS, endMs, stepMs: HOUR_MS };
  }
  return {
    startMs: localDayStart(earliest),
    endMs: localDayStart(nowMs) + DAY_MS,
    stepMs: DAY_MS,
  };
}

/** Column start timestamps covering the range. */
function buildColumns(range: Range): number[] {
  const columns: number[] = [];
  if (!(range.stepMs > 0) || range.endMs <= range.startMs) return columns;
  let t = range.startMs;
  while (t < range.endMs) {
    columns.push(t);
    t = nextEdge(t, range.stepMs);
  }
  return columns;
}

/** Last column whose start is <= ts, or -1 when ts is before the range. */
function columnIndex(columns: number[], ts: number): number {
  let lo = 0;
  let hi = columns.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (columns[mid]! <= ts) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const frac = (cur: number, prev: number): number => (prev === 0 ? NaN : (cur - prev) / prev);

interface ModelAcc {
  provider?: string;
  cost: number[];
  requests: number[];
  /** prompt + output tokens per column */
  tokensByCol: number[];
  requestsTotal: number;
  promptTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  tokens: number;
  cached: number;
  latencyMs: number;
}

// `reasoning` (thinking) tokens are a subset of `output` in every usage
// shape we parse, so token volume is prompt + output and the breakdown chart
// shows completion = output − reasoning next to reasoning.
function totalsOf(cost: number, requests: number, prompt: number, output: number, cached: number): Totals {
  const tokens = prompt + output;
  const promptAll = prompt;
  return {
    costUsd: cost,
    requests,
    tokens,
    cacheHit: promptAll > 0 ? cached / promptAll : 0,
    blendedPerM: tokens > 0 ? cost / (tokens / 1e6) : 0,
  };
}

/**
 * Aggregate in-range buckets into everything the activity view renders.
 * `previous` covers the window of equal length immediately before the range;
 * `delta` is the fractional change (NaN when the previous value is 0).
 */
export function aggregate(buckets: UsageBucket[], pricing: PricingTable, range: Range): Activity {
  const columns = buildColumns(range);
  const nCols = columns.length;

  const tokens = { prompt: new Array<number>(nCols).fill(0), completion: new Array<number>(nCols).fill(0), reasoning: new Array<number>(nCols).fill(0) };
  const caching = { cached: new Array<number>(nCols).fill(0), uncached: new Array<number>(nCols).fill(0) };
  const colCost = new Array<number>(nCols).fill(0);
  const colRequests = new Array<number>(nCols).fill(0);
  const accs = new Map<string, ModelAcc>();

  for (const b of buckets) {
    if (b.hourMs < range.startMs || b.hourMs >= range.endMs) continue;
    const idx = columnIndex(columns, b.hourMs);
    if (idx < 0) continue;

    const usage: Usage = {
      input: b.input,
      cacheRead: b.cacheRead,
      cacheWrite: b.cacheWrite,
      cacheWrite5m: b.cacheWrite5m ?? 0,
      cacheWrite1h: b.cacheWrite1h ?? 0,
      output: b.output,
      reasoning: b.reasoning,
    };
    const cost = costOf(usage, b.model, pricing);
    const prompt = b.input + b.cacheRead + b.cacheWrite;

    colCost[idx] = (colCost[idx] ?? 0) + cost;
    colRequests[idx] = (colRequests[idx] ?? 0) + b.requests;
    tokens.prompt[idx] = (tokens.prompt[idx] ?? 0) + prompt;
    const reasoning = Math.min(b.reasoning, b.output);
    tokens.completion[idx] = (tokens.completion[idx] ?? 0) + b.output - reasoning;
    tokens.reasoning[idx] = (tokens.reasoning[idx] ?? 0) + reasoning;
    caching.cached[idx] = (caching.cached[idx] ?? 0) + b.cacheRead;
    caching.uncached[idx] = (caching.uncached[idx] ?? 0) + b.input + b.cacheWrite;

    let acc = accs.get(b.model);
    if (acc === undefined) {
      acc = {
        provider: b.provider,
        cost: new Array<number>(nCols).fill(0),
        requests: new Array<number>(nCols).fill(0),
        tokensByCol: new Array<number>(nCols).fill(0),
        requestsTotal: 0,
        promptTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        tokens: 0,
        cached: 0,
        latencyMs: 0,
      };
      accs.set(b.model, acc);
    }
    if (acc.provider === undefined && b.provider !== undefined) acc.provider = b.provider;
    acc.cost[idx] = (acc.cost[idx] ?? 0) + cost;
    acc.requests[idx] = (acc.requests[idx] ?? 0) + b.requests;
    acc.tokensByCol[idx] = (acc.tokensByCol[idx] ?? 0) + prompt + b.output;
    acc.requestsTotal += b.requests;
    acc.promptTokens += prompt;
    acc.outputTokens += b.output;
    acc.reasoningTokens += reasoning;
    acc.tokens += prompt + b.output;
    acc.cached += b.cacheRead;
    acc.latencyMs += b.latencyMs;
  }

  // Models sorted by total cost desc (name asc as a deterministic tiebreak).
  const models = [...accs.keys()].sort((a, b) => {
    const byCost = sum(accs.get(b)!.cost) - sum(accs.get(a)!.cost);
    return byCost !== 0 ? byCost : a < b ? -1 : a > b ? 1 : 0;
  });

  const series = {
    costUsd: models.map((m) => accs.get(m)!.cost),
    requests: models.map((m) => accs.get(m)!.requests),
    tokens: models.map((m) => accs.get(m)!.tokensByCol),
  };

  const sparkTokens = tokens.prompt.map((p, i) => p + tokens.completion[i]! + tokens.reasoning[i]!);
  const colCacheHit = caching.cached.map((c, i) => {
    const denom = c + caching.uncached[i]!;
    return denom > 0 ? c / denom : 0;
  });
  const colBlended = colCost.map((c, i) => (sparkTokens[i]! > 0 ? c / (sparkTokens[i]! / 1e6) : 0));

  const prevStart = range.startMs - (range.endMs - range.startMs);
  let pCost = 0;
  let pRequests = 0;
  let pPrompt = 0;
  let pOutput = 0;
  let pCached = 0;
  for (const b of buckets) {
    if (b.hourMs < prevStart || b.hourMs >= range.startMs) continue;
    const usage: Usage = {
      input: b.input,
      cacheRead: b.cacheRead,
      cacheWrite: b.cacheWrite,
      cacheWrite5m: b.cacheWrite5m ?? 0,
      cacheWrite1h: b.cacheWrite1h ?? 0,
      output: b.output,
      reasoning: b.reasoning,
    };
    pCost += costOf(usage, b.model, pricing);
    pRequests += b.requests;
    pPrompt += b.input + b.cacheRead + b.cacheWrite;
    pOutput += b.output;
    pCached += b.cacheRead;
  }

  const totals = totalsOf(sum(colCost), sum(colRequests), sum(tokens.prompt), sum(tokens.completion) + sum(tokens.reasoning), sum(caching.cached));
  const previous = totalsOf(pCost, pRequests, pPrompt, pOutput, pCached);

  const perModel: ModelRow[] = models.map((model) => {
    const acc = accs.get(model)!;
    const cost = sum(acc.cost);
    const row = priceFor(model, pricing);
    return {
      model,
      provider: acc.provider,
      requests: acc.requestsTotal,
      tokens: acc.tokens,
      promptTokens: acc.promptTokens,
      outputTokens: acc.outputTokens,
      costUsd: cost,
      effectivePerM: acc.tokens > 0 ? cost / (acc.tokens / 1e6) : 0,
      cacheHit: acc.promptTokens > 0 ? acc.cached / acc.promptTokens : 0,
      avgLatencyMs: acc.requestsTotal > 0 ? acc.latencyMs / acc.requestsTotal : 0,
      outputTokSec: acc.latencyMs > 0 ? acc.outputTokens / (acc.latencyMs / 1000) : 0,
      inputPrice: row?.input ?? 0,
      outputPrice: row?.output ?? 0,
    };
  });

  return {
    range,
    totals,
    previous,
    delta: {
      costUsd: frac(totals.costUsd, previous.costUsd),
      requests: frac(totals.requests, previous.requests),
      tokens: frac(totals.tokens, previous.tokens),
      cacheHit: frac(totals.cacheHit, previous.cacheHit),
      blendedPerM: frac(totals.blendedPerM, previous.blendedPerM),
    },
    columns,
    models,
    series,
    tokens,
    caching,
    sparkline: {
      costUsd: colCost,
      requests: colRequests,
      tokens: sparkTokens,
      cacheHit: colCacheHit,
      blendedPerM: colBlended,
    },
    perModel,
  };
}
