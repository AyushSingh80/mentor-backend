/**
 * The contract guard.
 *
 * `ca-map` is the last thing standing between a model's output and a FACT
 * rendered on a phone with no signal. The stakes are higher than the MCQ
 * mapper's: a bad question is a wrong answer on a drill she can dispute with
 * one tap, whereas a bad current-affairs item gets copied into a Mains answer
 * worth 250 marks, and nothing about a fabricated fact looks different from a
 * real one on screen.
 *
 * Its two jobs pull in opposite directions and both are tested here:
 *
 * - REJECT anything that would render broken or read as a claim it cannot
 *   support: a note with no evidence behind it, a note that overruns the
 *   reading block, an item whose kind the selection rule cannot read, a story
 *   she already has — and, above all, a source URL that cannot be opened.
 * - ACCEPT everything else, including an item whose syllabus slug this build
 *   has never heard of. An untagged item is still a readable item.
 *
 * And it must never throw. It runs inside a streaming read loop on a path whose
 * contract is that it does not reject, so an exception would abandon the rest
 * of the stream and discard every item already ingested in the digest.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  canonicalUrl,
  createDigestMapper,
  headlineFingerprint,
  isFetchableUrl,
  mapDigestBatch,
  mapDigestItem,
  noteWordCount,
  normaliseHeadline,
  type CaMapContext,
} from '../src/lib/ca-map';
import { buildTagIndex, type TagFact } from '../src/lib/ca-tags';
import { CA_RULES } from '../src/lib/ca-types';

/* ------------------------------------------------------------------ helpers */

const FACTS: TagFact[] = [
  {
    id: 41,
    slug: 'gs2-polity-fr',
    paper: 'gs2',
    topic: 'Polity',
    subtopic: 'Fundamental Rights',
    status: 'first_pass',
    retiredAt: null,
  },
  {
    id: 77,
    slug: 'gs3-economy-fiscal',
    paper: 'gs3',
    topic: 'Economy',
    subtopic: 'Fiscal policy',
    status: 'in_progress',
    retiredAt: null,
  },
];

function context(overrides: Partial<CaMapContext> = {}): CaMapContext {
  return {
    date: '2026-09-07',
    tagIndex: buildTagIndex(FACTS),
    knownCanonicalUrls: new Set<string>(),
    knownFingerprints: new Set<string>(),
    ...overrides,
  };
}

let counter = 0;

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  counter += 1;
  return {
    headline: `Supreme Court rules on matter number ${counter}`,
    sourceUrl: `https://www.thehindu.com/news/national/story-${counter}/`,
    sourceName: 'The Hindu',
    publishedAt: '2026-09-06T18:30:00.000Z',
    kind: 'judgment',
    noteMd: 'The Court held that the notification was ultra vires the parent Act.',
    evidence: [{ quote: 'the notification was ultra vires the parent Act', at: 128 }],
    syllabusSlugs: ['gs2-polity-fr'],
    ...overrides,
  };
}

function words(count: number): string {
  return Array.from({ length: count }, (_, i) => `word${i}`).join(' ');
}

/* -------------------------------------------------- the safety rule: URLs */

describe('mapDigestItem — the source URL is a safety mechanism', () => {
  it('rejects the fake runner’s about:blank', () => {
    // A fake item must not be ingestable by a build that is not itself pointed
    // at the fake server. The marker travels with the data rather than
    // depending on a flag someone remembered to unset.
    const outcome = mapDigestItem(payload({ sourceUrl: 'about:blank' }), context());
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'bad_source_url');
  });

  it('rejects a blank, missing or whitespace-only URL', () => {
    for (const value of ['', '   ', null, undefined, 42, {}]) {
      const outcome = mapDigestItem(payload({ sourceUrl: value }), context());
      assert.equal(outcome.ok, false, `sourceUrl ${String(value)} must be rejected`);
      assert.equal(outcome.reason, 'bad_source_url');
    }
  });

  it('rejects every non-http scheme', () => {
    for (const value of [
      'about:blank',
      'file:///etc/passwd',
      'data:text/html,<h1>hi</h1>',
      'javascript:alert(1)',
      'ftp://example.com/x',
      'chrome://version',
      'thehindu.com/story',
      'http:',
      'https:/only-one-slash',
    ]) {
      const outcome = mapDigestItem(payload({ sourceUrl: value }), context());
      assert.equal(outcome.ok, false, `${value} must be rejected`);
      assert.equal(outcome.reason, 'bad_source_url');
    }
  });

  it('accepts http and https, whatever the casing', () => {
    for (const value of [
      'http://pib.gov.in/release/1',
      'https://pib.gov.in/release/1',
      'HTTPS://PIB.GOV.IN/release/1',
    ]) {
      assert.equal(isFetchableUrl(value), true, `${value} is fetchable`);
      const outcome = mapDigestItem(payload({ sourceUrl: value }), context());
      assert.equal(outcome.ok, true, `${value} must be accepted`);
    }
  });

  it('names the offending value in the rejection, without echoing the payload', () => {
    const outcome = mapDigestItem(payload({ sourceUrl: 'about:blank' }), context());
    assert.equal(outcome.ok, false);
    assert.match(outcome.detail, /about:blank/);
    assert.ok(outcome.detail.length < 200, 'the detail is one loggable line');
  });
});

/* ------------------------------------------------- the rest of the rejects */

describe('mapDigestItem — what must never reach the feed', () => {
  it('rejects an empty headline', () => {
    for (const value of ['', '   ', null, undefined, 7]) {
      const outcome = mapDigestItem(payload({ headline: value }), context());
      assert.equal(outcome.ok, false, `headline ${String(value)} must be rejected`);
      assert.equal(outcome.reason, 'empty_headline');
    }
  });

  it('rejects an empty note — the note IS the item', () => {
    for (const value of ['', '   ', null, undefined]) {
      const outcome = mapDigestItem(payload({ noteMd: value }), context());
      assert.equal(outcome.ok, false, `noteMd ${String(value)} must be rejected`);
      assert.equal(outcome.reason, 'empty_note');
    }
  });

  it('rejects a note over the word budget', () => {
    const outcome = mapDigestItem(
      payload({ noteMd: words(CA_RULES.maxNoteWords + 1) }),
      context(),
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'note_too_long');
    assert.match(outcome.detail, new RegExp(`${CA_RULES.maxNoteWords + 1} words`));
  });

  it('accepts a note exactly at the budget', () => {
    // The cap is a ceiling, not a target; the boundary must not cost her an
    // item that was written to it.
    const outcome = mapDigestItem(payload({ noteMd: words(CA_RULES.maxNoteWords) }), context());
    assert.equal(outcome.ok, true);
    assert.equal(noteWordCount(words(CA_RULES.maxNoteWords)), CA_RULES.maxNoteWords);
  });

  it('rejects zero evidence — the claim would be unbacked', () => {
    for (const value of [[], null, undefined, 'a quote', [{}], [''], [{ quote: '  ' }]]) {
      const outcome = mapDigestItem(payload({ evidence: value }), context());
      assert.equal(outcome.ok, false, `evidence ${JSON.stringify(value)} must be rejected`);
      assert.equal(outcome.reason, 'no_evidence');
    }
  });

  it('accepts evidence as bare strings as well as spans', () => {
    const outcome = mapDigestItem(
      payload({ evidence: ['the notification was ultra vires', { quote: 'a second quote' }] }),
      context(),
    );
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.item.evidence, [
      { quote: 'the notification was ultra vires' },
      { quote: 'a second quote' },
    ]);
  });

  it('rejects an unknown kind rather than defaulting it', () => {
    // Unlike `difficulty` in the MCQ mapper, which only changes a label, the
    // kind IS the selection rule — a cabinet decision earns a slot and a
    // bilateral visit does not.
    for (const value of ['announcement', '', null, undefined, 3, 'EVENTS']) {
      const outcome = mapDigestItem(payload({ kind: value }), context());
      assert.equal(outcome.ok, false, `kind ${String(value)} must be rejected`);
      assert.equal(outcome.reason, 'unknown_kind');
    }
  });

  it('accepts every kind the schema names, case-insensitively', () => {
    for (const kind of ['structural', 'report', 'judgment', 'scheme', 'data', 'event']) {
      const outcome = mapDigestItem(payload({ kind: kind.toUpperCase() }), context());
      assert.equal(outcome.ok, true, `${kind} must be accepted`);
      assert.equal(outcome.item.kind, kind);
    }
  });
});

/* --------------------------------------------------------- never throws */

describe('mapDigestItem — never throws', () => {
  it('returns a rejection for a wholly malformed payload', () => {
    for (const value of [null, undefined, 42, 'a string', [], [1, 2], true, NaN]) {
      const outcome = mapDigestItem(value, context());
      assert.equal(outcome.ok, false, `${JSON.stringify(value)} must be rejected`);
      assert.equal(outcome.reason, 'not_an_object');
    }
  });

  it('survives a payload whose every field is the wrong type', () => {
    const hostile = {
      headline: { nested: true },
      sourceUrl: [1, 2, 3],
      noteMd: 42,
      evidence: 'not an array',
      kind: null,
      syllabusSlugs: { not: 'an array' },
      anthro: 'not an object',
      publishedAt: [],
    };
    const outcome = mapDigestItem(hostile, context());
    assert.equal(outcome.ok, false);
  });

  it('survives a self-referential payload', () => {
    const circular: Record<string, unknown> = payload();
    circular.self = circular;
    const outcome = mapDigestItem(circular, context());
    assert.equal(outcome.ok, true);
  });

  it('returns a rejection rather than throwing on a non-array batch', () => {
    const result = mapDigestBatch('not an array', context());
    assert.deepEqual(result.accepted, []);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0]?.reason, 'not_an_object');
  });
});

/* ------------------------------------------------------------- duplicates */

describe('duplicate suppression', () => {
  it('rejects and COUNTS a duplicate headline within one batch', () => {
    const mapper = createDigestMapper(context());
    const first = mapper.accept(
      payload({ headline: 'SC strikes down the electoral bonds scheme' }),
    );
    const second = mapper.accept(
      // Same story, different outlet: a different URL, a cosmetically different
      // headline. Two of six slots on one fact is the failure being prevented.
      payload({ headline: 'SC Strikes Down the Electoral Bonds Scheme.' }),
    );

    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'duplicate_headline');

    const result = mapper.result();
    assert.equal(result.accepted.length, 1);
    assert.equal(result.duplicates, 1);
    assert.equal(result.rejected[0]?.index, 1);
  });

  it('rejects a duplicate canonical URL within one batch', () => {
    const mapper = createDigestMapper(context());
    mapper.accept(payload({ headline: 'A', sourceUrl: 'https://pib.gov.in/r/1' }));
    const second = mapper.accept(
      // The same document, reached through a campaign link.
      payload({ headline: 'A quite different headline', sourceUrl: 'https://www.pib.gov.in/r/1?utm_source=x' }),
    );

    assert.equal(second.ok, false);
    assert.equal(second.reason, 'duplicate_url');
    assert.equal(mapper.result().duplicates, 1);
  });

  it('rejects against the fortnight window the device already holds', () => {
    const held = headlineFingerprint('SC strikes down the electoral bonds scheme');
    const outcome = mapDigestItem(
      payload({ headline: 'SC strikes down the electoral bonds scheme' }),
      context({ knownFingerprints: new Set([held]) }),
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'duplicate_headline');
  });

  it('does not let one duplicate abandon the items after it', () => {
    const result = mapDigestBatch(
      [
        payload({ headline: 'One' }),
        payload({ headline: 'One' }),
        payload({ headline: 'Two' }),
        payload({ headline: 'Three' }),
      ],
      context(),
    );
    assert.equal(result.accepted.length, 3);
    assert.equal(result.duplicates, 1);
  });
});

/* ------------------------------------------------------------ fingerprints */

describe('headlineFingerprint — cosmetic differences only', () => {
  const same = (a: string, b: string) =>
    assert.equal(headlineFingerprint(a), headlineFingerprint(b), `"${a}" == "${b}"`);
  const differs = (a: string, b: string) =>
    assert.notEqual(headlineFingerprint(a), headlineFingerprint(b), `"${a}" != "${b}"`);

  it('collapses case, spacing and punctuation', () => {
    same('SC upholds the Act', 'sc upholds the act');
    same('SC upholds the Act', 'SC   upholds  the Act.');
    same('SC upholds the Act', '  SC upholds the Act!  ');
    same('SC upholds the Act', 'SC — upholds — the Act');
  });

  it('collapses smart quotes and apostrophes', () => {
    same('Govt’s new rule', "Govt's new rule");
    same('“Landmark” ruling on Article 21', 'Landmark ruling on Article 21');
  });

  it('collapses accents', () => {
    same('Café ruling upheld', 'Cafe ruling upheld');
  });

  it('collapses digit grouping, which is where two desks really differ', () => {
    // The headline-specific rule, and the reason this is not `stemFingerprint`.
    same('SC upholds Rs 1,00,000 cap', 'SC upholds Rs 100000 cap');
    same('Outlay of 1,234,567 crore approved', 'Outlay of 1234567 crore approved');
  });

  it('does NOT collapse a genuine rewording', () => {
    differs('SC upholds the Act', 'SC strikes down the Act');
    differs('SC upholds the Act', 'HC upholds the Act');
    differs('Cabinet clears the Bill', 'Cabinet defers the Bill');
    // Word order carries meaning; the normaliser does not sort.
    differs('Centre rejects state plea', 'State rejects Centre plea');
  });

  it('does NOT collapse a genuine change of figure', () => {
    differs('SC upholds Rs 1,00,000 cap', 'SC upholds Rs 2,00,000 cap');
    differs('Outlay of 1,234 crore', 'Outlay of 12,340 crore');
  });

  it('treats two groupings of the SAME digits as one figure', () => {
    // Indian and international grouping of one number, which is exactly the
    // cross-desk variance the rule exists for.
    same('Outlay of 1,234 crore', 'Outlay of 12,34 crore');
  });

  it('keeps non-Latin headlines distinguishable', () => {
    // A script `NON_WORD` did not cover would collapse every such headline to
    // the empty string, making each one "a duplicate" of every other.
    differs('उच्चतम न्यायालय ने कानून बरकरार रखा', 'उच्चतम न्यायालय ने कानून रद्द किया');
    assert.notEqual(normaliseHeadline('उच्चतम न्यायालय'), '');
  });

  it('is 16 stable hex characters', () => {
    const fingerprint = headlineFingerprint('SC upholds the Act');
    assert.match(fingerprint, /^[0-9a-f]{16}$/);
    assert.equal(fingerprint, headlineFingerprint('SC upholds the Act'));
  });
});

/* ------------------------------------------------------------- canonical URL */

describe('canonicalUrl', () => {
  it('strips tracking parameters, www, the fragment and a trailing slash', () => {
    assert.equal(
      canonicalUrl('https://www.thehindu.com/news/story/?utm_source=twitter&utm_medium=social#top'),
      'https://thehindu.com/news/story',
    );
  });

  it('keeps a parameter that identifies the document', () => {
    assert.equal(
      canonicalUrl('https://pib.gov.in/PressRelease.aspx?PRID=2026001&utm_campaign=x'),
      'https://pib.gov.in/PressRelease.aspx?PRID=2026001',
    );
  });

  it('sorts surviving parameters, because their order carries no meaning', () => {
    assert.equal(
      canonicalUrl('https://x.in/a?b=2&a=1'),
      canonicalUrl('https://x.in/a?a=1&b=2'),
    );
  });

  it('drops a default port and lowercases the host but not the path', () => {
    assert.equal(canonicalUrl('https://Example.IN:443/Story/One'), 'https://example.in/Story/One');
    assert.equal(canonicalUrl('http://Example.IN:80/Story'), 'http://example.in/Story');
  });

  it('drops credentials, which must never reach a rendered row', () => {
    assert.equal(canonicalUrl('https://user:pass@example.in/a'), 'https://example.in/a');
  });

  it('returns something usable for a URL it cannot parse', () => {
    // A key that is merely imprecise beats no key at all: refusing to produce
    // one would make the item invisible to duplicate suppression entirely.
    assert.equal(canonicalUrl('not a url'), 'not a url');
  });
});

/* ---------------------------------------------------------------- tagging */

describe('tagging — an unknown slug never rejects the item', () => {
  it('ingests an item whose slug this build has never heard of', () => {
    const outcome = mapDigestItem(
      payload({ syllabusSlugs: ['gs9-quantum-diplomacy'] }),
      context(),
    );

    assert.equal(outcome.ok, true, 'an unknown slug must not reject the item');
    assert.deepEqual(outcome.item.topicIds, []);
    // The RAW string is kept, so a later syllabus re-seed can re-resolve it.
    assert.deepEqual(outcome.item.syllabusTags, ['gs9-quantum-diplomacy']);
    assert.deepEqual(outcome.item.unknownTags, ['gs9-quantum-diplomacy']);
  });

  it('counts unknown slugs across a batch without dropping a single item', () => {
    const result = mapDigestBatch(
      [
        payload({ syllabusSlugs: ['gs9-quantum-diplomacy'] }),
        payload({ syllabusSlugs: ['gs2-polity-fr'] }),
        payload({ syllabusSlugs: ['gs9-quantum-diplomacy', 'gs8-space-law'] }),
      ],
      context(),
    );

    assert.equal(result.accepted.length, 3, 'every item survives');
    assert.deepEqual(result.unknownTags.sort(), ['gs8-space-law', 'gs9-quantum-diplomacy']);
  });

  it('resolves a known slug to its topic id, in rank order', () => {
    const outcome = mapDigestItem(
      payload({ syllabusSlugs: ['gs3-economy-fiscal', 'gs2-polity-fr'] }),
      context(),
    );
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.item.topicIds, [77, 41]);
  });

  it('accepts section keys alongside leaf slugs', () => {
    const outcome = mapDigestItem(
      payload({ syllabusSlugs: [], sectionKeys: ['gs2:Polity'] }),
      context(),
    );
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.item.topicIds, [41]);
  });

  it('ingests an item with no tags at all', () => {
    const outcome = mapDigestItem(payload({ syllabusSlugs: [] }), context());
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.item.topicIds, []);
    assert.deepEqual(outcome.item.syllabusTags, []);
  });
});

/* ------------------------------------------------------------ the row itself */

describe('the mapped row', () => {
  it('takes the digest day from the context and the publication date from the wire', () => {
    // A Sunday judgment lands in Monday's digest. Conflating the two makes the
    // monthly compilation wrong at every month boundary.
    const outcome = mapDigestItem(
      payload({ publishedAt: '2026-09-06T18:30:00.000Z' }),
      context({ date: '2026-09-07' }),
    );
    assert.equal(outcome.ok, true);
    assert.equal(outcome.item.date, '2026-09-07');
    assert.equal(outcome.item.publishedAt, '2026-09-06T18:30:00.000Z');
  });

  it('carries the anthropology pair and its usage line', () => {
    const outcome = mapDigestItem(
      payload({
        anthro: {
          p1Slug: 'anthro-p1-kinship',
          p2Slug: 'anthro-p2-tribal-india',
          usageLine: 'Cite as an instance of segmentary lineage in contemporary India.',
        },
      }),
      context(),
    );
    assert.equal(outcome.ok, true);
    assert.equal(outcome.item.anthroP1Slug, 'anthro-p1-kinship');
    assert.equal(outcome.item.anthroP2Slug, 'anthro-p2-tribal-india');
    assert.match(outcome.item.anthroLink ?? '', /segmentary lineage/);
  });

  it('leaves the anthropology fields null when nothing was claimed', () => {
    const outcome = mapDigestItem(payload(), context());
    assert.equal(outcome.ok, true);
    assert.equal(outcome.item.anthroLink, null);
    assert.equal(outcome.item.anthroP1Slug, null);
  });

  it('counts anthropology links across the batch, for the over-claim check', () => {
    const result = mapDigestBatch(
      [
        payload({ anthro: { p1Slug: 'a', p2Slug: 'b', usageLine: 'one' } }),
        payload(),
        payload(),
      ],
      context(),
    );
    assert.equal(result.anthroLinked, 1);
    assert.ok(
      result.anthroLinked / result.accepted.length < CA_RULES.maxAnthroLinkRate,
      'this batch is not over-claiming',
    );
  });

  it('accepts the field aliases the young server contract actually uses', () => {
    const outcome = mapDigestItem(
      {
        title: 'PIB announces a new scheme',
        url: 'https://pib.gov.in/r/9',
        note: 'The Cabinet approved an outlay of Rs 1,200 crore over five years.',
        quotes: ['an outlay of Rs 1,200 crore'],
        itemKind: 'scheme',
        tags: ['gs2-polity-fr'],
        outlet: 'PIB',
      },
      context(),
    );
    assert.equal(outcome.ok, true);
    assert.equal(outcome.item.headline, 'PIB announces a new scheme');
    assert.equal(outcome.item.sourceName, 'PIB');
    assert.equal(outcome.item.kind, 'scheme');
  });

  it('re-canonicalises rather than trusting the wire’s canonical URL', () => {
    // The device's duplicate window is keyed on THIS function's output; two
    // canonicalisers would drift and the window would stop matching.
    const outcome = mapDigestItem(
      payload({
        sourceUrl: 'https://www.thehindu.com/a/?utm_source=x',
        canonicalUrl: 'https://www.thehindu.com/a/?utm_source=x',
      }),
      context(),
    );
    assert.equal(outcome.ok, true);
    assert.equal(outcome.item.sourceUrlCanonical, 'https://thehindu.com/a');
  });
});
