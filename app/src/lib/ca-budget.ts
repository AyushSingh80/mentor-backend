/**
 * Volume discipline for the current-affairs feed. Pure — no RN, no expo-sqlite.
 *
 * The failure mode of every current-affairs system is that it produces more
 * than anyone can read, so she reads none of it. `CA_RULES` fixes the numbers;
 * this module is the machinery that actually holds the line, and there are only
 * four decisions in it:
 *
 *   - `estimateReadMinutes` — what a digest costs, in minutes.
 *   - `digestBudget`        — how big tomorrow's digest is allowed to be.
 *   - `readRate`            — how much of the recent feed she actually read.
 *   - `shouldRequestDigest` — whether to spend money asking for one at all.
 *
 * ## The feedback loop, which is the whole point
 *
 * `readRate` feeds `digestBudget`. When the 14-day read rate falls below
 * `CA_RULES.readRateFloor` the cap drops by one and the reason says so in
 * words. Six a day she reads beats eight she does not, and a cap that shrinks
 * silently teaches nothing — she would only see a shorter list and assume the
 * feed had a quiet week.
 *
 * ## The day-one false alarm, defended twice
 *
 * `readRate` returns `null` when there is no evidence, and `null` NEVER shrinks
 * the cap. This is `projectFirstPass`'s rule, which reports `behindTarget:
 * false` when nothing has moved: a fresh install that fires a warning on day
 * one is what makes every later, true warning ignorable.
 *
 * The second defence is inside `readRate` itself — see its header. Items that
 * are still inside their `catchUpDays` reading window are not evidence of
 * anything yet, so this morning's unread digest cannot drag the rate to zero
 * and shrink tomorrow's cap before she has had breakfast.
 *
 * Import rules for pure code: `@/lib/ca-types`, `@/lib/papers`, `@/lib/time`
 * and `@/lib/sm2` are safe value imports; `@/db/*` is type-only.
 */

import { CA_RULES, type DigestDay } from '@/lib/ca-types';

/* ------------------------------------------------------------------ dates */

const MS_PER_DAY = 86_400_000;

/** A `YYYY-MM-DD` prefix. Byte-compared throughout, never parsed for ordering. */
function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Civil-date arithmetic anchored at UTC midnight, exactly as `lib/sm2.ts` does
 * it and for the same reason: a local-midnight anchor produces 23- and 25-hour
 * days twice a year, which is enough to slide a window boundary by a day.
 *
 * Returns `null` rather than throwing. Every caller here is on a read path
 * behind a screen, and one hand-edited row must not be able to blank it.
 */
function shiftDay(day: string, delta: number): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) + delta * MS_PER_DAY;
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

function hoursSince(from: string | null, now: string): number | null {
  if (from === null) return null;
  const a = Date.parse(from);
  const b = Date.parse(now);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (b - a) / 3_600_000;
}

function percent(rate: number): number {
  return Math.round(rate * 100);
}

/* -------------------------------------------------------------- estimates */

/**
 * What she reads of an item: the headline plus the note.
 *
 * Structural, so a `CaItemFacts[]` is assignable without a conversion.
 */
export interface ReadableItem {
  headline: string;
  noteMd: string;
}

function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed === '') return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * Reading time for a digest, at `CA_RULES.readWordsPerMinute`.
 *
 * This is READING only. The 20-minute weekday budget is reading plus writing
 * the link into her own notes, and the header of `ca-types.ts` puts the split
 * at roughly 5 minutes to 15 — so an estimate that came back near 20 would mean
 * the digest had already eaten the part that does the actual work.
 *
 * `evidenceJson` is deliberately not counted. The quotes are proof she opens
 * when she doubts a note, not part of the daily read.
 *
 * Rounded up, so "3 minutes" is never an under-promise; zero items cost zero
 * rather than one.
 *
 * ## Not the figure the digest screen shows
 *
 * `readDigestDay` reports `estimatedMinutes`, and it is a DIFFERENT quantity on
 * purpose: notes only (no headlines), unread items only, and scaled by
 * `LINKING_MULTIPLIER` so a full six-item day estimates at the whole 20-minute
 * block rather than at the five minutes of reading inside it. That is the right
 * number to show her, because the block is what she is spending.
 *
 * This one is the right number to CHECK, because "does the reading fit inside
 * the block with room for the linking" is a question about the reading alone.
 * Two functions, two questions; they share `readWordsPerMinute` and nothing
 * else, and neither should be rewritten in terms of the other.
 */
export function estimateReadMinutes(items: readonly ReadableItem[]): number {
  let words = 0;
  for (const item of items) {
    words += countWords(item.headline) + countWords(item.noteMd);
  }
  if (words === 0) return 0;
  return Math.ceil(words / CA_RULES.readWordsPerMinute);
}

/* ----------------------------------------------------------- the read rate */

/** The two fields the read rate is measured from. `CaItemFacts` satisfies it. */
export interface DeliveredItem {
  /** Digest day, `YYYY-MM-DD`. The day it was DELIVERED, not published. */
  date: string;
  readAt: string | null;
}

/**
 * The share of recently delivered items she actually opened, or `null`.
 *
 * ## Only settled items count
 *
 * The window is `CA_RULES.readRateWindowDays` wide, but its recent edge is
 * clipped by `CA_RULES.catchUpDays`: an item is "due to read" for three days
 * and is archive after that, so an item delivered this morning has not been
 * ignored — it has not had its turn. Counting it would cap the achievable rate
 * below 1 even with perfect discipline, and, far worse, would make the FIRST
 * digest ever delivered score 0/6 and shrink day two's cap. That is precisely
 * the false alarm this module exists not to raise.
 *
 * ## `null` means no evidence, and it is not a zero
 *
 * With nothing settled in the window there is no rate — not a rate of zero.
 * `digestBudget` treats the two completely differently and must be able to
 * tell them apart, which a number cannot express.
 */
export function readRate(items: readonly DeliveredItem[], asOfDay: string): number | null {
  const asOf = dayOf(asOfDay);
  const windowStart = shiftDay(asOf, -(CA_RULES.readRateWindowDays - 1));
  // The newest day that has had its full reading window. See the header.
  const settledBy = shiftDay(asOf, -CA_RULES.catchUpDays);
  if (windowStart === null || settledBy === null) return null;

  let delivered = 0;
  let read = 0;

  for (const item of items) {
    const day = dayOf(item.date);
    if (day < windowStart || day > settledBy) continue;
    delivered += 1;
    if (item.readAt !== null && item.readAt !== '') read += 1;
  }

  if (delivered === 0) return null;
  return read / delivered;
}

/* --------------------------------------------------------------- the cap */

export interface DigestBudget {
  /** How many items the digest may contain. */
  items: number;
  /**
   * The minutes the block allows — the CEILING, not the estimate.
   *
   * It does not shrink when `items` does: the time she has on a Tuesday is a
   * fact about her shift, not about her reading discipline. Compare it against
   * `estimateReadMinutes` to see how much of it a digest would actually cost.
   */
  minutes: number;
  /** True when the read-rate feedback took one item off the cap. */
  reduced: boolean;
  /** Always populated. A cap that changes without saying why teaches nothing. */
  reason: string;
}

/**
 * Saturday, JS `Date.getDay()` convention — the same 0-is-Sunday numbering
 * `profile.workDays` and `DerivedBlock.dayOfWeek` already use.
 */
const SATURDAY = 6;

/**
 * How big tomorrow's digest may be.
 *
 * ## One bigger day a week, and it is Saturday
 *
 * `CA_RULES.weekendItemCap` is spent on Saturday alone; Sunday takes the
 * weekday cap. Both are off days, but they are not interchangeable — Sunday's
 * `OFFDAY_SLOTS` open with a timed answer set under exam conditions and close
 * with the capped lecture-backlog catch-up, so it is the most heavily committed
 * day of her week. Handing it the larger pile of current affairs as well is the
 * exact volume failure this module exists to prevent. Saturday is where the
 * genuine slack is, so Saturday is where the week's threads get read together.
 *
 * An out-of-range or non-integer `dayOfWeek` falls through to the weekday cap,
 * which is the smaller of the two: being wrong towards less reading is
 * recoverable, being wrong towards more is what makes her stop opening the app.
 */
export function digestBudget(input: {
  dayOfWeek: number;
  /** From `readRate`. `null` means no evidence, and never shrinks the cap. */
  recentReadRate: number | null;
}): DigestBudget {
  const saturday = Number.isInteger(input.dayOfWeek) && input.dayOfWeek === SATURDAY;
  const items = saturday ? CA_RULES.weekendItemCap : CA_RULES.dailyItemCap;
  const minutes = saturday ? CA_RULES.weekendBudgetMinutes : CA_RULES.dailyBudgetMinutes;
  const dayName = saturday ? 'Saturday' : 'a weekday';

  const rate = input.recentReadRate;

  // The day-one rule, stated once and stated here. `null` is "no evidence yet",
  // which is not the same as "she reads nothing" and must not be punished like
  // it. See `projectFirstPass`, which reports `behindTarget: false` for exactly
  // this reason when nothing has moved.
  if (rate === null || !Number.isFinite(rate)) {
    return {
      items,
      minutes,
      reduced: false,
      reason: `${items} items on ${dayName}, inside a ${minutes}-minute block. Not enough reading history yet to adjust that.`,
    };
  }

  if (rate < CA_RULES.readRateFloor) {
    // Never below one. A cap of zero is not discipline, it is the feed being
    // switched off without anyone deciding to switch it off.
    const reduced = Math.max(1, items - 1);
    return {
      items: reduced,
      minutes,
      reduced: true,
      reason:
        `You read ${percent(rate)}% of the last ${CA_RULES.readRateWindowDays} days' items, ` +
        `under the ${percent(CA_RULES.readRateFloor)}% mark — so today is ${reduced} items, not ${items}. ` +
        `${reduced} a day you read beats ${items} you do not.`,
    };
  }

  return {
    items,
    minutes,
    reduced: false,
    reason:
      `${items} items on ${dayName}, inside a ${minutes}-minute block. ` +
      `You are reading ${percent(rate)}% of what arrives, above the ${percent(CA_RULES.readRateFloor)}% mark.`,
  };
}

/* ------------------------------------------------------------ the trigger */

/**
 * `auto` is the app deciding. The other two are her deciding: `manual` is
 * today's button, `catch_up` is asking for a day that was missed. Both
 * deliberate acts are gated identically — see `shouldRequestDigest`.
 *
 * Matches `CaDigestTrigger` in `db/ca.ts`, restated rather than imported
 * because pure modules take `@/db/*` as types only and this one takes nothing
 * from there at all.
 */
export type DigestTrigger = 'auto' | 'manual' | 'catch_up';

/** `'none'` means no digest was ever requested for the day. From `DigestDay`. */
export type DigestStatus = DigestDay['status'];

export interface DigestGate {
  trigger: DigestTrigger;
  /** The real instant. Cooldowns are elapsed time, not calendar days. */
  now: string;
  /**
   * The status of the digest for the day being asked for, from
   * `DigestDay.status`. Today's, except on a `catch_up` request, where it is
   * the missed day's — the "one a day" rule is per calendar day either way.
   */
  todayStatus: DigestStatus;
  /**
   * The last digest ATTEMPT, successful or not.
   *
   * On attempts rather than successes, for `BANK_RULES.refillCooldownHours`'
   * reason verbatim: three failed calls in ten minutes cost the same money and
   * battery as three successful ones, and a server that is down stays down for
   * longer than six minutes.
   */
  lastAttemptAt: string | null;
  healthOk: boolean;
  spendCapAllows: boolean;
}

export interface DigestDecision {
  request: boolean;
  /** Shown on the screen. "Nothing happened" must always be explicable. */
  reason: string;
}

/**
 * Whether to ask the server for a digest.
 *
 * Same shape and same ordering as `shouldRefill`, because it is the same
 * problem with different nouns. The order is load-bearing:
 *
 * 1. **Already running.** Two in flight would race for the same `ca_digests`
 *    row and one would lose on the unique index.
 * 2. **Already delivered.** `ca_digests` has a UNIQUE index on `date`, so a
 *    second request for the same day is not merely wasteful, it is a
 *    constraint error. This check comes before the manual escape hatch below
 *    for that reason — manual can skip a policy, it cannot skip the database.
 * 3. **`partial` counts as delivered.** A short batch is a success, exactly as
 *    it is for the question bank: the items that arrived are real, the day is
 *    served, and re-running spends money to duplicate most of what she already
 *    has. Only `failed` — which produces no items at all — is retryable.
 * 4. **Spend cap.** Refused for manual too. The cap is not a preference.
 * 5. **Deliberate request.** `manual` and `catch_up` alike: she has the screen
 *    in front of her, and the app second-guessing her past this point would
 *    just be the app being wrong out loud.
 * 6. **Cooldown, then health.** Automatic only.
 */
export function shouldRequestDigest(gate: DigestGate): DigestDecision {
  if (gate.todayStatus === 'pending') {
    return { request: false, reason: 'Today’s digest is already being built.' };
  }

  if (gate.todayStatus === 'completed') {
    return { request: false, reason: 'Today’s digest has already arrived — there is one a day.' };
  }

  if (gate.todayStatus === 'partial') {
    return {
      request: false,
      reason:
        'Today’s digest came through short. What arrived is real and is kept; ' +
        'a second run would spend money to fetch most of it again.',
    };
  }

  if (!gate.spendCapAllows) {
    return {
      request: false,
      reason: 'The spend cap is reached, so no digest can be generated until it resets.',
    };
  }

  if (gate.trigger !== 'auto') {
    return {
      request: true,
      reason:
        gate.trigger === 'catch_up'
          ? 'You asked for a day that was missed.'
          : 'You asked for today’s digest.',
    };
  }

  const sinceLast = hoursSince(gate.lastAttemptAt, gate.now);
  if (sinceLast !== null && sinceLast < CA_RULES.digestCooldownHours) {
    const remaining = Math.max(1, Math.ceil(CA_RULES.digestCooldownHours - sinceLast));
    return {
      request: false,
      reason: `The last attempt was under ${CA_RULES.digestCooldownHours} hours ago. Next automatic one in about ${remaining}h.`,
    };
  }

  if (!gate.healthOk) {
    return { request: false, reason: 'The server is not reachable right now.' };
  }

  return {
    request: true,
    reason:
      gate.todayStatus === 'failed'
        ? 'Today’s digest failed and produced nothing. Trying once more.'
        : 'No digest for today yet.',
  };
}
