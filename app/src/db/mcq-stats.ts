/**
 * MCQ statistics repository. READS ONLY.
 *
 * This module writes NOTHING — no insert, no update, no delete, no transaction,
 * anywhere. It is the reporting half of the Prelims feature and it shares its
 * tables with three other agents' repositories; a write from here would be a
 * write those owners cannot see, cannot order against their own, and cannot
 * test. Every function below is a `select`. If a future change to this file
 * needs to persist something, it belongs in the owning repository instead.
 *
 * Thin on purpose, like every repository here: all the arithmetic lives in
 * `lib/mcq-score.ts`, which is pure and therefore actually unit-testable.
 * Anything importing `db/index` transitively imports `expo-sqlite`, which
 * cannot load under Node, so logic placed in this file is logic that can never
 * be tested. What is left here is four queries and some row mapping.
 */

import { and, asc, desc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';

import { db } from './index';
import { mcqAttempts, mcqQuestions, mcqSessions } from './schema';
import {
  calibration,
  netMarksTrend,
  scoreSession,
  type Calibration,
  type NetMarksPoint,
  type SessionScore,
} from '@/lib/mcq-score';
import type {
  AttemptRecord,
  SessionFacts,
  SessionMode,
  SessionStatus,
} from '@/lib/mcq-types';

type AttemptRow = typeof mcqAttempts.$inferSelect;
type SessionRow = typeof mcqSessions.$inferSelect;

/**
 * How many ids go into one `IN (...)` list.
 *
 * A 25-question timed set over sixty sessions is 1500 bound parameters in a
 * single statement. SQLite's limit is high on current builds and was 999 on
 * older ones; chunking costs one extra round trip on a local file and removes
 * the class of failure entirely.
 */
const ID_CHUNK = 400;

/** Sessions the marks trend looks back over. Roughly three months of daily drills. */
const TREND_SESSIONS = 60;

/** Attempts the lifetime calibration reads. Well past the 40 the trust check needs. */
const CALIBRATION_ATTEMPTS = 2000;

function chunk<T>(items: readonly T[], size = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/* -------------------------------------------------------------- mapping */

function toMode(raw: string): SessionMode {
  return raw === 'timed' ? 'timed' : 'micro';
}

/** Anything unrecognised is treated as still running, never as a finished score. */
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
 * `timeTakenSec` is nullable in the schema and advisory everywhere — it may
 * never influence scoring or selection — so a missing duration becomes 0 rather
 * than propagating a null into arithmetic that would silently produce NaN
 * marks.
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

/* -------------------------------------------------------------- queries */

/**
 * Question ids whose KEY is in doubt, among the ids given.
 *
 * Deliberately BROADER than `QUARANTINE_RULE`. Quarantine answers "may this
 * question be dealt again?" and ends when the dispute is resolved either way.
 * This answers "may this attempt be scored?", and a dispute resolved as
 * `upheld` means the key really was wrong — the attempt must stay unscored
 * forever, not become scoreable again the moment the dispute is closed. A
 * `rejected` dispute means the key was fine and the attempt scores normally.
 */
async function disputedAmong(questionIds: readonly number[]): Promise<number[]> {
  if (questionIds.length === 0) return [];

  const found: number[] = [];
  for (const ids of chunk(questionIds)) {
    const rows = await db
      .select({ id: mcqQuestions.id })
      .from(mcqQuestions)
      .where(
        and(
          inArray(mcqQuestions.id, ids),
          isNotNull(mcqQuestions.disputedAt),
          or(
            isNull(mcqQuestions.disputeResolvedAt),
            eq(mcqQuestions.disputeVerdict, 'upheld'),
          ),
        ),
      );
    for (const row of rows) found.push(row.id);
  }
  return found;
}

/**
 * How many times each question had been attempted BEFORE this session touched
 * it.
 *
 * Derived, never stored — a stored copy drifts, and this is cheap. "Before" is
 * measured against the instant of this session's own attempt on that question
 * and excludes this session's rows, so re-answering the same question twice
 * inside one set cannot inflate its own prior count.
 */
async function priorAttemptCounts(
  sessionId: number,
  attempts: readonly AttemptRow[],
): Promise<Map<number, number>> {
  const questionIds = [...new Set(attempts.map((a) => a.questionId))];
  const priors = new Map<number, number>();
  if (questionIds.length === 0) return priors;

  const history: AttemptRow[] = [];
  for (const ids of chunk(questionIds)) {
    const rows = await db.select().from(mcqAttempts).where(inArray(mcqAttempts.questionId, ids));
    history.push(...rows);
  }

  // Earliest attempt on each question within THIS session is the cut-off.
  const cutoff = new Map<number, string>();
  for (const row of attempts) {
    const current = cutoff.get(row.questionId);
    if (current === undefined || row.attemptedAt < current) {
      cutoff.set(row.questionId, row.attemptedAt);
    }
  }

  for (const row of history) {
    if (row.sessionId === sessionId) continue;
    const before = cutoff.get(row.questionId);
    if (before === undefined || row.attemptedAt >= before) continue;
    priors.set(row.questionId, (priors.get(row.questionId) ?? 0) + 1);
  }

  return priors;
}

/* --------------------------------------------------------------- public */

export interface SessionScoreInputs {
  session: SessionFacts;
  attempts: AttemptRecord[];
  disputedQuestionIds: number[];
  priorAttemptsByQuestion: Map<number, number>;
}

/** Everything `scoreSession` needs, or `null` when there is no such session. */
export async function getSessionScoreInputs(
  sessionId: number,
): Promise<SessionScoreInputs | null> {
  const [row] = await db.select().from(mcqSessions).where(eq(mcqSessions.id, sessionId)).limit(1);
  if (!row) return null;

  const attemptRows = await db
    .select()
    .from(mcqAttempts)
    .where(eq(mcqAttempts.sessionId, sessionId))
    .orderBy(asc(mcqAttempts.attemptedAt), asc(mcqAttempts.id));

  const [disputedQuestionIds, priorAttemptsByQuestion] = await Promise.all([
    disputedAmong(attemptRows.map((a) => a.questionId)),
    priorAttemptCounts(sessionId, attemptRows),
  ]);

  return {
    session: toFacts(row),
    attempts: attemptRows.map(toAttempt),
    disputedQuestionIds,
    priorAttemptsByQuestion,
  };
}

export async function getSessionScore(sessionId: number): Promise<SessionScore | null> {
  const inputs = await getSessionScoreInputs(sessionId);
  if (!inputs) return null;
  return scoreSession(
    inputs.session,
    inputs.attempts,
    inputs.disputedQuestionIds,
    inputs.priorAttemptsByQuestion,
  );
}

/**
 * Every attempt on record, newest first, capped.
 *
 * Sessions are NOT joined and status is NOT consulted: an abandoned session's
 * attempts belong in here in full. She really did answer them, and that is the
 * most expensive data this app collects.
 */
export async function lifetimeAttempts(limit = CALIBRATION_ATTEMPTS): Promise<AttemptRecord[]> {
  const rows = await db
    .select()
    .from(mcqAttempts)
    .orderBy(desc(mcqAttempts.attemptedAt), desc(mcqAttempts.id))
    .limit(limit);
  return rows.map(toAttempt);
}

export async function lifetimeCalibration(limit = CALIBRATION_ATTEMPTS): Promise<Calibration> {
  return calibration(await lifetimeAttempts(limit));
}

/**
 * The net-marks trend, oldest first.
 *
 * Only COMPLETED sessions are queried: an abandoned one is an interrupted
 * commute, not a low score, and its dip would be indistinguishable from a
 * collapse in performance.
 *
 * Prior-attempt counts are deliberately not fetched here. They change
 * `accuracy` — a remembered answer is not a known one — but they change no
 * mark, and the trend plots marks. Skipping them turns a per-session query into
 * two queries for the whole chart.
 */
export async function netMarksHistory(limit = TREND_SESSIONS): Promise<NetMarksPoint[]> {
  const sessionRows = await db
    .select()
    .from(mcqSessions)
    .where(eq(mcqSessions.status, 'completed'))
    .orderBy(desc(mcqSessions.studyDate), desc(mcqSessions.id))
    .limit(limit);

  if (sessionRows.length === 0) return [];

  const attemptRows: AttemptRow[] = [];
  for (const ids of chunk(sessionRows.map((s) => s.id))) {
    const rows = await db.select().from(mcqAttempts).where(inArray(mcqAttempts.sessionId, ids));
    attemptRows.push(...rows);
  }

  const disputed = new Set(await disputedAmong(attemptRows.map((a) => a.questionId)));

  const bySession = new Map<number, AttemptRow[]>();
  for (const row of attemptRows) {
    if (row.sessionId === null) continue;
    const bucket = bySession.get(row.sessionId);
    if (bucket) bucket.push(row);
    else bySession.set(row.sessionId, [row]);
  }

  const scores = sessionRows.map((row) => {
    const attempts = (bySession.get(row.id) ?? []).map(toAttempt);
    const ids = attempts.map((a) => a.questionId).filter((id) => disputed.has(id));
    return scoreSession(toFacts(row), attempts, ids);
  });

  return netMarksTrend(scores);
}

export interface SessionSummary {
  score: SessionScore;
  /**
   * Lifetime, not this session. One drill cannot reach the 40 attempts the
   * instrument-trust check needs, and a guess rate computed from three rows is
   * not a rate. The session's OWN counterfactuals live on `score`.
   */
  lifetime: Calibration;
  trend: NetMarksPoint[];
}

/**
 * One call for the summary screen.
 *
 * Three independent reads behind one state transition: a screen that lands in
 * four separate loading states after a twelve-minute commute drill is worse
 * than one that waits for all three local queries.
 */
export async function getSessionSummary(sessionId: number): Promise<SessionSummary | null> {
  const score = await getSessionScore(sessionId);
  if (!score) return null;

  const [lifetime, trend] = await Promise.all([lifetimeCalibration(), netMarksHistory()]);
  return { score, lifetime, trend };
}
