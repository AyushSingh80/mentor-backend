/**
 * The one model call, behind a swappable seam.
 *
 * Same shape as every other runner here. Non-streaming: a batch of questions is
 * one short reply.
 */

import { modelForTier, type ModelTier } from '../config.js';
import { providerFor } from '../providers/registry.js';
import { questionsFormat } from './schema.js';
import { isDafField, isLikelihood, type DafEntryInput, type QuestionDraft } from './types.js';

/**
 * Bulk, not evaluation tier.
 *
 * Producing "what is your district known for?" is not the hard part of this
 * feature — the safety rule is, and that is enforced mechanically in
 * `pipeline.ts` rather than by model capability.
 */
export const INTERVIEW_TIER: ModelTier = 'bulk';

export function interviewModel(): string {
  return modelForTier(INTERVIEW_TIER);
}

export interface InterviewUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface GenerateRequest {
  model: string;
  system: string;
  /** Only the entries she has actually filled in. */
  entries: readonly DafEntryInput[];
  /** Questions already banked, so the batch does not restate one. */
  excludeQuestions: readonly string[];
  take: number;
  maxTokens: number;
  requestId: string;
  signal: AbortSignal;
}

export interface GenerateResult {
  drafts: QuestionDraft[] | null;
  stopReason: string | null;
  usage: InterviewUsage;
  provenance: 'model' | 'fake';
}

export type GenerateRunner = (request: GenerateRequest) => Promise<GenerateResult>;

/**
 * The user turn.
 *
 * Exported and tested, because a payload builder that silently stops including
 * the exclusion list produces a batch of duplicates that looks perfectly
 * healthy — eight questions arrived, none of them new.
 */
export function buildGeneratePayload(request: {
  entries: readonly DafEntryInput[];
  excludeQuestions: readonly string[];
  take: number;
}): string {
  const lines: string[] = ['Her DAF entries, as she has filled them in:', ''];

  for (const entry of request.entries) {
    lines.push(`${entry.field}: ${entry.value}`);
  }

  lines.push(
    '',
    `Write at most ${request.take} questions, covering the areas these entries open.`,
    'Only fields listed above. A question about a field she left blank is one she cannot prepare for.',
  );

  if (request.excludeQuestions.length > 0) {
    lines.push(
      '',
      'Already banked — do NOT write these again, or a rewording of one:',
      ...request.excludeQuestions.map((question) => `  - ${question}`),
    );
  }

  return lines.join('\n');
}

const providerGenerateRunner: GenerateRunner = async (request) => {
  const response = await providerFor(INTERVIEW_TIER).structured({
    model: request.model,
    system: request.system,
    user: buildGeneratePayload(request),
    schema: questionsFormat.schema,
    schemaName: 'interview_questions',
    maxTokens: request.maxTokens,
    // HER DAF, verbatim: home district, hobbies, service preferences, the
    // employment history she filled in. Public in the sense that the board
    // will read it, personal in every sense that matters to a provider choice.
    dataClass: 'personal',
    requestId: request.requestId,
    signal: request.signal,
  });

  const parsed = response.json === null ? null : questionsFormat.parse(response.json);
  return {
    drafts: parsed?.ok === true ? coerceDrafts(parsed.value.questions) : null,
    stopReason: response.stopReason,
    usage: response.usage,
    provenance: 'model',
  };
};

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Shape only. Whether a question is any good, whether it smuggles a fact and
 * whether its field was supplied are all `pipeline.ts`'s business — a coercer
 * that also filtered would put two reasons for dropping a question in two
 * files, and the drop histogram would stop being trustworthy.
 */
export function coerceDrafts(value: unknown): QuestionDraft[] {
  if (!Array.isArray(value)) return [];

  const drafts: QuestionDraft[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;

    const question = text(record.question);
    const area = text(record.area);
    if (question === null || area === null) continue;

    const field = text(record.field);
    const likelihood = text(record.likelihood);

    drafts.push({
      field: field !== null && isDafField(field) ? field : null,
      area,
      question,
      likelihood: likelihood !== null && isLikelihood(likelihood) ? likelihood : 'possible',
    });
  }
  return drafts;
}

let active: GenerateRunner = providerGenerateRunner;

/** Test/dev seam. Passing null restores the real provider-backed runner. */
export function setInterviewRunner(runner: GenerateRunner | null): void {
  active = runner ?? providerGenerateRunner;
}

export function currentInterviewRunner(): GenerateRunner {
  return active;
}
