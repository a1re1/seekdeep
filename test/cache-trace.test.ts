import { describe, expect, test } from 'bun:test';
import type { Span } from '../src/model.ts';
import {
  bindCacheStrip,
  cacheBarAt,
  cacheBarRects,
  cacheSpanAt,
  cacheTooltipText,
  CACHE_PREVIEW_CHARS,
  collectCacheBars,
  freshCacheStripState,
  previewLine,
} from '../src/ui/cache-trace.ts';

const modelSpan = (
  id: string,
  startMs: number,
  endMs: number,
  usage: Span['usage'],
  extra: Partial<Span> = {},
): Span => ({
  id, parentId: null, kind: 'model', name: `call ${id}`, startMs, endMs, usage, children: [], ...extra,
});

describe('collectCacheBars identity', () => {
  test('one bar per model call with usage, in call order, exact Span objects', () => {
    const a = modelSpan('a', 10, 20, { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 });
    const b = modelSpan('b', 30, 40, { input: 0, cacheRead: 5, cacheWrite: 0, output: 1 });
    const root: Span = { id: 'r', parentId: null, kind: 'session', name: 'r', startMs: 0, endMs: 100, children: [b, a] };
    const bars = collectCacheBars(root, 0, 100);
    expect(bars.map((x) => x.span.id)).toEqual(['a', 'b']);
    expect(bars[0]!.span).toBe(a); // exact identity, not a copy
  });

  test('duplicate timestamps keep one bar each with distinct identity', () => {
    const p = modelSpan('p', 50, 60, { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 });
    const q = modelSpan('q', 50, 60, { input: 2, cacheRead: 0, cacheWrite: 0, output: 0 });
    const root: Span = { id: 'r', parentId: null, kind: 'session', name: 'r', startMs: 0, endMs: 100, children: [p, q] };
    const bars = collectCacheBars(root, 0, 100);
    expect(bars).toHaveLength(2);
    expect(bars[0]!.span).toBe(p);
    expect(bars[1]!.span).toBe(q);
    expect(bars[0]!.x0).toBeLessThan(bars[1]!.x0);
  });

  test('window filters to visible calls only', () => {
    const inWin = modelSpan('in', 40, 60, { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 });
    const out = modelSpan('out', 400, 410, { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 });
    const root: Span = { id: 'r', parentId: null, kind: 'session', name: 'r', startMs: 0, endMs: 1000, children: [inWin, out] };
    expect(collectCacheBars(root, 0, 100).map((b) => b.span.id)).toEqual(['in']);
  });
});

describe('cache bar rectangles and gaps', () => {
  const bars = collectCacheBars(
    { id: 'r', parentId: null, kind: 'session', name: 'r', startMs: 0, endMs: 300, children: [
      modelSpan('a', 0, 100, { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 }),
      modelSpan('b', 100, 200, { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 }),
      modelSpan('c', 200, 300, { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 }),
    ] },
    0, 300,
  );

  test('explicit rectangles preserve real gaps between bars', () => {
    const rects = cacheBarRects(bars, 300);
    expect(rects).toHaveLength(3);
    // bar 0 ends before bar 1 starts (gap of 0.15 slot widths in fraction space)
    expect(rects[0]!.x1).toBeLessThan(rects[1]!.x0);
    expect(rects[1]!.x1).toBeLessThan(rects[2]!.x0);
    // widths stay within the strip
    for (const rect of rects) {
      expect(rect.x0).toBeGreaterThanOrEqual(0);
      expect(rect.x1).toBeLessThanOrEqual(300);
    }
  });

  test('hit test returns null in gaps and outside the strip', () => {
    const rects = cacheBarRects(bars, 300);
    const midGap = (rects[0]!.x1 + rects[1]!.x0) / 2;
    expect(cacheBarAt(bars, 300, midGap)).toBeNull();
    expect(cacheBarAt(bars, 300, -5)).toBeNull();
    expect(cacheBarAt(bars, 300, 305)).toBeNull();
  });

  test('hit test inside a bar returns its exact span', () => {
    expect(cacheBarAt(bars, 300, 10)?.span.id).toBe('a');
    expect(cacheBarAt(bars, 300, 110)?.span.id).toBe('b');
    expect(cacheBarAt(bars, 300, 250)?.span.id).toBe('c');
    expect(cacheBarAt(bars, 300, 10)?.span).toBe(bars[0]!.span);
  });

  test('CSS coordinate scaling: device pixel size never leaks into hit testing', () => {
    // Same strip, painted at devicePixelRatio 2 (600 device px = 300 CSS px):
    // hit testing must use CSS pixels only.
    expect(cacheBarAt(bars, 300, 10)?.span.id).toBe('a');
    expect(cacheBarAt(bars, 300, 10)).toEqual(cacheBarRects(bars, 300)[0]!);
    const scaled = cacheBarRects(bars, 600);
    expect(scaled[0]!.x1).toBeCloseTo(cacheBarRects(bars, 300)[0]!.x1 * 2, 10);
  });

  test('degenerate widths yield no hittable geometry', () => {
    expect(cacheBarRects(bars, 0)).toEqual([]);
    expect(cacheBarRects(bars, NaN)).toEqual([]);
    expect(cacheBarAt(bars, 0, 5)).toBeNull();
  });
});

describe('previewLine truncation', () => {
  test('flattens whitespace but keeps short text intact', () => {
    expect(previewLine('  hello\n  world  ')).toBe('hello world');
    expect(previewLine('short')).toBe('short');
  });

  test('truncates to the bound with an ellipsis, never exceeding max', () => {
    const long = 'x'.repeat(5000);
    const out = previewLine(long);
    expect(out.length).toBe(CACHE_PREVIEW_CHARS);
    expect(out.endsWith('…')).toBe(true);
    expect(out.startsWith('x'.repeat(10))).toBe(true);
  });

  test('custom bound', () => {
    expect(previewLine('abcdef', 4)).toBe('abc…');
  });
});

describe('cacheTooltipText', () => {
  test('includes model, cache counts and hit rate', () => {
    const span = modelSpan('a', 0, 10, { input: 100, cacheRead: 300, cacheWrite: 100, output: 50 }, { model: 'claude-x' });
    const text = cacheTooltipText(span);
    expect(text).toContain('model: claude-x');
    expect(text).toContain('cache read: 300');
    expect(text).toContain('write: 100');
    expect(text).toContain('uncached: 100');
    expect(text).toContain('cache hit rate: 60.0%');
  });

  test('shows bounded plain-text output preview, no raw newlines', () => {
    const span = modelSpan('a', 0, 10, { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 }, {
      payload: { output: `<script>alert("x")</script>\nline2\n${'y'.repeat(999)}`, truncated: true },
    });
    const text = cacheTooltipText(span);
    expect(text).toContain('output:');
    expect(text).not.toContain('\nline2');
    expect(text.length).toBeLessThan(600);
  });

  test('newContext preview shows first item role/label and a more-count', () => {
    const span = modelSpan('a', 0, 10, { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 }, {
      payload: {
        newContext: [
          { role: 'user', label: 'user', text: 'fix the bug', chars: 11 },
          { role: 'tool_result', label: 'grep', text: 'no matches', chars: 10 },
        ],
      },
    });
    const text = cacheTooltipText(span);
    expect(text).toContain('context: user user fix the bug (+1 more)');
    expect(text).not.toContain('no matches'); // second item is not previewed
  });

  test('absent payload falls back to an explicit note, absent usage too', () => {
    expect(cacheTooltipText(modelSpan('a', 0, 10, { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 }))).toContain('payload: none recorded');
    expect(cacheTooltipText(modelSpan('a', 0, 10, undefined, { payload: {} }))).toContain('payload: none recorded');
    const bare = cacheTooltipText(modelSpan('a', 0, 10, undefined));
    expect(bare).toContain('no token usage recorded');
    expect(bare).toContain('payload: none recorded');
  });
});

describe('cache strip interaction geometry', () => {
  const clickFixture = () => {
    const a = modelSpan('a', 0, 10, { input: 2, cacheRead: 6, cacheWrite: 1, output: 3 }, { model: 'm1' });
    const b = modelSpan('b', 10, 20, { input: 4, cacheRead: 1, cacheWrite: 9, output: 7 }, { model: 'm2' });
    return { root: modelSpan('root', 0, 100, undefined, { children: [a, b] }), a, b };
  };

  test('dense overlapping minimum-width bars resolve to the last painted span, half-open', () => {
    const { root, a, b } = clickFixture();
    const bars = collectCacheBars(root, 0, 100);
    // 2.9 CSS px wide: both bars clamp to the 1.5 px paint minimum and overlap.
    const rects = cacheBarRects(bars, 2.9);
    expect(rects[0]!.x1).toBeGreaterThan(rects[1]!.x0); // genuinely overlapping
    const state = bindCacheStrip(freshCacheStripState(), bars, 2.9);
    expect(cacheSpanAt(state, rects[0]!.x0)).toBe(a);
    expect(cacheSpanAt(state, (rects[0]!.x0 + rects[1]!.x0) / 2)).toBe(a); // bar 1 starts right of this point
    expect(cacheSpanAt(state, rects[1]!.x0)).toBe(b); // boundary → later bar (half-open)
    expect(cacheSpanAt(state, rects[1]!.x0 + 0.04)).toBe(b); // overlap → topmost paint wins
    expect(cacheSpanAt(state, rects[1]!.x1 - 0.01)).toBe(b);
  });

  test('gaps, off-strip points, right edge and empty state never resolve', () => {
    const { root, a } = clickFixture();
    const state = bindCacheStrip(freshCacheStripState(), collectCacheBars(root, 0, 100), 600);
    expect(cacheSpanAt(state, 250)).toBe(a); // inside bar 0 (painted 0..255)
    expect(cacheSpanAt(state, 277)).toBe(null); // real 45 px gap between the two bars
    expect(cacheSpanAt(state, 580)).toBe(null); // beyond the last painted bar
    expect(cacheSpanAt(state, -1)).toBe(null);
    expect(cacheSpanAt(state, 600)).toBe(null); // half-open right edge
    expect(cacheSpanAt(state, Number.NaN)).toBe(null);
    expect(cacheSpanAt(freshCacheStripState(), 5)).toBe(null);
  });

  test('rebinding on render makes stale spans unreachable (session/zoom/resize)', () => {
    const { root, a } = clickFixture();
    const state = freshCacheStripState();
    bindCacheStrip(state, collectCacheBars(root, 0, 100), 600);
    expect(cacheSpanAt(state, 100)).toBe(a);
    // A later render for a different root (session/zoom change): the old call is
    // gone and only the newly painted call resolves...
    const other = modelSpan('z', 0, 10, { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 });
    const otherRoot = modelSpan('root2', 0, 100, undefined, { children: [other] });
    bindCacheStrip(state, collectCacheBars(otherRoot, 0, 100), 600);
    expect(cacheSpanAt(state, 100)).toBe(other);
    // ...and a paint with no bars (empty strip) disables hit testing entirely.
    bindCacheStrip(state, [], 600);
    expect(cacheSpanAt(state, 10)).toBe(null);
  });

  test('hit geometry is CSS-relative: identical mapping at 1x and 2x device pixels', () => {
    const { root, a, b } = clickFixture();
    const bars = collectCacheBars(root, 0, 100);
    // The painter maps bar fractions onto canvas.width (device px), hit testing
    // onto CSS px — both scale the same fractions, so the resolved call never
    // depends on devicePixelRatio.
    const css = bindCacheStrip(freshCacheStripState(), bars, 300);
    const device = bindCacheStrip(freshCacheStripState(), bars, 600);
    for (const frac of [0, 0.1, 0.4, 0.5, 0.6, 0.9]) {
      expect(cacheSpanAt(css, frac * 300)).toBe(cacheSpanAt(device, frac * 600));
    }
    expect(cacheSpanAt(css, 0.1 * 300)).toBe(a);
    expect(cacheSpanAt(css, 0.6 * 300)).toBe(b);
  });

  test('minimum painted width follows device pixels (1.5 device px, not CSS px)', () => {
    const { a, b } = clickFixture();
    // Hand-built thin bars on a 5 px strip: fraction width 0.1 * 5 = 0.5 px is
    // below the paint minimum, so the clamp decides: 1.5 CSS px at DPR 1 vs
    // 1.5 device px = 0.75 CSS px at DPR 2.
    const thin = [
      { x0: 0.3, x1: 0.4, span: a },
      { x0: 0.5, x1: 0.6, span: b },
    ];
    const one = cacheBarRects(thin, 5, 1);
    const two = cacheBarRects(thin, 5, 2);
    expect(one[0]!.x1 - one[0]!.x0).toBeCloseTo(1.5, 10);
    expect(two[0]!.x1 - two[0]!.x0).toBeCloseTo(0.75, 10);
    // Hit testing matches the painted width at each DPR; overlaps: last painted.
    const state = bindCacheStrip(freshCacheStripState(), thin, 5, 2);
    expect(cacheSpanAt(state, 2)).toBe(a);
    expect(cacheSpanAt(state, 2.25)).toBe(null); // painted edge is half-open
    expect(cacheSpanAt(state, 2.4)).toBe(null); // gap between the thin bars
    expect(cacheSpanAt(state, 3)).toBe(b);
  });
});
