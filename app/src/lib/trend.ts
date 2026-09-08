/**
 * Score-trend geometry.
 *
 * Pure: no React Native, no Expo, no database imports at runtime. Everything
 * here is arithmetic over already-normalised numbers, so it is unit-testable
 * under plain Node and the chart component stays a dumb renderer.
 *
 * ## Rule 1 — this module only ever sees percentages
 *
 * `TrendPoint.percent` is ALREADY 0–100 and already paper-normalised by
 * `scoreTrend()` in `db/answers.ts`. A 6/10, a 9/15 and a 12/20 are all 60%
 * and must plot at the same height; a 9/15 (60%) must plot BELOW a 7/10 (70%)
 * even though its raw total is larger. `buildTrendGeometry` must therefore
 * never be handed a raw total, an `EvaluationRow`, or a `{ total, max }` pair —
 * the type signature is the enforcement, and `tests/trend.test.ts` is the
 * regression guard. Plotting raw totals would draw a line that mostly tracks
 * which paper was practised that week, not whether the writing improved.
 *
 * ## Rule 2 — y is inverted, because the origin is TOP-LEFT
 *
 * These are React Native view coordinates, not maths coordinates: y grows
 * DOWNWARDS from the top edge of the plot. So a HIGHER percent produces a
 * LOWER `y`, `yMax` maps to `y = 0`, and `yMin` maps to `y = height`. Get this
 * backwards and the chart renders upside down — a steadily improving trend
 * slopes down the screen — which is easy to miss visually because the shape
 * still looks like a plausible chart. `yTicks[]` carries the same inversion,
 * so tick labels and dots agree by construction.
 */

import type { TrendPoint } from '@/db/answers';

export interface TrendGeometry {
  /** Plot width in view pixels, as measured/passed by the caller. */
  width: number;
  /** Plot height in view pixels. */
  height: number;
  /** Bottom of the value axis, in percent. Maps to `y = height`. */
  yMin: number;
  /** Top of the value axis, in percent. Maps to `y = 0`. */
  yMax: number;
  /** One entry per input point, in the same order. `y` is inverted (see above). */
  points: { x: number; y: number; percent: number; date: string; paper: string }[];
  /** Trailing moving average, aligned 1:1 with `points` by x. */
  average: { x: number; y: number }[];
  /** Horizontal gridline positions, already in view pixels. */
  yTicks: { y: number; label: string }[];
}

export interface TrendSize {
  width: number;
  height: number;
}

/**
 * Smallest value span we will ever render.
 *
 * Without a floor, three answers within a point of each other would be spread
 * across the full height and read as violent swings. 20 points of range keeps
 * a flat stretch looking flat.
 */
const MIN_SPAN = 20;

/** Default lookback for the moving average: enough to damp one bad day. */
const DEFAULT_WINDOW = 3;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * Chooses the visible percent range.
 *
 * Padded and rounded outwards to a multiple of 10 so tick labels are round
 * numbers, then clamped to 0–100 because a percentage cannot leave that range.
 * Guaranteed to return `yMax > yMin`, which is what keeps the pixel mapping
 * free of a divide-by-zero when every score is identical.
 */
function valueDomain(percents: number[]): { yMin: number; yMax: number } {
  if (percents.length === 0) return { yMin: 0, yMax: 100 };

  const low = Math.min(...percents);
  const high = Math.max(...percents);
  const pad = Math.max(5, (high - low) * 0.15);

  let yMin = clamp(Math.floor((low - pad) / 10) * 10, 0, 100);
  let yMax = clamp(Math.ceil((high + pad) / 10) * 10, 0, 100);

  if (yMax - yMin < MIN_SPAN) {
    const middle = (yMax + yMin) / 2;
    yMin = middle - MIN_SPAN / 2;
    yMax = middle + MIN_SPAN / 2;
    // Push the window back inside 0–100 rather than clipping it, so the span
    // stays MIN_SPAN wide even for a run of perfect or near-zero scores.
    if (yMin < 0) {
      yMax -= yMin;
      yMin = 0;
    }
    if (yMax > 100) {
      yMin -= yMax - 100;
      yMax = 100;
    }
    yMin = clamp(yMin, 0, 100);
    yMax = clamp(yMax, 0, 100);
  }

  return { yMin, yMax };
}

function tickStep(span: number): number {
  if (span <= 25) return 5;
  if (span <= 60) return 10;
  return 20;
}

/**
 * Percent -> view pixel. THE INVERSION LIVES HERE, and only here.
 *
 * `yMax` (the best score on the axis) becomes 0, the TOP of the plot.
 */
function toPixelY(percent: number, yMin: number, yMax: number, height: number): number {
  const span = yMax - yMin;
  if (span <= 0) return height / 2;
  const fraction = (percent - yMin) / span;
  return clamp(height - fraction * height, 0, height);
}

/**
 * Index -> view pixel.
 *
 * A single point has no interval to divide by, so it is centred rather than
 * pinned to x = 0 (which would look like a rendering bug).
 */
function toPixelX(index: number, count: number, width: number): number {
  if (count <= 1) return width / 2;
  return (index / (count - 1)) * width;
}

/**
 * Trailing simple moving average of `percent`, one value per input point.
 *
 * Deliberately trailing-with-partial-windows rather than only emitting once
 * `window` samples exist: the returned array is the same length as `points`,
 * so the average line starts at the first answer instead of floating two
 * answers in from the left with no explanation.
 */
export function movingAverage(points: TrendPoint[], window = DEFAULT_WINDOW): number[] {
  const size = Math.max(1, Math.floor(window));
  const out: number[] = [];
  let sum = 0;

  for (let i = 0; i < points.length; i += 1) {
    sum += points[i].percent;
    if (i >= size) sum -= points[i - size].percent;
    out.push(sum / Math.min(i + 1, size));
  }

  return out;
}

/**
 * Projects a chronological percent series into plot coordinates.
 *
 * Handles 0 and 1 points without dividing by zero: an empty series returns the
 * default 0–100 axis with no dots, and a single answer is centred horizontally.
 */
export function buildTrendGeometry(points: TrendPoint[], size: TrendSize): TrendGeometry {
  const width = Math.max(0, size.width);
  const height = Math.max(0, size.height);

  const { yMin, yMax } = valueDomain(points.map((p) => p.percent));

  const step = tickStep(yMax - yMin);
  const yTicks: { y: number; label: string }[] = [];
  const first = Math.ceil(yMin / step) * step;
  // 1e-9 absorbs the float error that would otherwise drop the top tick when
  // the domain boundary is itself a multiple of the step.
  for (let value = first; value <= yMax + 1e-9; value += step) {
    yTicks.push({ y: toPixelY(value, yMin, yMax, height), label: `${Math.round(value)}%` });
  }

  const plotted = points.map((point, i) => ({
    x: toPixelX(i, points.length, width),
    y: toPixelY(point.percent, yMin, yMax, height),
    percent: point.percent,
    date: point.date,
    paper: point.paper,
  }));

  const averages = movingAverage(points);
  const average = averages.map((value, i) => ({
    x: toPixelX(i, points.length, width),
    y: toPixelY(value, yMin, yMax, height),
  }));

  return { width, height, yMin, yMax, points: plotted, average, yTicks };
}

export interface TrendSummary {
  count: number;
  latest: number | null;
  earliest: number | null;
  mean: number | null;
  /** Latest minus earliest, in percentage points. Null below two answers. */
  changePoints: number | null;
}

export function summariseTrend(points: TrendPoint[]): TrendSummary {
  if (points.length === 0) {
    return { count: 0, latest: null, earliest: null, mean: null, changePoints: null };
  }

  const earliest = points[0].percent;
  const latest = points[points.length - 1].percent;
  const mean = points.reduce((total, p) => total + p.percent, 0) / points.length;

  return {
    count: points.length,
    latest,
    earliest,
    mean,
    changePoints: points.length > 1 ? latest - earliest : null,
  };
}

/**
 * One sentence describing the chart, for `accessibilityLabel`.
 *
 * A chart built from bare `View`s is completely invisible to a screen reader —
 * it announces nothing, not even "image" — so this text IS the chart for a
 * non-sighted user. Lives here rather than in the component so it is pure and
 * covered by tests.
 */
export function describeTrend(points: TrendPoint[], paperLabel?: string): string {
  const scope = paperLabel ? `${paperLabel} score trend` : 'Score trend';
  const summary = summariseTrend(points);

  if (summary.count === 0) return `${scope}. No scored answers yet.`;

  const round = (n: number) => Math.round(n);
  const answers = `${summary.count} scored ${summary.count === 1 ? 'answer' : 'answers'}`;

  if (summary.count === 1 || summary.changePoints === null) {
    return `${scope}. ${answers}, scoring ${round(summary.latest ?? 0)} percent.`;
  }

  const delta = summary.changePoints;
  const direction =
    Math.abs(delta) < 1 ? 'flat' : delta > 0 ? `up ${round(delta)} points` : `down ${round(-delta)} points`;

  return (
    `${scope}. ${answers}, from ${round(summary.earliest ?? 0)} percent to ` +
    `${round(summary.latest ?? 0)} percent — ${direction}. Average ${round(summary.mean ?? 0)} percent.`
  );
}
