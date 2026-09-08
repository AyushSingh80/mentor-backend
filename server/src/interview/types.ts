/**
 * Interview question generation. FROZEN.
 *
 * Counterpart to `app/src/lib/daf-types.ts`. Written before either side and
 * edited by neither.
 *
 * ## The one rule this whole phase rests on
 *
 * **This server generates QUESTIONS and never answers.**
 *
 * A fabricated question is, at worst, one the board will not ask — she prepares
 * something unnecessary and loses an hour. A fabricated FACT is different in
 * kind: "your district's literacy rate is 74%" written into her notes is
 * something she repeats to a board that knows the real figure, in the one exam
 * where being confidently wrong about your own home is unrecoverable.
 *
 * So nothing here asks a model to state a fact about her life, her district,
 * her university or her employer. It is asked what a board would ASK. She finds
 * the answers, which is the preparation.
 *
 * The schema has no field a fact could travel in, and that is deliberate rather
 * than incidental: a `context` or `suggestedAnswer` field would be filled, and
 * once filled it would be read.
 */

export const DAF_FIELDS = [
  'full_name',
  'home_town',
  'home_district',
  'home_state',
  'schooling',
  'graduation_subject',
  'university',
  'post_graduation',
  'achievements',
  'positions_held',
  'hobbies',
  'sports',
  'employment',
  'optional_subject',
  'service_preferences',
  'cadre_preferences',
] as const;

export type DafField = (typeof DAF_FIELDS)[number];

export function isDafField(value: unknown): value is DafField {
  return typeof value === 'string' && (DAF_FIELDS as readonly string[]).includes(value);
}

export const LIKELIHOODS = ['certain', 'likely', 'possible'] as const;
export type Likelihood = (typeof LIKELIHOODS)[number];

export function isLikelihood(value: unknown): value is Likelihood {
  return typeof value === 'string' && (LIKELIHOODS as readonly string[]).includes(value);
}

/** One DAF entry, as supplied by the device. Never invented here. */
export interface DafEntryInput {
  field: DafField;
  value: string;
}

/** One generated question. Note what is NOT here: any answer, any fact. */
export interface QuestionDraft {
  /** The DAF field it follows from, or null for a general one. */
  field: DafField | null;
  /** A short noun phrase grouping related questions, e.g. "District profile". */
  area: string;
  question: string;
  likelihood: Likelihood;
}

export type QuestionDropReason =
  | 'unknown_field'
  | 'field_not_supplied'
  | 'empty_question'
  | 'question_too_long'
  | 'not_a_question'
  | 'contains_answer'
  | 'duplicate'
  | 'unknown_likelihood';

export const MAX_QUESTION_CHARS = 260;
export const MAX_AREA_CHARS = 60;
export const MAX_VALUE_CHARS = 600;
export const MAX_ENTRIES = 20;
export const MAX_QUESTIONS_PER_BATCH = 20;
