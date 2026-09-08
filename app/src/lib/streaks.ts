/**
 * Consistency: a streak, an adherence rate, and which of the two to believe.
 *
 * Pure. Every clock reading is passed in.
 *
 * ## A word about streaks, because the usual design would hurt her here
 *
 * A conventional streak — one number, broken by one missed day — is a bad fit
 * for an eighteen-month campaign run alongside a 2:30pm–11:30pm shift, for
 * three specific reasons:
 *
 * 1. **It punishes the recoverable.** One late shift, one illness, one family
 *    obligation, and a forty-day count reads as zero. The counter says the same
 *    thing about a person who studied forty of the last forty-one days as about
 *    one who has never opened the app. That is not a motivational quirk; it is
 *    the point at which people quit, and she has until 2028.
 * 2. **It rewards the wrong act.** A chain that any interaction preserves
 *    rewards OPENING THE APP. Within a fortnight the rational move is a
 *    thirty-second tap to keep the number alive, and the number then measures
 *    nothing while looking like it measures everything.
 * 3. **It argues against rest.** A streak that demands seven days a week
 *    demands she never rest, on a schedule where rest is the scarce input. It
 *    would be a burnout driver sitting next to a burnout detector.
 *
 * So the streak here counts STUDY DAYS — days her own plan expected work — and
 * a planned rest day neither breaks it nor extends it. And it is presented
 * second: `adherence` is the honest headline, because a rate degrades
 * gracefully where a chain collapses. Twenty-two of the last twenty-eight days
 * survives a bad Tuesday; a chain does not.
 *
 * `longestStreak` is kept as a RECORD rather than a thing to protect. A record
 * you have already set cannot be lost, which is exactly the property the live
 * counter lacks.
 */

import { wasActive, type ActivityDay } from '@/lib/activity';

export const STREAK_RULES = {
  /**
   * The adherence window.
   *
   * Four weeks: long enough that one bad day moves it by about three points
   * rather than resetting it, short enough to notice a real change within a
   * fortnight. A 90-day window would be so stable that a genuine collapse took
   * a month to show, which is a month she does not have.
   */
  windowDays: 28,
  /**
   * Below this, the rate is worth saying something about.
   *
   * Not a target and never rendered as failure. Five days in seven is a working
   * aspirant's realistic ceiling once a shift, a commute and a household are
   * accounted for; 0.7 is a little under that, so falling through it means
   * something has changed rather than that the week was normal.
   */
  concernRate: 0.7,
  /** Below this the window has too little history to say anything at all. */
  minDaysForRate: 7,
} as const;

export interface StreakInput {
  /** Ascending, oldest first, with gaps present as inactive days. */
  days: readonly ActivityDay[];
  /**
   * Days her plan expected work, as `YYYY-MM-DD`.
   *
   * A day NOT in this set is a planned rest day: it neither breaks the streak
   * nor counts against adherence. Passing an empty set means "every day
   * counts", which is the honest default before a schedule exists.
   */
  studyDays: ReadonlySet<string>;
}

export interface Consistency {
  /**
   * Consecutive study days worked, counting back from the most recent.
   *
   * Planned rest days are skipped rather than counted, so a Sunday off does not
   * inflate the number and does not break it either.
   */
  currentStreak: number;
  /** The record. Cannot be lost, which is the point of keeping it. */
  longestStreak: number;
  /**
   * Share of study days in the window that saw real work, or null.
   *
   * Null means not enough history — which is NOT a rate of zero, and the two
   * must never be confused: reporting 0% to someone on day three is a false
   * alarm that teaches her the number is noise.
   */
  adherence: number | null;
  /** Study days in the window. The denominator, exposed so the rate is checkable. */
  studyDaysInWindow: number;
  activeDaysInWindow: number;
  /** Calendar days since the last day with any work, or null if never. */
  daysSinceActive: number | null;
  /** True when `adherence` is below the concern rate and there is enough history. */
  belowConcern: boolean;
}

function isStudyDay(day: string, studyDays: ReadonlySet<string>): boolean {
  return studyDays.size === 0 || studyDays.has(day);
}

/**
 * The consistency picture. Never throws, and never invents a rate.
 *
 * `days` is expected ascending; the streak walks it backwards from the end.
 */
export function consistency(input: StreakInput): Consistency {
  const days = input.days;
  const studyDays = input.studyDays;

  let currentStreak = 0;
  let longestStreak = 0;
  let running = 0;
  let studyDaysInWindow = 0;
  let activeDaysInWindow = 0;

  for (const day of days) {
    if (!isStudyDay(day.day, studyDays)) continue;
    studyDaysInWindow += 1;
    if (wasActive(day)) {
      activeDaysInWindow += 1;
      running += 1;
      longestStreak = Math.max(longestStreak, running);
    } else {
      running = 0;
    }
  }

  // The current streak is the run ending at the LAST study day in the range.
  // Walking backwards rather than reusing `running` because a trailing rest day
  // would otherwise leave `running` describing an earlier stretch.
  for (let i = days.length - 1; i >= 0; i -= 1) {
    const day = days[i]!;
    if (!isStudyDay(day.day, studyDays)) continue;
    if (!wasActive(day)) break;
    currentStreak += 1;
  }

  // Counted over CALENDAR days, not study days: "four days since you last
  // studied" is what she would say, and a rest day in the middle of those four
  // does not make it two.
  let daysSinceActive: number | null = null;
  for (let i = days.length - 1; i >= 0; i -= 1) {
    if (wasActive(days[i]!)) {
      daysSinceActive = days.length - 1 - i;
      break;
    }
  }

  const adherence =
    studyDaysInWindow >= STREAK_RULES.minDaysForRate
      ? activeDaysInWindow / studyDaysInWindow
      : null;

  return {
    currentStreak,
    longestStreak,
    adherence,
    studyDaysInWindow,
    activeDaysInWindow,
    daysSinceActive,
    belowConcern: adherence !== null && adherence < STREAK_RULES.concernRate,
  };
}

/**
 * The sentence to show. Always populated.
 *
 * Leads with the RATE, not the chain, and never renders a broken streak as
 * loss. "You have studied on 22 of the last 28 study days" is true whether the
 * chain is at nine or at zero, and it is the number that actually tracks
 * whether the preparation is happening.
 */
export function describeConsistency(state: Consistency): string {
  if (state.adherence === null) {
    return state.activeDaysInWindow === 0
      ? 'Not enough history yet to say anything useful about consistency.'
      : `${state.activeDaysInWindow} study ${
          state.activeDaysInWindow === 1 ? 'day' : 'days'
        } so far. A rate needs about a fortnight before it means anything.`;
  }

  const rate = `${state.activeDaysInWindow} of the last ${state.studyDaysInWindow} study days`;

  if (state.currentStreak >= 3) {
    return `${rate}, and ${state.currentStreak} in a row right now.`;
  }

  if (state.daysSinceActive !== null && state.daysSinceActive >= 3) {
    // Deliberately does not mention the streak. She knows it is gone, and
    // saying so is the app rubbing it in at the moment that matters most.
    return `${rate}. Nothing for ${state.daysSinceActive} days — the rate is what carries, and one week does not undo a month.`;
  }

  return state.longestStreak > state.currentStreak
    ? `${rate}. Your longest run is ${state.longestStreak} days.`
    : `${rate}.`;
}
