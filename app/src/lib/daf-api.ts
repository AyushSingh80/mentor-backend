/**
 * Backend client for interview question generation.
 *
 * Plain JSON, one short call — same reasoning as `drill-api.ts`.
 *
 * ## The most personal payload this app sends
 *
 * Her name, her home district, her employer. Three things follow, and all three
 * are the server's guarantees rather than this file's: the entries are never
 * persisted server-side, never logged, and the response carries no field a fact
 * could travel back in. See `server/src/interview/types.ts`.
 *
 * What this file guarantees is that only FILLED entries leave the device —
 * `buildQuestionsRequest` drops the empties — so a blank field is never
 * transmitted as an empty string that a model might fill in for her.
 */

import { fetch as expoFetch } from 'expo/fetch';
import { ApiError } from './api';
import { getServerBaseUrl, getServerToken } from './secure';
import type { DafField, Likelihood } from './daf-types';

export const INTERVIEW_TIMEOUT_MS = 60_000;

export interface DafEntryPayload {
  field: DafField;
  value: string;
}

export interface QuestionsRequest {
  requestId: string;
  entries: DafEntryPayload[];
  excludeQuestions: string[];
  take: number;
  promptVersion: string;
}

export interface GeneratedQuestion {
  field: DafField | null;
  area: string;
  question: string;
  likelihood: Likelihood;
}

export interface QuestionsSummary {
  requested: number;
  returned: number;
  kept: number;
  dropped: number;
  /** Histogram by drop reason. Rendered in words — a filter she cannot see teaches nothing. */
  dropReasons: Record<string, number>;
  underDelivered: boolean;
}

export interface QuestionsResponse {
  batchId: string;
  model: string;
  promptVersion: string;
  /** `'fake'` when the server is running scripted runners. Shown, never hidden. */
  provenance: string;
  questions: GeneratedQuestion[];
  summary: QuestionsSummary;
  usage: {
    inputTokens: number;
    outputTokens: number;
    monthUsd: number | null;
    monthlyCapUsd: number | null;
  };
}

async function requireConfig(): Promise<{ baseUrl: string; token: string }> {
  const [baseUrl, token] = await Promise.all([getServerBaseUrl(), getServerToken()]);
  if (!baseUrl || !token) {
    throw new ApiError('Server is not configured yet. Finish onboarding first.');
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), token };
}

/** Generates a batch of questions. Rejects on transport failure and non-2xx. */
export async function generateQuestions(
  request: QuestionsRequest,
  signal?: AbortSignal,
): Promise<QuestionsResponse> {
  const { baseUrl, token } = await requireConfig();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INTERVIEW_TIMEOUT_MS);
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    const response = await expoFetch(`${baseUrl}/interview/questions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(request),
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
          ? 'Spend cap reached — no new questions until it resets.'
          : `Request failed (${response.status})`,
        response.status,
        detail,
      );
    }

    return (await response.json()) as QuestionsResponse;
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      if (signal?.aborted) throw new ApiError('Cancelled.');
      throw new ApiError(
        `The server did not respond within ${Math.round(INTERVIEW_TIMEOUT_MS / 1000)}s.`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}
