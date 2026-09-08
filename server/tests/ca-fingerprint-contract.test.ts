/**
 * `headlineFingerprint` — the server half of a value compared across the wire.
 *
 * Counterpart: `app/tests/ca-fingerprint-contract.test.ts`. The CONTRACT table
 * below is byte-identical to the one there, and that is the whole point: the
 * two packages are never compiled together, so a literal on each side is the
 * only thing that can catch a change made on one.
 *
 * ## Why this comparison crosses the boundary at all
 *
 * `selectItems` builds `new Set(request.seenFingerprints)` from values the
 * DEVICE computed, then tests its own freshly-computed fingerprint against it.
 * The device was sending 64-bit hashes; this function returns sorted word
 * stems. The sets could not intersect, so the cross-request duplicate rule
 * never fired once — and it failed silently, in the expensive direction: a
 * running story was re-shortlisted, re-noted (billed), and given one of the six
 * daily slots every day, after which the device discarded it on ingest.
 *
 * If you change the algorithm here, change it there in the same commit and
 * regenerate this table by RUNNING both — not by reading either.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { headlineFingerprint } from '../src/ca/select.js';

/** Byte-identical to `CONTRACT` in the app-side counterpart. */
const CONTRACT: readonly [string, string][] = [
  ['SC quashes the bonds scheme', 'bond-quash-scheme'],
  ['Bonds scheme quashed by SC', 'bond-quash-scheme'],
  ['Cabinet approves revised Forest Rights framework', 'approv-cabinet-forest-framework-revis-right'],
  ['RBI holds repo rate at 6.5% for the sixth time', 'hold-rate-rbi-repo-sixth-time'],
  ['Tribal affairs ministry notifies 3 new communities', 'affair-community-ministry-notify-tribal'],
  ['SC strikes down electoral bonds', 'bond-down-electoral-strik'],
  ['Electoral bonds struck down by SC', 'bond-down-electoral-struck'],
  ['उच्चतम न्यायालय ने चुनावी बॉन्ड योजना रद्द की', 'उच्चतम न्यायालय ने चुनावी बॉन्ड योजना रद्द की'],
  ['', ''],
];

describe('headlineFingerprint agrees with the device, headline for headline', () => {
  for (const [headline, expected] of CONTRACT) {
    it(`maps ${JSON.stringify(headline).slice(0, 52)} to ${JSON.stringify(expected).slice(0, 46)}`, () => {
      assert.equal(headlineFingerprint(headline), expected);
    });
  }
});

describe('the non-Latin fallback, which both sides must carry', () => {
  it('does not collapse two different Hindi headlines to one fingerprint', () => {
    // Without the fallback both are '' and every Hindi headline is a duplicate
    // of every other — so ONE bad `reg` parameter on the PIB feed would empty
    // a whole digest and report it as a quiet news day.
    const a = headlineFingerprint('उच्चतम न्यायालय ने चुनावी बॉन्ड योजना रद्द की');
    const b = headlineFingerprint('मंत्रिमंडल ने वन अधिकार ढांचे को मंजूरी दी');
    assert.notEqual(a, '');
    assert.notEqual(a, b);
  });

  it('still collapses whitespace and case in the fallback', () => {
    assert.equal(
      headlineFingerprint('  उच्चतम   न्यायालय  '),
      headlineFingerprint('उच्चतम न्यायालय'),
    );
  });
});

describe('what selectItems relies on', () => {
  it('matches a fingerprint the device would have sent for the same story', () => {
    // The end-to-end shape of the comparison, in one assertion: the device
    // stores a headline, computes a fingerprint from it, sends it, and this
    // server recomputes from ITS copy of the headline and must land on the
    // same string. Two outlets, two wordings, one story.
    const asStored = 'SC quashes the bonds scheme';
    const asFetchedToday = 'Bonds scheme quashed by SC';
    const seen = new Set([headlineFingerprint(asStored)]);
    assert.equal(seen.has(headlineFingerprint(asFetchedToday)), true);
  });

  it('caps at eight stems', () => {
    const long =
      'Parliament passes comprehensive amendment legislation reforming municipal ' +
      'governance financing structures across seventeen states territories nationwide';
    assert.ok(headlineFingerprint(long).split('-').length <= 8);
  });
});
