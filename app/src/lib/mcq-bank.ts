/**
 * The question bank, measured in DAYS. Pure — no RN, no expo-sqlite.
 *
 * ## Why days and not rows
 *
 * "60 questions in the bank" means nothing to someone standing on a platform at
 * 7:44am. "Six days of runway" is actionable while she is still at home on
 * wifi, which is the only moment a top-up can actually happen. Everything in
 * this file exists to turn a row count into a number of days.
 *
 * ## Why the buffer is seven days and not thirty
 *
 * The bank is a BUFFER, not a library. A question generated three weeks ago was
 * aimed at whatever her weak areas looked like three weeks ago; if she has
 * since finished Modern History and started Economy, that question is now
 * pointed at the wrong topic and is worse than nothing, because it displaces a
 * question that would have been right. Seven days is long enough to survive a
 * week with no wifi and short enough that the bank keeps re-aiming itself.
 *
 * ## Why p75 and not the mean
 *
 * Demand is questions per day over a fortnight, and a fortnight contains days
 * she did not drill at all — a double shift, a wedding, flu. The mean over 14
 * days is dragged toward zero by those days and would size the bank for the
 * average day rather than for the day she actually opens the app. p75 sizes it
 * for a normal drilling day, which is the day the bank has to survive.
 *
 * Safe value imports here: `@/lib/papers`, `@/lib/time`, `@/lib/mcq-types`.
 * `@/db/*` is type-only. See the rule-of-thumb note at the top of `papers.ts`.
 */

import { PRELIMS_PAPERS, type BankRunway, type QuotaLine, type RefillPlan, type SectionDemand } from '@/lib/mcq-types';

/* ------------------------------------------------------------------- rules */

/**
 * Every tunable in one object so a reviewer can see the whole policy at once,
 * and so tests assert against the same numbers the app runs on.
 */
export const BANK_RULES = {
  /** What a healthy bank holds. */
  targetRunwayDays: 7,
  /** Below this, a refill is worth a network call. */
  lowWaterRunwayDays: 3,
  /**
   * An absolute floor in rows, independent of days.
   *
   * Runway is a ratio and a ratio lies at the extremes: a fortnight of illness
   * pushes demand to its 10/day floor, and 35 unseen questions then read as 3.5
   * days of runway — "fine" — right up until she drills two sets on the first
   * day back and the bank is empty on a train.
   */
  hardFloor: 40,
  /** Above this the bank is a library, not a buffer, and stops being re-aimed. */
  bankCeiling: 600,
  /** The server's hard maximum per request. Not a preference. */
  batchSize: 30,
  refillCooldownHours: 6,
  /** Share of every batch reserved for sections with no attempt data at all. */
  explorationShare: 0.2,
  /** Ceiling on any one section's share of a batch. */
  maxSectionShare: 0.25,
  /** Demand window. Matches `syllabus-coverage`'s window so the two agree. */
  demandWindowDays: 14,
  /**
   * The demand floor. Below this, runway arithmetic divides by a number small
   * enough to report months of buffer from a nearly empty bank.
   */
  minDemandPerDay: 10,
  /** `stale` saturates here: a section untouched for a month is fully stale. */
  stalenessCeilingDays: 30,
  /** Percentile of the daily series used as demand. */
  demandPercentile: 0.75,
} as const;

/** Weights on the three signals that decide where a batch is aimed. */
const PRIORITY_WEIGHTS = { errorRate: 0.5, gap: 0.3, stale: 0.2 } as const;

/**
 * How hard existing stock suppresses a section.
 *
 * A discount rather than a hard exclusion: a section that is both weak and
 * well-stocked should slide down the list, not fall off it.
 */
const STOCK_DISCOUNT = 0.4;

/**
 * Cap on how many stems travel in `excludeStemHashes`.
 *
 * The bank ceiling is 600 and every hash is 16 bytes of JSON; the whole set
 * fits comfortably, but an unbounded list is one schema change away from being
 * a request body that a proxy rejects.
 */
const MAX_EXCLUDE_HASHES = 600;

/* ---------------------------------------------------------- date arithmetic */

const MS_PER_DAY = 86_400_000;

/** A calendar day, `YYYY-MM-DD` — the first ten characters of an ISO string. */
function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

function dayMs(day: string): number {
  return Date.parse(`${dayOf(day)}T00:00:00.000Z`);
}

/** Whole days from `from` to `to`. Negative when `to` precedes `from`. */
function daysBetween(from: string, to: string): number {
  const a = dayMs(from);
  const b = dayMs(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / MS_PER_DAY);
}

function addDays(day: string, count: number): string {
  const base = dayMs(day);
  if (!Number.isFinite(base)) return dayOf(day);
  return new Date(base + count * MS_PER_DAY).toISOString().slice(0, 10);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/* ------------------------------------------------------------- fingerprints */

/**
 * Punctuation, symbols and separators — everything that is not a letter or a
 * digit in a script this app will realistically see.
 *
 * Written as an explicit range set rather than `\p{L}` because Unicode property
 * escapes are an engine feature and this string is hashed identically on
 * Hermes, on Node under the test runner, and on whatever JSC an old Android
 * build falls back to. A fingerprint that differs between engines would make
 * every duplicate check silently pass.
 */
const NON_WORD = /[^a-z0-9\u00C0-\u024F\u0370-\u1FFF\u2C00-\uD7FF]+/g;

/** Apostrophes vanish rather than splitting a word: `don't` -> `dont`. */
const APOSTROPHES = /['\u2018\u2019\u201B\u2032\u00B4\u0060]/g;

/** Combining marks left behind by NFKD, so `é` and `e` fingerprint alike. */
const COMBINING = /[\u0300-\u036F]/g;

/**
 * The comparable form of a stem.
 *
 * Deliberately conservative. It collapses the things that are not differences —
 * case, spacing, punctuation, accents — and nothing else. It does NOT sort
 * words, drop stopwords or stem morphology, because those turn two genuine
 * paraphrases into the same string, and a false duplicate is invisible: the
 * question is dropped on insert and nothing ever reports it missing.
 */
export function normaliseStem(stem: string): string {
  const raw = typeof stem === 'string' ? stem : '';

  // `normalize` is ES2015 but has been absent from stripped-down engines.
  const decomposed =
    typeof raw.normalize === 'function' ? raw.normalize('NFKD').replace(COMBINING, '') : raw;

  const collapsed = decomposed
    .toLowerCase()
    .replace(APOSTROPHES, '')
    .replace(NON_WORD, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // A stem written wholly in a script `NON_WORD` does not cover would collapse
  // to the empty string, and every such stem would then be "a duplicate" of
  // every other. Falling back to the whitespace-collapsed original keeps them
  // distinguishable at the cost of being case-sensitive, which is the safe
  // direction to fail in.
  if (collapsed !== '') return collapsed;
  return raw.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** FNV-1a, 32-bit. The multiply is the standard shift-and-add decomposition. */
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash =
      (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/** djb2-xor, 32-bit. Structurally unlike FNV-1a, which is the point. */
function djb232(text: string): number {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = (((hash << 5) + hash) ^ text.charCodeAt(i)) >>> 0;
  }
  return hash >>> 0;
}

function hex8(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0');
}

/**
 * A stable 64-bit fingerprint of a stem, as 16 hex characters.
 *
 * Two independent 32-bit hashes concatenated rather than one 64-bit hash: no
 * BigInt (Hermes has it, older JSC does not), no crypto dependency, and two
 * algorithms with different mixing functions do not share collisions. At the
 * 600-row bank ceiling the chance of a false duplicate is around 1 in 10^13,
 * which is small enough that a collision is not a failure mode worth designing
 * around — unlike the normalisation above, which is.
 *
 * Stored rather than recomputed: `mcq_questions.stem_fingerprint` is indexed,
 * and the exclude list sent to the server is exactly these strings.
 */
export function stemFingerprint(stem: string): string {
  const normalised = normaliseStem(stem);
  // The second hash sees a different string, so a pathological input cannot
  // land on the same weak spot in both.
  return hex8(fnv1a32(normalised)) + hex8(djb232(`${normalised.length} ${normalised}`));
}

/* ------------------------------------------------------------------ demand */

export interface DailyDrillCount {
  /** `YYYY-MM-DD`, local calendar day. */
  day: string;
  count: number;
}

/**
 * Nearest-rank percentile over an ascending array.
 *
 * Nearest-rank rather than linear interpolation because the series is small
 * (14 points) and integral (question counts): interpolating between day 10 and
 * day 11 invents a demand of 23.5 questions, which is not a thing that ever
 * happened and is harder to explain on a support call.
 */
function percentile(ascending: readonly number[], fraction: number): number {
  if (ascending.length === 0) return 0;
  const rank = Math.ceil(fraction * ascending.length);
  const index = Math.min(ascending.length - 1, Math.max(0, rank - 1));
  return ascending[index] ?? 0;
}

/**
 * Questions per day, as the bank should size for it.
 *
 * The window is a fixed number of CALENDAR days ending at `asOfDay`, so a day
 * with no drill contributes a real zero rather than being absent from the
 * series. That matters: the whole reason for p75 over the mean is that those
 * zeros exist, and a series that silently omitted them would make the two
 * statistics agree.
 */
export function dailyDemand(
  counts: readonly DailyDrillCount[],
  opts: { asOfDay: string; windowDays?: number; floor?: number },
): number {
  const windowDays =
    Number.isFinite(opts.windowDays) && (opts.windowDays ?? 0) > 0
      ? Math.floor(opts.windowDays as number)
      : BANK_RULES.demandWindowDays;
  const floor = Number.isFinite(opts.floor) ? (opts.floor as number) : BANK_RULES.minDemandPerDay;

  const asOf = dayOf(opts.asOfDay);
  const byDay = new Map<string, number>();
  for (const entry of counts) {
    const day = dayOf(entry.day);
    const value = Number.isFinite(entry.count) ? Math.max(0, entry.count) : 0;
    byDay.set(day, (byDay.get(day) ?? 0) + value);
  }

  // Inclusive: 14 days covers today and the thirteen before it.
  const series: number[] = [];
  for (let back = windowDays - 1; back >= 0; back -= 1) {
    series.push(byDay.get(addDays(asOf, -back)) ?? 0);
  }

  series.sort((a, b) => a - b);
  return Math.max(floor, percentile(series, BANK_RULES.demandPercentile));
}

/* ----------------------------------------------------------------- runway */

/** Everything the runway needs that only the database knows. */
export interface BankInventory {
  /** Unseen, un-quarantined, and aimed at a section she has actually studied. */
  unseenEligible: number;
  totalBanked: number;
  quarantined: number;
  redrillDueToday: number;
  lastSuccessfulRefillAt: string | null;
}

/**
 * Rows into days.
 *
 * `redrillDueToday` is reported but deliberately NOT counted as runway. A
 * question she has already seen is revision, not new material; counting it as
 * supply would let the bank report a comfortable week while holding nothing she
 * has not already answered.
 */
export function computeRunway(inventory: BankInventory, demandPerDay: number): BankRunway {
  const demand = Number.isFinite(demandPerDay) && demandPerDay > 0
    ? demandPerDay
    : BANK_RULES.minDemandPerDay;
  const unseenEligible = Math.max(0, Math.floor(inventory.unseenEligible));
  const runwayDays = unseenEligible / demand;

  return {
    unseenEligible,
    totalBanked: Math.max(0, Math.floor(inventory.totalBanked)),
    quarantined: Math.max(0, Math.floor(inventory.quarantined)),
    redrillDueToday: Math.max(0, Math.floor(inventory.redrillDueToday)),
    demandPerDay: demand,
    runwayDays,
    belowLowWater:
      runwayDays < BANK_RULES.lowWaterRunwayDays || unseenEligible < BANK_RULES.hardFloor,
    lastSuccessfulRefillAt: inventory.lastSuccessfulRefillAt,
  };
}

/* ------------------------------------------------------------- the trigger */

/**
 * Deliberately NOT a background fetch.
 *
 * Android background execution is throttled by every OEM battery optimiser in
 * the market and is silently disabled on several of them. An offline guarantee
 * that depends on a background task is an offline guarantee that fails on the
 * exact devices this app has to work on, so every trigger below is attached to
 * something the user actually did.
 */
export type RefillTrigger = 'post_session' | 'auto' | 'manual';

export interface RefillGate {
  trigger: RefillTrigger;
  runway: BankRunway;
  /** ISO instant. */
  now: string;
  /**
   * The last refill ATTEMPT, successful or not. The cooldown is on attempts:
   * three failed calls in ten minutes cost the same money and battery as three
   * successful ones, and a server that is down stays down for more than six
   * minutes.
   */
  lastRefillAttemptAt: string | null;
  healthOk: boolean;
  spendCapAllows: boolean;
  /**
   * True when the clock is inside one of her `micro` commute blocks.
   *
   * The whole point of the bank is that the commute needs no network. Spending
   * the first ninety seconds of a twelve-minute window on a generation call is
   * the failure this feature exists to prevent.
   */
  insideMicroBlock: boolean;
  refillInFlight: boolean;
}

export interface RefillDecision {
  refill: boolean;
  /** Shown on the launcher. "Nothing happened" must always be explicable. */
  reason: string;
}

function hoursSince(from: string | null, now: string): number | null {
  if (from === null) return null;
  const a = Date.parse(from);
  const b = Date.parse(now);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (b - a) / 3_600_000;
}

function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * The hysteresis lives in two places at once, and it needs both.
 *
 * `belowLowWater` stops the trigger firing once the bank is healthy again;
 * the cooldown stops it firing repeatedly while the bank is still low and a
 * refill is already on its way to fixing that. Without the second, every
 * foreground event between the request and the questions arriving would start
 * another one.
 */
export function shouldRefill(gate: RefillGate): RefillDecision {
  const { runway, trigger } = gate;

  if (gate.refillInFlight) {
    return { refill: false, reason: 'A top-up is already running.' };
  }

  if (runway.totalBanked >= BANK_RULES.bankCeiling) {
    return {
      refill: false,
      reason:
        `The bank already holds ${runway.totalBanked} questions. Past ${BANK_RULES.bankCeiling} it stops ` +
        'being a buffer and starts being a library aimed at last month’s weak areas.',
    };
  }

  if (!gate.spendCapAllows) {
    return {
      refill: false,
      reason: 'The spend cap is reached, so no questions can be generated until it resets.',
    };
  }

  // Manual is the honest answer to "I have wifi and I am about to travel". It
  // skips the runway threshold, the cooldown and the commute check — she can
  // see the runway on the same screen as the button, so the app second-guessing
  // her here would just be the app being wrong out loud.
  if (trigger === 'manual') {
    return { refill: true, reason: 'You asked for a top-up.' };
  }

  const sinceLast = hoursSince(gate.lastRefillAttemptAt, gate.now);
  if (sinceLast !== null && sinceLast < BANK_RULES.refillCooldownHours) {
    const remaining = Math.max(1, Math.ceil(BANK_RULES.refillCooldownHours - sinceLast));
    return {
      refill: false,
      reason: `The last top-up was under ${BANK_RULES.refillCooldownHours} hours ago. Next automatic one in about ${remaining}h.`,
    };
  }

  if (!runway.belowLowWater) {
    return {
      refill: false,
      reason:
        `${roundTo(runway.runwayDays, 1)} days of questions in hand, above the ` +
        `${BANK_RULES.lowWaterRunwayDays}-day mark.`,
    };
  }

  if (trigger === 'auto') {
    if (!gate.healthOk) {
      return { refill: false, reason: 'The server is not reachable right now.' };
    }
    if (gate.insideMicroBlock) {
      return {
        refill: false,
        reason: 'You are inside a commute drill window — the bank tops up outside it, never during.',
      };
    }
  }

  return {
    refill: true,
    reason:
      `${roundTo(runway.runwayDays, 1)} days of questions left, under the ` +
      `${BANK_RULES.lowWaterRunwayDays}-day mark.`,
  };
}

/* -------------------------------------------------------------- the plan */

interface Candidate {
  section: SectionDemand;
  errorRate: number;
  gap: number;
  stale: number;
  priority: number;
  raw: number;
  /** No attempts at all: the section the greedy rule can never learn about. */
  exploring: boolean;
  daysSinceDrilled: number | null;
}

/**
 * Laplace-smoothed error rate: `(wrong + 1) / (attempted + 2)`.
 *
 * Unsmoothed, one wrong answer out of one attempt is a 100% error rate — the
 * highest score the term can produce — so a single tap outranks every real,
 * measured weakness on the board and takes a quarter of the next batch.
 * Smoothed, that same section reads 0.67, which is still weak evidence of
 * weakness but is now small enough that the other two signals can outvote it:
 * a section with a hundred attempts and a far worse coverage gap wins, and
 * unsmoothed it would not. That is the behaviour `scoreSection` is tested on.
 */
export function laplaceErrorRate(wrong: number, attempted: number): number {
  const safeAttempted = Math.max(0, Number.isFinite(attempted) ? attempted : 0);
  const safeWrong = Math.min(safeAttempted, Math.max(0, Number.isFinite(wrong) ? wrong : 0));
  return (safeWrong + 1) / (safeAttempted + 2);
}

/**
 * Both gates are hard, and for different reasons.
 *
 * A section she has never opened produces a 20% score, and a 20% score in week
 * one is not a diagnostic — it is the reason she stops opening the app. And
 * there is no Prelims paper for Anthropology, Essay or Ethics, so a question
 * generated for one of them is money spent on something she can never be
 * examined on.
 */
function isEligible(section: SectionDemand): boolean {
  return (
    section.eligible &&
    (PRELIMS_PAPERS as readonly string[]).includes(section.paper) &&
    section.syllabusSlugs.length > 0
  );
}

export interface SectionScore {
  /** Laplace-smoothed. Never 0 and never 1, whatever the counts say. */
  errorRate: number;
  gap: number;
  stale: number;
  /** `0.5*errorRate + 0.3*gap + 0.2*stale`. */
  priority: number;
  /** `priority` after the existing-stock discount, floored at zero. */
  raw: number;
  /** `null` when the section has never been drilled at all. */
  daysSinceDrilled: number | null;
}

/**
 * How badly one section needs questions, on the three signals that matter.
 *
 * Exported because the allocation step downstream is lossy by design — the 25%
 * cap flattens the top of the board, so two sections with genuinely different
 * priorities can receive the same quota. Testing the aim only through
 * `planBankRefill` would therefore pass with the scoring badly wrong. This is
 * the function that decides what the batch is FOR, and it is asserted on
 * directly.
 */
export function scoreSection(
  section: SectionDemand,
  opts: { asOfDay: string; stockFraction?: number },
): SectionScore {
  const errorRate = laplaceErrorRate(section.wrong, section.attempted);
  const gap = clamp01(1 - (Number.isFinite(section.percentFirstPass) ? section.percentFirstPass : 0) / 100);

  const daysSinceDrilled =
    section.lastDrilledDay === null
      ? null
      : Math.max(0, daysBetween(section.lastDrilledDay, opts.asOfDay));
  // Never drilled is maximally stale. Not "unknown": it is the strongest
  // possible statement that nothing recent covers this section.
  const stale =
    daysSinceDrilled === null ? 1 : clamp01(daysSinceDrilled / BANK_RULES.stalenessCeilingDays);

  const priority =
    PRIORITY_WEIGHTS.errorRate * errorRate +
    PRIORITY_WEIGHTS.gap * gap +
    PRIORITY_WEIGHTS.stale * stale;

  return {
    errorRate,
    gap,
    stale,
    priority,
    raw: Math.max(0, priority - STOCK_DISCOUNT * clamp01(opts.stockFraction ?? 0)),
    daysSinceDrilled,
  };
}

function toCandidate(section: SectionDemand, asOfDay: string, stockFraction: number): Candidate {
  const score = scoreSection(section, { asOfDay, stockFraction });
  return {
    section,
    ...score,
    exploring: section.attempted === 0,
  };
}

interface Apportionment {
  key: string;
  weight: number;
}

/**
 * Largest-remainder apportionment with per-key caps.
 *
 * The reconciliation is the whole reason this is a function rather than three
 * lines of `Math.round`. Rounding each share independently produces a plan that
 * asks for 29 or 31 questions, and the arithmetic of a plan that does not sum
 * to its own batch size cannot be tested: every assertion becomes "about
 * thirty". Here the remainders are handed out one at a time, so the total is
 * exact by construction.
 */
function apportion(
  entries: readonly Apportionment[],
  total: number,
  capOf: (key: string) => number,
): Map<string, number> {
  const out = new Map<string, number>();
  if (entries.length === 0 || total <= 0) return out;

  const caps = new Map(entries.map((entry) => [entry.key, Math.max(0, capOf(entry.key))] as const));
  const capacity = [...caps.values()].reduce((sum, cap) => sum + cap, 0);
  const target = Math.min(Math.floor(total), capacity);
  if (target <= 0) {
    for (const entry of entries) out.set(entry.key, 0);
    return out;
  }

  const totalWeight = entries.reduce((sum, entry) => sum + Math.max(0, entry.weight), 0);

  // Every weight zero is not an error: it means every eligible section is
  // already well enough stocked that the discount cancelled its priority. An
  // even split is the honest answer, and it still respects the caps.
  const ideal = entries.map((entry) =>
    totalWeight > 0 ? (target * Math.max(0, entry.weight)) / totalWeight : target / entries.length,
  );

  let assigned = 0;
  const remainders: { key: string; remainder: number; order: number }[] = [];
  entries.forEach((entry, index) => {
    const share = ideal[index] ?? 0;
    const base = Math.min(caps.get(entry.key) ?? 0, Math.floor(share));
    out.set(entry.key, base);
    assigned += base;
    remainders.push({ key: entry.key, remainder: share - Math.floor(share), order: index });
  });

  // Largest remainder first; ties fall back to the caller's order, which is
  // priority order. Deterministic, so the same board always plans the same way.
  remainders.sort((a, b) => b.remainder - a.remainder || a.order - b.order);

  let cursor = 0;
  // `assigned < target <= capacity` guarantees at least one key is under its
  // cap on every pass, so this terminates. The bound is belt-and-braces: an
  // infinite loop here would hang the app on a fire-and-forget code path.
  const bound = (target + 1) * remainders.length + remainders.length;
  for (let spin = 0; assigned < target && spin < bound; spin += 1) {
    const pick = remainders[cursor % remainders.length];
    cursor += 1;
    if (!pick) break;
    const current = out.get(pick.key) ?? 0;
    if (current >= (caps.get(pick.key) ?? 0)) continue;
    out.set(pick.key, current + 1);
    assigned += 1;
  }

  return out;
}

function pluralDays(count: number): string {
  return count === 1 ? '1 day' : `${count} days`;
}

function quotaReason(candidate: Candidate, count: number): string {
  const { section } = candidate;
  const coverage = `${Math.round(clamp01(section.percentFirstPass / 100) * 100)}% coverage`;

  const parts: string[] = [coverage];

  if (section.attempted === 0) {
    parts.push('never drilled — exploring a blind spot');
  } else {
    parts.push(`${section.wrong} of your last ${section.attempted} wrong`);
    if (candidate.daysSinceDrilled !== null && candidate.daysSinceDrilled >= 14) {
      parts.push(`last drilled ${pluralDays(candidate.daysSinceDrilled)} ago`);
    }
  }

  if (section.unseenStock > 0) {
    parts.push(`${section.unseenStock} unseen in hand`);
  }

  return `${count} from ${section.label} — ${parts.join(', ')}`;
}

export interface PlanBankRefillInput {
  sections: readonly SectionDemand[];
  /** Local calendar day, `YYYY-MM-DD`. Staleness is measured against it. */
  asOfDay: string;
  /** Defaults to `BANK_RULES.batchSize`, which is the server's hard maximum. */
  batchSize?: number;
  excludeStemHashes?: readonly string[];
}

/**
 * Where the next batch is aimed.
 *
 * ```
 * errorRate(s) = (wrong + 1) / (attempted + 2)
 * gap(s)       = 1 - percentFirstPass(s)/100
 * stale(s)     = clamp(daysSinceLastDrilled/30, 0, 1)
 * priority     = 0.5*errorRate + 0.3*gap + 0.2*stale
 * raw          = max(0, priority - 0.4*stockFraction)
 * quota        = batchSize * 0.8 * raw/sum(raw), capped at 25% of the batch
 * ```
 *
 * plus a 20% exploration share spread evenly over eligible sections with zero
 * attempts. That share is the most important line in the whole file: a greedy
 * rule scores a section by its error rate, a section with no attempts has no
 * error rate, and so a never-drilled section is never sampled, never acquires
 * an error rate, and can never surface as weak. The 20% is what stops a blind
 * spot from being permanent.
 *
 * The returned `batchSize` is the plan's own total and the quotas sum to it
 * exactly. It can be smaller than the requested batch when the 25% cap and the
 * number of eligible sections cannot between them absorb a full batch — three
 * eligible sections at a cap of seven is twenty-one questions, and asking for
 * thirty would either breach the cap or produce a plan whose lines do not add
 * up. Shrinking is the honest option.
 */
export function planBankRefill(input: PlanBankRefillInput): RefillPlan {
  const requested = Math.max(
    0,
    Math.floor(
      Number.isFinite(input.batchSize) ? (input.batchSize as number) : BANK_RULES.batchSize,
    ),
  );
  const asOfDay = dayOf(input.asOfDay);
  const excludeStemHashes = [...(input.excludeStemHashes ?? [])].slice(0, MAX_EXCLUDE_HASHES);

  const eligible = input.sections.filter(isEligible);

  if (eligible.length === 0 || requested === 0) {
    return {
      batchSize: 0,
      quotas: [],
      excludeStemHashes,
      rationale:
        eligible.length === 0
          ? 'Nothing to generate: no Prelims section has a topic you have started yet. Mark a topic ' +
            'in progress in the syllabus and the bank starts filling against it.'
          : 'Nothing to generate: the requested batch was empty.',
    };
  }

  // A section's share of the unseen stock, so the discount is relative to the
  // bank rather than to an absolute row count that means different things at
  // 50 and at 500 questions.
  const totalUnseen = eligible.reduce(
    (sum, section) => sum + Math.max(0, section.unseenStock),
    0,
  );

  const candidates = eligible
    .map((section) =>
      toCandidate(
        section,
        asOfDay,
        totalUnseen === 0 ? 0 : Math.max(0, section.unseenStock) / totalUnseen,
      ),
    )
    // Priority order, with the section key as the tie-break so the same board
    // always produces byte-identical plans.
    .sort((a, b) => b.priority - a.priority || a.section.sectionKey.localeCompare(b.section.sectionKey));

  const perSectionCap = Math.max(1, Math.floor(requested * BANK_RULES.maxSectionShare));
  const budget = Math.min(requested, candidates.length * perSectionCap);

  const remainingCap = new Map(candidates.map((c) => [c.section.sectionKey, perSectionCap] as const));

  /* --------------------------------------------------------- exploration */

  const explorers = candidates.filter((c) => c.exploring);
  let exploration = new Map<string, number>();

  if (explorers.length > 0 && budget > 0) {
    // At least one question, always. `round(budget * 0.2)` is zero for a batch
    // of two, and an exploration share that rounds away is not an exploration
    // share — the blind spot stays blind on exactly the small batches where a
    // single question would have been most of the evidence.
    const explorationBudget = Math.max(
      1,
      Math.min(budget, Math.round(budget * BANK_RULES.explorationShare)),
    );
    exploration = apportion(
      // Evenly: these sections have no data, so there is nothing to rank them
      // by, and inventing a ranking would be pretending otherwise.
      explorers.map((c) => ({ key: c.section.sectionKey, weight: 1 })),
      explorationBudget,
      (key) => remainingCap.get(key) ?? 0,
    );
    for (const [key, count] of exploration) {
      remainingCap.set(key, Math.max(0, (remainingCap.get(key) ?? 0) - count));
    }
  }

  const explorationTotal = [...exploration.values()].reduce((sum, n) => sum + n, 0);

  /* -------------------------------------------------------------- greedy */

  const greedy = apportion(
    candidates.map((c) => ({ key: c.section.sectionKey, weight: c.raw })),
    budget - explorationTotal,
    (key) => remainingCap.get(key) ?? 0,
  );

  /* ------------------------------------------------------------- output */

  const quotas: QuotaLine[] = [];
  let total = 0;

  for (const candidate of candidates) {
    const key = candidate.section.sectionKey;
    const count = (exploration.get(key) ?? 0) + (greedy.get(key) ?? 0);
    if (count <= 0) continue;

    total += count;
    quotas.push({
      sectionKey: key,
      // One line per section: the count she reads is a section total ("12 from
      // Modern History"), and a section's leaves are interchangeable targets
      // for generation. The first slug anchors the section for the server; the
      // full list travels on the request beside it.
      syllabusSlug: candidate.section.syllabusSlugs[0] ?? key,
      count,
      reason: quotaReason(candidate, count),
    });
  }

  quotas.sort((a, b) => b.count - a.count || a.sectionKey.localeCompare(b.sectionKey));

  const exploringSections = quotas.filter(
    (line) => (exploration.get(line.sectionKey) ?? 0) > 0,
  ).length;

  const shortfallNote =
    total < requested
      ? ` Asked for ${requested}; ${candidates.length} eligible ${
          candidates.length === 1 ? 'section' : 'sections'
        } at a cap of ${perSectionCap} each leaves room for ${total}.`
      : '';

  return {
    batchSize: total,
    quotas,
    excludeStemHashes,
    rationale:
      `${total} questions across ${quotas.length} ${quotas.length === 1 ? 'section' : 'sections'}, ` +
      `aimed by error rate, coverage gap and staleness. ` +
      `${explorationTotal} of them go to ${exploringSections} ${
        exploringSections === 1 ? 'section' : 'sections'
      } you have never drilled, so a blind spot cannot stay invisible. ` +
      `No section may take more than ${perSectionCap}.${shortfallNote}`,
  };
}
