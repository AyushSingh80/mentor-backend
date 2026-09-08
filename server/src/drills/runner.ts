/**
 * The two model calls, behind a swappable seam.
 *
 * Same shape as `ca/runner.ts` and `mcq/runner.ts`: a function type per call, a
 * module-level active runner, and a setter the tests and `EVAL_RUNNER=fake` use.
 * The seam is on the MODEL CALL and nothing else — the payload builders below
 * are exported and always run, so a fake runner still exercises the prompt
 * assembly that a real one would.
 *
 * Both calls are non-streaming. A batch of six prompts is one short reply, and
 * marking one attempt is another; neither is long enough for a dropped
 * connection mid-response to be the common failure, which is what made streaming
 * worth its complexity on `/evaluate` and `/ca/digest`.
 */

import { modelForTier, type ModelTier } from '../config.js';
import { providerFor } from '../providers/registry.js';
import { evaluationFormat, promptsFormat } from './schema.js';
import {
  PART_MAX,
  PARTS_OF_KIND,
  type DrillEvaluation,
  type DrillKind,
  type DrillPart,
  type DrillPromptDraft,
  type PartVerdict,
  type SubmittedPart,
} from './types.js';

/**
 * Bulk, not evaluation-tier — for GENERATION.
 *
 * Setting a topic is not the hard part; marking is. The evaluation call uses
 * the evaluation tier, which is the whole reason these are two constants rather
 * than one.
 */
export const DRILL_GENERATE_TIER: ModelTier = 'bulk';
export const DRILL_EVALUATE_TIER: ModelTier = 'evaluation';

export function generateModel(): string {
  return modelForTier(DRILL_GENERATE_TIER);
}

export function evaluateModel(): string {
  return modelForTier(DRILL_EVALUATE_TIER);
}

export interface DrillUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/* --------------------------------------------------------------- call one */

export interface GenerateRequest {
  model: string;
  system: string;
  /** How many of each kind to set. */
  want: readonly { kind: DrillKind; count: number }[];
  /** Slugs the model may tag with, and the only ones. Advisory labels included. */
  vocabulary: readonly { slug: string; label: string }[];
  /** Prompts already banked, so the batch does not restate one. */
  excludePrompts: readonly string[];
  maxTokens: number;
  requestId: string;
  signal: AbortSignal;
}

export interface GenerateResult {
  /** Null when the reply could not be parsed or was truncated. */
  drafts: DrillPromptDraft[] | null;
  stopReason: string | null;
  usage: DrillUsage;
  provenance: 'model' | 'fake';
}

export type GenerateRunner = (request: GenerateRequest) => Promise<GenerateResult>;

/**
 * The user turn for call one.
 *
 * Exported and tested, because a payload builder that silently stops including
 * the exclusion list produces a batch of duplicates that looks perfectly
 * healthy — six prompts arrived, none of them new.
 */
export function buildGeneratePayload(request: {
  want: readonly { kind: DrillKind; count: number }[];
  vocabulary: readonly { slug: string; label: string }[];
  excludePrompts: readonly string[];
}): string {
  const lines: string[] = ['Set the following:'];

  for (const entry of request.want) {
    lines.push(
      `  - ${entry.count} × ${entry.kind === 'essay_outline' ? 'essay topic (essay_outline)' : 'ethics case (ethics_case)'}`,
    );
  }

  lines.push('', 'Syllabus slugs in scope (use these verbatim, or null):');
  for (const entry of request.vocabulary) {
    lines.push(entry.label === entry.slug ? `  - ${entry.slug}` : `  - ${entry.slug}  (${entry.label})`);
  }

  if (request.excludePrompts.length > 0) {
    lines.push(
      '',
      'Already banked — do NOT set these again, or a restatement of one:',
      ...request.excludePrompts.map((prompt) => `  - ${prompt}`),
    );
  }

  return lines.join('\n');
}

/* --------------------------------------------------------------- call two */

export interface EvaluateRequest {
  model: string;
  system: string;
  kind: DrillKind;
  promptText: string;
  caseDetail: string | null;
  parts: readonly SubmittedPart[];
  maxTokens: number;
  requestId: string;
  signal: AbortSignal;
}

export interface EvaluateResult {
  evaluation: DrillEvaluation | null;
  stopReason: string | null;
  usage: DrillUsage;
  provenance: 'model' | 'fake';
}

export type EvaluateRunner = (request: EvaluateRequest) => Promise<EvaluateResult>;

/**
 * The user turn for call two.
 *
 * The per-part maximum is stated IN THE PAYLOAD rather than left to the schema,
 * because the schema can only say "a number" — the ceiling is per part and the
 * model has to be told which ceiling applies to the part in front of it. The
 * pipeline clamps anyway; this is what makes the clamp rarely necessary.
 */
export function buildEvaluatePayload(request: {
  kind: DrillKind;
  promptText: string;
  caseDetail: string | null;
  parts: readonly SubmittedPart[];
}): string {
  const lines: string[] = [
    request.kind === 'essay_outline'
      ? 'She was set this essay topic and asked for an OUTLINE, not a full essay:'
      : 'She was set this ethics case:',
    '',
    request.promptText,
  ];

  if (request.caseDetail !== null && request.caseDetail.trim() !== '') {
    lines.push('', request.caseDetail);
  }

  lines.push('', `--- what she wrote (${request.parts.length} parts) ---`);

  for (const part of request.parts) {
    lines.push('', `## ${part.part}  (out of ${PART_MAX[part.part]})`, '', part.content);
  }

  lines.push(
    '',
    '--- ---',
    `Return one verdict per part above, using exactly these keys: ${request.parts
      .map((part) => part.part)
      .join(', ')}.`,
  );

  return lines.join('\n');
}

/* -------------------------------------------------------- provider runners */

const providerGenerateRunner: GenerateRunner = async (request) => {
  const response = await providerFor(DRILL_GENERATE_TIER).structured({
    model: request.model,
    system: request.system,
    user: buildGeneratePayload(request),
    schema: promptsFormat.schema,
    schemaName: 'drill_prompts',
    maxTokens: request.maxTokens,
    // Topics and a vocabulary of syllabus slugs. None of her writing is here.
    dataClass: 'public',
    requestId: request.requestId,
    signal: request.signal,
  });

  const parsed = response.json === null ? null : promptsFormat.parse(response.json);
  return {
    drafts: parsed?.ok === true ? coerceDrafts(parsed.value.prompts) : null,
    stopReason: response.stopReason,
    usage: response.usage,
    provenance: 'model',
  };
};

const providerEvaluateRunner: EvaluateRunner = async (request) => {
  const response = await providerFor(DRILL_EVALUATE_TIER).structured({
    model: request.model,
    system: request.system,
    user: buildEvaluatePayload(request),
    schema: evaluationFormat.schema,
    schemaName: 'drill_evaluation',
    maxTokens: request.maxTokens,
    // HER OWN WRITING, verbatim, and one of only two calls that carry any.
    // The tier already says this is the expensive model; the data class is
    // what will say which endpoints it may be sent to.
    dataClass: 'personal',
    requestId: request.requestId,
    signal: request.signal,
  });

  const parsed = response.json === null ? null : evaluationFormat.parse(response.json);
  return {
    evaluation:
      parsed?.ok === true ? coerceEvaluation(parsed.value, request.kind) : null,
    stopReason: response.stopReason,
    usage: response.usage,
    provenance: 'model',
  };
};

/* ------------------------------------------------------------- coercion */

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The model's prompt list, coerced without judgement.
 *
 * Shape only. Whether a topic is any good, whether a case has a real dilemma
 * and whether the slug resolves are all `pipeline.ts`'s business — a coercer
 * that also filtered would put two different reasons for dropping a prompt in
 * two different files, and the drop histogram would stop being trustworthy.
 */
export function coerceDrafts(value: unknown): DrillPromptDraft[] {
  if (!Array.isArray(value)) return [];

  const drafts: DrillPromptDraft[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;

    const kind = text(record.kind);
    const promptText = text(record.promptText);
    if (kind === null || promptText === null) continue;

    drafts.push({
      kind: kind as DrillKind,
      promptText,
      caseDetail: text(record.caseDetail),
      syllabusSlug: text(record.syllabusSlug),
      why: text(record.why) ?? '',
    });
  }
  return drafts;
}

/**
 * The model's verdicts, coerced and CLAMPED to each part's own ceiling.
 *
 * `total` is recomputed from the clamped verdicts and the model's own sum, if
 * it offered one, is discarded. A total that disagrees with its parts is the
 * one error a reader cannot detect: she sees 34/40, adds the parts to 29, and
 * has no way to know which number the app believes.
 */
export function coerceEvaluation(
  value: {
    verdicts?: unknown;
    highestLeverageFix?: unknown;
    feedbackMarkdown?: unknown;
  },
  kind: DrillKind,
): DrillEvaluation | null {
  if (!Array.isArray(value.verdicts)) return null;

  const allowed = new Set<string>(PARTS_OF_KIND[kind]);
  const seen = new Set<string>();
  const verdicts: PartVerdict[] = [];

  for (const entry of value.verdicts) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;

    const part = text(record.part);
    // A verdict for a part of the OTHER kind is dropped rather than kept: it
    // cannot be stored (`drill_scores` is keyed on the drill's own parts) and
    // counting it into the total would inflate a score for work not done.
    if (part === null || !allowed.has(part) || seen.has(part)) continue;
    seen.add(part);

    const max = PART_MAX[part as DrillPart];
    const raw = typeof record.score === 'number' && Number.isFinite(record.score) ? record.score : 0;
    verdicts.push({
      part: part as DrillPart,
      score: Math.min(Math.max(raw, 0), max),
      max,
      comment: text(record.comment) ?? '',
    });
  }

  if (verdicts.length === 0) return null;

  return {
    verdicts,
    total: verdicts.reduce((sum, verdict) => sum + verdict.score, 0),
    max: verdicts.reduce((sum, verdict) => sum + verdict.max, 0),
    highestLeverageFix: text(value.highestLeverageFix) ?? '',
    feedbackMd: text(value.feedbackMarkdown) ?? '',
  };
}

/* ------------------------------------------------------------------ seams */

let activeGenerateRunner: GenerateRunner = providerGenerateRunner;
let activeEvaluateRunner: EvaluateRunner = providerEvaluateRunner;

/** Test/dev seam. Passing null restores the real provider-backed runner. */
export function setGenerateRunner(runner: GenerateRunner | null): void {
  activeGenerateRunner = runner ?? providerGenerateRunner;
}

export function setEvaluateRunner(runner: EvaluateRunner | null): void {
  activeEvaluateRunner = runner ?? providerEvaluateRunner;
}

export function currentGenerateRunner(): GenerateRunner {
  return activeGenerateRunner;
}

export function currentEvaluateRunner(): EvaluateRunner {
  return activeEvaluateRunner;
}
