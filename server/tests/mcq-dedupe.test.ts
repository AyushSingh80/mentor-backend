/**
 * Duplicate detection. Pure, so this is where the coverage goes.
 *
 * The failure this guards is slow rather than dramatic: without it the bank
 * fills with the same twelve facts asked forty ways, and every review slot
 * spent on a repeat is a slot not spent on something she does not know.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.ANTHROPIC_API_KEY ??= 'sk-ant-test-not-real';
process.env.MODEL_EVALUATION ??= 'eval-model-1';
process.env.MODEL_BULK ??= 'bulk-model-1';
process.env.APP_BEARER_TOKEN ??= 'test-token';

const {
  SIMHASH_MAX_DISTANCE,
  hammingDistance,
  hash64,
  normaliseFactKey,
  normaliseStem,
  shingles,
  simHash64,
  simHashFromHex,
  simHashHex,
  stemHash,
} = await import('../src/mcq/dedupe.js');
const { BankIndex } = await import('../src/mcq/bank-index.js');

describe('normaliseStem', () => {
  it('collapses case, punctuation and whitespace', () => {
    assert.equal(
      normaliseStem('  Consider   the following STATEMENTS, regarding Article 368: '),
      'consider the following statements regarding article 368',
    );
  });

  it('strips the [SAMPLE] marker so a fake and a real stem hash alike', () => {
    // Otherwise `dev:fake` could never reproduce a real duplication bug.
    assert.equal(normaliseStem('[SAMPLE] Consider the following'), 'consider the following');
    assert.equal(
      stemHash('[SAMPLE] Consider the following'),
      stemHash('Consider the following'),
    );
  });

  it('ignores diacritics', () => {
    assert.equal(normaliseStem('Sāmkhya'), normaliseStem('Samkhya'));
  });
});

describe('stemHash', () => {
  it('is stable, 16 hex chars, and insensitive to formatting', () => {
    const a = stemHash('Consider the following statements.');
    assert.match(a, /^[0-9a-f]{16}$/);
    assert.equal(a, stemHash('  consider   the following   STATEMENTS!  '));
  });

  it('differs for genuinely different stems', () => {
    assert.notEqual(stemHash('Statements about Article 368'), stemHash('Statements about GST'));
  });
});

describe('normaliseFactKey', () => {
  it('folds the spellings a model actually produces into one key', () => {
    assert.equal(normaliseFactKey('Polity:Article 368'), 'polity:article-368');
    assert.equal(normaliseFactKey('  polity:article_368  '), 'polity:article-368');
    assert.equal(normaliseFactKey('polity:article--368'), 'polity:article-368');
  });
});

describe('SimHash', () => {
  it('hashes tokens into a 64-bit space', () => {
    assert.ok(hash64('article') < 1n << 64n);
    assert.notEqual(hash64('article'), hash64('articles'));
  });

  it('builds word trigrams, falling back to words for short text', () => {
    assert.deepEqual(shingles('a b c d'), ['a b c', 'b c d']);
    assert.deepEqual(shingles('a b'), ['a', 'b']);
    assert.deepEqual(shingles(''), []);
  });

  it('round-trips through hex', () => {
    const value = simHash64('Consider the following statements regarding the Finance Commission');
    assert.match(simHashHex(value), /^[0-9a-f]{16}$/);
    assert.equal(simHashFromHex(simHashHex(value)), value);
  });

  const BASE =
    'Consider the following statements regarding the composition of the Finance Commission and the constitutional basis on which it rests';

  it('puts a light rewording inside the threshold', () => {
    const reworded =
      'Consider the following statements regarding the composition of a Finance Commission and the constitutional basis on which it rests';
    assert.ok(
      hammingDistance(simHash64(BASE), simHash64(reworded)) <= SIMHASH_MAX_DISTANCE,
      `measured ${hammingDistance(simHash64(BASE), simHash64(reworded))}`,
    );
  });

  it('puts an unrelated topic far outside it', () => {
    const unrelated =
      'Consider the following statements about the monsoon circulation over the Bay of Bengal and its onset over Kerala';
    assert.ok(
      hammingDistance(simHash64(BASE), simHash64(unrelated)) > SIMHASH_MAX_DISTANCE,
      `measured ${hammingDistance(simHash64(BASE), simHash64(unrelated))}`,
    );
  });

  it('is a backstop, not the primary mechanism — a real rewording escapes it', () => {
    // Documents the limit deliberately rather than papering over it. Swapping
    // two function words already exceeds Hamming 6, which is precisely why
    // factKey is the mechanism that carries dedup over eighteen months and
    // SimHash is only the net underneath it.
    const reworded =
      'Consider the following statements regarding the composition of the Finance Commission and its constitutional basis on which it rests';
    assert.ok(hammingDistance(simHash64(BASE), simHash64(reworded)) > SIMHASH_MAX_DISTANCE);
  });

  it('counts set bits, not values', () => {
    assert.equal(hammingDistance(0n, 0n), 0);
    assert.equal(hammingDistance(0b1011n, 0b1000n), 2);
  });
});

describe('BankIndex', () => {
  const q = (stem: string, factKey: string) => ({ stem, factKey });

  it('finds nothing in an empty index', () => {
    assert.equal(new BankIndex().find(q('A brand new stem', 'polity:new')), null);
  });

  it('catches a factKey the phone already holds, however it is spelled', () => {
    // The mechanism that still works after eighteen months. Lexical similarity
    // does not: "statements about Article 368" and "the amendment procedure"
    // share almost no tokens and are the same question.
    const index = new BankIndex({ factKeys: ['Polity:Article 368'] });
    const hit = index.find(
      q('Consider the following statements about the amendment procedure.', 'polity:article_368'),
    );
    assert.equal(hit?.kind, 'duplicate_fact');
  });

  it('catches an identical stem the phone already holds', () => {
    const stem = 'Consider the following statements regarding the Finance Commission.';
    const index = new BankIndex({ stemHashes: [stemHash(stem)] });
    assert.equal(index.find(q(stem, 'a-completely-different-key'))?.kind, 'duplicate_stem');
  });

  it('catches a near-duplicate by SimHash when the stem hash and factKey both miss', () => {
    const index = new BankIndex();
    index.add(
      q(
        'Consider the following statements regarding the composition of the Finance Commission and the constitutional basis on which it rests',
        'polity:fc:composition',
      ),
    );
    const nearly =
      'Consider the following statements regarding the composition of a Finance Commission and the constitutional basis on which it rests';
    // Different stem hash, different factKey: SimHash is the only thing left.
    assert.notEqual(
      stemHash(nearly),
      stemHash(
        'Consider the following statements regarding the composition of the Finance Commission and the constitutional basis on which it rests',
      ),
    );
    assert.equal(index.find(q(nearly, 'polity:fc:composition-alt'))?.kind, 'near_duplicate');
  });

  it('reports the cheapest signal first', () => {
    // factKey before stem hash before SimHash: a hit on the cheap check must
    // not pay for the expensive one.
    const stem = 'Consider the following statements regarding Article 368.';
    const index = new BankIndex({ factKeys: ['polity:368'], stemHashes: [stemHash(stem)] });
    assert.equal(index.find(q(stem, 'polity:368'))?.kind, 'duplicate_fact');
  });

  it('lets a genuinely new question through', () => {
    const index = new BankIndex();
    index.add(q('Consider the following statements regarding Article 368.', 'polity:368'));
    assert.equal(
      index.find(
        q('Consider the following statements about the monsoon over the Bay of Bengal.', 'geo:monsoon'),
      ),
      null,
    );
  });

  it('grows as the batch runs, so chunk 4 cannot repeat chunk 1', () => {
    const index = new BankIndex();
    assert.equal(index.size, 0);
    index.add(q('First question stem about something.', 'k1'));
    assert.equal(index.size, 1);
    assert.equal(index.find(q('First question stem about something.', 'k2'))?.kind, 'duplicate_stem');
  });

  it('survives a malformed simHash seed rather than failing the request', () => {
    // A dropped seed only weakens dedup; a thrown error loses the whole batch.
    const index = new BankIndex({ simHashes: ['not-hex', 'zzzz'] });
    assert.equal(index.find(q('Anything at all here', 'k'))?.kind, undefined);
  });

  it('ignores blank seed entries', () => {
    const index = new BankIndex({ factKeys: ['', '   '], stemHashes: ['', '  '] });
    assert.equal(index.find(q('Some stem', 'some-key')), null);
  });
});
