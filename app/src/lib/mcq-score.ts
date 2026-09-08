/**
 * Marks, calibration, and the two counterfactuals that make them teach.
 *
 * Pure: no React Native, no Expo, no `@/db/*` at runtime. Everything here is
 * arithmetic over rows a repository already fetched, so it runs under plain
 * `node --import tsx` and `tests/mcq-score.test.ts` can pin the arithmetic that
 * the whole Prelims half of this app rests on.
 *
 * ## Rule 1 — THREE outcomes, never two
 *
 * Correct `+2`. Wrong `−2/3`. Skip **exactly `0`**. A skip is
 * `chosenIndex === null` and nothing else (see `mcq_attempts` in `db/schema.ts`,
 * where a CHECK constraint makes the identity enforceable). Collapsing a skip
 * into a wrong answer is the single most expensive bug available in this file:
 * it invents a penalty she never incurred, at 0.667 marks a time, inside a
 * figure no other screen would contradict. `outcomeOf` is the only place the
 * three-way branch is written, and every count downstream goes through it.
 *
 * ## Rule 2 — the break-even is 25%, and it is DERIVED
 *
 * From `MARKS` in `mcq-types.ts`:
 *
 *     EV(p) = perCorrect·p + perWrong·(1 − p) = 2p − (2/3)(1 − p) = (8/3)p − 2/3
 *
 * which is zero at `p = −perWrong / (perCorrect − perWrong) = (2/3)/(8/3) = 1/4`.
 * So guessing pays **above 25%**, a blind four-way guess is exactly EV-neutral,
 * and eliminating even one option (p = 1/3) is worth +2/9 a question. Both
 * numbers are computed from the scheme rather than typed in, so a future change
 * to the marking scheme moves the threshold instead of silently invalidating it.
 * `tests/mcq-score.test.ts` pins the identity that proves it: 100 questions,
 * 25 correct, 75 wrong, net exactly zero.
 *
 * ## Rule 3 — every attempt counts for learning; not every session counts for marks
 *
 * An abandoned session's attempts are real answers to real questions and feed
 * lifetime accuracy and calibration — that log is the most expensive data this
 * app collects. But the session is `scoreable: false` and is kept out of the
 * net-marks trend: a 3-of-12 session is an interrupted commute, not a 25%
 * score, and letting it in makes the trend a measure of her train.
 */

import { MARKS } from '@/lib/mcq-types';
import type { AttemptRecord, SessionFacts, SessionMode, SessionStatus } from '@/lib/mcq-types';

/* ------------------------------------------------------------------ scheme */

export interface MarkingScheme {
  perCorrect: number;
  perWrong: number;
  perSkip: number;
}

/**
 * How close a stored `markPerWrong` may be to −2/3 and still be treated as it.
 *
 * `mcq_sessions.mark_per_wrong` defaults to the four-decimal literal `-0.6667`,
 * which is a rounded TRANSCRIPTION of −2/3, not a different marking scheme.
 * Scoring with it makes the break-even identity — 25 correct, 75 wrong — come
 * out at −0.0025 instead of 0, and a break-even that is not exactly zero cannot
 * be checked by eye or by test. Anything inside this tolerance snaps onto the
 * exact rational; anything outside it is a genuinely different scheme and is
 * honoured verbatim, which is the entire reason the scheme is frozen per
 * session in the first place.
 */
const SCHEME_EPSILON = 5e-4;

function snap(stored: number, canonical: number): number {
  return Math.abs(stored - canonical) < SCHEME_EPSILON ? canonical : stored;
}

/**
 * The scheme a session was dealt under, defaulting to the current one.
 *
 * Frozen per session for the same reason `evaluations.rubricVersion` is frozen
 * per evaluation: re-rendering an old session under a new scheme silently
 * rewrites her history. UPSC's CSAT scheme changed in 2015; assume it can
 * change again.
 */
export function resolveScheme(session?: Pick<SessionFacts, 'markPerCorrect' | 'markPerWrong'>): MarkingScheme {
  if (!session) return { ...MARKS };

  const perCorrect = Number.isFinite(session.markPerCorrect)
    ? snap(session.markPerCorrect, MARKS.perCorrect)
    : MARKS.perCorrect;
  const perWrong = Number.isFinite(session.markPerWrong)
    ? snap(session.markPerWrong, MARKS.perWrong)
    : MARKS.perWrong;

  return { perCorrect, perWrong, perSkip: MARKS.perSkip };
}

/** Expected marks from answering one question with probability `p` of being right. */
export function expectedMarks(p: number, scheme: MarkingScheme = MARKS): number {
  return scheme.perCorrect * p + scheme.perWrong * (1 - p);
}

/**
 * The accuracy at which answering and skipping are worth the same.
 *
 * Solve `perCorrect·p + perWrong·(1 − p) = perSkip` for p. Under the standard
 * scheme this is exactly 1/4.
 */
export function breakEvenAccuracy(scheme: MarkingScheme = MARKS): number {
  const span = scheme.perCorrect - scheme.perWrong;
  if (span === 0) return Number.NaN;
  return (scheme.perSkip - scheme.perWrong) / span;
}

/** 0.25 under the standard scheme. Below this, answering costs marks. */
export const BREAK_EVEN_ACCURACY = breakEvenAccuracy(MARKS);

/**
 * A four-way question with one option eliminated: p = 1/3 ≈ 33.3%.
 *
 * This is the trainable target, not the break-even. It is comfortably ABOVE the
 * 25% break-even and worth `+2/9` a question, which is exactly why the rule
 * worth drilling is "guess if and only if you eliminated something". Candidates
 * lose marks because they believe they eliminated when they did not — hence the
 * guess bucket below, which measures the belief against the outcome.
 */
export const ONE_ELIMINATION_ACCURACY = 1 / 3;

/* ------------------------------------------------------------ per attempt */

export type AttemptOutcome = 'correct' | 'wrong' | 'skipped';

/**
 * The three-way branch, written once.
 *
 * `correct === true` with `chosenIndex === null` is forbidden by the
 * `mcq_attempts_skip_not_correct` CHECK, but a row that somehow carried it
 * would be read as a SKIP here, never as a correct answer. Awarding +2 for a
 * question she never answered is worse than losing the row.
 */
export function outcomeOf(attempt: Pick<AttemptRecord, 'chosenIndex' | 'correct'>): AttemptOutcome {
  // `== null` catches both null and undefined in one comparison, matching
  // `mcq-redrill.outcomeOf` exactly. The two must agree on every input: if one
  // classified an attempt as skipped while the other called it wrong, the same
  // answer would score zero and still increment `lapses` — breaking the
  // invariant both files state in their headers, in a way no test would catch
  // because no code path produces the disagreeing value today.
  if (attempt.chosenIndex == null) return 'skipped';
  return attempt.correct ? 'correct' : 'wrong';
}

export interface ScoredAttempt {
  questionId: number;
  outcome: AttemptOutcome;
  chosenIndex: number | null;
  guessed: boolean;
  /** Marks this attempt actually contributed. Always 0 when `excluded`. */
  marks: number;
  /**
   * The key was disputed. Scores zero AND leaves `maxMarks`: a bad key must not
   * both teach a falsehood and tell her she is worse than she is.
   */
  excluded: boolean;
  /** `priorAttempts > 0`. A correct repeat may be remembered rather than known. */
  repeat: boolean;
  priorAttempts: number;
  timeTakenSec: number;
  attemptedAt: string;
}

/* -------------------------------------------------------- counterfactuals */

/**
 * "You guessed 6 times and got 1. Skipping those would have scored 1.3 marks
 * more." — in marks, from this session's own rows. A preached rule is not a
 * lesson; her own arithmetic is.
 */
export interface GuessCounterfactual {
  /** Answered AND flagged as a guess, disputed rows excluded. */
  guesses: number;
  correct: number;
  wrong: number;
  /** What those guesses actually scored. */
  actualMarks: number;
  /** What they would have scored skipped: zero, by definition. */
  skippedMarks: number;
  /** `skippedMarks − actualMarks`. Positive means skipping would have paid. */
  deltaMarks: number;
  message: string;
}

/**
 * "You skipped 3. At your own guess rate of 38%, guessing would have been worth
 * +0.9." `null` when she flagged no guesses, because there is then no rate of
 * her own to price the skips against and a borrowed one would be fiction.
 */
export interface SkipCounterfactual {
  skips: number;
  /** Correct ÷ answered among THIS session's flagged guesses. */
  guessAccuracy: number | null;
  expectedMarksPerGuess: number | null;
  /** Expected marks gained by guessing the skips instead. `null` when unknown. */
  deltaMarks: number | null;
  message: string;
}

export interface SessionCounterfactuals {
  guessing: GuessCounterfactual;
  skipping: SkipCounterfactual;
}

/* ------------------------------------------------------------- the score */

export interface SessionScore {
  sessionId: number;
  mode: SessionMode;
  status: SessionStatus;
  studyDate: string;
  scheme: MarkingScheme;

  /**
   * Whether this session's marks belong on a scoreboard.
   *
   * Completed only. An abandoned or in-progress session still exposes a fully
   * populated `perAttempt` — those answers happened — but its total is not a
   * score of anything and never reaches the trend.
   */
  scoreable: boolean;
  notScoreableReason: string | null;

  perAttempt: ScoredAttempt[];

  plannedCount: number;
  /** Attempts on record, disputed included. */
  seen: number;
  /** Attempts that count for marks: `seen` minus disputed. */
  counted: number;
  answered: number;
  skipped: number;
  correct: number;
  wrong: number;
  excluded: number;
  repeats: number;

  netMarks: number;
  /** `counted × perCorrect`. Disputed questions reduce it. */
  maxMarks: number;
  /**
   * Marks per 100 questions — the ONE cross-session comparable figure.
   *
   * A 10-question drill and a 25-question set cannot share an axis in raw
   * marks, exactly as a 9/15 and a 12/20 cannot share one in raw totals (see
   * the percent rule in `db/answers.ts`). Normalising to 100 also puts it on
   * the scale of the real paper, which is 100 questions for 200 marks.
   * `null` when nothing countable was attempted.
   */
  netPer100: number | null;

  /**
   * Answered ÷ counted. FIRST-CLASS, not a footnote.
   *
   * Over-correcting into skipping everything is a real failure mode and is
   * completely invisible in an accuracy figure: skip 95 of 100 and answer the
   * remaining 5 perfectly and accuracy reads 100%.
   */
  attemptRate: number | null;
  /** Headline accuracy: first sightings only. Repeats are excluded. */
  accuracy: number | null;
  /** Accuracy over every answered attempt, repeats included. */
  accuracyWithRepeats: number | null;

  counterfactuals: SessionCounterfactuals;
}

const NO_ATTEMPT_PRIORS: ReadonlyMap<number, number> = new Map<number, number>();

function reasonNotScoreable(status: SessionStatus, seen: number, planned: number): string | null {
  if (status === 'completed') return null;
  if (status === 'abandoned') {
    return (
      `Abandoned at ${seen} of ${planned}. Every answer below still counts toward your ` +
      `lifetime accuracy and calibration, but ${seen} questions is an interrupted ` +
      `commute, not a score — so it stays out of the marks trend.`
    );
  }
  return 'Still in progress. Marks are provisional until the session is finished.';
}

/**
 * Scores one session.
 *
 * `disputedQuestionIds` are questions whose KEY is in doubt — currently
 * quarantined, or disputed and upheld. `priorAttemptsByQuestion` counts attempts
 * on each question from BEFORE this session, derived rather than stored (a
 * stored copy drifts).
 */
export function scoreSession(
  session: SessionFacts,
  attempts: readonly AttemptRecord[],
  disputedQuestionIds: Iterable<number> = [],
  priorAttemptsByQuestion: ReadonlyMap<number, number> = NO_ATTEMPT_PRIORS,
): SessionScore {
  const scheme = resolveScheme(session);
  const disputed = new Set<number>(disputedQuestionIds);

  const perAttempt: ScoredAttempt[] = attempts.map((attempt) => {
    const outcome = outcomeOf(attempt);
    const excluded = disputed.has(attempt.questionId);
    const priorAttempts = priorAttemptsByQuestion.get(attempt.questionId) ?? 0;

    const marks = excluded
      ? 0
      : outcome === 'correct'
        ? scheme.perCorrect
        : outcome === 'wrong'
          ? scheme.perWrong
          : scheme.perSkip;

    return {
      questionId: attempt.questionId,
      outcome,
      chosenIndex: attempt.chosenIndex,
      guessed: attempt.guessed,
      marks,
      excluded,
      repeat: priorAttempts > 0,
      priorAttempts,
      timeTakenSec: attempt.timeTakenSec,
      attemptedAt: attempt.attemptedAt,
    };
  });

  const counting = perAttempt.filter((a) => !a.excluded);
  const answeredRows = counting.filter((a) => a.outcome !== 'skipped');
  const firstSightings = answeredRows.filter((a) => !a.repeat);

  const correct = counting.filter((a) => a.outcome === 'correct').length;
  const wrong = counting.filter((a) => a.outcome === 'wrong').length;
  const skipped = counting.filter((a) => a.outcome === 'skipped').length;
  const excluded = perAttempt.length - counting.length;
  const repeats = perAttempt.filter((a) => a.repeat).length;

  const netMarks = totalMarks(correct, wrong, skipped, scheme);
  const counted = counting.length;
  const maxMarks = counted * scheme.perCorrect;

  return {
    sessionId: session.sessionId,
    mode: session.mode,
    status: session.status,
    studyDate: session.studyDate,
    scheme,

    scoreable: session.status === 'completed',
    notScoreableReason: reasonNotScoreable(session.status, perAttempt.length, session.plannedCount),

    perAttempt,

    plannedCount: session.plannedCount,
    seen: perAttempt.length,
    counted,
    answered: answeredRows.length,
    skipped,
    correct,
    wrong,
    excluded,
    repeats,

    netMarks,
    maxMarks,
    netPer100: counted > 0 ? (netMarks / counted) * 100 : null,

    attemptRate: counted > 0 ? answeredRows.length / counted : null,
    accuracy: ratio(firstSightings.filter((a) => a.outcome === 'correct').length, firstSightings.length),
    accuracyWithRepeats: ratio(correct, answeredRows.length),

    counterfactuals: buildCounterfactuals(counting, skipped, scheme),
  };
}

function ratio(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/**
 * Net marks from COUNTS, never from summing one row at a time.
 *
 * Three multiplications instead of N additions, and the difference is not
 * cosmetic: accumulating `−2/3` seventy-five times leaves 4.2e−14 of float
 * residue, so the break-even identity — 25 correct, 75 wrong — comes out at
 * `4.15e-14` rather than `0`. `25 * 2 + 75 * (−2/3)` is exactly `0` in IEEE-754
 * because `75 * (−2/3)` rounds to exactly `−50`. A break-even that is only
 * approximately zero cannot be asserted, cannot be eyeballed, and quietly
 * stops being a fact about the marking scheme.
 */
function totalMarks(
  correct: number,
  wrong: number,
  skipped: number,
  scheme: MarkingScheme,
): number {
  return correct * scheme.perCorrect + wrong * scheme.perWrong + skipped * scheme.perSkip;
}

/* ------------------------------------------------------ counterfactual text */

/** One decimal. Marks are only ever meaningful to about a third of one. */
function marks(value: number): string {
  return Math.abs(value).toFixed(1);
}

function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function times(count: number): string {
  return count === 1 ? 'once' : `${count} times`;
}

/** Below this many marks the difference is not worth a claim in either direction. */
const NEGLIGIBLE_MARKS = 0.05;

function buildCounterfactuals(
  counting: readonly ScoredAttempt[],
  skips: number,
  scheme: MarkingScheme,
): SessionCounterfactuals {
  const guessRows = counting.filter((a) => a.guessed && a.outcome !== 'skipped');
  const guessCorrect = guessRows.filter((a) => a.outcome === 'correct').length;
  const guessWrong = guessRows.length - guessCorrect;
  const actualMarks = totalMarks(guessCorrect, guessWrong, 0, scheme);
  const skippedMarks = guessRows.length * scheme.perSkip;
  const deltaMarks = skippedMarks - actualMarks;

  const guessing: GuessCounterfactual = {
    guesses: guessRows.length,
    correct: guessCorrect,
    wrong: guessWrong,
    actualMarks,
    skippedMarks,
    deltaMarks,
    message: guessMessage(guessRows.length, guessCorrect, deltaMarks),
  };

  const guessAccuracy = ratio(guessCorrect, guessRows.length);
  const expectedMarksPerGuess = guessAccuracy === null ? null : expectedMarks(guessAccuracy, scheme);
  const skipDelta = expectedMarksPerGuess === null ? null : expectedMarksPerGuess * skips;

  const skipping: SkipCounterfactual = {
    skips,
    guessAccuracy,
    expectedMarksPerGuess,
    deltaMarks: skipDelta,
    message: skipMessage(skips, guessAccuracy, skipDelta),
  };

  return { guessing, skipping };
}

function guessMessage(guesses: number, correct: number, delta: number): string {
  if (guesses === 0) {
    return 'You flagged no guesses this session — every answer you gave, you believed.';
  }

  const opening = `You guessed ${times(guesses)} and got ${correct} right.`;

  if (delta > NEGLIGIBLE_MARKS) {
    return `${opening} Skipping those would have scored ${marks(delta)} marks more.`;
  }
  if (delta < -NEGLIGIBLE_MARKS) {
    return `${opening} Skipping those would have cost you ${marks(delta)} marks — those guesses paid.`;
  }
  return `${opening} Skipping them would have scored the same, to within a rounding error.`;
}

function skipMessage(skips: number, guessAccuracy: number | null, delta: number | null): string {
  if (skips === 0) return 'You skipped nothing — every question you saw, you answered.';

  const opening = `You skipped ${skips}.`;

  if (guessAccuracy === null || delta === null) {
    return (
      `${opening} You flagged no guesses this session, so there is no rate of your own ` +
      `to price those skips against.`
    );
  }

  const rate = `At your own guess rate of ${percent(guessAccuracy)}`;

  if (delta > NEGLIGIBLE_MARKS) {
    return `${opening} ${rate}, guessing would have been worth +${marks(delta)}.`;
  }
  if (delta < -NEGLIGIBLE_MARKS) {
    return `${opening} ${rate}, guessing would have cost ${marks(delta)} — the skips were right.`;
  }
  return `${opening} ${rate}, guessing was worth almost exactly nothing either way.`;
}

/* ------------------------------------------------------------ formatting */

/**
 * Display helpers, here rather than in the components.
 *
 * Two cards and one screen render these same numbers. Left to each of them
 * they would drift — one showing `-0.7`, another `−0.67`, a third `-0.666666`
 * — and a marks figure that renders differently in two places on one screen
 * reads as two different figures.
 */

/** `+8`, `−1.3`, `0`. A real minus sign, and no trailing `.0` on whole marks. */
export function formatSignedMarks(value: number): string {
  // Rounded before the zero test so −0.04 renders as `0`, never as `−0`.
  const rounded = Math.round(value * 10) / 10;
  if (rounded === 0) return '0';
  const body = Number.isInteger(rounded) ? String(Math.abs(rounded)) : Math.abs(rounded).toFixed(1);
  return `${rounded > 0 ? '+' : '−'}${body}`;
}

/** `8`, `3.3`. Unsigned, for maxima and totals that cannot be negative. */
export function formatMarks(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** `80%`, or an em dash when the figure does not exist. Never `0%` for unknown. */
export function formatPercent(fraction: number | null, dash = '—'): string {
  return fraction === null ? dash : `${Math.round(fraction * 100)}%`;
}

/* --------------------------------------------------------------- trend */

export interface NetMarksPoint {
  sessionId: number;
  /** The session's local study day, fixed at start. Not recomputed. */
  date: string;
  mode: SessionMode;
  netMarks: number;
  /** The comparable figure. This is what a chart plots. */
  netPer100: number;
  counted: number;
}

/**
 * Chronological net-marks history, normalised per 100 questions.
 *
 * Abandoned and in-progress sessions are dropped. Including them would make the
 * line a record of which commutes got interrupted rather than of how she is
 * scoring, and the drops would look exactly like collapses in performance.
 * Oldest-first, matching `scoreTrend()`.
 */
export function netMarksTrend(scores: readonly SessionScore[]): NetMarksPoint[] {
  return scores
    .filter((score) => score.scoreable && score.counted > 0 && score.netPer100 !== null)
    .map((score) => ({
      sessionId: score.sessionId,
      date: score.studyDate,
      mode: score.mode,
      netMarks: score.netMarks,
      netPer100: score.netPer100 as number,
      counted: score.counted,
    }))
    .sort((a, b) => (a.date === b.date ? a.sessionId - b.sessionId : a.date < b.date ? -1 : 1));
}

/* ---------------------------------------------------------- calibration */

export type CalibrationBucketKey = 'answered_confident' | 'answered_guessed' | 'skipped';

export interface CalibrationBucket {
  key: CalibrationBucketKey;
  label: string;
  attempts: number;
  correct: number;
  wrong: number;
  /** `null` for the skipped bucket and for any empty bucket. */
  accuracy: number | null;
  netMarks: number;
  /** Marks per 10 questions handled this way. THE SIGN IS THE LESSON. */
  marksPer10: number | null;
  /** `null` where accuracy is unknowable (skips have no accuracy). */
  aboveBreakEven: boolean | null;
}

export interface Calibration {
  total: number;
  answered: number;
  skipped: number;
  /** First-class. Skipping everything is a failure mode an accuracy hides. */
  attemptRate: number | null;
  accuracyOnAttempted: number | null;
  guessAccuracy: number | null;
  confidentAccuracy: number | null;
  buckets: CalibrationBucket[];
  breakEvenAccuracy: number;

  /**
   * Whether the "I'm guessing" flag can be believed.
   *
   * The flag is opt-in and will be under-reported: guessing feels like knowing.
   * If the attempts she did NOT flag are barely better than chance over a real
   * sample, the flag is not measuring what it claims and every bucket split by
   * it is fiction. An instrument that cannot detect its own failure is worse
   * than no instrument, so this goes false and the verdict falls back to
   * aggregate framing that does not depend on the flag at all.
   */
  instrumentTrusted: boolean;
  instrumentNote: string | null;

  verdict: string;
  verdictBasis: 'buckets' | 'aggregate';
  /** Attempting almost nothing is the other way to lose marks. */
  overCorrecting: boolean;
}

/** Sample below which a poor confident bucket is noise, not a broken instrument. */
export const INSTRUMENT_MIN_ATTEMPTS = 40;

/** Confident-bucket accuracy below this over a real sample means the flag is not being used. */
export const INSTRUMENT_MIN_CONFIDENT_ACCURACY = 0.7;

/** Attempt rate below which "skip more" is the wrong advice however good the accuracy. */
export const OVER_CORRECTION_ATTEMPT_RATE = 0.6;

const BUCKET_LABELS: Record<CalibrationBucketKey, string> = {
  answered_confident: 'Answered, not flagged',
  answered_guessed: 'Answered, flagged as a guess',
  skipped: 'Skipped',
};

function bucketOf(attempt: Pick<AttemptRecord, 'chosenIndex' | 'correct' | 'guessed'>): CalibrationBucketKey {
  if (outcomeOf(attempt) === 'skipped') return 'skipped';
  return attempt.guessed ? 'answered_guessed' : 'answered_confident';
}

/**
 * Calibration over any set of attempts — one session, one week, or everything.
 *
 * Deliberately takes raw `AttemptRecord`s rather than scored ones: this is the
 * LIFETIME view, it spans sessions that may have been dealt under different
 * frozen schemes, and it answers "does she know when she does not know", which
 * has nothing to do with whether any particular session was completed. Abandoned
 * sessions belong in here in full.
 */
export function calibration(
  attempts: readonly AttemptRecord[],
  scheme: MarkingScheme = MARKS,
): Calibration {
  const keys: CalibrationBucketKey[] = ['answered_confident', 'answered_guessed', 'skipped'];

  const buckets: CalibrationBucket[] = keys.map((key) => {
    const rows = attempts.filter((a) => bucketOf(a) === key);
    const correct = rows.filter((a) => outcomeOf(a) === 'correct').length;
    const wrong = rows.filter((a) => outcomeOf(a) === 'wrong').length;
    const netMarks = totalMarks(correct, wrong, rows.length - correct - wrong, scheme);
    const accuracy = key === 'skipped' ? null : ratio(correct, rows.length);

    return {
      key,
      label: BUCKET_LABELS[key],
      attempts: rows.length,
      correct,
      wrong,
      accuracy,
      netMarks,
      marksPer10: rows.length > 0 ? (netMarks / rows.length) * 10 : null,
      aboveBreakEven: accuracy === null ? null : accuracy > breakEvenAccuracy(scheme),
    };
  });

  const byKey = (key: CalibrationBucketKey) => buckets.find((b) => b.key === key)!;
  const confident = byKey('answered_confident');
  const guessed = byKey('answered_guessed');
  const skippedBucket = byKey('skipped');

  const answered = confident.attempts + guessed.attempts;
  const total = attempts.length;
  const attemptRate = ratio(answered, total);
  const accuracyOnAttempted = ratio(confident.correct + guessed.correct, answered);

  const instrumentBroken =
    confident.attempts >= INSTRUMENT_MIN_ATTEMPTS &&
    confident.accuracy !== null &&
    confident.accuracy < INSTRUMENT_MIN_CONFIDENT_ACCURACY;

  const breakEven = breakEvenAccuracy(scheme);
  const overCorrecting = attemptRate !== null && total > 0 && attemptRate < OVER_CORRECTION_ATTEMPT_RATE;

  const useBuckets = !instrumentBroken && guessed.attempts > 0;

  return {
    total,
    answered,
    skipped: skippedBucket.attempts,
    attemptRate,
    accuracyOnAttempted,
    guessAccuracy: guessed.accuracy,
    confidentAccuracy: confident.accuracy,
    buckets,
    breakEvenAccuracy: breakEven,

    instrumentTrusted: !instrumentBroken,
    instrumentNote: instrumentBroken ? instrumentNoteFor(confident) : null,

    verdict: useBuckets
      ? bucketVerdict(guessed, breakEven, attemptRate, overCorrecting)
      : aggregateVerdict(attemptRate, accuracyOnAttempted, skippedBucket.attempts, breakEven, overCorrecting),
    verdictBasis: useBuckets ? 'buckets' : 'aggregate',
    overCorrecting,
  };
}

function instrumentNoteFor(confident: CalibrationBucket): string {
  return (
    `The answers you did not flag are only ${percent(confident.accuracy ?? 0)} right over ` +
    `${confident.attempts} attempts. That is close enough to guessing that the “I'm guessing” ` +
    `flag is clearly under-reported, so the guess breakdown cannot be trusted and this reads ` +
    `your totals instead.`
  );
}

function attemptRateClause(attemptRate: number | null, overCorrecting: boolean): string {
  if (!overCorrecting || attemptRate === null) return '';
  return (
    ` Watch the other direction too: you attempted only ${percent(attemptRate)} of what you saw, ` +
    `and a skipped question can never pay.`
  );
}

function bucketVerdict(
  guessed: CalibrationBucket,
  breakEven: number,
  attemptRate: number | null,
  overCorrecting: boolean,
): string {
  const accuracy = guessed.accuracy ?? 0;
  const per10 = guessed.marksPer10 ?? 0;
  const tail = attemptRateClause(attemptRate, overCorrecting);

  if (accuracy > breakEven) {
    return (
      `Your flagged guesses land ${percent(accuracy)} of the time — above the ` +
      `${percent(breakEven)} break-even, so they are worth ${marks(per10)} marks per 10. ` +
      `Keep guessing when you have eliminated an option.${tail}`
    );
  }
  if (accuracy < breakEven) {
    return (
      `Your flagged guesses land only ${percent(accuracy)} of the time — below the ` +
      `${percent(breakEven)} break-even, costing ${marks(per10)} marks per 10. ` +
      `Skip unless you have genuinely eliminated an option.${tail}`
    );
  }
  return (
    `Your flagged guesses land ${percent(accuracy)} — exactly the ${percent(breakEven)} ` +
    `break-even, so they are worth nothing either way. Only guesses that follow a real ` +
    `elimination beat that.${tail}`
  );
}

function aggregateVerdict(
  attemptRate: number | null,
  accuracyOnAttempted: number | null,
  skipped: number,
  breakEven: number,
  overCorrecting: boolean,
): string {
  if (attemptRate === null || accuracyOnAttempted === null) {
    return 'Not enough attempts yet to say anything about your guessing.';
  }

  const head = `You attempt ${percent(attemptRate)} of what you see and land ${percent(accuracyOnAttempted)} of those.`;
  const tail = attemptRateClause(attemptRate, overCorrecting);

  if (accuracyOnAttempted > breakEven) {
    const skipLine =
      skipped > 0
        ? ` The ${skipped} you skipped are the untested part: at that accuracy, any of them where you could eliminate an option was worth attempting.`
        : '';
    return `${head} Above ${percent(breakEven)} an attempt pays, so what you do attempt is paying.${skipLine}${tail}`;
  }

  return (
    `${head} That is below the ${percent(breakEven)} break-even, so on average each attempt ` +
    `is costing you marks. Skip unless you have eliminated an option.${tail}`
  );
}
