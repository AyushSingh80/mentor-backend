/**
 * The Anthropic adapter.
 *
 * Everything Anthropic-shaped lives here and nowhere else: the client, the
 * `cache_control` breakpoint, `output_config.format`, and the translation from
 * the SDK's `stop_reason` vocabulary to the four values this server acts on.
 * The seven structured call sites and `/evaluate` now speak the port in
 * `types.ts` and know none of it.
 *
 * The two model calls below are the ones that were in `mcq/runner.ts`,
 * `ca/runner.ts`, `drills/runner.ts`, `interview/runner.ts` and
 * `routes/evaluate.ts` until this phase, moved rather than rewritten. All seven
 * structured calls sent an identical request apart from model, system, user,
 * schema and `max_tokens` — including the cache breakpoint, which is why it is
 * unconditional here rather than a flag on the port.
 */

import Anthropic from '@anthropic-ai/sdk';

import { readUsage } from '../anthropic.js';
import { config } from '../config.js';
import type {
  EvaluationRunner,
  Provider,
  ProviderCapabilities,
  StopReason,
  StructuredRequest,
  StructuredResponse,
} from './types.js';

/**
 * Constructed unconditionally, with an empty key when none is configured.
 *
 * The client is inert either way — it makes no request until something calls
 * it, and nothing calls it in headlines mode. Guarding the construction would
 * mean every call site handling a null client, which is a lot of branching to
 * express a rule `requireCapability` already enforces at the route edge.
 *
 * Module-private on purpose. Exporting it would make "reach around the port and
 * call the SDK directly" a one-line import, which is exactly the drift this
 * phase exists to prevent. The key is never logged and never leaves this module.
 */
const client = new Anthropic({ apiKey: config.anthropicApiKey ?? '' });

/* --------------------------------------------------------------- the SDK seam */

/**
 * The exact request this adapter sends, and the exact fields it reads back.
 *
 * Declared as an interface rather than reached for through the SDK types so the
 * adapter can be driven by a scripted call in a test. Without this there is no
 * way to prove the request shape — the cache breakpoint, the single system
 * turn, the schema — without a network call and a real key, and a provider
 * boundary nobody can test is a provider boundary that drifts.
 */
export interface AnthropicStructuredParams {
  model: string;
  max_tokens: number;
  system: { type: 'text'; text: string; cache_control: { type: 'ephemeral' } }[];
  messages: { role: 'user'; content: string }[];
  output_config: {
    format: {
      type: 'json_schema';
      schema: { [key: string]: unknown };
      parse(content: string): string;
    };
  };
}

export interface AnthropicStructuredReply {
  /** The first text block, unparsed — see `passThrough` below. */
  parsed_output: string | null;
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
}

export type AnthropicStructuredCall = (
  params: AnthropicStructuredParams,
  options: { signal: AbortSignal },
) => Promise<AnthropicStructuredReply>;

/**
 * The `parse` the SDK requires, doing nothing.
 *
 * `messages.parse` populates `parsed_output` by running the format's `parse`
 * over the first text block, and returns null when there is no text block at
 * all. Handing it the identity function therefore yields exactly "the raw JSON
 * document, or null" — which is what the port promises — while leaving the
 * REAL parsing where it already lives, in each `schema.ts`'s `safeFormat`.
 * That matters: `safeFormat.parse` never throws, so a malformed reply still
 * reports the tokens Anthropic already billed. A parser that threw here would
 * reject the promise and lose them.
 */
function passThrough(content: string): string {
  return content;
}

const sdkStructuredCall: AnthropicStructuredCall = (params, options) =>
  client.messages.parse(params, options);

/* ------------------------------------------------------------- stop reasons */

/**
 * The SDK's `stop_reason` narrowed to the vocabulary the pipelines act on.
 *
 * Only `'max_tokens'` is load-bearing: `mcq/pipeline.ts`, `ca/pipeline.ts` and
 * `drills/pipeline.ts` all discard a whole chunk on it, because a truncated
 * structured reply parses cleanly and is short by questions nobody counted.
 * That mapping is one-to-one and must stay so.
 *
 * Everything else that is not a refusal collapses to `'end_turn'`. That is
 * behaviour-preserving rather than merely convenient: no code has ever compared
 * `stopReason` against anything but `'max_tokens'`, and the value never reaches
 * a client — the pipelines carry it in their result objects and the routes drop
 * it. `'stop_sequence'`, `'tool_use'` and `'pause_turn'` were therefore already
 * indistinguishable from `'end_turn'` in effect.
 *
 * KNOWN GAP, deliberately left: `'model_context_window_exceeded'` also collapses
 * to `'end_turn'`, exactly as it did before this refactor, so a reply cut off by
 * the context window is NOT discarded as truncated. Treating it as truncation is
 * probably right and is a behaviour change, which is why it is not being made in
 * a refactor phase.
 */
export function mapStopReason(raw: string | null): StopReason {
  if (raw === null) return null;
  if (raw === 'max_tokens') return 'max_tokens';
  if (raw === 'refusal') return 'refusal';
  return 'end_turn';
}

/* --------------------------------------------------------- the evaluation port */

const anthropicEvaluationRunner: EvaluationRunner = (request) => {
  const run = client.messages.stream({
    model: request.model,
    max_tokens: 4096,
    system: request.system,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: request.instruction }, ...request.blocks] as never,
      },
    ],
  });

  return {
    onText(listener) {
      run.on('text', listener);
    },
    onUsage(listener) {
      // Track usage as it arrives, not only on completion. If the stream breaks
      // mid-generation, those tokens were still consumed and billed by
      // Anthropic — reading them only from finalMessage() would leave the
      // counters at zero and under-count real spend against the cap.
      run.on('streamEvent', (event) => {
        if (event.type === 'message_start') {
          listener({ inputTokens: event.message.usage.input_tokens });
        } else if (event.type === 'message_delta') {
          listener({ outputTokens: event.usage.output_tokens });
        }
      });
    },
    async finalUsage() {
      const final = await run.finalMessage();
      return {
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
      };
    },
    abort() {
      run.abort();
    },
  };
};

/* ------------------------------------------------------------- the provider */

/**
 * Anthropic's own limits, as a value the registry and future call sites can
 * read. `maxImagesPerRequest` is the API's ceiling, not this server's — the
 * server's own limit is `MAX_FILES` in `upload.ts` and is far lower. Both are
 * real and the smaller one wins; recording the provider's here is what lets a
 * later phase notice that a provider's ceiling has dropped BELOW `MAX_FILES`.
 */
const ANTHROPIC_CAPABILITIES: ProviderCapabilities = {
  structured: true,
  evaluation: true,
  acceptsPdfDocuments: true,
  maxImagesPerRequest: 100,
  reportsCacheTokens: true,
  // No ceiling worth modelling: the largest prompt this app builds is far
  // inside what the Messages API accepts.
  maxRequestBytes: Number.POSITIVE_INFINITY,
};

/**
 * Built by a factory so a test can drive the adapter with a scripted SDK call.
 * Production uses the no-argument form, which is the same code path.
 */
export function createAnthropicProvider(
  structuredCall: AnthropicStructuredCall = sdkStructuredCall,
  evaluation: EvaluationRunner = anthropicEvaluationRunner,
): Provider {
  return {
    id: 'anthropic',
    capabilities: ANTHROPIC_CAPABILITIES,
    evaluation,

    async structured(request: StructuredRequest): Promise<StructuredResponse> {
      const reply = await structuredCall(
        {
          model: request.model,
          // NOT a hardcoded ceiling. Five questions with three statements and
          // four rationales each is several thousand output tokens; at 4096
          // every chunk truncates, and a truncated chunk is one that was paid
          // for and delivered nothing. Every caller computes its own.
          max_tokens: request.maxTokens,
          system: [
            {
              type: 'text',
              text: request.system,
              // The system prompt is identical across every chunk of every
              // batch and across both calls of a two-call pipeline. Caching it
              // is the difference between paying for it four times and paying
              // once; the read tokens are counted by `readUsage`, never dropped.
              cache_control: { type: 'ephemeral' },
            },
          ],
          messages: [{ role: 'user', content: request.user }],
          // `schemaName` has nowhere to go: Anthropic's JSONOutputFormat is
          // `{ type, schema }` and carries no name. Dropped here rather than
          // omitted from the port, because Groq requires one.
          output_config: {
            format: { type: 'json_schema', schema: request.schema, parse: passThrough },
          },
        },
        { signal: request.signal },
      );

      return {
        json: reply.parsed_output,
        stopReason: mapStopReason(reply.stop_reason),
        usage: readUsage(reply.usage),
      };
    },
  };
}

export const anthropicProvider: Provider = createAnthropicProvider();
