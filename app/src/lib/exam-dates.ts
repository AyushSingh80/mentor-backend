/**
 * The dates the whole plan is measured against.
 *
 * Extracted from `(tabs)/index.tsx`, where they were a module-local constant and
 * an inline string literal — and therefore unreachable from any module that
 * could be tested. The decision engine needs both, and a second copy of a date
 * that UPSC can move is exactly the kind of duplication that goes stale in one
 * place only.
 */

/**
 * Prelims 2028. Approximate, and updated when UPSC notifies.
 *
 * The only date that actually matters — everything before it is self-imposed.
 */
export const PRELIMS_2028 = '2028-05-21';

/**
 * The default first-pass target when the profile carries none.
 *
 * A self-imposed milestone, not a UPSC date: the first full pass of GS1–4,
 * Anthropology P1 and P2 and Essay. The profile's own `targetFirstPassDate`
 * wins whenever it is set; this is the fallback for a profile written before
 * the field existed.
 */
export const DEFAULT_FIRST_PASS_TARGET = '2027-03-31';
