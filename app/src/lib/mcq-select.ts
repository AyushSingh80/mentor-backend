/**
 * The selection ladder — how a drill session is dealt.
 *
 * Pure. No RN, no expo-sqlite. Safe value imports only (`@/lib/mcq-types`,
 * `@/lib/sm2`); `@/db/*` would be type-only, and nothing here needs it.
 *
 * ## The promise
 *
 * **Never render an empty drill while a usable question exists.** An empty
 * screen at 07:45 on a train is indistinguishable from a broken app, and it is
 * the failure that stops the habit. So the ladder walks four tiers in a fixed
 * order and takes whatever it can get:
 *
 *   1. `unseen_targeted` — unseen, in the weak sections the refill aimed at.
 *      The normal path, and where almost every question comes from.
 *   2. `unseen_any`      — unseen, any *eligible* section. Targeting is
 *      relaxed before freshness is: a new question from the wrong section
 *      still teaches something new, whereas a repeat dressed up as new does
 *      not. Eligibility is never relaxed — see below.
 *   3. `redrill_due`     — wrong answers whose SM-2 interval is up today.
 *      This is not a consolation tier. A question she got wrong, returning at
 *      the moment she is about to forget the correction, is the
 *      highest-value drill in the whole app; it sits third only because
 *      unseen stock is perishable and this is not.
 *   4. `stale_correct`   — answered correctly at least
 *      `STALE_CORRECT_DAYS` ago, oldest first. Genuine spaced retrieval, and
 *      the reason a bank that has been fully seen is still worth opening.
 *
 * ## Eligibility is never relaxed
 *
 * A section she has never studied is excluded from tiers 1 and 2 at every
 * level of desperation. Being drilled on material the app knows she has not
 * reached teaches nothing and reads as the app not knowing where she is — the
 * fastest way to lose the trust that makes her open it on a commute at all.
 * Running dry is the better failure: `selectForSession` returns `[]` and the
 * screen can say why.
 *
 * Tiers 3 and 4 do not consult eligibility, deliberately. She has already
 * attempted those questions, so the "material you have not reached" objection
 * cannot apply; withholding a due correction because a section's coverage
 * number moved would be strictly worse than showing it.
 *
 * ## Repeats are labelled and scored apart
 *
 * Tiers 3 and 4 always come back with `priorAttempts > 0`, and the score agent
 * excludes them from headline accuracy. A remembered answer is not a known
 * one, and a session that quietly mixes recall of the app's own recent
 * feedback into an accuracy figure is measuring the wrong thing. The flag is
 * forced structurally here rather than trusted from the caller's join, so a
 * repeat can never arrive on screen looking new.
 *
 * ## Determinism
 *
 * No `Math.random` anywhere. Ordering inside the unseen tiers comes from a
 * hash of `(seed, questionId)`, so a fixed seed gives a fixed deal that a test
 * can assert exactly, while different seeds give different — but equally
 * valid — orders. Sorting unseen questions by id instead would systematically
 * drill the oldest generation batch first and leave the newest never dealt.
 *
 * ## Never throws
 *
 * This is the last thing between a stored row and a blank screen. Every date
 * comparison is prefix-based and total, every malformed candidate is dropped
 * rather than diagnosed, and a nonsensical `count` yields `[]`. One
 * hand-edited row must not be able to take the drill down.
 */

import {
  OPTION_COUNT,
  QUARANTINE_RULE,
  type Difficulty,
  type DrillQuestion,
  type QuestionSource,
  type SelectionTier,
} from '@/lib/mcq-types';
import { isDue } from '@/lib/sm2';

/**
 * How long a correct answer stays "known" before it is worth re-testing.
 *
 * Three weeks, which is past SM-2's second interval of six days and well
 * inside the range where retrieval still strengthens rather than merely
 * confirms. Deliberately a plain constant and not an SM-2 interval: tier 4 is
 * for questions that were never enrolled at all, so there is no schedule to
 * consult, and inventing one would mean writing a second scheduler.
 */
export const STALE_CORRECT_DAYS = 21;

/** The ladder, in the only order it is ever walked. */
export const TIER_ORDER: readonly SelectionTier[] = [
  'unseen_targeted',
  'unseen_any',
  'redrill_due',
  'stale_correct',
];

/** The two tiers that deal a question she has already attempted. */
export function isRepeatTier(tier: SelectionTier): boolean {
  return tier === 'redrill_due' || tier === 'stale_correct';
}

/** Plain-language tier names, for `mcqSessions.selectionReason`. */
const TIER_LABEL: Record<SelectionTier, string> = {
  unseen_targeted: 'new in your weak sections',
  unseen_any: 'new elsewhere',
  redrill_due: 'due for re-drill',
  stale_correct: 'not seen in three weeks',
};

/**
 * One row of the bank, as `db/mcq-questions.ts` deals it.
 *
 * Everything the ladder needs is precomputed by the repository, because the
 * three facts that decide a tier — how many attempts, when it was last right,
 * when its re-drill falls due — live in three different tables and are far
 * cheaper to aggregate in SQL once than to re-derive per candidate.
 */
export interface SelectionCandidate {
  questionId: number;
  stem: string;
  /** Parsed from `options_json`. Anything not exactly `OPTION_COUNT` is dropped. */
  options: string[];
  correctIndex: number;
  eliminationLogic: string | null;
  difficulty: Difficulty;
  source: QuestionSource;
  pyqYear: number | null;
  pyqPaper: string | null;
  paper: string;
  /** `${paper}:${topic}`, matching what `coverageBySection` emits. */
  sectionKey: string;
  sectionLabel: string | null;
  syllabusTopicId: number | null;
  /** `QUARANTINE_RULE`, already evaluated. Excluded at EVERY tier. */
  quarantined: boolean;
  /** Derived from `mcq_attempts`, never stored. Zero means unseen. */
  priorAttempts: number;
  /** Most recent CORRECT attempt, or null. Drives tier 4. */
  lastCorrectAt: string | null;
  /** `mcq_review_queue.dueAt`, or null when not enrolled. Drives tier 3. */
  redrillDueAt: string | null;
}

export interface SelectionRequest {
  candidates: readonly SelectionCandidate[];
  /**
   * The sections this deal is aiming at, from the refill plan's quotas. Tier 1
   * draws only from here. An empty list simply means tier 1 yields nothing and
   * the ladder starts at tier 2 — not that everything is targeted.
   */
  targetSectionKeys: readonly string[];
  /**
   * Sections she has actually studied, from `SectionDemand.eligible`. Tiers 1
   * and 2 never leave this set, at any level of scarcity. An empty list means
   * no unseen question is dealable, which is the correct answer before the
   * first topic reaches first pass.
   */
  eligibleSectionKeys: readonly string[];
  count: number;
  /** Local calendar day, from `localDate(profile.timezone)`. */
  todayIso: string;
  /** `SessionPreset.preferPyq` — true for `timed`, false for `micro`. */
  preferPyq: boolean;
  /**
   * `SessionPreset.allowUnstudiedPyq`. Absent reads as false, so a caller that
   * has not been updated keeps today's behaviour exactly.
   */
  allowUnstudiedPyq?: boolean;
  /** Fixed seed in, fixed deal out. */
  seed: number;
}

/* ------------------------------------------------------------------ guards */

/**
 * A candidate that can be put on screen without breaking the option pad.
 *
 * The quarantine check is first and applies at every tier: a question she
 * believes teaches a falsehood must appear in NO selection tier, and spaced
 * repetition drilling a wrong key to mastery is the worst thing this app can
 * do. `QUARANTINE_RULE` is referenced so a reader lands on the definition.
 *
 * The shape checks are not defensive padding. `optionsJson` is free text from
 * a model; a three-option question renders a broken pad, an out-of-range
 * `correctIndex` makes every answer wrong forever, and a blank option is an
 * invisible tap target. Dropping is silent on purpose — this is the read path,
 * and one malformed row must cost one question, not the screen.
 */
function isDealable(candidate: SelectionCandidate): boolean {
  if (candidate.quarantined) return false;
  if (!Number.isInteger(candidate.questionId)) return false;
  if (!Array.isArray(candidate.options) || candidate.options.length !== OPTION_COUNT) return false;
  if (!candidate.options.every((option) => typeof option === 'string' && option.trim() !== '')) {
    return false;
  }
  if (!Number.isInteger(candidate.correctIndex)) return false;
  return candidate.correctIndex >= 0 && candidate.correctIndex < OPTION_COUNT;
}

/** Documented here so the predicate above and the repository cannot drift. */
export const SELECTION_QUARANTINE_RULE = QUARANTINE_RULE;

/* ------------------------------------------------------------------- dates */

const MS_PER_DAY = 86_400_000;

/**
 * Whole days between two calendar days, or `null` if either is unreadable.
 *
 * Its own parser rather than `startOfDayIso`, which throws by design: that is
 * correct on a write path and wrong here, where a single bad `attempted_at`
 * must cost one candidate rather than the whole deal.
 */
function daysSince(fromIso: string, todayIso: string): number | null {
  const from = civilDay(fromIso);
  const to = civilDay(todayIso);
  if (from === null || to === null) return null;
  return Math.round((to - from) / MS_PER_DAY);
}

function civilDay(dateIso: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateIso);
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(ms) ? ms : null;
}

/* ------------------------------------------------------------------ shuffle */

/**
 * A deterministic order over the unseen pool.
 *
 * Hashes `(seed, questionId)` rather than shuffling in place, so the result
 * does not depend on the order SQLite happened to return rows in — the deal is
 * a function of the seed and the ids alone, which is what makes an exact
 * assertion in a test meaningful rather than incidental.
 *
 * xorshift-style avalanche via `Math.imul`, kept in unsigned 32-bit space so
 * every input digit affects every output digit. Nothing here is
 * cryptographic and nothing needs to be.
 */
function shuffleKey(seed: number, questionId: number): number {
  const safeSeed = Number.isFinite(seed) ? Math.trunc(seed) : 0;
  let x = (safeSeed ^ Math.imul(questionId, 2654435761)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 2246822507) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 3266489909) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

/**
 * Past questions first, in a timed set only.
 *
 * A timed set is a measurement, and a real UPSC paper is the best available
 * proxy for the exam — its distractors were written to catch the mistakes
 * candidates actually make, which no generated question can promise. A micro
 * drill on a commute is for coverage instead, where the generated bank's
 * breadth is the point and a PYQ bias would keep re-serving the same small
 * pool of past papers.
 */
function pyqRank(candidate: SelectionCandidate, preferPyq: boolean): number {
  if (!preferPyq) return 0;
  return candidate.source === 'pyq' ? 0 : 1;
}

/* -------------------------------------------------------------- the ladder */

function toDrillQuestion(candidate: SelectionCandidate, tier: SelectionTier): DrillQuestion {
  return {
    questionId: candidate.questionId,
    stem: candidate.stem,
    // Copied, not aliased: the screen must not be able to mutate the bank row
    // a later tier may still be reading.
    options: [...candidate.options],
    correctIndex: candidate.correctIndex,
    eliminationLogic: candidate.eliminationLogic,
    difficulty: candidate.difficulty,
    source: candidate.source,
    pyqYear: candidate.pyqYear,
    pyqPaper: candidate.pyqPaper,
    paper: candidate.paper,
    sectionLabel: candidate.sectionLabel,
    syllabusTopicId: candidate.syllabusTopicId,
    // Structural, not trusted. A tier-3 or tier-4 question is a repeat by
    // definition, so it is flagged as one even if the attempt aggregate that
    // produced `priorAttempts` disagreed — the alternative is a repeat
    // rendering as new and quietly counting toward headline accuracy.
    priorAttempts: isRepeatTier(tier) ? Math.max(1, candidate.priorAttempts) : candidate.priorAttempts,
    tier,
  };
}

/**
 * Deals one session. Never throws, never repeats, never exceeds `count`.
 *
 * Returns `[]` when the bank is genuinely dry — that is a real state with a
 * real screen behind it, not an error, and throwing would turn "no questions
 * today" into a crash on a train.
 */
export function selectForSession(request: SelectionRequest): DrillQuestion[] {
  const wanted = Number.isFinite(request.count) ? Math.floor(request.count) : 0;
  if (wanted <= 0) return [];

  const targeted = new Set(request.targetSectionKeys);
  const eligible = new Set(request.eligibleSectionKeys);
  const { todayIso, preferPyq, seed } = request;
  const allowUnstudiedPyq = request.allowUnstudiedPyq === true;

  /**
   * Eligible, or a past question in a set that admits them.
   *
   * Tier 1 is deliberately NOT relaxed: targeting stays inside sections she has
   * started, because a targeted drill is remediation and remediating material
   * she has not met is not remediation.
   */
  const dealable = (c: SelectionCandidate): boolean =>
    eligible.has(c.sectionKey) || (allowUnstudiedPyq && c.source === 'pyq');

  // Deduplicated by id up front, so a candidate list containing the same
  // question twice — a join that fanned out, say — cannot put it on screen
  // twice however the tiers fall.
  const pool = new Map<number, SelectionCandidate>();
  for (const candidate of request.candidates) {
    if (!isDealable(candidate)) continue;
    if (!pool.has(candidate.questionId)) pool.set(candidate.questionId, candidate);
  }
  if (pool.size === 0) return [];

  /**
   * Unseen, defined so an inconsistent row cannot be dealt as new.
   *
   * `priorAttempts` is an aggregate over `mcq_attempts`; a re-drill enrolment
   * and a recorded correct answer are independent evidence from two other
   * tables that she HAS seen this question. Nothing enrols without an attempt,
   * so in a consistent bank the extra two clauses never fire — but when they
   * disagree, treating the question as new is the damaging direction to be
   * wrong in: it would render without the repeat flag and count toward
   * headline accuracy, which is exactly the measurement the flag protects.
   */
  const unseen = (c: SelectionCandidate) =>
    c.priorAttempts === 0 && c.redrillDueAt === null && c.lastCorrectAt === null;

  const freshOrder = (list: SelectionCandidate[]) =>
    list.sort(
      (a, b) =>
        pyqRank(a, preferPyq) - pyqRank(b, preferPyq) ||
        shuffleKey(seed, a.questionId) - shuffleKey(seed, b.questionId) ||
        a.questionId - b.questionId,
    );

  /** Most overdue first: a correction missed for a week outranks today's. */
  const dueOrder = (list: SelectionCandidate[]) =>
    list.sort(
      (a, b) =>
        (a.redrillDueAt ?? '').localeCompare(b.redrillDueAt ?? '') || a.questionId - b.questionId,
    );

  /** Oldest correct answer first: the one closest to being forgotten. */
  const staleOrder = (list: SelectionCandidate[]) =>
    list.sort(
      (a, b) =>
        (a.lastCorrectAt ?? '').localeCompare(b.lastCorrectAt ?? '') || a.questionId - b.questionId,
    );

  const all = [...pool.values()];

  const tiers: { tier: SelectionTier; pick: () => SelectionCandidate[] }[] = [
    {
      tier: 'unseen_targeted',
      pick: () =>
        freshOrder(
          all.filter((c) => unseen(c) && eligible.has(c.sectionKey) && targeted.has(c.sectionKey)),
        ),
    },
    {
      tier: 'unseen_any',
      pick: () => freshOrder(all.filter((c) => unseen(c) && dealable(c))),
    },
    {
      tier: 'redrill_due',
      pick: () =>
        dueOrder(all.filter((c) => c.redrillDueAt !== null && isDue(c.redrillDueAt, todayIso))),
    },
    {
      tier: 'stale_correct',
      pick: () =>
        staleOrder(
          all.filter((c) => {
            // An enrolled question's spacing belongs to SM-2. Pulling one
            // early because it happens to be three weeks old would silently
            // override the interval the algorithm just computed — and if it
            // IS due, tier 3 has already taken it.
            if (c.redrillDueAt !== null) return false;
            if (c.lastCorrectAt === null) return false;
            const age = daysSince(c.lastCorrectAt, todayIso);
            return age !== null && age >= STALE_CORRECT_DAYS;
          }),
        ),
    },
  ];

  const dealt: DrillQuestion[] = [];
  const used = new Set<number>();

  for (const { tier, pick } of tiers) {
    if (dealt.length >= wanted) break;
    for (const candidate of pick()) {
      if (dealt.length >= wanted) break;
      // The single guarantee that no question appears twice in one session,
      // whichever tiers it qualifies for.
      if (used.has(candidate.questionId)) continue;
      used.add(candidate.questionId);
      dealt.push(toDrillQuestion(candidate, tier));
    }
  }

  return dealt;
}

/**
 * What to store in `mcqSessions.selectionReason`, in words.
 *
 * An app that silently decides what to drill gets second-guessed, and the
 * question she will ask three weeks later — "why did it keep giving me the
 * same ones?" — is unanswerable without this. Ordered by the ladder rather
 * than by size, so the sentence reads as the ladder was walked.
 */
export function selectionReason(questions: readonly DrillQuestion[]): string {
  if (questions.length === 0) return 'nothing available';

  const parts: string[] = [];
  for (const tier of TIER_ORDER) {
    const n = questions.filter((q) => q.tier === tier).length;
    if (n > 0) parts.push(`${n} ${TIER_LABEL[tier]}`);
  }
  return parts.join(', ');
}
