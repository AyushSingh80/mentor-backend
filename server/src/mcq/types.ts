/**
 * Domain types for the question bank.
 *
 * The type that matters most in this file is `VerifiableQuestion`. Blind
 * verification is only blind if the payload really is blind, and "remember not
 * to include the answer" is not a guarantee — it is a comment that survives
 * exactly until someone adds a field. `VerifiableQuestion` is built with an
 * explicit `Pick`, so a new field on `BankedQuestion` cannot reach the verifier
 * unless a human adds its name here. That is the difference between a rule and
 * a hope.
 */

export const DIFFICULTIES = ['foundation', 'standard', 'challenging'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export function isDifficulty(value: unknown): value is Difficulty {
  return typeof value === 'string' && (DIFFICULTIES as readonly string[]).includes(value);
}

/**
 * Question shapes. Both are statement-based and both have options that denote
 * a SUBSET of statement indices, which is what makes the structural checks
 * mechanical rather than a matter of taste: an option is either a well-formed
 * subset expression or it is not, and two options either denote the same set
 * or they do not.
 */
export const QUESTION_FORMS = ['statements_correct', 'statements_incorrect'] as const;
export type QuestionForm = (typeof QUESTION_FORMS)[number];

export interface Statement {
  /** 1-based, matching how the option text refers to it ("1 and 3 only"). */
  index: number;
  text: string;
  /**
   * The model's own verdict on this statement. Present so the key can be
   * RECOMPUTED and compared, which turns the single most common LLM MCQ
   * failure — right reasoning, wrong key-to-option translation — from an
   * invisible error into arithmetic.
   */
  isTrue: boolean;
}

/** What the generation model returns, before anything has been checked. */
export interface QuestionDraft {
  form: QuestionForm;
  stem: string;
  statements: Statement[];
  options: string[];
  answerIndex: number;
  /** One per option, including the key. Why an aspirant would pick it. */
  eliminationRationale: string[];
  /** Opaque dedup key for the underlying fact, stable across rewordings. */
  factKey: string;
  /** Where the fact can be checked: a named source, article, or report. */
  verifiabilityAnchor: string;
}

export interface VerificationVerdict {
  chosenIndex: number;
  /**
   * Deliberately two-valued. `low` is not representable, because a verifier
   * that can say "low" will say it rather than decline, and a low-confidence
   * pass is a coin flip banked as a fact. The prompt's instruction is to
   * return fewer verdicts instead.
   */
  confidence: 'high' | 'medium';
  ambiguous: boolean;
  timeDependent: boolean;
  factuallyDisputed: boolean;
}

export interface BankedQuestion extends QuestionDraft {
  /** Stable within a batch; `${requestId}:${ordinal}`. */
  id: string;
  paper: string;
  /** Opaque to this server. Never parsed, only compared and echoed. */
  topicSlug: string;
  difficulty: Difficulty;
  /** Content hash of the prompt corpus AND the JSON schema that produced it. */
  promptVersion: string;
  verifierVersion: string;
  /** `fake` questions came from the scripted runner and are not real. */
  provenance: 'model' | 'fake';
  /** Normalised-stem hash the client echoes back as `excludeStemHashes`. */
  stemHash: string;
  /** 64-bit SimHash as 16 hex chars, for near-duplicate detection. */
  simHash: string;
  verification: VerificationVerdict;
  meta?: { fake?: boolean };
}

/**
 * Exactly what the blind verifier is allowed to see.
 *
 * No `answerIndex`, no `eliminationRationale`, no `difficulty`, no
 * `factKey`, no statement truth values. A verifier that can see the key is not
 * checking the question, it is agreeing with it.
 */
export type VerifiableQuestion = Pick<BankedQuestion, 'form' | 'stem' | 'options'> & {
  statements: { index: number; text: string }[];
};

export function toVerifiable(q: QuestionDraft): VerifiableQuestion {
  return {
    form: q.form,
    stem: q.stem,
    options: [...q.options],
    // Rebuilt field by field rather than spread-and-delete: a spread would
    // carry `isTrue` through the moment someone reorders this expression.
    statements: q.statements.map((s) => ({ index: s.index, text: s.text })),
  };
}

/**
 * The exact bytes sent to the verifier.
 *
 * Exported so a test can assert on the serialised payload rather than on the
 * object graph. The property under test is "the key never crosses this
 * boundary", and only the serialised form can prove it.
 */
export function buildVerificationPayload(questions: readonly QuestionDraft[]): string {
  return JSON.stringify({ questions: questions.map(toVerifiable) }, null, 2);
}

/* ------------------------------------------------------------------ frames */

export interface McqMetaFrame {
  requestId: string;
  model: string;
  verifierModel: string;
  paper: string;
  topicSlug: string;
  topicLabel: string;
  difficulty: Difficulty;
  requested: number;
  chunkSize: number;
  plannedChunks: number;
  promptVersion: string;
  verifierVersion: string;
}

/** Why a candidate never reached the wire. One reason per rejected question. */
export type RejectionReason =
  | 'structure'
  | 'option_subsets'
  | 'elimination_power'
  | 'self_consistency'
  | 'time_varying'
  | 'length_cue'
  | 'above_option'
  | 'duplicate_fact'
  | 'duplicate_stem'
  | 'near_duplicate'
  | 'verifier_disagreed'
  | 'verifier_ambiguous'
  | 'verifier_time_dependent'
  | 'verifier_disputed'
  | 'verifier_silent'
  | 'truncated_chunk';

export interface McqSummaryFrame {
  requested: number;
  delivered: number;
  /** True whenever fewer than `requested` questions cleared. Not an error. */
  underDelivered: boolean;
  generated: number;
  rejected: number;
  rejections: Partial<Record<RejectionReason, number>>;
  /**
   * Blind verifier answered a question differently from the key it was never
   * shown. Surfaced rather than buried: sustained above ~20% means the
   * generation prompt is producing questions whose keys do not follow from
   * their own statements, and that is a prompt bug, not bad luck.
   */
  keyDisagreements: number;
  chunksRun: number;
  chunksTruncated: number;
  /** Set when the client left mid-batch and remaining chunks were skipped. */
  cancelled: boolean;
}
