/**
 * Backlog trend geometry. Pure — no RN, no expo-sqlite.
 *
 * SKELETON: types are FROZEN. Bodies are owned by the dashboard agent.
 *
 * ## Why this is not `trend.ts`
 *
 * `lib/trend.ts` is percentage-only by design: its domain clamps to 0–100 and
 * its ticks round to multiples of ten, and `tests/trend.test.ts` exists to
 * enforce exactly that. Feed it a 140-hour backlog and every point clamps to
 * the ceiling, drawing a flat line — silently wrong, and still looking like a
 * plausible chart, which is the precise failure its own header warns about.
 *
 * Generalising it would mean deleting the guarantee Phase 1 shipped, on a
 * module with no component-level coverage, for the benefit of one screen. So
 * this duplicates roughly forty lines of pixel arithmetic instead. That is the
 * intended trade — do not helpfully merge them.
 *
 * ## Axis convention
 *
 * `y` is in view pixels with the origin TOP-LEFT, the React Native convention.
 * A LARGER backlog produces a SMALLER `y`. Getting this backwards renders the
 * chart upside down, which is easy to miss because it still looks like a chart.
 */

import type { BacklogSeriesPoint } from '@/lib/backlog';

export interface BacklogChartPoint {
  x: number;
  y: number;
  date: string;
  backlogHours: number;
}

export interface BacklogChartGeometry {
  width: number;
  height: number;
  /** Hours, unbounded above. Never clamped to 100. */
  yMin: number;
  yMax: number;
  points: BacklogChartPoint[];
  yTicks: { y: number; label: string }[];
  /** True when the series only ever went up — worth colouring differently. */
  monotonicallyRising: boolean;
}

/**
 * The axis always starts at zero.
 *
 * Zero is a real, reachable state here — "caught up" — unlike a percentage
 * axis where the interesting band is somewhere in the middle. Anchoring at
 * zero means the height of the line IS the size of the problem, so a backlog
 * that doubles looks twice as bad instead of being re-normalised back into the
 * same-looking chart by a floating window.
 */
const Y_MIN_HOURS = 0;

/** Smallest top-of-axis, so an empty or freshly-cleared chart still has a scale. */
const MIN_TOP_HOURS = 2;

/** Target gridline count. Four or five intervals read cleanly at phone width. */
const TICK_INTERVALS = 4;

/** Mantissas a human reads without effort, ×10ⁿ. */
const STEP_MANTISSAS = [1, 2, 2.5, 4, 5, 10];

/**
 * Smallest readable interval that fits the range in about `TICK_INTERVALS`.
 *
 * The whole point of not reusing `trend.ts` is that the domain is unbounded,
 * so the tick step cannot be a fixed 5/10/20 ladder: the same function has to
 * produce `0.5h` ticks for a two-hour backlog and `40h` ticks for a
 * hundred-and-forty-hour one.
 */
function niceStep(span: number): number {
  if (!Number.isFinite(span) || span <= 0) return 1;
  const rough = span / TICK_INTERVALS;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  for (const mantissa of STEP_MANTISSAS) {
    const step = mantissa * magnitude;
    if (step >= rough - 1e-9) return step;
  }
  return 10 * magnitude;
}

/**
 * Chooses the visible hours range.
 *
 * Deliberately has no upper clamp. A 140-hour backlog produces a 160-hour
 * axis; the ONLY reason this module exists rather than calling `trend.ts` is
 * that the same input there would clamp to 100 and flatten.
 */
function valueDomain(hours: number[]): { yMin: number; yMax: number; step: number } {
  const peak = hours.length > 0 ? Math.max(...hours) : 0;
  const top = Math.max(MIN_TOP_HOURS, peak);
  const step = niceStep(top - Y_MIN_HOURS);

  // Round the top out to a whole number of steps so the last gridline IS the
  // top edge, then push one step further if the worst day landed exactly on
  // it — a dot welded to the frame reads as clipped rather than as a peak.
  let yMax = Math.max(step, Math.ceil((top - 1e-9) / step) * step);
  if (yMax <= peak + 1e-9) yMax += step;

  return { yMin: Y_MIN_HOURS, yMax, step };
}

/** Hours -> view pixel. THE INVERSION LIVES HERE, and only here. */
function toPixelY(hours: number, yMin: number, yMax: number, height: number): number {
  const span = yMax - yMin;
  if (span <= 0) return height / 2;
  const fraction = (hours - yMin) / span;
  // Clamped to the plot box, not to the value domain: an out-of-domain point
  // is a bug elsewhere, and drawing it off-canvas would hide it.
  return Math.min(height, Math.max(0, height - fraction * height));
}

/**
 * Index -> view pixel.
 *
 * A single day has no interval to divide by, so it is centred rather than
 * pinned to x = 0 (which would look like a rendering bug).
 */
function toPixelX(index: number, count: number, width: number): number {
  if (count <= 1) return width / 2;
  return (index / (count - 1)) * width;
}

/**
 * Ticks are formatted from the value alone, with trailing zeros dropped, so a
 * `0.5h` step and a `40h` step both read naturally without decimal bookkeeping.
 */
function formatTick(value: number): string {
  return `${Math.round(value * 100) / 100}h`;
}

/** `12.4` -> `12.4`, `12.0` -> `12`. Hours read badly with a trailing `.0`. */
function formatHours(hours: number): string {
  const rounded = Math.round(hours * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function hoursWord(hours: number): string {
  return Math.abs(Math.round(hours * 10) / 10) === 1 ? 'hour' : 'hours';
}

/**
 * Projects a chronological backlog series into plot coordinates.
 *
 * Handles 0 and 1 points without dividing by zero: an empty series returns the
 * default axis with no dots, and a single day is centred horizontally.
 */
export function buildBacklogChart(
  series: BacklogSeriesPoint[],
  size: { width: number; height: number },
): BacklogChartGeometry {
  const width = Math.max(0, size.width);
  const height = Math.max(0, size.height);

  const hours = series.map((point) => Math.max(0, point.backlogContentMin) / 60);
  const { yMin, yMax, step } = valueDomain(hours);

  const yTicks: { y: number; label: string }[] = [];
  // 1e-9 absorbs the float error that would otherwise drop the top tick when
  // the domain boundary is itself a multiple of the step.
  for (let value = yMin; value <= yMax + 1e-9; value += step) {
    yTicks.push({ y: toPixelY(value, yMin, yMax, height), label: formatTick(value) });
  }

  const points: BacklogChartPoint[] = series.map((point, i) => ({
    x: toPixelX(i, series.length, width),
    y: toPixelY(hours[i], yMin, yMax, height),
    date: point.date,
    backlogHours: hours[i],
  }));

  // "Rising" means every step was up or level AND it actually ended higher.
  // A perfectly flat fortnight is not rising, and colouring it as though it
  // were would be the app inventing bad news.
  let neverFell = series.length >= 2;
  for (let i = 1; i < hours.length; i += 1) {
    if (hours[i] < hours[i - 1] - 1e-9) {
      neverFell = false;
      break;
    }
  }
  const monotonicallyRising =
    neverFell && hours.length >= 2 && hours[hours.length - 1] > hours[0] + 1e-9;

  return { width, height, yMin, yMax, points, yTicks, monotonicallyRising };
}

/** One spoken sentence, since a chart made of Views is invisible to a reader. */
export function describeBacklogChart(geometry: BacklogChartGeometry): string {
  const points = geometry.points;
  if (points.length === 0) return 'Lecture backlog trend. No lecture history yet.';

  const first = points[0];
  const last = points[points.length - 1];

  if (points.length === 1) {
    return (
      `Lecture backlog trend. One day of history: ${formatHours(first.backlogHours)} ` +
      `${hoursWord(first.backlogHours)} behind.`
    );
  }

  const peak = points.reduce((worst, p) => (p.backlogHours > worst.backlogHours ? p : worst), first);
  const change = last.backlogHours - first.backlogHours;
  const rounded = Math.round(change * 10) / 10;

  const direction =
    rounded === 0
      ? 'level'
      : rounded > 0
        ? `up ${formatHours(rounded)} ${hoursWord(rounded)}`
        : `down ${formatHours(-rounded)} ${hoursWord(rounded)}`;

  const trailer = geometry.monotonicallyRising
    ? ' It has grown every single day.'
    : peak.backlogHours > last.backlogHours + 1e-9
      ? ` Worst was ${formatHours(peak.backlogHours)} ${hoursWord(peak.backlogHours)}.`
      : '';

  return (
    `Lecture backlog trend over ${points.length} days, from ` +
    `${formatHours(first.backlogHours)} to ${formatHours(last.backlogHours)} ` +
    `${hoursWord(last.backlogHours)} behind — ${direction}.${trailer}`
  );
}
