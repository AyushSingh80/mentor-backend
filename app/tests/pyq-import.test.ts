/**
 * The past-paper import planner.
 *
 * Every test here is about a way the import could destroy something she cannot
 * get back: an answer key rewritten without re-scoring the attempts made under
 * it, a question she disputed silently returned to circulation, a row deleted
 * along with its whole history.
 *
 * The planner is pure precisely so those decisions are testable without a
 * database. `db/pyq.ts` executes and decides nothing, and cannot be tested at
 * all — it imports `@/db/*` and does not load under Node. That is the expected
 * split, not a gap.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PYQ_IMPORT_DISPUTE_REASON,
  planIsEmpty,
  planPyqImport,
  rescoreAttempt,
  stemFingerprint,
  type ExistingPyqMcq,
  type PyqImportContext,
} from '../src/lib/pyq-import';
import { pyqExternalId, type PyqDataset, type PyqMcq, type PyqSet } from '../src/data/pyq/types';

const EXAM = 'prelims-gs1' as const;
const YEAR = 2023;
const BOOKLET = 'a' as const;

function id(number: number): string {
  return pyqExternalId(EXAM, YEAR, BOOKLET, number);
}

function mcq(number: number, overrides: Partial<PyqMcq> = {}): PyqMcq {
  return {
    number,
    stem: `Consider the following statements about topic ${number}.`,
    options: ['1 only', '2 only', 'Both 1 and 2', 'Neither 1 nor 2'],
    correctIndex: 0,
    eliminationLogic: null,
    difficulty: 'medium',
    syllabusSlug: null,
    ...overrides,
  };
}

function set(overrides: Partial<PyqSet> = {}): PyqSet {
  return {
    exam: EXAM,
    year: YEAR,
    booklet: BOOKLET,
    verification: {
      verifiedBy: 'SD',
      verifiedOn: '2026-09-08',
      keySource: 'upsc_official',
      sourceUrl: 'https://upsc.gov.in/examinations/previous-question-papers',
      note: null,
    },
    mcqs: [mcq(1)],
    written: [],
    dropped: [],
    ...overrides,
  };
}

function dataset(overrides: Partial<PyqDataset> = {}): PyqDataset {
  return { version: 1, sets: [set()], renames: [], ...overrides };
}

function existing(number: number, overrides: Partial<ExistingPyqMcq> = {}): ExistingPyqMcq {
  const source = mcq(number);
  return {
    id: 1000 + number,
    externalId: id(number),
    stem: source.stem,
    options: source.options,
    correctIndex: source.correctIndex,
    eliminationLogic: null,
    difficulty: 'medium',
    syllabusTopicId: null,
    pyqYear: YEAR,
    pyqPaper: 'Prelims GS Paper I',
    disputedAt: null,
    disputeReason: null,
    disputeNote: null,
    disputeResolvedAt: null,
    ...overrides,
  };
}

function context(overrides: Partial<PyqImportContext> = {}): PyqImportContext {
  return {
    existingMcqs: [],
    existingDrills: [],
    generatedStems: [],
    topicIdBySlug: new Map(),
    ...overrides,
  };
}

describe('the shape of the plan', () => {
  it('has no way to express a delete', () => {
    // Structural, not behavioural, and that is the point. `mcq_attempts` and
    // `mcq_review_queue` cascade from `mcq_questions`: a delete would not
    // remove a question, it would remove her record of having answered it.
    // Asserting on the KEYS means no future edit can add a delete path without
    // this failing.
    const plan = planPyqImport(context(), dataset());
    assert.ok(!Object.keys(plan).includes('delete'));
    assert.ok(!Object.keys(plan).includes('remove'));
    assert.deepEqual(Object.keys(plan).sort(), [
      'insert',
      'quarantine',
      'recodeKey',
      'rejected',
      'renameExternalId',
      'supersede',
      'unchanged',
      'unquarantine',
      'update',
    ]);
  });

  it('an update carries no field that could rewrite a key', () => {
    // The same device `SeedPlan.update` uses: the type has nothing to name.
    const changed = set({ mcqs: [mcq(1, { stem: 'A different stem entirely.' })] });
    const plan = planPyqImport(
      context({ existingMcqs: [existing(1)] }),
      dataset({ sets: [changed] }),
    );

    assert.equal(plan.update.length, 1);
    const fields = plan.update[0]!.fields as unknown as Record<string, unknown>;
    assert.ok(!('correctIndex' in fields), 'an update must not be able to move the key');
    assert.ok(!('options' in fields), 'nor reorder the options the key indexes into');
  });
});

describe('steady state', () => {
  it('emits nothing when the dataset matches what is stored', () => {
    // A launch that writes nothing does not churn every `useLiveQuery` in the
    // app. This is the path taken on almost every cold start.
    const plan = planPyqImport(context({ existingMcqs: [existing(1)] }), dataset());
    assert.ok(planIsEmpty(plan), JSON.stringify(plan));
    assert.equal(plan.unchanged, 1);
  });
});

describe('a corrected answer key', () => {
  it('produces recodeKey, never update', () => {
    const corrected = set({ mcqs: [mcq(1, { correctIndex: 2 })] });
    const plan = planPyqImport(
      context({ existingMcqs: [existing(1)] }),
      dataset({ sets: [corrected] }),
    );

    assert.equal(plan.recodeKey.length, 1);
    assert.equal(plan.recodeKey[0]?.correctIndex, 2);
    assert.equal(plan.recodeKey[0]?.id, 1001);
    assert.equal(plan.update.length, 0, 'a key move must not travel as a content update');
  });

  it('carries the options with the key', () => {
    // The key is an index INTO the options. A booklet correction can reorder
    // them and move the index together; applying one without the other leaves a
    // moment with a wrong answer in it.
    const reordered = set({
      mcqs: [mcq(1, { options: ['Both 1 and 2', '1 only', '2 only', 'Neither 1 nor 2'] })],
    });
    const plan = planPyqImport(
      context({ existingMcqs: [existing(1)] }),
      dataset({ sets: [reordered] }),
    );
    assert.equal(plan.recodeKey.length, 1);
    assert.equal(plan.recodeKey[0]?.options[0], 'Both 1 and 2');
  });
});

describe('rescoreAttempt', () => {
  it('leaves a skip a skip', () => {
    // She declined to answer. No correction can turn that into a recall, and
    // scoring it as one would inflate `lastCorrectAt` and hide a weak topic.
    assert.equal(rescoreAttempt(null, 2), false);
  });

  it('marks her right when the corrected key agrees with what she chose', () => {
    // The whole reason a key correction re-scores: `mcq_attempts.correct` drives
    // `mcqWeakTopics`, `lastCorrectAt` and selection tier 4. Left stale, the app
    // keeps calling her wrong for having been right.
    assert.equal(rescoreAttempt(2, 2), true);
    assert.equal(rescoreAttempt(1, 2), false);
  });
});

describe('withdrawal', () => {
  it('quarantines what the dataset no longer claims', () => {
    const plan = planPyqImport(
      context({ existingMcqs: [existing(1), existing(99)] }),
      dataset(),
    );
    assert.equal(plan.quarantine.length, 1);
    assert.equal(plan.quarantine[0]?.id, 1099);
  });

  it('never re-stamps a question SHE disputed', () => {
    // Her dispute note is the only thing distinguishing "she raised this" from
    // "the importer withdrew it". Overwriting it would make her dispute
    // indistinguishable from an import artefact, and the next revision would
    // silently return the question to circulation.
    const hers = existing(99, {
      disputedAt: '2026-08-01T00:00:00.000Z',
      disputeReason: 'wrong_key',
      disputeNote: 'The key contradicts the NCERT.',
    });
    const plan = planPyqImport(context({ existingMcqs: [existing(1), hers] }), dataset());
    assert.equal(plan.quarantine.length, 0);
  });
});

describe('returning a question to circulation', () => {
  it('restores one a previous import withdrew', () => {
    const withdrawn = existing(1, {
      disputedAt: '2026-08-01T00:00:00.000Z',
      disputeReason: PYQ_IMPORT_DISPUTE_REASON,
      disputeNote: 'withdrawn in dataset v0',
    });
    const plan = planPyqImport(context({ existingMcqs: [withdrawn] }), dataset());
    assert.equal(plan.unquarantine.length, 1);
    assert.equal(plan.unquarantine[0]?.id, 1001);
  });

  it('NEVER restores one she disputed herself', () => {
    // `disputeQuestion` promises a disputed question stops being served
    // immediately. A background import undoing that would break the promise
    // with no error anywhere — the most dangerous single behaviour in this file.
    const hers = existing(1, {
      disputedAt: '2026-08-01T00:00:00.000Z',
      disputeReason: 'wrong_key',
      disputeNote: 'The key contradicts the NCERT.',
    });
    const plan = planPyqImport(context({ existingMcqs: [hers] }), dataset());
    assert.equal(plan.unquarantine.length, 0);
  });

  it('does not restore one whose dispute she already resolved', () => {
    const resolved = existing(1, {
      disputedAt: '2026-08-01T00:00:00.000Z',
      disputeReason: PYQ_IMPORT_DISPUTE_REASON,
      disputeResolvedAt: '2026-08-02T00:00:00.000Z',
    });
    const plan = planPyqImport(context({ existingMcqs: [resolved] }), dataset());
    assert.equal(plan.unquarantine.length, 0);
  });
});

describe('refusals', () => {
  it('refuses an entire unverified set', () => {
    // The structural teeth behind "never ship a paper nobody checked". Whole
    // set, so it cannot be defeated by someone forgetting one question.
    const unverified = set({ verification: null, mcqs: [mcq(1), mcq(2), mcq(3)] });
    const plan = planPyqImport(context(), dataset({ sets: [unverified] }));

    assert.equal(plan.insert.length, 0);
    assert.equal(plan.rejected.length, 3);
    assert.ok(plan.rejected.every((entry) => entry.reason === 'unverified_set'));
  });

  it('takes the first of a duplicated id and rejects the rest', () => {
    // Matching `planSeed`. A repeat would otherwise overwrite the first with
    // the second's answer key, which is the silent key-corrupting case.
    const dupes = set({ mcqs: [mcq(1, { correctIndex: 0 }), mcq(1, { correctIndex: 3 })] });
    const plan = planPyqImport(context(), dataset({ sets: [dupes] }));

    assert.equal(plan.insert.length, 1);
    assert.equal(
      (plan.insert[0] as { row: { correctIndex: number } }).row.correctIndex,
      0,
      'first wins',
    );
    assert.equal(plan.rejected[0]?.reason, 'duplicate_external_id');
  });

  it('refuses a malformed question rather than banking it', () => {
    const cases: [Partial<PyqMcq>, string][] = [
      [{ options: ['a', 'b', 'c'] }, 'option_count'],
      [{ options: ['a', '', 'c', 'd'] }, 'empty_option'],
      [{ options: ['a', 'a', 'c', 'd'] }, 'duplicate_option'],
      [{ correctIndex: 9 }, 'correct_index'],
      [{ stem: '   ' }, 'empty_stem'],
    ];
    for (const [override, reason] of cases) {
      const plan = planPyqImport(context(), dataset({ sets: [set({ mcqs: [mcq(1, override)] })] }));
      assert.equal(plan.insert.length, 0, reason);
      assert.equal(plan.rejected[0]?.reason, reason);
    }
  });
});

describe('superseding a generated twin', () => {
  it('withdraws the generated question a real paper duplicates', () => {
    // UPSC's key beats a model's, and this is the one place the app can act on
    // that without asking.
    const fingerprint = stemFingerprint(mcq(1).stem);
    const plan = planPyqImport(
      context({ generatedStems: [{ id: 55, stemFingerprint: fingerprint, quarantined: false }] }),
      dataset(),
    );

    assert.equal(plan.supersede.length, 1);
    assert.equal(plan.supersede[0]?.questionId, 55);
    assert.equal(plan.insert.length, 1, 'the past question is still banked');
  });

  it('does not supersede an already-quarantined generated question', () => {
    const fingerprint = stemFingerprint(mcq(1).stem);
    const plan = planPyqImport(
      context({ generatedStems: [{ id: 55, stemFingerprint: fingerprint, quarantined: true }] }),
      dataset(),
    );
    assert.equal(plan.supersede.length, 0);
  });
});

describe('syllabus tagging', () => {
  it('imports untagged rather than guessing when the slug is unknown', () => {
    // Mirrors `mcq-generate-map.ts`: an unknown slug leaves the question
    // unattributed and still drillable. The question is good; it simply does
    // not aim.
    const tagged = set({ mcqs: [mcq(1, { syllabusSlug: 'gs2-polity-nonexistent' })] });
    const plan = planPyqImport(context(), dataset({ sets: [tagged] }));

    assert.equal(plan.insert.length, 1);
    assert.equal((plan.insert[0] as { row: { syllabusTopicId: number | null } }).row.syllabusTopicId, null);
  });

  it('resolves a slug it knows', () => {
    const tagged = set({ mcqs: [mcq(1, { syllabusSlug: 'gs2-polity-federalism' })] });
    const plan = planPyqImport(
      context({ topicIdBySlug: new Map([['gs2-polity-federalism', 42]]) }),
      dataset({ sets: [tagged] }),
    );
    assert.equal((plan.insert[0] as { row: { syllabusTopicId: number | null } }).row.syllabusTopicId, 42);
  });
});
