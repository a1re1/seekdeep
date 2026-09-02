import { describe, expect, test } from 'bun:test';
import { modelSeries } from '../src/ui/activity-view.ts';

describe('modelSeries', () => {
  test('gives each model its own per-column values (series is [model][column])', () => {
    const series = { costUsd: [[1, 2, 3], [10, 20, 30]], requests: [[1, 1, 1], [2, 2, 2]] };
    const out = modelSeries({ models: ['a', 'b'], series }, (s) => s.costUsd);
    expect(out.map((r) => r.name)).toEqual(['a', 'b']);
    expect(out[0]!.values).toEqual([1, 2, 3]);
    expect(out[1]!.values).toEqual([10, 20, 30]);
    expect(out[0]!.color).not.toBe(out[1]!.color);
  });
});
