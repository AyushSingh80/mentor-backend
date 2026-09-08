/**
 * Scripted interview questions for `EVAL_RUNNER=fake`.
 *
 * ## Why this fake states nothing
 *
 * The other fakes are prefixed `[SAMPLE]` because a fake SCORE is dangerous —
 * "31/40" is a sentence she can believe and calibrate against. A fake QUESTION
 * is close to harmless: at worst she prepares something a board will not ask.
 *
 * What would NOT be harmless is a fake that slipped a fact into a question —
 * "your district, known for its silk weaving" — because that is precisely the
 * failure `pipeline.ts#looksLikeAnAnswer` exists to catch, and a fixture that
 * produced it would be indistinguishable from the real bug in a manual test.
 *
 * So every question below asks and states nothing, and one is deliberately
 * MALFORMED — it supplies a fact — so the drop path is exercised on every fake
 * run rather than only in a unit test.
 */

import type { GenerateRunner } from './interview/runner.js';

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

export const fakeInterviewRunner: GenerateRunner = async (request) => {
  const fields = request.entries.map((entry) => entry.field);

  const templates: { field: (typeof fields)[number] | null; area: string; question: string; likelihood: 'certain' | 'likely' | 'possible' }[] =
    [];

  for (const field of fields) {
    templates.push({
      field,
      area: `[SAMPLE] ${field}`,
      question: `[SAMPLE] What would you want a board to understand about your ${field.replace(/_/g, ' ')}?`,
      likelihood: 'likely',
    });
  }

  templates.push({
    field: null,
    area: '[SAMPLE] Why this service',
    question: '[SAMPLE] Why are you leaving a job you are doing well to join the service?',
    likelihood: 'certain',
  });

  // Deliberately malformed: an appositive supplying a fact. Exercises
  // `looksLikeAnAnswer` on every fake run, so the guard cannot rot unnoticed.
  templates.push({
    field: fields[0] ?? null,
    area: '[SAMPLE] Guard check',
    question:
      '[SAMPLE] Your home district, known for its handloom weaving, faces which administrative challenge?',
    likelihood: 'possible',
  });

  return {
    drafts: templates.slice(0, request.take + 2),
    stopReason: 'end_turn',
    usage: ZERO_USAGE,
    provenance: 'fake',
  };
};
