/**
 * The past-question importer.
 *
 * Thin by design, like every repository here: `planPyqImport` in
 * `lib/pyq-import.ts` decides everything and is pure; this module reads rows,
 * executes the plan, and holds the three rules that are properties of SQLite
 * and of this driver rather than of the domain.
 *
 * ## Rule one: `db.transaction` here is SYNCHRONOUS
 *
 * `drizzle-orm/expo-sqlite` calls `transaction(tx)` WITHOUT awaiting it and
 * runs COMMIT on the next line. An `async` callback returns a pending promise
 * immediately, so COMMIT fires before any statement inside has executed and
 * every statement autocommits independently — no atomicity, and no rollback
 * either, because an async function cannot throw synchronously for the driver's
 * `catch` to see. **Synchronous callback, and `.run()` / `.get()` / `.all()` on
 * EVERY statement.** Drizzle builders are lazy: a missing `.run()` builds a
 * statement and discards it, the transaction commits nothing, the promise
 * resolves, and the caller is told it worked. That has already cost real data
 * in this repository — see the note on `setTopicStatus` in `db/syllabus.ts`.
 *
 * ## Rule two: batch inserts chunk on PARAMETERS, not on rows
 *
 * SQLite compiles a statement's bound parameters into one list and older builds
 * cap that list at 999. `db/syllabus.ts` chunks at a flat 100 rows because its
 * rows bind five columns each; copying that number here would bind 1,200 on a
 * question insert and fail outright. A full Prelims paper is 100 questions and
 * a twenty-year import is two thousand, so this is not a theoretical limit —
 * it is the first thing a real dataset would hit. The chunk sizes below are
 * derived from the column count, the way `db/mcq-bank.ts` derives its.
 *
 * ## Rule three: ONE TRANSACTION PER SET, not one for the whole dataset
 *
 * This is a deliberate departure from `db/syllabus.ts`, which wraps its entire
 * plan in one transaction, and it is not an oversight.
 *
 * There, a half-applied plan is real corruption: rows tombstoned whose status
 * was never carried onto their rename targets, which is precisely the
 * eighteen-months-of-self-assessment loss that module exists to prevent. Here,
 * a half-applied plan is a smaller question bank. Every set is independent —
 * 2019 Set A knows nothing about 2018 Set B — and each set's own transaction
 * still makes its key changes and their attempt re-scoring atomic, which is the
 * only coupling that actually matters. So if set eleven of twenty fails, ten
 * papers are banked, nine are not, and the next launch re-plans and completes
 * the rest. One transaction across all twenty would instead roll back the ten
 * that worked and retry the same failure forever, leaving her with nothing.
 *
 * The withdrawal sweep gets its own transaction for the same reason: the rows
 * it retires belong to no set that still exists.
 */

import { eq, isNull, ne, or } from 'drizzle-orm';

import { db } from './index';
import { drills, mcqAttempts, mcqQuestions, profile } from './schema';
import { topicIdBySlug } from './syllabus';
import { PYQ_DATASET_V1 } from '@/data/pyq/dataset';
import type { PyqDataset } from '@/data/pyq/types';
import {
  planIsEmpty,
  planPyqImport,
  rescoreAttempt,
  PYQ_IMPORT_DISPUTE_REASON,
  type ExistingGeneratedStem,
  type ExistingPyqDrill,
  type ExistingPyqMcq,
  type PyqImportPlan,
  type PyqInsert,
  type PyqQuarantine,
  type PyqRecodeKey,
  type PyqRename,
  type PyqSupersede,
  type PyqUnquarantine,
  type PyqUpdate,
} from '@/lib/pyq-import';
import { OPTION_COUNT } from '@/lib/mcq-types';

/**
 * The old SQLite ceiling on bound parameters in one statement.
 *
 * Current builds allow 32,766, but which build is on the device is not knowable
 * from here and finding out costs a crash on the launch that imports the bank.
 */
const MAX_BOUND_PARAMETERS = 999;

/** Columns bound per imported question, `created_at` included. */
const QUESTION_COLUMNS = 12;

/** Columns bound per imported drill, `created_at` included. */
const DRILL_COLUMNS = 11;

const QUESTION_CHUNK = Math.min(100, Math.floor(MAX_BOUND_PARAMETERS / QUESTION_COLUMNS));
const DRILL_CHUNK = Math.min(100, Math.floor(MAX_BOUND_PARAMETERS / DRILL_COLUMNS));

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * `options_json` is free text on a column the schema does not constrain.
 *
 * Anything that is not exactly `OPTION_COUNT` strings becomes `[]`, which then
 * differs from the dataset and produces a `recodeKey` — so a row corrupted by
 * some earlier writer heals on the next import rather than being compared
 * forever as two unequal blobs. It must not throw: one malformed row may cost
 * one question, never the whole import.
 */
function parseOptions(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== OPTION_COUNT) return [];
    return parsed.every((option) => typeof option === 'string') ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------- reads */

async function readExistingMcqs(): Promise<ExistingPyqMcq[]> {
  const rows = await db
    .select({
      id: mcqQuestions.id,
      externalId: mcqQuestions.externalId,
      stem: mcqQuestions.stem,
      optionsJson: mcqQuestions.optionsJson,
      correctIndex: mcqQuestions.correctIndex,
      eliminationLogic: mcqQuestions.eliminationLogic,
      difficulty: mcqQuestions.difficulty,
      syllabusTopicId: mcqQuestions.syllabusTopicId,
      pyqYear: mcqQuestions.pyqYear,
      pyqPaper: mcqQuestions.pyqPaper,
      disputedAt: mcqQuestions.disputedAt,
      disputeReason: mcqQuestions.disputeReason,
      disputeNote: mcqQuestions.disputeNote,
      disputeResolvedAt: mcqQuestions.disputeResolvedAt,
    })
    .from(mcqQuestions)
    .where(eq(mcqQuestions.source, 'pyq'));

  // A pyq row with no external id predates the importer and has no identity it
  // could be matched on. Left alone rather than adopted: guessing which dataset
  // entry it is would be the key-corrupting collision the id scheme exists to
  // prevent, arriving by a different route.
  return rows
    .filter((row): row is typeof row & { externalId: string } => row.externalId !== null)
    .map(({ optionsJson, ...row }) => ({ ...row, options: parseOptions(optionsJson) }));
}

async function readGeneratedStems(): Promise<ExistingGeneratedStem[]> {
  const rows = await db
    .select({
      id: mcqQuestions.id,
      stemFingerprint: mcqQuestions.stemFingerprint,
      disputedAt: mcqQuestions.disputedAt,
      disputeResolvedAt: mcqQuestions.disputeResolvedAt,
    })
    .from(mcqQuestions)
    .where(or(isNull(mcqQuestions.source), ne(mcqQuestions.source, 'pyq')));

  return rows.map((row) => ({
    id: row.id,
    stemFingerprint: row.stemFingerprint,
    quarantined: row.disputedAt !== null && row.disputeResolvedAt === null,
  }));
}

/**
 * EVERY drill, generated ones included.
 *
 * The generated rows are not candidates for matching — they have no external
 * id — but `drills` has a UNIQUE index on `(kind, prompt_text)`, and inserting
 * an imported prompt that duplicates a generated one throws and takes the whole
 * set's transaction with it. The planner needs them to see that coming.
 */
async function readExistingDrills(): Promise<ExistingPyqDrill[]> {
  return db
    .select({
      id: drills.id,
      kind: drills.kind,
      promptText: drills.promptText,
      caseDetail: drills.caseDetail,
      syllabusTopicId: drills.syllabusTopicId,
      source: drills.source,
      externalId: drills.externalId,
      pyqYear: drills.pyqYear,
      pyqPaper: drills.pyqPaper,
      retiredAt: drills.retiredAt,
    })
    .from(drills);
}

/* ------------------------------------------------------------------ writes */

/** One set's worth of work. The unit of atomicity — see rule three. */
interface SetGroup {
  setKey: string | null;
  renameExternalId: PyqRename[];
  insert: PyqInsert[];
  update: PyqUpdate[];
  recodeKey: PyqRecodeKey[];
  unquarantine: PyqUnquarantine[];
  supersede: PyqSupersede[];
  quarantine: PyqQuarantine[];
}

function emptyGroup(setKey: string | null): SetGroup {
  return {
    setKey,
    renameExternalId: [],
    insert: [],
    update: [],
    recodeKey: [],
    unquarantine: [],
    supersede: [],
    quarantine: [],
  };
}

/**
 * Partitions the plan into transactions.
 *
 * Insertion order is preserved by `Map`, so the sets apply in dataset order and
 * the set-less withdrawal sweep — whose entries the planner emits last — lands
 * last, mirroring `ensureSyllabusSeeded`'s tombstone phase.
 */
function groupBySet(plan: PyqImportPlan): SetGroup[] {
  const groups = new Map<string | null, SetGroup>();

  const at = (setKey: string | null): SetGroup => {
    const existing = groups.get(setKey);
    if (existing) return existing;
    const created = emptyGroup(setKey);
    groups.set(setKey, created);
    return created;
  };

  for (const action of plan.renameExternalId) at(action.setKey).renameExternalId.push(action);
  for (const action of plan.insert) at(action.setKey).insert.push(action);
  for (const action of plan.update) at(action.setKey).update.push(action);
  for (const action of plan.recodeKey) at(action.setKey).recodeKey.push(action);
  for (const action of plan.unquarantine) at(action.setKey).unquarantine.push(action);
  for (const action of plan.supersede) at(action.setKey).supersede.push(action);
  for (const action of plan.quarantine) at(action.setKey).quarantine.push(action);

  return [...groups.values()];
}

/**
 * Applies one set. Synchronous callback, `.run()` on every statement — rule one.
 */
function applyGroup(group: SetGroup, now: string): void {
  const bankedOn = now.slice(0, 10);

  db.transaction((tx) => {
    /* -- 1. Renames first, so an id a later insert wants is already free. -- */

    for (const action of group.renameExternalId) {
      if (action.target === 'mcq') {
        tx.update(mcqQuestions)
          .set({ externalId: action.toExternalId })
          .where(eq(mcqQuestions.id, action.id))
          .run();
      } else {
        tx.update(drills)
          .set({ externalId: action.toExternalId })
          .where(eq(drills.id, action.id))
          .run();
      }
    }

    /* -- 2. Insert. -- */

    const mcqRows = group.insert.filter((action) => action.target === 'mcq');
    for (const batch of chunk(mcqRows, QUESTION_CHUNK)) {
      tx.insert(mcqQuestions)
        .values(
          batch.map(({ row }) => ({
            syllabusTopicId: row.syllabusTopicId,
            stem: row.stem,
            optionsJson: JSON.stringify(row.options),
            correctIndex: row.correctIndex,
            eliminationLogic: row.eliminationLogic,
            difficulty: row.difficulty,
            source: 'pyq',
            pyqYear: row.pyqYear,
            pyqPaper: row.pyqPaper,
            externalId: row.externalId,
            stemFingerprint: row.stemFingerprint,
          })),
        )
        .run();
    }

    const drillRows = group.insert.filter((action) => action.target === 'drill');
    for (const batch of chunk(drillRows, DRILL_CHUNK)) {
      tx.insert(drills)
        .values(
          batch.map(({ row }) => ({
            kind: row.kind,
            status: 'banked' as const,
            promptText: row.promptText,
            caseDetail: row.caseDetail,
            syllabusTopicId: row.syllabusTopicId,
            // The day it was banked, not the day it was set. Sliced from the
            // ISO instant and byte-compared, never re-parsed.
            bankedOn,
            source: 'pyq',
            pyqYear: row.pyqYear,
            pyqPaper: row.pyqPaper,
            externalId: row.externalId,
          })),
        )
        .run();
    }

    /* -- 3. Content only. -- */

    for (const action of group.update) {
      if (action.target === 'mcq') {
        // Note what is absent: no `correctIndex`, no `optionsJson`. `PyqMcqUpdate`
        // carries neither, so this `set` has nothing to name them with — the
        // same guarantee `db/syllabus.ts` gets from `SyllabusSeedEntry` having
        // no status field.
        tx.update(mcqQuestions)
          .set({
            stem: action.fields.stem,
            stemFingerprint: action.fields.stemFingerprint,
            eliminationLogic: action.fields.eliminationLogic,
            difficulty: action.fields.difficulty,
            syllabusTopicId: action.fields.syllabusTopicId,
            pyqYear: action.fields.pyqYear,
            pyqPaper: action.fields.pyqPaper,
          })
          .where(eq(mcqQuestions.id, action.id))
          .run();
      } else {
        tx.update(drills)
          .set({
            promptText: action.fields.promptText,
            caseDetail: action.fields.caseDetail,
            syllabusTopicId: action.fields.syllabusTopicId,
            pyqYear: action.fields.pyqYear,
            pyqPaper: action.fields.pyqPaper,
          })
          .where(eq(drills.id, action.id))
          .run();
      }
    }

    /* -- 4. The key, and the history that hangs off it. -- */

    for (const action of group.recodeKey) {
      tx.update(mcqQuestions)
        .set({
          // Written together and in one statement. The key is an index INTO
          // these options; a moment in which one has landed and the other has
          // not is a moment with a wrong answer in it.
          optionsJson: JSON.stringify(action.options),
          correctIndex: action.correctIndex,
        })
        .where(eq(mcqQuestions.id, action.id))
        .run();

      // Re-score every prior attempt, with the semantics of the `upheld` branch
      // of `resolveDispute`: a skip stays a skip, because she declined to
      // answer and no correction can turn that into a recall.
      //
      // Every attempt, not just the most recent. `resolveDispute` re-scores one
      // because a dispute is ABOUT one specific attempt and is timestamped
      // against it; a corrected key has no such anchor and invalidates the
      // scoring of all of them. `mcq_attempts.correct` drives `mcqWeakTopics`,
      // `lastCorrectAt` and selection tier 4, so a stale one leaves the app
      // calling her wrong for having been right.
      const attempts = tx
        .select({
          id: mcqAttempts.id,
          chosenIndex: mcqAttempts.chosenIndex,
          correct: mcqAttempts.correct,
        })
        .from(mcqAttempts)
        .where(eq(mcqAttempts.questionId, action.id))
        .all();

      for (const attempt of attempts) {
        const nowCorrect = rescoreAttempt(attempt.chosenIndex, action.correctIndex);
        if (nowCorrect === attempt.correct) continue;
        tx.update(mcqAttempts)
          .set({ correct: nowCorrect })
          .where(eq(mcqAttempts.id, attempt.id))
          .run();
      }
    }

    /* -- 5. Restore what a previous import withdrew. -- */

    for (const action of group.unquarantine) {
      if (action.target === 'mcq') {
        // Cleared wholesale, the note included: it was the importer's marker,
        // not hers. The planner has already established that — a dispute SHE
        // raised never reaches this loop.
        tx.update(mcqQuestions)
          .set({
            disputedAt: null,
            disputeReason: null,
            disputeNote: null,
            disputeResolvedAt: null,
            disputeVerdict: null,
          })
          .where(eq(mcqQuestions.id, action.id))
          .run();
      } else {
        tx.update(drills).set({ retiredAt: null }).where(eq(drills.id, action.id)).run();
      }
    }

    /* -- 6. The generated guess at a question UPSC actually set. -- */

    for (const action of group.supersede) {
      tx.update(mcqQuestions)
        .set({
          disputedAt: now,
          disputeReason: PYQ_IMPORT_DISPUTE_REASON,
          disputeNote: action.note,
          disputeResolvedAt: null,
          disputeVerdict: null,
        })
        .where(eq(mcqQuestions.id, action.questionId))
        .run();
    }

    /* -- 7. Withdraw. Never DELETE. -- */

    for (const action of group.quarantine) {
      if (action.target === 'mcq') {
        // `mcq_attempts` and `mcq_review_queue` both cascade from this row, so
        // a DELETE here would not remove a question — it would remove her
        // record of having answered it. Quarantine takes it out of every
        // selection tier and every inventory count and leaves all of that
        // standing.
        //
        // Unlike `disputeQuestion`, the `mcq_review_queue` row is left alone.
        // That deletion exists there because the intervals were computed
        // against a key she believes is wrong; a question withdrawn by a
        // dataset revision has no such defect, is inert while quarantined, and
        // comes back with its spacing intact if a later revision restores it.
        tx.update(mcqQuestions)
          .set({
            disputedAt: now,
            disputeReason: PYQ_IMPORT_DISPUTE_REASON,
            disputeNote: action.note,
            disputeResolvedAt: null,
            disputeVerdict: null,
          })
          .where(eq(mcqQuestions.id, action.id))
          .run();
      } else {
        // `drills` has no dispute columns, so retirement is its quarantine.
        // `drill_parts` and `drill_scores` cascade from this row: a delete
        // would destroy an answer she has already written and its score.
        tx.update(drills).set({ retiredAt: now }).where(eq(drills.id, action.id)).run();
      }
    }
  });
}

/* ------------------------------------------------------------------ import */

/**
 * Called once from the root layout after migrations succeed, alongside
 * `ensureSyllabusSeeded` and AFTER it — an imported question files itself
 * against a syllabus topic, and an unresolvable slug degrades that filing.
 *
 * Must be idempotent: on a steady-state launch it performs zero writes and
 * returns an empty plan, so it does not churn every live query in the app on
 * every cold start. With the dataset empty, which is where this phase leaves
 * it, every launch is a steady-state launch.
 */
export async function ensurePyqImported(
  dataset: PyqDataset = PYQ_DATASET_V1,
): Promise<PyqImportPlan> {
  const [existingMcqs, generatedStems, existingDrills, slugs] = await Promise.all([
    readExistingMcqs(),
    readGeneratedStems(),
    readExistingDrills(),
    topicIdBySlug(),
  ]);

  const plan = planPyqImport(
    { existingMcqs, existingDrills, generatedStems, topicIdBySlug: slugs },
    dataset,
  );

  const now = new Date().toISOString();

  // One transaction per set. A failure in one leaves the sets before it banked
  // and the next launch completes the rest — see rule three in the header.
  for (const group of groupBySet(plan)) applyGroup(group, now);

  // A record, never a gate: the diff above ran regardless. Written only when it
  // would change something, so the steady-state launch stays at zero writes.
  const current = await db
    .select({ version: profile.pyqDatasetVersion })
    .from(profile)
    .where(eq(profile.id, 1))
    .limit(1);

  if (current.length > 0 && current[0].version !== dataset.version) {
    await db
      .update(profile)
      .set({ pyqDatasetVersion: dataset.version })
      .where(eq(profile.id, 1));
  }

  return plan;
}

/**
 * Re-exported so the caller can ask "did this import do anything?" without
 * reaching past this module into the pure one for a second import path.
 */
export { planIsEmpty };
