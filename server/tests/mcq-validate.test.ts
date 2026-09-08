/**
 * The free half of the pipeline. Pure functions, so this file is dense on
 * purpose: every check here is the last thing standing between a wrong answer
 * key and a spaced-repetition schedule that will drill it to mastery.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.ANTHROPIC_API_KEY ??= 'sk-ant-test-not-real';
process.env.MODEL_EVALUATION ??= 'eval-model-1';
process.env.MODEL_BULK ??= 'bulk-model-1';
process.env.APP_BEARER_TOKEN ??= 'test-token';

const {
  ABOVE_OPTION_PATTERN,
  deriveExpectedSet,
  eliminationPower,
  hasEliminationPower,
  optionContentLength,
  parseOptionSubset,
  setsEqual,
  subsetKey,
  validateQuestion,
} = await import('../src/mcq/validate.js');
const { buildVerificationPayload, toVerifiable } = await import('../src/mcq/types.js');

type Draft = Parameters<typeof validateQuestion>[0];

/** A question that passes everything. Each test breaks exactly one thing. */
function goodDraft(overrides: Partial<Draft> = {}): Draft {
  return {
    form: 'statements_correct',
    stem: 'Consider the following statements regarding the Finance Commission.\nWhich of the statements given above is/are correct?',
    statements: [
      { index: 1, text: 'It is constituted by the President under Article 280.', isTrue: true },
      { index: 2, text: 'Its recommendations are binding on the Union Government.', isTrue: false },
    ],
    options: ['1 only', '2 only', 'Both 1 and 2', 'Neither 1 nor 2'],
    answerIndex: 0,
    eliminationRationale: [
      'Correct: Article 280 vests constitution of the body in the President.',
      'Confuses the binding force of the recommendations with their constitutional origin.',
      'Assumes both hold; the second does not.',
      'Assumes neither holds; the first does.',
    ],
    factKey: 'polity:article-280:finance-commission',
    verifiabilityAnchor: 'Article 280 of the Constitution of India.',
    ...overrides,
  } as Draft;
}

const STANDARD = { difficulty: 'standard' } as const;

describe('parseOptionSubset', () => {
  it('reads the classic subset forms', () => {
    assert.deepEqual([...(parseOptionSubset('1 only', 3) ?? [])], [1]);
    assert.deepEqual([...(parseOptionSubset('1 and 3 only', 3) ?? [])], [1, 3]);
    assert.deepEqual([...(parseOptionSubset('1, 2 and 3', 3) ?? [])], [1, 2, 3]);
    assert.deepEqual([...(parseOptionSubset('Both 1 and 2', 2) ?? [])], [1, 2]);
  });

  it('treats the negated forms as the empty set', () => {
    assert.deepEqual([...(parseOptionSubset('Neither 1 nor 2', 2) ?? [])], []);
    assert.deepEqual(
      [...(parseOptionSubset('None of the statements given above is correct', 3) ?? [])],
      [],
    );
  });

  it('returns null when the option does not denote a subset at all', () => {
    assert.equal(parseOptionSubset('The Reserve Bank of India', 3), null);
    assert.equal(parseOptionSubset('', 3), null);
  });

  it('returns null when an option references a statement that does not exist', () => {
    // A "4 only" option on a three-statement question is unanswerable, and
    // silently treating it as {} would make it look like a valid empty set.
    assert.equal(parseOptionSubset('4 only', 3), null);
    assert.equal(parseOptionSubset('0 only', 3), null);
  });

  it('is insensitive to wording, which is the whole point', () => {
    const a = parseOptionSubset('1 and 2 only', 2);
    const b = parseOptionSubset('Both 1 and 2', 2);
    assert.ok(a && b);
    assert.ok(setsEqual(a, b), 'the same set written two ways must compare equal');
    assert.equal(subsetKey(a), subsetKey(b));
  });
});

describe('elimination power', () => {
  const sets = (groups: number[][]) => groups.map((g) => new Set(g));

  it('counts the smaller side of the split', () => {
    // Statement 1 is in two options and out of two: resolving it either way
    // kills two.
    const subsets = sets([[1], [2], [1, 2], []]);
    assert.equal(eliminationPower(subsets, 1), 2);
    assert.equal(eliminationPower(subsets, 2), 2);
  });

  it('accepts the canonical two-statement option set', () => {
    assert.equal(hasEliminationPower(sets([[1], [2], [1, 2], []]), 2, 'foundation'), true);
  });

  it('accepts a three-statement set where one statement splits it evenly', () => {
    assert.equal(
      hasEliminationPower(sets([[1, 2], [2, 3], [3], [1, 2, 3]]), 3, 'standard'),
      true,
    );
  });

  it('rejects an option set where no statement buys two eliminations', () => {
    // Every option is an outlier on every statement: partial knowledge gets
    // you nothing, which makes this recall wearing a Prelims costume.
    const subsets = sets([[1], [2], [1, 2], [1, 2, 3]]);
    assert.equal(hasEliminationPower(subsets, 3, 'standard'), false);
    assert.equal(hasEliminationPower(subsets, 3, 'foundation'), false);
  });

  it('does not apply the requirement to challenging questions', () => {
    const subsets = sets([[1], [2], [1, 2], [1, 2, 3]]);
    assert.equal(hasEliminationPower(subsets, 3, 'challenging'), true);
  });
});

describe('deriveExpectedSet', () => {
  const statements = [
    { index: 1, isTrue: true },
    { index: 2, isTrue: false },
    { index: 3, isTrue: true },
  ];

  it('names the true statements for statements_correct', () => {
    assert.deepEqual([...deriveExpectedSet('statements_correct', statements)], [1, 3]);
  });

  it('names the false statements for statements_incorrect', () => {
    assert.deepEqual([...deriveExpectedSet('statements_incorrect', statements)], [2]);
  });
});

describe('validateQuestion — structural', () => {
  it('accepts a well-formed question', () => {
    const result = validateQuestion(goodDraft(), STANDARD);
    assert.equal(result.ok, true, JSON.stringify(result));
    if (result.ok) assert.equal(result.derivedAnswerIndex, 0);
  });

  it('rejects an answerIndex outside 0..3', () => {
    for (const answerIndex of [-1, 4, 1.5, Number.NaN]) {
      const result = validateQuestion(goodDraft({ answerIndex } as Partial<Draft>), STANDARD);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason, 'structure');
    }
  });

  it('rejects anything other than exactly four options', () => {
    const three = validateQuestion(
      goodDraft({ options: ['1 only', '2 only', 'Both 1 and 2'] }),
      STANDARD,
    );
    assert.equal(three.ok, false);
  });

  it('rejects an empty option', () => {
    const result = validateQuestion(
      goodDraft({ options: ['1 only', '   ', 'Both 1 and 2', 'Neither 1 nor 2'] }),
      STANDARD,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'structure');
  });

  it('requires four rationales including one for the key', () => {
    const result = validateQuestion(
      goodDraft({ eliminationRationale: ['a', 'b', 'c'] }),
      STANDARD,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'structure');

    const blank = validateQuestion(
      goodDraft({ eliminationRationale: ['a', 'b', 'c', '  '] }),
      STANDARD,
    );
    assert.equal(blank.ok, false);
  });

  it('requires a factKey and a verifiability anchor', () => {
    assert.equal(validateQuestion(goodDraft({ factKey: '' }), STANDARD).ok, false);
    assert.equal(validateQuestion(goodDraft({ verifiabilityAnchor: '' }), STANDARD).ok, false);
  });

  it('rejects two options that denote the same set of statements', () => {
    // Different strings, same meaning. Without this the question silently has
    // three options and the guess rate rises from 25% to 33%.
    const result = validateQuestion(
      goodDraft({ options: ['1 only', 'Statement 1 alone', 'Both 1 and 2', 'Neither 1 nor 2'] }),
      STANDARD,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'option_subsets');
  });

  it('rejects an option that does not denote a subset at all', () => {
    const result = validateQuestion(
      goodDraft({ options: ['1 only', '2 only', 'Both 1 and 2', 'The Finance Ministry'] }),
      STANDARD,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'option_subsets');
  });

  it('rejects a question with no elimination power at foundation level', () => {
    const result = validateQuestion(
      goodDraft({
        statements: [
          { index: 1, text: 'First claim about the body.', isTrue: true },
          { index: 2, text: 'Second claim about the body.', isTrue: true },
          { index: 3, text: 'Third claim about the body.', isTrue: false },
        ],
        options: ['1 only', '2 only', '1 and 2 only', '1, 2 and 3'],
        answerIndex: 2,
      }),
      { difficulty: 'foundation' },
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'elimination_power');
  });
});

describe('validateQuestion — self-consistency', () => {
  it('rejects when the key disagrees with the statements own verdicts', () => {
    // The reasoning is right and the translation to an option is wrong. This
    // is the most common real failure and it is invisible without this check:
    // every rationale still reads plausibly.
    const result = validateQuestion(goodDraft({ answerIndex: 2 }), STANDARD);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'self_consistency');
      assert.match(result.detail, /answerIndex 2 but the verdicts imply 0/);
    }
  });

  it('rejects when no option matches the verdicts at all', () => {
    const result = validateQuestion(
      goodDraft({
        statements: [
          { index: 1, text: 'First claim.', isTrue: false },
          { index: 2, text: 'Second claim.', isTrue: false },
        ],
        options: ['1 only', '2 only', 'Both 1 and 2', '1, 2 and 2 only'],
        answerIndex: 0,
      }),
      STANDARD,
    );
    assert.equal(result.ok, false);
  });

  it('applies the inverted polarity for statements_incorrect', () => {
    const result = validateQuestion(
      goodDraft({
        form: 'statements_incorrect',
        // Statement 2 is the false one, so the key must be "2 only".
        answerIndex: 1,
      }),
      STANDARD,
    );
    assert.equal(result.ok, true, JSON.stringify(result));
  });
});

describe('validateQuestion — prohibitions', () => {
  it('rejects a time-varying qualifier anywhere in the question', () => {
    for (const word of ['current', 'currently', 'latest', 'present', 'recent', 'as of']) {
      const result = validateQuestion(
        goodDraft({
          statements: [
            { index: 1, text: `The ${word} arrangement is set by Article 280.`, isTrue: true },
            { index: 2, text: 'Its recommendations are binding.', isTrue: false },
          ],
        }),
        STANDARD,
      );
      assert.equal(result.ok, false, `"${word}" must be rejected`);
      if (!result.ok) assert.equal(result.reason, 'time_varying');
    }
  });

  it('rejects a question about who holds an office', () => {
    const result = validateQuestion(
      goodDraft({
        stem: 'Who is the Chairman of the Finance Commission?\nWhich of the statements given above is/are correct?',
      }),
      STANDARD,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'time_varying');
  });

  it('still allows an office named in a timeless constitutional claim', () => {
    // The rule must not reject Polity itself. "The President may promulgate
    // ordinances" is as true in five years as today.
    const result = validateQuestion(
      goodDraft({
        statements: [
          {
            index: 1,
            text: 'The President may promulgate ordinances under Article 123.',
            isTrue: true,
          },
          { index: 2, text: 'An ordinance has a life of one year.', isTrue: false },
        ],
      }),
      STANDARD,
    );
    assert.equal(result.ok, true, JSON.stringify(result));
  });

  it('rejects a count that only grows', () => {
    const result = validateQuestion(
      goodDraft({
        statements: [
          { index: 1, text: 'India has 85 Ramsar sites.', isTrue: true },
          { index: 2, text: 'Ramsar designation is made under a 1971 treaty.', isTrue: false },
        ],
      }),
      STANDARD,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'time_varying');
  });

  it('rejects an "all of the above" option', () => {
    assert.match('All of the above', ABOVE_OPTION_PATTERN);
    const result = validateQuestion(
      goodDraft({ options: ['1 only', '2 only', 'Neither 1 nor 2', 'All of the above'] }),
      STANDARD,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'above_option');
  });

  it('does not confuse a legitimate empty-set option with "none of the above"', () => {
    assert.doesNotMatch('None of the statements given above is correct', ABOVE_OPTION_PATTERN);
  });

  it('rejects a correct option padded far longer than the others', () => {
    const result = validateQuestion(
      goodDraft({
        options: [
          '1 only, provided the recommendation has been laid before each House of Parliament together with an explanatory memorandum',
          '2 only',
          'Both 1 and 2',
          'Neither 1 nor 2',
        ],
      }),
      STANDARD,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'length_cue');
  });

  it('does not fire on ordinary subset options of different lengths', () => {
    // "Neither 1 nor 2" is 2.5x the raw length of "1 only". Measuring raw
    // length would reject every normal UPSC option set.
    assert.equal(optionContentLength('Neither 1 nor 2'), 0);
    assert.equal(optionContentLength('1 only'), 0);
    assert.equal(validateQuestion(goodDraft({ answerIndex: 0 }), STANDARD).ok, true);
  });
});

describe('the blind projection', () => {
  it('drops the key, the rationales and the statement verdicts', () => {
    const projected = toVerifiable(goodDraft());
    assert.deepEqual(Object.keys(projected).sort(), ['form', 'options', 'statements', 'stem']);
    for (const statement of projected.statements) {
      assert.deepEqual(Object.keys(statement).sort(), ['index', 'text']);
    }
  });

  it('serialises without the answer or any rationale text', () => {
    // The property under test is about the BYTES on the wire, not the object
    // graph: a verifier that can see the key is agreeing, not verifying.
    const payload = buildVerificationPayload([goodDraft(), goodDraft({ answerIndex: 3 })]);
    assert.equal(payload.includes('answerIndex'), false);
    assert.equal(payload.includes('eliminationRationale'), false);
    assert.equal(payload.includes('isTrue'), false);
    assert.equal(payload.includes('factKey'), false);
    assert.equal(payload.includes('difficulty'), false);
    for (const rationale of goodDraft().eliminationRationale) {
      assert.equal(payload.includes(rationale), false, 'a rationale string leaked');
    }
    // And it still carries what the verifier genuinely needs.
    assert.ok(payload.includes('Finance Commission'));
    assert.ok(payload.includes('Neither 1 nor 2'));
  });
});
