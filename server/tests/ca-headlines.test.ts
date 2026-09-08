import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildLabelIndex,
  selectHeadlines,
  tagCandidate,
  DEFAULT_MAX_AGE_DAYS,
  type HeadlineSource,
  type HeadlineVocabularyEntry,
} from '../src/ca/headlines.js';
import type { Candidate } from '../src/ca/select.js';

const TODAY = '2026-09-08';

const VOCAB: HeadlineVocabularyEntry[] = [
  { slug: 'gs2-polity-federalism', label: 'Federalism', paper: 'gs2', level: 'leaf' },
  {
    slug: 'gs2-polity-governor',
    label: 'Governor discretionary powers',
    paper: 'gs2',
    level: 'leaf',
  },
  { slug: 'gs3-economy-banking', label: 'Banking and monetary policy', paper: 'gs3', level: 'leaf' },
  { slug: 'gs1-culture-temple', label: 'Temple architecture', paper: 'gs1', level: 'leaf' },
  // Two labels sharing a broad word, so "development" carries little signal.
  { slug: 'gs1-society-development', label: 'Society and development', paper: 'gs1', level: 'leaf' },
  { slug: 'gs3-econ-development', label: 'Economic development', paper: 'gs3', level: 'leaf' },
];

const SOURCES: HeadlineSource[] = [
  { id: 'rbi_press', name: 'RBI Press Releases', papers: ['gs3'], trust: 'primary' },
  { id: 'pib_releases', name: 'PIB Press Releases', papers: ['gs2', 'gs3'], trust: 'primary' },
  {
    id: 'hindu_national',
    name: 'The Hindu — National',
    papers: ['gs1', 'gs2', 'gs3'],
    trust: 'secondary',
  },
];

function candidate(partial: Partial<Candidate> & { index: number }): Candidate {
  return {
    url: `https://example.test/${partial.index}`,
    canonicalUrl: `https://example.test/${partial.index}`,
    sourceName: 'The Hindu — National',
    headline: 'A headline',
    lede: null,
    publishedAt: `${TODAY}T06:00:00Z`,
    feedId: 'hindu_national',
    ...partial,
  };
}

describe('tagCandidate', () => {
  const index = buildLabelIndex(VOCAB);

  it('tags on a full-label match', () => {
    const tags = tagCandidate('Federalism under strain in Centre-State talks', index, ['gs2']);
    assert.ok(tags.includes('gs2-polity-federalism'));
  });

  it('refuses a tag on one incidental word of a long label', () => {
    // The case measured against the real syllabus: "government" is carried by
    // exactly ONE of 438 labels, so a rarity rule called it distinctive and an
    // RBI auction notice claimed that label. One word out of four is not what
    // the heading is about.
    const tags = tagCandidate('Auction of Government of India Dated Securities', index, ['gs2']);
    assert.ok(
      !tags.includes('gs2-polity-governor'),
      'one term of a multi-word heading must not claim it',
    );
  });

  it('requires a short label to match in full', () => {
    // "Federalism" is one word: the word is the whole heading, so it is the
    // whole requirement. "Banking and monetary policy" is three, and one of
    // them is not enough.
    assert.ok(tagCandidate('Federalism under strain', index, ['gs2']).includes(
      'gs2-polity-federalism',
    ));
    assert.ok(
      !tagCandidate('A policy announcement', index, ['gs3']).includes('gs3-economy-banking'),
    );
  });

  it('accepts a long label when at least half its terms are present', () => {
    const tags = tagCandidate('Governor discretionary powers questioned', index, ['gs2']);
    assert.ok(tags.includes('gs2-polity-governor'));

    const half = tagCandidate('Banking policy review announced', index, ['gs3']);
    assert.ok(
      half.includes('gs3-economy-banking'),
      'two of three terms of "Banking and monetary policy" is a real restatement',
    );
  });

  it('breaks a coverage tie on how many terms actually matched', () => {
    // Both labels are fully covered here. Three matched words is stronger
    // evidence than one, so the three-word heading leads — a one-word label is
    // fully covered by any headline that happens to contain that word.
    const tags = tagCandidate(
      'Banking and monetary policy shifts amid a federalism row',
      index,
      ['gs2', 'gs3'],
    );
    assert.equal(tags[0], 'gs3-economy-banking');
    assert.ok(tags.includes('gs2-polity-federalism'));
  });

  it('refuses a tag whose paper the feed does not cover', () => {
    // The words are a perfect match for the GS1 culture label. The feed only
    // covers GS3, so the tag must not be produced. This is the rule that stops
    // an RBI release being filed under Indian art.
    const tags = tagCandidate('Temple architecture grant announced', index, ['gs3']);
    assert.deepEqual(tags, []);
  });

  it('does not tag on a broad term shared across labels', () => {
    // "development" carries two of the six labels here, and the threshold at
    // this vocabulary size is one. Nothing else in the text completes either
    // label, so neither may be claimed. This is the counterpart to the
    // distinctive-term rule and the reason the threshold scales with size.
    const tags = tagCandidate('A development of some kind', index, ['gs1', 'gs3']);
    assert.deepEqual(tags, []);
  });

  it('returns nothing for text with no significant terms', () => {
    assert.deepEqual(tagCandidate('   ', index, ['gs2']), []);
  });
});

describe('selectHeadlines', () => {
  const base = { vocabulary: VOCAB, sources: SOURCES, date: TODAY, limit: 10 };

  it('caps how many picks one outlet may take', () => {
    const candidates = Array.from({ length: 8 }, (_, i) =>
      candidate({ index: i, headline: `Hindu story ${i}`, feedId: 'hindu_national' }),
    );
    const { picked, drops } = selectHeadlines({ ...base, candidates, maxPerSource: 3 });

    assert.equal(picked.length, 3);
    assert.equal(drops.filter((drop) => drop.reason === 'over_source_cap').length, 5);
  });

  it('leaves no slot empty when one outlet dominates the top of the ranking', () => {
    // Five high-scoring items from one feed and two from another. Capping at 3
    // per source must still fill five slots, not three — the bug this ordering
    // exists to prevent is trimming AFTER taking the top N.
    const candidates = [
      ...Array.from({ length: 5 }, (_, i) =>
        candidate({
          index: i,
          headline: `Federalism story ${i}`,
          feedId: 'pib_releases',
          sourceName: 'PIB Press Releases',
        }),
      ),
      candidate({ index: 5, headline: 'Banking and monetary policy review', feedId: 'rbi_press' }),
      candidate({ index: 6, headline: 'Federalism debate continues', feedId: 'hindu_national' }),
    ];

    const { picked } = selectHeadlines({ ...base, candidates, limit: 5, maxPerSource: 3 });
    assert.equal(picked.length, 5);
    assert.equal(picked.filter((p) => p.candidate.feedId === 'pib_releases').length, 3);
  });

  it('drops entries older than the age window', () => {
    const candidates = [
      candidate({ index: 0, publishedAt: '2026-08-01T06:00:00Z', headline: 'Ancient news' }),
      candidate({ index: 1, publishedAt: `${TODAY}T06:00:00Z`, headline: 'Today news' }),
    ];
    const { picked, drops } = selectHeadlines({ ...base, candidates });

    assert.equal(picked.length, 1);
    assert.equal(picked[0]?.candidate.headline, 'Today news');
    assert.equal(drops.filter((drop) => drop.reason === 'stale').length, 1);
  });

  it('keeps an entry with no publication date rather than guessing its age', () => {
    // PIB's index pages carry no date. Dropping them as "stale" would silently
    // remove a primary source; dropping them as "fresh" would let an archive
    // page rank top. Keeping them unscored for recency is the middle.
    const candidates = [candidate({ index: 0, publishedAt: null, headline: 'Undated release' })];
    const { picked } = selectHeadlines({ ...base, candidates });
    assert.equal(picked.length, 1);
  });

  it('ranks a primary source above commentary, all else equal', () => {
    const candidates = [
      candidate({ index: 0, headline: 'Some story', feedId: 'hindu_national' }),
      candidate({ index: 1, headline: 'Some story elsewhere', feedId: 'pib_releases' }),
    ];
    const { picked } = selectHeadlines({ ...base, candidates });
    assert.equal(picked[0]?.candidate.feedId, 'pib_releases');
  });

  it('derives item kind from the publisher, never from the text', () => {
    // A newspaper reporting on a judgment is a report. Only the Court's own
    // feed produces a judgment.
    const candidates = [
      candidate({ index: 0, headline: 'Supreme Court judgment strikes down the rule' }),
      candidate({ index: 1, headline: 'Routine listing', feedId: 'rbi_press' }),
    ];
    const { picked } = selectHeadlines({ ...base, candidates });
    const byFeed = new Map(picked.map((p) => [p.candidate.feedId, p.itemKind]));

    assert.equal(byFeed.get('hindu_national'), 'report');
    assert.equal(byFeed.get('rbi_press'), 'data');
  });

  it('drops an entry from a feed that is not in the allowlist', () => {
    const candidates = [candidate({ index: 0, feedId: 'not_a_real_feed' })];
    const { picked, drops } = selectHeadlines({ ...base, candidates });

    assert.equal(picked.length, 0);
    assert.equal(drops[0]?.reason, 'unknown_feed');
  });

  it('keeps an untagged item rather than dropping it', () => {
    // The bias is toward under-tagging, which only works if an untagged item is
    // still shown. Dropping them would make a fresh install — where the
    // vocabulary is nearly empty — return nothing at all.
    const candidates = [candidate({ index: 0, headline: 'Something entirely unrelated' })];
    const { picked } = selectHeadlines({ ...base, candidates, vocabulary: [] });

    assert.equal(picked.length, 1);
    assert.deepEqual(picked[0]?.syllabusTags, []);
  });

  it('matches the lede as well as the headline', () => {
    // The Hindu titles editorials "Ground control:" and similar, which carry no
    // terms at all. Without the lede they would never tag.
    const candidates = [
      candidate({
        index: 0,
        headline: 'Ground control:',
        lede: 'Federalism is tested when the Centre and States disagree',
      }),
    ];
    const { picked } = selectHeadlines({ ...base, candidates });
    assert.ok(picked[0]?.syllabusTags.includes('gs2-polity-federalism'));
  });

  it('is deterministic: the same input yields the same order', () => {
    const candidates = Array.from({ length: 6 }, (_, i) =>
      candidate({ index: i, headline: `Story ${i}` }),
    );
    const a = selectHeadlines({ ...base, candidates });
    const b = selectHeadlines({ ...base, candidates });
    assert.deepEqual(
      a.picked.map((p) => p.candidate.canonicalUrl),
      b.picked.map((p) => p.candidate.canonicalUrl),
    );
  });

  it('respects the limit', () => {
    const candidates = Array.from({ length: 20 }, (_, i) =>
      candidate({ index: i, headline: `Story ${i}`, feedId: i % 2 ? 'pib_releases' : 'rbi_press' }),
    );
    const { picked } = selectHeadlines({ ...base, candidates, limit: 4, maxPerSource: 10 });
    assert.equal(picked.length, 4);
  });

  it('exposes a fingerprint that matches the duplicate checker', () => {
    const candidates = [candidate({ index: 0, headline: 'SC quashes the bonds scheme' })];
    const { picked } = selectHeadlines({ ...base, candidates });
    // Sorted stems, so a reordered headline collapses to the same value.
    assert.equal(picked[0]?.headlineFingerprint, 'bond-quash-scheme');
  });

  it('defaults the age window to a week', () => {
    assert.equal(DEFAULT_MAX_AGE_DAYS, 7);
  });
});

describe('ranking bands', () => {
  const base = { vocabulary: VOCAB, sources: SOURCES, date: TODAY, limit: 10 };

  it('ranks any tagged item above every untagged one, whatever the source', () => {
    // The live-feed failure this rule exists for: three routine RBI notices
    // outranked every Hindu editorial because a primary source beat a tagged
    // secondary one. A bond auction is not examinable for being official.
    const candidates = [
      candidate({ index: 0, headline: 'Auction of Government of India Dated Securities', feedId: 'rbi_press' }),
      candidate({ index: 1, headline: 'Money Market Operations as on September 07', feedId: 'rbi_press' }),
      candidate({ index: 2, headline: 'Federalism under strain', feedId: 'hindu_national' }),
    ];
    const { picked } = selectHeadlines({ ...base, candidates });

    assert.equal(picked[0]?.candidate.feedId, 'hindu_national');
    assert.ok(picked[0]?.syllabusTags.includes('gs2-polity-federalism'));
  });

  it('still orders untagged items by source trust', () => {
    const candidates = [
      candidate({ index: 0, headline: 'Nothing matching here', feedId: 'hindu_national' }),
      candidate({ index: 1, headline: 'Also nothing matching', feedId: 'rbi_press' }),
    ];
    const { picked } = selectHeadlines({ ...base, candidates });
    assert.equal(picked[0]?.candidate.feedId, 'rbi_press');
  });
});
