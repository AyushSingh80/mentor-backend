/**
 * Answer and evaluation repository.
 *
 * One rule shapes most of this file: scores are stored raw (out of 10, 15, 20
 * or 125 depending on paper and length) but compared as percentages. A 6/10 and
 * a 9/15 are the same performance; plotting raw totals on one axis would draw a
 * trend line that is mostly an artefact of which paper was practised that week.
 */

import { desc, eq, inArray } from 'drizzle-orm';
import { db } from './index';
import { answers, evaluationDimensions, evaluations } from './schema';
import type { PaperValue } from '@/lib/papers';

export type AnswerRow = typeof answers.$inferSelect;
export type EvaluationRow = typeof evaluations.$inferSelect;
export type DimensionRow = typeof evaluationDimensions.$inferSelect;

/**
 * Re-exported so this repository's public surface is unchanged — every existing
 * importer keeps working. The definitions moved to `@/lib/papers` because this
 * module imports `expo-sqlite`, which cannot load under Node, and Phase 2's
 * pure modules need the paper constants in code that IS unit-testable.
 *
 * A re-export alone does not put the names in local scope, hence the separate
 * type import below for this file's own signatures.
 */
export { DIRECTIVES, PAPERS, paperLabel, type Directive, type PaperValue } from '@/lib/papers';

export interface NewAnswer {
  paper: PaperValue;
  questionText: string;
  directiveWord?: string;
  wordLimit: number;
  imagePaths: string[];
  syllabusTopicId?: number | null;
}

export async function createAnswer(input: NewAnswer): Promise<number> {
  const [row] = await db
    .insert(answers)
    .values({
      paper: input.paper,
      questionText: input.questionText.trim(),
      directiveWord: input.directiveWord ?? null,
      wordLimit: input.wordLimit,
      imagePaths: JSON.stringify(input.imagePaths),
      syllabusTopicId: input.syllabusTopicId ?? null,
      syncStatus: 'pending',
    })
    .returning({ id: answers.id });

  if (!row) throw new Error('Failed to create answer');
  return row.id;
}

export async function setSyncStatus(
  answerId: number,
  status: 'pending' | 'queued' | 'evaluated' | 'failed',
): Promise<void> {
  await db.update(answers).set({ syncStatus: status }).where(eq(answers.id, answerId));
}

export interface EvaluationInput {
  answerId: number;
  model: string;
  rubricVersion: string;
  total: number;
  max: number;
  dimensions: { name: string; score: number; max: number; comment?: string }[];
  directiveWord?: string | null;
  directiveCompliance?: boolean | null;
  feedbackMd: string;
  modelSkeletonMd?: string | null;
  highestLeverageFix?: string | null;
  legibility?: string | null;
  wordLimitRespected?: boolean | null;
  confidence?: string | null;
}

/**
 * Writes the evaluation, its dimensions, and the answer's status as one unit.
 * A partial write here would show an answer as evaluated with no score, which
 * is worse than showing it as still pending.
 */
export async function saveEvaluation(input: EvaluationInput): Promise<number> {
  let evaluationId = 0;

  // SYNCHRONOUS callback with `.run()`/`.get()` on every statement — see the
  // note in `profile.ts`. An `async` callback on this driver commits before any
  // statement executes, which here would have allowed an evaluation row to
  // exist with none of its dimensions, or an answer marked `evaluated` with no
  // evaluation at all.
  db.transaction((tx) => {
    const row = tx
      .insert(evaluations)
      .values({
        answerId: input.answerId,
        model: input.model,
        rubricVersion: input.rubricVersion,
        total: input.total,
        max: input.max,
        directiveWord: input.directiveWord ?? null,
        directiveCompliance: input.directiveCompliance ?? null,
        feedbackMd: input.feedbackMd,
        modelSkeletonMd: input.modelSkeletonMd ?? null,
        highestLeverageFix: input.highestLeverageFix ?? null,
        legibility: input.legibility ?? null,
        wordLimitRespected: input.wordLimitRespected ?? null,
        confidence: input.confidence ?? null,
      })
      .returning({ id: evaluations.id })
      .get();

    if (!row) throw new Error('Failed to save evaluation');
    evaluationId = row.id;

    if (input.dimensions.length > 0) {
      tx.insert(evaluationDimensions)
        .values(
          input.dimensions.map((d) => ({
            evaluationId: row.id,
            name: d.name,
            score: d.score,
            max: d.max,
            comment: d.comment ?? null,
          })),
        )
        .run();
    }

    tx.update(answers)
      .set({ syncStatus: 'evaluated' })
      .where(eq(answers.id, input.answerId))
      .run();
  });

  return evaluationId;
}

export interface AnswerSummary {
  answer: AnswerRow;
  evaluation: EvaluationRow | null;
  /** 0–100, comparable across papers and word limits. */
  percent: number | null;
}

function toPercent(evaluation: EvaluationRow | null): number | null {
  if (!evaluation || evaluation.max <= 0) return null;
  return (evaluation.total / evaluation.max) * 100;
}

export async function listAnswers(limit = 100): Promise<AnswerSummary[]> {
  const rows = await db
    .select()
    .from(answers)
    .orderBy(desc(answers.createdAt), desc(answers.id))
    .limit(limit);

  if (rows.length === 0) return [];

  // One query for all evaluations rather than N per row.
  const evalRows = await db
    .select()
    .from(evaluations)
    .where(
      inArray(
        evaluations.answerId,
        rows.map((r) => r.id),
      ),
    );

  const byAnswer = new Map<number, EvaluationRow>();
  for (const e of evalRows) {
    // Keep the newest evaluation if an answer was ever re-evaluated.
    const existing = byAnswer.get(e.answerId);
    if (!existing || e.createdAt > existing.createdAt) byAnswer.set(e.answerId, e);
  }

  return rows.map((answer) => {
    const evaluation = byAnswer.get(answer.id) ?? null;
    return { answer, evaluation, percent: toPercent(evaluation) };
  });
}

export interface AnswerDetail extends AnswerSummary {
  dimensions: DimensionRow[];
}

export async function getAnswerDetail(answerId: number): Promise<AnswerDetail | null> {
  const [answer] = await db.select().from(answers).where(eq(answers.id, answerId)).limit(1);
  if (!answer) return null;

  const evalRows = await db
    .select()
    .from(evaluations)
    .where(eq(evaluations.answerId, answerId))
    .orderBy(desc(evaluations.createdAt), desc(evaluations.id))
    .limit(1);

  const evaluation = evalRows[0] ?? null;
  const dimensions = evaluation
    ? await db
        .select()
        .from(evaluationDimensions)
        .where(eq(evaluationDimensions.evaluationId, evaluation.id))
    : [];

  return { answer, evaluation, percent: toPercent(evaluation), dimensions };
}

export interface TrendPoint {
  date: string;
  percent: number;
  paper: string;
}

/** Chronological score history, normalised so papers are comparable. */
export async function scoreTrend(paper?: PaperValue): Promise<TrendPoint[]> {
  const summaries = await listAnswers(500);
  return summaries
    .filter((s) => s.percent !== null && (!paper || s.answer.paper === paper))
    .map((s) => ({
      date: s.answer.createdAt.slice(0, 10),
      percent: s.percent!,
      paper: s.answer.paper,
    }))
    .reverse(); // listAnswers is newest-first; a trend reads oldest-first.
}

export interface DimensionAverage {
  name: string;
  averagePercent: number;
  count: number;
}

/**
 * Weakest rubric dimensions across recent evaluations.
 *
 * This is the question the normalised dimensions table exists to answer, and
 * the one a mentor should lead with: not "how did I do" but "what specifically
 * keeps costing me marks".
 */
export async function weakestDimensions(sampleSize = 20): Promise<DimensionAverage[]> {
  const recent = await db
    .select()
    .from(evaluations)
    .orderBy(desc(evaluations.createdAt), desc(evaluations.id))
    .limit(sampleSize);

  if (recent.length === 0) return [];

  const dims = await db
    .select()
    .from(evaluationDimensions)
    .where(
      inArray(
        evaluationDimensions.evaluationId,
        recent.map((e) => e.id),
      ),
    );

  const totals = new Map<string, { sum: number; count: number }>();
  for (const d of dims) {
    if (d.max <= 0) continue;
    const bucket = totals.get(d.name) ?? { sum: 0, count: 0 };
    bucket.sum += (d.score / d.max) * 100;
    bucket.count += 1;
    totals.set(d.name, bucket);
  }

  return [...totals.entries()]
    .map(([name, v]) => ({ name, averagePercent: v.sum / v.count, count: v.count }))
    .sort((a, b) => a.averagePercent - b.averagePercent);
}

/** Answers captured but never successfully evaluated — the offline queue. */
export async function pendingAnswers(): Promise<AnswerRow[]> {
  return db
    .select()
    .from(answers)
    .where(inArray(answers.syncStatus, ['pending', 'queued', 'failed']))
    .orderBy(desc(answers.createdAt));
}
