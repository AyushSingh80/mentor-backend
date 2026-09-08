import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildBacklogChart, describeBacklogChart } from '../src/lib/backlog-chart';
import { buildTrendGeometry } from '../src/lib/trend';
import type { BacklogSeriesPoint } from '../src/lib/backlog';

const SIZE = { width: 300, height: 200 };

/**
 * A series point built from HOURS, converted to the content minutes the series
 * actually carries right here in the fixture, so a chart that started reading
 * the wrong field is visible in the diff.
 */
const at = (date: string, backlogHours: number): BacklogSeriesPoint => ({
  date,
  releasedContentMin: backlogHours * 60,
  watchedContentMin: 0,
  skippedContentMin: 0,
  backlogContentMin: backlogHours * 60,
});

function series(hours: number[]): BacklogSeriesPoint[] {
  return hours.map((h, i) => at(`2026-09-${String(i + 1).padStart(2, '0')}`, h));
}

describe('buildBacklogChart — the unbounded domain', () => {
  /**
   * THE regression this file exists for.
   *
   * `lib/trend.ts` clamps its domain to 0–100 and is right to: it only ever
   * sees percentages. Route hours through it and a 100/120/140-hour backlog
   * lands on one flat line at the ceiling — silently wrong, and still shaped
   * like a plausible chart. This asserts both halves: the backlog chart
   * separates them, and `trend.ts` provably would not have.
   */
  it('does not clamp a 140-hour backlog to 100', () => {
    const geometry = buildBacklogChart(series([100, 120, 140]), SIZE);

    assert.ok(
      geometry.yMax >= 140,
      `a 140-hour peak needs an axis of at least 140, got ${geometry.yMax}`,
    );

    const [y100, y120, y140] = geometry.points.map((p) => p.y);
    assert.ok(y140 < y120 && y120 < y100, 'the three readings must be three heights');
    assert.ok(
      Math.abs(y100 - y140) > 10,
      `100h and 140h are ${Math.abs(y100 - y140)}px apart — that is a flattened axis`,
    );

    // What reusing trend.ts would have produced, spelled out. Its domain
    // clamps, so all three collapse onto the same y.
    const clamped = buildTrendGeometry(
      [100, 120, 140].map((h, i) => ({ date: `2026-09-0${i + 1}`, percent: h, paper: 'gs1' })),
      SIZE,
    );
    assert.equal(clamped.yMax, 100, 'trend.ts must still clamp — that is its guarantee');
    const clampedYs = clamped.points.map((p) => p.y);
    assert.equal(new Set(clampedYs).size, 1, 'trend.ts flattens hours; that is why this module exists');
  });

  it('scales its ticks to the magnitude instead of a fixed ladder', () => {
    const small = buildBacklogChart(series([0.5, 1, 1.5]), SIZE);
    const large = buildBacklogChart(series([80, 200, 320]), SIZE);

    assert.ok(small.yMax <= 4, `a 1.5-hour backlog should not get a ${small.yMax}-hour axis`);
    assert.ok(large.yMax >= 320, `a 320-hour peak needs headroom, got ${large.yMax}`);
    assert.ok(small.yTicks.length >= 3 && small.yTicks.length <= 8);
    assert.ok(large.yTicks.length >= 3 && large.yTicks.length <= 8);
  });

  it('anchors the axis at zero, because zero is a state she can reach', () => {
    for (const hours of [[3], [3, 9], [140, 141]]) {
      const geometry = buildBacklogChart(series(hours), SIZE);
      assert.equal(geometry.yMin, 0);
      assert.equal(geometry.yTicks[0].label, '0h');
      assert.equal(geometry.yTicks[0].y, SIZE.height);
    }
  });

  it('keeps the worst day off the top edge', () => {
    for (const peak of [1, 4, 40, 140, 300]) {
      const geometry = buildBacklogChart(series([0, peak]), SIZE);
      assert.ok(geometry.yMax > peak, `axis top ${geometry.yMax} does not clear a ${peak}h peak`);
      const worst = geometry.points[1];
      assert.ok(worst.y > 0, 'the peak dot would be clipped by the frame');
    }
  });
});

describe('buildBacklogChart — the axis is inverted', () => {
  /**
   * Origin is TOP-LEFT, the React Native convention. A worse backlog is
   * HIGHER on screen, which means a SMALLER y. Getting this backwards draws a
   * chart that still looks like a chart while saying the opposite.
   */
  it('gives a higher backlog a smaller y', () => {
    const geometry = buildBacklogChart(series([2, 10, 40]), SIZE);
    const [ySmall, yMedium, yLarge] = geometry.points.map((p) => p.y);

    assert.ok(yLarge < yMedium, `40h (${yLarge}) must sit above 10h (${yMedium})`);
    assert.ok(yMedium < ySmall, `10h (${yMedium}) must sit above 2h (${ySmall})`);

    // Sorting by backlog and sorting by y must give opposite orders. If they
    // ever agree, the inversion was dropped.
    const byBacklog = [...geometry.points].sort((a, b) => a.backlogHours - b.backlogHours);
    const byHeight = [...geometry.points].sort((a, b) => a.y - b.y);
    assert.deepEqual(
      byBacklog.map((p) => p.date),
      [...byHeight].reverse().map((p) => p.date),
    );
  });

  it('puts a cleared backlog on the floor and never below it', () => {
    const geometry = buildBacklogChart(series([0, 12]), SIZE);
    assert.equal(geometry.points[0].y, SIZE.height);
    for (const point of geometry.points) {
      assert.ok(point.y >= 0 && point.y <= SIZE.height, `y ${point.y} escaped the plot`);
    }
  });

  it('positions tick labels with the same inversion as the dots', () => {
    const geometry = buildBacklogChart(series([10, 30]), SIZE);
    for (let i = 1; i < geometry.yTicks.length; i += 1) {
      assert.ok(
        geometry.yTicks[i].y < geometry.yTicks[i - 1].y,
        'later ticks are larger values and must sit higher',
      );
    }
    assert.equal(geometry.yTicks[geometry.yTicks.length - 1].y, 0, 'the top tick is the top edge');
  });
});

describe('buildBacklogChart — degenerate inputs', () => {
  it('handles an empty series without dividing by zero', () => {
    const geometry = buildBacklogChart([], SIZE);
    assert.deepEqual(geometry.points, []);
    assert.equal(geometry.yMin, 0);
    assert.ok(geometry.yMax > 0);
    assert.ok(geometry.yTicks.length > 0);
    for (const tick of geometry.yTicks) assert.ok(Number.isFinite(tick.y));
    assert.equal(geometry.monotonicallyRising, false);
  });

  it('centres a single day rather than pinning it to the left edge', () => {
    const geometry = buildBacklogChart(series([6]), SIZE);
    assert.equal(geometry.points.length, 1);
    assert.equal(geometry.points[0].x, SIZE.width / 2);
    assert.ok(Number.isFinite(geometry.points[0].y));
    assert.equal(geometry.monotonicallyRising, false);
  });

  it('survives a zero-size plot', () => {
    const geometry = buildBacklogChart(series([4, 8]), { width: 0, height: 0 });
    for (const point of geometry.points) {
      assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
    }
    for (const tick of geometry.yTicks) assert.ok(Number.isFinite(tick.y));
  });

  it('treats a run of identical readings as flat, not as a divide by zero', () => {
    const geometry = buildBacklogChart(series([20, 20, 20, 20]), SIZE);
    const ys = geometry.points.map((p) => p.y);
    for (const y of ys) {
      assert.equal(y, ys[0]);
      assert.ok(Number.isFinite(y));
    }
    assert.equal(geometry.monotonicallyRising, false, 'flat is not rising');
  });

  it('spreads points evenly across the full width', () => {
    const geometry = buildBacklogChart(series([1, 2, 3, 4, 5]), SIZE);
    assert.equal(geometry.points[0].x, 0);
    assert.equal(geometry.points[4].x, SIZE.width);
    assert.equal(geometry.points[2].x, SIZE.width / 2);
  });

  it('never plots a negative backlog', () => {
    const corrupt: BacklogSeriesPoint[] = [
      { date: '2026-09-01', releasedContentMin: 0, watchedContentMin: 0, skippedContentMin: 0, backlogContentMin: -600 },
      { date: '2026-09-02', releasedContentMin: 0, watchedContentMin: 0, skippedContentMin: 0, backlogContentMin: 600 },
    ];
    const geometry = buildBacklogChart(corrupt, SIZE);
    assert.equal(geometry.points[0].backlogHours, 0);
    assert.equal(geometry.points[0].y, SIZE.height);
  });
});

describe('buildBacklogChart — monotonicallyRising', () => {
  it('is true only when it never fell and ended higher', () => {
    assert.equal(buildBacklogChart(series([2, 5, 9]), SIZE).monotonicallyRising, true);
    assert.equal(buildBacklogChart(series([2, 2, 9]), SIZE).monotonicallyRising, true);
    assert.equal(buildBacklogChart(series([2, 9, 5]), SIZE).monotonicallyRising, false);
    assert.equal(buildBacklogChart(series([9, 5, 2]), SIZE).monotonicallyRising, false);
    assert.equal(buildBacklogChart(series([9, 9, 9]), SIZE).monotonicallyRising, false);
  });
});

describe('describeBacklogChart', () => {
  it('says there is nothing to plot rather than announcing an empty chart', () => {
    const text = describeBacklogChart(buildBacklogChart([], SIZE));
    assert.match(text, /No lecture history/);
    assert.doesNotMatch(text, /NaN|undefined|Infinity/);
  });

  it('describes a single day without inventing a direction', () => {
    const text = describeBacklogChart(buildBacklogChart(series([4]), SIZE));
    assert.match(text, /One day/);
    assert.match(text, /4 hours/);
    assert.doesNotMatch(text, /up |down /);
  });

  it('reports the direction and size of the change in hours', () => {
    const rising = describeBacklogChart(buildBacklogChart(series([10, 20, 34]), SIZE));
    assert.match(rising, /from 10 to 34 hours/);
    assert.match(rising, /up 24 hours/);
    assert.match(rising, /grown every single day/);

    const falling = describeBacklogChart(buildBacklogChart(series([34, 20, 10]), SIZE));
    assert.match(falling, /down 24 hours/);
    assert.match(falling, /Worst was 34 hours/);
  });

  it('calls a flat stretch level rather than inventing news', () => {
    const text = describeBacklogChart(buildBacklogChart(series([12, 12, 12]), SIZE));
    assert.match(text, /level/);
    assert.doesNotMatch(text, /up |down |grown/);
  });

  it('speaks in hours, never in percent or lecture counts', () => {
    const text = describeBacklogChart(buildBacklogChart(series([1, 60, 140]), SIZE));
    assert.match(text, /hours/);
    assert.doesNotMatch(text, /%|percent|pages|lectures/);
    assert.doesNotMatch(text, /NaN|undefined|Infinity/);
  });
});
