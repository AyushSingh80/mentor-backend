/**
 * Calendar-day arithmetic on `YYYY-MM-DD` labels.
 *
 * ## Why a shared module
 *
 * Four near-identical private copies of this already exist —
 * `syllabus-coverage.ts`, `mcq-bank.ts`, `activity.ts` and `db/revision.ts`. A
 * fifth, written for the decision engine, would be one more place for the
 * midnight-anchoring rule to drift.
 *
 * ## Why the four copies are NOT migrated here
 *
 * Deliberately, and it should not read as an oversight. Each of those modules
 * has its own tests covering its own arithmetic, and rewiring four tested
 * modules to prove a point about duplication puts working code at risk for no
 * product gain. `today-decision.ts` is this module's only consumer for now.
 * Migrating the rest is a separate change with its own review.
 *
 * ## The rule everything here obeys
 *
 * A day label is a LABEL. It is anchored at UTC midnight only so that two of
 * them can be differenced, and the result is a count of calendar days rather
 * than a duration. Nothing here converts a timezone: a local day is produced by
 * `lib/time.ts#localDate` from the user's zone, and re-parsing one through a
 * local `Date` is how a 22:15 commute drill lands on tomorrow.
 */

const MS_PER_DAY = 86_400_000;

/** The `YYYY-MM-DD` prefix of an ISO instant, or of a day label already. */
export function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

/** UTC midnight of a day label, in ms. Only ever used to difference two days. */
export function dayMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

/**
 * Whole calendar days from `from` to `to`. Negative when `to` is earlier.
 *
 * Returns 0 rather than `NaN` for an unparseable label. A `NaN` here would
 * propagate silently through a division into a rate rendered on screen, and a
 * rate of `NaN` reads as a broken app; a rate of 0 reads as "nothing yet",
 * which is at least a state the caller already has to handle.
 */
export function daysBetween(from: string, to: string): number {
  const a = dayMs(from);
  const b = dayMs(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / MS_PER_DAY);
}

/** A day label `count` days after `day`. Unparseable input is returned as-is. */
export function addDays(day: string, count: number): string {
  const base = dayMs(day);
  if (!Number.isFinite(base)) return day;
  return new Date(base + count * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Whether a label parses as a real calendar day. */
export function isDay(day: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(dayMs(day));
}
