/**
 * The provider ports.
 *
 * Two ports, deliberately, because the two things this server asks a model to
 * do have nothing in common. `Provider.structured` is one request in, one JSON
 * document out, non-streaming — seven call sites use it and all seven want the
 * same five things. `EvaluationRunner` is a long streamed prose reply with
 * scanned pages attached, and it has exactly one call site.
 *
 * ## Why the structured port is this narrow
 *
 * Every one of the seven call sites sends exactly one system turn, one user
 * turn and one schema. None sends tools, none sends conversation history, none
 * sends more than one user turn. So the port takes exactly that and nothing
 * else.
 *
 * The temptation is to accept `messages: Message[]` and "leave room". Do not.
 * A wider interface invites drift, and drift across a provider boundary breaks
 * SILENTLY: a second user turn that Anthropic concatenates and Gemini rejects
 * is not a type error, it is a 400 in production on the one call site that
 * grew the extra turn. The narrow shape makes that a compile error instead.
 *
 * ## Why it is not modelled on Anthropic
 *
 * The eventual providers are Gemini (evaluation tier) and Groq (bulk tier).
 * Anthropic-only concepts therefore stay OUT of the port and live in the
 * adapter: `cache_control` on the system block, `output_config.format`, the
 * `stop_reason` vocabulary. What crosses the boundary is what all three can
 * express — a system string, a user string, a JSON Schema, a token ceiling.
 */

/**
 * Every provider this server can be pointed at.
 *
 * A union rather than `string` on purpose. `registry.ts` holds a
 * `Record<ProviderId, Provider>`, so adding an id here without adding an
 * adapter is a COMPILE error — which is the failure this phase exists to make
 * impossible. Phase 3 adds 'groq' and 'gemini' and the table forces both
 * halves of that change to land together.
 */
export const PROVIDER_IDS = ['anthropic', 'groq', 'gemini'] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * What the request carries, for a provider that has to care.
 *
 * `personal` is her own writing or her own DAF — the drill marking call and
 * the interview question call. `public` is syllabus topics and published news.
 * Nothing branches on this today and the Anthropic adapter ignores it; it is
 * on the request because the moment a second provider exists, the question
 * "may this text go to that endpoint" has to be answerable AT THE CALL SITE,
 * and retrofitting it later means auditing seven call sites under time
 * pressure rather than one adapter at leisure.
 */
export type DataClass = 'public' | 'personal';

/**
 * Why a reply stopped, in the only vocabulary this server acts on.
 *
 * `'max_tokens'` IS LOAD-BEARING. Three pipelines discard a whole chunk on it
 * (`mcq/pipeline.ts`, `ca/pipeline.ts`, `drills/pipeline.ts`) because a
 * truncated structured reply parses perfectly and is missing questions nobody
 * counted. An adapter that maps a provider's truncation signal to anything
 * else silently accepts short output; that is the single most expensive
 * mistake available in this file.
 *
 * `'error'` has no Anthropic equivalent and is never produced by the Anthropic
 * adapter, which throws instead — a network failure is a rejected promise, the
 * same as today. It exists for a provider whose SDK reports a failed
 * generation in-band rather than by throwing.
 */
export type StopReason = 'end_turn' | 'max_tokens' | 'refusal' | 'error' | null;

/**
 * The four counts the spend ledger records.
 *
 * The cache pair is not decoration: it is NOT included in `inputTokens` on the
 * wire, and every chunk after the first in an MCQ batch is a cache read. A
 * provider that cannot report them returns zeros and declares
 * `reportsCacheTokens: false` rather than folding them into the input count,
 * so the ledger never double-counts.
 */
export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export const ZERO_TOKEN_COUNTS: TokenCounts = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

export interface StructuredRequest {
  /** Resolved by the caller from its tier. The port never picks a model. */
  model: string;
  /** Exactly one system turn. Adapters may cache it; callers may not assume so. */
  system: string;
  /** Exactly one user turn. */
  user: string;
  /**
   * A plain JSON Schema document. Not an SDK format object: the call site owns
   * the schema (it is hashed into `promptVersion`) and the adapter owns how its
   * provider is told about it.
   */
  schema: Record<string, unknown>;
  /**
   * A name for the schema. Anthropic has nowhere to put it; Groq's
   * `response_format: { type: 'json_schema', json_schema: { name, schema } }`
   * requires one. Supplied by every call site so no adapter has to invent it.
   */
  schemaName: string;
  maxTokens: number;
  dataClass: DataClass;
  /** For correlating logs. Not sent to any provider today. */
  requestId: string;
  signal: AbortSignal;
}

export interface StructuredResponse {
  /**
   * The raw JSON document, unparsed, or null when the reply carried no text.
   *
   * A STRING and not a parsed object, because the call site already owns a
   * parser: `safeFormat().parse` in each `schema.ts` returns a discriminated
   * result and never throws, precisely so a malformed reply still reports the
   * usage that was already billed. Parsing here would either duplicate that or
   * throw the usage away.
   */
  json: string | null;
  stopReason: StopReason;
  usage: TokenCounts;
}

/**
 * What a provider can do, as a value rather than as a comment.
 *
 * Read at boot by `registry.ts`. A capability that is only documented is a
 * capability nobody checks — binding a structured-only provider to
 * `PROVIDER_EVALUATION` would then fail on the first marked answer instead of
 * at startup.
 */
export interface ProviderCapabilities {
  /** Can honour `structured()`. False makes the provider unusable on any tier. */
  structured: boolean;
  /** Can honour the streaming evaluation port. Gates `PROVIDER_EVALUATION`. */
  evaluation: boolean;
  /** Accepts a PDF as a native document block rather than rasterised pages. */
  acceptsPdfDocuments: boolean;
  /** Provider-side ceiling on image blocks in one request. */
  maxImagesPerRequest: number;
  /** Reports cache creation and cache read tokens separately from input. */
  reportsCacheTokens: boolean;
  /**
   * Largest request body the provider will accept, in bytes.
   *
   * Declared rather than assumed because it is a real, differing limit and the
   * failure is silent-looking: Groq's free tier answers 413 for a body Anthropic
   * takes without comment. Measured live on 2026-09-08 — 438 syllabus leaves in
   * the digest prompt (≈39 KB) is refused, ≈25 KB is accepted.
   *
   * `Infinity` means "no ceiling worth modelling", which is the honest value for
   * a provider whose limit is far above anything this app builds.
   */
  maxRequestBytes: number;
}

/* ------------------------------------------------------- the evaluation port */

/**
 * A page of her answer.
 *
 * Base64 plus a media type is the common denominator: Anthropic takes
 * `{ type: 'image' | 'document', source: { type: 'base64', ... } }`, Gemini
 * takes `inlineData: { mimeType, data }`. The PDF case is a separate variant
 * rather than another media type because whether a provider takes a PDF
 * NATIVELY is a capability the caller has to be able to ask about — see
 * `acceptsPdfDocuments`.
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string };
    }
  | {
      type: 'document';
      source: { type: 'base64'; media_type: 'application/pdf'; data: string };
    };

export interface EvaluationRequest {
  model: string;
  system: string;
  instruction: string;
  blocks: ContentBlock[];
}

export interface EvaluationTokenCounts {
  inputTokens: number;
  outputTokens: number;
}

/**
 * The slice of a streaming model call `/evaluate` actually depends on.
 *
 * Not a stream object and not an async iterator: the route needs to attach
 * listeners before the first token, bill partial usage when the stream breaks,
 * and abort on client disconnect. Those four methods are all of it.
 */
export interface EvaluationRun {
  onText(listener: (delta: string) => void): void;
  /** Partial counts as they arrive, so a broken stream still bills correctly. */
  onUsage(listener: (counts: Partial<EvaluationTokenCounts>) => void): void;
  finalUsage(): Promise<EvaluationTokenCounts>;
  abort(): void;
}

export type EvaluationRunner = (request: EvaluationRequest) => EvaluationRun;

/* -------------------------------------------------------------- the provider */

export interface Provider {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities;

  /** One system turn, one user turn, one schema. See the header. */
  structured(request: StructuredRequest): Promise<StructuredResponse>;

  /**
   * The streaming evaluation port, or null when this provider does not offer
   * one. Null and `capabilities.evaluation === false` must agree; the registry
   * asserts it at boot, so the flag can never drift from the implementation.
   */
  readonly evaluation: EvaluationRunner | null;
}
