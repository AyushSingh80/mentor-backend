/**
 * JSON Schemas for the two structured-output calls.
 *
 * Hand-written, for the same reason `mcq/schema.ts` is: a schema here is a wire
 * contract hashed into `promptVersion`, so it must be a value that is read and
 * diffed directly rather than the output of a library whose emitted shape can
 * change under a patch release and silently re-version a month of digests.
 *
 * WHY STRUCTURED OUTPUTS AND NOT A FENCED BLOCK: both calls return a LIST.
 * `extractTrailingJson` takes the LAST fence — correct for one trailing score
 * block, catastrophic here. Ask for ten shortlist picks, get ten fences, and it
 * returns pick ten while reporting success; the other nine vanish with nothing
 * to notice. Its own comment now says so. `output_config.format` returns one
 * document conforming to this schema or it fails loudly.
 */

import type { JSONOutputFormat } from '@anthropic-ai/sdk/resources/messages/messages';
import { MAX_EVIDENCE_PER_ITEM, MAX_NOTE_WORDS } from './types.js';
import { ITEM_KINDS } from './select.js';

/** Tags and sections per item. Small on purpose — see the prompt calibration. */
export const MAX_SYLLABUS_SLUGS_PER_ITEM = 4;
export const MAX_SECTION_KEYS_PER_ITEM = 3;

/**
 * Call 1. Headline plus lede for ~40 candidates in, ~10 indices out.
 *
 * The model returns an INDEX into the candidate list, never a URL. A URL is a
 * string the model can rewrite, mistype or hallucinate outright; an index that
 * falls outside the list is a bounds check the server performs for free. The
 * URL it names is then the one the server already fetched, not the one the
 * model believed it saw.
 */
export const SHORTLIST_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['picks'],
  properties: {
    picks: {
      type: 'array',
      description:
        'The candidates worth the full read, best first. Returning fewer than asked is the expected outcome on a quiet day; padding the list is not.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['candidateIndex', 'kind', 'syllabusSlugs', 'sectionKeys', 'why'],
        properties: {
          candidateIndex: {
            type: 'integer',
            minimum: 0,
            description: 'Position of the candidate in the numbered list you were given.',
          },
          kind: {
            type: 'string',
            enum: [...ITEM_KINDS],
            description:
              'What changed. A rule changing is structural|report|judgment|scheme|data; a happening is an event. A cabinet decision is structural; a bilateral visit is an event.',
          },
          syllabusSlugs: {
            type: 'array',
            maxItems: MAX_SYLLABUS_SLUGS_PER_ITEM,
            items: { type: 'string' },
            description:
              'Slugs taken VERBATIM from the syllabus list supplied in the request. An item with no slug from that list earns no slot, so returning an empty array is how you decline a candidate you already picked.',
          },
          sectionKeys: {
            type: 'array',
            maxItems: MAX_SECTION_KEYS_PER_ITEM,
            items: { type: 'string' },
            description: 'Section keys taken verbatim from the sections supplied in the request.',
          },
          why: {
            type: 'string',
            description:
              'One clause naming what changed. Read by a human in a log, never shown to the aspirant.',
          },
        },
      },
    },
  },
};

/**
 * Call 2. The full extracted text of the shortlist in, notes out.
 *
 * `evidence` carries the quote only. The offset in `EvidenceSpan.at` is
 * resolved by `ground.ts` against the text the server fetched, because an
 * offset the model supplies is an offset the model can be wrong about — and a
 * wrong offset that still parses is worse than no offset at all.
 */
export const NOTES_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      description:
        'One entry per source you can write from with certainty. Omit any source whose text does not support a note. Fewer is correct.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'url',
          'headline',
          'kind',
          'noteMd',
          'sentenceEvidence',
          'evidence',
          'sectionKeys',
          'syllabusSlugs',
          'anthro',
        ],
        properties: {
          url: {
            type: 'string',
            description:
              'Copied character-for-character from the SOURCE URL line of the document you are writing about. A url that is not one of the supplied documents is discarded.',
          },
          headline: {
            type: 'string',
            description: 'Your own one-line headline for the item. Not the outlet’s.',
          },
          kind: { type: 'string', enum: [...ITEM_KINDS] },
          noteMd: {
            type: 'string',
            description: `The note, at most ${MAX_NOTE_WORDS} words of markdown. Every sentence must be supported by one of your evidence quotes. Write nothing that is not in the supplied text — not a date, not a number, not a background fact you happen to know.`,
          },
          sentenceEvidence: {
            type: 'array',
            items: { type: 'integer', minimum: 0 },
            description:
              'One entry per sentence of noteMd, in order: the index into your evidence array that supports that sentence. A sentence with no supporting quote means the note is wrong, not that this array is shorter.',
          },
          evidence: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_EVIDENCE_PER_ITEM,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['quote'],
              properties: {
                quote: {
                  type: 'string',
                  description:
                    'VERBATIM from the supplied text — copied, not remembered, not tidied. The server checks it is a literal substring and discards the whole item if it is not.',
                },
              },
            },
          },
          sectionKeys: {
            type: 'array',
            maxItems: MAX_SECTION_KEYS_PER_ITEM,
            items: { type: 'string' },
          },
          syllabusSlugs: {
            type: 'array',
            maxItems: MAX_SYLLABUS_SLUGS_PER_ITEM,
            items: { type: 'string' },
            description: 'Verbatim slugs from the supplied syllabus list. No slug, no slot.',
          },
          /**
           * Required rather than nullable, with the empty string meaning "no
           * claim".
           *
           * A nullable object would need a union type, and this file stays
           * inside the exact JSON Schema vocabulary `mcq/schema.ts` already
           * proves against this SDK. The server converts all-empty to null and
           * enforces the pairing rule itself, which is where it belongs: a
           * prompt instruction is not an enforcement mechanism.
           */
          anthro: {
            type: 'object',
            additionalProperties: false,
            required: ['p1Slug', 'p2Slug', 'usageLine'],
            description:
              'The Paper 1 concept and its Indian instance. Leave all three fields as empty strings unless BOTH halves are real. Claiming a link on everything is worse than claiming none.',
            properties: {
              p1Slug: {
                type: 'string',
                description: 'The Paper 1 theory slug, or "" if you are not claiming a link.',
              },
              p2Slug: {
                type: 'string',
                description:
                  'The Paper 2 slug for the Indian instance the SOURCE actually names — a community, a Schedule, an Act, a district. "" if the source names none.',
              },
              usageLine: {
                type: 'string',
                description:
                  'One sentence she could write verbatim into a Mains answer, naming both the concept and the instance. "" if you are not claiming a link.',
              },
            },
          },
        },
      },
    },
  },
};

/**
 * Format objects for `messages.parse()`.
 *
 * `parse` is what makes `parsed_output` typed and populated; with a bare schema
 * the SDK returns null. It NEVER THROWS, returning a discriminated result
 * instead, because the SDK turns a thrown parser error into a rejected request
 * — which would lose the usage numbers for a call Anthropic has already billed.
 * A truncated response still costs money and still has to be recorded.
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

export interface RawShortlistOutput {
  picks?: unknown;
}

export interface RawNotesOutput {
  items?: unknown;
}

export const shortlistFormat = safeFormat<RawShortlistOutput>(SHORTLIST_SCHEMA);
export const notesFormat = safeFormat<RawNotesOutput>(NOTES_SCHEMA);

/** Canonical bytes of a schema, for hashing it into the prompt version. */
export function schemaFingerprint(schema: Record<string, unknown>): string {
  return JSON.stringify(schema);
}
