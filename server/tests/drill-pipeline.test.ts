/**
 * The generation and marking pipelines.
 *
 * Everything here is the server deciding which parts of the model's proposal
 * earn a slot. The bar is deliberately high for prompts: a bad essay topic
 * costs her twenty minutes of a morning she does not have again, and a case
 * with no real dilemma teaches the comprehension exercise rather than the
 * paper.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.ANTHROPIC_API_KEY ??= 'test-key';
process.env.MODEL_EVALUATION ??= 'eval-model-1';
process.env.MODEL_BULK ??= 'bulk-model-1';
process.env.APP_BEARER_TOKEN ??= 'test-token';

const { promptFingerprint, runEvaluation, runGeneration } = await import(
  '../src/drills/pipeline.js'
);
const { buildEvaluatePayload, buildGeneratePayload } = await import('../src/drills/runner.js');
const { ESSAY_OUTLINE_PARTS, PART_MAX, maxForKind } = await import('../src/drills/types.js');

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

const VOCAB = [
  { slug: 'essay-gov-democracy-and-dissent', label: 'Democracy, dissent and the citizen' },
  { slug: 'gs4-values-integrity', label: 'Integrity' },
];

function essay(promptText: string, overrides: Record<string, unknown> = {}) {
  return {
    kind: 'essay_outline' as const,
    promptText,
    caseDetail: null,
    syllabusSlug: 'essay-gov-democracy-and-dissent',
    why: 'admits several lenses',
    ...overrides,
  };
}

function ethics(promptText: string, overrides: Record<string, unknown> = {}) {
  return {
    kind: 'ethics_case' as const,
    promptText,
    caseDetail: 'You are the Sub-Divisional Magistrate and the file is incomplete.',
    syllabusSlug: 'gs4-values-integrity',
    why: 'a rule against an outcome',
    ...overrides,
  };
}

async function generate(
  drafts: unknown[],
  want: { kind: 'essay_outline' | 'ethics_case'; count: number }[] = [
    { kind: 'essay_outline', count: 3 },
  ],
  excludePrompts: string[] = [],
) {
  return runGeneration(
    {
      requestId: 'r',
      want,
      vocabulary: VOCAB,
      excludePrompts,
      model: 'm',
      system: 's',
    },
    {
      generate: async () => ({
        drafts: drafts as never,
        stopReason: 'end_turn',
        usage: ZERO_USAGE,
        provenance: 'model',
      }),
      signal: new AbortController().signal,
    },
  );
}

/* ------------------------------------------------------------ fingerprints */

describe('promptFingerprint', () => {
  it('collapses a REORDERING of the same topic', () => {
    // The failure it prevents: she opens a topic, writes for twenty minutes,
    // and recognises it halfway through.
    assert.equal(
      promptFingerprint('Order, disorder and the modern state'),
      promptFingerprint('The modern state, disorder and order'),
    );
  });

  it('does NOT collapse a synonym rewrite, and the comment says so', () => {
    // Pinned so nobody reads the module as promising more than it does.
    // Catching this needs an embedding — a paid call to save a two-cent prompt.
    assert.notEqual(
      promptFingerprint('Is development compatible with ecology'),
      promptFingerprint('Can ecology and development coexist'),
    );
  });

  it('ignores stopwords, so filler cannot make two topics look distinct', () => {
    assert.equal(
      promptFingerprint('Order and disorder over the state'),
      promptFingerprint('Order, disorder: the state'),
    );
  });

  it('does not collapse two genuinely different topics', () => {
    assert.notEqual(
      promptFingerprint('Democracy requires dissent'),
      promptFingerprint('Development requires displacement'),
    );
  });

  it('ignores case and punctuation', () => {
    assert.equal(
      promptFingerprint('Order, disorder and the state.'),
      promptFingerprint('ORDER DISORDER AND THE STATE'),
    );
  });

  it('falls back for a script the stripper does not cover', () => {
    // Without the fallback every such prompt fingerprints to '' and is "a
    // duplicate" of every other, which would silently empty a batch.
    const a = promptFingerprint('न्याय और समानता');
    const b = promptFingerprint('स्वतंत्रता और उत्तरदायित्व');
    assert.notEqual(a, '');
    assert.notEqual(a, b);
  });
});

/* -------------------------------------------------------------- generation */

describe('runGeneration', () => {
  it('keeps clean prompts and resolves their slugs', async () => {
    const outcome = await generate([essay('Order is not the absence of disorder')]);
    assert.equal(outcome.summary.kept, 1);
    assert.equal(outcome.prompts[0]?.syllabusSlug, 'essay-gov-democracy-and-dissent');
  });

  it('drops an essay topic phrased as a GS directive', async () => {
    // Setting one teaches her to write GS answers in the essay paper, which is
    // the diagnosis the essay rubric asks for most often.
    const outcome = await generate([essay('Discuss the impact of urbanisation on families')]);
    assert.equal(outcome.summary.kept, 0);
    assert.equal(outcome.drops[0]?.reason, 'not_a_question');
  });

  it('keeps a topic that merely contains a directive word', async () => {
    // The rule is about how the topic OPENS, not about a banned vocabulary. A
    // filter on the word anywhere would drop good topics.
    const outcome = await generate([essay('To examine a life is to change it')]);
    assert.equal(outcome.summary.kept, 1);
  });

  it('drops a case with no situation to decide on', async () => {
    // Enforced here rather than left to the device's CHECK constraint, which
    // would reject the row after the batch was billed for.
    const outcome = await generate(
      [ethics('A contractor offers a favour', { caseDetail: '   ' })],
      [{ kind: 'ethics_case', count: 2 }],
    );
    assert.equal(outcome.summary.kept, 0);
    assert.equal(outcome.drops[0]?.reason, 'case_missing_detail');
  });

  it('drops an essay topic carrying case detail', async () => {
    const outcome = await generate([essay('Order and disorder', { caseDetail: 'You are the SDM.' })]);
    assert.equal(outcome.drops[0]?.reason, 'outline_has_detail');
  });

  it('drops a restatement of a prompt already banked', async () => {
    const outcome = await generate(
      [essay('Order, disorder and the modern state')],
      [{ kind: 'essay_outline', count: 2 }],
      ['The modern state, disorder and order'],
    );
    assert.equal(outcome.summary.kept, 0);
    assert.equal(outcome.drops[0]?.reason, 'duplicate');
  });

  it('drops a restatement WITHIN one batch', async () => {
    const outcome = await generate([
      essay('Order, disorder and the modern state'),
      essay('The modern state, disorder and order'),
    ]);
    assert.equal(outcome.summary.kept, 1);
    assert.equal(outcome.summary.dropReasons.duplicate, 1);
  });

  it('drops a slug outside the request rather than carrying it', async () => {
    // The app resolves these against its own syllabus; a slug from nowhere is
    // noise there. The PROMPT is kept — an untagged prompt is still drillable.
    const outcome = await generate([essay('Order and disorder', { syllabusSlug: 'invented-slug' })]);
    assert.equal(outcome.summary.kept, 1);
    assert.equal(outcome.prompts[0]?.syllabusSlug, null);
  });

  it('never returns more of a kind than was asked for', async () => {
    const outcome = await generate(
      [essay('One'), essay('Two topics here'), essay('Three topics there')],
      [{ kind: 'essay_outline', count: 2 }],
    );
    assert.equal(outcome.summary.kept, 2);
  });

  it('reports under-delivery as a fact rather than an error', async () => {
    const outcome = await generate([essay('Only one')], [{ kind: 'essay_outline', count: 3 }]);
    assert.equal(outcome.summary.underDelivered, true);
    assert.equal(outcome.summary.kept, 1);
  });

  it('counts every drop by reason, so a filter she cannot see still teaches', async () => {
    const outcome = await generate(
      [
        essay('Discuss the role of the state'),
        essay('Order and disorder', { caseDetail: 'x' }),
        essay('A perfectly good topic about time'),
      ],
      [{ kind: 'essay_outline', count: 3 }],
    );
    assert.deepEqual(outcome.summary.dropReasons, { not_a_question: 1, outline_has_detail: 1 });
    assert.equal(outcome.summary.kept, 1);
  });

  it('survives a null reply without throwing', async () => {
    const outcome = await runGeneration(
      { requestId: 'r', want: [{ kind: 'essay_outline', count: 3 }], vocabulary: [], excludePrompts: [], model: 'm', system: 's' },
      {
        generate: async () => ({ drafts: null, stopReason: 'max_tokens', usage: ZERO_USAGE, provenance: 'model' }),
        signal: new AbortController().signal,
      },
    );
    assert.equal(outcome.summary.kept, 0);
    assert.equal(outcome.summary.returned, 0);
  });
});

/* -------------------------------------------------------------- evaluation */

const OUTLINE_PARTS = ESSAY_OUTLINE_PARTS.map((part) => ({ part, content: `written ${part}` }));

async function evaluate(evaluation: unknown) {
  return runEvaluation(
    {
      requestId: 'r',
      kind: 'essay_outline',
      promptText: 'Order is not the absence of disorder',
      caseDetail: null,
      parts: OUTLINE_PARTS,
      model: 'm',
      system: 's',
    },
    {
      evaluate: async () => ({
        evaluation: evaluation as never,
        stopReason: 'end_turn',
        usage: ZERO_USAGE,
        provenance: 'model',
      }),
      signal: new AbortController().signal,
    },
  );
}

function fullSheet() {
  const verdicts = ESSAY_OUTLINE_PARTS.map((part) => ({
    part,
    score: PART_MAX[part],
    max: PART_MAX[part],
    comment: `on ${part}`,
  }));
  return {
    verdicts,
    total: verdicts.reduce((sum, v) => sum + v.score, 0),
    max: maxForKind('essay_outline'),
    highestLeverageFix: 'one thing',
    feedbackMd: 'prose',
  };
}

describe('runEvaluation', () => {
  it('accepts a complete mark sheet', async () => {
    const outcome = await evaluate(fullSheet());
    assert.equal(outcome.error, null);
    assert.equal(outcome.evaluation?.total, maxForKind('essay_outline'));
  });

  it('rejects a sheet missing a part rather than showing a partial one', async () => {
    // She reads three scores, sees no fourth, and cannot tell whether the
    // closing scored zero or was skipped. A retry is the honest outcome.
    const sheet = fullSheet();
    const outcome = await evaluate({ ...sheet, verdicts: sheet.verdicts.slice(0, 3) });
    assert.equal(outcome.evaluation, null);
    assert.match(outcome.error ?? '', /skipped 1 of 4/);
  });

  it('reports the KIND`s maximum, not the sum of what came back', async () => {
    const sheet = fullSheet();
    const outcome = await evaluate({ ...sheet, max: 999 });
    assert.equal(outcome.evaluation?.max, maxForKind('essay_outline'));
  });

  it('surfaces a truncated reply as its own error', async () => {
    const outcome = await runEvaluation(
      {
        requestId: 'r',
        kind: 'essay_outline',
        promptText: 'p',
        caseDetail: null,
        parts: OUTLINE_PARTS,
        model: 'm',
        system: 's',
      },
      {
        evaluate: async () => ({
          evaluation: null,
          stopReason: 'max_tokens',
          usage: ZERO_USAGE,
          provenance: 'model',
        }),
        signal: new AbortController().signal,
      },
    );
    assert.match(outcome.error ?? '', /truncated/);
  });

  it('returns the usage even when the reply was unusable', async () => {
    // A truncated reply still costs money. A ledger that only records successes
    // under-counts the month and the cap stops binding.
    const outcome = await runEvaluation(
      { requestId: 'r', kind: 'essay_outline', promptText: 'p', caseDetail: null, parts: OUTLINE_PARTS, model: 'm', system: 's' },
      {
        evaluate: async () => ({
          evaluation: null,
          stopReason: 'max_tokens',
          usage: { ...ZERO_USAGE, inputTokens: 4200, outputTokens: 900 },
          provenance: 'model',
        }),
        signal: new AbortController().signal,
      },
    );
    assert.equal(outcome.usage.inputTokens, 4200);
  });
});

/* ----------------------------------------------------------------- payloads */

describe('the payloads', () => {
  it('includes the exclusion list, or a batch of duplicates looks healthy', () => {
    const payload = buildGeneratePayload({
      want: [{ kind: 'essay_outline', count: 2 }],
      vocabulary: VOCAB,
      excludePrompts: ['Order is not the absence of disorder'],
    });
    assert.match(payload, /Already banked/);
    assert.match(payload, /Order is not the absence of disorder/);
  });

  it('renders each slug with its label', () => {
    const payload = buildGeneratePayload({
      want: [{ kind: 'essay_outline', count: 1 }],
      vocabulary: VOCAB,
      excludePrompts: [],
    });
    assert.match(payload, /gs4-values-integrity {2}\(Integrity\)/);
  });

  it('states the per-part maximum, which the schema cannot', () => {
    const payload = buildEvaluatePayload({
      kind: 'essay_outline',
      promptText: 'p',
      caseDetail: null,
      parts: OUTLINE_PARTS,
    });
    assert.match(payload, new RegExp(`## thesis {2}\\(out of ${PART_MAX.thesis}\\)`));
  });

  it('includes the case detail, without which a case is a different question', () => {
    const payload = buildEvaluatePayload({
      kind: 'ethics_case',
      promptText: 'A contractor offers a favour',
      caseDetail: 'You are the Sub-Divisional Magistrate.',
      parts: [{ part: 'keywords', content: 'probity' }],
    });
    assert.match(payload, /Sub-Divisional Magistrate/);
  });

  it('names the exact keys the verdicts must use', () => {
    const payload = buildEvaluatePayload({
      kind: 'essay_outline',
      promptText: 'p',
      caseDetail: null,
      parts: OUTLINE_PARTS,
    });
    assert.match(payload, /thesis, dimensions, opening, closing/);
  });
});
