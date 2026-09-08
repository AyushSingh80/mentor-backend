/**
 * Gemini, for the evaluation tier.
 *
 * The only provider here that can serve `/evaluate`, and the reason is narrow:
 * marking a Mains answer means reading three to five pages of handwritten
 * Indian-English exam prose, written at speed, with margin notes, arrows and
 * crossings-out. Gemini has the strongest vision of the free tiers and takes a
 * PDF as a native document — which matters more than it sounds, because the
 * capture path she actually uses is a phone scanner app that produces PDFs.
 *
 * ## Why this is a separate file from `groq.ts`
 *
 * They share almost nothing. Groq answers one structured POST; this streams
 * server-sent events, carries base64 pages, and has to report partial usage
 * when the stream breaks. Folding both into one "OpenAI-compatible-ish" adapter
 * would mean a file where half the branches are dead on every call.
 *
 * ## The failure mode this adapter is most exposed to
 *
 * A weak vision model does not refuse a page it cannot read — it misreads it
 * fluently and marks the misreading confidently. She is drilling the topic
 * precisely because she cannot detect that. So before this is trusted, run the
 * calibration in `DEPLOYMENT.md`: ten real scans, and gate on whether the
 * TRANSCRIPTION matches what she wrote, not on whether the scores look
 * plausible. A marking difference is arguable between two competent markers; a
 * misread page is marking a different answer.
 *
 * ## The key
 *
 * Read once at construction, never logged, never in an error message, and never
 * in the URL — it travels as `x-goog-api-key`, not a query parameter, because a
 * query parameter lands in every proxy log between here and Google.
 */

import type {
  ContentBlock,
  EvaluationRequest,
  EvaluationRun,
  EvaluationTokenCounts,
  Provider,
  ProviderCapabilities,
  StructuredRequest,
  StructuredResponse,
  TokenCounts,
} from './types.js';
import { toStrictSubset } from './json-schema.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export const GEMINI_CAPABILITIES: ProviderCapabilities = {
  structured: true,
  evaluation: true,
  /** The whole reason this provider serves evaluation. */
  acceptsPdfDocuments: true,
  maxImagesPerRequest: 16,
  /** No separate cache accounting on this path. Zeros, never estimates. */
  reportsCacheTokens: false,
  /**
   * Generous, and deliberately not `Infinity`.
   *
   * The inline-data path has a real request ceiling around 20MB, and
   * `upload.ts` already caps a request at 25MB of files before base64 expands
   * it by a third. So the app's own limit is the binding one and this number
   * exists to make that relationship visible rather than accidental.
   */
  maxRequestBytes: 18_000_000,
};

/** Raised for a condition the caller should surface, not retry. */
export class GeminiRefusal extends Error {
  constructor(
    message: string,
    readonly kind: 'rejected' | 'rate_limited' | 'unavailable',
  ) {
    super(message);
    this.name = 'GeminiRefusal';
  }
}

/**
 * A message built from the STATUS, never the body.
 *
 * Google's error bodies quote the request back, and this string reaches an SSE
 * frame the phone renders and the server log.
 */
function describeFailure(status: number): string {
  if (status === 400) return 'The provider refused the request as malformed.';
  if (status === 401 || status === 403) return 'The provider rejected the API key.';
  if (status === 413) return 'The pages were too large for the provider.';
  if (status === 429) return 'The provider rate limit was reached.';
  if (status >= 500) return 'The provider is unavailable.';
  return `The provider refused the request (HTTP ${status}).`;
}

/**
 * `ContentBlock` to Gemini's `parts`.
 *
 * Both image and document collapse to `inlineData`, which is why the block type
 * carries the distinction the wire does not: the CALLER needs to know whether a
 * PDF survives, and `acceptsPdfDocuments` is how it asks.
 */
export function toParts(blocks: readonly ContentBlock[]): Record<string, unknown>[] {
  return blocks.map((block) => {
    if (block.type === 'text') return { text: block.text };
    return { inlineData: { mimeType: block.source.media_type, data: block.source.data } };
  });
}

/** Gemini's `usageMetadata` to the two counts `/evaluate` bills on. */
export function toEvaluationUsage(raw: unknown): Partial<EvaluationTokenCounts> {
  const meta = (raw ?? {}) as Record<string, unknown>;
  const num = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  const input = num(meta.promptTokenCount);
  const output = num(meta.candidatesTokenCount);
  const counts: Partial<EvaluationTokenCounts> = {};
  if (input !== undefined) counts.inputTokens = input;
  if (output !== undefined) counts.outputTokens = output;
  return counts;
}

/** Text out of one streamed chunk. Absent parts are normal, not an error. */
export function textOfChunk(chunk: unknown): string {
  const payload = (chunk ?? {}) as Record<string, unknown>;
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  let out = '';
  for (const candidate of candidates) {
    const content = (candidate as Record<string, unknown>).content as
      | Record<string, unknown>
      | undefined;
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    for (const part of parts) {
      const text = (part as Record<string, unknown>).text;
      if (typeof text === 'string') out += text;
    }
  }
  return out;
}

/**
 * Splits an SSE body into `data:` payloads.
 *
 * Carries a buffer across calls because a chunk boundary lands mid-frame
 * routinely — the app's own `sse-contract.test.ts` exists for the same reason on
 * the other side of the wire.
 */
export function createSseSplitter(): (chunk: string) => string[] {
  let buffer = '';
  return (chunk: string): string[] => {
    buffer += chunk;
    const out: string[] = [];
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (payload !== '' && payload !== '[DONE]') out.push(payload);
      }
      index = buffer.indexOf('\n');
    }
    return out;
  };
}

export interface GeminiProviderOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export function createGeminiProvider(options: GeminiProviderOptions): Provider {
  const doFetch = options.fetchImpl ?? fetch;
  const base = options.baseUrl ?? BASE;

  function headers(): Record<string, string> {
    return { 'content-type': 'application/json', 'x-goog-api-key': options.apiKey };
  }

  return {
    id: 'gemini',
    capabilities: GEMINI_CAPABILITIES,

    async structured(request: StructuredRequest): Promise<StructuredResponse> {
      const { schema } = toStrictSubset(request.schema);
      const response = await doFetch(`${base}/${request.model}:generateContent`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: request.system }] },
          contents: [{ role: 'user', parts: [{ text: request.user }] }],
          generationConfig: {
            maxOutputTokens: request.maxTokens,
            responseMimeType: 'application/json',
            responseSchema: schema,
          },
        }),
        signal: request.signal,
      });

      if (!response.ok) {
        throw new GeminiRefusal(
          describeFailure(response.status),
          response.status === 429 ? 'rate_limited' : response.status >= 500 ? 'unavailable' : 'rejected',
        );
      }

      const payload = (await response.json()) as Record<string, unknown>;
      const text = textOfChunk(payload);
      const meta = toEvaluationUsage(payload.usageMetadata);
      const usage: TokenCounts = {
        inputTokens: meta.inputTokens ?? 0,
        outputTokens: meta.outputTokens ?? 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      };

      const finish = (
        (payload.candidates as Record<string, unknown>[] | undefined)?.[0] as
          | Record<string, unknown>
          | undefined
      )?.finishReason;

      return {
        json: text.trim() === '' ? null : text,
        // `MAX_TOKENS` maps to the value three pipelines discard a chunk on.
        // Mapped wrong, a truncated reply is banked instead of thrown away.
        stopReason:
          finish === 'STOP'
            ? 'end_turn'
            : finish === 'MAX_TOKENS'
              ? 'max_tokens'
              : finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT'
                ? 'refusal'
                : 'error',
        usage,
      };
    },

    evaluation(request: EvaluationRequest): EvaluationRun {
      const controller = new AbortController();
      const textListeners: ((delta: string) => void)[] = [];
      const usageListeners: ((counts: Partial<EvaluationTokenCounts>) => void)[] = [];

      /**
       * The last counts seen, kept so a BROKEN stream still bills.
       *
       * `/evaluate` bills whatever arrived when a stream dies mid-answer. Losing
       * the running total there would mean a call that spent real tokens and
       * recorded none, which is the direction that quietly breaks a spend cap.
       */
      let latest: EvaluationTokenCounts = { inputTokens: 0, outputTokens: 0 };

      const done = (async (): Promise<EvaluationTokenCounts> => {
        const response = await doFetch(`${base}/${request.model}:streamGenerateContent?alt=sse`, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: request.system }] },
            contents: [
              { role: 'user', parts: [...toParts(request.blocks), { text: request.instruction }] },
            ],
          }),
          signal: controller.signal,
        });

        if (!response.ok || response.body === null) {
          throw new GeminiRefusal(
            describeFailure(response.status),
            response.status === 429 ? 'rate_limited' : 'rejected',
          );
        }

        const split = createSseSplitter();
        const decoder = new TextDecoder();
        const reader = response.body.getReader();

        for (;;) {
          const { done: finished, value } = await reader.read();
          if (finished) break;
          for (const payload of split(decoder.decode(value, { stream: true }))) {
            let chunk: unknown;
            try {
              chunk = JSON.parse(payload);
            } catch {
              // A frame that does not parse is dropped rather than fatal: the
              // answer already streamed is worth more than the parse error, and
              // the route's own validation is what decides if it is usable.
              continue;
            }

            const text = textOfChunk(chunk);
            if (text !== '') for (const listener of textListeners) listener(text);

            const counts = toEvaluationUsage((chunk as Record<string, unknown>).usageMetadata);
            if (counts.inputTokens !== undefined || counts.outputTokens !== undefined) {
              latest = {
                inputTokens: counts.inputTokens ?? latest.inputTokens,
                outputTokens: counts.outputTokens ?? latest.outputTokens,
              };
              for (const listener of usageListeners) listener(counts);
            }
          }
        }

        return latest;
      })();

      // Attached immediately so a rejection before `finalUsage()` is awaited
      // cannot become an unhandled rejection and take the process down.
      done.catch(() => undefined);

      return {
        onText(listener) {
          textListeners.push(listener);
        },
        onUsage(listener) {
          usageListeners.push(listener);
        },
        finalUsage() {
          return done;
        },
        abort() {
          controller.abort();
        },
      };
    },
  };
}
