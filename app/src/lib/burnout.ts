/**
 * Burnout signals, from work she was already doing.
 *
 * Pure. Every clock reading is passed in.
 *
 * ## The two ways this feature normally fails
 *
 * **It cries wolf.** An app that always has a concern is an app whose concerns
 * are scrolled past, and by the time one matters it has been trained into
 * furniture. So `detectBurnout` returns AT MOST ONE finding, and returning null
 * is the expected outcome on a normal week. Every threshold below is set where
 * a normal bad week does not trip it.
 *
 * **It measures the wrong thing.** "Hours studied" falls on a week she was ill
 * and on a week she was fine and busy, and neither is burnout. What separates
 * them is the SHAPE: burnout on this schedule looks like sustained volume with
 * collapsing breadth (grinding one easy surface), or work drifting later and
 * later into the night on top of an 11:30pm finish, or output holding while
 * scores fall — effort without absorption.
 *
 * ## Every finding names one small thing to do
 *
 * Because "you may be burning out" is not actionable and reads as an
 * accusation. A finding she can act on in one morning is one she might act on;
 * a diagnosis is one she will argue with.
 */

import { wasActive, type ActivityDay, type ActivityKind } from '@/lib/activity';

export const BURNOUT_RULES = {
  /** Two weeks against the two before them. Shorter is noise; longer is late. */
  windowDays: 14,
  /**
   * Volume must fall by this much before it is worth mentioning.
   *
   * 45%, which is a lot. A 20% dip is a normal fortnight — one heavy week at
   * work, one weekend away — and flagging it would fire most months.
   */
  volumeDropShare: 0.45,
  /**
   * Work in the SMALL HOURS is the night-shift signal, and it is measured as
   * work starting before this minute rather than ending after one.
   *
   * The distinction is load-bearing. Her shift ends at 23:30 and she is home
   * around midnight, so a 01:40 revision falls on the NEXT calendar day at
   * minute 100 — a small number, not a large one. Testing `lastMinute` against
   * a late threshold looks right and is backwards: it would catch a healthy
   * 23:45 session and miss the 01:40 one entirely.
   *
   * 04:00, because her wake time is 07:15 and study starts at 08:00; nothing
   * legitimate on this schedule begins before four.
   */
  smallHoursEndMinute: 4 * 60,
  /** Late nights in the window before it is a pattern rather than a bad night. */
  lateNightCount: 5,
  /**
   * Breadth below this, sustained, means one surface is carrying everything.
   *
   * MCQ drilling is the usual one: it is the easiest thing to do tired, gives
   * the most immediate feedback, and is the least like the Mains paper that
   * decides the result.
   */
  narrowBreadth: 1,
  narrowDayCount: 8,
  /** Self-reported energy at or below this, averaged, when she has reported it. */
  lowEnergy: 2.2,
  minReportsForEnergy: 4,
  /** Days of history before any of this is worth computing. */
  minDaysOfHistory: 21,
} as const;

export type BurnoutSignal =
  | 'volume_collapse'
  | 'late_night_drift'
  | 'narrowing'
  | 'low_energy'
  | 'effort_without_absorption';

export interface BurnoutFinding {
  signal: BurnoutSignal;
  /** What was observed, in numbers she can check against her own memory. */
  observation: string;
  /** One small thing to do. Never a plan, never a list. */
  suggestion: string;
}

export interface BurnoutInput {
  /** Ascending, oldest first, gaps present as inactive days. */
  days: readonly ActivityDay[];
  /**
   * Recent evaluation scores as fractions of their maximum, oldest first.
   *
   * Optional. Absent means the absorption check simply does not run, rather
   * than running on nothing — a check with no data must be silent, not clean.
   */
  scoreFractions?: readonly number[];
}

function totalWeight(day: ActivityDay): number {
  let total = 0;
  for (const kind of Object.keys(day.weights) as ActivityKind[]) {
    total += day.weights[kind];
  }
  return total;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * At most one finding, or null.
 *
 * Order is priority order, and it is chosen so the finding she gets is the one
 * that costs most to ignore: sleep first, because sleep debt compounds and
 * everything else is downstream of it.
 */
export function detectBurnout(input: BurnoutInput): BurnoutFinding | null {
  const days = input.days;
  if (days.length < BURNOUT_RULES.minDaysOfHistory) return null;

  const window = days.slice(-BURNOUT_RULES.windowDays);
  const previous = days.slice(-BURNOUT_RULES.windowDays * 2, -BURNOUT_RULES.windowDays);

  /* --------------------------------------------- 1. sleep, before anything else */

  const lateNights = window.filter(
    (day) => day.firstMinute !== null && day.firstMinute < BURNOUT_RULES.smallHoursEndMinute,
  ).length;

  if (lateNights >= BURNOUT_RULES.lateNightCount) {
    return {
      signal: 'late_night_drift',
      observation: `You have studied in the small hours on ${lateNights} of the last ${window.length} days.`,
      suggestion:
        'Move one block earlier tomorrow rather than adding one. On a shift that ends at 11:30, the hour after midnight is borrowed from the morning that actually produces the first pass.',
    };
  }

  /* ------------------------------------------------ 2. energy, when reported */

  const energies = window
    .map((day) => day.energy)
    .filter((value): value is number => value !== null && Number.isFinite(value));

  if (energies.length >= BURNOUT_RULES.minReportsForEnergy) {
    const average = mean(energies)!;
    if (average <= BURNOUT_RULES.lowEnergy) {
      return {
        signal: 'low_energy',
        observation: `Your own energy scores average ${average.toFixed(1)} out of 5 over ${energies.length} days.`,
        suggestion:
          'Take one full off-day this week and put nothing on it. The lecture backlog tracker exists so a rest day is a visible cost rather than an invisible one — check what it actually costs before deciding you cannot afford it.',
      };
    }
  }

  /* ---------------------------------------------------- 3. volume collapse */

  if (previous.length >= BURNOUT_RULES.windowDays) {
    const now = mean(window.map(totalWeight))!;
    const before = mean(previous.map(totalWeight))!;
    if (before > 0 && now < before * (1 - BURNOUT_RULES.volumeDropShare)) {
      const drop = Math.round((1 - now / before) * 100);
      return {
        signal: 'volume_collapse',
        observation: `Your work is down about ${drop}% against the fortnight before it.`,
        suggestion:
          'Pick the single smallest thing — one MCQ set on the commute — and do only that tomorrow. A fortnight of nothing is recoverable; the habit of not opening the app is the part that is not.',
      };
    }
  }

  /* ------------------------------------------------------- 4. narrowing */

  const activeDays = window.filter(wasActive);
  const narrowDays = activeDays.filter((day) => day.breadth <= BURNOUT_RULES.narrowBreadth);

  if (
    activeDays.length >= BURNOUT_RULES.narrowDayCount &&
    narrowDays.length >= BURNOUT_RULES.narrowDayCount
  ) {
    // Name the surface she has narrowed ONTO. "You are only doing one thing" is
    // a shrug; "you have only been drilling MCQs" is something she recognises.
    const counts = new Map<ActivityKind, number>();
    for (const day of narrowDays) {
      for (const kind of day.kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    const [dominant] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const label = dominant?.[0] === 'mcq' ? 'MCQ drilling' : `${dominant?.[0] ?? 'one thing'} alone`;

    return {
      signal: 'narrowing',
      observation: `${narrowDays.length} of your last ${activeDays.length} study days were ${label} and nothing else.`,
      suggestion:
        'Write one answer tomorrow, even a bad one. Drilling is the easiest thing to do tired and the least like the paper that decides the result.',
    };
  }

  /* ------------------------------- 5. effort holding, absorption falling */

  const scores = input.scoreFractions ?? [];
  if (scores.length >= 6 && previous.length >= BURNOUT_RULES.windowDays) {
    const half = Math.floor(scores.length / 2);
    const earlier = mean(scores.slice(0, half));
    const later = mean(scores.slice(half));
    const volumeNow = mean(window.map(totalWeight))!;
    const volumeBefore = mean(previous.map(totalWeight))!;
    const volumeHeld = volumeBefore === 0 || volumeNow >= volumeBefore * 0.8;

    if (earlier !== null && later !== null && volumeHeld && later < earlier - 0.08) {
      return {
        signal: 'effort_without_absorption',
        observation: `You are working as much as before, and your answer scores have fallen from about ${Math.round(
          earlier * 100,
        )}% to ${Math.round(later * 100)}%.`,
        suggestion:
          'Read the last three evaluations end to end before writing the next answer. More volume will not fix a problem the feedback has already named.',
      };
    }
  }

  return null;
}

/**
 * A plain summary when there is nothing to flag, or null.
 *
 * Deliberately separate from `detectBurnout`, so a screen can show reassurance
 * without a finding having to be invented to fill the space.
 */
export function describeSteadiness(days: readonly ActivityDay[]): string | null {
  if (days.length < BURNOUT_RULES.minDaysOfHistory) return null;
  const window = days.slice(-BURNOUT_RULES.windowDays);
  const active = window.filter(wasActive).length;
  if (active === 0) return null;
  return `${active} study days in the last ${window.length}, across ${
    new Set(window.flatMap((day) => day.kinds)).size
  } kinds of work. Nothing here looks like strain.`;
}
