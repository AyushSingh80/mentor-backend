import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildTrendGeometry,
  describeTrend,
  movingAverage,
  summariseTrend,
} from '../src/lib/trend';
import type { TrendPoint } from '../src/db/answers';

const SIZE = { width: 300, height: 200 };

/**
 * Builds a point the way `scoreTrend()` does — from a raw score and its max,
 * converted to a percent HERE. The conversion is deliberately spelled out in
 * the fixture so a test that accidentally starts feeding raw totals into the
 * geometry is visible in the diff.
 */
const at = (date: string, score: number, max: number, paper = 'gs1'): TrendPoint => ({
  date,
  percent: (score / max) * 100,
  paper,
});

describe('buildTrendGeometry — the percentage rule', () => {
  /**
   * THE regression this file exists for.
   *
   * Raw totals order  9 > 8 > 7  (anthro, gs1, gs2)
   * Percentages order 70 > 60 > 40  (gs2, anthro, gs1)
   *
   * The two orderings are deliberately different, so a geometry that plotted
   * `total` instead of `percent` cannot accidentally pass. Origin is TOP-LEFT,
   * so the BEST percent must have the SMALLEST y.
   */
  it('orders y by percentage, not by raw total', () => {
    const gs1 = at('2026-09-01', 8, 20); // 40%, raw 8
    const anthro = at('2026-09-02', 9, 15, 'anthro_p1'); // 60%, raw 9 — highest raw
    const gs2 = at('2026-09-03', 7, 10, 'gs2'); // 70%, raw 7 — lowest raw

    const geometry = buildTrendGeometry([gs1, anthro, gs2], SIZE);
    const [yFortyPercent, ySixtyPercent, ySeventyPercent] = geometry.points.map((p) => p.y);

    // 70% sits highest on screen (smallest y), 40% lowest (largest y).
    assert.ok(
      ySeventyPercent < ySixtyPercent,
      `70% (raw 7/10) must sit above 60% (raw 9/15): ${ySeventyPercent} < ${ySixtyPercent}`,
    );
    assert.ok(
      ySixtyPercent < yFortyPercent,
      `60% (raw 9/15) must sit above 40% (raw 8/20): ${ySixtyPercent} < ${yFortyPercent}`,
    );

    // Stated the other way round: sorting by raw total gives a different
    // sequence than sorting by y. If these ever agree, percentages were lost.
    const byRawTotal = [anthro, gs1, gs2]; // 9, 8, 7
    const byScreenHeight = [gs2, anthro, gs1]; // 70%, 60%, 40%
    assert.notDeepEqual(byRawTotal, byScreenHeight);
  });

  it('puts equal percentages at exactly the same y regardless of paper maximum', () => {
    const geometry = buildTrendGeometry(
      [
        at('2026-09-01', 6, 10), // 60%
        at('2026-09-02', 9, 15, 'gs2'), // 60%
        at('2026-09-03', 12, 20, 'essay'), // 60%
        at('2026-09-04', 75, 125, 'essay'), // 60%
      ],
      SIZE,
    );

    const ys = geometry.points.map((p) => p.y);
    for (const y of ys) assert.equal(y, ys[0]);
  });

  it('inverts y: the origin is top-left, so a higher percent is a lower y', () => {
    const geometry = buildTrendGeometry([at('2026-09-01', 2, 10), at('2026-09-02', 9, 10)], SIZE);

    const [low, high] = geometry.points;
    assert.equal(low.percent, 20);
    assert.equal(high.percent, 90);
    assert.ok(high.y < low.y, 'the 90% answer must render nearer the top of the plot');

    // yMax maps to the top edge, yMin to the bottom edge — never the reverse.
    const topTick = geometry.yTicks[geometry.yTicks.length - 1];
    const bottomTick = geometry.yTicks[0];
    assert.ok(topTick.y < bottomTick.y);
    assert.ok(geometry.yTicks.every((t) => t.y >= 0 && t.y <= SIZE.height));
  });
});

describe('buildTrendGeometry — degenerate inputs', () => {
  it('handles zero points without dividing by zero', () => {
    const geometry = buildTrendGeometry([], SIZE);

    assert.deepEqual(geometry.points, []);
    assert.deepEqual(geometry.average, []);
    assert.equal(geometry.width, 300);
    assert.equal(geometry.height, 200);
    assert.equal(geometry.yMin, 0);
    assert.equal(geometry.yMax, 100);
    assert.ok(geometry.yTicks.length > 0);
    assert.ok(geometry.yTicks.every((t) => Number.isFinite(t.y)));
  });

  it('centres a single point instead of pinning it to x = 0', () => {
    const geometry = buildTrendGeometry([at('2026-09-01', 13, 20)], SIZE);

    assert.equal(geometry.points.length, 1);
    assert.equal(geometry.points[0].x, 150);
    assert.ok(Number.isFinite(geometry.points[0].y));
    assert.equal(geometry.average.length, 1);
    assert.equal(geometry.average[0].y, geometry.points[0].y);
  });

  it('keeps a usable axis span when every score is identical', () => {
    const flat = [at('2026-09-01', 6, 10), at('2026-09-02', 9, 15), at('2026-09-03', 12, 20)];
    const geometry = buildTrendGeometry(flat, SIZE);

    assert.ok(geometry.yMax - geometry.yMin >= 20, 'a flat run must not collapse the axis');
    assert.ok(geometry.points.every((p) => Number.isFinite(p.y)));
  });

  it('clamps the axis to 0–100 for a run of perfect scores', () => {
    const geometry = buildTrendGeometry([at('2026-09-01', 10, 10), at('2026-09-02', 20, 20)], SIZE);

    assert.equal(geometry.yMax, 100);
    assert.ok(geometry.yMin >= 0);
    assert.ok(geometry.yMax - geometry.yMin >= 20);
    assert.ok(geometry.points.every((p) => p.y >= 0 && p.y <= SIZE.height));
  });

  it('survives a zero-sized plot area (first render, before onLayout)', () => {
    const geometry = buildTrendGeometry([at('2026-09-01', 6, 10), at('2026-09-02', 8, 10)], {
      width: 0,
      height: 0,
    });

    assert.ok(geometry.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
  });

  it('spreads points evenly across the full width', () => {
    const geometry = buildTrendGeometry(
      [at('2026-09-01', 5, 10), at('2026-09-02', 6, 10), at('2026-09-03', 7, 10)],
      SIZE,
    );

    assert.deepEqual(
      geometry.points.map((p) => p.x),
      [0, 150, 300],
    );
  });
});

describe('movingAverage', () => {
  it('returns one value per point, starting at the first answer', () => {
    const points = [
      at('2026-09-01', 3, 10), // 30
      at('2026-09-02', 6, 10), // 60
      at('2026-09-03', 9, 10), // 90
      at('2026-09-04', 6, 10), // 60
    ];

    assert.deepEqual(movingAverage(points, 3), [30, 45, 60, 70]);
  });

  it('averages percentages, not raw totals', () => {
    // Raw totals 6 and 9 average to 7.5; the percentages 60 and 60 average to 60.
    const average = movingAverage([at('2026-09-01', 6, 10), at('2026-09-02', 9, 15)], 2);
    assert.deepEqual(average, [60, 60]);
  });

  it('handles zero and one point', () => {
    assert.deepEqual(movingAverage([]), []);
    assert.deepEqual(movingAverage([at('2026-09-01', 7, 10)]), [70]);
  });

  it('defaults to a three-answer window', () => {
    const points = [
      at('2026-09-01', 0, 10),
      at('2026-09-02', 0, 10),
      at('2026-09-03', 3, 10),
      at('2026-09-04', 3, 10),
    ];
    assert.deepEqual(movingAverage(points), [0, 0, 10, 20]);
  });

  it('treats a nonsensical window as a window of one', () => {
    const points = [at('2026-09-01', 4, 10), at('2026-09-02', 8, 10)];
    assert.deepEqual(movingAverage(points, 0), [40, 80]);
    assert.deepEqual(movingAverage(points, -5), [40, 80]);
  });

  it('smooths one bad day rather than tracking it', () => {
    const points = [
      at('2026-09-01', 7, 10),
      at('2026-09-02', 7, 10),
      at('2026-09-03', 1, 10), // the bad day
      at('2026-09-04', 7, 10),
    ];
    const smoothed = movingAverage(points, 3);
    assert.ok(smoothed[2] > points[2].percent, 'the dip must be damped, not mirrored');
    assert.ok(smoothed[2] < points[1].percent);
  });
});

describe('summariseTrend / describeTrend', () => {
  it('reports change in percentage points', () => {
    const summary = summariseTrend([at('2026-09-01', 4, 10), at('2026-09-02', 13, 20)]);
    assert.equal(summary.count, 2);
    assert.equal(summary.earliest, 40);
    assert.equal(summary.latest, 65);
    assert.equal(summary.changePoints, 25);
  });

  it('has no change to report from a single answer', () => {
    const summary = summariseTrend([at('2026-09-01', 4, 10)]);
    assert.equal(summary.changePoints, null);
    assert.equal(summary.latest, 40);
  });

  it('describes an empty chart in words', () => {
    assert.match(describeTrend([]), /no scored answers/i);
  });

  it('describes direction and magnitude for a screen reader', () => {
    const text = describeTrend(
      [at('2026-09-01', 4, 10), at('2026-09-02', 6, 10), at('2026-09-03', 7, 10)],
      'GS1',
    );
    assert.match(text, /GS1/);
    assert.match(text, /3 scored answers/);
    assert.match(text, /up 30 points/);
  });

  it('calls a flat run flat rather than inventing a direction', () => {
    const text = describeTrend([at('2026-09-01', 6, 10), at('2026-09-02', 9, 15)]);
    assert.match(text, /flat/);
  });
});
