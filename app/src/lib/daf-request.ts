/**
 * The interview question request body, assembled.
 *
 * Its own pure module for the reason `ca-request.ts`, `mcq-request.ts` and
 * `drill-request.ts` all give: the assembly's natural home imports `@/db/*` and
 * `expo/fetch`, which cannot load under Node, and a wire body no test can reach
 * is a wire body that ships wrong. Twice now, in this repo.
 */

import type { DafEntryPayload, QuestionsRequest } from '@/lib/daf-api';
import { DAF_FIELDS, DAF_RULES, type DafEntry } from '@/lib/daf-types';

/**
 * The prompt cohort this build asks for.
 *
 * Echoed onto `interview_questions.prompt_version` so a bad cohort can be
 * discarded. Here rather than in `daf-api.ts` because that module imports
 * `expo/fetch`, so a VALUE imported from it drags React Native into anything
 * that touches it.
 */
export const INTERVIEW_PROMPT_VERSION = 'interview-v1';

export interface QuestionsRequestInput {
  requestId: string;
  /** Every DAF entry held on the device, filled or not. */
  entries: readonly DafEntry[];
  /** Question texts already banked, so a batch does not restate one. */
  bankedQuestions: readonly string[];
  take?: number;
}

/**
 * Assemble the body. Pure: same input, same bytes.
 *
 * ## Empty entries are DROPPED, not sent blank
 *
 * The server refuses an entry with a blank value, and rightly — but the deeper
 * reason is upstream of validation. A field transmitted as `""` invites the
 * model to write a question about a university she never named, which is how a
 * generated biography starts. Sending only what she has actually written means
 * an invented field has nowhere to come from.
 *
 * Declared order, so two runs over the same form produce byte-identical bodies.
 */
export function buildQuestionsRequest(input: QuestionsRequestInput): QuestionsRequest {
  const byField = new Map(input.entries.map((entry) => [entry.field, entry] as const));

  const entries: DafEntryPayload[] = [];
  for (const field of DAF_FIELDS) {
    const value = byField.get(field)?.value.trim() ?? '';
    if (value === '') continue;
    entries.push({ field, value });
  }

  return {
    requestId: input.requestId,
    entries,
    excludeQuestions: [...input.bankedQuestions],
    take: Math.max(1, Math.floor(input.take ?? DAF_RULES.batchSize)),
    promptVersion: INTERVIEW_PROMPT_VERSION,
  };
}
