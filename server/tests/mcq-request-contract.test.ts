/**
 * POST /mcq/generate request-body contract — the server half.
 *
 * Counterpart: `app/tests/mcq-request-contract.test.ts`, which asserts the app
 * EMITS this body. Sibling of `ca-request-contract.test.ts`, written after the
 * same defect was found in both phases.
 *
 * Phase 3 shipped with every field name different on the two sides. The app
 * sent `{batchSize, sections[]}`; the server read `{paper, topic, difficulty,
 * count}`, found no paper, and answered 400 to every refill ever attempted —
 * the offline question bank could never fill. `tests/mcq-http.test.ts` passed
 * throughout, because its fixture body described a shape no client sent.
 *
 * So the object below is COPIED FROM THE APP. If it stops matching what
 * `buildGenerateRequest` produces, this file is wrong, and updating it to agree
 * with the parser is exactly the mistake to avoid.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.ANTHROPIC_API_KEY ??= 'test-key';
process.env.MODEL_EVALUATION ??= 'eval-model-1';
process.env.MODEL_BULK ??= 'bulk-model-1';
process.env.APP_BEARER_TOKEN ??= 'test-token';

const { parseMcqBody } = await import('../src/routes/mcq.js');

/** Verbatim the output of `buildGenerateRequest` in `app/src/lib/mcq-request.ts`. */
function appRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 'mcq_2026-09-07_5f2a',
    resume: false,
    batchSize: 12,
    sections: [
      {
        sectionKey: 'gs2:Indian Constitution',
        syllabusSlug: 'gs2-fundamental-rights',
        syllabusSlugs: ['gs2-fundamental-rights', 'gs2-dpsp'],
        paper: 'gs2',
        label: 'Indian Constitution and Polity',
        count: 7,
        reason: 'lowest accuracy of the sections you have started',
      },
      {
        sectionKey: 'gs3:Economy',
        syllabusSlug: 'gs3-budgeting',
        syllabusSlugs: ['gs3-budgeting'],
        paper: 'gs3',
        label: 'Indian Economy',
        count: 5,
        reason: 'never drilled',
      },
    ],
    excludeStemHashes: ['9c1f2ab0', '4d7e8f21'],
    promptVersion: 'mcq-prelims-v1',
    rationale: 'topping up the two weakest sections',
    ...overrides,
  };
}

function accept(body: Record<string, unknown>) {
  const parsed = parseMcqBody(body);
  assert.notEqual(typeof parsed, 'string', `body was rejected: ${String(parsed)}`);
  return parsed as Exclude<ReturnType<typeof parseMcqBody>, string>;
}

/* --------------------------------------------------------------------- tests */

describe('the body the app actually sends', () => {
  it('is accepted', () => {
    const parsed = accept(appRequest());
    assert.equal(parsed.requestId, 'mcq_2026-09-07_5f2a');
    assert.equal(parsed.batchSize, 12);
    assert.equal(parsed.sections.length, 2);
  });

  it('keeps the sections in the order the planner ranked them', () => {
    // The loop runs them in order and the batch can be cut short by a
    // disconnect or a truncated chunk, so section order IS priority order: the
    // weakest section must be generated first, not last.
    const parsed = accept(appRequest());
    assert.deepEqual(
      parsed.sections.map((section) => section.sectionKey),
      ['gs2:Indian Constitution', 'gs3:Economy'],
    );
  });

  it('carries every per-section field the prompt and the ledger need', () => {
    const [polity] = accept(appRequest()).sections;
    assert.equal(polity?.paper, 'gs2');
    assert.equal(polity?.label, 'Indian Constitution and Polity');
    assert.equal(polity?.syllabusSlug, 'gs2-fundamental-rights');
    assert.deepEqual(polity?.syllabusSlugs, ['gs2-fundamental-rights', 'gs2-dpsp']);
    assert.equal(polity?.count, 7);
    assert.match(polity?.reason ?? '', /lowest accuracy/);
  });

  it('carries the exclusion list through under the name the app uses', () => {
    // The quiet half of the original break. A misnamed exclusion list does not
    // fail — the server answers 200 and regenerates questions already banked,
    // billing for every one of them.
    const parsed = accept(appRequest());
    assert.deepEqual(parsed.excludeStemHashes, ['9c1f2ab0', '4d7e8f21']);
  });

  it('defaults the generation register when the app does not send one', () => {
    // The app has no per-section difficulty concept: its own `Difficulty` type
    // describes a BANKED question's drill difficulty, which is a different
    // thing from the register a prompt writes in.
    assert.equal(accept(appRequest()).difficulty, 'standard');
  });

  it('accepts an explicit register, so a later planner can vary it', () => {
    assert.equal(accept(appRequest({ difficulty: 'challenging' })).difficulty, 'challenging');
  });

  it('echoes the client`s prompt cohort without comparing it', () => {
    // Two versions on purpose: this one is what the CLIENT believes it asked
    // for, and the server computes its own from its prompt files' hashes.
    // Comparing them would make a server prompt edit a total client outage.
    assert.equal(accept(appRequest()).promptVersion, 'mcq-prelims-v1');
    assert.equal(accept(appRequest({ promptVersion: 'anything-at-all' })).promptVersion, 'anything-at-all');
  });

  it('ignores the one field the app sends and this server does not read', () => {
    assert.equal('resume' in accept(appRequest()), false);
  });
});

describe('the batch total, which both sides compute', () => {
  it('refuses a batchSize that disagrees with its own section counts', () => {
    // Checked rather than reconciled. The app's planner documents that its
    // quotas "sum to exactly batchSize after rounding reconciliation", so a
    // disagreement is a bug in that arithmetic — and silently trusting one of
    // the two numbers would bill for one batch size and deliver another.
    const parsed = parseMcqBody(appRequest({ batchSize: 20 }));
    assert.equal(typeof parsed, 'string');
    assert.match(String(parsed), /does not equal the sum of section counts/);
  });

  it('derives the total when the app omits it', () => {
    const body = appRequest();
    delete body.batchSize;
    assert.equal(accept(body).batchSize, 12);
  });

  it('holds the BATCH to the model-call floor, not each section', () => {
    // `MIN_COUNT` asks whether a request is worth two model calls. A quota of
    // three inside a batch of twelve is a legitimate plan, and holding every
    // section to five would force the planner to lie about its own quotas.
    const parsed = accept(
      appRequest({
        batchSize: 12,
        sections: [
          { sectionKey: 'a', syllabusSlug: 'a1', syllabusSlugs: ['a1'], paper: 'gs1', label: 'A', count: 3, reason: '' },
          { sectionKey: 'b', syllabusSlug: 'b1', syllabusSlugs: ['b1'], paper: 'gs2', label: 'B', count: 4, reason: '' },
          { sectionKey: 'c', syllabusSlug: 'c1', syllabusSlugs: ['c1'], paper: 'gs3', label: 'C', count: 5, reason: '' },
        ],
      }),
    );
    assert.deepEqual(parsed.sections.map((s) => s.count), [3, 4, 5]);
  });
});

describe('section edge cases', () => {
  it('falls back to the anchor slug when the leaf list is empty', () => {
    const parsed = accept(
      appRequest({
        batchSize: 12,
        sections: [
          { sectionKey: 'a', syllabusSlug: 'anchor', syllabusSlugs: [], paper: 'gs1', label: 'A', count: 12, reason: '' },
        ],
      }),
    );
    assert.deepEqual(parsed.sections[0]?.syllabusSlugs, ['anchor']);
  });

  it('refuses a repeated sectionKey', () => {
    // Two runs against the same topic inside one batch would each carry their
    // own fact-key set, so the second cannot see what the first produced and
    // near-duplicates get through.
    const body = appRequest();
    const sections = body.sections as Record<string, unknown>[];
    const parsed = parseMcqBody(
      appRequest({ sections: [sections[0], { ...sections[0], count: 5 }], batchSize: 14 }),
    );
    assert.equal(typeof parsed, 'string');
    assert.match(String(parsed), /repeats sectionKey/);
  });

  it('refuses an empty section list rather than billing for nothing', () => {
    assert.equal(typeof parseMcqBody(appRequest({ sections: [], batchSize: 12 })), 'string');
  });

  it('refuses a flattened section list of bare strings', () => {
    // Tempting to accept, and wrong: it would let a future app version send a
    // list that silently loses every count, paper and label.
    const parsed = parseMcqBody(appRequest({ sections: ['gs2:Indian Constitution'] }));
    assert.equal(typeof parsed, 'string');
    assert.match(String(parsed), /sections\[0\] must be an object/);
  });
});
