/**
 * Choosing which stored material to surface for a drill.
 *
 * The property that matters, and the one that reads as a bug until you know
 * why: use count sorts ASCENDING. A quote used in four essays is one she
 * reaches for automatically; the bank exists to surface the one she has
 * forgotten she has. Every "most relevant first" instinct here is wrong.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bankDiagnosis, suggestMaterial, tallyByKind } from '../src/lib/material';
import { DRILL_RULES, type MaterialFacts, type MaterialKind } from '../src/lib/drill-types';

let nextId = 0;
function material(overrides: Partial<MaterialFacts> = {}): MaterialFacts {
  nextId += 1;
  return {
    id: nextId,
    kind: 'quote',
    content: `material ${nextId}`,
    attribution: null,
    sourceNote: null,
    syllabusTopicId: null,
    caItemId: null,
    timesUsed: 0,
    lastUsedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

const CTX = { syllabusTopicId: 10, siblingTopicIds: [10, 11, 12] };

/* -------------------------------------------------------------- selection */

describe('suggestMaterial', () => {
  it('puts exact-topic material first', () => {
    const bank = [
      material({ syllabusTopicId: null }),
      material({ syllabusTopicId: 11 }),
      material({ syllabusTopicId: 10 }),
    ];
    const picked = suggestMaterial(bank, CTX);
    assert.equal(picked[0]?.material.syllabusTopicId, 10);
    assert.match(picked[0]?.reason ?? '', /this exact topic/);
  });

  it('puts same-section material next', () => {
    const bank = [material({ syllabusTopicId: 99, timesUsed: 0 }), material({ syllabusTopicId: 12 })];
    const picked = suggestMaterial(bank, CTX);
    assert.equal(picked[0]?.material.syllabusTopicId, 12);
    assert.match(picked[0]?.reason ?? '', /elsewhere in this section/);
  });

  it('prefers the FORGOTTEN item within a relevance band', () => {
    // The heart of the module. Both are on-topic; the unused one wins.
    const used = material({ syllabusTopicId: 10, timesUsed: 4 });
    const unused = material({ syllabusTopicId: 10, timesUsed: 0 });
    const picked = suggestMaterial([used, unused], CTX);
    assert.equal(picked[0]?.material.id, unused.id);
  });

  it('prefers the least recently used when the counts tie', () => {
    const recent = material({ syllabusTopicId: 10, timesUsed: 2, lastUsedAt: '2026-09-06T00:00:00.000Z' });
    const stale = material({ syllabusTopicId: 10, timesUsed: 2, lastUsedAt: '2026-02-01T00:00:00.000Z' });
    const picked = suggestMaterial([recent, stale], CTX);
    assert.equal(picked[0]?.material.id, stale.id);
  });

  it('surfaces never-used untagged material above tagged material she keeps using', () => {
    // Otherwise the untagged half of the bank is never seen, and the bank is
    // quietly half the size she thinks it is.
    const usedElsewhere = material({ syllabusTopicId: 99, timesUsed: 6 });
    const forgotten = material({ syllabusTopicId: null, timesUsed: 0 });
    const picked = suggestMaterial([usedElsewhere, forgotten], CTX);
    assert.equal(picked[0]?.material.id, forgotten.id);
    assert.match(picked[0]?.reason ?? '', /never used/);
  });

  it('caps at the rule`s suggestion count', () => {
    const bank = Array.from({ length: 40 }, () => material({ syllabusTopicId: 10 }));
    assert.equal(suggestMaterial(bank, CTX).length, DRILL_RULES.materialSuggestions);
  });

  it('honours an explicit limit, including zero', () => {
    const bank = Array.from({ length: 10 }, () => material());
    assert.equal(suggestMaterial(bank, { ...CTX, limit: 2 }).length, 2);
    assert.deepEqual(suggestMaterial(bank, { ...CTX, limit: 0 }), []);
  });

  it('is deterministic — the same bank yields the same order', () => {
    // A screen re-render must never reshuffle the suggestions under her.
    const bank = [
      material({ syllabusTopicId: 10 }),
      material({ syllabusTopicId: 10 }),
      material({ syllabusTopicId: 11 }),
      material({ syllabusTopicId: null, timesUsed: 3 }),
    ];
    assert.deepEqual(
      suggestMaterial(bank, CTX).map((s) => s.material.id),
      suggestMaterial(bank, CTX).map((s) => s.material.id),
    );
  });

  it('still returns something for a drill with no resolved topic', () => {
    // An untagged drill is common early on. Returning nothing would make the
    // panel look broken rather than empty.
    const bank = [material({ timesUsed: 1 }), material({ timesUsed: 0 })];
    const picked = suggestMaterial(bank, { syllabusTopicId: null, siblingTopicIds: [] });
    assert.equal(picked.length, 2);
    assert.equal(picked[0]?.material.timesUsed, 0);
  });

  it('returns nothing for an empty bank rather than throwing', () => {
    assert.deepEqual(suggestMaterial([], CTX), []);
  });

  it('always populates a reason', () => {
    const bank = [
      material({ syllabusTopicId: 10 }),
      material({ syllabusTopicId: 11 }),
      material({ syllabusTopicId: null, timesUsed: 0 }),
      material({ syllabusTopicId: 99, timesUsed: 3 }),
    ];
    for (const suggestion of suggestMaterial(bank, CTX)) {
      assert.notEqual(suggestion.reason.trim(), '');
    }
  });
});

/* ----------------------------------------------------------------- tally */

describe('tallyByKind', () => {
  it('counts every kind, including ones with nothing in them', () => {
    const tally = tallyByKind([material({ kind: 'quote' }), material({ kind: 'quote' })]);
    assert.equal(tally.quote, 2);
    assert.equal(tally.example, 0);
    assert.equal(tally.data, 0);
  });

  it('ignores a kind this build does not know', () => {
    const tally = tallyByKind([material({ kind: 'sonnet' as MaterialKind })]);
    assert.equal(Object.values(tally).reduce((a, b) => a + b, 0), 0);
  });
});

describe('bankDiagnosis', () => {
  it('says nothing about a bank too small to diagnose', () => {
    assert.equal(bankDiagnosis(tallyByKind([material(), material()])), null);
  });

  it('flags a bank that is all quotes and thinkers', () => {
    // The rubric penalises decorative quotes explicitly, and this is the shape
    // of bank that produces them.
    const bank = [
      ...Array.from({ length: 9 }, () => material({ kind: 'quote' })),
      ...Array.from({ length: 4 }, () => material({ kind: 'thinker' })),
      material({ kind: 'example' }),
    ];
    assert.match(bankDiagnosis(tallyByKind(bank)) ?? '', /decorative/);
  });

  it('says nothing about a balanced bank', () => {
    // An app that always has an opinion is one whose opinions stop being read.
    const bank = [
      ...Array.from({ length: 5 }, () => material({ kind: 'quote' })),
      ...Array.from({ length: 5 }, () => material({ kind: 'example' })),
      ...Array.from({ length: 5 }, () => material({ kind: 'data' })),
    ];
    assert.equal(bankDiagnosis(tallyByKind(bank)), null);
  });

  it('notices a bank with no quotes at all', () => {
    const bank = Array.from({ length: 12 }, () => material({ kind: 'example' }));
    assert.match(bankDiagnosis(tallyByKind(bank)) ?? '', /No quotes yet/);
  });
});
