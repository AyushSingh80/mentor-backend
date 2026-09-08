/**
 * Drill rows: banking prompts, writing parts, storing a mark sheet.
 *
 * ## Rule one: every transaction callback is SYNCHRONOUS
 *
 * `db.transaction` on the expo-sqlite driver is `"sync"` kind. An `async`
 * callback commits BEFORE any statement inside it has run, so the transaction
 * becomes decorative and each statement autocommits on its own. That defect was
 * found at all five pre-existing call sites in Phase 2 and is why every callback
 * below is synchronous with `.run()` / `.get()` / `.all()`.
 *
 * It matters most in `saveEvaluation`. A mark sheet is one fact: scores written
 * without the drill's own total is a screen showing per-part marks that do not
 * add up to the header, and there is no way for her to tell which is right.
 *
 * ## Rule two: batch inserts are chunked on PARAMETERS, not rows
 *
 * SQLite caps a statement's bound parameters at 999 on older builds, and which
 * build is on the device is not knowable from here. The chunk sizes below are
 * derived from the column count rather than written by hand.
 *
 * ## Rule three: her writing is never lost to a failed evaluation
 *
 * `submitDrill` and `saveEvaluation` are separate, and separately durable. The
 * words are on disk the moment she taps submit; the marking is a network call
 * that can fail on a train, and a failure moves the row to `failed` with an
 * error to show — never back to `in_progress`, and never over her text.
 */

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import { db } from './index';
import { drillParts, drillScores, drills, syllabusTopics } from './schema';
import {
  PARTS_OF_KIND,
  isDrillKind,
  type DrillFacts,
  type DrillKind,
  type DrillPart,
  type DrillPartFacts,
  type DrillScoreFacts,
  type DrillStatus,
} from '@/lib/drill-types';

const nowIso = (): string => new Date().toISOString();

/**
 * `drill_scores` has 7 columns; 999/7 is 142, and 90 leaves clear headroom.
 *
 * `drill_parts` needs no chunk constant: a drill has at most five parts and
 * they are written one at a time as she types, never in a batch.
 */
const SCORE_CHUNK = 90;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function statusOf(value: string): DrillStatus {
  return value === 'in_progress' ||
    value === 'submitted' ||
    value === 'evaluated' ||
    value === 'failed'
    ? value
    : 'banked';
}

function kindOf(value: string): DrillKind {
  // A kind this build does not know cannot drive the part list, and an outline
  // is the conservative reading: it has fewer parts and no required detail.
  return isDrillKind(value) ? value : 'essay_outline';
}

function wordsIn(content: string): number {
  const trimmed = content.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

/* ------------------------------------------------------------------ banking */

export interface BankablePrompt {
  kind: DrillKind;
  promptText: string;
  caseDetail: string | null;
  syllabusSlug: string | null;
  batchId: string;
  promptVersion: string;
}

/**
 * Banks a batch of prompts. Returns how many rows were actually written.
 *
 * `onConflictDoNothing` on `(kind, prompt_text)`, so re-running a batch after a
 * partial failure banks the rest rather than throwing on the first one already
 * held. The count returned is the count WRITTEN, which is what the refill
 * reports — "6 prompts arrived, 2 were already banked" is a true sentence and
 * "6 banked" would not be.
 */
export async function bankPrompts(
  prompts: readonly BankablePrompt[],
  bankedOn: string,
): Promise<number> {
  if (prompts.length === 0) return 0;

  // Slugs resolved in one read rather than per row. An unresolvable slug leaves
  // `syllabusTopicId` null, which degrades filing and never blocks the prompt.
  const slugs = [...new Set(prompts.map((p) => p.syllabusSlug).filter((s): s is string => s !== null))];
  const topicIdBySlug = new Map<string, number>();
  if (slugs.length > 0) {
    const rows = await db
      .select({ id: syllabusTopics.id, slug: syllabusTopics.slug })
      .from(syllabusTopics)
      .where(and(inArray(syllabusTopics.slug, slugs), sql`${syllabusTopics.retiredAt} is null`));
    for (const row of rows) topicIdBySlug.set(row.slug, row.id);
  }

  const values = prompts.map((prompt) => ({
    kind: prompt.kind,
    status: 'banked' as const,
    promptText: prompt.promptText,
    // Normalised to satisfy `drills_case_detail_matches_kind`: a non-case must
    // carry null, not an empty string, or the CHECK rejects the whole insert.
    caseDetail: prompt.kind === 'ethics_case' ? prompt.caseDetail : null,
    syllabusTopicId:
      prompt.syllabusSlug === null ? null : (topicIdBySlug.get(prompt.syllabusSlug) ?? null),
    bankedOn,
    batchId: prompt.batchId,
    promptVersion: prompt.promptVersion,
  }));

  let written = 0;
  for (const batch of chunk(values, 60)) {
    const rows = await db
      .insert(drills)
      .values(batch)
      .onConflictDoNothing({ target: [drills.kind, drills.promptText] })
      .returning({ id: drills.id });
    written += rows.length;
  }
  return written;
}

/* -------------------------------------------------------------------- reads */

const DRILL_COLUMNS = {
  id: drills.id,
  kind: drills.kind,
  status: drills.status,
  promptText: drills.promptText,
  caseDetail: drills.caseDetail,
  syllabusTopicId: drills.syllabusTopicId,
  bankedOn: drills.bankedOn,
  startedAt: drills.startedAt,
  submittedAt: drills.submittedAt,
  minutesSpent: drills.minutesSpent,
  total: drills.total,
  max: drills.max,
  feedbackMd: drills.feedbackMd,
} as const;

function toFacts(
  row: {
    id: number;
    kind: string;
    status: string;
    promptText: string;
    caseDetail: string | null;
    syllabusTopicId: number | null;
    bankedOn: string;
    startedAt: string | null;
    submittedAt: string | null;
    minutesSpent: number | null;
    total: number | null;
    max: number | null;
    feedbackMd: string | null;
  },
  parts: readonly DrillPartFacts[],
  scores: readonly DrillScoreFacts[],
): DrillFacts {
  return {
    id: row.id,
    kind: kindOf(row.kind),
    status: statusOf(row.status),
    promptText: row.promptText,
    caseDetail: row.caseDetail,
    syllabusTopicId: row.syllabusTopicId,
    bankedOn: row.bankedOn,
    startedAt: row.startedAt,
    submittedAt: row.submittedAt,
    minutesSpent: row.minutesSpent,
    parts,
    scores,
    total: row.total,
    max: row.max,
    feedbackMd: row.feedbackMd,
  };
}

/** One drill in full, with its parts and any mark sheet. */
export async function readDrill(id: number): Promise<DrillFacts | null> {
  const [row] = await db.select(DRILL_COLUMNS).from(drills).where(eq(drills.id, id)).limit(1);
  if (row === undefined) return null;

  const [partRows, scoreRows] = await Promise.all([
    db
      .select({ part: drillParts.part, content: drillParts.content, ordinal: drillParts.ordinal })
      .from(drillParts)
      .where(eq(drillParts.drillId, id))
      .orderBy(asc(drillParts.ordinal)),
    db
      .select({
        part: drillScores.part,
        score: drillScores.score,
        max: drillScores.max,
        comment: drillScores.comment,
      })
      .from(drillScores)
      .where(eq(drillScores.drillId, id)),
  ]);

  const kind = kindOf(row.kind);
  const order = PARTS_OF_KIND[kind];
  const rank = (part: string): number => {
    const index = (order as readonly string[]).indexOf(part);
    // A part this build does not know sorts last rather than first, so an
    // unrecognised row can never displace the thesis at the top of the screen.
    return index === -1 ? order.length : index;
  };

  const parts: DrillPartFacts[] = partRows
    .map((part) => ({
      part: part.part as DrillPart,
      content: part.content,
      words: wordsIn(part.content),
    }))
    .sort((a, b) => rank(a.part) - rank(b.part));

  const scores: DrillScoreFacts[] = scoreRows
    .map((score) => ({
      part: score.part as DrillPart,
      score: score.score,
      max: score.max,
      comment: score.comment,
    }))
    .sort((a, b) => rank(a.part) - rank(b.part));

  return toFacts(row, parts, scores);
}

/**
 * The next prompt to drill of a kind, or null.
 *
 * A started-but-unfinished drill wins over a fresh one, and that is the whole
 * ordering rule: finishing what is open beats starting something new, and an
 * app that hands her a new topic while yesterday's outline sits half-written is
 * how a bank fills with abandoned drafts.
 */
export async function nextDrill(kind: DrillKind): Promise<DrillFacts | null> {
  const [resumable] = await db
    .select({ id: drills.id })
    .from(drills)
    .where(and(eq(drills.kind, kind), eq(drills.status, 'in_progress')))
    .orderBy(asc(drills.startedAt))
    .limit(1);
  if (resumable !== undefined) return readDrill(resumable.id);

  const [banked] = await db
    .select({ id: drills.id })
    .from(drills)
    .where(and(eq(drills.kind, kind), eq(drills.status, 'banked')))
    .orderBy(asc(drills.id))
    .limit(1);
  return banked === undefined ? null : readDrill(banked.id);
}

/** Counts per kind, for the bank status. */
export async function readBankCounts(): Promise<
  { kind: DrillKind; banked: number; inProgress: number }[]
> {
  const rows = await db
    .select({ kind: drills.kind, status: drills.status, n: sql<number>`count(*)` })
    .from(drills)
    .where(inArray(drills.status, ['banked', 'in_progress']))
    .groupBy(drills.kind, drills.status);

  const byKind = new Map<DrillKind, { banked: number; inProgress: number }>();
  for (const row of rows) {
    const kind = kindOf(row.kind);
    const entry = byKind.get(kind) ?? { banked: 0, inProgress: 0 };
    if (row.status === 'banked') entry.banked = Number(row.n) || 0;
    else entry.inProgress = Number(row.n) || 0;
    byKind.set(kind, entry);
  }

  return [...byKind.entries()].map(([kind, counts]) => ({ kind, ...counts }));
}

/** Prompt texts already banked, sent so a batch does not restate one. */
export async function bankedPromptTexts(limit = 200): Promise<string[]> {
  const rows = await db
    .select({ promptText: drills.promptText })
    .from(drills)
    .orderBy(desc(drills.id))
    .limit(limit);
  return rows.map((row) => row.promptText);
}

/** Recent attempts, newest first, for the history list. */
export async function recentDrills(limit = 20): Promise<DrillFacts[]> {
  const rows = await db
    .select(DRILL_COLUMNS)
    .from(drills)
    .where(inArray(drills.status, ['submitted', 'evaluated', 'failed']))
    .orderBy(desc(drills.submittedAt))
    .limit(limit);
  return Promise.all(rows.map((row) => readDrill(row.id))).then((facts) =>
    facts.filter((entry): entry is DrillFacts => entry !== null),
  );
}

/* ------------------------------------------------------------------ writes */

/** Marks a banked drill as started. Idempotent — a resume must not reset the clock. */
export async function startDrill(id: number, at: string = nowIso()): Promise<void> {
  await db
    .update(drills)
    .set({ status: 'in_progress', startedAt: at })
    .where(and(eq(drills.id, id), eq(drills.status, 'banked')));
}

/**
 * Saves one part as she writes.
 *
 * Upsert on `(drill_id, part)`, so autosave is safe to call on every pause and
 * a re-edit replaces rather than duplicating. The whole point is that nothing
 * she has typed is ever more than a few seconds from disk.
 */
export async function saveDrillPart(
  drillId: number,
  part: DrillPart,
  content: string,
  kind: DrillKind,
): Promise<void> {
  const ordinal = (PARTS_OF_KIND[kind] as readonly string[]).indexOf(part);
  await db
    .insert(drillParts)
    .values({ drillId, part, content, ordinal: ordinal === -1 ? 99 : ordinal, updatedAt: nowIso() })
    .onConflictDoUpdate({
      target: [drillParts.drillId, drillParts.part],
      set: { content, updatedAt: nowIso() },
    });
}

/**
 * Commits the attempt. Her words are durable from this point regardless of
 * what the network does.
 */
export async function submitDrill(
  drillId: number,
  minutesSpent: number | null,
  at: string = nowIso(),
): Promise<void> {
  await db
    .update(drills)
    .set({ status: 'submitted', submittedAt: at, minutesSpent, error: null })
    .where(eq(drills.id, drillId));
}

export interface DrillEvaluationInput {
  verdicts: readonly { part: DrillPart; score: number; max: number; comment: string }[];
  total: number;
  max: number;
  feedbackMd: string;
  highestLeverageFix: string;
  rubricVersion: string;
  model: string;
}

/**
 * Writes a mark sheet.
 *
 * ONE transaction, synchronous callback. The scores and the drill's own total
 * are a single fact: per-part marks written without the header total is a screen
 * whose parts do not add up to its heading, and nothing on it tells her which
 * number to trust.
 *
 * Old scores are deleted first, so a re-evaluation replaces rather than
 * colliding with the unique index — and it never touches `drill_parts`, which
 * is why they are separate tables.
 */
export async function saveEvaluation(
  drillId: number,
  input: DrillEvaluationInput,
): Promise<void> {
  const at = nowIso();

  await db.transaction((tx) => {
    tx.delete(drillScores).where(eq(drillScores.drillId, drillId)).run();

    for (const batch of chunk(input.verdicts, SCORE_CHUNK)) {
      tx.insert(drillScores)
        .values(
          batch.map((verdict) => ({
            drillId,
            part: verdict.part,
            score: verdict.score,
            max: verdict.max,
            comment: verdict.comment,
            createdAt: at,
          })),
        )
        .run();
    }

    tx.update(drills)
      .set({
        status: 'evaluated',
        total: input.total,
        max: input.max,
        feedbackMd: input.feedbackMd,
        highestLeverageFix: input.highestLeverageFix,
        rubricVersion: input.rubricVersion,
        model: input.model,
        error: null,
      })
      .where(eq(drills.id, drillId))
      .run();
  });
}

/**
 * Records a failed evaluation.
 *
 * Leaves the status at `failed` rather than reverting to `in_progress`: her
 * writing is finished and must not be presented as a draft again, and the retry
 * belongs on the mark sheet screen where the error can be read.
 */
export async function failEvaluation(drillId: number, error: string): Promise<void> {
  await db.update(drills).set({ status: 'failed', error }).where(eq(drills.id, drillId));
}

/** Sibling topic ids in the same section, for material suggestions. */
export async function siblingTopicIds(topicId: number | null): Promise<number[]> {
  if (topicId === null) return [];
  const [row] = await db
    .select({ paper: syllabusTopics.paper, topic: syllabusTopics.topic })
    .from(syllabusTopics)
    .where(eq(syllabusTopics.id, topicId))
    .limit(1);
  if (row === undefined) return [];

  const rows = await db
    .select({ id: syllabusTopics.id })
    .from(syllabusTopics)
    .where(and(eq(syllabusTopics.paper, row.paper), eq(syllabusTopics.topic, row.topic)));
  return rows.map((entry) => entry.id);
}
