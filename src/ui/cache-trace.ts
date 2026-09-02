// Cache trace strip: one equal-width bar per model call in call order, stacked
// cacheRead / cacheWrite / uncached input, so the call where the cache went
// cold is visible regardless of how long the call took.

import type { Span } from '../model.ts';
import { cssVar } from './dom.ts';

export interface CacheBar {
  x0: number;
  x1: number;
  span: Span;
}

export function collectCacheBars(root: Span, t0: number, t1: number): CacheBar[] {
  // Equal-width bars in call order (not time-positioned): a 2 s API call in a
  // 20 min session would otherwise be a hairline, and the question this strip
  // answers is "at which call did the cache go cold", which is ordinal.
  const spans: Span[] = [];
  const walk = (span: Span) => {
    if (span.kind === 'model' && span.usage !== undefined && span.endMs >= t0 && span.startMs <= t1) {
      spans.push(span);
    }
    for (const child of span.children) walk(child);
  };
  walk(root);
  spans.sort((p, q) => p.startMs - q.startMs || p.endMs - q.endMs);
  const n = spans.length;
  const gap = n > 200 ? 0 : 0.15;
  return spans.map((span, i) => ({ x0: i / n, x1: (i + 1 - gap) / n, span }));
}

export function drawCacheTrace(
  canvas: HTMLCanvasElement,
  bars: CacheBar[],
  t0: number,
  t1: number,
): void {
  const ctx = canvas.getContext('2d');
  if (ctx === null) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const w = canvas.width;
  const h = canvas.height;
  let maxTotal = 0;
  for (const bar of bars) {
    const u = bar.span.usage;
    maxTotal = Math.max(maxTotal, (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0) + (u?.input ?? 0));
  }
  if (maxTotal === 0) {
    ctx.fillStyle = cssVar('--text-tertiary', '#888');
    ctx.font = '11px -apple-system, system-ui, sans-serif';
    ctx.fillText('no token usage recorded', 6, h / 2);
    return;
  }
  for (const bar of bars) {
    const u = bar.span.usage;
    if (u === undefined) continue;
    const x = bar.x0 * w;
    const bw = Math.max(1.5, (bar.x1 - bar.x0) * w);
    const segs: Array<[number, string]> = [
      [u.cacheRead ?? 0, cssVar('--c-cache-read', '#22c55e')],
      [u.cacheWrite ?? 0, cssVar('--c-cache-write', '#ef4444')],
      [u.input ?? 0, cssVar('--c-input', '#eab308')],
    ];
    let y = h;
    for (const [value, color] of segs) {
      if (value <= 0) continue;
      const sh = Math.max(1, (value / maxTotal) * h);
      y -= sh;
      ctx.fillStyle = color;
      ctx.fillRect(x, y, bw, sh);
    }
  }
  void t0;
  void t1;
}

