/**
 * JSON Schemas for structured outputs.
 *
 * Hand-written rather than generated from zod. A schema here is a wire
 * contract that is hashed into `promptVersion`, so it needs to be a value that
 * is read and diffed directly, not the output of a library whose emitted shape
 * can change under a patch release and silently re-version every question in
 * the bank.
 *
 * WHY STRUCTURED OUTPUTS AND NOT A FENCED BLOCK: a batch response contains
 * twenty objects. Fence-scraping has to guess which fence is the answer, and
 * `extractTrailingJson` guesses "the last one" — correct for one trailing
 * score block, silently lossy for a list. `output_config.format` returns one
 * document conforming to this schema or it fails loudly.
 */

import type { JSONOutputFormat } from '@anthropic-ai/sdk/resources/messages/messages';
import { QUESTION_FORMS } from './types.js';

/** Statement-based questions carry 2 or 3 statements; 4 options always. */
export const MIN_STATEMENTS = 2;
export const MAX_STATEMENTS = 3;
export const OPTION_COUNT = 4;

export const GENERATION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      description:
        'Questions that survived your own review. Returning fewer than asked is a correct outcome; padding the list is not.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'form',
          'stem',
          'statements',
          'options',
          'answerIndex',
          'eliminationRationale',
          'factKey',
          'verifiabilityAnchor',
        ],
        properties: {
          form: { type: 'string', enum: [...QUESTION_FORMS] },
          stem: {
            type: 'string',
            description:
              'The question stem, ending in the standard closing line for the chosen form.',
          },
          statements: {
            type: 'array',
            minItems: MIN_STATEMENTS,
            maxItems: MAX_STATEMENTS,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['index', 'text', 'isTrue'],
              properties: {
                index: { type: 'integer', minimum: 1, maximum: MAX_STATEMENTS },
                text: { type: 'string' },
                isTrue: {
                  type: 'boolean',
                  description:
                    'Your verdict on this statement alone. The server recomputes the key from these and discards the question if it disagrees with answerIndex.',
                },
              },
            },
          },
          options: {
            type: 'array',
            minItems: OPTION_COUNT,
            maxItems: OPTION_COUNT,
            items: { type: 'string' },
            description:
              'Each option must name a DISTINCT set of statement numbers, e.g. "1 only", "2 and 3 only", "1, 2 and 3", "Neither 1 nor 2".',
          },
          answerIndex: { type: 'integer', minimum: 0, maximum: OPTION_COUNT - 1 },
          eliminationRationale: {
            type: 'array',
            minItems: OPTION_COUNT,
            maxItems: OPTION_COUNT,
            items: { type: 'string' },
            description:
              'One entry per option in the same order, including the key. For a wrong option, name the specific misconception that makes an aspirant choose it.',
          },
          factKey: {
            type: 'string',
            description:
              'Stable identifier for the underlying fact, lowercase, colon-separated, e.g. "polity:article-368:amendment-procedure". Two questions on the same fact must share it even when worded completely differently.',
          },
          verifiabilityAnchor: {
            type: 'string',
            description:
              'Where this can be checked: a constitutional article, a named Act and year, a named report, or a standard textbook chapter.',
          },
        },
      },
    },
  },
};

export const VERIFICATION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'questionIndex',
          'chosenIndex',
          'confidence',
          'ambiguous',
          'timeDependent',
          'factuallyDisputed',
        ],
        properties: {
          questionIndex: {
            type: 'integer',
            minimum: 0,
            description: 'Position of the question in the list you were given.',
          },
          chosenIndex: {
            type: 'integer',
            minimum: 0,
            maximum: OPTION_COUNT - 1,
            description: 'The option you believe is correct, reasoning from scratch.',
          },
          confidence: {
            type: 'string',
            // 'low' is deliberately absent. See VerificationVerdict in types.ts.
            enum: ['high', 'medium'],
          },
          ambiguous: {
            type: 'boolean',
            description:
              'True if more than one option could be defended, or the stem is open to more than one reading.',
          },
          timeDependent: {
            type: 'boolean',
            description: 'True if the answer could change with time.',
          },
          factuallyDisputed: {
            type: 'boolean',
            description: 'True if standard sources disagree about this.',
          },
        },
      },
    },
  },
};

/**
 * Format objects for `messages.parse()`.
 *
 * The `parse` function is what makes `parsed_output` typed and populated: with
 * a bare schema the SDK returns `parsed_output: null`. It is written to NEVER
 * THROW, returning a discriminated result instead, because the SDK's own
 * parser turns a thrown error into a rejected request — which would lose the
 * usage numbers for a call that has already been billed by Anthropic. A
 * truncated response still costs money and still has to be recorded.
 */
export type ParseOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

function safeFormat<T>(schema: Record<string, unknown>): JSONOutputFormat & {
  parse(content: string): ParseOutcome<T>;
} {
  return {
    type: 'json_schema',
    schema,
    parse(content: string): ParseOutcome<T> {
      try {
        return { ok: true, value: JSON.parse(content) as T };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  };
}

export interface RawGenerationOutput {
  questions?: unknown;
}

export interface RawVerificationOutput {
  verdicts?: unknown;
}

export const generationFormat = safeFormat<RawGenerationOutput>(GENERATION_SCHEMA);
export const verificationFormat = safeFormat<RawVerificationOutput>(VERIFICATION_SCHEMA);

/** Canonical bytes of a schema, for hashing it into the prompt version. */
export function schemaFingerprint(schema: Record<string, unknown>): string {
  return JSON.stringify(schema);
}
