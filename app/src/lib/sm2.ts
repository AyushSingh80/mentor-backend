/**
 * SM-2 spaced repetition. Pure — no RN, no expo-sqlite.
 *
 * SKELETON: types and constants are FROZEN. Bodies are owned by the revision agent.
 *
 * ## Variant
 *
 * SM-2 as published by Wozniak (1987/1990), plus an ease floor, an interval
 * ceiling and a monotonic-interval guard. This is NOT the Anki variant, which
 * differs in its lapse handling and interval modifiers — a reader who assumes
 * Anki will misread every rule below.
 *
 * ## The rules
 *
 *   pass (q >= 3):
 *     n == 0  ->  I = 1
 *     n == 1  ->  I = 6
 *     n >= 2  ->  I = max(I_prev + 1, round(I_prev * EF))
 *     n += 1
 *   fail:
 *     n = 0 ; I = 1 ; lapses += 1
 *
 *   EF += 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)     // on EVERY grade
 *   EF  = max(1.3, EF)
 *   I   = min(I, 180)
 *
 * ## Pitfalls, every one of which needs a test
 *
 * - **Ease floor 1.3.** Without the clamp, repeated failures drive EF negative,
 *   then intervals negative, then `dueAt` permanently in the past. The classic
 *   SM-2 bug.
 * - **The first two intervals are constants**, 1 and 6. Applying `I * EF` from
 *   the first review gives a 2.5-day first interval and a wholly different
 *   schedule. This is why `repetitions` is a stored column.
 * - **q = 4 leaves EF exactly unchanged** — `0.1 - 1*(0.08 + 0.02) = 0`. Assert
 *   it: it is the cheapest possible proof the delta formula was transcribed
 *   correctly.
 * - **The interval-1 absorbing state.** At EF 1.3, `round(1 * 1.3) = 1`
 *   forever. Hence `max(I_prev + 1, ...)`.
 * - **The date-boundary bug, most likely defect in this module.** A card
 *   reviewed at 22:00 and scheduled "+1 day" as a full timestamp is invisible
 *   during the whole 08:00–10:00 morning study block and only appears at 22:00.
 *   Always SET `dueAt` to the start of the due day, and always COMPARE by date
 *   prefix. Both live here so no caller can get it wrong.
 * - **Due-day pile-up.** Enrolling 80 topics at once makes them all fall due on
 *   the same day forever. Do NOT fuzz intervals — that corrupts the algorithm.
 *   Cap the daily list instead, via `selectDueList`.
 *
 * ## Two different 1–5 scales
 *
 * `syllabusTopics.confidence` is a standing self-report. `ReviewGrade` is
 * recall performance right now. Never derive one from the other and never put
 * them in the same control.
 */

export type ReviewGrade = 0 | 1 | 2 | 3 | 4 | 5;

/**
 * Four buttons, not six. `Again = 2` rather than 0 is deliberate: at q=0 the
 * penalty is −0.80, so two lapses drop a fresh item straight to the 1.3 floor,
 * which is far too harsh for a whole syllabus topic. −0.32 is the right
 * severity here, and making it explicit stops it being an accident.
 */
export const GRADE_BUTTONS = [
  { grade: 2 as ReviewGrade, label: 'Again', hint: 'Could not recall it' },
  { grade: 3 as ReviewGrade, label: 'Hard', hint: 'Recalled with real effort' },
  { grade: 4 as ReviewGrade, label: 'Good', hint: 'Recalled correctly' },
  { grade: 5 as ReviewGrade, label: 'Easy', hint: 'Instant and certain' },
] as const;

export interface Sm2State {
  repetitions: number;
  intervalDays: number;
  easeFactor: number;
  lapses: number;
}

export interface Sm2Result extends Sm2State {
  /** ISO, always at the start of the due day in local terms. */
  dueAt: string;
  lapsed: boolean;
}

export const SM2 = {
  minEase: 1.3,
  firstInterval: 1,
  secondInterval: 6,
  /** Beyond six months a review is worthless before the 2028 exam anyway. */
  maxIntervalDays: 180,
  passingGrade: 3,
  /** Failures after which an item is a leech, eating review time daily. */
  leechThreshold: 8,
} as const;

/* ------------------------------------------------------------------ dates */

/**
 * Civil-date arithmetic, deliberately anchored at UTC midnight.
 *
 * Everything below treats an ISO string as a `YYYY-MM-DD` calendar day plus
 * noise. Anchoring the arithmetic at UTC midnight makes "+1 day" exactly
 * 86400000 ms with no DST hour to lose or gain — a local-midnight anchor
 * silently produces 23- and 25-hour days twice a year, which is enough to slip
 * a review across a date boundary.
 */
const MS_PER_DAY = 86_400_000;

function civilDay(dateIso: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateIso);
  if (!match) throw new Error(`Not an ISO date: ${JSON.stringify(dateIso)}`);
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function fromCivilDay(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 10)}T00:00:00.000Z`;
}

/* -------------------------------------------------------------- algorithm */

/**
 * One review.
 *
 * Two orderings matter and both are load-bearing:
 *
 * 1. The interval is computed from the INCOMING ease factor, and only then is
 *    the ease factor updated. That is the order the header's rule block lists
 *    them in and the order Wozniak published. Updating ease first is the Anki
 *    lineage and produces a visibly different schedule from the third review
 *    onward — so this is a choice, not an accident.
 * 2. The ease delta is applied on EVERY grade, failures included. A lapse
 *    resets `repetitions` and the interval; it does NOT reset the ease, and it
 *    does not escape the penalty. That is what eventually grinds a genuinely
 *    hard topic down to the 1.3 floor, which is the signal `isLeech` reads.
 */
export function applyReview(
  state: Sm2State,
  grade: ReviewGrade,
  reviewedOnIso: string,
): Sm2Result {
  const passed = grade >= SM2.passingGrade;

  // The interval multiplier is the ease as it stood BEFORE this review.
  const previousEase = state.easeFactor;

  const delta = 0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02);
  // The floor is the whole reason this clamp exists: unclamped, repeated
  // failures at -0.32 a time drive the ease negative in nine reviews, then the
  // interval negative, and `dueAt` lands permanently in the past.
  const easeFactor = Math.max(SM2.minEase, previousEase + delta);

  let repetitions: number;
  let intervalDays: number;
  let lapses = state.lapses;

  if (!passed) {
    repetitions = 0;
    intervalDays = SM2.firstInterval;
    lapses += 1;
  } else if (state.repetitions === 0) {
    // Constants, not `1 * ease`. This is the reason `repetitions` is a stored
    // column rather than something inferred from the interval.
    repetitions = 1;
    intervalDays = SM2.firstInterval;
  } else if (state.repetitions === 1) {
    repetitions = 2;
    intervalDays = SM2.secondInterval;
  } else {
    repetitions = state.repetitions + 1;
    // `+ 1` breaks the interval-1 absorbing state: at the 1.3 floor,
    // round(1 * 1.3) is 1, so a plain multiply schedules the item for tomorrow
    // forever no matter how often it is passed.
    intervalDays = Math.max(
      state.intervalDays + 1,
      Math.round(state.intervalDays * previousEase),
    );
  }

  intervalDays = Math.min(intervalDays, SM2.maxIntervalDays);

  return {
    repetitions,
    intervalDays,
    easeFactor,
    lapses,
    // The date boundary, handled in the one place every caller goes through:
    // the review instant is collapsed to its calendar day before the interval
    // is added, so a 22:00 review lands at 00:00 on the due day rather than at
    // 22:00 — visible for the whole of the 08:00–10:00 study block.
    dueAt: fromCivilDay(civilDay(reviewedOnIso) + intervalDays * MS_PER_DAY),
    lapsed: !passed,
  };
}

/**
 * Date-prefix comparison, never a timestamp comparison. See the header.
 *
 * Never throws: this is the read path behind the daily list, and one malformed
 * row must not be able to blank the whole screen. A prefix that is not a date
 * simply fails to compare as due.
 */
export function isDue(dueAt: string, todayIso: string): boolean {
  return dueAt.slice(0, 10) <= todayIso.slice(0, 10);
}

export function startOfDayIso(dateIso: string): string {
  return fromCivilDay(civilDay(dateIso));
}

/**
 * An item ground to the ease floor that gets failed forever.
 *
 * Counted in lapses rather than read off the ease factor: the ease bottoms out
 * at 1.3 and stays there, so it cannot distinguish an item that has just
 * arrived at the floor from one that has been failed daily for a month.
 */
export function isLeech(state: Sm2State): boolean {
  return state.lapses >= SM2.leechThreshold;
}

/**
 * Most-overdue-first, capped. Absorbs the first-run enrolment pile-up.
 *
 * The cap is the ONLY defence against pile-up. Fuzzing the intervals would
 * spread the load too, and would also corrupt the algorithm — the schedule is
 * the product, and an interval that is not what SM-2 computed makes every
 * later interval wrong as well.
 *
 * The sort is stable, so items sharing a due date keep the caller's ordering;
 * pass them in syllabus order to get a deterministic list.
 */
export function selectDueList<T extends { dueAt: string }>(
  items: T[],
  todayIso: string,
  cap: number,
): T[] {
  if (!Number.isFinite(cap) || cap <= 0) return [];
  return items
    .filter((item) => isDue(item.dueAt, todayIso))
    .sort((a, b) => (a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : 0))
    .slice(0, Math.floor(cap));
}
