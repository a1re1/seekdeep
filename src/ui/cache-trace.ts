// Cache trace strip: one equal-width bar per model call in call order, stacked
// cacheRead / cacheWrite / uncached input, so the call where the cache went
// cold is visible regardless of how long the call took.
//
// Bars are rectangles in fraction space over [0, 1) so one mapping serves both
// the device-pixel canvas paint and CSS-pixel hit testing / tooltip anchoring.

import { cacheHitRate, type Span } from '../model.ts';
import { cssVar } from './dom.ts';
import { formatCount, formatPct, formatTokens } from './format.ts';

export interface CacheBar {
  x0: number;
  x1: number;
  span: Span;
}

/** A bar's painted rectangle in CSS pixels — the exact geometry hit testing uses. */
export interface CacheBarRect {
  x0: number;
  x1: number;
  span: Span;
}

/** Max characters of model output / context text shown in the hover preview. */
export const CACHE_PREVIEW_CHARS = 200;

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
  // Stable sort: equal timestamps keep document order, so every call — even
  // duplicates — keeps its own bar and its exact Span identity.
  spans.sort((p, q) => p.startMs - q.startMs || p.endMs - q.endMs);
  const n = spans.length;
  const gap = n > 200 ? 0 : 0.15;
  return spans.map((span, i) => ({ x0: i / n, x1: (i + 1 - gap) / n, span }));
}

/** Collapse any text to one bounded plain-text line (no markup, no newlines). */
export function previewLine(text: string, max = CACHE_PREVIEW_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

/**
 * Painted rectangles in CSS pixels for `bars` across a strip `cssWidth` wide.
 * Matches what drawCacheTrace paints (same 1.5 px minimum width) while keeping
 * the real gaps between bars, so a point in a gap never resolves to a span.
 */
export function cacheBarRects(bars: CacheBar[], cssWidth: number, dpr = 1): CacheBarRect[] {
  if (!(cssWidth > 0) || !Number.isFinite(cssWidth)) return [];
  const k = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return bars.map((bar) => {
    const x0 = bar.x0 * cssWidth;
    // Painter clamps at 1.5 canvas (device) px = 1.5/dpr CSS px, so hit
    // geometry matches the paint at any devicePixelRatio.
    const width = Math.max(1.5 / k, (bar.x1 - bar.x0) * cssWidth);
    return { x0, x1: Math.min(cssWidth, x0 + width), span: bar.span };
  });
}

/**
 * Hit test in CSS coordinates (offsetX space, not device pixels): the painted
 * rectangle under `cssX`, or null when the point is off-strip or in a gap.
 * Returns the exact Span that bar was built from — never a nearest neighbour.
 */
export function cacheBarAt(
  bars: CacheBar[],
  cssWidth: number,
  cssX: number,
  dpr = 1,
): CacheBarRect | null {
  if (!(cssX >= 0 && cssX < cssWidth)) return null; // strip is half-open
  const rects = cacheBarRects(bars, cssWidth, dpr);
  // Reverse order: later bars are painted on top, so where minimum-width bars
  // overlap the last painted matching rect wins.
  for (let i = rects.length - 1; i >= 0; i--) {
    const rect = rects[i]!;
    if (cssX >= rect.x0 && cssX < rect.x1) return rect;
  }
  return null;
}

/**
 * Live hit-test state for the app's cache strip: the bars behind the canvas
 * currently on screen plus their CSS-pixel rectangles. Rebound on every paint,
 * so a queued hover/click from an earlier render, session or zoom window can
 * never resolve to a span that is no longer painted.
 */
export interface CacheStripState {
  bars: CacheBar[];
  rects: CacheBarRect[];
  cssWidth: number;
}

export function freshCacheStripState(): CacheStripState {
  return { bars: [], rects: [], cssWidth: 0 };
}

/** Rebind the strip to freshly painted bars; call on every render. */
export function bindCacheStrip(
  state: CacheStripState,
  bars: CacheBar[],
  cssWidth: number,
  dpr = 1,
): CacheStripState {
  const rects = cacheBarRects(bars, cssWidth, dpr);
  state.bars = bars;
  state.rects = rects;
  state.cssWidth = rects.length > 0 ? cssWidth : 0;
  return state;
}

/**
 * Resolve a CSS-pixel x (event.offsetX) to the exact Span painted under it, or
 * null for off-strip points, gaps and unknown state. Geometry is CSS-relative:
 * the painter maps the same bar fractions onto device pixels, so the resolved
 * call is identical at any devicePixelRatio. With dense minimum-width bars
 * that overlap, the LAST painted match wins (the one visible on top) and
 * boundaries are half-open [x0, x1) so two bars never both claim a point.
 */
export function cacheSpanAt(state: CacheStripState, cssX: number): Span | null {
  if (!(state.cssWidth > 0) || !Number.isFinite(cssX)) return null;
  if (cssX < 0 || cssX >= state.cssWidth) return null;
  for (let i = state.rects.length - 1; i >= 0; i--) {
    const rect = state.rects[i]!;
    if (cssX >= rect.x0 && cssX < rect.x1) return rect.span;
  }
  return null;
}

/**
 * Plain-text hover preview for one cache bar (assigned via textContent by the
 * UI, never HTML): identity, cache counts + hit rate, bounded payload excerpt.
 * Absent payload degrades to an explicit note instead of an empty tooltip.
 */
export function cacheTooltipText(span: Span): string {
  const u = span.usage;
  const lines = [span.name];
  if (span.model !== undefined) lines.push(`model: ${span.model}`);
  if (u === undefined) {
    lines.push('no token usage recorded');
  } else {
    lines.push(
      `tokens (in/cache rd/cache wr/out): ${formatTokens(u)}`,
      `cache hit rate: ${formatPct(cacheHitRate(u))}`,
      `cache read: ${formatCount(u.cacheRead)} · write: ${formatCount(u.cacheWrite)} · uncached: ${formatCount(u.input)}`,
    );
  }
  const output = span.payload?.output;
  const context = span.payload?.newContext;
  if (output !== undefined && output.length > 0) lines.push(`output: ${previewLine(output)}`);
  const first = context?.[0];
  if (first !== undefined) {
    const more = context !== undefined && context.length > 1 ? ` (+${context.length - 1} more)` : '';
    lines.push(`context: ${first.role} ${previewLine(`${first.label} ${first.text}`)}${more}`);
  }
  if ((output === undefined || output.length === 0) && first === undefined) {
    lines.push('payload: none recorded');
  }
  if (span.ok === false) lines.push('status: failed');
  lines.push('click: inspect this call');
  return lines.join('\n');
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
