import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Imports the pure mapper, not `evaluation.ts` — that file pulls in the DB and
// the network client, neither of which can load under Node. Keeping the three
// wire-to-DB impedance mismatches in a pure module is what makes them testable.
import {
  defaultMaxForWordLimit,
  extractModelSkeleton,
  toEvaluationInput,
} from '../src/lib/evaluation-map';
import type { EvaluationMeta, EvaluationScores } from '../src/lib/api';

const META: EvaluationMeta = {
  model: 'bulk-model-4-6-20260514',
  rubricVersion: 'sha256:9f2c14b0',
  rubricName: 'GS Mains',
  paper: 'gs2',
  pages: 3,
};

/** Shaped like the five sections `server/src/rubrics/_output.md` demands. */
const FEEDBACK = [
  '## Directive compliance',
  '',
  'The question says "critically examine"; the answer only describes.',
  '',
  '## Dimension-by-dimension',
  '',
  '**Content and syllabus relevance — 1.8/4.** You write "the scheme was very',
  'beneficial" without naming a single beneficiary group.',
  '',
  '## The single highest-leverage fix',
  '',
  'Add a two-line counter-view before the conclusion.',
  '',
  '## Model skeleton',
  '',
  '- Intro: define cooperative federalism in one line, cite Article 263.',
  '- Body: three paragraphs — fiscal, administrative, political.',
  '- Conclusion: forward-looking, name one institutional fix.',
  '',
  '## Compared to last time',
  '',
  'Your introduction is one line now instead of five.',
].join('\n');

const SKELETON = [
  '- Intro: define cooperative federalism in one line, cite Article 263.',
  '- Body: three paragraphs — fiscal, administrative, political.',
  '- Conclusion: forward-looking, name one institutional fix.',
].join('\n');

const scores = (over: Partial<EvaluationScores> = {}): EvaluationScores => ({
  total: 6,
  max: 10,
  dimensions: [{ name: 'Content and syllabus relevance', score: 1.8, max: 4, comment: 'Thin.' }],
  ...over,
});

const mapped = (over: Partial<Parameters<typeof toEvaluationInput>[0]> = {}) =>
  toEvaluationInput({
    answerId: 7,
    meta: META,
    scores: scores(),
    feedbackMarkdown: FEEDBACK,
    wordLimit: 150,
    paper: 'gs2',
    ...over,
  });

describe('defaultMaxForWordLimit', () => {
  it('marks a 150-word answer out of 10', () => {
    assert.equal(defaultMaxForWordLimit(150, 'gs1'), 10);
  });

  it('marks a 250-word answer out of 15', () => {
    assert.equal(defaultMaxForWordLimit(250, 'gs3'), 15);
  });

  it('marks a GS4 case study out of 20', () => {
    assert.equal(defaultMaxForWordLimit(250, 'gs4'), 20);
  });

  it('marks a short GS4 theory question out of 10, not 20', () => {
    // GS4 Section A is ordinary 10-mark questions; only the Section B case
    // studies are 20s. Keying off the paper alone would inflate every ethics
    // theory answer's denominator and quietly halve its percentage.
    assert.equal(defaultMaxForWordLimit(150, 'gs4'), 10);
  });

  it('marks a full essay out of 125', () => {
    assert.equal(defaultMaxForWordLimit(1000, 'essay'), 125);
    // Whatever nominal limit was captured — an essay is an essay.
    assert.equal(defaultMaxForWordLimit(250, 'essay'), 125);
  });

  it('treats the anthropology papers like any other written answer', () => {
    assert.equal(defaultMaxForWordLimit(150, 'anthro_p1'), 10);
    assert.equal(defaultMaxForWordLimit(250, 'anthro_p2'), 15);
  });
});

describe('extractModelSkeleton', () => {
  it('pulls section 4 out of a full rubric response', () => {
    assert.equal(extractModelSkeleton(FEEDBACK), SKELETON);
  });

  it('stops at the next section instead of swallowing it', () => {
    const skeleton = extractModelSkeleton(FEEDBACK) ?? '';
    assert.doesNotMatch(skeleton, /Compared to last time/);
    assert.doesNotMatch(skeleton, /introduction is one line/);
  });

  it('returns null when the model never wrote one', () => {
    const withoutSkeleton = FEEDBACK.replace(
      /## Model skeleton[\s\S]*?(?=## Compared)/,
      '',
    );
    assert.equal(extractModelSkeleton(withoutSkeleton), null);
  });

  it('returns null for feedback with no sections at all', () => {
    assert.equal(extractModelSkeleton('Just some prose about federalism.'), null);
    assert.equal(extractModelSkeleton(''), null);
  });

  it('finds a bold heading, which models emit as often as a hash', () => {
    const markdown = [
      '**The single highest-leverage fix**',
      '',
      'Name the counter-view.',
      '',
      '**Model skeleton**',
      '',
      'Intro: one line of context.',
      'Body: two arguments, one counter.',
      'Conclusion: a forward look.',
      '',
      '**Compared to last time**',
      '',
      'Nothing improved.',
    ].join('\n');

    assert.equal(
      extractModelSkeleton(markdown),
      'Intro: one line of context.\nBody: two arguments, one counter.\nConclusion: a forward look.',
    );
  });

  it('does not mistake a bold lead-in inside the skeleton for the next section', () => {
    // `**Intro** — …` is skeleton content. Treating every bold line as a
    // heading would truncate the skeleton to nothing on the most natural
    // formatting a model could pick.
    const markdown = [
      '## Model skeleton',
      '',
      '**Intro** — define the term, one line.',
      '**Body** — three paragraphs, one counter-view.',
      '**Conclusion** — an institutional fix.',
    ].join('\n');

    const skeleton = extractModelSkeleton(markdown);
    assert.match(skeleton ?? '', /\*\*Body\*\*/);
    assert.match(skeleton ?? '', /institutional fix/);
  });

  it('reads a numbered heading with the content on the same line', () => {
    const markdown = '4. **Model skeleton** — Intro, body, conclusion in three lines.';
    assert.equal(extractModelSkeleton(markdown), 'Intro, body, conclusion in three lines.');
  });

  it('runs to the end when the skeleton is the last section', () => {
    // Section 5 is written only when a previous attempt was supplied, so this
    // is the common shape, not the edge case.
    const markdown = ['## Model skeleton', '', 'Intro.', 'Body.', 'Conclusion.'].join('\n');
    assert.equal(extractModelSkeleton(markdown), 'Intro.\nBody.\nConclusion.');
  });

  it('returns null for a heading with nothing under it', () => {
    assert.equal(extractModelSkeleton('## Model skeleton\n\n## Compared to last time\n\nBetter.'), null);
  });
});

describe('toEvaluationInput — unparseable score block', () => {
  it('keeps the prose and stores a max of 0 so the row self-excludes', () => {
    const input = mapped({ scores: null });

    // `toPercent` in answers.ts returns null when max <= 0, so this row is
    // absent from the trend rather than plotted as a zero.
    assert.equal(input.total, 0);
    assert.equal(input.max, 0);
    assert.deepEqual(input.dimensions, []);

    // The feedback is the only thing the model produced, and the part she
    // actually reads. Discarding the evaluation to protect a chart would be
    // the wrong trade.
    assert.equal(input.feedbackMd, FEEDBACK);
    assert.equal(input.modelSkeletonMd, SKELETON);
  });

  it('still records which model and rubric produced it', () => {
    const input = mapped({ scores: null });
    assert.equal(input.model, META.model);
    assert.equal(input.rubricVersion, META.rubricVersion);
  });

  it('treats a non-numeric total as unusable rather than as zero marks', () => {
    // `evaluations.total` is NOT NULL; writing NaN fails the transaction and
    // loses the feedback with it. A max of 0 excludes the row instead.
    const input = mapped({
      scores: scores({ total: undefined as unknown as number }),
    });
    assert.equal(input.total, 0);
    assert.equal(input.max, 0);
  });
});

describe('toEvaluationInput — provenance', () => {
  it('takes model and rubricVersion from meta, never a local constant', () => {
    // A rubric edit changes rubricVersion, which is what makes an old score and
    // a new score visibly not comparable. A hardcoded constant would erase that.
    const input = mapped({
      meta: { ...META, model: 'eval-model-4-2', rubricVersion: 'sha256:deadbeef' },
    });
    assert.equal(input.model, 'eval-model-4-2');
    assert.equal(input.rubricVersion, 'sha256:deadbeef');
  });

  it('carries the scalar judgements straight through', () => {
    const input = mapped({
      scores: scores({
        directiveWord: 'critically examine',
        directiveCompliance: false,
        highestLeverageFix: 'Add a counter-view.',
        legibility: 'mixed',
        wordLimitRespected: true,
        confidence: 'medium',
      }),
    });

    assert.equal(input.directiveWord, 'critically examine');
    assert.equal(input.directiveCompliance, false);
    assert.equal(input.highestLeverageFix, 'Add a counter-view.');
    assert.equal(input.legibility, 'mixed');
    assert.equal(input.wordLimitRespected, true);
    assert.equal(input.confidence, 'medium');
  });

  it('nulls absent scalars rather than storing empty strings', () => {
    const input = mapped({ scores: scores({ legibility: '', highestLeverageFix: '   ' }) });
    assert.equal(input.legibility, null);
    assert.equal(input.highestLeverageFix, null);
    assert.equal(input.directiveCompliance, null);
  });
});

describe('toEvaluationInput — legibilityNote', () => {
  it('folds the note into the feedback under its own heading', () => {
    // `legibilityNote` has no column. It is the sentence that says WHY the
    // rating is what it is — the actionable half — so it is appended, not
    // dropped.
    const input = mapped({
      scores: scores({
        legibility: 'poor',
        legibilityNote: 'Page 2 is cropped along the right margin.',
      }),
    });

    assert.match(input.feedbackMd, /## Legibility/);
    assert.match(input.feedbackMd, /Page 2 is cropped along the right margin\./);
    assert.equal(input.legibility, 'poor');
    // Appended, never substituted: the original prose survives intact.
    assert.ok(input.feedbackMd.startsWith(FEEDBACK));
  });

  it('leaves the feedback untouched when there is no note', () => {
    assert.equal(mapped({ scores: scores({ legibility: 'good' }) }).feedbackMd, FEEDBACK);
    assert.equal(mapped({ scores: scores({ legibilityNote: '' }) }).feedbackMd, FEEDBACK);
    assert.equal(mapped({ scores: scores({ legibilityNote: '   ' }) }).feedbackMd, FEEDBACK);
  });

  it('does not let the note leak into the model skeleton', () => {
    // The skeleton is section 4 and often the last thing written, so appending
    // to the end of the markdown is exactly where a naive extractor would pick
    // the note up as skeleton content.
    const trailingSkeleton = ['## Model skeleton', '', 'Intro.', 'Body.', 'Conclusion.'].join('\n');
    const input = mapped({
      feedbackMarkdown: trailingSkeleton,
      scores: scores({ legibilityNote: 'The last two lines are illegible.' }),
    });

    assert.equal(input.modelSkeletonMd, 'Intro.\nBody.\nConclusion.');
    assert.match(input.feedbackMd, /The last two lines are illegible\./);
  });
});

describe('toEvaluationInput — dimensions', () => {
  it('trusts total and keeps dimensions as reported when they do not sum', () => {
    // `_output.md` requires the dimensions to sum to total. Models break that
    // rule. Rescaling would fabricate per-dimension marks the model never gave,
    // and those marks are what `weakestDimensions` reports back as "this is
    // what keeps costing you".
    const input = mapped({
      scores: scores({
        total: 6,
        max: 10,
        dimensions: [
          { name: 'Content', score: 1.8, max: 4, comment: 'Thin.' },
          { name: 'Structure', score: 1, max: 3, comment: 'Flat.' },
          { name: 'Directive compliance', score: 0.5, max: 3, comment: 'Described only.' },
        ],
      }),
    });

    assert.equal(input.total, 6);
    assert.equal(input.max, 10);
    assert.deepEqual(
      input.dimensions.map((d) => d.score),
      [1.8, 1, 0.5],
    );
    assert.notEqual(
      input.dimensions.reduce((sum, d) => sum + d.score, 0),
      input.total,
    );
    assert.deepEqual(
      input.dimensions.map((d) => d.max),
      [4, 3, 3],
    );
  });

  it('drops nameless entries and defaults unusable numbers to zero', () => {
    const input = mapped({
      scores: scores({
        dimensions: [
          { name: '', score: 2, max: 4, comment: 'x' },
          { name: 'Structure', score: undefined as unknown as number, max: 3, comment: '' },
        ],
      }),
    });

    assert.equal(input.dimensions.length, 1);
    assert.equal(input.dimensions[0]?.name, 'Structure');
    assert.equal(input.dimensions[0]?.score, 0);
    // An empty comment is stored as absent, not as an empty string.
    assert.equal(input.dimensions[0]?.comment, undefined);
  });

  it('survives a dimensions field that is not an array', () => {
    const input = mapped({
      scores: scores({ dimensions: undefined as unknown as EvaluationScores['dimensions'] }),
    });
    assert.deepEqual(input.dimensions, []);
  });
});

describe('toEvaluationInput — max', () => {
  it('uses the reported max even when it disagrees with the word limit', () => {
    // The model saw the actual mark allocation printed on the paper; this code
    // only saw a word count.
    const input = mapped({ scores: scores({ max: 12.5 }), wordLimit: 150, paper: 'gs2' });
    assert.equal(input.max, 12.5);
  });

  it('falls back to the word-limit default when the model omitted max', () => {
    const input = mapped({
      scores: scores({ total: 9, max: undefined as unknown as number }),
      wordLimit: 250,
      paper: 'gs4',
    });
    assert.equal(input.total, 9);
    assert.equal(input.max, 20);
  });

  it('falls back when the model reports a max of zero', () => {
    // A zero max would silently exclude a perfectly good score from the trend.
    const input = mapped({ scores: scores({ max: 0 }), wordLimit: 150, paper: 'gs1' });
    assert.equal(input.max, 10);
  });
});
