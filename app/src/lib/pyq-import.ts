/**
 * Planning a past-paper import.
 *
 * Pure, and that is the point: this module decides everything dangerous — which
 * answer keys get rewritten, which questions stop being served, which of her
 * attempts get re-scored — and none of it touches a database, so every rule
 * below is testable with literal data. `db/pyq.ts` executes the plan and makes
 * no decisions at all.
 *
 * The shape is `lib/syllabus-seed.ts`'s, deliberately, because the failure being
 * guarded against is the same one: a re-import that quietly destroys history she
 * cannot get back.
 *
 * ## What this plan CANNOT express
 *
 * There is no `delete` array, and its absence is load-bearing rather than an
 * omission. `mcq_attempts` and `mcq_review_queue` cascade from `mcq_questions`,
 * and `drill_parts` and `drill_scores` cascade from `drills`. Deleting a
 * question would not remove a question — it would remove her record of having
 * answered it. A withdrawn question is quarantined instead: the row stays, the
 * history stays, and nothing serves it.
 *
 * `PyqMcqUpdateFields` likewise has no `correctIndex` and no `options`. A key
 * change is a different act with different consequences, and it travels in
 * `recodeKey` where the executor can see it and re-score against it. That is
 * the device `SeedPlan.update` already uses by carrying a `SyllabusSeedEntry`
 * with no status field to name.
 */

import type { DrillKind } from './drill-types';
import type { PyqDataset, PyqMcq, PyqSet, PyqWritten } from '@/data/pyq/types';
import { pyqExamSpec, pyqExternalId, pyqSetKey } from '@/data/pyq/types';

/**
 * Written to `dispute_reason` on anything this importer withdraws.
 *
 * Load-bearing: it is the only thing distinguishing "the dataset withdrew this"
 * from "SHE disputed this". A dataset revision may return the first to
 * circulation and must never return the second — `disputeQuestion` promises a
 * disputed question stops being served immediately, and a background import
 * silently undoing that would break the promise with no error anywhere.
 */
export const PYQ_IMPORT_DISPUTE_REASON = 'outdated';

/** Options a question may have. Mirrors `OPTION_COUNT` in `mcq-types.ts`. */
const OPTION_COUNT = 4;

/* ------------------------------------------------------------ what exists */

export interface ExistingPyqMcq {
  id: number;
  externalId: string;
  stem: string;
  options: readonly string[];
  correctIndex: number;
  eliminationLogic: string | null;
  difficulty: string;
  syllabusTopicId: number | null;
  pyqYear: number | null;
  pyqPaper: string | null;
  disputedAt: string | null;
  disputeReason: string | null;
  disputeNote: string | null;
  disputeResolvedAt: string | null;
}

/** A generated question, for collision detection only. */
export interface ExistingGeneratedStem {
  id: number;
  stemFingerprint: string;
  quarantined: boolean;
}

export interface ExistingPyqDrill {
  id: number;
  kind: string;
  promptText: string;
  caseDetail: string | null;
  syllabusTopicId: number | null;
  source: string | null;
  externalId: string | null;
  pyqYear: number | null;
  pyqPaper: string | null;
  retiredAt: string | null;
}

/* ------------------------------------------------------------- the actions */

export interface PyqRename {
  setKey: string | null;
  target: 'mcq' | 'drill';
  id: number;
  toExternalId: string;
}

export interface PyqMcqInsertRow {
  externalId: string;
  stem: string;
  options: readonly string[];
  correctIndex: number;
  eliminationLogic: string | null;
  difficulty: string;
  syllabusTopicId: number | null;
  pyqYear: number;
  pyqPaper: string;
  stemFingerprint: string;
}

export interface PyqDrillInsertRow {
  externalId: string;
  kind: DrillKind;
  promptText: string;
  caseDetail: string | null;
  syllabusTopicId: number | null;
  pyqYear: number;
  pyqPaper: string;
}

export type PyqInsert =
  | { setKey: string; target: 'mcq'; row: PyqMcqInsertRow }
  | { setKey: string; target: 'drill'; row: PyqDrillInsertRow };

/** Note what is absent: no key, no options. See the header. */
export interface PyqMcqUpdateFields {
  stem: string;
  stemFingerprint: string;
  eliminationLogic: string | null;
  difficulty: string;
  syllabusTopicId: number | null;
  pyqYear: number;
  pyqPaper: string;
}

export interface PyqDrillUpdateFields {
  promptText: string;
  caseDetail: string | null;
  syllabusTopicId: number | null;
  pyqYear: number;
  pyqPaper: string;
}

export type PyqUpdate =
  | { setKey: string; target: 'mcq'; id: number; fields: PyqMcqUpdateFields }
  | { setKey: string; target: 'drill'; id: number; fields: PyqDrillUpdateFields };

/**
 * A key that moved. Its own action because its consequences are unique: it
 * rewrites what "correct" meant for attempts she has already made.
 *
 * `options` travels with it because the key is an index INTO them. A booklet
 * correction can reorder the options and move the index together, and applying
 * one without the other leaves a moment with a wrong answer in it.
 */
export interface PyqRecodeKey {
  setKey: string;
  id: number;
  options: readonly string[];
  correctIndex: number;
}

export interface PyqUnquarantine {
  setKey: string;
  target: 'mcq' | 'drill';
  id: number;
}

export interface PyqSupersede {
  setKey: string;
  questionId: number;
  note: string;
}

export interface PyqQuarantine {
  setKey: string | null;
  target: 'mcq' | 'drill';
  id: number;
  note: string;
}

export type PyqRejectReason =
  | 'unverified_set'
  | 'duplicate_external_id'
  | 'option_count'
  | 'empty_option'
  | 'duplicate_option'
  | 'correct_index'
  | 'empty_stem'
  | 'wrong_form_for_exam'
  | 'case_detail_mismatch'
  | 'prompt_collides_with_generated';

export interface PyqImportPlan {
  renameExternalId: PyqRename[];
  insert: PyqInsert[];
  update: PyqUpdate[];
  recodeKey: PyqRecodeKey[];
  unquarantine: PyqUnquarantine[];
  supersede: PyqSupersede[];
  quarantine: PyqQuarantine[];
  unchanged: number;
  rejected: { externalId: string; reason: PyqRejectReason }[];
}

export function planIsEmpty(plan: PyqImportPlan): boolean {
  return (
    plan.renameExternalId.length === 0 &&
    plan.insert.length === 0 &&
    plan.update.length === 0 &&
    plan.recodeKey.length === 0 &&
    plan.unquarantine.length === 0 &&
    plan.supersede.length === 0 &&
    plan.quarantine.length === 0
  );
}

/**
 * Whether an attempt was correct under a given key.
 *
 * A skip stays a skip: she declined to answer, and no key correction can turn
 * that into a recall. Same semantics as the `upheld` branch of `resolveDispute`.
 */
export function rescoreAttempt(chosenIndex: number | null, correctIndex: number): boolean {
  if (chosenIndex === null) return false;
  return chosenIndex === correctIndex;
}

/**
 * Normalised stem, for duplicate suppression against generated questions.
 *
 * Deliberately crude and deliberately the same shape the bank already uses: a
 * false positive supersedes one generated question that a real paper duplicates,
 * which is the outcome wanted anyway.
 */
export function stemFingerprint(stem: string): string {
  return stem
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .join(' ')
    .slice(0, 200);
}

/* -------------------------------------------------------------- validation */

function validateMcq(mcq: PyqMcq): PyqRejectReason | null {
  if (mcq.stem.trim() === '') return 'empty_stem';
  if (mcq.options.length !== OPTION_COUNT) return 'option_count';
  if (mcq.options.some((option) => option.trim() === '')) return 'empty_option';
  if (new Set(mcq.options.map((option) => option.trim())).size !== OPTION_COUNT) {
    return 'duplicate_option';
  }
  if (
    !Number.isInteger(mcq.correctIndex) ||
    mcq.correctIndex < 0 ||
    mcq.correctIndex >= OPTION_COUNT
  ) {
    return 'correct_index';
  }
  return null;
}

/**
 * `drills_case_detail_matches_kind` is a CHECK constraint.
 *
 * Getting this wrong does not degrade one row — it aborts the whole set's
 * transaction, so it is refused here where the cost is one question.
 */
function validateWritten(written: PyqWritten, kind: DrillKind): PyqRejectReason | null {
  if (written.promptText.trim() === '') return 'empty_stem';
  const needsCase = kind === 'ethics_case';
  const hasCase = written.caseDetail !== null && written.caseDetail.trim() !== '';
  if (needsCase !== hasCase) return 'case_detail_mismatch';
  return null;
}

/* ------------------------------------------------------------------- plan */

export interface PyqImportContext {
  existingMcqs: readonly ExistingPyqMcq[];
  existingDrills: readonly ExistingPyqDrill[];
  generatedStems: readonly ExistingGeneratedStem[];
  /** Slug to live topic id. A slug absent from it imports untagged. */
  topicIdBySlug: ReadonlyMap<string, number>;
}

export function planPyqImport(context: PyqImportContext, dataset: PyqDataset): PyqImportPlan {
  const plan: PyqImportPlan = {
    renameExternalId: [],
    insert: [],
    update: [],
    recodeKey: [],
    unquarantine: [],
    supersede: [],
    quarantine: [],
    unchanged: 0,
    rejected: [],
  };

  const mcqByExternalId = new Map(context.existingMcqs.map((row) => [row.externalId, row] as const));
  const drillByExternalId = new Map<string, ExistingPyqDrill>();
  const generatedPromptTexts = new Map<string, ExistingPyqDrill>();
  for (const row of context.existingDrills) {
    if (row.source === 'pyq' && row.externalId !== null) drillByExternalId.set(row.externalId, row);
    // `drills` has a UNIQUE index on (kind, prompt_text). An imported prompt
    // duplicating a generated one throws and takes the set's transaction with
    // it, so the collision is caught here rather than at the database.
    if (row.source !== 'pyq') generatedPromptTexts.set(`${row.kind} ${row.promptText}`, row);
  }

  const generatedByFingerprint = new Map<string, ExistingGeneratedStem>();
  for (const row of context.generatedStems) {
    if (row.stemFingerprint === '' || row.quarantined) continue;
    if (!generatedByFingerprint.has(row.stemFingerprint)) {
      generatedByFingerprint.set(row.stemFingerprint, row);
    }
  }

  /**
   * Renames first, mirroring `planSeed` rule 1.
   *
   * Simpler than the syllabus case because attempts reference `question_id`,
   * not the external id: a rename rewrites one column on a row that keeps its
   * id and therefore keeps all of its history.
   */
  for (const rename of dataset.renames) {
    const mcq = mcqByExternalId.get(rename.fromExternalId);
    if (mcq !== undefined && !mcqByExternalId.has(rename.toExternalId)) {
      plan.renameExternalId.push({
        setKey: null,
        target: 'mcq',
        id: mcq.id,
        toExternalId: rename.toExternalId,
      });
      mcqByExternalId.delete(rename.fromExternalId);
      mcqByExternalId.set(rename.toExternalId, { ...mcq, externalId: rename.toExternalId });
      continue;
    }
    const drill = drillByExternalId.get(rename.fromExternalId);
    if (drill !== undefined && !drillByExternalId.has(rename.toExternalId)) {
      plan.renameExternalId.push({
        setKey: null,
        target: 'drill',
        id: drill.id,
        toExternalId: rename.toExternalId,
      });
      drillByExternalId.delete(rename.fromExternalId);
      drillByExternalId.set(rename.toExternalId, { ...drill, externalId: rename.toExternalId });
    }
  }

  const seenThisRun = new Set<string>();
  const claimed = new Set<string>();

  for (const set of dataset.sets) {
    const spec = pyqExamSpec(set.exam);
    const setKey = pyqSetKey(set.exam, set.year, set.booklet);

    // A set nobody checked against the paper cannot reach the device by any
    // path, including "someone forgot". Whole set, not question by question.
    if (set.verification === null) {
      for (const mcq of set.mcqs) {
        plan.rejected.push({
          externalId: pyqExternalId(set.exam, set.year, set.booklet, mcq.number),
          reason: 'unverified_set',
        });
      }
      for (const written of set.written) {
        plan.rejected.push({
          externalId: pyqExternalId(set.exam, set.year, set.booklet, written.number),
          reason: 'unverified_set',
        });
      }
      continue;
    }

    planMcqs(set, spec.form === 'mcq', setKey);
    planWritten(set, spec.form === 'written' ? spec.drillKind : null, setKey);
  }

  function planMcqs(set: PyqSet, allowed: boolean, setKey: string): void {
    const spec = pyqExamSpec(set.exam);
    for (const mcq of set.mcqs) {
      const externalId = pyqExternalId(set.exam, set.year, set.booklet, mcq.number);

      // First occurrence wins, matching `planSeed`'s duplicate handling. A
      // repeat would otherwise overwrite the first with the second's key.
      if (seenThisRun.has(externalId)) {
        plan.rejected.push({ externalId, reason: 'duplicate_external_id' });
        continue;
      }
      seenThisRun.add(externalId);

      if (!allowed) {
        plan.rejected.push({ externalId, reason: 'wrong_form_for_exam' });
        continue;
      }
      const invalid = validateMcq(mcq);
      if (invalid !== null) {
        plan.rejected.push({ externalId, reason: invalid });
        continue;
      }

      claimed.add(externalId);
      const syllabusTopicId =
        mcq.syllabusSlug === null ? null : (context.topicIdBySlug.get(mcq.syllabusSlug) ?? null);
      const fingerprint = stemFingerprint(mcq.stem);
      const row = mcqByExternalId.get(externalId);

      if (row === undefined) {
        const twin = generatedByFingerprint.get(fingerprint);
        if (twin !== undefined) {
          plan.supersede.push({
            setKey,
            questionId: twin.id,
            note: `${PYQ_IMPORT_DISPUTE_REASON}: superseded by ${externalId}, whose key is UPSC's`,
          });
          // One generated twin may only be superseded once.
          generatedByFingerprint.delete(fingerprint);
        }
        plan.insert.push({
          setKey,
          target: 'mcq',
          row: {
            externalId,
            stem: mcq.stem,
            options: mcq.options,
            correctIndex: mcq.correctIndex,
            eliminationLogic: mcq.eliminationLogic,
            difficulty: mcq.difficulty,
            syllabusTopicId,
            pyqYear: set.year,
            pyqPaper: spec.label,
            stemFingerprint: fingerprint,
          },
        });
        continue;
      }

      let touched = false;

      // The key moved. Separate from `update` precisely so the executor knows
      // to re-score every prior attempt against it.
      const optionsDiffer =
        row.options.length !== mcq.options.length ||
        row.options.some((option, index) => option !== mcq.options[index]);
      if (row.correctIndex !== mcq.correctIndex || optionsDiffer) {
        plan.recodeKey.push({
          setKey,
          id: row.id,
          options: mcq.options,
          correctIndex: mcq.correctIndex,
        });
        touched = true;
      }

      const fields: PyqMcqUpdateFields = {
        stem: mcq.stem,
        stemFingerprint: fingerprint,
        eliminationLogic: mcq.eliminationLogic,
        difficulty: mcq.difficulty,
        syllabusTopicId,
        pyqYear: set.year,
        pyqPaper: spec.label,
      };
      if (
        row.stem !== fields.stem ||
        row.eliminationLogic !== fields.eliminationLogic ||
        row.difficulty !== fields.difficulty ||
        row.syllabusTopicId !== fields.syllabusTopicId ||
        row.pyqYear !== fields.pyqYear ||
        row.pyqPaper !== fields.pyqPaper
      ) {
        plan.update.push({ setKey, target: 'mcq', id: row.id, fields });
        touched = true;
      }

      // Returned to circulation ONLY if a previous import withdrew it. A
      // question she disputed stays out until she resolves it herself.
      if (
        row.disputedAt !== null &&
        row.disputeResolvedAt === null &&
        row.disputeReason === PYQ_IMPORT_DISPUTE_REASON
      ) {
        plan.unquarantine.push({ setKey, target: 'mcq', id: row.id });
        touched = true;
      }

      if (!touched) plan.unchanged += 1;
    }
  }

  function planWritten(set: PyqSet, kind: DrillKind | null, setKey: string): void {
    const spec = pyqExamSpec(set.exam);
    for (const written of set.written) {
      const externalId = pyqExternalId(set.exam, set.year, set.booklet, written.number);

      if (seenThisRun.has(externalId)) {
        plan.rejected.push({ externalId, reason: 'duplicate_external_id' });
        continue;
      }
      seenThisRun.add(externalId);

      if (kind === null) {
        plan.rejected.push({ externalId, reason: 'wrong_form_for_exam' });
        continue;
      }
      const invalid = validateWritten(written, kind);
      if (invalid !== null) {
        plan.rejected.push({ externalId, reason: invalid });
        continue;
      }

      claimed.add(externalId);
      const syllabusTopicId =
        written.syllabusSlug === null
          ? null
          : (context.topicIdBySlug.get(written.syllabusSlug) ?? null);
      const row = drillByExternalId.get(externalId);

      if (row === undefined) {
        // The UNIQUE (kind, prompt_text) index would abort the whole set.
        if (generatedPromptTexts.has(`${kind} ${written.promptText}`)) {
          plan.rejected.push({ externalId, reason: 'prompt_collides_with_generated' });
          continue;
        }
        plan.insert.push({
          setKey,
          target: 'drill',
          row: {
            externalId,
            kind,
            promptText: written.promptText,
            caseDetail: written.caseDetail,
            syllabusTopicId,
            pyqYear: set.year,
            pyqPaper: spec.label,
          },
        });
        continue;
      }

      let touched = false;
      const fields: PyqDrillUpdateFields = {
        promptText: written.promptText,
        caseDetail: written.caseDetail,
        syllabusTopicId,
        pyqYear: set.year,
        pyqPaper: spec.label,
      };
      if (
        row.promptText !== fields.promptText ||
        row.caseDetail !== fields.caseDetail ||
        row.syllabusTopicId !== fields.syllabusTopicId ||
        row.pyqYear !== fields.pyqYear ||
        row.pyqPaper !== fields.pyqPaper
      ) {
        plan.update.push({ setKey, target: 'drill', id: row.id, fields });
        touched = true;
      }
      if (row.retiredAt !== null) {
        plan.unquarantine.push({ setKey, target: 'drill', id: row.id });
        touched = true;
      }
      if (!touched) plan.unchanged += 1;
    }
  }

  /**
   * Withdrawn: ours, and the dataset no longer claims it.
   *
   * Scoped to rows this importer owns. A generated question must never be
   * withdrawn by a past-paper import that simply does not mention it.
   */
  for (const row of context.existingMcqs) {
    if (claimed.has(row.externalId)) continue;
    // Already out of circulation. Re-stamping would overwrite HER dispute note
    // with the importer's, and the note is the only thing distinguishing them.
    if (row.disputedAt !== null && row.disputeResolvedAt === null) continue;
    plan.quarantine.push({
      setKey: null,
      target: 'mcq',
      id: row.id,
      note: `withdrawn in dataset v${dataset.version}`,
    });
  }

  for (const row of context.existingDrills) {
    if (row.source !== 'pyq' || row.externalId === null) continue;
    if (claimed.has(row.externalId)) continue;
    if (row.retiredAt !== null) continue;
    plan.quarantine.push({
      setKey: null,
      target: 'drill',
      id: row.id,
      note: `withdrawn in dataset v${dataset.version}`,
    });
  }

  return plan;
}
