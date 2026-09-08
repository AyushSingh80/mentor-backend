/**
 * The Essay and Ethics drill wire and pipeline vocabulary. FROZEN.
 *
 * The counterpart to `app/src/lib/drill-types.ts`. Written before either side
 * and edited by neither.
 *
 * ## Why this file exists at all
 *
 * Phases 3 and 4 each shipped with every field name different across the wire.
 * Both times the two halves were built in parallel against a contract that was
 * described in prose and never written down, both times every test on both
 * sides passed, and both times the feature answered 400 to every request it
 * ever received. The cure is not more tests on either half — it is one file
 * both halves import their vocabulary from, plus a contract test pair that
 * feeds one side's real output to the other side's real parser.
 *
 * The two `PARTS` lists below are the load-bearing part: they are the keys the
 * app writes into `drill_parts`, the keys the model is told to score, and the
 * keys the app reads scores back under. One rename in one place and the scores
 * land nowhere, silently, with a 200 on the wire.
 */

/* ------------------------------------------------------------------ kinds */

export const DRILL_KINDS = ['essay_outline', 'ethics_case'] as const;
export type DrillKind = (typeof DRILL_KINDS)[number];

export function isDrillKind(value: unknown): value is DrillKind {
  return typeof value === 'string' && (DRILL_KINDS as readonly string[]).includes(value);
}

/** Byte-identical to `PARTS_OF_KIND` in `app/src/lib/drill-types.ts`. */
export const ESSAY_OUTLINE_PARTS = ['thesis', 'dimensions', 'opening', 'closing'] as const;
export const ETHICS_CASE_PARTS = [
  'keywords',
  'stakeholders',
  'options',
  'decision',
  'theory',
] as const;

export type DrillPart = (typeof ESSAY_OUTLINE_PARTS)[number] | (typeof ETHICS_CASE_PARTS)[number];

export const PARTS_OF_KIND: Readonly<Record<DrillKind, readonly DrillPart[]>> = {
  essay_outline: ESSAY_OUTLINE_PARTS,
  ethics_case: ETHICS_CASE_PARTS,
};

/** The rubric file each kind is scored against. */
export const RUBRIC_OF_KIND: Readonly<Record<DrillKind, string>> = {
  essay_outline: 'essay',
  ethics_case: 'ethics',
};

/**
 * Marks available per part.
 *
 * An outline is scored out of 40 rather than the essay's 125, because it is not
 * an essay: it carries the three rubric dimensions decidable without full prose
 * and is worth saying so. A case study is scored out of the 20 UPSC actually
 * gives one, split by the rubric's own weights — 20/20/25/20/15 of 20 marks,
 * rounded to whole marks that still sum to 20.
 */
export const PART_MAX: Readonly<Record<DrillPart, number>> = {
  thesis: 12,
  dimensions: 12,
  opening: 8,
  closing: 8,
  keywords: 4,
  stakeholders: 4,
  options: 5,
  decision: 4,
  theory: 3,
};

export function maxForKind(kind: DrillKind): number {
  return PARTS_OF_KIND[kind].reduce((total, part) => total + PART_MAX[part], 0);
}

/* ------------------------------------------------------------- generation */

/** One banked prompt, as generated. Never scored, never edited. */
export interface DrillPromptDraft {
  kind: DrillKind;
  /** The essay topic, or the one-line framing of the case. */
  promptText: string;
  /**
   * The case's situational detail. Null for an essay topic, and required for a
   * case: "you are a District Magistrate and a contractor offers..." is the
   * part that makes a case answerable as an administrator rather than as a
   * philosopher.
   */
  caseDetail: string | null;
  /** A syllabus slug from the vocabulary the request supplied, or null. */
  syllabusSlug: string | null;
  /** One clause on why this is worth drilling. Read in a log, never shown. */
  why: string;
}

export type PromptDropReason =
  | 'unknown_kind'
  | 'empty_prompt'
  | 'prompt_too_long'
  | 'case_missing_detail'
  | 'outline_has_detail'
  | 'no_syllabus_tag'
  | 'duplicate'
  | 'not_a_question';

/* ------------------------------------------------------------- evaluation */

/** One part, as written by her, sent to be scored. */
export interface SubmittedPart {
  part: DrillPart;
  content: string;
}

/** One part's verdict. `max` is echoed from `PART_MAX`, never invented. */
export interface PartVerdict {
  part: DrillPart;
  score: number;
  max: number;
  /**
   * What to fix, in one or two sentences addressed to her.
   *
   * Required, including on a part that scored full marks: "12/12" teaches
   * nothing, and the part of the feedback loop that compounds is knowing WHY
   * something worked well enough to do it again.
   */
  comment: string;
}

export interface DrillEvaluation {
  verdicts: readonly PartVerdict[];
  /** Sums the verdicts. Recomputed server-side; the model's own sum is ignored. */
  total: number;
  max: number;
  /** The one change worth making next time. Singular on purpose. */
  highestLeverageFix: string;
  feedbackMd: string;
}

export const MAX_PROMPT_CHARS = 400;
export const MAX_CASE_DETAIL_CHARS = 1400;
/**
 * Per part, and deliberately LOOSER than the device's own ceiling.
 *
 * The device gates at `DRILL_RULES.maxPartWords` (220), which at eight
 * characters a word — UPSC prose runs to "intergenerational" and
 * "constitutional" — is 1760. This bound was 1600, so a part the local gate
 * called ready could have been refused here: a 400 on twenty minutes of writing,
 * after the submit button said yes.
 *
 * The two bounds are not redundant and should not be equal. The local one shapes
 * behaviour, is free, is instant, and explains itself in words. This one is a
 * safety limit on a request body, and a safety limit that fires before the
 * behavioural one is a bug rather than a defence.
 */
export const MAX_PART_CHARS = 2000;
export const MAX_PARTS_PER_DRILL = 5;
