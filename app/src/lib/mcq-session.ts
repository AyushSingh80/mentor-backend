/**
 * The drill runtime: presets, the deal/advance machine, timer accounting and
 * the abandon/resume rules. Pure — no RN, no expo-sqlite, no `@/db/*` values.
 *
 * Everything in this file is a function of its arguments, which is the only
 * reason any of it is testable: `db/mcq-sessions.ts` transitively imports
 * `expo-sqlite` and cannot run under `node --import tsx`. So the rules live
 * here and the repository stays thin, exactly as `lib/sm2.ts` and
 * `db/revision.ts` are split.
 *
 * ## One engine, two presets
 *
 * Scoring, selection, the pad and persistence are shared. Two implementations
 * of scoring is precisely how two code paths end up disagreeing by a third of
 * a mark with neither trustworthy — so scoring is not here at all. It lives in
 * `lib/mcq-score.ts`, once, and both presets go through it.
 *
 * The presets differ in four behaviours that a duration setting cannot
 * express, and each one is a measurement property rather than a preference:
 *
 * | | `micro` | `timed` |
 * |---|---|---|
 * | Reveal | after each question | at the END only |
 * | Clock | none shown; time recorded | visible countdown, auto-submits at zero |
 * | Abandonment | resumable within the local day | never resumable |
 * | Count | 10, extendable +5 to 20 | 25 |
 *
 * A set that shows the answer mid-way is not a measurement, and neither is a
 * measured set resumed after a two-hour break. Both are fine for practice,
 * which is what `micro` is for.
 *
 * ## Two clocks, again
 *
 * `studyDate` is the LOCAL CALENDAR DAY captured at session start. Everything
 * about resumption and closure compares calendar days. Instants (`startedAt`,
 * `attemptedAt`) are for the audit log. They are separate parameters here for
 * the same reason they are separate in `db/revision.ts`: at 02:00 in
 * Asia/Kolkata a UTC timestamp still carries yesterday's date.
 *
 * ## `timeTakenSec` is advisory, structurally
 *
 * Nothing in this module lets a duration reach scoring or selection. The only
 * consumer of `timeTakenSec` is the `mcq_attempts.time_taken_sec` column, and
 * neither `lib/mcq-score.ts` nor `lib/mcq-redrill.ts` reads it. That is
 * deliberate: `activeSeconds` is a best effort over AppState transitions, so a
 * wrong answer there must stay cosmetic rather than corrupting a mark or a
 * spaced-repetition interval.
 */

import {
  OPTION_COUNT,
  type AttemptRecord,
  type DrillQuestion,
  type SessionMode,
  type SessionPreset,
  type SessionStatus,
} from '@/lib/mcq-types';

/* ---------------------------------------------------------------- presets */

/**
 * A commute. Ten questions because the arithmetic works out to a real
 * twelve-and-a-half minutes: roughly 45 s to answer plus roughly 30 s to
 * actually read the elimination logic is 75 s a question, and reading the
 * elimination logic is the part that teaches. Twenty would be a set she
 * abandons; five would not be worth unlocking the phone for.
 *
 * Extendable in fives to twenty for the days the train is stuck, because the
 * alternative — starting a second session — splits one sitting into two rows
 * and makes the day's figures wrong in both directions.
 */
export const MICRO_PRESET: SessionPreset = {
  mode: 'micro',
  questionCount: 10,
  maxQuestionCount: 20,
  revealMode: 'per_question',
  secondsPerQuestion: null,
  resumableWithinDay: true,
  // A micro drill is for consolidating studied material, so the trust argument
  // behind the eligibility gate holds here in full.
  preferPyq: false,
  allowUnstudiedPyq: false,
};

/**
 * A measured set. Twenty-five questions at 72 s each is 30 minutes, and 72 s
 * is not arbitrary: UPSC Prelims is 100 questions in 120 minutes, which is
 * exactly 72 s a question. A measured set that runs at a gentler pace than the
 * exam measures something other than the exam.
 *
 * `preferPyq` because the point of a measured set is calibration, and a past
 * question's key is UPSC's rather than a model's.
 */
export const TIMED_PRESET: SessionPreset = {
  mode: 'timed',
  questionCount: 25,
  // Equal to `questionCount`: extending a measured set mid-flight changes the
  // denominator of the thing being measured. `canExtend` reads this.
  maxQuestionCount: 25,
  revealMode: 'at_end',
  secondsPerQuestion: 72,
  resumableWithinDay: false,
  preferPyq: true,
  allowUnstudiedPyq: true,
};

export const PRESETS: Record<SessionMode, SessionPreset> = {
  micro: MICRO_PRESET,
  timed: TIMED_PRESET,
};

/** Five, not one: a one-question extension is a decision she has to make ten times. */
export const EXTEND_STEP = 5;

/** Route params and DB text columns are strings and can be anything. */
export function isSessionMode(value: unknown): value is SessionMode {
  return value === 'micro' || value === 'timed';
}

export function presetFor(mode: SessionMode): SessionPreset {
  return PRESETS[mode];
}

export function canExtend(preset: SessionPreset, plannedCount: number): boolean {
  return plannedCount < preset.maxQuestionCount;
}

export function extendedCount(preset: SessionPreset, plannedCount: number): number {
  if (!canExtend(preset, plannedCount)) return plannedCount;
  return Math.min(preset.maxQuestionCount, plannedCount + EXTEND_STEP);
}

/**
 * The whole-set budget, in seconds, or `null` when there is no clock.
 *
 * `secondsPerQuestion` is a RATE, not a per-question deadline. A per-question
 * timer that fires would force a commit on a question she was three seconds
 * from getting right, which is not how the exam works either — the exam gives
 * you the whole budget and lets you spend it where it pays.
 */
export function sessionBudgetSeconds(preset: SessionPreset, questionCount: number): number | null {
  if (preset.secondsPerQuestion === null) return null;
  return Math.max(0, Math.round(preset.secondsPerQuestion * questionCount));
}

/**
 * What the countdown reads, or `null` in `micro` — where elapsed time is
 * recorded but never displayed as pressure. A commute drill with a clock on it
 * is a commute drill she stops doing.
 */
export function remainingSeconds(
  preset: SessionPreset,
  questionCount: number,
  elapsedSec: number,
): number | null {
  const budget = sessionBudgetSeconds(preset, questionCount);
  if (budget === null) return null;
  if (!Number.isFinite(elapsedSec)) return budget;
  return Math.max(0, budget - Math.floor(elapsedSec));
}

/* ------------------------------------------------------------------ timer */

/**
 * A transition of "is this drill actually in front of her", the AND of
 * `AppState === 'active'` and the screen being focused. Recorded at the
 * instant it happens; the reducer below turns a list of them into a duration.
 */
export interface ClockEvent {
  atMs: number;
  active: boolean;
}

/**
 * The hard ceiling on one question's recorded time.
 *
 * She pockets the phone mid-question, gets off the train, and answers forty
 * minutes later. Without a clamp that single attempt records 2400 s and drags
 * every mean it touches. Ten minutes is already far beyond any honest single
 * MCQ, so anything above it is noise whatever caused it — and because
 * `timeTakenSec` is advisory, clamping it cannot cost a mark.
 */
export const MAX_QUESTION_SECONDS = 600;

/**
 * Milliseconds spent active inside `[startedAtMs, endedAtMs]`, unclamped.
 *
 * Events at or before the window's start define the state the window opened
 * in — a question begun while the app was already backgrounded (a
 * notification tap that lands the wrong way) accumulates nothing until the
 * next `active: true`. Events are copied before sorting: the caller's array is
 * usually a ref that is still being appended to.
 */
export function activeMillis(
  events: readonly ClockEvent[],
  startedAtMs: number,
  endedAtMs: number,
): number {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) return 0;
  const end = Math.max(startedAtMs, endedAtMs);

  const ordered = events
    .filter((event) => Number.isFinite(event.atMs))
    .slice()
    .sort((a, b) => a.atMs - b.atMs);

  // Default true: with no events at all the question was simply in front of
  // her the whole time, which is the overwhelmingly common case.
  let active = true;
  for (const event of ordered) {
    if (event.atMs > startedAtMs) break;
    active = event.active;
  }

  let cursor = startedAtMs;
  let millis = 0;
  for (const event of ordered) {
    if (event.atMs <= startedAtMs) continue;
    if (event.atMs >= end) break;
    if (active) millis += event.atMs - cursor;
    cursor = event.atMs;
    active = event.active;
  }
  if (active) millis += end - cursor;

  return Math.max(0, millis);
}

/**
 * One question's `timeTakenSec`: foreground-only and hard-clamped.
 *
 * The clamp is applied here rather than by the caller so that every write of
 * `timeTakenSec` goes through the same ceiling — a second call site that
 * forgot it is exactly how one 40-minute attempt gets into the table.
 */
export function activeSeconds(
  events: readonly ClockEvent[],
  startedAtMs: number,
  endedAtMs: number,
): number {
  const seconds = Math.round(activeMillis(events, startedAtMs, endedAtMs) / 1000);
  return Math.min(MAX_QUESTION_SECONDS, Math.max(0, seconds));
}

/* ------------------------------------------------------- deal and advance */

export type DrillPhase = 'answering' | 'revealed' | 'finished';

export interface DrillMachine {
  /** Index into the dealt questions. */
  index: number;
  phase: DrillPhase;
  /**
   * The "I'm guessing" flag for the CURRENT question only. Reset on every
   * advance so the toggle costs one extra tap exactly when it applies, and
   * never silently carries a stale claim onto the next question.
   */
  guessing: boolean;
}

/** Question ids that already have a committed attempt in this session. */
export function answeredIds(attempts: readonly AttemptRecord[]): Set<number> {
  return new Set(attempts.map((attempt) => attempt.questionId));
}

/**
 * The first question with no committed attempt, or `null` when the set is
 * finished.
 *
 * This is the whole resume mechanism. There is no stored cursor to reconcile
 * against a set of attempts that a crash may have truncated — the position IS
 * derived from what is durable, so the two cannot disagree.
 */
export function nextIndex(
  questions: readonly Pick<DrillQuestion, 'questionId'>[],
  attempts: readonly AttemptRecord[],
): number | null {
  const done = answeredIds(attempts);
  for (let index = 0; index < questions.length; index += 1) {
    if (!done.has(questions[index].questionId)) return index;
  }
  return null;
}

/** The machine as it should be on mount, restored from what SQLite holds. */
export function startMachine(
  questions: readonly Pick<DrillQuestion, 'questionId'>[],
  attempts: readonly AttemptRecord[],
): DrillMachine {
  const index = nextIndex(questions, attempts);
  if (index === null) {
    return { index: Math.max(0, questions.length - 1), phase: 'finished', guessing: false };
  }
  // Never 'revealed': a resumed micro session must not open on the previous
  // question's answer, and the attempt it belonged to is already durable.
  return { index, phase: 'answering', guessing: false };
}

/**
 * One committed answer.
 *
 * In `per_question` the machine stops on the reveal — the elimination logic is
 * the part that teaches, and skipping past it makes the drill a quiz. In
 * `at_end` it moves straight on, because showing the key mid-set would end the
 * measurement.
 */
export function commit(machine: DrillMachine, preset: SessionPreset, total: number): DrillMachine {
  if (machine.phase === 'finished') return machine;
  if (preset.revealMode === 'per_question') {
    return { ...machine, phase: 'revealed' };
  }
  return advance({ ...machine, phase: 'revealed' }, total);
}

/** Explicit tap only. There is deliberately no swipe — see the screen header. */
export function advance(machine: DrillMachine, total: number): DrillMachine {
  if (machine.phase === 'finished') return machine;
  const next = machine.index + 1;
  if (next >= total) {
    return { index: machine.index, phase: 'finished', guessing: false };
  }
  return { index: next, phase: 'answering', guessing: false };
}

/** Extending a micro set re-opens a machine that had already finished. */
export function reopen(machine: DrillMachine, total: number): DrillMachine {
  if (machine.phase !== 'finished') return machine;
  const index = Math.min(machine.index + 1, Math.max(0, total - 1));
  return { index, phase: 'answering', guessing: false };
}

export function toggleGuess(machine: DrillMachine): DrillMachine {
  return { ...machine, guessing: !machine.guessing };
}

/* -------------------------------------------------------------- outcomes */

/** An attempt as it is about to be written. `AttemptRecord` minus the instant. */
export interface PendingAttempt {
  questionId: number;
  /** `null` IS the skip. There is no separate flag — see the schema comment. */
  chosenIndex: number | null;
  correct: boolean;
  guessed: boolean;
  timeTakenSec: number;
}

/**
 * The single place `correct` is decided.
 *
 * An out-of-range index is treated as a skip rather than as a wrong answer:
 * it can only come from a bug, and inventing a wrong answer out of a bug both
 * costs her a mark and enrols the question in the re-drill queue.
 */
export function commitAnswer(
  question: Pick<DrillQuestion, 'questionId' | 'correctIndex'>,
  chosenIndex: number | null,
  guessed: boolean,
  timeTakenSec: number,
): PendingAttempt {
  const valid =
    chosenIndex !== null &&
    Number.isInteger(chosenIndex) &&
    chosenIndex >= 0 &&
    chosenIndex < OPTION_COUNT;

  const chosen = valid ? chosenIndex : null;

  return {
    questionId: question.questionId,
    chosenIndex: chosen,
    correct: chosen !== null && chosen === question.correctIndex,
    // A skip is not a guess. Recording one would inflate the guess rate with
    // the exact decisions that prove she is NOT guessing.
    guessed: chosen === null ? false : guessed,
    timeTakenSec: clampSeconds(timeTakenSec),
  };
}

export function skipAnswer(
  question: Pick<DrillQuestion, 'questionId' | 'correctIndex'>,
  timeTakenSec: number,
): PendingAttempt {
  return commitAnswer(question, null, false, timeTakenSec);
}

/**
 * The clock hit zero with questions still unanswered.
 *
 * Every one of them becomes a SKIP, never a wrong answer. Marking them wrong
 * would charge −0.667 each for questions she never saw — turning a
 * mistimed set into a punitive score — and would enrol every one of them in
 * the re-drill queue as though she had got them wrong. Running out of time is
 * a pacing failure, and the honest record of a pacing failure is a run of
 * unattempted questions.
 */
export function autoSubmitSkips(
  questions: readonly Pick<DrillQuestion, 'questionId' | 'correctIndex'>[],
  attempts: readonly AttemptRecord[],
): PendingAttempt[] {
  const done = answeredIds(attempts);
  return questions
    .filter((question) => !done.has(question.questionId))
    .map((question) => skipAnswer(question, 0));
}

function clampSeconds(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_QUESTION_SECONDS, Math.max(0, Math.round(value)));
}

/* ---------------------------------------------------------- NOT scoring */

/**
 * There is deliberately no scoring in this file.
 *
 * `lib/mcq-score.ts` owns marks, accuracy, the attempt rate and the guess
 * counterfactuals, and it is the only implementation. Two implementations of
 * scoring is exactly how two code paths end up disagreeing by a third of a
 * mark with neither trustworthy, so the drill screen shows PROGRESS — "7 of
 * 10" — and never a running total. The one place a mark appears mid-drill is
 * the per-question reveal, which reads `MARKS` directly rather than deriving
 * anything.
 *
 * Likewise `outcomeOf` lives in `lib/mcq-redrill.ts` alongside the rule that
 * consumes it, and in `lib/mcq-score.ts` for the same reason. This module
 * produces `PendingAttempt` rows and lets those two classify them.
 */

/* ------------------------------------------------- abandon, resume, close */

/** The lifecycle facts, which is all any of the rules below need. */
export interface SessionLifecycle {
  mode: SessionMode;
  status: SessionStatus;
  /** Local calendar day, fixed at session start and never recomputed. */
  studyDate: string;
  plannedCount: number;
  answeredCount: number;
}

/** Date-prefix comparison, never a timestamp comparison — as `sm2.isDue` does. */
export function isSameStudyDay(studyDate: string, todayIso: string): boolean {
  return studyDate.slice(0, 10) === todayIso.slice(0, 10);
}

/**
 * May she pick this session back up?
 *
 * `micro`: yes, for the rest of the local calendar day. Every committed
 * attempt is already durable, so resuming costs nothing and losing six
 * answered questions to a phone call would be the real defect.
 *
 * `timed`: never. Resuming a measured set after a break is not a measurement —
 * the break is exactly the variable the set exists to control. The unfinished
 * attempts still count toward accuracy and re-drill; only the set-level figure
 * is lost, and it was never valid.
 */
export function isResumable(session: SessionLifecycle, todayIso: string): boolean {
  if (session.status !== 'in_progress') return false;
  if (!presetFor(session.mode).resumableWithinDay) return false;
  return isSameStudyDay(session.studyDate, todayIso);
}

/**
 * What an `in_progress` row should become when a session list is next built.
 *
 * A session is never closed by a background timer — the app is not running.
 * It is closed lazily, the same way `revision_queue` enrols lazily, so the
 * status can never drift from what actually happened.
 */
export function closureStatus(session: SessionLifecycle, todayIso: string): SessionStatus {
  if (session.status !== 'in_progress') return session.status;
  // Reached the planned count but never wrote `endedAt` — the app died between
  // the last attempt and the summary. Every attempt is durable, so this is a
  // finished set, not an abandoned one.
  if (session.answeredCount >= session.plannedCount) return 'completed';
  if (isResumable(session, todayIso)) return 'in_progress';
  return 'abandoned';
}
