/**
 * POST /interview/questions — the server half of the contract, and the fact check.
 *
 * Counterpart: `app/tests/daf-contract.test.ts`. The object below is COPIED
 * FROM THE APP; if it stops matching what `buildQuestionsRequest` produces,
 * this file is wrong, and updating it to agree with the parser is the mistake
 * the pair exists to prevent.
 *
 * The second half of this file is the more important one. `looksLikeAnAnswer`
 * is the mechanical enforcement of the rule the whole phase rests on: the
 * server produces questions and never facts. The prompt asks for that; this is
 * what makes it true.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.ANTHROPIC_API_KEY ??= 'test-key';
process.env.MODEL_EVALUATION ??= 'eval-model-1';
process.env.MODEL_BULK ??= 'bulk-model-1';
process.env.APP_BEARER_TOKEN ??= 'test-token';

const { parseInterviewBody } = await import('../src/routes/interview.js');
const { isAskable, looksLikeAnAnswer, questionFingerprint, runGeneration } = await import(
  '../src/interview/pipeline.js'
);
const { buildGeneratePayload } = await import('../src/interview/runner.js');

/** Verbatim `buildQuestionsRequest` output. */
function appRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 'iv_2026-09-08_5f2a',
    entries: [
      { field: 'home_district', value: 'Barpeta, Assam' },
      { field: 'hobbies', value: 'Reading — mainly Indian political history, currently Guha' },
      { field: 'employment', value: 'Operations analyst on an evening shift' },
    ],
    excludeQuestions: ['What is your district known for?'],
    take: 8,
    promptVersion: 'interview-v1',
    ...overrides,
  };
}

function accept(body: Record<string, unknown>) {
  const parsed = parseInterviewBody(body);
  assert.notEqual(typeof parsed, 'string', `body was rejected: ${String(parsed)}`);
  return parsed as Exclude<ReturnType<typeof parseInterviewBody>, string>;
}

/* --------------------------------------------------------------- the body */

describe('the body the app actually sends', () => {
  it('is accepted', () => {
    const parsed = accept(appRequest());
    assert.equal(parsed.entries.length, 3);
    assert.equal(parsed.take, 8);
  });

  it('keeps the exclusion list under the name the app uses', () => {
    assert.deepEqual(accept(appRequest()).excludeQuestions, ['What is your district known for?']);
  });

  it('refuses an empty entry list rather than inventing a biography', () => {
    // With no entries there is nothing to generate from except invention, and
    // admitting it would reserve budget to produce exactly that.
    const parsed = parseInterviewBody(appRequest({ entries: [] }));
    assert.equal(typeof parsed, 'string');
    assert.match(String(parsed), /at least one filled DAF field/);
  });

  it('refuses a blank value', () => {
    const parsed = parseInterviewBody(
      appRequest({ entries: [{ field: 'home_district', value: '   ' }] }),
    );
    assert.equal(typeof parsed, 'string');
  });

  it('refuses a field this server does not know', () => {
    const parsed = parseInterviewBody(
      appRequest({ entries: [{ field: 'astrological_sign', value: 'Libra' }] }),
    );
    assert.equal(typeof parsed, 'string');
    assert.match(String(parsed), /must be one of/);
  });

  it('refuses a repeated field', () => {
    const parsed = parseInterviewBody(
      appRequest({
        entries: [
          { field: 'hobbies', value: 'Reading' },
          { field: 'hobbies', value: 'Chess' },
        ],
      }),
    );
    assert.equal(typeof parsed, 'string');
    assert.match(String(parsed), /repeats hobbies/);
  });

  it('echoes the client`s prompt cohort without comparing it', () => {
    assert.equal(accept(appRequest()).promptVersion, 'interview-v1');
  });
});

/* --------------------------------------------------- the rule of this phase */

describe('looksLikeAnAnswer — the rule the whole phase rests on', () => {
  it('catches an appositive supplying a fact', () => {
    assert.equal(
      looksLikeAnAnswer('Your district, known for its silk weaving, faces what challenge?'),
      true,
    );
  });

  it('catches a superlative claim', () => {
    assert.equal(
      looksLikeAnAnswer('Assam, the largest producer of tea in India, has what problem?'),
      true,
    );
  });

  it('catches a parenthetical figure', () => {
    assert.equal(
      looksLikeAnAnswer('How would you raise literacy in your district (literacy 74%)?'),
      true,
    );
  });

  it('catches a relative clause handing her a number', () => {
    assert.equal(
      looksLikeAnAnswer('In your district, where the sex ratio is 958, what would you do?'),
      true,
    );
  });

  it('catches a premise handed to her', () => {
    assert.equal(
      looksLikeAnAnswer('Given that your district is a flood-prone area, what is your plan?'),
      true,
    );
  });

  it('does NOT catch a question that ASKS for the same fact', () => {
    // The distinction the whole check turns on. "What is it known for?" is the
    // question; ", known for its silk weaving," is the answer.
    for (const good of [
      'What is your home district known for?',
      'What is the literacy rate of your district, and how does it compare with the state?',
      'What is the main crop grown in Barpeta?',
      'Your district faces which single administrative challenge you would prioritise?',
      'Take me through the 2011 census picture of your district.',
    ]) {
      assert.equal(looksLikeAnAnswer(good), false, `false positive on: ${good}`);
    }
  });

  it('does not reject a question merely for containing a number', () => {
    // A numeric filter would reject half the good questions. Naming a census
    // year is legitimate; supplying its figures is not.
    assert.equal(looksLikeAnAnswer('What changed in your district between 2001 and 2011?'), false);
  });
});

describe('isAskable', () => {
  it('accepts a question mark', () => {
    assert.equal(isAskable('Why this service?'), true);
  });

  it('accepts the imperatives a board actually uses', () => {
    // A bare `?` test would drop real questions: boards say "take me through
    // your decision to leave engineering" far more often than they ask it.
    for (const each of [
      'Tell me about your home district.',
      'Take me through your decision to leave engineering.',
      'Convince me you would not resign in two years.',
    ]) {
      assert.equal(isAskable(each), true, `rejected: ${each}`);
    }
  });

  it('rejects a statement', () => {
    assert.equal(isAskable('Your district is known for weaving.'), false);
  });
});

/* -------------------------------------------------------------- generation */

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

async function generate(drafts: unknown[], supplied = ['home_district', 'hobbies'] as const) {
  return runGeneration(
    {
      requestId: 'r',
      entries: supplied.map((field) => ({ field, value: 'a filled value' })),
      excludeQuestions: [],
      take: 8,
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

function draft(question: string, overrides: Record<string, unknown> = {}) {
  return {
    field: 'home_district' as const,
    area: 'District profile',
    question,
    likelihood: 'certain' as const,
    ...overrides,
  };
}

describe('runGeneration', () => {
  it('drops a question that supplies a fact, before any other rule', () => {
    // Ordered first on purpose: a question supplying a fact is worse than no
    // question, where the other rules are about usefulness.
    return generate([draft('Your district, known for weaving, faces what?')]).then((outcome) => {
      assert.equal(outcome.summary.kept, 0);
      assert.equal(outcome.drops[0]?.reason, 'contains_answer');
    });
  });

  it('drops a question about a field she left blank', async () => {
    // Also the shape a hallucinated biography takes: a question about a
    // university she never mentioned.
    const outcome = await generate([
      draft('What did you study at university?', { field: 'university' }),
    ]);
    assert.equal(outcome.summary.kept, 0);
    assert.equal(outcome.drops[0]?.reason, 'field_not_supplied');
  });

  it('keeps a general question with no field', async () => {
    const outcome = await generate([draft('Why are you leaving your job?', { field: null })]);
    assert.equal(outcome.summary.kept, 1);
    assert.equal(outcome.questions[0]?.field, null);
  });

  it('drops a statement that is not a question', async () => {
    const outcome = await generate([draft('Your district is known for weaving.')]);
    assert.equal(outcome.drops[0]?.reason, 'not_a_question');
  });

  it('drops a rewording of a question already banked', async () => {
    const outcome = await runGeneration(
      {
        requestId: 'r',
        entries: [{ field: 'home_district', value: 'Barpeta' }],
        excludeQuestions: ['What is your district known for?'],
        take: 8,
        model: 'm',
        system: 's',
      },
      {
        generate: async () => ({
          drafts: [draft('For what is your district known?')] as never,
          stopReason: 'end_turn',
          usage: ZERO_USAGE,
          provenance: 'model',
        }),
        signal: new AbortController().signal,
      },
    );
    assert.equal(outcome.summary.kept, 0);
    assert.equal(outcome.drops[0]?.reason, 'duplicate');
  });

  it('counts every drop by reason', async () => {
    const outcome = await generate([
      draft('Your district, known for weaving, faces what?'),
      draft('A statement about your district.'),
      draft('What is your district known for?'),
    ]);
    assert.deepEqual(outcome.summary.dropReasons, { contains_answer: 1, not_a_question: 1 });
    assert.equal(outcome.summary.kept, 1);
  });

  it('survives a null reply without throwing', async () => {
    const outcome = await runGeneration(
      { requestId: 'r', entries: [{ field: 'hobbies', value: 'x' }], excludeQuestions: [], take: 8, model: 'm', system: 's' },
      {
        generate: async () => ({ drafts: null, stopReason: 'max_tokens', usage: ZERO_USAGE, provenance: 'model' }),
        signal: new AbortController().signal,
      },
    );
    assert.equal(outcome.summary.kept, 0);
  });
});

describe('questionFingerprint', () => {
  it('collapses a reordering', () => {
    assert.equal(
      questionFingerprint('What is your district known for?'),
      questionFingerprint('For what is your district known?'),
    );
  });

  it('does not collapse two different questions', () => {
    assert.notEqual(
      questionFingerprint('What is your district known for?'),
      questionFingerprint('What is the literacy rate of your district?'),
    );
  });
});

describe('buildGeneratePayload', () => {
  it('lists only the entries supplied', () => {
    const payload = buildGeneratePayload({
      entries: [{ field: 'home_district', value: 'Barpeta, Assam' }],
      excludeQuestions: [],
      take: 8,
    });
    assert.match(payload, /home_district: Barpeta, Assam/);
    assert.match(payload, /A question about a field she left blank/);
  });

  it('includes the exclusion list, or a batch of duplicates looks healthy', () => {
    const payload = buildGeneratePayload({
      entries: [{ field: 'hobbies', value: 'Reading' }],
      excludeQuestions: ['What do you read?'],
      take: 8,
    });
    assert.match(payload, /Already banked/);
    assert.match(payload, /What do you read\?/);
  });
});
