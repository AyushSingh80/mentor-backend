/**
 * Text helpers, and nothing that talks to a model.
 *
 * The SDK client, the structured call and the streaming call all moved to
 * `providers/anthropic.ts` when the provider port landed. What is left is the
 * part that was never really about Anthropic: reading a fenced score block out
 * of prose, the media types the upload filter allows, and normalising a usage
 * object. `readUsage` stays because its argument is Anthropic-shaped and its
 * only caller is that adapter; everything else here has callers that are not.
 *
 * No import of the SDK, deliberately. `upload.ts` needs `isImageMediaType` on
 * every request and importing this file must not drag a client — or a key —
 * into a module that has no business with either.
 */

/** Image media types the Messages API accepts as image blocks. */
export const IMAGE_MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const;

export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

export function isImageMediaType(value: string): value is ImageMediaType {
  return (IMAGE_MEDIA_TYPES as readonly string[]).includes(value);
}

/**
 * Pulls the trailing ```json fence out of a model response.
 *
 * The rubric asks for prose first and the score block last, so the scores
 * reflect the reasoning above them rather than anchoring it. Returns null
 * rather than throwing: a missing or malformed block should degrade to
 * "feedback without a chartable score", never to a lost evaluation.
 *
 * SCOPED TO EVALUATION. Do not reuse this for any endpoint that expects a
 * LIST of objects. `matches.at(-1)` returns the LAST fence, which is correct
 * for one trailing score block and catastrophic for a batch: ask for twenty
 * questions, get twenty fences, and this silently returns question twenty
 * while reporting `parsed: true`. Nineteen questions vanish with no error to
 * notice. Batch endpoints use `output_config.format` structured outputs
 * instead (see src/mcq/schema.ts), which returns one document, not a stream of
 * fences to guess between.
 */
export function extractTrailingJson(text: string): unknown | null {
  const matches = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  const last = matches.at(-1);
  if (!last?.[1]) return null;
  try {
    return JSON.parse(last[1].trim());
  } catch {
    return null;
  }
}

/**
 * Strips the trailing score fence so the app can render clean feedback prose.
 *
 * Deliberately not a single `$`-anchored regex: with a lazy quantifier, that
 * backtracks until it can reach the end of the string, so an earlier
 * illustrative ```json fence in the feedback causes it to match from the FIRST
 * fence to the LAST — silently deleting all the real feedback in between.
 * Locating the last fence explicitly and slicing avoids that entirely.
 */
export function stripTrailingJson(text: string): string {
  const matches = [...text.matchAll(/```json\s*[\s\S]*?```/g)];
  const last = matches.at(-1);
  if (!last || last.index === undefined) return text.trimEnd();

  // Only strip when the fence really is trailing; otherwise it is part of the
  // prose and removing it would lose content.
  if (text.slice(last.index + last[0].length).trim() !== '') return text.trimEnd();

  return text.slice(0, last.index).trimEnd();
}

/**
 * Normalises the SDK's usage object into the counts the ledger records.
 *
 * `cache_creation_input_tokens` and `cache_read_input_tokens` are nullable on
 * the wire and are NOT included in `input_tokens`. Reading only `input_tokens`
 * therefore under-counts every cached call — which is every MCQ chunk after
 * the first, since they all share one long system prompt. Weighting happens in
 * `billableInputTokens`; this function only makes sure nothing is dropped.
 */
export function readUsage(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}): {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
} {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
  };
}
