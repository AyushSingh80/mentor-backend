/**
 * The two network flows: topping up the prompt bank, and marking an attempt.
 *
 * ## Neither ever rejects
 *
 * Both return an outcome carrying a status, a sentence and the counts. The
 * callers are a screen mount and a button, and a rejected promise from either
 * is an unhandled rejection in a React effect — which on Android is a red box
 * over the study block. `ca-digest.ts` and `mcq-refill.ts` hold the same
 * contract for the same reason.
 *
 * ## Her writing is durable before either flow starts
 *
 * `submitAndEvaluate` writes the attempt to disk FIRST and only then calls the
 * server. A failure moves the row to `failed` with an error to show; it never
 * reverts to `in_progress` and never touches `drill_parts`. Twenty minutes of
 * writing must not depend on a train having signal.
 */

import { evaluateDrill, generatePrompts } from '@/lib/drill-api';
import {
  buildEvaluateDrillRequest,
  buildGeneratePromptsRequest,
  DRILL_PROMPT_VERSION,
} from '@/lib/drill-request';
import { bankStock, shouldRefillPrompts, type RefillTrigger } from '@/lib/drill-bank';
import { checkSubmittable, elapsedMinutes } from '@/lib/drills';
import type { DrillFacts, DrillKind } from '@/lib/drill-types';
import {
  bankPrompts,
  bankedPromptTexts,
  failEvaluation,
  readBankCounts,
  saveEvaluation,
  submitDrill,
} from '@/db/drills';
import { markMaterialUsed } from '@/db/material';
import { readTagFacts } from '@/db/ca';
import { tagVocabulary } from '@/lib/ca-tags';
import { checkHealth } from '@/lib/api';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function newRequestId(prefix: string): string {
  const time = Date.now().toString(36);
  const a = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${time}_${a}`;
}

/* ------------------------------------------------------------- the refill */

export type RefillStatus = 'skipped' | 'completed' | 'partial' | 'failed';

export interface RefillOutcome {
  status: RefillStatus;
  /** Always populated. "Nothing happened" must be explicable on screen. */
  reason: string;
  requested: number;
  received: number;
  banked: number;
}

export interface RefillInput {
  trigger: RefillTrigger;
  /** ISO instant. Injectable so a test is not clock-dependent. */
  now?: string;
  /** Local calendar day, `YYYY-MM-DD`. */
  bankedOn: string;
}

let refillInFlight = false;

/**
 * Tops the prompt bank up. Never rejects.
 *
 * The health check is best-effort: it exists to turn "the spend cap is reached"
 * into a sentence before a model call rather than after one, and a health check
 * that itself fails must not block a refill that might have worked.
 */
export async function refillPrompts(input: RefillInput): Promise<RefillOutcome> {
  const now = input.now ?? new Date().toISOString();

  const skipped = (reason: string): RefillOutcome => ({
    status: 'skipped',
    reason,
    requested: 0,
    received: 0,
    banked: 0,
  });

  let spendCapAllows = true;
  try {
    const health = await checkHealth();
    spendCapAllows = health.caps?.allowed !== false;
  } catch {
    // Unreachable server: let the real call produce the real error, which is
    // more specific than anything guessed from a failed ping.
    spendCapAllows = true;
  }

  let counts: Awaited<ReturnType<typeof readBankCounts>>;
  try {
    counts = await readBankCounts();
  } catch (error) {
    return { status: 'failed', reason: messageOf(error), requested: 0, received: 0, banked: 0 };
  }

  const decision = shouldRefillPrompts({
    stock: bankStock({ counts, lastRefillAttemptAt: null }),
    trigger: input.trigger,
    now,
    spendCapAllows,
    refillInFlight,
  });

  if (!decision.refill) return skipped(decision.reason);

  const requested = decision.want.reduce((total, entry) => total + entry.count, 0);
  refillInFlight = true;

  try {
    const [banked, tagFacts] = await Promise.all([bankedPromptTexts(), readTagFacts()]);

    // The same vocabulary the digest ships, and for the same reason: the app
    // owns the taxonomy and the server may tag only from it.
    const vocabulary = tagVocabulary(tagFacts).map((entry) => ({
      slug: entry.slug,
      label: entry.label,
    }));

    const request = buildGeneratePromptsRequest({
      requestId: newRequestId('drill'),
      want: decision.want,
      vocabulary,
      bankedPrompts: banked,
    });

    const response = await generatePrompts(request);

    const written = await bankPrompts(
      response.prompts.map((prompt) => ({
        kind: prompt.kind,
        promptText: prompt.promptText,
        caseDetail: prompt.caseDetail,
        syllabusSlug: prompt.syllabusSlug,
        batchId: response.batchId,
        promptVersion: response.promptVersion ?? DRILL_PROMPT_VERSION,
      })),
      input.bankedOn,
    );

    const received = response.prompts.length;
    return {
      status: written === 0 ? 'failed' : written < requested ? 'partial' : 'completed',
      reason:
        written === 0
          ? received === 0
            ? 'The server set no prompts. Nothing was banked.'
            : `${received} prompts arrived and every one was already banked.`
          : `Banked ${written} new prompt${written === 1 ? '' : 's'}${
              written < requested ? ` of ${requested} asked for` : ''
            }.`,
      requested,
      received,
      banked: written,
    };
  } catch (error) {
    const status = (error as { status?: unknown } | null)?.status;
    return {
      status: 'failed',
      reason:
        status === 429
          ? 'Spend cap reached — no new prompts until it resets.'
          : status === 401 || status === 403
            ? 'The server rejected this device’s token. Re-enter it in onboarding.'
            : messageOf(error),
      requested,
      received: 0,
      banked: 0,
    };
  } finally {
    refillInFlight = false;
  }
}

/* --------------------------------------------------------- submit and mark */

export type SubmitStatus = 'blocked' | 'evaluated' | 'saved_unmarked';

export interface SubmitOutcome {
  status: SubmitStatus;
  reason: string;
  total: number | null;
  max: number | null;
}

export interface SubmitInput {
  drill: DrillFacts;
  /** Material shown alongside, so use counts reflect what she actually saw. */
  suggestedMaterialIds?: readonly number[];
  now?: string;
}

/**
 * Commits an attempt and marks it. Never rejects.
 *
 * The order is the point: the local gate first (free, instant, and refuses only
 * what a paid call would refuse anyway), then the write to disk, then the
 * network. `saved_unmarked` is a real success — her twenty minutes are
 * preserved and the mark sheet can be retried on wifi.
 */
export async function submitAndEvaluate(input: SubmitInput): Promise<SubmitOutcome> {
  const drill = input.drill;
  const now = input.now ?? new Date().toISOString();

  const check = checkSubmittable(drill.kind, drill.parts);
  if (!check.ready) {
    return { status: 'blocked', reason: check.blocker ?? 'Not ready to submit.', total: null, max: null };
  }

  const minutes = elapsedMinutes(drill.kind, drill.startedAt, now);

  try {
    await submitDrill(drill.id, minutes, now);
  } catch (error) {
    // The write is the one step that must not fail silently: everything after
    // it is recoverable and this is not.
    return {
      status: 'blocked',
      reason: `Could not save your answer: ${messageOf(error)}`,
      total: null,
      max: null,
    };
  }

  if (input.suggestedMaterialIds && input.suggestedMaterialIds.length > 0) {
    // Best-effort: a failed use count must never turn a marked drill into an
    // error. The bias it feeds is a nudge, not a guarantee.
    await markMaterialUsed(input.suggestedMaterialIds).catch(() => undefined);
  }

  return markAttempt(drill);
}

/**
 * The marking half, alone.
 *
 * Split out so `retryEvaluation` does not re-run the submit step. Re-submitting
 * would re-stamp `submittedAt` and recompute `minutesSpent` — overwriting a
 * correct measurement of how long the attempt took with the interval to
 * whenever she happened to find wifi.
 */
async function markAttempt(drill: DrillFacts): Promise<SubmitOutcome> {
  try {
    const response = await evaluateDrill(
      buildEvaluateDrillRequest({
        requestId: newRequestId('deval'),
        kind: drill.kind,
        promptText: drill.promptText,
        caseDetail: drill.caseDetail,
        parts: drill.parts,
      }),
    );

    await saveEvaluation(drill.id, {
      verdicts: response.verdicts,
      total: response.total,
      max: response.max,
      feedbackMd: response.feedbackMarkdown,
      highestLeverageFix: response.highestLeverageFix,
      rubricVersion: response.rubricVersion,
      model: response.model,
    });

    return {
      status: 'evaluated',
      reason: `Marked ${response.total} of ${response.max}.`,
      total: response.total,
      max: response.max,
    };
  } catch (error) {
    const status = (error as { status?: unknown } | null)?.status;
    const reason =
      status === 429
        ? 'Spend cap reached. Your answer is saved and can be marked once it resets.'
        : `${messageOf(error)} Your answer is saved and can be marked later.`;
    await failEvaluation(drill.id, reason).catch(() => undefined);
    return { status: 'saved_unmarked', reason, total: null, max: null };
  }
}

/**
 * Re-runs marking on a drill whose evaluation failed. Never rejects.
 *
 * Deliberately does NOT re-run the submit gate: the attempt was already
 * accepted and is on disk, and a gate that has since tightened must not strand
 * work she has finished.
 */
export function retryEvaluation(drill: DrillFacts): Promise<SubmitOutcome> {
  return markAttempt(drill);
}

/** Convenience wrappers, mirroring `digestOnForeground` / `digestNow`. */
export function refillOnForeground(bankedOn: string): Promise<RefillOutcome> {
  return refillPrompts({ trigger: 'auto', bankedOn });
}

export function refillNow(bankedOn: string): Promise<RefillOutcome> {
  return refillPrompts({ trigger: 'manual', bankedOn });
}

/** Kinds, for a screen that offers a choice. */
export const DRILL_KIND_ORDER: readonly DrillKind[] = ['essay_outline', 'ethics_case'];
