/**
 * The past-question data format. Pure — no RN, no expo-sqlite, no database.
 *
 * The counterpart to `data/syllabus-v1.ts`, and it borrows that file's
 * discipline wholesale: a permanent identity per record, wording that may be
 * corrected freely, and a versioned dataset that ships as source. What differs
 * is what a mistake costs. A wrong syllabus bullet is a bad label; a wrong
 * ANSWER KEY is drilled to mastery by spaced repetition, and the better the
 * scheduling works the more thoroughly the falsehood is learned. Everything
 * below exists to make that specific failure hard to commit and impossible to
 * commit silently.
 *
 * ## Identity: `pyq-<exam>-<year>-<set>-q<NNN>`
 *
 * Permanent, like a syllabus slug. Text may be corrected; an id may not, and
 * `lib/pyq-import.ts` matches on it alone.
 *
 * **The booklet set letter is in the id and that is not cosmetic.** UPSC prints
 * four booklets — Set A, B, C, D — of the same Prelims paper with the questions
 * AND the options in different orders, and publishes a separate answer key for
 * each. So "question 42" names a different question in each booklet, with a
 * different correct option. Without the set letter, two extractions taken from
 * two booklets mint the same id for two different questions, and the second
 * import silently rewrites the first one's key. That is the worst outcome this
 * whole subsystem can produce: a question that reads correctly, has a plausible
 * key, and is wrong — indistinguishable from a good row by inspection.
 *
 * The id is OPAQUE. Nothing parses it back apart; every field it encodes is
 * also a column on the row.
 *
 * ## `verification` is nullable so that it can be refused
 *
 * A null one is not a gap to fill in later. `planPyqImport` refuses the entire
 * set, so an unverified paper cannot reach the bank by being forgotten about.
 * The nullability IS the enforcement — a required field would be satisfied by
 * typing anything into it.
 *
 * ## `dropped` makes the refusals countable
 *
 * A question that could not be represented honestly — a map, a
 * match-the-following, a table in the stem, a page the scan cannot read — is
 * recorded with its reason rather than omitted. "94 of 100 questions imported,
 * 6 dropped" is a true and checkable sentence. Silent omission looks identical
 * to a bug in the extractor.
 *
 * ## What this file must never contain
 *
 * Question content. The dataset in `dataset.ts` ships empty; extraction is a
 * later phase and a human one. Nothing here may generate, guess at, or
 * complete a stem, an option or a key.
 */

import type { DrillKind } from '@/lib/drill-types';
import type { Difficulty } from '@/lib/mcq-types';
import type { PaperValue } from '@/lib/papers';

/* -------------------------------------------------------------------- exams */

/**
 * The papers this phase can actually place, and deliberately only those.
 *
 * Prelims GS Paper I banks as `mcq_questions`. Mains Essay and GS4 bank as
 * `drills`, whose two kinds — `essay_outline` and `ethics_case` — are exactly
 * these two papers. Mains GS1–GS3 are missing on purpose: their questions
 * belong on `answers`, which is written when SHE writes an answer rather than
 * when a paper is imported, so an importer that accepted them would accept a
 * set and place none of it. CSAT is missing for a different reason: its
 * comprehension and reasoning questions sit under no syllabus leaf, and a
 * hundred untagged questions would be dealt into GS sessions by the
 * `unseen_any` tier as though they were General Studies.
 *
 * Adding an exam later costs one entry here. It cannot invalidate an id already
 * minted, because the exam slug is part of that id.
 */
export const PYQ_EXAMS = [
  'prelims-gs1',
  'mains-essay',
  'mains-gs4',
] as const;

export type PyqExam = (typeof PYQ_EXAMS)[number];

export function isPyqExam(value: unknown): value is PyqExam {
  return typeof value === 'string' && (PYQ_EXAMS as readonly string[]).includes(value);
}

export interface PyqExamSpec {
  exam: PyqExam;
  /**
   * Written verbatim into `mcq_questions.pyq_paper` / `drills.pyq_paper`, and
   * shown on screen beside the question. A past key is UPSC's and a generated
   * one is a model's; she is entitled to weight them differently, which she can
   * only do if the screen says which is which.
   */
  label: string;
  /** Which table the paper lands in. `mcq` banks questions, `written` banks drills. */
  form: 'mcq' | 'written';
  /** The drill kind a written paper banks as. Null for an objective paper. */
  drillKind: DrillKind | null;
  /**
   * The Mains paper, where the exam is one. Prelims GS mixes GS1, GS2 and GS3
   * in a single booklet and is not any one of them, so it is null rather than
   * arbitrarily assigned.
   */
  paper: PaperValue | null;
}

const EXAM_SPECS: Readonly<Record<PyqExam, PyqExamSpec>> = {
  'prelims-gs1': {
    exam: 'prelims-gs1',
    label: 'Prelims GS Paper I',
    form: 'mcq',
    drillKind: null,
    paper: null,
  },
  'mains-essay': {
    exam: 'mains-essay',
    label: 'Mains Essay',
    form: 'written',
    drillKind: 'essay_outline',
    paper: 'essay',
  },
  'mains-gs4': {
    exam: 'mains-gs4',
    label: 'Mains GS Paper IV',
    form: 'written',
    drillKind: 'ethics_case',
    paper: 'gs4',
  },
};

export function pyqExamSpec(exam: PyqExam): PyqExamSpec {
  return EXAM_SPECS[exam];
}

/* ----------------------------------------------------------------- booklets */

/**
 * The booklet set. Lowercase because it goes straight into the id.
 *
 * There is no case conversion anywhere between here and the id, on purpose: a
 * `toLowerCase()` in one place and not another is exactly how two extractions
 * of the same booklet end up with two different ids for one question.
 *
 * `'x'` means the paper has no booklets — Mains is printed in one version. It
 * occupies the slot rather than collapsing the id format, so every id has the
 * same shape and the Prelims case never becomes the special one.
 */
export const PYQ_BOOKLETS = ['a', 'b', 'c', 'd', 'x'] as const;

export type PyqBooklet = (typeof PYQ_BOOKLETS)[number];

export function isPyqBooklet(value: unknown): value is PyqBooklet {
  return typeof value === 'string' && (PYQ_BOOKLETS as readonly string[]).includes(value);
}

/* ----------------------------------------------------------------- identity */

/** Zero-padding width for the question number. 100-question papers, so three. */
export const PYQ_NUMBER_DIGITS = 3;

/** The highest number `PYQ_NUMBER_DIGITS` can represent without widening an id. */
export const PYQ_MAX_NUMBER = 999;

/**
 * The permanent external id.
 *
 * Zero-padded so ids sort the way a human reads a question paper: unpadded,
 * `q10` sorts before `q9` in every listing, log line and index this string will
 * ever appear in.
 */
export function pyqExternalId(
  exam: PyqExam,
  year: number,
  booklet: PyqBooklet,
  number: number,
): string {
  return `pyq-${exam}-${year}-${booklet}-q${String(number).padStart(PYQ_NUMBER_DIGITS, '0')}`;
}

/**
 * Groups a set's rows for the importer, which runs one transaction per set.
 *
 * Deliberately the same prefix the ids in that set share, so a row's group is
 * legible from its id alone when something has to be diagnosed from a log.
 */
export function pyqSetKey(exam: PyqExam, year: number, booklet: PyqBooklet): string {
  return `pyq-${exam}-${year}-${booklet}`;
}

/* ------------------------------------------------------------- verification */

/**
 * Where the answer key came from, in descending order of trust.
 *
 * Not a boolean, because "verified" collapses two very different claims. UPSC's
 * own key is authoritative; a key reconstructed from coaching institutes'
 * published solutions is a consensus of guesses and is wrong often enough that
 * it must be visible as such rather than laundered into the same field.
 */
export type PyqKeySource =
  /** UPSC's published answer key for this booklet. */
  | 'upsc_official'
  /** UPSC's revised key, issued after the objection window. Beats the first one. */
  | 'upsc_revised'
  /** Reconstructed from published solutions. Trusted least, and shown as such. */
  | 'published_consensus';

/**
 * Who checked this set, when, and against what.
 *
 * Every field is about a HUMAN act. There is no `verifiedByTool`, and adding
 * one would defeat the point: the property being asserted is that a person
 * compared this set's keys against a published key and is accountable for the
 * result.
 */
export interface PyqVerification {
  /** The person who checked. */
  verifiedBy: string;
  /** `YYYY-MM-DD`. Byte-compared and displayed; never re-parsed into a Date. */
  verifiedOn: string;
  keySource: PyqKeySource;
  /** Where the paper and the key were obtained. Null when offline/from print. */
  sourceUrl: string | null;
  /** Anything a later reader needs — a disputed question, a scan quality caveat. */
  note: string | null;
}

/* ------------------------------------------------------------------ records */

/**
 * Why an extracted question was refused.
 *
 * Every one of these is a question that EXISTS in the paper and is not in the
 * app. Recording which is what keeps "94 imported" from quietly meaning
 * "94 found".
 */
export type PyqDropReason =
  /** The stem depends on a map, a diagram or an image the app cannot show. */
  | 'map_or_diagram'
  /** Match-the-following. Not answerable on a four-option pad. */
  | 'match_the_following'
  /** A table in the stem. Renders as unreadable prose on a phone. */
  | 'table_in_stem'
  /** The scan is illegible. Guessing at the missing words would invent a question. */
  | 'unreadable_scan'
  /** UPSC withdrew the question and awarded marks to all candidates. */
  | 'withdrawn_by_upsc'
  /** No key of acceptable provenance exists for this one question. */
  | 'no_verified_key';

export interface PyqDropped {
  /** The number printed in this booklet, so the drop is checkable against the paper. */
  number: number;
  reason: PyqDropReason;
  note: string | null;
}

/** One objective question, exactly as printed in ONE booklet. */
export interface PyqMcq {
  /**
   * The number printed in THIS booklet — not a position in the array below.
   *
   * It is what the id is built from, so it is the identity, and it is what
   * makes a drop or a correction checkable against the paper in hand.
   */
  number: number;
  stem: string;
  /** Exactly `OPTION_COUNT`, in the order this booklet prints them. */
  options: readonly string[];
  /** Indexes into `options` AS ORDERED ABOVE. Booklet-specific by construction. */
  correctIndex: number;
  /**
   * Null, and it must stay null unless a human wrote one.
   *
   * A past paper ships no explanation. Generating one would put a model's
   * reasoning behind UPSC's key wearing UPSC's authority, which is worse than
   * having none: she would have no way to tell the two apart.
   */
  eliminationLogic: string | null;
  difficulty: Difficulty;
  /** `syllabus_topics.slug`. Null when the question sits under no single leaf. */
  syllabusSlug: string | null;
}

/** One written question — an essay topic, or an ethics case. */
export interface PyqWritten {
  number: number;
  promptText: string;
  /**
   * The situation, for an ethics case. Null for an essay topic.
   *
   * Required for `ethics_case` and forbidden otherwise, because
   * `drills_case_detail_matches_kind` is a CHECK constraint: getting it wrong
   * does not degrade one row, it aborts the whole set's transaction.
   */
  caseDetail: string | null;
  syllabusSlug: string | null;
}

/**
 * One paper, one booklet.
 *
 * `mcqs` and `written` are both present rather than split into two set types
 * because the exam already decides which is populated, and one type keeps the
 * importer's per-set transaction boundary to a single concept. The importer
 * refuses entries in the array the exam's form does not use.
 */
export interface PyqSet {
  exam: PyqExam;
  year: number;
  booklet: PyqBooklet;
  /** Null refuses the whole set. See the header — this is the enforcement. */
  verification: PyqVerification | null;
  mcqs: readonly PyqMcq[];
  written: readonly PyqWritten[];
  dropped: readonly PyqDropped[];
}

/**
 * A correction to the id scheme itself, carrying a row's attempt history across.
 *
 * The syllabus equivalent is `SyllabusRename`, and the reason is the same: an
 * id is permanent precisely because there is a declared way to change one. The
 * case this exists for is real and already foreseeable — ids minted before the
 * booklet letter was required have to move to ids that carry it, and doing that
 * by insert-and-withdraw would leave her attempts attached to the quarantined
 * old row and the new one looking unseen.
 */
export interface PyqExternalIdRename {
  fromExternalId: string;
  toExternalId: string;
}

export interface PyqDataset {
  /**
   * Bumped on every content change. Recorded on `profile.pyq_dataset_version`
   * after a successful import, for display — never as a gate on the diff.
   */
  version: number;
  sets: readonly PyqSet[];
  /** Empty until an id scheme changes. Annotated so the first entry is type-checked. */
  renames: readonly PyqExternalIdRename[];
}
