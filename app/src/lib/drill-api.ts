/**
 * Backend client for the essay and ethics drills.
 *
 * Plain JSON, not SSE, and that is a deliberate difference from `mcq-api.ts`
 * and `ca-api.ts`. Those stream because they run for minutes and a drop at
 * ninety seconds would bill for everything and return nothing. Setting six
 * prompts is one short model call, and marking one attempt is another; a body
 * that either arrives or does not is the simpler contract for work that
 * finishes in fifteen seconds, and streaming has a real cost in client
 * complexity that should be paid only where it buys something.
 *
 * ## The contract
 *
 * Every field below matches `parseGenerateBody` and `parseEvaluateBody` in
 * `server/src/routes/drills.ts`, and `tests/drill-contract.test.ts` pins that on
 * this side while `server/tests/drill-contract.test.ts` pins it on the other.
 * Phases 3 and 4 both shipped with every field name different across the wire
 * while both packages' suites passed, so the pair is not optional.
 */

import { fetch as expoFetch } from 'expo/fetch';
import { ApiError } from './api';
import { getServerBaseUrl, getServerToken } from './secure';
import type { DrillKind, DrillPart } from './drill-types';

/**
 * Generation is a short call and marking is a longer one — an evaluation-tier
 * model reading five parts of her writing. Neither is minutes.
 */
export const DRILL_GENERATE_TIMEOUT_MS = 60_000;
export const DRILL_EVALUATE_TIMEOUT_MS = 90_000;

/* ---------------------------------------------------------------- the wire */

export interface DrillVocabularyEntry {
  slug: string;
  /** Advisory — the server must not parse it. `slug` is the whole contract. */
  label: string;
}

export interface GeneratePromptsRequest {
  requestId: string;
  /** How many of each kind. The server caps the total at one batch. */
  want: { kind: DrillKind; count: number }[];
  /** The syllabus keys the server may tag with, and the ONLY ones. */
  vocabulary: DrillVocabularyEntry[];
  /** Prompt texts already banked, so a batch does not restate one. */
  excludePrompts: string[];
  promptVersion: string;
}

export interface GeneratedPrompt {
  kind: DrillKind;
  promptText: string;
  caseDetail: string | null;
  syllabusSlug: string | null;
  why: string;
}

export interface GenerateSummary {
  requested: number;
  returned: number;
  kept: number;
  dropped: number;
  /** Histogram by drop reason. Rendered in words — a filter she cannot see teaches nothing. */
  dropReasons: Record<string, number>;
  /** Fewer than asked for. A correct outcome, carried so the UI can say so. */
  underDelivered: boolean;
}

export interface DrillUsage {
  inputTokens: number;
  outputTokens: number;
  monthUsd: number | null;
  monthlyCapUsd: number | null;
  drillsMonthUsd: number | null;
  drillsMonthlyCapUsd: number | null;
}

export interface GeneratePromptsResponse {
  batchId: string;
  model: string;
  promptVersion: string;
  /** `'fake'` when the server is running scripted runners. Shown, never hidden. */
  provenance: string;
  prompts: GeneratedPrompt[];
  summary: GenerateSummary;
  usage: DrillUsage;
}

export interface SubmittedPart {
  part: DrillPart;
  content: string;
}

export interface EvaluateDrillRequest {
  requestId: string;
  kind: DrillKind;
  promptText: string;
  caseDetail: string | null;
  parts: SubmittedPart[];
}

export interface PartVerdict {
  part: DrillPart;
  score: number;
  max: number;
  comment: string;
}

export interface EvaluateDrillResponse {
  kind: DrillKind;
  model: string;
  promptVersion: string;
  /** Content hash of the rubric that scored this. Same string `evaluations` stores. */
  rubricVersion: string;
  provenance: string;
  verdicts: PartVerdict[];
  total: number;
  max: number;
  highestLeverageFix: string;
  feedbackMarkdown: string;
  usage: DrillUsage;
}

/* ------------------------------------------------------------------ client */

async function requireDrillConfig(): Promise<{ baseUrl: string; token: string }> {
  const [baseUrl, token] = await Promise.all([getServerBaseUrl(), getServerToken()]);
  if (!baseUrl || !token) {
    throw new ApiError('Server is not configured yet. Finish onboarding first.');
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), token };
}

/**
 * One JSON round trip with a hard timeout.
 *
 * The timeout is not optional: this runs on a commute, where an
 * unreachable-but-not-refused host leaves the promise pending for as long as
 * the OS socket timeout takes — long enough to strand her on a spinner through
 * the whole of her writing block.
 */
async function postJson<T>(
  path: string,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  const { baseUrl, token } = await requireDrillConfig();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Chain any caller-supplied signal into ours. Overwriting the signal with the
  // timeout controller alone would silently make caller cancellation a no-op.
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    const response = await expoFetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      let detail: unknown;
      try {
        detail = await response.json();
      } catch {
        detail = await response.text().catch(() => undefined);
      }
      throw new ApiError(
        response.status === 429
          ? 'Spend cap reached — no drills until it resets.'
          : `Request failed (${response.status})`,
        response.status,
        detail,
      );
    }

    return (await response.json()) as T;
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      if (signal?.aborted) throw new ApiError('Cancelled.');
      throw new ApiError(`The server did not respond within ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}

/** Sets a batch of practice prompts. Rejects on transport failure and non-2xx. */
export function generatePrompts(
  request: GeneratePromptsRequest,
  signal?: AbortSignal,
): Promise<GeneratePromptsResponse> {
  return postJson('/drills/generate', request, DRILL_GENERATE_TIMEOUT_MS, signal);
}

/** Marks one attempt, part by part. */
export function evaluateDrill(
  request: EvaluateDrillRequest,
  signal?: AbortSignal,
): Promise<EvaluateDrillResponse> {
  return postJson('/drills/evaluate', request, DRILL_EVALUATE_TIMEOUT_MS, signal);
}
