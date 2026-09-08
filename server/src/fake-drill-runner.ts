/**
 * Scripted drill runners for `EVAL_RUNNER=fake`.
 *
 * Exists so the phone app can be walked end to end on a real device without
 * spending anything. The questions worth answering there — does the outline
 * editor keep her text across a rotation, does the mark sheet render, does a
 * submit survive airplane mode — have nothing to do with the quality of the
 * marking.
 *
 * ## Everything is prefixed [SAMPLE], and that is a safety property
 *
 * A fake MARK is the dangerous half here, exactly as a fake score is on
 * `/evaluate`. A topic she is set is a prompt and nothing turns on it, but
 * "31/40, your thesis carries the essay" is a sentence she can believe. If it
 * arrived unlabelled she would calibrate against a number no model produced.
 *
 * The scores are also deliberately MEDIOCRE and identical every time. A fake
 * that returned full marks would be pleasant and useless; one that returned a
 * plausible spread would be indistinguishable from a real mark sheet at a
 * glance, which is the thing to avoid.
 */

import { PART_MAX, PARTS_OF_KIND } from './drills/types.js';
import type { EvaluateRunner, GenerateRunner } from './drills/runner.js';

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

const ESSAY_TOPICS = [
  'Order is not the absence of disorder, but its management',
  'The measure of a society is what it does with what it cannot use',
  'A nation writes its future in the way it treats its past',
  'Technology answers questions we have stopped asking',
  'Justice delayed is justice restructured',
  'The commons survives only where someone is accountable for it',
];

const ETHICS_CASES = [
  'A contractor offers to fund a school your department cannot afford',
  'A subordinate falsified a survey to meet a target you set',
  'A relief list omits a settlement that is not on any revenue map',
  'Your predecessor signed an order you believe to be unlawful',
  'A journalist asks you to confirm a file you have not been shown',
  'A transfer would remove you from an inquiry you are conducting',
];

export const fakeGenerateRunner: GenerateRunner = async (request) => {
  const drafts = request.want.flatMap((entry) =>
    Array.from({ length: entry.count }, (_unused, index) => {
      const isEssay = entry.kind === 'essay_outline';
      const pool = isEssay ? ESSAY_TOPICS : ETHICS_CASES;
      const text = pool[index % pool.length]!;
      return {
        kind: entry.kind,
        // The index keeps the prompts distinct, so the duplicate filter is
        // exercised rather than accidentally rejecting the whole batch.
        promptText: `[SAMPLE] ${text} (${index + 1})`,
        caseDetail: isEssay
          ? null
          : `[SAMPLE] You are the Sub-Divisional Magistrate. This situation is scripted and no part of it is real. Decide as though it were.`,
        // Only ever a slug the request actually offered, so the pipeline's
        // allowlist check is exercised honestly rather than always dropping.
        syllabusSlug: request.vocabulary[index % Math.max(1, request.vocabulary.length)]?.slug ?? null,
        why: 'scripted sample prompt',
      };
    }),
  );

  return { drafts, stopReason: 'end_turn', usage: ZERO_USAGE, provenance: 'fake' };
};

export const fakeEvaluateRunner: EvaluateRunner = async (request) => {
  const parts = PARTS_OF_KIND[request.kind];

  const verdicts = request.parts
    .filter((submitted) => (parts as readonly string[]).includes(submitted.part))
    .map((submitted) => {
      const max = PART_MAX[submitted.part];
      return {
        part: submitted.part,
        // Roughly 60%, floored so a one-mark part is never zero. Mediocre and
        // constant: a fake that flattered would be useless, and one that looked
        // plausible would be mistaken for a real mark sheet.
        score: Math.max(1, Math.floor(max * 0.6)),
        max,
        comment: `[SAMPLE] Scripted comment for "${submitted.part}". No model read this.`,
      };
    });

  return {
    evaluation: {
      verdicts,
      total: verdicts.reduce((sum, verdict) => sum + verdict.score, 0),
      max: verdicts.reduce((sum, verdict) => sum + verdict.max, 0),
      highestLeverageFix: '[SAMPLE] Scripted fix. Turn off EVAL_RUNNER=fake for real marking.',
      feedbackMd:
        '## [SAMPLE] Scripted feedback\n\nNo model was called and nothing was billed. ' +
        'Every score on this sheet is a fixed fraction of the maximum.',
    },
    stopReason: 'end_turn',
    usage: ZERO_USAGE,
    provenance: 'fake',
  };
};
