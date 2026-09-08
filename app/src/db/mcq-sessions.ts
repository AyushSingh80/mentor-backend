/**
 * MCQ session repository — session lifecycle, the deal, and THE ATTEMPT
 * TRANSACTION.
 *
 * Thin on purpose, like every repository here. All the rules are pure and live
 * elsewhere: presets, the advance machine, the timer and the abandon/resume
 * predicates in `lib/mcq-session.ts`; the re-drill rule in `lib/mcq-redrill.ts`;
 * marks in `lib/mcq-score.ts`. Anything importing `db/index` transitively
 * imports `expo-sqlite` and cannot run under Node, so logic placed here is
 * logic that can never be tested. What is left is queries, row mapping, and one
 * transaction that has to be exactly right.
 *
 * ## Save per question, never "review then submit"
 *
 * Phase 1's save-before-network rule, applied per question. She is on a train
 * and the app can be killed between any two taps — by iOS reclaiming memory, by
 * a call, by the battery. So an attempt is durable the instant it is committed,
 * and the screen restores its position from these rows rather than from any
 * in-memory cursor. There is deliberately no "submit the set" write: by the
 * time the last question is answered, everything that matters is already on
 * disk and finishing only stamps a status.
 *
 * ## The transaction, and why it is SYNCHRONOUS
 *
 * `recordAttempt` is not `async`, and that is the whole point rather than an
 * oversight.
 *
 * `drizzle-orm/expo-sqlite` is a `"sync"` driver: `ExpoSQLiteSession.transaction`
 * is typed `transaction<T>(cb: (tx) => T): T`. It calls `BEGIN`, then `cb(tx)`
 * WITHOUT awaiting it, then `COMMIT` on the next line. Hand it an `async`
 * callback and the callback returns a pending promise the moment it hits its
 * first `await`; `COMMIT` fires immediately, and every statement inside then
 * executes afterwards as an independent autocommit. No atomicity — and no
 * rollback either, because an async function cannot throw synchronously for the
 * driver's `catch` to see. The bug is invisible in testing: every statement
 * still runs, and every row still appears.
 *
 * Here that would mean a graded question with no attempt row, or an attempt
 * whose SM-2 consequence never landed. Months later neither is explicable: the
 * re-drill schedule would show an interval that moved for no recorded reason,
 * or a question she got wrong that never came back.
 *
 * So: no `async` on the function, no `await` in the callback, and `.run()` or
 * `.get()` terminating every statement — the sync driver's builders are lazy,
 * and a statement without a terminator is a query object that never executes.
 * Keeping the public function synchronous makes the rule structural: there is
 * no `await` anywhere for a later edit to accidentally place inside the
 * callback.
 *
 * ## What this module does NOT decide
 *
 * Marks (`lib/mcq-score.ts`), the re-drill rule (`lib/mcq-redrill.ts`) and the
 * selection ladder (`lib/mcq-select.ts` over `db/mcq-questions.ts`) each have
 * exactly one implementation and none of them is here. This module opens
 * sessions, records attempts, closes sessions, and stitches the deal together.
 *
 * ## The seam with `lib/mcq-redrill.ts`
 *
 * That module owns the RULE and is pure; this one owns the WRITE. Inside the
 * transaction: read the current `mcq_review_queue` row with `.get()`, call
 * `redrillEffect`, execute the returned `RedrillWrite` with `.run()`. SM-2 is
 * not re-implemented anywhere on this path — `mcq-redrill` delegates to
 * `lib/sm2.ts` and this file delegates to `mcq-redrill`.
 *
 * ## Two clocks
 *
 * `todayIso` is the LOCAL CALENDAR DAY and is what schedules the re-drill.
 * `attemptedAt` is the real INSTANT and is what the audit log stores. They are
 * separate parameters and must not be collapsed: at 02:00 in Asia/Kolkata
 * `new Date().toISOString()` still carries yesterday's UTC date, so scheduling
 * from it would make a just-missed question fall due again the same local day.
 * See the same note in `db/revision.ts`.
 */

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import { db } from './index';
import {
  mcqAttempts,
  mcqQuestions,
  mcqReviewQueue,
  mcqSessions,
  syllabusTopics,
} from './schema';
import { readBankSnapshot } from './mcq-bank';
import { loadSelectionCandidates } from './mcq-questions';
import { scoreSection } from '@/lib/mcq-bank';
import { selectForSession } from '@/lib/mcq-select';
import { outcomeOf, redrillEffect, type RedrillWrite } from '@/lib/mcq-redrill';
import {
  closureStatus,
  extendedCount,
  presetFor,
  sessionBudgetSeconds,
  type PendingAttempt,
  type SessionLifecycle,
} from '@/lib/mcq-session';
import {
  MARKS,
  OPTION_COUNT,
  type AttemptRecord,
  type Difficulty,
  type DrillQuestion,
  type QuestionSource,
  type SelectionTier,
  type SessionFacts,
  type SessionMode,
  type SessionPreset,
  type SessionStatus,
} from '@/lib/mcq-types';
import type { Sm2State } from '@/lib/sm2';

type SessionRow = typeof mcqSessions.$inferSelect;
type AttemptRow = typeof mcqAttempts.$inferSelect;

/* -------------------------------------------------------------- mapping */

function toMode(raw: string): SessionMode {
  return raw === 'timed' ? 'timed' : 'micro';
}

/** Anything unrecognised reads as still running, never as a finished score. */
function toStatus(raw: string): SessionStatus {
  return raw === 'completed' || raw === 'abandoned' ? raw : 'in_progress';
}

function toFacts(row: SessionRow): SessionFacts {
  return {
    sessionId: row.id,
    mode: toMode(row.mode),
    status: toStatus(row.status),
    studyDate: row.studyDate,
    plannedCount: row.plannedCount,
    markPerCorrect: row.markPerCorrect,
    markPerWrong: row.markPerWrong,
  };
}

/**
 * `timeTakenSec` is nullable and advisory everywhere, so a missing duration
 * becomes 0 rather than propagating a null into arithmetic.
 */
function toAttempt(row: AttemptRow): AttemptRecord {
  return {
    questionId: row.questionId,
    chosenIndex: row.chosenIndex,
    correct: row.correct,
    guessed: row.guessed,
    timeTakenSec: row.timeTakenSec ?? 0,
    attemptedAt: row.attemptedAt,
  };
}

function toDifficulty(raw: string): Difficulty {
  return raw === 'easy' || raw === 'hard' ? raw : 'medium';
}

function toSource(raw: string | null): QuestionSource {
  return raw === 'pyq' ? 'pyq' : 'generated';
}

/**
 * `optionsJson` is a JSON array we wrote, but a corrupt or short row must not
 * render a broken pad — `DrillQuestion.options` is documented as always being
 * `OPTION_COUNT` long, and a three-option question would leave a dead button
 * that silently commits nothing.
 */
function parseOptions(raw: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== OPTION_COUNT) return null;
    if (!parsed.every((value): value is string => typeof value === 'string')) return null;
    return parsed;
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------- writes */

export interface StartSessionInput {
  mode: SessionMode;
  /** LOCAL calendar day, from `localDate(profile.timezone)`. Fixed at start. */
  studyDate: string;
  /** Defaults to the preset's count. */
  plannedCount?: number;
  /** Which tier of the selection ladder dealt this session. */
  selectionReason?: string | null;
  startedAtIso?: string;
}

/**
 * Opens a session.
 *
 * The marking scheme is frozen INTO the row, exactly as
 * `evaluations.rubricVersion` is: a session scored under one scheme and
 * re-rendered later under another silently rewrites her history. UPSC's CSAT
 * scheme changed in 2015, so assume it can change again.
 */
export async function startSession(input: StartSessionInput): Promise<SessionFacts> {
  const preset = presetFor(input.mode);
  const plannedCount = Math.max(1, input.plannedCount ?? preset.questionCount);

  const [row] = await db
    .insert(mcqSessions)
    .values({
      mode: input.mode,
      status: 'in_progress',
      studyDate: input.studyDate,
      plannedCount,
      durationTargetSec: sessionBudgetSeconds(preset, plannedCount),
      markPerCorrect: MARKS.perCorrect,
      markPerWrong: MARKS.perWrong,
      selectionReason: input.selectionReason ?? null,
      ...(input.startedAtIso ? { startedAt: input.startedAtIso } : {}),
    })
    .returning();

  if (!row) throw new Error('Failed to open drill session');
  return toFacts(row);
}

export interface RecordAttemptInput {
  sessionId: number;
  /** Built by `commitAnswer`/`skipAnswer` — the only place `correct` is decided. */
  attempt: PendingAttempt;
  /** LOCAL calendar day. Schedules the re-drill. */
  todayIso: string;
  /** Real INSTANT, for the audit log. Defaults to now. */
  attemptedAtIso?: string;
}

export interface RecordedAttempt {
  attemptId: number;
  attempt: AttemptRecord;
  /** What the rule decided. Returned so a caller can explain the queue move. */
  redrill: RedrillWrite;
}

/**
 * Records one attempt and its re-drill consequence, atomically.
 *
 * SYNCHRONOUS — see the transaction note in this file's header. Deliberately
 * not `async`: on this driver an async callback commits before any statement
 * runs, and the two writes below are precisely the pair that must not come
 * apart.
 *
 * Ordering inside the transaction is not arbitrary. The attempt is inserted
 * first because it is the fact — she really did press that button — and the
 * queue move is its consequence. If `redrillEffect` throws (it throws on an
 * unparseable `todayIso`, and deliberately so: a substituted date would put an
 * uncomparable string in `due_at` and the question would never be due again),
 * the whole transaction rolls back and the screen surfaces an error, rather
 * than silently keeping an attempt whose consequence never landed.
 */
export function recordAttempt(input: RecordAttemptInput): RecordedAttempt {
  const { attempt } = input;
  const attemptedAt = input.attemptedAtIso ?? new Date().toISOString();

  // The `mcq_attempts_skip_not_correct` CHECK enforces this in SQLite, but a
  // constraint violation surfaces as an opaque driver error mid-drill. Failing
  // here names the actual bug.
  if (attempt.chosenIndex === null && attempt.correct) {
    throw new Error('A skipped question cannot be recorded as correct');
  }

  const outcome = outcomeOf(attempt);

  let attemptId = 0;
  let write: RedrillWrite | null = null;

  db.transaction((tx) => {
    const inserted = tx
      .insert(mcqAttempts)
      .values({
        questionId: attempt.questionId,
        chosenIndex: attempt.chosenIndex,
        correct: attempt.correct,
        timeTakenSec: attempt.timeTakenSec,
        guessed: attempt.guessed,
        sessionId: input.sessionId,
        attemptedAt,
      })
      .returning({ id: mcqAttempts.id })
      .get();

    if (!inserted) throw new Error('Failed to record attempt');
    attemptId = inserted.id;

    // The seam. Read the row, let the pure rule decide, execute what it returns.
    const current = tx
      .select()
      .from(mcqReviewQueue)
      .where(eq(mcqReviewQueue.questionId, attempt.questionId))
      .get();

    const state: Sm2State | null = current
      ? {
          repetitions: current.repetitions,
          intervalDays: current.intervalDays,
          easeFactor: current.easeFactor,
          lapses: current.lapses,
        }
      : null;

    const decided = redrillEffect(outcome, state, input.todayIso, attempt.questionId);
    write = decided;

    // A skip is not a graded recall — `mcq-redrill` never assigns it a grade —
    // so it must not stamp `lastReviewedAt` either. That column is the audit
    // clock for reviews that actually happened, and an enrolment triggered by
    // declining to answer is not one of them.
    const reviewedAt = outcome === 'skipped' ? null : attemptedAt;

    if (decided.kind === 'insert') {
      tx.insert(mcqReviewQueue)
        .values({
          questionId: decided.questionId,
          dueAt: decided.dueAt,
          intervalDays: decided.intervalDays,
          easeFactor: decided.easeFactor,
          repetitions: decided.repetitions,
          lapses: decided.lapses,
          lastReviewedAt: reviewedAt,
        })
        // UNIQUE on `question_id`. Not expected on the happy path — the read
        // above just proved there is no row — but two commits racing inside one
        // session would otherwise take the drill down with a constraint error.
        .onConflictDoNothing({ target: mcqReviewQueue.questionId })
        .run();
    } else if (decided.kind === 'update') {
      tx.update(mcqReviewQueue)
        .set({
          dueAt: decided.dueAt,
          intervalDays: decided.intervalDays,
          easeFactor: decided.easeFactor,
          repetitions: decided.repetitions,
          lapses: decided.lapses,
          ...(reviewedAt === null ? {} : { lastReviewedAt: reviewedAt }),
        })
        .where(eq(mcqReviewQueue.questionId, decided.questionId))
        .run();
    }
    // `kind === 'none'`: nothing to write. The rule's own header explains that
    // a 'none' still carries a complete, safe row precisely so that a caller
    // which ignored `kind` could not do damage; this one does not ignore it.
  });

  if (write === null) throw new Error('Attempt transaction did not run');

  return {
    attemptId,
    attempt: {
      questionId: attempt.questionId,
      chosenIndex: attempt.chosenIndex,
      correct: attempt.correct,
      guessed: attempt.guessed,
      timeTakenSec: attempt.timeTakenSec,
      attemptedAt,
    },
    redrill: write,
  };
}

/** Ends a session that reached its planned count. No-op on a closed session. */
export async function finishSession(sessionId: number, endedAtIso?: string): Promise<void> {
  await db
    .update(mcqSessions)
    .set({ status: 'completed', endedAt: endedAtIso ?? new Date().toISOString() })
    .where(and(eq(mcqSessions.id, sessionId), eq(mcqSessions.status, 'in_progress')));
}

/**
 * Closes a session she walked away from.
 *
 * The attempts are untouched and always will be: she really did answer them,
 * so they count toward lifetime accuracy and toward the re-drill queue. Only
 * the SESSION-level figure is forfeited, and `lib/mcq-score.ts` is what
 * suppresses it — a 3-of-12 session is an interrupted commute, not a 25%
 * score.
 */
export async function abandonSession(sessionId: number, endedAtIso?: string): Promise<void> {
  await db
    .update(mcqSessions)
    .set({ status: 'abandoned', endedAt: endedAtIso ?? new Date().toISOString() })
    .where(and(eq(mcqSessions.id, sessionId), eq(mcqSessions.status, 'in_progress')));
}

/**
 * Adds five more questions to a micro set. Returns the new planned count.
 *
 * Timed sets refuse: `TIMED_PRESET.maxQuestionCount === questionCount`, so
 * `canExtend` is false and this is a no-op. Extending a measured set mid-flight
 * would change the denominator of the thing being measured.
 */
export async function extendSession(sessionId: number): Promise<number> {
  const facts = await getSessionFacts(sessionId);
  if (!facts) throw new Error(`Session ${sessionId} not found`);
  if (facts.status !== 'in_progress') return facts.plannedCount;

  const preset = presetFor(facts.mode);
  const next = extendedCount(preset, facts.plannedCount);
  if (next === facts.plannedCount) return facts.plannedCount;

  await db
    .update(mcqSessions)
    .set({ plannedCount: next, durationTargetSec: sessionBudgetSeconds(preset, next) })
    .where(eq(mcqSessions.id, sessionId));

  return next;
}

/**
 * Lazy closure, run whenever a session list is built.
 *
 * There is no background job to do this — the app is not running when she
 * closes it — so `in_progress` rows are reconciled on the way past, the same
 * way `revision_queue` enrols lazily. `closureStatus` decides; this only
 * executes. Returns the number of rows closed, which is zero on a steady-state
 * open.
 *
 * `activeSessionId` exempts the session currently on screen, and it is not
 * optional in practice: every timed row is unresumable by construction, so a
 * sweep that did not exempt the live one would close the very set being taken.
 * `drill/[id].tsx` calls this on mount with its own id; any other session-list
 * builder should call it the same way.
 */
export async function closeStaleSessions(
  todayIso: string,
  activeSessionId: number | null = null,
): Promise<number> {
  const rows = await db
    .select({
      id: mcqSessions.id,
      mode: mcqSessions.mode,
      status: mcqSessions.status,
      studyDate: mcqSessions.studyDate,
      plannedCount: mcqSessions.plannedCount,
      answered: sql<number>`count(${mcqAttempts.id})`,
    })
    .from(mcqSessions)
    .leftJoin(mcqAttempts, eq(mcqAttempts.sessionId, mcqSessions.id))
    .where(eq(mcqSessions.status, 'in_progress'))
    .groupBy(mcqSessions.id);

  const closures: { id: number; status: SessionStatus }[] = [];
  for (const row of rows) {
    if (row.id === activeSessionId) continue;
    const lifecycle: SessionLifecycle = {
      mode: toMode(row.mode),
      status: 'in_progress',
      studyDate: row.studyDate,
      plannedCount: row.plannedCount,
      answeredCount: Number(row.answered ?? 0),
    };
    const next = closureStatus(lifecycle, todayIso);
    if (next !== 'in_progress') closures.push({ id: row.id, status: next });
  }

  if (closures.length === 0) return 0;

  const endedAt = new Date().toISOString();
  // One transaction for the sweep. Synchronous callback, `.run()` on every
  // statement — the same rule as `recordAttempt`, for the same driver reason.
  db.transaction((tx) => {
    for (const closure of closures) {
      tx.update(mcqSessions)
        .set({ status: closure.status, endedAt })
        .where(and(eq(mcqSessions.id, closure.id), eq(mcqSessions.status, 'in_progress')))
        .run();
    }
  });

  return closures.length;
}

/* ---------------------------------------------------------------- reads */

export async function getSessionFacts(sessionId: number): Promise<SessionFacts | null> {
  const [row] = await db
    .select()
    .from(mcqSessions)
    .where(eq(mcqSessions.id, sessionId))
    .limit(1);
  return row ? toFacts(row) : null;
}

/** Committed attempts, oldest first — which is also the order they were dealt. */
export async function listAttempts(sessionId: number): Promise<AttemptRecord[]> {
  const rows = await db
    .select()
    .from(mcqAttempts)
    .where(eq(mcqAttempts.sessionId, sessionId))
    .orderBy(asc(mcqAttempts.attemptedAt), asc(mcqAttempts.id));
  return rows.map(toAttempt);
}

/** The most recent micro session that can still be picked up today, if any. */
export async function findResumableSession(todayIso: string): Promise<SessionFacts | null> {
  const rows = await db
    .select()
    .from(mcqSessions)
    .where(
      and(
        eq(mcqSessions.status, 'in_progress'),
        eq(mcqSessions.mode, 'micro'),
        eq(mcqSessions.studyDate, todayIso.slice(0, 10)),
      ),
    )
    .orderBy(desc(mcqSessions.id))
    .limit(1);

  return rows[0] ? toFacts(rows[0]) : null;
}

/* ----------------------------------------------------------------- deal */

export interface DealInput {
  need: number;
  /** Questions already attempted in this session. Never deal one twice. */
  excludeQuestionIds: number[];
  preferPyq: boolean;
  /** `SessionPreset.allowUnstudiedPyq`. Threaded, never re-derived. */
  allowUnstudiedPyq: boolean;
  /** LOCAL calendar day — what "due" means for the re-drill tier. */
  todayIso: string;
}

export type QuestionDealer = (input: DealInput) => Promise<DrillQuestion[]>;

const QUESTION_FIELDS = {
  id: mcqQuestions.id,
  stem: mcqQuestions.stem,
  optionsJson: mcqQuestions.optionsJson,
  correctIndex: mcqQuestions.correctIndex,
  eliminationLogic: mcqQuestions.eliminationLogic,
  difficulty: mcqQuestions.difficulty,
  source: mcqQuestions.source,
  pyqYear: mcqQuestions.pyqYear,
  pyqPaper: mcqQuestions.pyqPaper,
  syllabusTopicId: mcqQuestions.syllabusTopicId,
  paper: syllabusTopics.paper,
  topic: syllabusTopics.topic,
  subtopic: syllabusTopics.subtopic,
} as const;

type QuestionFieldsRow = {
  [K in keyof typeof QUESTION_FIELDS]: (typeof QUESTION_FIELDS)[K]['_']['data'] | null;
};

function toDrillQuestion(
  row: QuestionFieldsRow,
  tier: SelectionTier,
  priorAttempts: number,
): DrillQuestion | null {
  if (row.id === null || row.stem === null || row.optionsJson === null) return null;
  const options = parseOptions(row.optionsJson);
  if (options === null) return null;

  const correctIndex = row.correctIndex;
  if (correctIndex === null || correctIndex < 0 || correctIndex >= OPTION_COUNT) return null;

  return {
    questionId: row.id,
    stem: row.stem,
    options,
    correctIndex,
    eliminationLogic: row.eliminationLogic,
    difficulty: toDifficulty(row.difficulty ?? 'medium'),
    source: toSource(row.source),
    pyqYear: row.pyqYear,
    pyqPaper: row.pyqPaper,
    paper: row.paper ?? '',
    sectionLabel: row.subtopic ?? row.topic,
    syllabusTopicId: row.syllabusTopicId,
    priorAttempts,
    tier,
  };
}

/** Attempts on record per question, derived rather than stored — a copy drifts. */
async function attemptCounts(questionIds: readonly number[]): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  if (questionIds.length === 0) return counts;

  const rows = await db
    .select({ questionId: mcqAttempts.questionId, n: sql<number>`count(*)` })
    .from(mcqAttempts)
    .where(inArray(mcqAttempts.questionId, [...questionIds]))
    .groupBy(mcqAttempts.questionId);

  for (const row of rows) counts.set(row.questionId, Number(row.n ?? 0));
  return counts;
}

/**
 * The deal, which is NOT implemented here.
 *
 * `lib/mcq-select.ts` owns the four-tier ladder and `db/mcq-questions.ts` owns
 * the candidate read. A second selection living in this file would be the same
 * failure as a second scoring: two code paths that agree today, diverge on the
 * tier-3 date boundary in a month, and leave nobody able to say which deal was
 * right. So this only stitches the two together and hands over.
 *
 * `targetSectionKeys` uses `scoreSection` — the bank's OWN weakness rule, not a
 * second one invented here.
 *
 * This was left empty during parallel authorship, on the correct reasoning that
 * inventing an aiming rule in this file would duplicate the one that decides
 * what a batch is FOR. The ladder degrades safely to tier 2, so the deal was
 * never wrong — only unaimed, which quietly meant the weak-first targeting the
 * whole feature is built around never actually fired. Reusing the exported pure
 * scorer wires it without a second rule existing anywhere.
 *
 * The seed is the session id, so a micro session resumed after a crash deals
 * the same remainder rather than reshuffling under her.
 */
/**
 * How many of her weakest sections tier 1 aims at.
 *
 * One would let a single bad section monopolise every deal and turn a drill
 * into a grind; all of them is the same as aiming at nothing. Four is the
 * drill-side analogue of the batch planner's 25% per-section cap.
 */
const TARGET_SECTIONS_PER_DEAL = 4;

export const dealForSession =
  (sessionId: number): QuestionDealer =>
  async (input) => {
    if (input.need <= 0) return [];

    const asOfDay = input.todayIso.slice(0, 10);
    const [candidates, snapshot] = await Promise.all([
      loadSelectionCandidates(),
      readBankSnapshot({ asOfDay }),
    ]);

    const already = new Set(input.excludeQuestionIds);

    const eligible = snapshot.sections.filter((section) => section.eligible);

    // Her weakest studied sections, by the same three signals the refill plan
    // aims with: Laplace-smoothed error rate, coverage gap, staleness. Taking a
    // handful rather than one keeps a single bad section from monopolising the
    // deal, which is the drill-side analogue of the batch's 25% per-section cap.
    const targetSectionKeys = eligible
      .map((section) => ({
        key: section.sectionKey,
        priority: scoreSection(section, { asOfDay }).priority,
      }))
      .sort((a, b) => b.priority - a.priority || a.key.localeCompare(b.key))
      .slice(0, TARGET_SECTIONS_PER_DEAL)
      .map((entry) => entry.key);

    return selectForSession({
      // Questions already answered in THIS session are removed before the
      // ladder sees them: `selectForSession` deduplicates within a deal but
      // knows nothing about the session that is already half done.
      candidates: candidates.filter((candidate) => !already.has(candidate.questionId)),
      targetSectionKeys,
      // Tiers 1 and 2 never leave the sections she has actually studied.
      // Drilling a section she has never opened destroys trust in the whole
      // feature, and `SectionDemand.eligible` is where that fact lives.
      eligibleSectionKeys: snapshot.sections
        .filter((section) => section.eligible)
        .map((section) => section.sectionKey),
      count: input.need,
      todayIso: input.todayIso,
      preferPyq: input.preferPyq,
      allowUnstudiedPyq: input.allowUnstudiedPyq,
      seed: sessionId,
    });
  };

/**
 * Hydrates questions she has already answered in this session, in the order she
 * answered them.
 *
 * A direct query rather than a filter over `loadSelectionCandidates`, and
 * deliberately so: that read excludes quarantined questions, which is right for
 * a DEAL and wrong here. She answered this one before anyone disputed it, and
 * the reveal still has to render.
 *
 * A malformed row is kept with placeholder options rather than dropped: it is
 * already answered, dropping it would shift every later index by one, and the
 * restore position is derived from these indices.
 *
 * `tier` is not persisted anywhere — it describes how a question was CHOSEN,
 * not what it is — so restored questions carry `unseen_any` and nothing reads
 * it. `priorAttempts`, which does matter, is real.
 */
async function hydrateAnswered(questionIds: readonly number[]): Promise<DrillQuestion[]> {
  if (questionIds.length === 0) return [];

  const rows = await db
    .select(QUESTION_FIELDS)
    .from(mcqQuestions)
    .leftJoin(syllabusTopics, eq(syllabusTopics.id, mcqQuestions.syllabusTopicId))
    .where(inArray(mcqQuestions.id, [...questionIds]));

  const priors = await attemptCounts(questionIds);
  const byId = new Map<number, QuestionFieldsRow>();
  for (const row of rows) if (row.id !== null) byId.set(row.id, row);

  return questionIds.map((questionId) => {
    const row = byId.get(questionId);
    // `priorAttempts` counts every attempt on record including this session's,
    // so the one she just made is subtracted to leave attempts from BEFORE.
    const prior = Math.max(0, (priors.get(questionId) ?? 1) - 1);
    const mapped = row ? toDrillQuestion(row, 'unseen_any', prior) : null;
    if (mapped) return mapped;

    return {
      questionId,
      stem: row?.stem ?? `Question ${questionId}`,
      options: Array.from({ length: OPTION_COUNT }, (_, i) => `Option ${'ABCD'[i]}`),
      correctIndex: -1,
      eliminationLogic: null,
      difficulty: 'medium' as Difficulty,
      source: 'generated' as QuestionSource,
      pyqYear: null,
      pyqPaper: null,
      paper: '',
      sectionLabel: null,
      syllabusTopicId: null,
      priorAttempts: prior,
      tier: 'unseen_any' as SelectionTier,
    } satisfies DrillQuestion;
  });
}

/* ------------------------------------------------------------------- run */

export interface DrillRun {
  facts: SessionFacts;
  preset: SessionPreset;
  /** Answered questions first, in the order she answered them, then the remainder. */
  questions: DrillQuestion[];
  attempts: AttemptRecord[];
  /** Fewer questions than planned: the bank is short and cannot fill the set. */
  shortBy: number;
}

/**
 * Everything the drill screen needs, restored from SQLite.
 *
 * The dealt questions are NOT stored — there is no session_questions table and
 * there should not be one. The position in the set is derived from the
 * committed attempts, so a crash cannot leave a cursor pointing at a question
 * that was never answered, and the un-attempted remainder is simply re-dealt.
 * The answered ones lead the list so index N is always attempt N.
 */
export async function loadRun(
  sessionId: number,
  todayIso: string,
  deal: QuestionDealer = dealForSession(sessionId),
): Promise<DrillRun | null> {
  const facts = await getSessionFacts(sessionId);
  if (!facts) return null;

  const preset = presetFor(facts.mode);
  const attempts = await listAttempts(sessionId);
  const answered = await hydrateAnswered(attempts.map((attempt) => attempt.questionId));

  const need = Math.max(0, facts.plannedCount - answered.length);
  const fresh =
    need > 0 && facts.status === 'in_progress'
      ? await deal({
          need,
          excludeQuestionIds: attempts.map((attempt) => attempt.questionId),
          preferPyq: preset.preferPyq,
          allowUnstudiedPyq: preset.allowUnstudiedPyq,
          todayIso,
        })
      : [];

  const questions = [...answered, ...fresh];

  return {
    facts,
    preset,
    questions,
    attempts,
    shortBy: Math.max(0, facts.plannedCount - questions.length),
  };
}
