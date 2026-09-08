/**
 * MCQ question repository — selection reads, the quarantine predicate, and the
 * dispute transaction.
 *
 * Thin on purpose, like every repository here. The ladder itself is
 * `lib/mcq-select.ts` and the SM-2 rule is `lib/mcq-redrill.ts`, both pure and
 * therefore actually unit-testable; anything importing `db/index`
 * transitively imports `expo-sqlite` and cannot run under Node, so logic
 * placed in this file is logic that can never be tested. What is left here is
 * three reads and two writes.
 *
 * ## THE HARD BOUNDARY
 *
 * Phase 3 writes NOTHING in Phase 2. This file touches `mcq_questions`,
 * `mcq_attempts` and `mcq_review_queue` and nothing else — never
 * `revision_queue`, `revision_reviews`, `flashcards` or
 * `syllabus_topics.confidence`. The syllabus link is READ-ONLY:
 * `mcqWeakTopics()` renders it and writes nothing. See the header of
 * `lib/mcq-redrill.ts` for why a wrong MCQ must never grade its topic.
 *
 * ## Trust — why the dispute path exists at all
 *
 * An AI-generated key that is wrong does not merely fail to teach. Spaced
 * repetition takes the falsehood and drills it to mastery, and the better the
 * scheduling works the more thoroughly the wrong fact is learned. So one tap
 * on the reveal has to be able to stop it dead, offline, with no signal and no
 * server verdict — and everything that tap must undo has to be undone
 * together or not at all.
 *
 * ## `db.transaction` on this driver is "sync"
 *
 * `drizzle-orm/expo-sqlite` calls `transaction(tx)` WITHOUT awaiting and runs
 * COMMIT on the next line. An `async` callback returns a pending promise
 * immediately, so COMMIT fires before any statement inside has executed and
 * every statement runs as an independent autocommit — no atomicity, and no
 * rollback either, since an async function cannot throw synchronously for the
 * driver's `catch` to see. **Synchronous callback, `.run()`/`.get()` on every
 * statement.** The outer function is `async` only so callers can `await` it
 * the way they await every other repository call; nothing inside the callback
 * is.
 */

import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';

import { db } from './index';
import { mcqAttempts, mcqQuestions, mcqReviewQueue, syllabusTopics } from './schema';
import { paperLabel } from '@/lib/papers';
import type { SelectionCandidate } from '@/lib/mcq-select';
import type { Difficulty, DisputeReason, DisputeVerdict, QuestionSource } from '@/lib/mcq-types';
import { OPTION_COUNT } from '@/lib/mcq-types';

export type McqQuestionRow = typeof mcqQuestions.$inferSelect;

/* -------------------------------------------------------------- quarantine */

/**
 * `QUARANTINE_RULE`, as a drizzle predicate: `disputedAt IS NOT NULL AND
 * disputeResolvedAt IS NULL`.
 *
 * A quarantined question must appear in NO selection tier and in NO inventory
 * count. The rule is stated once in `mcq-types.ts` and implemented separately
 * by each repository that needs it — pinned by an integration test rather than
 * shared as a query builder across ownership boundaries, so a change to one
 * owner's query cannot silently redefine another owner's.
 */
export function isQuarantined() {
  return and(isNotNull(mcqQuestions.disputedAt), isNull(mcqQuestions.disputeResolvedAt));
}

/**
 * The negation, spelled out rather than wrapped in `not()`.
 *
 * `NOT (A IS NOT NULL AND B IS NULL)` is `A IS NULL OR B IS NOT NULL`, and
 * SQL's three-valued logic makes getting this wrong easy and silent: a
 * question with no dispute at all has `disputedAt IS NULL`, and any predicate
 * that compares it with `<>` instead of `IS` drops it from the bank entirely.
 */
export function isNotQuarantined() {
  return or(isNull(mcqQuestions.disputedAt), isNotNull(mcqQuestions.disputeResolvedAt));
}

/* ----------------------------------------------------------------- mapping */

const DIFFICULTIES: readonly string[] = ['easy', 'medium', 'hard'];

/**
 * `difficulty` is free text in the schema, so a value the app does not know is
 * possible in principle. Falling back to `medium` keeps the column total — an
 * unrecognised difficulty must never become a fourth bucket no screen renders.
 */
function toDifficulty(raw: string): Difficulty {
  return DIFFICULTIES.includes(raw) ? (raw as Difficulty) : 'medium';
}

/** `source` is nullable. Anything that is not explicitly a past question is generated. */
function toSource(raw: string | null): QuestionSource {
  return raw === 'pyq' ? 'pyq' : 'generated';
}

/**
 * `options_json` is free text written from a model response.
 *
 * Returns `[]` on anything that is not exactly `OPTION_COUNT` non-empty
 * strings, which `selectForSession` then drops. The rejection lives in the
 * pure module rather than here so it is unit-tested; this only has to avoid
 * throwing, because a single malformed row must cost one question and not the
 * whole deal.
 */
function toOptions(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== OPTION_COUNT) return [];
    return parsed.every((option) => typeof option === 'string') ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------- reads */

/**
 * Every dealable question, with the three facts that decide its tier.
 *
 * Three queries rather than one, stitched in JS. The alternative — correlated
 * subqueries per question — is harder to read and no faster on SQLite, and
 * these three each hit an index: `mcq_attempts.question_id`,
 * `mcq_review_queue.question_id`, and the questions scan itself. The attempt
 * aggregate is the expensive one, growing to tens of thousands of rows over
 * eighteen months; it is a single grouped pass, and it runs once per deal
 * rather than once per candidate.
 *
 * Quarantined questions are excluded HERE as well as in the pure selector.
 * Belt and braces on purpose: this is the one rule where being wrong means
 * teaching a falsehood, and the cost of enforcing it twice is one SQL clause.
 *
 * Questions are NOT filtered by paper. A question whose topic was retired or
 * unset has no `sectionKey`, so tiers 1 and 2 skip it automatically — but it
 * can still be a re-drill that is due, and withholding a correction she has
 * already earned would be strictly worse than showing it.
 */
export async function loadSelectionCandidates(): Promise<SelectionCandidate[]> {
  const rows = await db
    .select({
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
    })
    .from(mcqQuestions)
    .leftJoin(syllabusTopics, eq(syllabusTopics.id, mcqQuestions.syllabusTopicId))
    .where(isNotQuarantined());

  if (rows.length === 0) return [];

  const [stats, queue] = await Promise.all([
    db
      .select({
        questionId: mcqAttempts.questionId,
        attempts: sql<number>`count(*)`,
        // `max(case when ...)` rather than a second query: SQLite compares
        // these ISO strings byte-wise, and the schema guarantees one format.
        lastCorrectAt: sql<
          string | null
        >`max(case when ${mcqAttempts.correct} = 1 then ${mcqAttempts.attemptedAt} end)`,
      })
      .from(mcqAttempts)
      .groupBy(mcqAttempts.questionId),
    db
      .select({ questionId: mcqReviewQueue.questionId, dueAt: mcqReviewQueue.dueAt })
      .from(mcqReviewQueue),
  ]);

  const attemptsById = new Map(stats.map((row) => [row.questionId, row] as const));
  const dueById = new Map(queue.map((row) => [row.questionId, row.dueAt] as const));

  return rows.map<SelectionCandidate>((row) => {
    const seen = attemptsById.get(row.id);
    return {
      questionId: row.id,
      stem: row.stem,
      options: toOptions(row.optionsJson),
      correctIndex: row.correctIndex,
      eliminationLogic: row.eliminationLogic,
      difficulty: toDifficulty(row.difficulty),
      source: toSource(row.source),
      pyqYear: row.pyqYear,
      pyqPaper: row.pyqPaper,
      paper: row.paper ?? '',
      // `${paper}:${topic}`, exactly as `coverageBySection` emits it. A
      // question with no live topic gets '', which is in no eligible set and
      // therefore never reaches tiers 1 or 2.
      sectionKey: row.paper && row.topic ? `${row.paper}:${row.topic}` : '',
      sectionLabel: row.topic ?? null,
      syllabusTopicId: row.syllabusTopicId,
      // Already excluded by the WHERE clause; stated so the pure selector's
      // own guard has an honest value to read rather than an assumed one.
      quarantined: false,
      priorAttempts: Number(seen?.attempts ?? 0),
      lastCorrectAt: seen?.lastCorrectAt ?? null,
      redrillDueAt: dueById.get(row.id) ?? null,
    };
  });
}

export interface McqWeakTopic {
  topicId: number;
  slug: string;
  paper: string;
  paperLabel: string;
  topic: string;
  subtopic: string | null;
  attempted: number;
  wrong: number;
  /** Correct ÷ attempted, as a percentage. `null` when nothing was answered. */
  accuracyPercent: number | null;
}

/**
 * The topic link, READ-ONLY — the whole of it.
 *
 * This is the one place Phase 3 and the syllabus meet, and it is a `select`.
 * The Revise screen may render "you keep missing Prelims questions on Modern
 * History" beside its own list; what it may NOT do, and what this module
 * deliberately gives it no way to do, is turn that into an SM-2 grade against
 * the topic. One missed fact is not evidence of topic-level forgetting, and
 * `revision_queue` holds exactly one interval per topic to destroy.
 *
 * Quarantined questions are excluded: a disputed key must not be able to
 * nominate a topic as weak on the strength of an answer that may itself be
 * wrong.
 */
export async function mcqWeakTopics(limit = 10): Promise<McqWeakTopic[]> {
  const rows = await db
    .select({
      topicId: syllabusTopics.id,
      slug: syllabusTopics.slug,
      paper: syllabusTopics.paper,
      topic: syllabusTopics.topic,
      subtopic: syllabusTopics.subtopic,
      attempted: sql<number>`count(*)`,
      wrong: sql<
        number
      >`sum(case when ${mcqAttempts.chosenIndex} is not null and ${mcqAttempts.correct} = 0 then 1 else 0 end)`,
      answered: sql<number>`sum(case when ${mcqAttempts.chosenIndex} is not null then 1 else 0 end)`,
      correct: sql<number>`sum(case when ${mcqAttempts.correct} = 1 then 1 else 0 end)`,
    })
    .from(mcqAttempts)
    .innerJoin(mcqQuestions, eq(mcqQuestions.id, mcqAttempts.questionId))
    .innerJoin(syllabusTopics, eq(syllabusTopics.id, mcqQuestions.syllabusTopicId))
    .where(and(isNull(syllabusTopics.retiredAt), isNotQuarantined()))
    .groupBy(syllabusTopics.id)
    // The SAME expression as `wrong` above, not a shorter one: `correct = 0`
    // alone counts skips as wrong answers, which would rank a topic she is
    // being cautious about above one she is actually getting wrong.
    .orderBy(
      desc(
        sql`sum(case when ${mcqAttempts.chosenIndex} is not null and ${mcqAttempts.correct} = 0 then 1 else 0 end)`,
      ),
    )
    .limit(limit);

  return rows.map((row) => {
    const answered = Number(row.answered ?? 0);
    return {
      topicId: row.topicId,
      slug: row.slug,
      paper: row.paper,
      paperLabel: paperLabel(row.paper),
      topic: row.topic,
      subtopic: row.subtopic,
      attempted: Number(row.attempted ?? 0),
      wrong: Number(row.wrong ?? 0),
      // Skips are excluded from the denominator: declining to answer is not a
      // wrong answer, and counting it as one would make a cautious commute
      // look like a collapse in accuracy.
      accuracyPercent: answered === 0 ? null : (Number(row.correct ?? 0) / answered) * 100,
    };
  });
}

/**
 * Attempts detached from their session by a rejected dispute — the audit trail.
 *
 * Offered so the summary screen can say "one question was withdrawn after you
 * disputed it" without its owner having to reach into this module's tables. A
 * voided attempt no longer carries a `session_id`, so it is invisible to any
 * query keyed on one; this finds it the only way left, by the question set the
 * session dealt.
 */
export async function voidedAttemptsAmong(
  questionIds: readonly number[],
): Promise<(typeof mcqAttempts.$inferSelect)[]> {
  if (questionIds.length === 0) return [];
  return db
    .select()
    .from(mcqAttempts)
    .where(and(inArray(mcqAttempts.questionId, [...questionIds]), isNull(mcqAttempts.sessionId)));
}

/* ------------------------------------------------------------------ writes */

export interface DisputeInput {
  questionId: number;
  reason: DisputeReason;
  /** Optional free text. Never required — a dispute must cost one tap. */
  note?: string | null;
  /** Real instant. Defaults to now. */
  disputedAtIso?: string;
}

export interface DisputeOutcome {
  questionId: number;
  disputedAt: string;
  reason: DisputeReason;
  /** The attempt whose marks this dispute voids, if she had already answered. */
  voidedAttemptId: number | null;
  /** True when a re-drill enrolment was cancelled. */
  redrillCancelled: boolean;
}

/**
 * Raises a dispute. FOUR things, ONE synchronous transaction.
 *
 *   1. Record `disputedAt` + `disputeReason` (+ note).
 *   2. **Quarantine** it — excluded from every selection tier and from
 *      inventory. It cannot teach the false fact twice.
 *   3. **Void the attempt's contribution to scoring.** The row stays for
 *      audit.
 *   4. **Reverse the SM-2 consequence** — delete the re-drill enrolment that
 *      wrong answer just created.
 *
 * A partial dispute — quarantined but still scored, or unscored but still
 * queued — is the exact half-state that makes the feature untrustworthy, so
 * none of these may land without the others.
 *
 * ## How 1, 2 and 3 are one statement, and why that is stronger
 *
 * All three are predicates over the same three columns. Quarantine is
 * `disputedAt IS NOT NULL AND disputeResolvedAt IS NULL`; the scoring
 * exclusion in `db/mcq-stats.ts` is the deliberately broader `disputedAt IS
 * NOT NULL AND (disputeResolvedAt IS NULL OR disputeVerdict = 'upheld')`. So
 * the single UPDATE below makes the question quarantined and its attempt
 * unscored at the same instant, and there is no interleaving in which one
 * holds and the other does not. Two separate statements could not have made
 * that promise as well; this is not a missing step.
 *
 * `scoreSession` then scores that attempt zero AND removes it from
 * `maxMarks`, keeping the row visible in `perAttempt` as `excluded`. That is
 * what "the row stays for audit" buys: a bad key must not both teach a
 * falsehood and tell her she is worse than she is, and the summary can still
 * show that a question was withdrawn rather than silently showing one fewer.
 *
 * Clearing `disputeResolvedAt` and `disputeVerdict` matters and is easy to
 * miss: re-disputing a question that was previously resolved would otherwise
 * leave `disputeResolvedAt` set, the quarantine predicate false, and the
 * question back in circulation the moment she flagged it a second time.
 */
export async function disputeQuestion(input: DisputeInput): Promise<DisputeOutcome> {
  const disputedAt = input.disputedAtIso ?? new Date().toISOString();
  const note = input.note?.trim() ? input.note.trim() : null;

  // SYNCHRONOUS callback, `.run()`/`.get()` on every statement. See the header.
  return db.transaction((tx) => {
    const question = tx
      .select({ id: mcqQuestions.id })
      .from(mcqQuestions)
      .where(eq(mcqQuestions.id, input.questionId))
      .get();

    // Throwing rolls the whole transaction back, so a dispute against a
    // question that does not exist leaves nothing behind.
    if (!question) throw new Error(`No MCQ question ${input.questionId} to dispute`);

    // 1 + 2 + 3.
    tx.update(mcqQuestions)
      .set({
        disputedAt,
        disputeReason: input.reason,
        disputeNote: note,
        disputeResolvedAt: null,
        disputeVerdict: null,
      })
      .where(eq(mcqQuestions.id, input.questionId))
      .run();

    // The attempt this dispute voids, named in the result so the screen can
    // say so immediately rather than waiting for a re-score.
    const attempt = tx
      .select({ id: mcqAttempts.id })
      .from(mcqAttempts)
      .where(
        and(eq(mcqAttempts.questionId, input.questionId), lte(mcqAttempts.attemptedAt, disputedAt)),
      )
      .orderBy(desc(mcqAttempts.attemptedAt), desc(mcqAttempts.id))
      .limit(1)
      .get();

    // 4. Reverse the SM-2 consequence.
    //
    // Unconditional, and it removes an older enrolment too. Every interval on
    // that row was computed from grades applied against a key she believes is
    // wrong, so there is nothing in it worth keeping — and a quarantined
    // question must not sit in a queue waiting to be dealt the moment the
    // dispute is resolved. `mcq_review_queue` has a UNIQUE index on
    // `question_id`, so this deletes at most one row.
    const removed = tx
      .delete(mcqReviewQueue)
      .where(eq(mcqReviewQueue.questionId, input.questionId))
      .run();

    return {
      questionId: input.questionId,
      disputedAt,
      reason: input.reason,
      voidedAttemptId: attempt?.id ?? null,
      redrillCancelled: removed.changes > 0,
    };
  });
}

export interface ResolveDisputeInput {
  questionId: number;
  verdict: DisputeVerdict;
  /** `upheld` only: the corrected key. Omitted when the fix is not to the key. */
  correctedIndex?: number;
  /** `upheld` only. Must be exactly `OPTION_COUNT` options if given. */
  correctedOptions?: string[];
  correctedStem?: string;
  correctedEliminationLogic?: string | null;
  /** The explanation she is owed, above all on a rejection. */
  note?: string | null;
  resolvedAtIso?: string;
}

export interface DisputeResolution {
  questionId: number;
  verdict: DisputeVerdict;
  resolvedAt: string;
  /** True when the answer key actually moved. */
  keyChanged: boolean;
  previousCorrectIndex: number;
  correctIndex: number;
  /** The attempt re-scored against the corrected key, if there was one. */
  rescoredAttemptId: number | null;
  /** What she chose, and whether the corrected key says it was right. */
  wasCorrect: boolean | null;
  nowCorrect: boolean | null;
  /** True when a rejection permanently detached the attempt from its session. */
  markStaysVoided: boolean;
}

/**
 * Closes a dispute. One synchronous transaction, like raising one.
 *
 * **upheld** — correct the question, un-quarantine it, and re-score her
 * attempt against the corrected key so she can SEE the outcome. The mark
 * itself stays voided: `db/mcq-stats.ts` excludes an upheld question from
 * scoring forever, deliberately and correctly, because the key really was
 * wrong. What changes is the attempt's `correct` flag, which is what every
 * question-level statistic reads — `mcqWeakTopics`, `lastCorrectAt`, and
 * therefore tier 4 of the ladder. If she picked what turns out to be the right
 * answer, she stops being counted as having got it wrong.
 *
 * **rejected** — un-quarantine with an explanation, but do NOT restore the old
 * score. Re-scoring a month-old session because a dispute was rejected
 * rewrites history: the total she saw, and possibly acted on, would silently
 * drop weeks later. The scoring exclusion in `db/mcq-stats.ts` is keyed on the
 * verdict and would hand that mark back, so the attempt is detached from its
 * session here instead — permanently, and only the one attempt the dispute was
 * about. Attempts from other sessions were only ever collateral while the key
 * was in doubt and return to scoring normally, which is right: the key was
 * fine.
 *
 * **never resolved** — stays quarantined forever, which is simply what
 * happens when neither branch is called. Losing a handful of questions from a
 * bank that is refilled on demand is trivial; showing her a wrong one again is
 * not. There is deliberately no timeout that releases a dispute unreviewed.
 */
export async function resolveDispute(input: ResolveDisputeInput): Promise<DisputeResolution> {
  const resolvedAt = input.resolvedAtIso ?? new Date().toISOString();
  const note = input.note?.trim() ? input.note.trim() : null;

  return db.transaction((tx) => {
    const question = tx
      .select({
        id: mcqQuestions.id,
        correctIndex: mcqQuestions.correctIndex,
        disputedAt: mcqQuestions.disputedAt,
        disputeNote: mcqQuestions.disputeNote,
      })
      .from(mcqQuestions)
      .where(eq(mcqQuestions.id, input.questionId))
      .get();

    if (!question) throw new Error(`No MCQ question ${input.questionId} to resolve`);
    if (!question.disputedAt) throw new Error(`MCQ question ${input.questionId} is not disputed`);

    const upheld = input.verdict === 'upheld';

    // Validated before anything is written. A corrected key outside the option
    // range would make every answer wrong forever — strictly worse than the
    // disputed key it replaces.
    const correctedIndex = upheld ? input.correctedIndex : undefined;
    if (
      correctedIndex !== undefined &&
      (!Number.isInteger(correctedIndex) || correctedIndex < 0 || correctedIndex >= OPTION_COUNT)
    ) {
      throw new Error(`Corrected key ${correctedIndex} is not one of the ${OPTION_COUNT} options`);
    }
    if (input.correctedOptions && input.correctedOptions.length !== OPTION_COUNT) {
      throw new Error(`A question needs exactly ${OPTION_COUNT} options`);
    }

    const nextIndex = correctedIndex ?? question.correctIndex;
    const keyChanged = nextIndex !== question.correctIndex;

    tx.update(mcqQuestions)
      .set({
        disputeResolvedAt: resolvedAt,
        disputeVerdict: input.verdict,
        // Appended rather than replaced: her reason for disputing and the
        // reviewer's reason for the verdict are both worth keeping, and the
        // rejection is the one she is owed an explanation for.
        disputeNote: note
          ? question.disputeNote
            ? `${question.disputeNote}\n\n${input.verdict}: ${note}`
            : `${input.verdict}: ${note}`
          : question.disputeNote,
        ...(upheld
          ? {
              correctIndex: nextIndex,
              ...(input.correctedOptions
                ? { optionsJson: JSON.stringify(input.correctedOptions) }
                : {}),
              ...(input.correctedStem ? { stem: input.correctedStem } : {}),
              ...(input.correctedEliminationLogic !== undefined
                ? { eliminationLogic: input.correctedEliminationLogic }
                : {}),
            }
          : {}),
      })
      .where(eq(mcqQuestions.id, input.questionId))
      .run();

    // The attempt the dispute was about: the last one made at or before it was
    // raised. Recovered rather than stored — `disputedAt` is on the row, so
    // this is exact and needs no column the frozen schema does not have.
    const attempt = tx
      .select({
        id: mcqAttempts.id,
        chosenIndex: mcqAttempts.chosenIndex,
        correct: mcqAttempts.correct,
        sessionId: mcqAttempts.sessionId,
      })
      .from(mcqAttempts)
      .where(
        and(
          eq(mcqAttempts.questionId, input.questionId),
          lte(mcqAttempts.attemptedAt, question.disputedAt),
        ),
      )
      .orderBy(desc(mcqAttempts.attemptedAt), desc(mcqAttempts.id))
      .limit(1)
      .get();

    let nowCorrect: boolean | null = null;
    let markStaysVoided = false;

    if (attempt) {
      if (upheld) {
        // Re-score against the corrected key. A skip stays a skip: she
        // declined to answer, and no correction can turn that into a recall.
        nowCorrect = attempt.chosenIndex === null ? false : attempt.chosenIndex === nextIndex;
        if (nowCorrect !== attempt.correct) {
          tx.update(mcqAttempts)
            .set({ correct: nowCorrect })
            .where(eq(mcqAttempts.id, attempt.id))
            .run();
        }
      } else if (attempt.sessionId !== null) {
        // Rejected. Keep the mark voided by detaching the attempt from its
        // session; every field describing what she actually did survives.
        tx.update(mcqAttempts).set({ sessionId: null }).where(eq(mcqAttempts.id, attempt.id)).run();
        markStaysVoided = true;
      }
    }

    return {
      questionId: input.questionId,
      verdict: input.verdict,
      resolvedAt,
      keyChanged,
      previousCorrectIndex: question.correctIndex,
      correctIndex: nextIndex,
      rescoredAttemptId: attempt?.id ?? null,
      wasCorrect: attempt?.correct ?? null,
      nowCorrect,
      markStaysVoided,
    };
  });
}

/** Disputed and unresolved — the quarantine list, for a review screen. */
export async function quarantinedQuestions(): Promise<McqQuestionRow[]> {
  return db
    .select()
    .from(mcqQuestions)
    .where(isQuarantined())
    .orderBy(asc(mcqQuestions.disputedAt), asc(mcqQuestions.id));
}
