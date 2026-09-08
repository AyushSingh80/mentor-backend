/**
 * The grounding gate.
 *
 * This is the most valuable test file in the phase. Everything downstream of it
 * — the shortlist, the notes call, the digest she reads at 10:15 — is a
 * suggestion; this is the only thing in the pipeline that can say no and mean
 * it. Every test below is written the same way: take a draft that passes
 * completely, break EXACTLY ONE thing, and assert the item is dropped.
 *
 * The bar is not "the checks fire". It is "the checks fire on the fabrication a
 * competent model would actually produce": a quote with one word improved, a
 * round number that sounds right, a judgment year off by one, `Article 21A`
 * where the source said `Article 21`. Those are the failures that reach a Mains
 * answer, because they are the ones that survive a human read-through.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.ANTHROPIC_API_KEY ??= 'sk-ant-test-not-real';
process.env.MODEL_EVALUATION ??= 'eval-model-1';
process.env.MODEL_BULK ??= 'bulk-model-1';
process.env.APP_BEARER_TOKEN ??= 'test-token';

const {
  canonicalNumber,
  citationTokens,
  dateTokens,
  normaliseForGrounding,
  numberTokens,
  splitSentences,
  stripMarkdown,
  ungroundedCitations,
  ungroundedDates,
  ungroundedNumbers,
  verifyGrounding,
} = await import('../src/ca/ground.js');
const { extractArticle } = await import('../src/ca/extract.js');

type Draft = Parameters<typeof verifyGrounding>[0];
type Doc = Parameters<typeof verifyGrounding>[1];

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): Promise<string> =>
  readFile(join(here, 'fixtures', 'ca', name), 'utf8');

/**
 * The fetched page, with the typographic characters a real CMS emits.
 *
 * Smart quotes, a non-breaking space and an em dash are in here on purpose: a
 * model handed this text will quote it back with ASCII punctuation, and a
 * grounding check that treated that as a mismatch would drop every honest item
 * while catching no dishonest one.
 */
const SOURCE_TEXT = [
  'A three-judge bench of the Supreme Court held on 12 March 2026 that access to',
  'schooling in a Scheduled Area is inseparable from the guarantee under Article 21.',
  'The bench read Articles 14, 19 and 21 together.',
  'The Union had allocated ₹1,200 crore to the National Tribal Health Mission,',
  'and 62 per cent of that allocation remained unspent.',
  'The National Commission for Scheduled Tribes (NCST) had been consulted.',
  'Section 6 of the Forest Rights Act, 2006 vests the determination of claims in the Gram Sabha.',
  'The Court called the provision “a facet of the right to life” — and said the Fifth Schedule applies.',
].join(' ');

function sourceDoc(overrides: Partial<Doc> = {}): Doc {
  return {
    url: 'https://www.thehindu.com/news/national/bench-reads-article-21/article1.ece',
    canonicalUrl: 'https://thehindu.com/news/national/bench-reads-article-21/article1.ece',
    sourceName: 'The Hindu — National',
    feedId: 'hindu_national',
    title: 'Bench reads education access into Article 21',
    publishedAt: '2026-03-12T04:00:00.000Z',
    text: SOURCE_TEXT,
    charCount: SOURCE_TEXT.length,
    fetchedAt: '2026-03-12T05:00:00.000Z',
    ...overrides,
  };
}

const QUOTE_ONE =
  'held on 12 March 2026 that access to schooling in a Scheduled Area is inseparable from the guarantee under Article 21';
const QUOTE_TWO = 'The Union had allocated ₹1,200 crore to the National Tribal Health Mission';
const QUOTE_THREE =
  'Section 6 of the Forest Rights Act, 2006 vests the determination of claims in the Gram Sabha';

/** A draft that clears all five checks. Every test breaks exactly one thing. */
function goodDraft(overrides: Partial<Draft> = {}): Draft {
  return {
    url: 'https://www.thehindu.com/news/national/bench-reads-article-21/article1.ece',
    headline: 'Supreme Court reads education access into Article 21',
    kind: 'judgment',
    noteMd: [
      'The Supreme Court held on 12 March 2026 that schooling in a Scheduled Area falls under Article 21.',
      'The Union had allocated 1,200 crore to the National Tribal Health Mission.',
      'Section 6 of the Forest Rights Act vests the determination of claims in the Gram Sabha.',
    ].join(' '),
    sentenceEvidence: [0, 1, 2],
    evidence: [
      { quote: QUOTE_ONE, at: -1 },
      { quote: QUOTE_TWO, at: -1 },
      { quote: QUOTE_THREE, at: -1 },
    ],
    sectionKeys: ['polity'],
    syllabusSlugs: ['gs2_polity_fundamental_rights'],
    anthro: null,
    ...overrides,
  };
}

/** Asserts the item was dropped, and for the stated reason. */
function assertDropped(draft: Draft, reason: string, doc: Doc = sourceDoc()): void {
  const verdict = verifyGrounding(draft, doc);
  assert.equal(verdict.ok, false, 'expected the item to be DROPPED');
  if (verdict.ok) return;
  assert.equal(verdict.reason, reason, `drop reason: ${verdict.detail}`);
}

/* ------------------------------------------------------------- normalisation */

describe('normaliseForGrounding', () => {
  it('collapses whitespace and unifies quote marks and dashes', () => {
    assert.equal(
      normaliseForGrounding('the “right to\nlife” — and ‘more’'),
      'the "right to life" - and \'more\'',
    );
  });

  it('deletes invisible characters rather than turning them into spaces', () => {
    // U+FEFF is in JS `\s`, so collapsing before deleting would split a word.
    assert.equal(normaliseForGrounding('Arti﻿cle​ 21­'), 'Article 21');
  });

  it('composes canonically so an entity-decoded accent matches a precomposed one', () => {
    assert.equal(normaliseForGrounding('André'), normaliseForGrounding('André'));
  });

  it('is NOT more permissive than that', () => {
    // Case, punctuation and digits are untouched. Every loosening here is a
    // loosening of every check in the file.
    assert.equal(normaliseForGrounding('Article 21A.'), 'Article 21A.');
    assert.notEqual(normaliseForGrounding('ARTICLE 21'), normaliseForGrounding('article 21'));
    // NFKC would map these to `2` and `1`. NFC does not, and must not.
    assert.equal(normaliseForGrounding('²①'), '²①');
  });
});

/* ----------------------------------------------------------- quote grounding */

describe('quote grounding', () => {
  it('accepts a literal substring and resolves the offset', () => {
    const verdict = verifyGrounding(goodDraft(), sourceDoc());
    assert.equal(verdict.ok, true, verdict.ok ? '' : verdict.detail);
    if (!verdict.ok) return;
    assert.equal(verdict.evidence.length, 3);
    for (const span of verdict.evidence) assert.ok(span.at >= 0, 'every `at` is resolved');
  });

  it('resolves offsets that actually index the normalised text', () => {
    // The invariant the wire depends on. Without it `at` is decoration: the app
    // cannot highlight the quote and no later stage can re-check the claim.
    const verdict = verifyGrounding(goodDraft(), sourceDoc());
    assert.equal(verdict.ok, true);
    if (!verdict.ok) return;
    for (const span of verdict.evidence) {
      assert.equal(
        verdict.normalisedText.slice(span.at, span.at + span.quote.length),
        span.quote,
      );
    }
  });

  it('drops the item when ONE WORD of a quote is changed', () => {
    // "three-judge" -> "five-judge". Everything else about this item is perfect.
    // Similarity scoring would rate this above 0.99 and let it through.
    assertDropped(
      goodDraft({
        evidence: [
          { quote: QUOTE_ONE.replace('Scheduled Area', 'Scheduled District'), at: -1 },
          { quote: QUOTE_TWO, at: -1 },
          { quote: QUOTE_THREE, at: -1 },
        ],
      }),
      'ungrounded_quote',
    );
  });

  it('drops a quote whose words are all present but reordered', () => {
    assertDropped(
      goodDraft({
        evidence: [
          { quote: 'the guarantee under Article 21 that access to schooling', at: -1 },
          { quote: QUOTE_TWO, at: -1 },
          { quote: QUOTE_THREE, at: -1 },
        ],
      }),
      'ungrounded_quote',
    );
  });

  it('drops a quote that inserts a single plausible word', () => {
    assertDropped(
      goodDraft({
        evidence: [
          { quote: QUOTE_ONE.replace('under Article 21', 'under Article 21 alone'), at: -1 },
          { quote: QUOTE_TWO, at: -1 },
          { quote: QUOTE_THREE, at: -1 },
        ],
      }),
      'ungrounded_quote',
    );
  });

  it('matches an ASCII quote against smart quotes, a non-breaking space and an em dash', () => {
    const quoted =
      'The Court called the provision "a facet of the right to life" - and said the Fifth Schedule applies';
    const verdict = verifyGrounding(
      goodDraft({
        noteMd: 'The Court read the right to life as covering the Fifth Schedule obligation.',
        sentenceEvidence: [0],
        evidence: [{ quote: quoted, at: -1 }],
      }),
      sourceDoc(),
    );
    assert.equal(verdict.ok, true, verdict.ok ? '' : verdict.detail);
    if (!verdict.ok) return;
    assert.equal(verdict.evidence[0]?.quote, quoted);
  });

  it('drops an item with ZERO evidence rather than marking it unverified', () => {
    // There is no third state. An item that brought no proof is an item that
    // cannot be checked, and "unverified" on a screen she reads at 10:15 is
    // indistinguishable from verified by the time it reaches an answer sheet.
    const verdict = verifyGrounding(
      goodDraft({ evidence: [], sentenceEvidence: [] }),
      sourceDoc(),
    );
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.equal(verdict.reason, 'ungrounded_quote');
    assert.match(verdict.detail, /no evidence/i);
  });

  it('drops an empty or whitespace-only quote', () => {
    assertDropped(
      goodDraft({
        evidence: [{ quote: '   ', at: -1 }, { quote: QUOTE_TWO, at: -1 }, { quote: QUOTE_THREE, at: -1 }],
      }),
      'ungrounded_quote',
    );
  });

  it('drops every quote when the fetched text is empty', () => {
    assertDropped(goodDraft(), 'ungrounded_quote', sourceDoc({ text: '', charCount: 0 }));
  });
});

/* --------------------------------------------------------- numeric grounding */

describe('ungroundedNumbers', () => {
  it('finds nothing in a note whose numbers all appear in the source', () => {
    assert.deepEqual(ungroundedNumbers(goodDraft().noteMd, SOURCE_TEXT), []);
  });

  it('catches a plausible-but-absent outlay', () => {
    // The source says 1,200 crore. 1,500 is the shape of a number a model
    // reaches for when it half-remembers, and it is the reason this check is
    // mechanical rather than a prompt instruction.
    assert.deepEqual(ungroundedNumbers('An outlay of 1,500 crore was approved.', SOURCE_TEXT), ['1500']);
  });

  it('catches an invented percentage and an invented bench strength', () => {
    assert.deepEqual(ungroundedNumbers('Some 71 per cent remained unspent.', SOURCE_TEXT), ['71']);
    assert.deepEqual(ungroundedNumbers('A bench of 7 judges decided it.', SOURCE_TEXT), ['7']);
  });

  it('does not let 21 be grounded by 2021', () => {
    // The substring trap. `'2021'.includes('21')` is true, and an implementation
    // built on `includes` would ground a fabricated number against a year.
    assert.deepEqual(ungroundedNumbers('Exactly 21 districts.', 'There were 2021 districts.'), ['21']);
  });

  it('treats grouped and ungrouped forms of the same number as the same number', () => {
    assert.deepEqual(ungroundedNumbers('1,200 crore', 'allocated 1200 crore'), []);
    assert.deepEqual(ungroundedNumbers('1200 crore', 'allocated 1,200 crore'), []);
    assert.deepEqual(ungroundedNumbers('1,00,000 households', 'reached 100000 households'), []);
    assert.deepEqual(ungroundedNumbers('a rate of 6.50 per cent', 'held at 6.5 per cent'), []);
    assert.deepEqual(ungroundedNumbers('1.0 per cent', 'grew 1 per cent'), []);
  });

  it('does not read markdown punctuation as a factual claim', () => {
    // An ordered-list marker and a link destination carry digits that are not
    // claims. Scanning them would drop honest items for their formatting.
    const md = '1. See [the release](https://pib.gov.in/x.aspx?PRID=2012345) for 2026 figures.';
    assert.deepEqual(ungroundedNumbers(md, 'Published in 2026.'), []);
  });

  it('canonicalises numbers without going through a float', () => {
    assert.equal(canonicalNumber('1,200'), '1200');
    assert.equal(canonicalNumber('6.50'), '6.5');
    assert.equal(canonicalNumber('1.0'), '1');
    assert.equal(canonicalNumber('0.5'), '0.5');
    assert.equal(canonicalNumber('007'), '7');
    // Twenty digits survive intact; `Number()` would have collapsed these two
    // different identifiers onto the same value.
    assert.notEqual(canonicalNumber('12345678901234567890'), canonicalNumber('12345678901234567891'));
  });

  it('drops the whole item for one ungrounded number', () => {
    assertDropped(
      goodDraft({
        noteMd: [
          'The Supreme Court held on 12 March 2026 that schooling in a Scheduled Area falls under Article 21.',
          'The Union had allocated 1,500 crore to the National Tribal Health Mission.',
          'Section 6 of the Forest Rights Act vests the determination of claims in the Gram Sabha.',
        ].join(' '),
      }),
      'ungrounded_number',
    );
  });
});

/* ------------------------------------------------------------ date grounding */

describe('ungroundedDates', () => {
  it('finds nothing in a note whose dates all appear in the source', () => {
    assert.deepEqual(ungroundedDates(goodDraft().noteMd, SOURCE_TEXT), []);
  });

  it('catches an invented judgment year', () => {
    // The single most dangerous fabrication in the product: a citation with the
    // wrong year reads exactly as authoritative as one with the right year.
    assert.deepEqual(ungroundedDates('The bench decided this in 1998.', SOURCE_TEXT), ['1998']);
  });

  it('catches an invented month', () => {
    assert.deepEqual(ungroundedDates('Delivered in April 2026.', SOURCE_TEXT), ['April']);
  });

  it('catches an invented weekday', () => {
    assert.deepEqual(ungroundedDates('The bench sat on Tuesday.', SOURCE_TEXT), ['Tuesday']);
  });

  it('does not let a lowercase modal "may" ground the month May', () => {
    // The false PASS this check exists to refuse. Without the capitalisation
    // rule, any source containing "the Court may direct" grounds a note that
    // invents a May judgment.
    assert.deepEqual(ungroundedDates('Decided in May 2026.', 'The Court may direct in 2026.'), ['May']);
    // And the reverse still works: a real May in the source grounds it.
    assert.deepEqual(ungroundedDates('Decided in May 2026.', 'Delivered in May 2026.'), []);
  });

  it('does not let 2026 be grounded by 12026', () => {
    assert.deepEqual(ungroundedDates('In 2026 the bench sat.', 'Case number 12026 was listed.'), ['2026']);
  });

  it('reads abbreviations as the month they abbreviate', () => {
    assert.deepEqual(ungroundedDates('Issued in Mar 2026.', 'Issued in March 2026.'), []);
    assert.deepEqual(ungroundedDates('Issued in Sept 2026.', 'Issued in September 2026.'), []);
  });

  it('drops the whole item for one ungrounded date', () => {
    assertDropped(
      goodDraft({
        noteMd: [
          'The Supreme Court held on 12 March 2025 that schooling in a Scheduled Area falls under Article 21.',
          'The Union had allocated 1,200 crore to the National Tribal Health Mission.',
          'Section 6 of the Forest Rights Act vests the determination of claims in the Gram Sabha.',
        ].join(' '),
      }),
      // 2025 is absent from the source as both a number and a year; the number
      // check runs first, which is the correct and stable ordering.
      'ungrounded_number',
    );
    // Isolated, the date check is the one that fires.
    assert.deepEqual(ungroundedDates('Decided in 2025.', SOURCE_TEXT), ['2025']);
  });
});

/* -------------------------------------------------------- citation grounding */

describe('ungroundedCitations', () => {
  it('finds nothing in a note whose citations all appear in the source', () => {
    assert.deepEqual(ungroundedCitations(goodDraft().noteMd, SOURCE_TEXT), []);
  });

  it('FAILS Article 21A against a source that says Article 21', () => {
    // The right to life and the right to education are different provisions.
    // A note that swaps one for the other is wrong in a way that reads as
    // authoritative, and a prefix match would have accepted it.
    assert.deepEqual(ungroundedCitations('Article 21A guarantees free education.', SOURCE_TEXT), [
      'article 21a',
    ]);
  });

  it('does not let Article 21 be grounded by a source that says only Article 21A', () => {
    assert.deepEqual(ungroundedCitations('Under Article 21 the Court held...', 'Article 21A applies.'), [
      'article 21',
    ]);
  });

  it('grounds a single article against a source that cites a list of them', () => {
    // "Articles 14, 19 and 21" is how Indian legal copy is actually written.
    // Without list expansion on BOTH sides this is a false drop on the most
    // common sentence in the corpus.
    assert.deepEqual(ungroundedCitations('Article 19 was read in.', SOURCE_TEXT), []);
    assert.deepEqual(ungroundedCitations('Article 14 was read in.', SOURCE_TEXT), []);
  });

  it('catches a section number the source never cites', () => {
    assert.deepEqual(ungroundedCitations('Section 7 of the Act applies.', SOURCE_TEXT), ['section 7']);
  });

  it('catches the wrong Schedule', () => {
    assert.deepEqual(ungroundedCitations('The Sixth Schedule applies.', SOURCE_TEXT), ['sixth schedule']);
    assert.deepEqual(ungroundedCitations('The Fifth Schedule applies.', SOURCE_TEXT), []);
  });

  it('catches an acronym the source never uses', () => {
    assert.deepEqual(ungroundedCitations('NITI Aayog reviewed the mission.', SOURCE_TEXT), ['NITI']);
    assert.deepEqual(ungroundedCitations('NCST was consulted.', SOURCE_TEXT), []);
  });

  it('does not let IAS be grounded by the word BIAS', () => {
    // The other substring trap, and the reason acronyms are compared as tokens.
    assert.deepEqual(ungroundedCitations('An IAS officer signed it.', 'There was no BIAS in it.'), ['IAS']);
  });

  it('splits trailing digits off an acronym so COP29 and COP 29 agree', () => {
    assert.deepEqual(ungroundedCitations('At COP29 the pledge was made.', 'At COP 29 in 2026.'), []);
  });

  it('drops the whole item for one ungrounded citation', () => {
    assertDropped(
      goodDraft({
        noteMd: [
          'The Supreme Court held on 12 March 2026 that schooling in a Scheduled Area falls under Article 21A.',
          'The Union had allocated 1,200 crore to the National Tribal Health Mission.',
          'Section 6 of the Forest Rights Act vests the determination of claims in the Gram Sabha.',
        ].join(' '),
      }),
      'ungrounded_citation',
    );
  });
});

/* --------------------------------------------------------- sentence coverage */

describe('splitSentences', () => {
  it('splits ordinary prose on terminators', () => {
    assert.deepEqual(splitSentences('One thing happened. Then another happened.'), [
      'One thing happened.',
      'Then another happened.',
    ]);
  });

  it('does not split on the abbreviations this corpus is full of', () => {
    assert.deepEqual(splitSentences('The outlay is Rs. 1,200 crore. The Court agreed.'), [
      'The outlay is Rs. 1,200 crore.',
      'The Court agreed.',
    ]);
    assert.deepEqual(splitSentences('Vishaka v. Union of India settled it.'), [
      'Vishaka v. Union of India settled it.',
    ]);
    assert.deepEqual(splitSentences('See Art. 21 and No. 14 below.'), ['See Art. 21 and No. 14 below.']);
  });

  it('does not split a decimal point', () => {
    assert.deepEqual(splitSentences('The rate is 6.25 per cent today.'), [
      'The rate is 6.25 per cent today.',
    ]);
  });

  it('treats each bullet and each numbered item as its own sentence', () => {
    assert.deepEqual(splitSentences('- First point\n- Second point'), ['First point', 'Second point']);
    assert.deepEqual(splitSentences('1. First thing.\n2. Second thing.'), [
      'First thing.',
      'Second thing.',
    ]);
  });

  it('counts a trailing fragment with no terminator', () => {
    assert.deepEqual(splitSentences('A complete sentence. A trailing fragment'), [
      'A complete sentence.',
      'A trailing fragment',
    ]);
  });
});

describe('sentence coverage', () => {
  it('drops a note whose last sentence carries no evidence index', () => {
    // The gap grounding alone leaves. Every quote here is verbatim, every
    // number, date and citation is in the source, and the third sentence is a
    // claim nobody attributed to anything.
    assertDropped(goodDraft({ sentenceEvidence: [0, 1] }), 'uncovered_sentence');
  });

  it('drops a note carrying more indices than it has sentences', () => {
    assertDropped(goodDraft({ sentenceEvidence: [0, 1, 2, 2] }), 'uncovered_sentence');
  });

  it('drops an index that points past the end of the evidence', () => {
    assertDropped(goodDraft({ sentenceEvidence: [0, 1, 5] }), 'uncovered_sentence');
  });

  it('drops a negative or non-integer index', () => {
    assertDropped(goodDraft({ sentenceEvidence: [0, 1, -1] }), 'uncovered_sentence');
    assertDropped(goodDraft({ sentenceEvidence: [0, 1, 1.5] }), 'uncovered_sentence');
  });

  it('drops a note with no sentences at all', () => {
    assertDropped(goodDraft({ noteMd: '   ', sentenceEvidence: [] }), 'uncovered_sentence');
  });

  it('accepts several sentences resting on the same evidence span', () => {
    const verdict = verifyGrounding(goodDraft({ sentenceEvidence: [0, 0, 0] }), sourceDoc());
    assert.equal(verdict.ok, true, verdict.ok ? '' : verdict.detail);
  });
});

/* -------------------------------------------------------------- the gate all */

describe('verifyGrounding as a gate', () => {
  it('never rewrites, repairs or annotates the draft', () => {
    // The rule this file shares with Phase 3's "on disagreement the question is
    // dropped, never re-keyed". A note edited to fit its evidence is a note
    // whose remaining sentences were written from a different premise.
    const draft = goodDraft({ noteMd: 'A sentence the source does not support at all in 1998.' });
    const snapshot = JSON.parse(JSON.stringify(draft)) as unknown;
    const verdict = verifyGrounding(draft, sourceDoc());
    assert.equal(verdict.ok, false);
    assert.deepEqual(JSON.parse(JSON.stringify(draft)), snapshot);
    assert.equal('noteMd' in verdict, false, 'a verdict never carries a mended note');
  });

  it('reports the first failure but records every one of them', () => {
    const verdict = verifyGrounding(
      goodDraft({
        noteMd: 'In 1998 the Court read Article 21A and allocated 1,500 crore.',
        sentenceEvidence: [],
        evidence: [{ quote: 'a quote the page never contained', at: -1 }],
      }),
      sourceDoc(),
    );
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.equal(verdict.reason, 'ungrounded_quote');
    const reasons = new Set(verdict.failures.map((failure) => failure.reason));
    assert.deepEqual(
      [...reasons].sort(),
      ['uncovered_sentence', 'ungrounded_citation', 'ungrounded_date', 'ungrounded_number', 'ungrounded_quote'],
      'one drop must not hide the other four problems',
    );
  });

  it('can produce each of the five grounding drop reasons', () => {
    const seen = new Set<string>();
    const breakages: Partial<Draft>[] = [
      { evidence: [{ quote: 'never on the page', at: -1 }], sentenceEvidence: [0, 0, 0] },
      { noteMd: 'The outlay was 1,500 crore.', sentenceEvidence: [0] },
      // A month, not a year: a 4-digit year is ALSO a number token, and the
      // number check runs first, so `ungrounded_date` is only reachable on its
      // own through a month or weekday. See the note in ground.ts.
      { noteMd: 'The bench sat in April.', sentenceEvidence: [0] },
      { noteMd: 'It turned on Article 21A.', sentenceEvidence: [0] },
      { sentenceEvidence: [0] },
    ];
    for (const breakage of breakages) {
      const verdict = verifyGrounding(goodDraft(breakage), sourceDoc());
      assert.equal(verdict.ok, false);
      if (!verdict.ok) seen.add(verdict.reason);
    }
    assert.deepEqual(
      [...seen].sort(),
      ['uncovered_sentence', 'ungrounded_citation', 'ungrounded_date', 'ungrounded_number', 'ungrounded_quote'],
    );
  });

  it('is deterministic and side-effect free', () => {
    const draft = goodDraft();
    const doc = sourceDoc();
    const first = verifyGrounding(draft, doc);
    const second = verifyGrounding(draft, doc);
    assert.deepEqual(first, second);
  });
});

/* ------------------------------------------------ against a real fetched page */

describe('grounding against a genuinely extracted page', () => {
  it('cannot be grounded by a year that only ever appeared in the furniture', () => {
    // The fixture's <nav> links to "Archive 1998" and its <footer> says
    // "© 2019 ... Registered in 1889". If extraction let those through, a note
    // could date a 2026 judgment to 1998 with the page's own authority.
    const html = fixture('article.html');
    return html.then((source) => {
      const article = extractArticle(source);
      assert.notEqual(article, null);
      if (article === null) return;
      assert.deepEqual(ungroundedDates('The bench decided in 1998.', article.text), ['1998']);
      assert.deepEqual(ungroundedNumbers('A helpline on 1800.', article.text), ['1800']);
      // And what the story really says still grounds.
      assert.deepEqual(ungroundedDates('Delivered on 12 March 2026.', article.text), []);
      assert.deepEqual(ungroundedCitations('It turned on Article 21.', article.text), []);
      assert.deepEqual(ungroundedCitations('It turned on Article 21A.', article.text), ['article 21a']);
    });
  });

  it('accepts a note quoting the extracted text verbatim', async () => {
    const article = extractArticle(await fixture('article.html'));
    assert.notEqual(article, null);
    if (article === null) return;
    const quote = 'the Fifth Schedule places an affirmative obligation on the Governor';
    const verdict = verifyGrounding(
      goodDraft({
        noteMd: 'The Fifth Schedule places an affirmative obligation on the Governor.',
        sentenceEvidence: [0],
        evidence: [{ quote, at: -1 }],
      }),
      sourceDoc({ text: article.text, charCount: article.charCount }),
    );
    assert.equal(verdict.ok, true, verdict.ok ? '' : verdict.detail);
    if (!verdict.ok) return;
    assert.equal(verdict.normalisedText.slice(verdict.evidence[0]?.at ?? -1).startsWith(quote), true);
  });
});

/* ---------------------------------------------------------- token extractors */

describe('token extractors', () => {
  it('extracts numbers, dates and citations symmetrically', () => {
    // Symmetry is the property the whole file rests on: the same extractor runs
    // over the note and over the page, so a token can only be grounded by the
    // same token, never by a substring of a different one.
    const text = 'Articles 14, 19 and 21 in March 2026 cost 1,200 crore under NCST.';
    assert.deepEqual(numberTokens(text), ['14', '19', '21', '2026', '1200']);
    assert.deepEqual(dateTokens(text), ['2026', 'March']);
    assert.deepEqual(citationTokens(text), ['article 14', 'article 19', 'article 21', 'NCST']);
  });

  it('strips markdown for scanning without touching the note itself', () => {
    const md = '**Bold** and [a link](https://x.test/9) and `code`.';
    assert.equal(stripMarkdown(md).includes('9'), false);
    assert.equal(stripMarkdown(md).includes('a link'), true);
  });
});
