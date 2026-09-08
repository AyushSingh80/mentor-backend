/**
 * POST /drills/generate and /drills/evaluate — the app half of the contract.
 *
 * Counterpart: `server/tests/drill-contract.test.ts`, which feeds these very
 * bodies through the real `parseGenerateBody` and `parseEvaluateBody`.
 *
 * ## Why this pair was written before the screens, not after
 *
 * Phases 3 and 4 each shipped with every field name different across the wire.
 * The app sent `{vocabulary, excludeCanonicalUrls}` and the server read
 * `{syllabusSlugs, seenCanonicalUrls}`; the app sent `{batchSize, sections[]}`
 * and the server read `{paper, topic, difficulty, count}`. Both times every test
 * on both sides passed, and both times the endpoint answered 400 to every
 * request it ever received.
 *
 * The cure is not more tests on either half. It is one pair that crosses the
 * boundary, and writing it first — so the wire is a thing that was agreed rather
 * than a thing each side inferred.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { EvaluateDrillRequest, GeneratePromptsRequest } from '../src/lib/drill-api';
import {
  DRILL_PROMPT_VERSION,
  buildEvaluateDrillRequest,
  buildGeneratePromptsRequest,
} from '../src/lib/drill-request';
import { ESSAY_OUTLINE_PARTS, ETHICS_CASE_PARTS, type DrillPartFacts } from '../src/lib/drill-types';

/* ------------------------------------------------------------------ shared */

function part(name: string, content: string): DrillPartFacts {
  return {
    part: name as DrillPartFacts['part'],
    content,
    words: content.trim().split(/\s+/).length,
  };
}

/* ---------------------------------------------------------------- generate */

function generateAsSent(
  overrides: Partial<Parameters<typeof buildGeneratePromptsRequest>[0]> = {},
): GeneratePromptsRequest {
  return buildGeneratePromptsRequest({
    requestId: 'drill_2026-09-07_5f2a',
    want: [
      { kind: 'essay_outline', count: 4 },
      { kind: 'ethics_case', count: 2 },
    ],
    vocabulary: [
      { slug: 'essay-envt-climate-and-responsibility', label: 'Climate and responsibility' },
      { slug: 'gs4-values-integrity', label: 'Integrity' },
    ],
    bankedPrompts: ['Order is not the absence of disorder, but its management'],
    ...overrides,
  });
}

/** Every key `parseGenerateBody` reads, restated. The two packages never compile together. */
const GENERATE_KEYS = [
  'excludePrompts',
  'promptVersion',
  'requestId',
  'vocabulary',
  'want',
] as const;

describe('POST /drills/generate request body', () => {
  it('sends exactly the keys the server reads, and no others', () => {
    assert.deepEqual(
      Object.keys(JSON.parse(JSON.stringify(generateAsSent()))).sort(),
      [...GENERATE_KEYS].sort(),
    );
  });

  it('sends each want entry as {kind, count} and nothing else', () => {
    for (const entry of generateAsSent().want) {
      assert.deepEqual(Object.keys(entry).sort(), ['count', 'kind']);
      assert.ok(Number.isInteger(entry.count) && entry.count > 0);
    }
  });

  it('drops a kind asked for zero of rather than sending it', () => {
    // The server refuses a count below one, and rightly: asking for none of
    // something is not a request, it is a bug upstream. Sending it would turn a
    // full-of-one-kind bank into a 400 on every automatic top-up.
    const request = generateAsSent({
      want: [
        { kind: 'essay_outline', count: 3 },
        { kind: 'ethics_case', count: 0 },
      ],
    });
    assert.deepEqual(request.want, [{ kind: 'essay_outline', count: 3 }]);
  });

  it('sends vocabulary entries as {slug, label}', () => {
    for (const entry of generateAsSent().vocabulary) {
      assert.deepEqual(Object.keys(entry).sort(), ['label', 'slug']);
      assert.notEqual(entry.slug.trim(), '');
    }
  });

  it('sends the banked prompts under the name the server reads', () => {
    // The quiet half of every version of this bug. A misnamed exclusion list
    // does not fail — the server answers 200 and sets a topic she already has,
    // which she discovers twenty minutes into writing it again.
    assert.deepEqual(generateAsSent().excludePrompts, [
      'Order is not the absence of disorder, but its management',
    ]);
  });

  it('does not send names from the shapes this contract replaced', () => {
    const sent = new Set(Object.keys(generateAsSent()));
    for (const dead of ['kinds', 'counts', 'syllabusSlugs', 'excludeCanonicalUrls', 'batchSize']) {
      assert.equal(sent.has(dead), false, `"${dead}" is not a field the server reads`);
    }
  });

  it('reports the prompt cohort this build asks for', () => {
    assert.equal(generateAsSent().promptVersion, DRILL_PROMPT_VERSION);
  });

  it('survives a JSON round trip unchanged', () => {
    // A Set, a Map or an undefined here serialises to something the server
    // cannot read, and TypeScript would not say a word.
    const request = generateAsSent();
    assert.deepEqual(JSON.parse(JSON.stringify(request)) as GeneratePromptsRequest, request);
  });

  it('copies the caller`s lists rather than aliasing them', () => {
    const banked = ['a'];
    const request = buildGeneratePromptsRequest({
      requestId: 'drill-alias',
      want: [{ kind: 'essay_outline', count: 1 }],
      vocabulary: [],
      bankedPrompts: banked,
    });
    banked.push('b');
    assert.deepEqual(request.excludePrompts, ['a']);
  });
});

/* ---------------------------------------------------------------- evaluate */

const OUTLINE_PARTS: DrillPartFacts[] = [
  part('thesis', 'Order is a continuous administrative achievement, not a settled condition.'),
  part('dimensions', 'Political: policing by consent\nEconomic: the cost of predictability\nHistorical: the Emergency as managed order'),
  part('opening', 'In 1975 the trains ran on time. That sentence has done more damage than almost any other.'),
  part('closing', 'The question is never whether order exists but who bears its cost.'),
];

function evaluateAsSent(
  overrides: Partial<Parameters<typeof buildEvaluateDrillRequest>[0]> = {},
): EvaluateDrillRequest {
  return buildEvaluateDrillRequest({
    requestId: 'drill_eval_5f2a',
    kind: 'essay_outline',
    promptText: 'Order is not the absence of disorder, but its management',
    caseDetail: null,
    parts: OUTLINE_PARTS,
    ...overrides,
  });
}

const EVALUATE_KEYS = ['caseDetail', 'kind', 'parts', 'promptText', 'requestId'] as const;

describe('POST /drills/evaluate request body', () => {
  it('sends exactly the keys the server reads, and no others', () => {
    assert.deepEqual(
      Object.keys(JSON.parse(JSON.stringify(evaluateAsSent()))).sort(),
      [...EVALUATE_KEYS].sort(),
    );
  });

  it('sends parts in DECLARED order, whatever order they were written in', () => {
    // The mark sheet is rendered by joining verdicts to parts. Sending them in
    // editing order would still work today and would break silently the moment
    // anything joined positionally instead of by key.
    const shuffled = [...OUTLINE_PARTS].reverse();
    assert.deepEqual(
      evaluateAsSent({ parts: shuffled }).parts.map((entry) => entry.part),
      [...ESSAY_OUTLINE_PARTS],
    );
  });

  it('sends each part as {part, content}', () => {
    for (const entry of evaluateAsSent().parts) {
      assert.deepEqual(Object.keys(entry).sort(), ['content', 'part']);
    }
  });

  it('sends null rather than an empty string for an outline`s case detail', () => {
    // The server refuses an ethics case whose detail is missing and refuses an
    // outline that carries one. An empty string is neither, and would be read
    // as "missing" by one check and "present" by the other.
    assert.equal(evaluateAsSent({ caseDetail: '   ' }).caseDetail, null);
  });

  it('carries the case detail for an ethics case, which the server requires', () => {
    const request = buildEvaluateDrillRequest({
      requestId: 'drill_eval_case',
      kind: 'ethics_case',
      promptText: 'A contractor offers to fund a school your department cannot afford',
      caseDetail: 'You are the Sub-Divisional Magistrate of a district where the school has no roof.',
      parts: ETHICS_CASE_PARTS.map((name) => part(name, `A written answer for ${name}.`)),
    });
    assert.equal(request.kind, 'ethics_case');
    assert.match(request.caseDetail ?? '', /Sub-Divisional Magistrate/);
    assert.deepEqual(
      request.parts.map((entry) => entry.part),
      [...ETHICS_CASE_PARTS],
    );
  });

  it('omits an empty part rather than sending a blank one', () => {
    // The server refuses a part whose content is blank. Sending one would turn
    // a half-finished draft into a 400 rather than a local submit-gate message.
    const request = evaluateAsSent({
      parts: [OUTLINE_PARTS[0]!, part('dimensions', '   '), OUTLINE_PARTS[2]!],
    });
    assert.deepEqual(
      request.parts.map((entry) => entry.part),
      ['thesis', 'opening'],
    );
  });

  it('trims the prompt and every part', () => {
    const request = evaluateAsSent({
      promptText: '  a topic with padding  ',
      parts: [part('thesis', '  padded thesis  ')],
    });
    assert.equal(request.promptText, 'a topic with padding');
    assert.equal(request.parts[0]?.content, 'padded thesis');
  });

  it('survives a JSON round trip unchanged', () => {
    const request = evaluateAsSent();
    assert.deepEqual(JSON.parse(JSON.stringify(request)) as EvaluateDrillRequest, request);
  });
});
