/**
 * Backend client.
 *
 * Uses `expo/fetch` rather than the React Native global: it supports real
 * streaming response bodies, which is what makes evaluation feedback appear
 * as it is written instead of after a thirty-second blank wait.
 */

import { File as FsFile } from 'expo-file-system';
import { fetch as expoFetch } from 'expo/fetch';
import { getServerBaseUrl, getServerToken } from './secure';
import { SSEParser } from './sse';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function requireConfig(): Promise<{ baseUrl: string; token: string }> {
  const [baseUrl, token] = await Promise.all([getServerBaseUrl(), getServerToken()]);
  if (!baseUrl || !token) {
    throw new ApiError('Server is not configured yet. Finish onboarding first.');
  }
  return { baseUrl, token };
}

/** Default ceiling for the small JSON calls. Deliberately short: this app is
 *  used on commutes, where a black-holed connection hangs rather than refuses. */
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * fetch with a hard timeout.
 *
 * Without this, an unreachable-but-not-refused host (captive portal, flaky
 * mobile data) leaves the promise pending for as long as the OS socket timeout
 * takes — which is long enough to strand the user on a spinner.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Chain any caller-supplied signal into ours. Overwriting `init.signal` with
  // the timeout controller alone would silently make caller cancellation a
  // no-op — the fetch would keep running on a different controller.
  const external = init.signal;
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      if (external?.aborted) throw new ApiError('Request cancelled.');
      throw new ApiError(`Server did not respond within ${timeoutMs / 1000}s.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', onExternalAbort);
  }
}

export interface HealthResponse {
  ok: boolean;
  timezone: string;
  /**
   * Whether the server has model credentials configured.
   *
   * Chooses the current-affairs transport: `false` means headlines mode —
   * real feeds, no notes, nothing billed. Optional because a server built
   * before this field existed omits it, and `undefined` must not read as
   * "no model" and silently downgrade a working paid setup. Treat only an
   * explicit `false` as a downgrade.
   */
  modelConfigured?: boolean;
  rubrics: Record<string, string>;
  /**
   * Content hashes of the question-bank prompts and the JSON schema they are
   * paired with. Present so a server whose prompt files are missing fails a
   * health check instead of failing on the first paid request.
   */
  mcq: {
    promptVersion: string;
    verifierVersion: string;
  };
  /**
   * Content hash of the digest prompts and their schemas. Present for the same
   * reason as `mcq`: the server reads those files from disk to answer this, so
   * a build whose script forgot to copy them fails a health check rather than
   * the first paid request of the month.
   */
  ca: {
    promptVersion: string;
  };
  caps: {
    allowed: boolean;
    monthUsd: number;
    monthlyCapUsd: number;
    todayRequests: number;
    dailyRequestCap: number;
  };
}

/** Unauthenticated liveness check — also used to validate the URL at onboarding. */
export async function checkHealth(
  baseUrl?: string,
  signal?: AbortSignal,
): Promise<HealthResponse> {
  const url = baseUrl ?? (await getServerBaseUrl());
  if (!url) throw new ApiError('No server URL configured.');

  const res = await fetchWithTimeout(`${url.replace(/\/+$/, '')}/health`, { signal });
  if (!res.ok) throw new ApiError(`Health check failed (${res.status})`, res.status);
  return (await res.json()) as HealthResponse;
}

/** Verifies the bearer token by hitting an authenticated endpoint. */
export async function checkAuth(baseUrl: string, token: string): Promise<boolean> {
  const res = await fetchWithTimeout(`${baseUrl.replace(/\/+$/, '')}/usage`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.ok;
}

/* -------------------------------------------------------------- evaluation */

export interface EvaluationMeta {
  model: string;
  rubricVersion: string;
  rubricName: string;
  paper: string;
  pages: number;
}

export interface EvaluationDimension {
  name: string;
  score: number;
  max: number;
  comment: string;
}

export interface EvaluationScores {
  total: number;
  max: number;
  dimensions: EvaluationDimension[];
  directiveWord?: string;
  directiveCompliance?: boolean;
  highestLeverageFix?: string;
  legibility?: string;
  legibilityNote?: string;
  wordLimitRespected?: boolean;
  confidence?: string;
}

export interface EvaluationUsage {
  inputTokens: number;
  outputTokens: number;
  estCostUsd: number;
  monthUsd: number;
  monthlyCapUsd: number;
}

export interface EvaluationHandlers {
  onMeta?: (meta: EvaluationMeta) => void;
  onToken?: (text: string) => void;
  onScores?: (payload: {
    scores: EvaluationScores | null;
    feedbackMarkdown: string;
    parsed: boolean;
  }) => void;
  onUsage?: (usage: EvaluationUsage) => void;
  /**
   * Fires only on the server's terminal `done` frame. Without this, a stream
   * truncated mid-generation and a cleanly finished one are indistinguishable
   * to the caller — the promise resolves either way — and a partial evaluation
   * would be saved as if it were complete.
   */
  onDone?: () => void;
  onError?: (message: string) => void;
}

export interface EvaluateInput {
  paper: string;
  question: string;
  directiveWord?: string;
  wordLimit: number;
  previousAttempt?: string;
  /** Local file URIs for the scanned pages, plus their mime types. */
  files: { uri: string; name: string; type: string }[];
  signal?: AbortSignal;
}

export async function evaluateAnswer(
  input: EvaluateInput,
  handlers: EvaluationHandlers,
): Promise<void> {
  const { baseUrl, token } = await requireConfig();

  const form = new FormData();
  form.append('paper', input.paper);
  form.append('question', input.question);
  form.append('wordLimit', String(input.wordLimit));
  if (input.directiveWord) form.append('directiveWord', input.directiveWord);
  if (input.previousAttempt) form.append('previousAttempt', input.previousAttempt);

  /**
   * The `File` object goes on the form DIRECTLY. Not its bytes, and not a Blob
   * built from them.
   *
   * `expo-file-system`'s `File` is declared `implements Blob`, so `expo/fetch`'s
   * multipart serialiser takes it through its blob path and reads the contents
   * natively — no copy through JS at all, which also means a 20MB scan never
   * lands in the JS heap.
   *
   * The two shapes that DO NOT work, both found the hard way:
   *
   *  - React Native's `{uri, name, type}` shape, which `convertFormData` states
   *    it does not support for RN's FormData.
   *  - `new Blob([bytes])`, which was the previous fix here and fails on device
   *    with "Creating blobs from 'ArrayBuffer' and 'ArrayBufferView' are not
   *    supported". React Native's `Blob` cannot be constructed from binary data
   *    in JS at all — expo's own `createBlob.ts` says so and ships a native
   *    workaround for it. Under Node `Blob` works fine, so no test could catch
   *    this: EVERY evaluation upload failed on a real phone and only a real
   *    phone could show it.
   */
  for (const file of input.files) {
    form.append('files', new FsFile(file.uri) as unknown as Blob, file.name);
  }

  const res = await expoFetch(`${baseUrl}/evaluate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
    signal: input.signal,
  });

  if (!res.ok) {
    let detail: unknown;
    try {
      detail = await res.json();
    } catch {
      detail = await res.text().catch(() => undefined);
    }
    throw new ApiError(
      res.status === 429
        ? 'Spend cap reached — evaluation blocked until the cap resets.'
        : `Evaluation failed (${res.status})`,
      res.status,
      detail,
    );
  }

  if (!res.body) throw new ApiError('Server returned no stream.');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SSEParser();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
        // A malformed frame must surface through onError like any other
        // failure, not escape as a rejected promise and bypass the callback
        // API — and it must not abandon the rest of the stream.
        let payload: unknown;
        try {
          payload = JSON.parse(frame.data);
        } catch {
          handlers.onError?.(`Malformed ${frame.event} frame from server.`);
          continue;
        }

        switch (frame.event) {
          case 'meta':
            handlers.onMeta?.(payload as EvaluationMeta);
            break;
          case 'token':
            handlers.onToken?.((payload as { text: string }).text);
            break;
          case 'scores':
            handlers.onScores?.(
              payload as {
                scores: EvaluationScores | null;
                feedbackMarkdown: string;
                parsed: boolean;
              },
            );
            break;
          case 'usage':
            handlers.onUsage?.(payload as EvaluationUsage);
            break;
          case 'done':
            handlers.onDone?.();
            break;
          case 'error':
            handlers.onError?.((payload as { message: string }).message);
            break;
          default:
            break;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
