/**
 * POST /ca/digest request-body contract — the server half.
 *
 * Counterpart: `app/tests/ca-request-contract.test.ts`, which asserts the app
 * EMITS this body. This one asserts `parseCaBody` READS it. Neither is
 * sufficient alone: the bug they exist to catch lives in the gap between two
 * packages that are never compiled together, and it is not hypothetical.
 *
 * Phase 4 shipped with every field name different on the two sides. The app
 * sent `vocabulary`; the server read `syllabusSlugs`, found nothing, and
 * answered 400 to every digest request ever made. `tests/ca-http.test.ts`
 * passed throughout, because its fixture body described a shape no client sent.
 *
 * So the object below is COPIED FROM THE APP, not written to suit this parser.
 * If it stops matching what `buildDigestRequest` produces, this file is wrong
 * and updating it to agree with the parser is exactly the mistake to avoid.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.ANTHROPIC_API_KEY ??= 'test-key';
process.env.MODEL_EVALUATION ??= 'eval-model-1';
process.env.MODEL_BULK ??= 'bulk-model-1';
process.env.APP_BEARER_TOKEN ??= 'test-token';

const { parseCaBody } = await import('../src/routes/ca.js');

/**
 * Verbatim the output of `buildDigestRequest` in `app/src/lib/ca-request.ts`,
 * on a syllabus with one started section and one untouched.
 */
function appRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 'req_2026-09-07_5f2a',
    resume: false,
    date: '2026-09-07',
    timezone: 'Asia/Kolkata',
    maxItems: 6,
    vocabulary: [
      { slug: 'gs2:Indian Constitution', label: 'Indian Constitution', paper: 'gs2', level: 'section' },
      { slug: 'gs3:Environment', label: 'Environment', paper: 'gs3', level: 'section' },
      { slug: 'anthro_p2:Tribal India', label: 'Tribal India', paper: 'anthro_p2', level: 'section' },
      { slug: 'gs2-fundamental-rights', label: 'Indian Constitution', paper: 'gs2', level: 'leaf' },
      { slug: 'gs2-dpsp', label: 'Indian Constitution', paper: 'gs2', level: 'leaf' },
    ],
    seenCanonicalUrls: ['https://pib.gov.in/pressrelease/1234'],
    seenFingerprints: ['9c1f2ab0'],
    sectionCountsThisWeek: { 'gs2:Indian Constitution': 2 },
    linkAnthropology: true,
    promptVersion: 'ca-digest-v1',
    ...overrides,
  };
}

function accept(body: Record<string, unknown>) {
  const parsed = parseCaBody(body);
  assert.notEqual(typeof parsed, 'string', `body was rejected: ${String(parsed)}`);
  return parsed as Exclude<ReturnType<typeof parseCaBody>, string>;
}

/* --------------------------------------------------------------------- tests */

describe('the body the app actually sends', () => {
  it('is accepted', () => {
    const parsed = accept(appRequest());
    assert.equal(parsed.requestId, 'req_2026-09-07_5f2a');
    assert.equal(parsed.date, '2026-09-07');
    assert.equal(parsed.maxItems, 6);
  });

  it('carries the exclusion lists through under the names the app uses', () => {
    // The quietest of the three original mismatches, and the worst. A misnamed
    // exclusion list does not fail: the server answers 200 and re-delivers
    // yesterday's stories forever, with nothing in any log to say so.
    const parsed = accept(appRequest());
    assert.deepEqual(parsed.seenCanonicalUrls, ['https://pib.gov.in/pressrelease/1234']);
    assert.deepEqual(parsed.seenFingerprints, ['9c1f2ab0']);
    assert.deepEqual(parsed.sectionCountsThisWeek, { 'gs2:Indian Constitution': 2 });
    assert.equal(parsed.linkAnthropology, true);
  });

  it('builds a FLAT allowlist holding both vocabulary levels', () => {
    // `select.ts` rule 1 drops any item that hits no key in `syllabusSlugs`.
    // Leaves-only would drop a correctly section-tagged item — and on a fresh
    // install, where the app offers sections and nothing else, it would drop
    // every item in every digest.
    const parsed = accept(appRequest());
    assert.deepEqual(parsed.syllabusSlugs, [
      'gs2:Indian Constitution',
      'gs3:Environment',
      'anthro_p2:Tribal India',
      'gs2-fundamental-rights',
      'gs2-dpsp',
    ]);
  });

  it('derives the section subset from `level`, for the diversity cap', () => {
    const parsed = accept(appRequest());
    assert.deepEqual(parsed.sections, [
      'gs2:Indian Constitution',
      'gs3:Environment',
      'anthro_p2:Tribal India',
    ]);
  });

  it('keeps the labels, which are what make a bare slug legible to the model', () => {
    const parsed = accept(appRequest());
    assert.equal(parsed.slugLabels['gs2-fundamental-rights'], 'Indian Constitution');
    assert.equal(parsed.slugLabels['gs3:Environment'], 'Environment');
  });

  it('accepts a fresh install, where the vocabulary is sections and nothing else', () => {
    // `tagVocabulary` withholds leaves for sections she has not started. On day
    // one that is the whole payload, and it must not be a 400.
    const sectionsOnly = appRequest({
      vocabulary: [
        { slug: 'gs1:Modern History', label: 'Modern History', paper: 'gs1', level: 'section' },
        { slug: 'gs2:Indian Constitution', label: 'Indian Constitution', paper: 'gs2', level: 'section' },
      ],
      sectionCountsThisWeek: {},
    });
    const parsed = accept(sectionsOnly);
    assert.equal(parsed.syllabusSlugs.length, 2);
    assert.deepEqual(parsed.sections, parsed.syllabusSlugs);
  });

  it('ignores the three fields the app sends and this server does not read', () => {
    // Asserted rather than assumed: an unread field must be a decision someone
    // made, not a rename nobody noticed. The app half lists the same three.
    const parsed = accept(appRequest());
    for (const key of ['resume', 'timezone', 'promptVersion']) {
      assert.equal(key in parsed, false, `"${key}" is documented as unread but was parsed`);
    }
  });
});

describe('vocabulary edge cases', () => {
  it('degrades an entry with no usable level to a leaf rather than rejecting', () => {
    // `level` is advisory per the app's own contract. Refusing the request over
    // it would cost a paid digest for a field that is not the contract.
    const parsed = accept(
      appRequest({ vocabulary: [{ slug: 'gs2-dpsp', label: 'DPSP', paper: 'gs2' }] }),
    );
    assert.deepEqual(parsed.syllabusSlugs, ['gs2-dpsp']);
    assert.deepEqual(parsed.sections, []);
  });

  it('keeps the first of a repeated slug, matching the device index', () => {
    // `buildTagIndex`'s `remember()` is first-writer-wins. A second entry here
    // would inflate the prompt with a key the device resolves only once.
    const parsed = accept(
      appRequest({
        vocabulary: [
          { slug: 'gs2-dpsp', label: 'DPSP', paper: 'gs2', level: 'leaf' },
          { slug: 'gs2-dpsp', label: 'Directive Principles', paper: 'gs2', level: 'leaf' },
        ],
      }),
    );
    assert.deepEqual(parsed.syllabusSlugs, ['gs2-dpsp']);
    assert.equal(parsed.slugLabels['gs2-dpsp'], 'DPSP');
  });

  it('rejects a vocabulary of bare strings rather than reading them as slugs', () => {
    // Tempting to accept, and wrong. It would let a future app version send a
    // flattened list that silently loses every label and every level.
    const parsed = parseCaBody(appRequest({ vocabulary: ['gs2-dpsp'] }));
    assert.equal(typeof parsed, 'string');
  });

  it('refuses an empty vocabulary rather than billing for a guaranteed empty digest', () => {
    assert.equal(typeof parseCaBody(appRequest({ vocabulary: [] })), 'string');
  });
});
