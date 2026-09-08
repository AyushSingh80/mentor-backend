/**
 * The model boundary for question banking.
 *
 * Two seams, both swappable: `setMcqRunner` for generation and
 * `setVerificationRunner` for blind verification. Two rather than one because
 * the fake needs to make them DISAGREE — a fake pair that always agrees would
 * leave the single most expensive branch of the pipeline, the one that decides
 * whether to drop a question, never exercised outside production.
 *
 * Both calls are non-streaming and structured. A batch reply is a list, and
 * fence-scraping a list is how you lose nineteen of twenty questions while
 * reporting success (see the note on `extractTrailingJson`).
 *
 * Neither call names a provider. Both go through the structured port, which the
 * registry binds to whatever `PROVIDER_BULK` selected at boot; the schema and
 * its parser stay here, because the schema is hashed into `promptVersion` and
 * belongs to the question bank, not to whoever is serving it.
 */

import { modelForTier, type ModelTier } from '../config.js';
import { providerFor } from '../providers/registry.js';
import type { Difficulty, QuestionDraft } from './types.js';
import { buildVerificationPayload } from './types.js';
import { generationFormat, verificationFormat } from './schema.js';

/** MCQ runs on the bulk tier: high volume, and checked twice besides. */
export const MCQ_TIER: ModelTier = 'bulk';

export interface McqUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export const ZERO_USAGE: McqUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

export interface GenerationRequest {
  model: string;
  system: string;
  instruction: string;
  /** How many questions this chunk asks for. */
  count: number;
  maxTokens: number;
  /** Questions already requested in this batch. Seeds the fake runner. */
  ordinalOffset: number;
  topicSlug: string;
  difficulty: Difficulty;
  requestId: string;
  signal: AbortSignal;
}

export interface GenerationResult {
  /** Null when the reply could not be parsed or was truncated. */
  drafts: QuestionDraft[] | null;
  /** `'max_tokens'` means the chunk is unusable, whatever parsed. */
  stopReason: string | null;
  usage: McqUsage;
  provenance: 'model' | 'fake';
}

export type McqRunner = (request: GenerationRequest) => Promise<GenerationResult>;

export interface VerificationRequest {
  model: string;
  system: string;
  /**
   * The blind payload — stem, statements-without-verdicts, options. Built by
   * `buildVerificationPayload`, which is the only thing allowed to construct
   * it, so there is a single place where blindness can be verified.
   */
  payload: string;
  count: number;
  maxTokens: number;
  ordinalOffset: number;
  topicSlug: string;
  requestId: string;
  signal: AbortSignal;
}

export interface RawVerdict {
  questionIndex: number;
  chosenIndex: number;
  confidence: 'high' | 'medium';
  ambiguous: boolean;
  timeDependent: boolean;
  factuallyDisputed: boolean;
}

export interface VerificationResult {
  verdicts: RawVerdict[] | null;
  stopReason: string | null;
  usage: McqUsage;
}

export type VerificationRunner = (request: VerificationRequest) => Promise<VerificationResult>;

/* -------------------------------------------------------- provider runners */

const providerMcqRunner: McqRunner = async (request) => {
  const response = await providerFor(MCQ_TIER).structured({
    model: request.model,
    system: request.system,
    user: request.instruction,
    schema: generationFormat.schema,
    schemaName: 'mcq_generation',
    // NOT the hardcoded 4096 that /evaluate uses. Five questions with three
    // statements and four rationales each is several thousand output tokens;
    // at 4096 every chunk truncates, and a truncated chunk is a chunk that
    // was paid for and delivered nothing.
    maxTokens: request.maxTokens,
    // Syllabus topics and the model's own facts. Nothing of hers is in here.
    dataClass: 'public',
    requestId: request.requestId,
    signal: request.signal,
  });

  // Parsed HERE and not in the adapter. `generationFormat.parse` never throws,
  // returning a discriminated result instead, so a malformed reply still
  // reports the tokens the provider already billed for it.
  const parsed = response.json === null ? null : generationFormat.parse(response.json);

  return {
    drafts: parsed?.ok === true ? coerceDrafts(parsed.value.questions) : null,
    stopReason: response.stopReason,
    usage: response.usage,
    provenance: 'model',
  };
};

const providerVerificationRunner: VerificationRunner = async (request) => {
  const response = await providerFor(MCQ_TIER).structured({
    model: request.model,
    system: request.system,
    user: request.payload,
    schema: verificationFormat.schema,
    schemaName: 'mcq_verification',
    maxTokens: request.maxTokens,
    dataClass: 'public',
    requestId: request.requestId,
    signal: request.signal,
  });

  const parsed = response.json === null ? null : verificationFormat.parse(response.json);

  return {
    verdicts: parsed?.ok === true ? coerceVerdicts(parsed.value.verdicts) : null,
    stopReason: response.stopReason,
    usage: response.usage,
  };
};

/* ------------------------------------------------------------- coercion */

/**
 * Structured outputs constrain the shape but this code still treats the reply
 * as untrusted: everything past this point is validated, and validation is
 * only meaningful if the objects it receives are the objects that arrived.
 * Anything that is not an object is dropped here rather than throwing, so one
 * malformed entry costs one question and not the whole chunk.
 */
function coerceDrafts(value: unknown): QuestionDraft[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is QuestionDraft => typeof item === 'object' && item !== null);
}

function coerceVerdicts(value: unknown): RawVerdict[] {
  if (!Array.isArray(value)) return [];
  const out: RawVerdict[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const v = item as Record<string, unknown>;
    if (!Number.isInteger(v.questionIndex) || !Number.isInteger(v.chosenIndex)) continue;
    out.push({
      questionIndex: v.questionIndex as number,
      chosenIndex: v.chosenIndex as number,
      confidence: v.confidence === 'medium' ? 'medium' : 'high',
      // Missing flags are treated as "not flagged" only because the schema
      // makes them required; a flag that arrives as anything truthy counts.
      ambiguous: v.ambiguous === true,
      timeDependent: v.timeDependent === true,
      factuallyDisputed: v.factuallyDisputed === true,
    });
  }
  return out;
}

/* ---------------------------------------------------------------- seams */

let activeMcqRunner: McqRunner = providerMcqRunner;
let activeVerificationRunner: VerificationRunner = providerVerificationRunner;

/** Test/dev seam. Passing null restores the real provider-backed runner. */
export function setMcqRunner(runner: McqRunner | null): void {
  activeMcqRunner = runner ?? providerMcqRunner;
}

/** Second seam, so a fake verifier can disagree with a fake generator. */
export function setVerificationRunner(runner: VerificationRunner | null): void {
  activeVerificationRunner = runner ?? providerVerificationRunner;
}

export function currentMcqRunner(): McqRunner {
  return activeMcqRunner;
}

export function currentVerificationRunner(): VerificationRunner {
  return activeVerificationRunner;
}

export function mcqModel(): string {
  return modelForTier(MCQ_TIER);
}

export { buildVerificationPayload };
