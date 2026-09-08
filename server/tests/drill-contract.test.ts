/**
 * POST /drills/generate and /drills/evaluate — the server half of the contract.
 *
 * Counterpart: `app/tests/drill-contract.test.ts`, which asserts the app EMITS
 * these bodies. The objects below are COPIED FROM THE APP, not written to suit
 * these parsers. If one stops matching what `buildGeneratePromptsRequest` or
 * `buildEvaluateDrillRequest` produces, this file is wrong — and updating it to
 * agree with the parser is exactly the mistake this pair exists to prevent.
 *
 * Written before the screens rather than after the outage, which is the one
 * process change Phase 5 makes over Phases 3 and 4.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.ANTHROPIC_API_KEY ??= 'test-key';
process.env.MODEL_EVALUATION ??= 'eval-model-1';
process.env.MODEL_BULK ??= 'bulk-model-1';
process.env.APP_BEARER_TOKEN ??= 'test-token';

const { parseEvaluateBody, parseGenerateBody } = await import('../src/routes/drills.js');
const { ESSAY_OUTLINE_PARTS, ETHICS_CASE_PARTS, PART_MAX, maxForKind } = await import(
  '../src/drills/types.js'
);

/* ---------------------------------------------------------------- generate */

/** Verbatim `buildGeneratePromptsRequest` output. */
function appGenerate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 'drill_2026-09-07_5f2a',
    want: [
      { kind: 'essay_outline', count: 4 },
      { kind: 'ethics_case', count: 2 },
    ],
    vocabulary: [
      { slug: 'essay-envt-climate-and-responsibility', label: 'Climate and responsibility' },
      { slug: 'gs4-values-integrity', label: 'Integrity' },
    ],
    excludePrompts: ['Order is not the absence of disorder, but its management'],
    promptVersion: 'drills-v1',
    ...overrides,
  };
}

function acceptGenerate(body: Record<string, unknown>) {
  const parsed = parseGenerateBody(body);
  assert.notEqual(typeof parsed, 'string', `body was rejected: ${String(parsed)}`);
  return parsed as Exclude<ReturnType<typeof parseGenerateBody>, string>;
}

describe('the generate body the app actually sends', () => {
  it('is accepted', () => {
    const parsed = acceptGenerate(appGenerate());
    assert.equal(parsed.requestId, 'drill_2026-09-07_5f2a');
    assert.equal(parsed.want.length, 2);
  });

  it('keeps the want counts, which size the reservation', () => {
    const parsed = acceptGenerate(appGenerate());
    assert.deepEqual(parsed.want, [
      { kind: 'essay_outline', count: 4 },
      { kind: 'ethics_case', count: 2 },
    ]);
  });

  it('keeps the exclusion list under the name the app uses', () => {
    // The quiet failure: a misnamed list means the server answers 200 and sets
    // a topic she already has, which she discovers twenty minutes in.
    assert.deepEqual(acceptGenerate(appGenerate()).excludePrompts, [
      'Order is not the absence of disorder, but its management',
    ]);
  });

  it('keeps the labels, which are what make a bare slug legible to the model', () => {
    const parsed = acceptGenerate(appGenerate());
    assert.equal(parsed.vocabulary[0]?.label, 'Climate and responsibility');
  });

  it('falls back to the slug when a vocabulary entry has no label', () => {
    const parsed = acceptGenerate(
      appGenerate({ vocabulary: [{ slug: 'gs4-values-integrity' }] }),
    );
    assert.equal(parsed.vocabulary[0]?.label, 'gs4-values-integrity');
  });

  it('accepts a request with no vocabulary at all', () => {
    // A device whose syllabus is unseeded can still drill. The prompts arrive
    // untagged, which degrades filing and nothing else.
    const parsed = acceptGenerate(appGenerate({ vocabulary: [] }));
    assert.deepEqual(parsed.vocabulary, []);
  });

  it('refuses an empty want rather than billing for a guaranteed empty batch', () => {
    const parsed = parseGenerateBody(appGenerate({ want: [] }));
    assert.equal(typeof parsed, 'string');
    assert.match(String(parsed), /at least one prompt/);
  });

  it('refuses a count of zero', () => {
    const parsed = parseGenerateBody(
      appGenerate({ want: [{ kind: 'essay_outline', count: 0 }] }),
    );
    assert.equal(typeof parsed, 'string');
  });

  it('refuses a repeated kind, which would double-count the reservation', () => {
    const parsed = parseGenerateBody(
      appGenerate({
        want: [
          { kind: 'essay_outline', count: 2 },
          { kind: 'essay_outline', count: 2 },
        ],
      }),
    );
    assert.equal(typeof parsed, 'string');
    assert.match(String(parsed), /repeats kind/);
  });

  it('refuses a batch over the ceiling', () => {
    const parsed = parseGenerateBody(
      appGenerate({
        want: [
          { kind: 'essay_outline', count: 12 },
          { kind: 'ethics_case', count: 12 },
        ],
      }),
    );
    assert.equal(typeof parsed, 'string');
    assert.match(String(parsed), /batch ceiling/);
  });
});

/* ---------------------------------------------------------------- evaluate */

/** Verbatim `buildEvaluateDrillRequest` output for an outline. */
function appEvaluate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 'drill_eval_5f2a',
    kind: 'essay_outline',
    promptText: 'Order is not the absence of disorder, but its management',
    caseDetail: null,
    parts: [
      { part: 'thesis', content: 'Order is a continuous administrative achievement, not a settled condition.' },
      { part: 'dimensions', content: 'Political: policing by consent\nEconomic: the cost of predictability\nHistorical: the Emergency as managed order' },
      { part: 'opening', content: 'In 1975 the trains ran on time. That sentence has done more damage than almost any other.' },
      { part: 'closing', content: 'The question is never whether order exists but who bears its cost.' },
    ],
    ...overrides,
  };
}

function acceptEvaluate(body: Record<string, unknown>) {
  const parsed = parseEvaluateBody(body);
  assert.notEqual(typeof parsed, 'string', `body was rejected: ${String(parsed)}`);
  return parsed as Exclude<ReturnType<typeof parseEvaluateBody>, string>;
}

describe('the evaluate body the app actually sends', () => {
  it('is accepted', () => {
    const parsed = acceptEvaluate(appEvaluate());
    assert.equal(parsed.kind, 'essay_outline');
    assert.equal(parsed.parts.length, 4);
  });

  it('keeps the parts in declared order', () => {
    assert.deepEqual(
      acceptEvaluate(appEvaluate()).parts.map((entry) => entry.part),
      [...ESSAY_OUTLINE_PARTS],
    );
  });

  it('orders parts sent out of order, so the mark sheet always lines up', () => {
    const shuffled = (appEvaluate().parts as unknown[]).slice().reverse();
    assert.deepEqual(
      acceptEvaluate(appEvaluate({ parts: shuffled })).parts.map((entry) => entry.part),
      [...ESSAY_OUTLINE_PARTS],
    );
  });

  it('accepts an ethics case with its situation', () => {
    const parsed = acceptEvaluate({
      requestId: 'drill_eval_case',
      kind: 'ethics_case',
      promptText: 'A contractor offers to fund a school your department cannot afford',
      caseDetail: 'You are the Sub-Divisional Magistrate of a district where the school has no roof.',
      parts: ETHICS_CASE_PARTS.map((part) => ({ part, content: `A written answer for ${part}.` })),
    });
    assert.equal(parsed.parts.length, ETHICS_CASE_PARTS.length);
    assert.match(parsed.caseDetail ?? '', /Sub-Divisional/);
  });

  it('refuses an ethics case with no situation', () => {
    // Marking a case without its facts is marking a different question: every
    // option's merits turn on detail that would not be in the payload.
    const parsed = parseEvaluateBody({
      requestId: 'r',
      kind: 'ethics_case',
      promptText: 'A contractor offers to fund a school',
      caseDetail: null,
      parts: ETHICS_CASE_PARTS.map((part) => ({ part, content: `answer for ${part}` })),
    });
    assert.equal(typeof parsed, 'string');
    assert.match(String(parsed), /caseDetail is required/);
  });

  it('refuses a partial submission rather than marking it out of the wrong total', () => {
    // She would read three scores against a total that assumed five, and no
    // number on the screen would be the one she thinks it is.
    const parsed = parseEvaluateBody(
      appEvaluate({ parts: (appEvaluate().parts as unknown[]).slice(0, 2) }),
    );
    assert.equal(typeof parsed, 'string');
    assert.match(String(parsed), /has 4 parts; 2 were sent/);
  });

  it('refuses a part belonging to the other kind', () => {
    const parsed = parseEvaluateBody(
      appEvaluate({
        parts: [
          { part: 'thesis', content: 'x'.repeat(40) },
          { part: 'stakeholders', content: 'x'.repeat(40) },
          { part: 'opening', content: 'x'.repeat(40) },
          { part: 'closing', content: 'x'.repeat(40) },
        ],
      }),
    );
    assert.equal(typeof parsed, 'string');
    assert.match(String(parsed), /must be one of thesis\|dimensions\|opening\|closing/);
  });

  it('refuses a repeated part', () => {
    const parts = appEvaluate().parts as Record<string, unknown>[];
    const parsed = parseEvaluateBody(appEvaluate({ parts: [...parts, parts[0]] }));
    assert.equal(typeof parsed, 'string');
    assert.match(String(parsed), /repeats thesis/);
  });

  it('refuses a blank part', () => {
    const parts = (appEvaluate().parts as Record<string, unknown>[]).slice();
    parts[1] = { part: 'dimensions', content: '   ' };
    const parsed = parseEvaluateBody(appEvaluate({ parts }));
    assert.equal(typeof parsed, 'string');
  });
});

/* -------------------------------------------------------------- the marks */

describe('the mark scale, which both sides display', () => {
  it('sums the part maxima to the kind`s total', () => {
    for (const [kind, parts] of [
      ['essay_outline', ESSAY_OUTLINE_PARTS],
      ['ethics_case', ETHICS_CASE_PARTS],
    ] as const) {
      const summed = parts.reduce((total, part) => total + PART_MAX[part], 0);
      assert.equal(maxForKind(kind), summed, `${kind} max must equal the sum of its parts`);
    }
  });

  it('scores an ethics case out of the 20 UPSC actually gives one', () => {
    // The mark she sees has to be the mark the paper uses, or the trend line
    // means nothing against a real attempt.
    assert.equal(maxForKind('ethics_case'), 20);
  });

  it('scores an outline out of less than the essay paper`s 125', () => {
    // An outline is not an essay and must never present itself as one.
    assert.ok(maxForKind('essay_outline') < 125);
  });
});
