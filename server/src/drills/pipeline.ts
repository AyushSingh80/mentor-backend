/**
 * Generation and evaluation, orchestrated.
 *
 * Two entry points, deliberately separate: `runGeneration` sets prompts and
 * `runEvaluation` marks one attempt. They share nothing but their usage
 * accounting, and merging them would put a batch's failure modes and an
 * attempt's failure modes in one place where neither is legible.
 *
 * ## What this file is for
 *
 * The model's output is a proposal. Everything here is the server deciding
 * which parts of that proposal earn a slot, deterministically, before anything
 * reaches the device. Every drop is counted and named — a filter she cannot see
 * teaches nothing, and a batch that silently returns two prompts instead of six
 * is indistinguishable from a quiet model.
 */

import {
  MAX_CASE_DETAIL_CHARS,
  MAX_PROMPT_CHARS,
  PARTS_OF_KIND,
  isDrillKind,
  maxForKind,
  type DrillEvaluation,
  type DrillKind,
  type DrillPromptDraft,
  type PromptDropReason,
  type SubmittedPart,
} from './types.js';
import type {
  DrillUsage,
  EvaluateRunner,
  GenerateRunner,
} from './runner.js';

/* ------------------------------------------------------------------ usage */

const ZERO_USAGE: DrillUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

/* ------------------------------------------------------------- generation */

export interface AcceptedPrompt extends DrillPromptDraft {
  /** Normalised form used for duplicate detection. Never persisted. */
  fingerprint: string;
}

export interface PromptDrop {
  promptText: string;
  reason: PromptDropReason;
  detail: string;
}

export interface GenerationSummary {
  requested: number;
  returned: number;
  kept: number;
  dropped: number;
  dropReasons: Partial<Record<PromptDropReason, number>>;
  /** Fewer than asked for is a CORRECT outcome, not an error. */
  underDelivered: boolean;
}

export interface GenerationOutcome {
  prompts: AcceptedPrompt[];
  drops: PromptDrop[];
  summary: GenerationSummary;
  usage: DrillUsage;
  provenance: 'model' | 'fake';
  stopReason: string | null;
}

/** Words that carry no identity. The same list `ca/select.ts` uses. */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it', 'its', 'of', 'on',
  'or', 'over', 'that', 'the', 'to', 'up', 'with', 'after', 'amid', 'new', 'says', 'said',
  'can', 'does', 'do', 'has', 'have', 'was', 'were', 'will', 'not', 'but', 'this', 'than',
]);

/**
 * A topic's identity, for duplicate detection.
 *
 * Sorted significant word stems, the same device `ca/select.ts` uses on
 * headlines. What it catches is a REORDERING: "Order, disorder and the state"
 * and "The state, order and disorder" collapse to one fingerprint, and an exact
 * match would bank both.
 *
 * What it does NOT catch is a synonym rewrite. "Is development compatible with
 * ecology" and "Can ecology and development coexist" are the same prompt to a
 * reader and different stem sets to this function, because the words genuinely
 * differ. Catching that needs an embedding, which is a paid call to save a
 * prompt worth two cents — the wrong trade. The prompt itself is told not to
 * restate anything in the exclusion list, and this is the mechanical backstop
 * for the case where it does so verbatim or in a different order.
 *
 * Crude on purpose in the other direction too: a false positive costs one
 * prompt out of six, a false negative costs her twenty minutes rediscovering
 * that she has already written this outline.
 */
export function promptFingerprint(promptText: string): string {
  const words = promptText
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 3 && !STOPWORDS.has(word))
    .map((word) => word.replace(/(ing|ed|es|s)$/, ''))
    .filter((word) => word.length > 3);
  const stems = [...new Set(words)].sort().slice(0, 10).join('-');
  // A prompt in a script the strip does not cover would otherwise fingerprint
  // to the empty string and be "a duplicate" of every other such prompt.
  return stems === '' ? promptText.toLowerCase().replace(/\s+/g, ' ').trim() : stems;
}

export interface GenerationInput {
  requestId: string;
  want: readonly { kind: DrillKind; count: number }[];
  vocabulary: readonly { slug: string; label: string }[];
  /** Prompt texts already banked on the device. */
  excludePrompts: readonly string[];
  model: string;
  system: string;
}

export interface GenerationDeps {
  generate: GenerateRunner;
  signal: AbortSignal;
  log?: (message: string) => void;
}

/** Output tokens to allow per prompt, plus an envelope for the case detail. */
function generateMaxTokens(count: number): number {
  return 700 + count * 500;
}

export async function runGeneration(
  input: GenerationInput,
  deps: GenerationDeps,
): Promise<GenerationOutcome> {
  const requested = input.want.reduce((total, entry) => total + entry.count, 0);
  const wantByKind = new Map(input.want.map((entry) => [entry.kind, entry.count] as const));
  const allowedSlugs = new Set(input.vocabulary.map((entry) => entry.slug));

  const result = await deps.generate({
    model: input.model,
    system: input.system,
    want: input.want,
    vocabulary: input.vocabulary,
    excludePrompts: input.excludePrompts,
    maxTokens: generateMaxTokens(requested),
    requestId: input.requestId,
    signal: deps.signal,
  });

  const drafts = result.drafts ?? [];
  const drops: PromptDrop[] = [];
  const kept: AcceptedPrompt[] = [];
  const keptByKind = new Map<DrillKind, number>();

  // Seeded from the device's bank, then grown as this batch accepts, so a batch
  // cannot bank the same topic twice under two wordings.
  const seen = new Set(input.excludePrompts.map(promptFingerprint));

  const drop = (promptText: string, reason: PromptDropReason, detail: string): void => {
    drops.push({ promptText: promptText.slice(0, 120), reason, detail });
    deps.log?.(`[drills] dropped (${reason}): ${detail}`);
  };

  for (const draft of drafts) {
    if (!isDrillKind(draft.kind)) {
      drop(draft.promptText, 'unknown_kind', `unrecognised kind "${String(draft.kind)}"`);
      continue;
    }

    const promptText = draft.promptText.trim();
    if (promptText === '') {
      drop('', 'empty_prompt', 'a prompt with no text');
      continue;
    }
    if (promptText.length > MAX_PROMPT_CHARS) {
      drop(promptText, 'prompt_too_long', `${promptText.length} chars over ${MAX_PROMPT_CHARS}`);
      continue;
    }

    // An essay topic is a statement, not an instruction. "Discuss the impact
    // of X" is a GS question, and setting it as an essay teaches her to write
    // GS answers in the essay paper — the single diagnosis the essay rubric
    // asks the evaluator to give most often.
    if (draft.kind === 'essay_outline' && /^(discuss|examine|analyse|analyze|evaluate|comment on)\b/i.test(promptText)) {
      drop(promptText, 'not_a_question', 'an essay topic phrased as a GS directive');
      continue;
    }

    const caseDetail = draft.caseDetail?.trim() ?? '';
    if (draft.kind === 'ethics_case') {
      if (caseDetail === '') {
        // Enforced here rather than left to the device's CHECK constraint,
        // because the constraint would reject the row AFTER the batch was
        // billed for, and the app would show a bank that quietly did not grow.
        drop(promptText, 'case_missing_detail', 'a case with no situation to decide on');
        continue;
      }
      if (caseDetail.length > MAX_CASE_DETAIL_CHARS) {
        drop(promptText, 'prompt_too_long', `case detail ${caseDetail.length} chars`);
        continue;
      }
    } else if (caseDetail !== '') {
      drop(promptText, 'outline_has_detail', 'an essay topic carrying case detail');
      continue;
    }

    const fingerprint = promptFingerprint(promptText);
    if (seen.has(fingerprint)) {
      drop(promptText, 'duplicate', `restates a prompt already banked: ${promptText}`);
      continue;
    }

    // A slug outside the request is dropped rather than carried: the app
    // resolves these against its own syllabus and a slug from nowhere is noise
    // there. The PROMPT is kept — an untagged prompt is still drillable.
    const syllabusSlug =
      draft.syllabusSlug !== null && allowedSlugs.has(draft.syllabusSlug)
        ? draft.syllabusSlug
        : null;

    const alreadyKept = keptByKind.get(draft.kind) ?? 0;
    const wanted = wantByKind.get(draft.kind) ?? 0;
    if (alreadyKept >= wanted) {
      drop(promptText, 'duplicate', `over the ${wanted} asked for of ${draft.kind}`);
      continue;
    }

    seen.add(fingerprint);
    keptByKind.set(draft.kind, alreadyKept + 1);
    kept.push({
      kind: draft.kind,
      promptText,
      caseDetail: draft.kind === 'ethics_case' ? caseDetail : null,
      syllabusSlug,
      why: draft.why,
      fingerprint,
    });
  }

  const dropReasons: Partial<Record<PromptDropReason, number>> = {};
  for (const entry of drops) {
    dropReasons[entry.reason] = (dropReasons[entry.reason] ?? 0) + 1;
  }

  return {
    prompts: kept,
    drops,
    summary: {
      requested,
      returned: drafts.length,
      kept: kept.length,
      dropped: drops.length,
      dropReasons,
      underDelivered: kept.length < requested,
    },
    usage: result.usage ?? ZERO_USAGE,
    provenance: result.provenance,
    stopReason: result.stopReason,
  };
}

/* ------------------------------------------------------------- evaluation */

export interface EvaluationInput {
  requestId: string;
  kind: DrillKind;
  promptText: string;
  caseDetail: string | null;
  parts: readonly SubmittedPart[];
  model: string;
  system: string;
}

export interface EvaluationDeps {
  evaluate: EvaluateRunner;
  signal: AbortSignal;
  log?: (message: string) => void;
}

export interface EvaluationOutcome {
  evaluation: DrillEvaluation | null;
  usage: DrillUsage;
  provenance: 'model' | 'fake';
  stopReason: string | null;
  /** Set when the reply was unusable. Logged, never echoed to the client. */
  error: string | null;
}

/** Enough for a comment per part plus the prose feedback. */
function evaluateMaxTokens(parts: number): number {
  return 900 + parts * 350;
}

export async function runEvaluation(
  input: EvaluationInput,
  deps: EvaluationDeps,
): Promise<EvaluationOutcome> {
  const result = await deps.evaluate({
    model: input.model,
    system: input.system,
    kind: input.kind,
    promptText: input.promptText,
    caseDetail: input.caseDetail,
    parts: input.parts,
    maxTokens: evaluateMaxTokens(input.parts.length),
    requestId: input.requestId,
    signal: deps.signal,
  });

  const usage = result.usage ?? ZERO_USAGE;

  if (result.evaluation === null) {
    return {
      evaluation: null,
      usage,
      provenance: result.provenance,
      stopReason: result.stopReason,
      error:
        result.stopReason === 'max_tokens'
          ? 'The marking reply was truncated.'
          : 'The marking reply could not be read.',
    };
  }

  /**
   * A verdict is required for every part she wrote.
   *
   * A partial mark sheet is worse than none: she reads three scores, sees no
   * fourth, and cannot tell whether the closing scored zero or was skipped.
   * Rejecting sends her a retry, which is the honest outcome for a reply that
   * did not do what it was asked.
   */
  const returned = new Set(result.evaluation.verdicts.map((verdict) => verdict.part));
  const missing = input.parts.filter((part) => !returned.has(part.part));
  if (missing.length > 0) {
    deps.log?.(
      `[drills] incomplete mark sheet: missing ${missing.map((part) => part.part).join(', ')}`,
    );
    return {
      evaluation: null,
      usage,
      provenance: result.provenance,
      stopReason: result.stopReason,
      error: `The marking reply skipped ${missing.length} of ${input.parts.length} parts.`,
    };
  }

  // The maximum is the KIND's, not the sum of the parts returned. They agree
  // whenever every part was submitted, and the check above guarantees that —
  // but recomputing from the kind means a future partial submission cannot
  // silently rescale her percentage.
  const max = maxForKind(input.kind);
  if (result.evaluation.max !== max) {
    deps.log?.(`[drills] verdict max ${result.evaluation.max} != kind max ${max}; using the kind`);
  }

  return {
    evaluation: { ...result.evaluation, max },
    usage,
    provenance: result.provenance,
    stopReason: result.stopReason,
    error: null,
  };
}

/** Every part of a kind, in declared order, for a submission check. */
export function partsFor(kind: DrillKind): readonly string[] {
  return PARTS_OF_KIND[kind];
}
