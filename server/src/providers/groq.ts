/**
 * Groq, for the bulk tier.
 *
 * `fetch` against one OpenAI-compatible endpoint. No SDK: the surface used here
 * is a single POST with a single response shape, and a dependency would be more
 * code to keep current than the twenty lines it replaces.
 *
 * ## The most consequential line in this file
 *
 * `finish_reason: 'length'` must map to `stopReason: 'max_tokens'`.
 *
 * Three pipelines discard a whole chunk on that exact value — `mcq/pipeline.ts`
 * does it twice, and `ca` and `drills` have the same guard. Map it wrong and
 * "throw away a truncated reply" silently becomes "bank a question whose options
 * array stopped early", which is precisely the failure structured outputs were
 * adopted to prevent. It is asserted first and on its own in the test file.
 *
 * ## No evaluation port
 *
 * `capabilities.evaluation` is false and `evaluation` is null, and the registry
 * asserts the two agree. Marking a handwritten answer needs vision good enough
 * to read her handwriting, and the failure mode of a weak vision model is not a
 * refusal — it is a fluent misreading, marked confidently. That is
 * `EVAL_RUNNER=fake` wearing a real provider's name, and `index.ts` already
 * refuses to start with the fake in production for exactly that reason.
 *
 * ## The key
 *
 * Read once at construction, never logged, never placed in an error message.
 * Groq's error bodies can echo request content, so `describeFailure` builds its
 * own message from the status rather than passing the body through.
 */

import { toStrictSubset } from './json-schema.js';
import type {
  Provider,
  ProviderCapabilities,
  StructuredRequest,
  StructuredResponse,
  StopReason,
  TokenCounts,
} from './types.js';

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

/** Retries. Four attempts is three retries. */
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 20_000;

/**
 * Total time this adapter may spend sleeping between attempts.
 *
 * `index.ts` sets `server.requestTimeout = 0`, so nothing else will ever cut a
 * request short. Without a budget here, a batch that hits a long rate-limit
 * window holds a spend reservation and an open SSE socket indefinitely.
 */
const BACKOFF_BUDGET_MS = 45_000;

/**
 * A reset window longer than this is a DAILY quota, not a per-minute one.
 *
 * Retrying into it burns attempts against an allowance that will not return for
 * hours. Failing fast lets the pipeline under-deliver, which it already treats
 * as a correct outcome and reports in words.
 */
const DAILY_WINDOW_MS = 90_000;

const ZERO: TokenCounts = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

export const GROQ_CAPABILITIES: ProviderCapabilities = {
  structured: true,
  evaluation: false,
  acceptsPdfDocuments: false,
  // Irrelevant while `evaluation` is false, and stated rather than left at a
  // number that would read as a promise if that ever flipped.
  maxImagesPerRequest: 0,
  reportsCacheTokens: false,
  /**
   * Measured live on 2026-09-08: 39 KB refused with a 413, 25 KB accepted.
   *
   * Set at the largest size observed to work rather than below it, because the
   * cost of being conservative here is not abstract. At 20 KB the digest's
   * vocabulary budget came out at ~4 KB, which fits 51 of 86 syllabus sections
   * — and an item whose section did not survive cannot be tagged at all, so it
   * is dropped as `no_syllabus_tag`. Trimming the taxonomy silently narrows
   * what the digest can even notice.
   */
  maxRequestBytes: 25_000,
};

/** Raised for a condition the caller should surface, not retry. */
export class GroqRefusal extends Error {
  constructor(
    message: string,
    readonly kind: 'rate_limited' | 'daily_limit' | 'rejected' | 'unavailable',
  ) {
    super(message);
    this.name = 'GroqRefusal';
  }
}

/**
 * `finish_reason` to `StopReason`.
 *
 * A closed mapping with an explicit fallback: an unrecognised value becomes
 * `'error'` rather than passing through as a raw provider string, so nothing
 * downstream can compare against a value this codebase has never seen.
 */
export function mapFinishReason(raw: unknown): StopReason {
  switch (raw) {
    case 'stop':
      return 'end_turn';
    // The line the header is about.
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    case 'tool_calls':
    case 'function_call':
      return 'error';
    default:
      return 'error';
  }
}

/**
 * Usage, with the cache pair pinned at zero.
 *
 * Never synthesised. `billableInputTokens` weights a cache write at 1.25x and a
 * read at 1.0x; inventing either would make the ledger describe a discount that
 * did not happen. `reportsCacheTokens: false` is how the capability says so.
 */
export function mapUsage(raw: unknown): TokenCounts {
  const usage = (raw ?? {}) as Record<string, unknown>;
  const num = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
  return {
    inputTokens: num(usage.prompt_tokens),
    outputTokens: num(usage.completion_tokens),
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
}

/**
 * The wait the provider is ASKING for, unclamped.
 *
 * Unclamped deliberately, and the first version of this got it wrong: it
 * clamped to `MAX_BACKOFF_MS` here, which meant a `retry-after: 3600` arrived
 * at the caller as twenty seconds and the daily-window check below could never
 * fire. The adapter then slept its way through four attempts against an
 * allowance that would not return for an hour.
 *
 * The clamp belongs at the sleep, where it is a bound on how long to wait. Here
 * it destroys the only signal that distinguishes a per-minute limit from a
 * daily one.
 */
export function retryDelayFromHeaders(headers: Headers, attempt: number): number | null {
  const retryAfter = headers.get('retry-after');
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  }

  const reset = headers.get('x-ratelimit-reset-requests') ?? headers.get('x-ratelimit-reset-tokens');
  if (reset !== null) {
    const parsed = parseDuration(reset);
    if (parsed !== null) return parsed;
  }

  // Full jitter. Retrying in lockstep after a shared limit is how one batch's
  // retries collide with the next batch's first attempt.
  const ceiling = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return Math.floor(ceiling * Math.random());
}

/** Groq writes windows as `2m59.56s`, `7.66s`, `1h`. Bare numbers are seconds. */
export function parseDuration(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  const bare = Number(trimmed);
  if (Number.isFinite(bare)) return Math.max(0, bare * 1000);

  const pattern = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let matched = false;
  for (const match of trimmed.matchAll(pattern)) {
    matched = true;
    const value = Number(match[1]);
    switch (match[2]) {
      case 'ms':
        total += value;
        break;
      case 's':
        total += value * 1000;
        break;
      case 'm':
        total += value * 60_000;
        break;
      case 'h':
        total += value * 3_600_000;
        break;
    }
  }
  return matched ? total : null;
}

/** A sleep that gives up the moment the request is abandoned. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * A message built from the STATUS, never from the body.
 *
 * Groq's error bodies can echo request content back, and this string reaches an
 * SSE `error` frame and the server log. The status is enough to act on.
 */
function describeFailure(status: number, bodyBytes: number): string {
  if (status === 401 || status === 403) return 'The provider rejected the API key.';
  if (status === 429) return 'The provider rate limit was reached.';
  // The size is the whole diagnosis for a 413 and is not sensitive. Without it
  // the message says only "too large", and finding out how large means adding
  // a log line and reproducing — which is what happened the first time.
  if (status === 413) {
    return `The provider refused a ${Math.round(bodyBytes / 1024)}KB request as too large.`;
  }
  if (status >= 500) return 'The provider is unavailable.';
  return `The provider refused the request (HTTP ${status}).`;
}

/** Server-side only. Never reaches a client, never carries the key. */
async function logRejection(response: Response): Promise<void> {
  try {
    const text = await response.text();
    console.error(`[groq] ${response.status} rejected: ${text.slice(0, 600)}`);
  } catch {
    console.error(`[groq] ${response.status} rejected, and the body could not be read.`);
  }
}

export interface GroqProviderOptions {
  apiKey: string;
  /** Injected in tests. Defaults to the global. */
  fetchImpl?: typeof fetch;
  endpoint?: string;
}

export function createGroqProvider(options: GroqProviderOptions): Provider {
  const doFetch = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint ?? ENDPOINT;

  return {
    id: 'groq',
    capabilities: GROQ_CAPABILITIES,
    evaluation: null,

    async structured(request: StructuredRequest): Promise<StructuredResponse> {
      const { schema } = toStrictSubset(request.schema);
      const body = JSON.stringify({
        model: request.model,
        /**
         * A reasoning model spends `max_completion_tokens` on its own thinking
         * BEFORE it writes anything, and this codebase computes that budget
         * from the size of the expected ANSWER — five picks plus an envelope.
         *
         * Measured: a two-candidate shortlist worked; forty candidates against
         * eighty-six syllabus sections returned HTTP 400
         * `json_validate_failed` with `failed_generation: ""`. Not a rejected
         * schema — the model reasoned until the budget was gone and emitted
         * nothing at all. The empty string is the whole diagnosis.
         *
         * Low effort rather than a larger budget: the callers' budgets are
         * calibrated against real output sizes and are correct, and raising
         * them everywhere to fund invisible reasoning would inflate every cost
         * estimate for output nobody sees. Providers that do not know the field
         * ignore it.
         */
        reasoning_effort: 'low',
        max_completion_tokens: request.maxTokens,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: request.schemaName, schema, strict: true },
        },
      });

      let slept = 0;

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const response = await doFetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${options.apiKey}`,
          },
          body,
          signal: request.signal,
        });

        if (response.ok) {
          const payload = (await response.json()) as Record<string, unknown>;
          const choice = (payload.choices as Record<string, unknown>[] | undefined)?.[0];
          const message = choice?.message as Record<string, unknown> | undefined;
          const content = typeof message?.content === 'string' ? message.content : null;
          return {
            json: content !== null && content.trim() !== '' ? content : null,
            stopReason: mapFinishReason(choice?.finish_reason),
            usage: mapUsage(payload.usage),
          };
        }

        // 400 is a rejected schema or a malformed request. Retrying hides a bug
        // and spends the allowance proving the same thing four times.
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          // The body goes to the SERVER LOG only, never into the thrown message.
          // A 4xx from this provider is almost always a schema or shape problem
          // and the body says which — but it can echo request content back, and
          // the thrown message reaches an SSE frame the device renders.
          await logRejection(response);
          throw new GroqRefusal(describeFailure(response.status, body.length), 'rejected');
        }

        const asked = retryDelayFromHeaders(response.headers, attempt) ?? BASE_BACKOFF_MS;

        // A window measured in minutes is a daily allowance. Waiting it out
        // holds a reservation for no gain; under-delivering is a reported,
        // recoverable outcome and this is how it gets reported honestly.
        if (response.status === 429 && asked > DAILY_WINDOW_MS) {
          throw new GroqRefusal(
            'The free tier allowance is used up for now. Try again later.',
            'daily_limit',
          );
        }

        // Clamped HERE, where it bounds a wait, and not in the header reader
        // where it would erase the daily signal.
        const delay = Math.min(asked, MAX_BACKOFF_MS);
        const last = attempt === MAX_ATTEMPTS - 1;
        if (last || slept + delay > BACKOFF_BUDGET_MS) {
          throw new GroqRefusal(
            describeFailure(response.status, body.length),
            response.status === 429 ? 'rate_limited' : 'unavailable',
          );
        }

        await sleep(delay, request.signal);
        slept += delay;
      }

      // Unreachable: the loop either returns or throws. Present so the function
      // has no implicit path that could return undefined after a refactor.
      throw new GroqRefusal('The provider did not answer.', 'unavailable');
    },
  };
}

export { ZERO as GROQ_ZERO_USAGE };
