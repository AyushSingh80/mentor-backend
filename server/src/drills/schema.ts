/**
 * JSON Schemas for the two structured-output calls.
 *
 * Hand-written, for the reason `mcq/schema.ts` and `ca/schema.ts` both give: a
 * schema here is a wire contract hashed into `promptVersion`, so it must be a
 * value that is read and diffed directly rather than the output of a library
 * whose emitted shape can change under a patch release and silently re-version
 * a month of drills.
 *
 * WHY STRUCTURED OUTPUTS AND NOT A FENCED BLOCK: both calls return a LIST, and
 * `extractTrailingJson` takes the LAST fence. Ask for six prompts, get six
 * fences, and it returns prompt six while reporting success. The evaluation
 * call is worse still — a per-part score list silently truncated to its last
 * entry would show her a 3/12 thesis and nothing else, which reads as a verdict
 * rather than as a bug.
 */

import type { JSONOutputFormat } from '@anthropic-ai/sdk/resources/messages/messages';
import { createHash } from 'node:crypto';
import {
  DRILL_KINDS,
  ESSAY_OUTLINE_PARTS,
  ETHICS_CASE_PARTS,
  MAX_CASE_DETAIL_CHARS,
  MAX_PROMPT_CHARS,
} from './types.js';

const ALL_PARTS = [...ESSAY_OUTLINE_PARTS, ...ETHICS_CASE_PARTS] as const;

/**
 * Call 1. A batch of drill prompts.
 *
 * `caseDetail` is nullable rather than absent for a non-case, because a schema
 * that omits the field entirely gives the model no place to put the situation
 * and it appends it to `promptText` instead — which then fails the device's
 * `drills_case_detail_matches_kind` CHECK, after being billed for.
 */
export const PROMPTS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['prompts'],
  properties: {
    prompts: {
      type: 'array',
      description:
        'The drill prompts, best first. Returning fewer than asked is the expected outcome when the syllabus scope is narrow; padding the list is not.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'promptText', 'caseDetail', 'syllabusSlug', 'why'],
        properties: {
          kind: {
            type: 'string',
            enum: [...DRILL_KINDS],
            description: 'Which kind of drill this prompt is for.',
          },
          promptText: {
            type: 'string',
            maxLength: MAX_PROMPT_CHARS,
            description:
              'For an essay: the topic exactly as a paper would print it, with no instructions attached. For a case: the one-line framing of the dilemma.',
          },
          caseDetail: {
            type: ['string', 'null'],
            maxLength: MAX_CASE_DETAIL_CHARS,
            description:
              'For ethics_case ONLY: the situation, in second person, naming her post and the concrete facts she must decide on. Null for essay_outline.',
          },
          syllabusSlug: {
            type: ['string', 'null'],
            description:
              'A slug taken VERBATIM from the list supplied in the request, or null if none fits. Never invent one.',
          },
          why: {
            type: 'string',
            description:
              'One clause on what makes this worth twenty minutes. Read by a human in a log, never shown to the aspirant.',
          },
        },
      },
    },
  },
};

/**
 * Call 2. Per-part scores for one attempt.
 *
 * `part` is an enum over EVERY part of both kinds rather than only the kind
 * being scored, because one schema is hashed into one `promptVersion`. A
 * per-kind schema would produce two versions for one prompt corpus and make the
 * retroactive purge that version exists for select the wrong half.
 *
 * The model returns no total. `pipeline.ts` sums the verdicts, because a total
 * that disagrees with its own parts is the one error a reader cannot detect and
 * arithmetic is free.
 */
export const EVALUATION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts', 'highestLeverageFix', 'feedbackMarkdown'],
  properties: {
    verdicts: {
      type: 'array',
      description: 'One entry per part you were given. Never more, never fewer.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['part', 'score', 'comment'],
        properties: {
          part: { type: 'string', enum: [...ALL_PARTS] },
          score: {
            type: 'number',
            description:
              'Marks for this part, between zero and the maximum stated in the request. Never above it.',
          },
          comment: {
            type: 'string',
            description:
              'What to fix, addressed to her, in one or two sentences. Required even at full marks: a bare score teaches nothing, and knowing WHY something worked is the part that compounds.',
          },
        },
      },
    },
    highestLeverageFix: {
      type: 'string',
      description:
        'The single change worth making next time. One thing, not a list — a list is a way of declining to prioritise.',
    },
    feedbackMarkdown: {
      type: 'string',
      description:
        'The prose feedback, in markdown. Addressed to her, specific to what she wrote, and never restating the scores.',
    },
  },
};

export type ParseOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

export interface RawPromptsOutput {
  prompts?: unknown;
}

export interface RawEvaluationOutput {
  verdicts?: unknown;
  highestLeverageFix?: unknown;
  feedbackMarkdown?: unknown;
}

/**
 * `parse` is what makes `parsed_output` typed and populated; with a bare schema
 * the SDK returns null. It NEVER THROWS, returning a discriminated result
 * instead, because the SDK turns a thrown parser error into a rejected request
 * — which would lose the usage numbers for a call Anthropic has already billed.
 * A truncated response still costs money and still has to be recorded.
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

export const promptsFormat = safeFormat<RawPromptsOutput>(PROMPTS_SCHEMA);
export const evaluationFormat = safeFormat<RawEvaluationOutput>(EVALUATION_SCHEMA);

/**
 * A stable hash of a schema, for folding into `promptVersion`.
 *
 * Keys are sorted before hashing so a cosmetic reordering of the literal above
 * does not re-version a month of drills, while any change to a name, an enum
 * or a bound does.
 */
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
