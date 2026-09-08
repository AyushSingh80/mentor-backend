/**
 * `POST /mcq/generate` — the only network call the question bank makes.
 *
 * Separate from `lib/api.ts` on purpose, and the reason is a number:
 * `DEFAULT_TIMEOUT_MS` there is 8 seconds, sized for small JSON calls on a
 * commute. Generating thirty questions takes tens of seconds of model time, so
 * borrowing that ceiling would abort every refill that ever worked — while the
 * server kept generating, and billing, on the other side of the dead socket.
 *
 * ## The wire format
 *
 * ```
 * meta -> question (x0..N) -> summary -> usage -> done
 * ```
 *
 * or a terminal `error`. `SSEParser` from `@/lib/sse` does the framing; it is
 * frozen and already pinned byte-for-byte by `tests/sse-contract.test.ts`.
 *
 * ## Questions are handed over AS THEY ARRIVE
 *
 * `onQuestion` is awaited per frame rather than the caller being handed an
 * array at the end. Accumulating would discard the entire point of streaming:
 * if the connection drops at question 15 of 30, an accumulating client banks
 * nothing and the user pays for thirty questions to receive none, whereas this
 * one has fifteen questions durably on the device.
 *
 * ## A short batch is a SUCCESS
 *
 * The server may deliver 14 of 20 because six failed its own quality control.
 * That is a correct outcome. There is no retry loop here and there must not be
 * one: the shortfall is topped up on the next scheduled run, which passes the
 * stems already held in `excludeStemHashes` so the second call generates new
 * material rather than the same material again.
 *
 * ## Three timers, three different failure modes
 *
 * - `connect` (20s) — the request was accepted and nothing came back. A captive
 *   portal answers the TCP handshake and then black-holes the request; without
 *   this the promise stays pending until the OS socket timeout, which is
 *   minutes.
 * - `idle` (45s) — the stream started and went silent. Reset on EVERY frame,
 *   never on a total, because a legitimate generation run is mostly waiting.
 * - `total` (180s) — the absolute ceiling. A server that emits a keep-alive
 *   comment every thirty seconds forever would reset the idle timer forever.
 */

import { fetch as expoFetch } from 'expo/fetch';

import { ApiError } from '@/lib/api';
import { getServerBaseUrl, getServerToken } from '@/lib/secure';
import { SSEParser } from '@/lib/sse';

/* ----------------------------------------------------------------- timing */

/** Time to the first byte. Generous, because the server plans before it writes. */
export const MCQ_CONNECT_TIMEOUT_MS = 20_000;

/** Silence between frames. Reset on every frame, including comments. */
export const MCQ_IDLE_TIMEOUT_MS = 45_000;

/** Absolute ceiling on one call, whatever the frames say. */
export const MCQ_TOTAL_TIMEOUT_MS = 420_000;

const CONNECT_TIMEOUT_REASON = 'The server did not start generating within 20 seconds.';
const IDLE_TIMEOUT_REASON = 'The generation stream went silent for 45 seconds.';
const TOTAL_TIMEOUT_REASON = 'The generation ran past its 7-minute ceiling.';
const CANCELLED_REASON = 'Top-up cancelled.';

/* ---------------------------------------------------------------- the wire */

/** One section's ask. `syllabusSlugs` carries the whole section, not one leaf. */
export interface McqGenerateSection {
  sectionKey: string;
  /** The section's anchor leaf — `QuotaLine.syllabusSlug`. */
  syllabusSlug: string;
  /** Every leaf in the section, so generation can spread across it. */
  syllabusSlugs: string[];
  paper: string;
  label: string;
  count: number;
  /** The same sentence shown to the user, sent so the logs agree with the UI. */
  reason: string;
}

export interface McqGenerateRequest {
  /**
   * Idempotency key, written to `mcq_bank_refills` BEFORE this call.
   *
   * A refill that times out after the server has already billed for thirty
   * questions must be re-fetchable under the same id, not re-generated.
   */
  requestId: string;
  /** True when re-attaching to a request the server may already have run. */
  resume: boolean;
  batchSize: number;
  sections: McqGenerateSection[];
  excludeStemHashes: string[];
  promptVersion: string;
  /** Human-readable, mirrored into `plan_json`. */
  rationale: string;
}

export interface McqGenerateMeta {
  batchId: string | null;
  promptVersion: string | null;
  model: string | null;
  requested: number | null;
}

export interface McqGenerateSummary {
  batchId: string | null;
  requested: number | null;
  /**
   * What the server actually emitted. Legitimately below `requested`.
   *
   * Reads the server's `delivered`, NOT its `generated` — those are different
   * numbers and the gap is large. `generated` counts what the model produced
   * before quality control, and a run that produced seventeen and delivered
   * nine would otherwise report nine banked questions as seventeen.
   */
  delivered: number | null;
  /** What the model produced before quality control. Diagnostic only. */
  generated: number | null;
  /** What its own quality control threw away. */
  rejected: number | null;
  /** How many sections the batch spanned. */
  sections: number | null;
}

export interface McqUsage {
  inputTokens: number;
  outputTokens: number;
  estCostUsd: number;
  model: string | null;
  monthUsd: number | null;
  monthlyCapUsd: number | null;
}

/** One step of the batch. What keeps the idle timer honest across sections. */
export interface McqGenerateProgress {
  /** `'section'`, or whatever a later server adds. Rendered, never parsed. */
  phase: string;
  done: number | null;
  total: number | null;
  /** One line, already human-readable. */
  detail: string | null;
}

export interface McqGenerateHandlers {
  onMeta?: (meta: McqGenerateMeta) => void;
  /**
   * Fires once per section, BEFORE its two model calls.
   *
   * A batch now spans four to six sections and a section that rejects
   * everything it generates emits no `question` frame for a minute or more. The
   * idle timer resets on any bytes, so these frames are what keep a slow
   * section from reading as a dead stream.
   */
  onProgress?: (progress: McqGenerateProgress) => void;
  /**
   * One banked question. Awaited, so writes stay ordered and a slow SQLite
   * write cannot race the next frame into the same transaction.
   */
  onQuestion?: (payload: unknown, index: number) => void | Promise<void>;
  onSummary?: (summary: McqGenerateSummary) => void;
  onUsage?: (usage: McqUsage) => void;
  /** The terminal frame. Its absence is how a truncated stream is detected. */
  onDone?: () => void;
  /** Terminal and exclusive: never also call `onDone`. */
  onError?: (message: string) => void;
}

/* ------------------------------------------------------------- primitives */

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function optionalNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function requiredNumber(value: unknown): number {
  return optionalNumber(value) ?? 0;
}

async function requireMcqConfig(): Promise<{ baseUrl: string; token: string }> {
  const [baseUrl, token] = await Promise.all([getServerBaseUrl(), getServerToken()]);
  if (!baseUrl || !token) {
    throw new ApiError('Server is not configured yet. Finish onboarding first.');
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), token };
}

/* ------------------------------------------------------------------- call */

/**
 * Streams one generation batch.
 *
 * Rejects on transport failure and on a non-2xx response; every stream-level
 * outcome — including the server's terminal `error` frame — arrives through
 * `handlers`. The caller (`mcq-refill.ts`) is the one holding the never-rejects
 * contract, and it needs a thrown transport failure to tell "the network did
 * not happen" apart from "the network happened and said no".
 */
export async function generateMcqs(
  request: McqGenerateRequest,
  handlers: McqGenerateHandlers,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const { baseUrl, token } = await requireMcqConfig();

  const controller = new AbortController();

  // One mutable holder rather than four `let`s: TypeScript narrows a `let`
  // assigned only inside a callback to its initialiser, which would make the
  // reason check below compile to nothing. Same trick, same reason, as
  // `evaluation.ts`.
  const timers: {
    connect: ReturnType<typeof setTimeout> | null;
    idle: ReturnType<typeof setTimeout> | null;
    total: ReturnType<typeof setTimeout> | null;
    /** Set by whichever timer fired, so an abort can be told apart from a cancel. */
    reason: string | null;
  } = { connect: null, idle: null, total: null, reason: null };

  const clearConnect = () => {
    if (timers.connect !== null) {
      clearTimeout(timers.connect);
      timers.connect = null;
    }
  };
  const clearIdle = () => {
    if (timers.idle !== null) {
      clearTimeout(timers.idle);
      timers.idle = null;
    }
  };
  const clearTotal = () => {
    if (timers.total !== null) {
      clearTimeout(timers.total);
      timers.total = null;
    }
  };

  const resetIdle = () => {
    clearIdle();
    timers.idle = setTimeout(() => {
      timers.reason = IDLE_TIMEOUT_REASON;
      controller.abort();
    }, MCQ_IDLE_TIMEOUT_MS);
  };

  const external = options.signal;
  const onExternalAbort = () => controller.abort();

  try {
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener('abort', onExternalAbort, { once: true });
    }

    timers.connect = setTimeout(() => {
      timers.reason = CONNECT_TIMEOUT_REASON;
      controller.abort();
    }, MCQ_CONNECT_TIMEOUT_MS);

    timers.total = setTimeout(() => {
      timers.reason = TOTAL_TIMEOUT_REASON;
      controller.abort();
    }, MCQ_TOTAL_TIMEOUT_MS);

    const response = await expoFetch(`${baseUrl}/mcq/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
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
          ? 'Spend cap reached — no questions can be generated until it resets.'
          : `Top-up failed (${response.status})`,
        response.status,
        detail,
      );
    }

    if (!response.body) throw new ApiError('Server returned no stream.');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SSEParser();
    let questionIndex = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        // Bytes arrived: the connect window is over and the idle one begins.
        // Done on the raw chunk rather than on a parsed frame so a keep-alive
        // comment — which `SSEParser` correctly yields nothing for — still
        // counts as the server being alive.
        clearConnect();
        resetIdle();

        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          let payload: unknown;
          try {
            payload = JSON.parse(frame.data);
          } catch {
            // A malformed frame must surface through `onError` like any other
            // failure rather than escaping as a rejection, and it must not
            // abandon the questions still to come.
            handlers.onError?.(`Malformed ${frame.event} frame from server.`);
            continue;
          }

          switch (frame.event) {
            case 'meta': {
              const record = asRecord(payload);
              handlers.onMeta?.({
                batchId: optionalText(record.batchId),
                promptVersion: optionalText(record.promptVersion),
                model: optionalText(record.model),
                requested: optionalNumber(record.requested),
              });
              break;
            }
            case 'question': {
              // Awaited: the bank write for question 15 must land before
              // question 16 is offered, or a duplicate inside one batch could
              // pass the fingerprint check twice.
              await handlers.onQuestion?.(payload, questionIndex);
              questionIndex += 1;
              // The write can take a moment on a cold SQLite page cache; the
              // idle window should measure the server's silence, not ours.
              resetIdle();
              break;
            }
            case 'progress': {
              const record = asRecord(payload);
              handlers.onProgress?.({
                phase: optionalText(record.phase) ?? 'working',
                done: optionalNumber(record.done),
                total: optionalNumber(record.total),
                detail: optionalText(record.detail),
              });
              break;
            }
            case 'summary': {
              const record = asRecord(payload);
              handlers.onSummary?.({
                batchId: optionalText(record.batchId),
                requested: optionalNumber(record.requested),
                delivered: optionalNumber(record.delivered),
                generated: optionalNumber(record.generated),
                rejected: optionalNumber(record.rejected),
                sections: optionalNumber(record.sections),
              });
              break;
            }
            case 'usage': {
              const record = asRecord(payload);
              handlers.onUsage?.({
                inputTokens: requiredNumber(record.inputTokens),
                outputTokens: requiredNumber(record.outputTokens),
                estCostUsd: requiredNumber(record.estCostUsd),
                model: optionalText(record.model),
                monthUsd: optionalNumber(record.monthUsd),
                monthlyCapUsd: optionalNumber(record.monthlyCapUsd),
              });
              break;
            }
            case 'done':
              handlers.onDone?.();
              break;
            case 'error':
              handlers.onError?.(
                optionalText(asRecord(payload).message) ?? 'The server stopped generating.',
              );
              break;
            default:
              break;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    // A timer-driven abort and a caller-driven one arrive identically. Only
    // these two flags say which happened, and the difference decides whether
    // the refill is retryable or was deliberately stopped.
    if (timers.reason !== null) throw new ApiError(timers.reason);
    if (external?.aborted) throw new ApiError(CANCELLED_REASON);
    throw error;
  } finally {
    // All three, on every path. A leaked total timer would abort a controller
    // nothing is listening to, three minutes after the screen moved on.
    clearConnect();
    clearIdle();
    clearTotal();
    external?.removeEventListener('abort', onExternalAbort);
  }
}
