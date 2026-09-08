/**
 * Batch orchestration: chunking, validation ordering, spend, cancellation.
 *
 * Deliberately knows nothing about HTTP. It takes runners and an emit
 * callback, so the whole thing — including the disconnect path and the
 * truncation path — is testable without a socket. `routes/mcq.ts` supplies
 * the sockets, the auth and the caps; this file supplies the judgement.
 *
 * The two properties worth stating up front:
 *
 *  1. UNDER-DELIVERY IS A SUCCESS. Asking for twenty and emitting eleven is a
 *     normal outcome, reported in the summary, not an error. There is no path
 *     in this file that lowers a standard to hit a count.
 *
 *  2. NOTHING UNVALIDATED REACHES THE WIRE. A question is emitted only after
 *     it has cleared every free check, been screened against the bank, and
 *     been answered independently by a model that never saw its key.
 */

import { BankIndex } from './bank-index.js';
import { simHash64, simHashHex, stemHash } from './dedupe.js';
import type { GenerationRequest, McqRunner, McqUsage, VerificationRunner } from './runner.js';
import { ZERO_USAGE, buildVerificationPayload } from './runner.js';
import type {
  BankedQuestion,
  Difficulty,
  McqSummaryFrame,
  QuestionDraft,
  RejectionReason,
} from './types.js';
import { validateQuestion } from './validate.js';

/**
 * Five per chunk.
 *
 * Small enough that a truncation, a parse failure or a disconnect costs one
 * fifth of the batch rather than all of it, and large enough that the cached
 * system prompt is amortised over several questions. It is also the unit of
 * billing: `recordUsage` runs per chunk, so a batch that dies at chunk three
 * of four has paid for three and recorded three.
 */
export const CHUNK_SIZE = 5;

export const MIN_COUNT = 5;
export const MAX_COUNT = 30;
export const DEFAULT_COUNT = 20;

/**
 * Extra chunks allowed to top up after rejections.
 *
 * Topping up is the right response to a disagreement — a fresh chunk costs
 * half what adjudicating a bad one would, and she needs twenty good questions
 * rather than these particular twenty. But an unbounded top-up loop on a topic
 * the model handles badly is exactly the runaway that empties the shared
 * wallet, so the budget is fixed and small. When it runs out, the endpoint
 * under-delivers, which is a correct outcome.
 */
export const MAX_TOPUP_CHUNKS = 2;

/** Output tokens to allow per requested question, plus a fixed envelope. */
const OUTPUT_TOKENS_PER_QUESTION = 900;
const OUTPUT_TOKENS_ENVELOPE = 500;
const VERIFY_TOKENS_PER_QUESTION = 300;
const VERIFY_TOKENS_ENVELOPE = 400;

export function generationMaxTokens(count: number): number {
  return count * OUTPUT_TOKENS_PER_QUESTION + OUTPUT_TOKENS_ENVELOPE;
}

export function verificationMaxTokens(count: number): number {
  return count * VERIFY_TOKENS_PER_QUESTION + VERIFY_TOKENS_ENVELOPE;
}

export function plannedChunksFor(count: number): number {
  return Math.max(1, Math.ceil(count / CHUNK_SIZE));
}

export interface PipelineTopic {
  slug: string;
  label: string;
  section?: string;
}

export interface PipelineInput {
  requestId: string;
  paper: string;
  topic: PipelineTopic;
  difficulty: Difficulty;
  count: number;
  excludeFactKeys: string[];
  excludeStemHashes: string[];
  model: string;
  verifierModel: string;
  generationSystem: string;
  verifierSystem: string;
  promptVersion: string;
  verifierVersion: string;
}

export interface ChunkUsageEvent {
  phase: 'generate' | 'verify';
  model: string;
  usage: McqUsage;
}

export interface PipelineDeps {
  generate: McqRunner;
  verify: VerificationRunner;
  /** Called once per question that has cleared the FULL pipeline. */
  emitQuestion: (question: BankedQuestion) => void;
  /** Awaited, so a chunk is billed before the next one is allowed to start. */
  onChunkUsage: (event: ChunkUsageEvent) => Promise<void>;
  /** True once the client is gone. Checked before every chunk and every call. */
  isCancelled: () => boolean;
  signal: AbortSignal;
  log?: (message: string, detail?: unknown) => void;
}

export interface PipelineResult {
  summary: McqSummaryFrame;
  totalUsage: McqUsage;
}

function addUsage(a: McqUsage, b: McqUsage): McqUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
  };
}

/** The user-turn text. The system prompt carries all the standing rules. */
export function buildInstruction(input: PipelineInput, count: number): string {
  return [
    `Paper: ${input.paper}`,
    // The slug is an opaque dedup key. The prompt is driven by the LABEL,
    // because the slug is the app's identifier and may be an abbreviation, a
    // path, or a hash — interpreting it here would couple this server to a
    // syllabus taxonomy it does not own and must not parse.
    `Topic: ${input.topic.label}`,
    input.topic.section ? `Section: ${input.topic.section}` : null,
    `Difficulty: ${input.difficulty}`,
    '',
    `Write up to ${count} questions on this topic.`,
    'Return fewer if you are not certain of them. Fewer is correct.',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

export async function runMcqPipeline(
  input: PipelineInput,
  deps: PipelineDeps,
): Promise<PipelineResult> {
  const index = new BankIndex({
    factKeys: input.excludeFactKeys,
    stemHashes: input.excludeStemHashes,
  });

  const rejections: Partial<Record<RejectionReason, number>> = {};
  const noteRejection = (reason: RejectionReason, detail: string): void => {
    rejections[reason] = (rejections[reason] ?? 0) + 1;
    deps.log?.(`[mcq] rejected (${reason}): ${detail}`);
  };

  let totalUsage = ZERO_USAGE;
  let delivered = 0;
  let generated = 0;
  let keyDisagreements = 0;
  let chunksRun = 0;
  let chunksTruncated = 0;
  let requestedSoFar = 0;
  let cancelled = false;

  const planned = plannedChunksFor(input.count);
  const maxChunks = planned + MAX_TOPUP_CHUNKS;

  const bill = async (phase: 'generate' | 'verify', model: string, usage: McqUsage): Promise<void> => {
    totalUsage = addUsage(totalUsage, usage);
    // Awaited on purpose. If the process dies between the model call and the
    // ledger write, the money is spent and unrecorded; keeping the write on
    // the critical path is what makes "dies at chunk 3 bills 3" true.
    await deps.onChunkUsage({ phase, model, usage });
  };

  while (delivered < input.count && chunksRun < maxChunks) {
    if (deps.isCancelled()) {
      cancelled = true;
      break;
    }

    const remaining = input.count - delivered;
    const askFor = Math.min(CHUNK_SIZE, remaining);

    /* ------------------------------------------- generation, with one retry */

    let drafts: QuestionDraft[] | null = null;
    let provenance: 'model' | 'fake' = 'model';
    let size = askFor;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (deps.isCancelled()) {
        cancelled = true;
        break;
      }

      chunksRun += 1;
      const request: GenerationRequest = {
        model: input.model,
        system: input.generationSystem,
        instruction: buildInstruction(input, size),
        count: size,
        maxTokens: generationMaxTokens(size),
        ordinalOffset: requestedSoFar,
        topicSlug: input.topic.slug,
        difficulty: input.difficulty,
        requestId: input.requestId,
        signal: deps.signal,
      };
      requestedSoFar += size;

      const result = await deps.generate(request);
      await bill('generate', input.model, result.usage);
      provenance = result.provenance;

      if (result.stopReason === 'max_tokens') {
        // The reply is a truncated JSON document. Salvaging the objects that
        // happen to be complete is the tempting move and the wrong one: the
        // last object is cut mid-field, and a question whose options array
        // stopped early is a question with two options and a key pointing off
        // the end. Discard the WHOLE chunk, bill it, halve and retry once.
        chunksTruncated += 1;
        for (let i = 0; i < size; i += 1) {
          noteRejection('truncated_chunk', `chunk truncated at ${request.maxTokens} tokens`);
        }
        deps.log?.(`[mcq] chunk truncated; retrying at half size`, { size });
        size = Math.max(1, Math.floor(size / 2));
        drafts = null;
        continue;
      }

      drafts = result.drafts;
      break;
    }

    if (cancelled) break;
    if (drafts === null) {
      // Truncated twice, or unparseable. Do not spin on it.
      if (chunksRun >= maxChunks) break;
      continue;
    }

    generated += drafts.length;

    /* ---------------------------------- free checks, then the free pre-screen */

    const survivors: QuestionDraft[] = [];
    for (const draft of drafts) {
      if (delivered + survivors.length >= input.count) break;

      const verdict = validateQuestion(draft, { difficulty: input.difficulty });
      if (!verdict.ok) {
        noteRejection(verdict.reason, verdict.detail);
        continue;
      }

      // Step 5 of the pipeline, run here as well as at the end. It is free,
      // and paying a model to verify a question the bank already holds is
      // pure waste. The authoritative commit still happens after verification.
      const duplicate = index.find({ stem: draft.stem, factKey: draft.factKey });
      if (duplicate) {
        noteRejection(duplicate.kind, duplicate.detail);
        continue;
      }

      // Provisionally claimed so two questions inside the SAME chunk cannot
      // both pass on the same factKey.
      index.add({ stem: draft.stem, factKey: draft.factKey });
      survivors.push(draft);
    }

    if (survivors.length === 0) continue;
    if (deps.isCancelled()) {
      cancelled = true;
      break;
    }

    /* -------------------------------------------- the one paid check per chunk */

    const payload = buildVerificationPayload(survivors);
    const verification = await deps.verify({
      model: input.verifierModel,
      system: input.verifierSystem,
      payload,
      count: survivors.length,
      maxTokens: verificationMaxTokens(survivors.length),
      ordinalOffset: requestedSoFar - drafts.length,
      topicSlug: input.topic.slug,
      requestId: input.requestId,
      signal: deps.signal,
    });
    await bill('verify', input.verifierModel, verification.usage);

    if (verification.stopReason === 'max_tokens' || verification.verdicts === null) {
      // Same rule as generation: a partial verdict list is not a partial
      // result, it is an unknown one. Every survivor in this chunk is dropped.
      chunksTruncated += verification.stopReason === 'max_tokens' ? 1 : 0;
      for (const _ of survivors) noteRejection('truncated_chunk', 'verification returned nothing');
      continue;
    }

    const byIndex = new Map<number, (typeof verification.verdicts)[number]>();
    for (const verdict of verification.verdicts) byIndex.set(verdict.questionIndex, verdict);

    for (let i = 0; i < survivors.length; i += 1) {
      const draft = survivors[i] as QuestionDraft;
      const verdict = byIndex.get(i);

      if (!verdict) {
        // The prompt tells the verifier to omit rather than guess. An omitted
        // verdict is an unchecked question, and unchecked is rejected.
        noteRejection('verifier_silent', 'no verdict returned for this question');
        continue;
      }

      if (verdict.chosenIndex !== draft.answerIndex) {
        // NEVER RE-KEY. The elimination rationales were written around the
        // original key; swapping the answer leaves four explanations that
        // argue for a different option than the one now marked correct, which
        // is a worse artefact than either candidate. Drop it and top up.
        keyDisagreements += 1;
        noteRejection(
          'verifier_disagreed',
          `key ${draft.answerIndex}, blind verifier chose ${verdict.chosenIndex}`,
        );
        continue;
      }

      // Each flag rejects on its own, INCLUDING when the answer matched. An
      // ambiguous question that both models happen to answer the same way is
      // still ambiguous, and in a spaced-repetition bank it trains a
      // confidently wrong instinct she has no way to trace.
      if (verdict.ambiguous) {
        noteRejection('verifier_ambiguous', 'verifier flagged the question as ambiguous');
        continue;
      }
      if (verdict.timeDependent) {
        noteRejection('verifier_time_dependent', 'verifier flagged the answer as time-dependent');
        continue;
      }
      if (verdict.factuallyDisputed) {
        noteRejection('verifier_disputed', 'verifier flagged the fact as disputed');
        continue;
      }

      delivered += 1;
      const question: BankedQuestion = {
        ...draft,
        id: `${input.requestId}:${String(delivered).padStart(2, '0')}`,
        paper: input.paper,
        topicSlug: input.topic.slug,
        difficulty: input.difficulty,
        promptVersion: input.promptVersion,
        verifierVersion: input.verifierVersion,
        provenance,
        stemHash: stemHash(draft.stem),
        simHash: simHashHex(simHash64(draft.stem)),
        verification: {
          chosenIndex: verdict.chosenIndex,
          confidence: verdict.confidence,
          ambiguous: verdict.ambiguous,
          timeDependent: verdict.timeDependent,
          factuallyDisputed: verdict.factuallyDisputed,
        },
        ...(provenance === 'fake' ? { meta: { fake: true } } : {}),
      };

      deps.emitQuestion(question);
      if (delivered >= input.count) break;
    }
  }

  const rejected = Object.values(rejections).reduce((sum, n) => sum + (n ?? 0), 0);

  if (generated > 0 && keyDisagreements / generated > 0.2) {
    // Loud on purpose. A sustained disagreement rate this high is not bad
    // luck, it is a generation prompt producing keys that do not follow from
    // its own statements — and that is a fixable bug rather than a mystery
    // about why the bank fills slowly.
    deps.log?.(
      `[mcq] HIGH KEY DISAGREEMENT: ${keyDisagreements}/${generated} questions were keyed differently by the blind verifier. The generation prompt needs work.`,
    );
  }

  return {
    totalUsage,
    summary: {
      requested: input.count,
      delivered,
      underDelivered: delivered < input.count,
      generated,
      rejected,
      rejections,
      keyDisagreements,
      chunksRun,
      chunksTruncated,
      cancelled,
    },
  };
}
