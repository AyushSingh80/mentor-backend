/**
 * The contract guard.
 *
 * `mcq-generate-map` is the last thing standing between a model's output and a
 * question rendered on a train with no signal and no way to report it. Its two
 * jobs pull in opposite directions and both are tested here:
 *
 * - REJECT anything that would render broken or teach a falsehood. Three
 *   options render a hole in the answer pad; a `correctIndex` of 4 marks every
 *   attempt wrong forever, under negative marking; a question with no
 *   elimination logic is a scoring event rather than a drill.
 * - ACCEPT everything else, including a question whose syllabus slug this build
 *   has never heard of. The app ships its syllabus as seed data and the server
 *   can be a revision ahead; if an unknown slug rejected the question, one
 *   syllabus correction on the server would become a total bank outage on the
 *   device — an offline failure caused by being online.
 *
 * And it must never throw. It runs inside a streaming read loop on a
 * fire-and-forget path, so an exception would abandon the rest of the stream
 * and discard every question already banked in the batch.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createBatchMapper,
  mapGeneratedBatch,
  mapGeneratedQuestion,
  type MapContext,
} from '../src/lib/mcq-generate-map';
import { stemFingerprint } from '../src/lib/mcq-bank';
import { OPTION_COUNT } from '../src/lib/mcq-types';

/* ------------------------------------------------------------------ helpers */

function context(overrides: Partial<MapContext> = {}): MapContext {
  return {
    topicIdBySlug: new Map([
      ['gs1-modern-history-1857', 41],
      ['gs2-polity-fr', 77],
    ]),
    knownFingerprints: new Set<string>(),
    batchId: 'batch-abc',
    promptVersion: 'mcq-prelims-v1',
    ...overrides,
  };
}

let counter = 0;

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  counter += 1;
  return {
    stem: `Which of the following statements about topic ${counter} is correct?`,
    options: ['Only 1', 'Only 2', 'Both 1 and 2', 'Neither 1 nor 2'],
    correctIndex: 2,
    eliminationLogic: 'Statement 1 fails because ...; statement 2 fails because ...',
    difficulty: 'medium',
    source: 'generated',
    syllabusSlug: 'gs1-modern-history-1857',
    externalId: `ext-${counter}`,
    ...overrides,
  };
}

/* ---------------------------------------------------------------- rejection */

describe('mapGeneratedQuestion — what must never reach the bank', () => {
  it('rejects three options', () => {
    const outcome = mapGeneratedQuestion(
      payload({ options: ['Only 1', 'Only 2', 'Both'] }),
      context(),
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'option_count');
    assert.match(outcome.detail, new RegExp(`Expected ${OPTION_COUNT} options, got 3`));
  });

  it('rejects five options', () => {
    const outcome = mapGeneratedQuestion(
      payload({ options: ['a', 'b', 'c', 'd', 'e'] }),
      context(),
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'option_count');
  });

  it('rejects a correctIndex of 4', () => {
    // One past the end. Under negative marking this marks every attempt wrong,
    // forever, and spaced repetition then drills the falsehood to mastery.
    const outcome = mapGeneratedQuestion(payload({ correctIndex: 4 }), context());
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'correct_index');
  });

  it('rejects a correctIndex of −1', () => {
    const outcome = mapGeneratedQuestion(payload({ correctIndex: -1 }), context());
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'correct_index');
  });

  it('rejects a missing or non-integer correctIndex', () => {
    for (const value of [undefined, null, 1.5, 'two', {}]) {
      const outcome = mapGeneratedQuestion(payload({ correctIndex: value }), context());
      assert.equal(outcome.ok, false, `correctIndex ${String(value)} must be rejected`);
      assert.equal(outcome.reason, 'correct_index');
    }
  });

  it('rejects empty elimination logic', () => {
    for (const value of ['', '   ', null, undefined, 42]) {
      const outcome = mapGeneratedQuestion(payload({ eliminationLogic: value }), context());
      assert.equal(outcome.ok, false, `eliminationLogic ${String(value)} must be rejected`);
      assert.equal(outcome.reason, 'empty_elimination_logic');
    }
  });

  it('rejects a blank stem and a blank option', () => {
    const blankStem = mapGeneratedQuestion(payload({ stem: '  ' }), context());
    assert.equal(blankStem.ok, false);
    assert.equal(blankStem.reason, 'empty_stem');

    const blankOption = mapGeneratedQuestion(payload({ options: ['a', '', 'c', 'd'] }), context());
    assert.equal(blankOption.ok, false);
    assert.equal(blankOption.reason, 'empty_option');
  });

  it('rejects two identical options', () => {
    // Unanswerable and undetectable on screen: whichever of the two she taps,
    // one of two identical strings is marked wrong.
    const outcome = mapGeneratedQuestion(
      payload({ options: ['Only 1', 'Only 1', 'Both', 'Neither'] }),
      context(),
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'duplicate_option');
  });

  it('rejects a past-question claim with no year', () => {
    // Provenance is on screen and it is what makes "this looks wrong" a
    // reasonable thing to tap. A pyq claim with no year cannot be shown
    // honestly in either direction.
    const outcome = mapGeneratedQuestion(payload({ source: 'pyq' }), context());
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'pyq_without_year');
  });
});

/* ---------------------------------------------------------------- tolerance */

describe('mapGeneratedQuestion — what must NOT become an outage', () => {
  it('resolves an unknown slug to syllabusTopicId null rather than rejecting', () => {
    const outcome = mapGeneratedQuestion(
      payload({ syllabusSlug: 'gs1-a-topic-this-build-has-never-heard-of' }),
      context(),
    );

    assert.equal(outcome.ok, true);
    assert.equal(outcome.question.syllabusTopicId, null);
    assert.equal(
      outcome.question.syllabusSlug,
      'gs1-a-topic-this-build-has-never-heard-of',
      'the slug is kept for the record even though it did not resolve',
    );
  });

  it('resolves a known slug to its topic id', () => {
    const outcome = mapGeneratedQuestion(payload(), context());
    assert.equal(outcome.ok, true);
    assert.equal(outcome.question.syllabusTopicId, 41);
  });

  it('accepts a question with no slug at all', () => {
    const outcome = mapGeneratedQuestion(payload({ syllabusSlug: undefined }), context());
    assert.equal(outcome.ok, true);
    assert.equal(outcome.question.syllabusTopicId, null);
    assert.equal(outcome.question.syllabusSlug, null);
  });

  it('defaults an unrecognised difficulty instead of rejecting', () => {
    // Cosmetic: it changes a label, not the key.
    const outcome = mapGeneratedQuestion(payload({ difficulty: 'brutal' }), context());
    assert.equal(outcome.ok, true);
    assert.equal(outcome.question.difficulty, 'medium');
  });

  it('accepts the field aliases the server has actually used', () => {
    const outcome = mapGeneratedQuestion(
      {
        question: 'Which of the following is correct?',
        choices: ['a', 'b', 'c', 'd'],
        answerIndex: 1,
        elimination: 'b is right because ...',
        factKey: 'fact-9',
      },
      context(),
    );

    assert.equal(outcome.ok, true);
    assert.equal(outcome.question.correctIndex, 1);
    assert.equal(
      outcome.question.externalId,
      'fact-9',
      'factKey and externalId are the same handle under two names',
    );
  });

  it('carries batch and prompt provenance onto every row', () => {
    const outcome = mapGeneratedQuestion(payload(), context());
    assert.equal(outcome.ok, true);
    assert.equal(outcome.question.batchId, 'batch-abc');
    assert.equal(outcome.question.promptVersion, 'mcq-prelims-v1');
    assert.equal(outcome.question.stemFingerprint.length, 16);
  });

  it('keeps a past question with a year, and its provenance', () => {
    const outcome = mapGeneratedQuestion(
      payload({ source: 'pyq', pyqYear: 2019, pyqPaper: 'GS Paper I' }),
      context(),
    );
    assert.equal(outcome.ok, true);
    assert.equal(outcome.question.source, 'pyq');
    assert.equal(outcome.question.pyqYear, 2019);
    assert.equal(outcome.question.pyqPaper, 'GS Paper I');
  });

  it('does not leave pyq fields on a generated question', () => {
    const outcome = mapGeneratedQuestion(payload({ pyqYear: 2019, pyqPaper: 'GS1' }), context());
    assert.equal(outcome.ok, true);
    assert.equal(outcome.question.pyqYear, null);
    assert.equal(outcome.question.pyqPaper, null);
  });
});

/* --------------------------------------------------------------- duplicates */

describe('duplicate suppression', () => {
  it('rejects a stem already in the bank and counts it', () => {
    const stem = 'Which of the following statements about the Doctrine of Lapse is correct?';
    const ctx = context({ knownFingerprints: new Set([stemFingerprint(stem)]) });

    // Same question, different punctuation and case — exactly what slips past
    // the server's exclude list.
    const result = mapGeneratedBatch(
      [payload({ stem: '  WHICH of the following statements about the doctrine of lapse is correct  ' })],
      ctx,
    );

    assert.equal(result.accepted.length, 0);
    assert.equal(result.duplicates, 1);
    assert.equal(result.rejected[0]?.reason, 'duplicate_stem');
  });

  it('rejects a stem repeated within one batch', () => {
    const stem = 'Consider the following statements about the Fundamental Rights.';
    const result = mapGeneratedBatch(
      [payload({ stem }), payload({ stem: stem.toUpperCase() })],
      context(),
    );

    assert.equal(result.accepted.length, 1);
    assert.equal(result.duplicates, 1);
  });

  it('does not treat two genuine paraphrases as duplicates', () => {
    const result = mapGeneratedBatch(
      [
        payload({ stem: 'Which of the following is NOT a fundamental right?' }),
        payload({ stem: 'Which of the following IS a fundamental right?' }),
      ],
      context(),
    );

    assert.equal(result.accepted.length, 2, 'a false duplicate is silent data loss');
    assert.equal(result.duplicates, 0);
  });
});

/* -------------------------------------------------------------- malformation */

describe('malformed payloads never throw', () => {
  it('returns an empty accepted list for a wholly malformed payload', () => {
    for (const bad of [null, undefined, 42, 'a string', { questions: [] }, true]) {
      const result = mapGeneratedBatch(bad, context());
      assert.deepEqual(result.accepted, [], `${String(bad)} must produce no accepted questions`);
      assert.ok(result.rejected.length > 0, 'and must say why');
      assert.equal(result.rejected[0]?.reason, 'not_an_object');
    }
  });

  it('rejects non-object entries inside an otherwise valid array', () => {
    const result = mapGeneratedBatch([null, payload(), 7, [], payload()], context());
    assert.equal(result.accepted.length, 2);
    assert.equal(result.rejected.length, 3);
    for (const entry of result.rejected) assert.equal(entry.reason, 'not_an_object');
  });

  it('reports the index of each rejection so a bad cohort is traceable', () => {
    const result = mapGeneratedBatch(
      [payload(), payload({ correctIndex: 9 }), payload(), payload({ options: ['a'] })],
      context(),
    );
    assert.deepEqual(
      result.rejected.map((entry) => entry.index),
      [1, 3],
    );
  });

  it('never puts a whole payload into a rejection detail', () => {
    const secretive = payload({
      correctIndex: 9,
      stem: 'x'.repeat(500),
    });
    const result = mapGeneratedBatch([secretive], context());
    assert.ok((result.rejected[0]?.detail.length ?? 0) < 200);
  });
});

/* ------------------------------------------------------------- the streaming */

describe('createBatchMapper — the streaming path', () => {
  it('accepts questions one at a time and accumulates the tally', () => {
    const mapper = createBatchMapper(context());

    const first = mapper.accept(payload());
    const second = mapper.accept(payload({ correctIndex: 4 }));
    const third = mapper.accept(payload({ syllabusSlug: 'unknown-slug' }));

    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(third.ok, true);

    const result = mapper.result();
    assert.equal(result.accepted.length, 2);
    assert.equal(result.rejected.length, 1);
    assert.deepEqual(result.unknownSlugs, ['unknown-slug']);
  });

  it('is a short batch, not an error, when most of a batch is rejected', () => {
    const mapper = createBatchMapper(context());
    for (let i = 0; i < 6; i += 1) mapper.accept(payload({ eliminationLogic: '' }));
    mapper.accept(payload());

    const result = mapper.result();
    assert.equal(result.accepted.length, 1);
    assert.equal(result.rejected.length, 6);
  });

  it('does not report a resolved slug as unknown', () => {
    const mapper = createBatchMapper(context());
    mapper.accept(payload({ syllabusSlug: 'gs2-polity-fr' }));
    assert.deepEqual(mapper.result().unknownSlugs, []);
  });

  it('snapshots its result rather than handing out live arrays', () => {
    const mapper = createBatchMapper(context());
    mapper.accept(payload());
    const before = mapper.result();
    mapper.accept(payload());

    assert.equal(before.accepted.length, 1, 'an earlier result must not mutate underneath a caller');
    assert.equal(mapper.result().accepted.length, 2);
  });
});
