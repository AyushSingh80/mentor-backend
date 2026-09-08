/**
 * `POST /ca/digest` — the only network call the current-affairs feed makes.
 *
 * Separate from `lib/api.ts` on purpose, and the reason is a number:
 * `DEFAULT_TIMEOUT_MS` there is 8 seconds, sized for small JSON calls on a
 * commute. A digest run reads feeds, fetches ten to thirty article pages,
 * grounds every quote against the fetched text and then writes six notes;
 * borrowing that ceiling would abort every digest that ever worked — while the
 * server kept fetching, generating, and billing, on the other side of the dead
 * socket. That file is frozen and is not edited to accommodate this one.
 *
 * ## The wire format
 *
 * ```
 * meta -> progress (x0..N) -> item (x0..N) -> summary -> usage -> done
 * ```
 *
 * or a terminal `error`. `SSEParser` from `@/lib/sse` does the framing; it is
 * frozen and already pinned byte-for-byte by `tests/sse-contract.test.ts`.
 *
 * ## Why `progress` exists at all
 *
 * The fetch phase is 20–60 seconds of server-side network I/O during which
 * there is nothing to emit. Without `progress` the idle timer would be sized
 * for a silence that is a normal part of a healthy run, which means it could
 * not be sized to catch a stalled one. The frames keep the idle window short
 * and honest, and they are also the only way the screen can say "fetching 12 of
 * 30 sources" rather than showing a spinner for a minute.
 *
 * ## Items are handed over AS THEY ARRIVE
 *
 * `onItem` is awaited per frame rather than the caller being handed an array at
 * the end. Accumulating would discard the entire point of streaming: a drop at
 * item 4 of 6 must leave four items on the device, not zero — and unlike a
 * question, an item is a fact about a day that will not be regenerated
 * identically tomorrow.
 *
 * ## A short digest is a SUCCESS
 *
 * Four items on a quiet Tuesday is a correct outcome, not an error. There is no
 * retry loop here and there must not be one: `CA_RULES.dailyItemCap` is a
 * ceiling on her reading time, never a quota the server owes her, and a client
 * that retried a shortfall would spend money manufacturing news.
 *
 * ## Three timers, three different failure modes
 *
 * - `connect` (25s) — the request was accepted and nothing came back. A captive
 *   portal answers the TCP handshake and then black-holes the request; without
 *   this the promise stays pending until the OS socket timeout, which is
 *   minutes. Slightly longer than the MCQ equivalent because this server reads
 *   its feed list before it writes its first frame.
 * - `idle` (45s) — the stream started and went silent. Reset on EVERY frame,
 *   `progress` included, because a legitimate digest run is mostly waiting on
 *   somebody else's web server.
 * - `total` (240s) — the absolute ceiling. A server that emits a keep-alive
 *   comment every thirty seconds forever would reset the idle timer forever.
 *   Four minutes rather than the MCQ three, because the fetch phase is bounded
 *   by thirty external hosts rather than by one model call.
 */

import { fetch as expoFetch } from 'expo/fetch';

import { headlineItems, headlineSummary } from './ca-headlines-map';

import { ApiError } from '@/lib/api';
import type { TagVocabularyEntry } from '@/lib/ca-tags';
import { getServerBaseUrl, getServerToken } from '@/lib/secure';
import { SSEParser } from '@/lib/sse';

/* ----------------------------------------------------------------- timing */

/** Time to the first byte. The server reads its feed list before it writes. */
export const CA_CONNECT_TIMEOUT_MS = 25_000;

/** Silence between frames. Reset on every frame, `progress` included. */
export const CA_IDLE_TIMEOUT_MS = 45_000;

/** Absolute ceiling on one call, whatever the frames say. */
export const CA_TOTAL_TIMEOUT_MS = 240_000;

const CONNECT_TIMEOUT_REASON = 'The server did not start the digest within 25 seconds.';
const IDLE_TIMEOUT_REASON = 'The digest stream went silent for 45 seconds.';
const TOTAL_TIMEOUT_REASON = 'The digest ran past its 4-minute ceiling.';
const CANCELLED_REASON = 'Digest cancelled.';

/* ---------------------------------------------------------------- the wire */

export interface CaDigestRequest {
  /**
   * Idempotency key, written to `ca_digests` BEFORE this call.
   *
   * A digest that times out after the server has already fetched thirty pages
   * and written six notes must be re-fetchable under the same id, not
   * re-generated.
   */
  requestId: string;
  /** True when re-attaching to a request the server may already have run. */
  resume: boolean;
  /** The local calendar day this digest belongs to, `YYYY-MM-DD`. */
  date: string;
  /** IANA zone, so "today" means the same thing on both sides. */
  timezone: string;
  /** Ceiling on kept items. Fewer is a correct outcome. */
  maxItems: number;
  /**
   * The syllabus keys the server may tag with, and the ONLY ones.
   *
   * The app owns the taxonomy; see the header of `ca-tags.ts`. A slug is opaque
   * to the server and it may not invent one.
   */
  vocabulary: TagVocabularyEntry[];
  /** Canonical URLs already held, so the server can shortlist around them. */
  seenCanonicalUrls: string[];
  /** Headline fingerprints already held, for the running-story window. */
  seenFingerprints: string[];
  /**
   * Items already delivered per section over the trailing week.
   *
   * Seeds the server's section-diversity cap. Without it the cap still binds
   * WITHIN a day but starts from zero every morning, so one section can take
   * its whole weekly allowance seven days running — the digest quietly becomes
   * a single-topic feed and nothing reports it.
   */
  sectionCountsThisWeek: Record<string, number>;
  /**
   * Ask for the Paper 1 concept and its Indian instance.
   *
   * Always true today; carried because the server reads it and a field the
   * server reads that the client never sends is how this contract broke once
   * already.
   */
  linkAnthropology: boolean;
  promptVersion: string;
}

export interface CaDigestMeta {
  requestId: string | null;
  model: string | null;
  promptVersion: string | null;
  /** Content hash of the source allowlist. A feed change is visible here. */
  sourceSetVersion: string | null;
  /** Feeds the server intends to read. Advisory, for the progress line. */
  sourceCount: number | null;
}

/** One step of the run, and what keeps the idle timer alive through the fetch. */
export interface CaDigestProgress {
  /** `'feeds' | 'fetch' | 'shortlist' | 'ground' | 'write'`, or whatever comes. */
  phase: string;
  done: number | null;
  total: number | null;
  /** One line, already human-readable. Rendered, not parsed. */
  detail: string | null;
}

export interface CaSourceFailure {
  url: string;
  feedId: string | null;
  reason: string;
  detail: string;
}

export interface CaDigestSummary {
  considered: number;
  shortlisted: number;
  kept: number;
  dropped: number;
  /** Histogram by drop reason. Rendered in words — a filter she cannot see teaches nothing. */
  dropReasons: Record<string, number>;
  /** Above `CA_RULES.maxAnthroLinkRate` the prompt is reaching. */
  anthroLinkRate: number;
  /** A 404 feed must never look like a quiet news day. */
  sourceFailures: CaSourceFailure[];
  /** Fewer than asked for. A correct outcome, carried so the UI can say so. */
  underDelivered: boolean;
}

export interface CaUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  estCostUsd: number;
  model: string | null;
  monthUsd: number | null;
  monthlyCapUsd: number | null;
}

export interface CaDigestHandlers {
  onMeta?: (meta: CaDigestMeta) => void;
  /** Every one of these also resets the idle window. That is their main job. */
  onProgress?: (progress: CaDigestProgress) => void;
  /**
   * One item. Awaited, so writes stay ordered and a slow SQLite write cannot
   * race the next frame into the same transaction — and so the duplicate check
   * for item 5 sees item 4.
   */
  onItem?: (payload: unknown, index: number) => void | Promise<void>;
  onSummary?: (summary: CaDigestSummary) => void;
  onUsage?: (usage: CaUsage) => void;
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
  // A JSON number arriving as a string is a serialiser quirk, not a bad frame.
  // `Number('')` is 0, hence the explicit emptiness check.
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function requiredNumber(value: unknown): number {
  return optionalNumber(value) ?? 0;
}

/** A `Record<string, number>` from whatever shape the histogram arrived in. */
function counts(value: unknown): Record<string, number> {
  const record = asRecord(value);
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(record)) {
    const n = optionalNumber(raw);
    if (n !== null && n > 0) out[key] = Math.round(n);
  }
  return out;
}

function sourceFailures(value: unknown): CaSourceFailure[] {
  if (!Array.isArray(value)) return [];
  const out: CaSourceFailure[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const url = optionalText(record.url);
    if (url === null) continue;
    out.push({
      url,
      feedId: optionalText(record.feedId),
      reason: optionalText(record.reason) ?? 'unknown',
      detail: optionalText(record.detail) ?? '',
    });
  }
  return out;
}

async function requireCaConfig(): Promise<{ baseUrl: string; token: string }> {
  const [baseUrl, token] = await Promise.all([getServerBaseUrl(), getServerToken()]);
  if (!baseUrl || !token) {
    throw new ApiError('Server is not configured yet. Finish onboarding first.');
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), token };
}

/* ------------------------------------------------------------------- call */

/**
 * Streams one digest run.
 *
 * Rejects on transport failure and on a non-2xx response; every stream-level
 * outcome — including the server's terminal `error` frame — arrives through
 * `handlers`. The caller (`ca-digest.ts`) is the one holding the never-rejects
 * contract, and it needs a thrown transport failure to tell "the network did
 * not happen" apart from "the network happened and said no".
 */
export async function streamCaDigest(
  request: CaDigestRequest,
  handlers: CaDigestHandlers,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const { baseUrl, token } = await requireCaConfig();

  const controller = new AbortController();

  // One mutable holder rather than four `let`s: TypeScript narrows a `let`
  // assigned only inside a callback to its initialiser, which would make the
  // reason check below compile to nothing. Same trick, same reason, as
  // `evaluation.ts` and `mcq-api.ts`.
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
    }, CA_IDLE_TIMEOUT_MS);
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
    }, CA_CONNECT_TIMEOUT_MS);

    timers.total = setTimeout(() => {
      timers.reason = TOTAL_TIMEOUT_REASON;
      controller.abort();
    }, CA_TOTAL_TIMEOUT_MS);

    const response = await expoFetch(`${baseUrl}/ca/digest`, {
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
          ? 'Spend cap reached — no digest can be generated until it resets.'
          : `Digest failed (${response.status})`,
        response.status,
        detail,
      );
    }

    if (!response.body) throw new ApiError('Server returned no stream.');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SSEParser();
    let itemIndex = 0;

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
            // abandon the items still to come.
            handlers.onError?.(`Malformed ${frame.event} frame from server.`);
            continue;
          }

          switch (frame.event) {
            case 'meta': {
              const record = asRecord(payload);
              handlers.onMeta?.({
                requestId: optionalText(record.requestId),
                model: optionalText(record.model),
                promptVersion: optionalText(record.promptVersion),
                sourceSetVersion: optionalText(record.sourceSetVersion),
                sourceCount: optionalNumber(record.sourceCount ?? record.feedCount),
              });
              break;
            }
            case 'progress': {
              const record = asRecord(payload);
              handlers.onProgress?.({
                phase: optionalText(record.phase) ?? 'working',
                done: optionalNumber(record.done ?? record.completed),
                total: optionalNumber(record.total),
                detail: optionalText(record.detail ?? record.message),
              });
              // Stated explicitly rather than relying on the chunk reset above.
              // This is the frame whose whole purpose is to prove the server is
              // alive through the 20–60s fetch phase; the idle window's
              // correctness must not depend on chunk boundaries lining up with
              // frame boundaries.
              resetIdle();
              break;
            }
            case 'item': {
              // Awaited: the write for item 4 must land before item 5 is
              // offered, or a duplicate inside one digest could pass the
              // fingerprint check twice.
              await handlers.onItem?.(payload, itemIndex);
              itemIndex += 1;
              // The write can take a moment on a cold SQLite page cache; the
              // idle window should measure the server's silence, not ours.
              resetIdle();
              break;
            }
            case 'summary': {
              const record = asRecord(payload);
              handlers.onSummary?.({
                considered: requiredNumber(record.considered),
                shortlisted: requiredNumber(record.shortlisted),
                kept: requiredNumber(record.kept),
                dropped: requiredNumber(record.dropped),
                dropReasons: counts(record.dropReasons),
                anthroLinkRate: requiredNumber(record.anthroLinkRate),
                sourceFailures: sourceFailures(record.sourceFailures),
                underDelivered: record.underDelivered === true,
              });
              break;
            }
            case 'usage': {
              const record = asRecord(payload);
              handlers.onUsage?.({
                inputTokens: requiredNumber(record.inputTokens),
                outputTokens: requiredNumber(record.outputTokens),
                cacheCreationInputTokens: requiredNumber(record.cacheCreationInputTokens),
                cacheReadInputTokens: requiredNumber(record.cacheReadInputTokens),
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
                optionalText(asRecord(payload).message) ?? 'The server stopped the digest.',
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
    // the digest is resumable or was deliberately stopped.
    if (timers.reason !== null) throw new ApiError(timers.reason);
    if (external?.aborted) throw new ApiError(CANCELLED_REASON);
    throw error;
  } finally {
    // All three, on every path. A leaked total timer would abort a controller
    // nothing is listening to, four minutes after the screen moved on.
    clearConnect();
    clearIdle();
    clearTotal();
    external?.removeEventListener('abort', onExternalAbort);
  }
}

/* --------------------------------------------------------- headlines mode */

/**
 * A digest run with no model behind it: `POST /ca/headlines`.
 *
 * Real feeds, real links, real publisher standfirsts, selected by rule. See
 * `server/src/ca/headlines.ts` for why the pipeline splits this way — briefly,
 * two of the digest's four stages never needed a model and demanding a key to
 * fetch an RSS feed made "no key" and "invented data" the same mode.
 *
 * ## Same handlers, deliberately
 *
 * The response is one JSON document, not a stream, and it is REPLAYED through
 * `CaDigestHandlers` frame by frame. That is not ceremony: `ca-digest.ts` owns
 * the mapper, the duplicate window, the per-item write and the never-rejects
 * contract, and every one of those is transport-independent. A second
 * orchestrator for the second transport is how the two modes drift until one
 * of them quietly stops writing items.
 *
 * `onItem` is awaited in order for the same reason the streaming path awaits
 * it: the duplicate check for item 5 has to see item 4.
 */
export async function fetchCaHeadlines(
  request: CaDigestRequest,
  handlers: CaDigestHandlers,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const { baseUrl, token } = await requireCaConfig();

  const controller = new AbortController();
  // One budget, not three. The streaming path needs connect/idle/total because
  // a model run legitimately goes quiet for a minute mid-stream; a feed sweep
  // either answers or does not.
  const timer = setTimeout(() => controller.abort(), CA_CONNECT_TIMEOUT_MS + CA_IDLE_TIMEOUT_MS);
  const forward = () => controller.abort();
  options.signal?.addEventListener('abort', forward, { once: true });

  let response: Response;
  try {
    response = (await expoFetch(`${baseUrl}/ca/headlines`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(request),
      signal: controller.signal,
    })) as unknown as Response;
  } catch (error) {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', forward);
    if (controller.signal.aborted && options.signal?.aborted !== true) {
      throw new ApiError('The server did not answer in time.');
    }
    throw new ApiError((error as Error).message || 'Could not reach the server.');
  }
  clearTimeout(timer);
  options.signal?.removeEventListener('abort', forward);

  if (!response.ok) {
    throw new ApiError(`Server refused the headline sweep (HTTP ${response.status}).`);
  }

  let body: Record<string, unknown>;
  try {
    body = asRecord(await response.json());
  } catch {
    throw new ApiError('The server sent a response that could not be read.');
  }

  // Order is the server's ranking and is preserved exactly. `onItem` is
  // awaited in sequence for the same reason the streaming path awaits it: the
  // duplicate check for item 5 has to have seen item 4.
  const items = headlineItems(body);
  for (let index = 0; index < items.length; index += 1) {
    await handlers.onItem?.(items[index], index);
  }

  handlers.onSummary?.(headlineSummary(body, request.maxItems));

  // No `onUsage`: nothing was billed, and a zero-cost usage frame would write a
  // ledger row implying a model call that never happened.
  handlers.onDone?.();
}
