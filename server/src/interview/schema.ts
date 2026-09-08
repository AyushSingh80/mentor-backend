/**
 * The JSON Schema for question generation.
 *
 * Hand-written, for the reason `mcq/schema.ts`, `ca/schema.ts` and
 * `drills/schema.ts` all give: a schema here is a wire contract hashed into
 * `promptVersion`, so it must be a value that is read and diffed directly
 * rather than the output of a library whose emitted shape can change under a
 * patch release and silently re-version a cohort.
 *
 * ## What is deliberately absent
 *
 * There is no `answer`, no `context`, no `background`, no `hint`. That is the
 * whole safety design of this phase and not an oversight — a field a fact could
 * travel in would be filled, and once filled it would be read.
 *
 * A fabricated question costs her an hour preparing something the board will
 * not ask. A fabricated fact about her home district costs her the interview:
 * she would repeat it to a board that knows the real figure, in the one exam
 * where being confidently wrong about your own home is unrecoverable.
 */

import type { JSONOutputFormat } from '@anthropic-ai/sdk/resources/messages/messages';
import { createHash } from 'node:crypto';
import { DAF_FIELDS, LIKELIHOODS, MAX_AREA_CHARS, MAX_QUESTION_CHARS } from './types.js';

export const QUESTIONS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      description:
        'The questions a board would actually ask, most likely first. Returning fewer than asked is correct when the form gives you little to work with; padding is not.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['field', 'area', 'question', 'likelihood'],
        properties: {
          field: {
            type: ['string', 'null'],
            enum: [...DAF_FIELDS, null],
            description:
              'The DAF field this follows from, taken from the entries supplied in the request. Null only for a question that follows from no single field.',
          },
          area: {
            type: 'string',
            maxLength: MAX_AREA_CHARS,
            description:
              'A short noun phrase grouping related questions — "District profile", "Why this optional". Reused across questions so they group; not a restatement of the question.',
          },
          question: {
            type: 'string',
            maxLength: MAX_QUESTION_CHARS,
            description:
              'The question, phrased as a board member would put it. A question and nothing else — never an answer, never a hint, and never a fact about the candidate or her district.',
          },
          likelihood: {
            type: 'string',
            enum: [...LIKELIHOODS],
            description:
              '`certain` for what almost every board asks (the home district, the optional, why the service). `likely` for a normal follow-up. `possible` for a question only a curious board reaches.',
          },
        },
      },
    },
  },
};

export type ParseOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

export interface RawQuestionsOutput {
  questions?: unknown;
}

/**
 * `parse` NEVER THROWS, returning a discriminated result instead, because the
 * SDK turns a thrown parser error into a rejected request — which would lose
 * the usage numbers for a call Anthropic has already billed.
 */
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

export const questionsFormat = safeFormat<RawQuestionsOutput>(QUESTIONS_SCHEMA);

/** Canonical bytes of a schema, for hashing it into the prompt version. */
export function schemaFingerprint(schema: Record<string, unknown>): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, entry]) => [key, canonical(entry)]),
      );
    }
    return value;
  };
  return createHash('sha256').update(JSON.stringify(canonical(schema))).digest('hex').slice(0, 12);
}
