// Formatting helpers: durations, token counts, currency, percentages.

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '–';
  const v = Math.max(0, ms);
  if (v < 1) return `${(v * 1000).toFixed(0)} µs`;
  if (v < 1_000) return `${v.toFixed(v < 10 ? 1 : 0)} ms`;
  const s = v / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)} s`;
  const m = Math.floor(s / 60);
  const rs = s - m * 60;
  if (m < 60) return `${m}m ${rs.toFixed(0)}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m - h * 60}m`;
}

export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '–';
  const v = Math.max(0, n);
  if (v < 1_000) return v.toFixed(0);
  if (v < 1_000_000) return `${(v / 1_000).toFixed(v < 10_000 ? 1 : 0)}k`;
  if (v < 1_000_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  return `${(v / 1_000_000_000).toFixed(2)}B`;
}

export function formatCost(usd: number): string {
  if (!Number.isFinite(usd)) return '–';
  if (usd > 0 && usd < 0.01) return `<$0.01`;
  if (usd >= 100) return `$${usd.toFixed(0)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatPct(fraction: number): string {
  if (!Number.isFinite(fraction)) return '–';
  return `${(fraction * 100).toFixed(1)}%`;
}

export function formatTokens(u: {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
}): string {
  return `${formatCount(u.input ?? 0)} / ${formatCount(u.cacheRead ?? 0)} / ${formatCount(
    u.cacheWrite ?? 0,
  )} / ${formatCount(u.output ?? 0)}`;
}
