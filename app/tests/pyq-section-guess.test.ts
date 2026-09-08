/**
 * The section proposer, against the REAL 438-leaf syllabus.
 *
 * Every case here runs on `SYLLABUS_V1` rather than a fixture. A fixture would
 * be written to agree with the code, and the property being defended is exactly
 * the one a fixture cannot show: that these rules survive contact with 86
 * sections whose headings overlap each other and whose bullets are lists.
 *
 * ## What is worth failing over
 *
 * Two things, in this order.
 *
 * 1. **A low-confidence stem gets NO proposal.** A wrong tag is worse than no
 *    tag and it is not close: an unmapped question still drills, it simply does
 *    not aim, while a mis-mapped one silently feeds `mcqWeakTopics`, the refill
 *    aim and every mentor prescription downstream, and nothing can later
 *    distinguish it from a good row. So the CSAT and comprehension cases below
 *    are the most important assertions in the file, not the least.
 * 2. **A stem that restates a bullet finds its section.** That is the whole
 *    value proposition — 86 candidates down to five, so that a person confirms
 *    in a second instead of scrolling 438 bullets.
 *
 * ## Measured accuracy
 *
 * Against 28 realistic stems written before the matcher was tuned (26 mappable,
 * 2 deliberately unmappable), restricted to the papers the exam actually
 * covers: 21 top-1 correct (75%), 0 wrong at the top, 7 refused. Against 8
 * adversarial non-syllabus stems scored over all 86 sections at once: 8 refused,
 * 0 false tags. The failure mode is UNDER-tagging by design, and the failures
 * are legible ones — see `it('refuses rather than reaches', …)` for the four
 * shapes they take.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SYLLABUS_V1 } from '../src/data/syllabus-v1';
import {
  DEFAULT_PROPOSAL_LIMIT,
  leavesOfSection,
  proposeSections,
  searchSections,
  sectionsOf,
  significantTerms,
  type SectionGuessEntry,
} from '../src/lib/pyq-section-guess';

/* ------------------------------------------------------------------ helpers */

const ALL = SYLLABUS_V1.entries;

/** The three papers a Prelims GS booklet draws on. See `data/pyq/types.ts`. */
const PRELIMS = ALL.filter((entry) => ['gs1', 'gs2', 'gs3'].includes(entry.paper));

function topKey(text: string, entries: readonly SectionGuessEntry[] = PRELIMS): string | null {
  const proposals = proposeSections(text, entries, DEFAULT_PROPOSAL_LIMIT);
  return proposals.length === 0 ? null : proposals[0].key;
}

function keys(text: string, entries: readonly SectionGuessEntry[] = PRELIMS): string[] {
  return proposeSections(text, entries, DEFAULT_PROPOSAL_LIMIT).map((p) => p.key);
}

/* ------------------------------------------------------ the refusal property */

describe('refusing a low-confidence stem', () => {
  /**
   * MUTATION-CHECKED. The single most important assertion here.
   *
   * A CSAT reasoning question, a comprehension question and an arithmetic
   * question sit under no syllabus leaf. `data/pyq/types.ts` says why that
   * matters: a hundred untagged CSAT questions dealt into GS sessions by the
   * `unseen_any` tier would look exactly like General Studies. The proposer's
   * job on these is to say nothing.
   *
   * Scored against ALL 86 sections rather than a paper-filtered subset, because
   * a caller that forgets to filter must still get silence here — the filter is
   * precision, not the safety rule.
   */
  it('proposes nothing for a stem the syllabus does not name', () => {
    const unmappable = [
      'If in a certain code language MONKEY is written as XDIJMN, how is TIGER written in that code?',
      'Directions: read the passage above and answer the question that follows. The author is most likely to agree with which one of the following statements?',
      'A train 150 metres long crosses a platform 250 metres long in 20 seconds. What is the speed of the train in kilometres per hour?',
      'A shopkeeper marks his goods 40 per cent above cost price and allows a discount of 25 per cent. What is his percentage profit?',
      'Arrange the following words in a meaningful logical order and select the correct sequence from the options given below.',
      'The average age of a group of eight persons is 30 years. When one person leaves the group the average becomes 28 years.',
    ];

    for (const stem of unmappable) {
      assert.deepEqual(
        proposeSections(stem, ALL, DEFAULT_PROPOSAL_LIMIT),
        [],
        `expected no proposal for: ${stem.slice(0, 60)}`,
      );
    }
  });

  it('proposes nothing for empty or termless text', () => {
    assert.deepEqual(proposeSections('', ALL), []);
    assert.deepEqual(proposeSections('   ', ALL), []);
    // Everything here is a stopword or under three characters, so the stem
    // normalises to no terms at all — the same state as an empty string.
    assert.deepEqual(proposeSections('is it in the of an at to', ALL), []);
  });

  it('proposes nothing when a stem shares one incidental word with a heading', () => {
    // 'Federalism and Devolution' carries 'federalism'; a sentence that uses the
    // word once and is about something else must not claim the section. This is
    // the rarity failure `headlines.ts` measured, arriving through a heading:
    // 824 of 1,163 label terms are carried by exactly one label, so a single
    // shared word is the norm rather than the signal.
    assert.equal(topKey('The lecture on federalism was cancelled because the hall was flooded.'), null);
  });

  it('honours a limit of zero without scoring anything', () => {
    assert.deepEqual(proposeSections('Non-Cooperation and Khilafat movements', PRELIMS, 0), []);
  });
});

/* ---------------------------------------------------------- the value property */

describe('proposing the right section', () => {
  /**
   * MUTATION-CHECKED. The other half of the bargain.
   *
   * Real UPSC stem shapes, each restating a bullet the way UPSC actually writes
   * them. If these stop landing at the top the tool is no better than scrolling,
   * and nobody will use it twice.
   */
  it('puts the right section first for stems that restate a bullet', () => {
    const cases: [stem: string, expected: string][] = [
      [
        'Consider the following statements about the Non-Cooperation Movement: 1. It was launched after the Rowlatt Act agitation and the Jallianwala Bagh massacre. 2. The Congress session at Nagpur in 1920 adopted the programme of non-cooperation.',
        'gs1:The Freedom Struggle',
      ],
      [
        'With reference to the Permanent Settlement introduced by Lord Cornwallis in 1793, consider the following statements about the land revenue demand fixed on the zamindars and its agrarian consequences.',
        'gs1:Modern Indian History',
      ],
      [
        'Which one of the following is a characteristic feature of the Nagara style of temple architecture found in northern India?',
        'gs1:Indian Art and Culture',
      ],
      [
        'Consider the following statements regarding the Directive Principles of State Policy: 1. They are enforceable by the courts. 2. They were borrowed from the Constitution of Ireland.',
        'gs2:Indian Constitution',
      ],
      [
        'Consider the following statements about the Election Commission of India: 1. It is a permanent constitutional body. 2. The Chief Election Commissioner can be removed in the same manner as a judge of the Supreme Court.',
        'gs2:Constitutional Bodies',
      ],
      [
        'With reference to the Right to Information Act, 2005, consider the following statements about the Central Information Commission and the exemptions available to public authorities.',
        'gs2:Governance, Transparency and Accountability',
      ],
      [
        'Consider the following statements regarding the Monetary Policy Committee of the Reserve Bank of India and the inflation targeting framework adopted in India.',
        'gs3:Indian Economy',
      ],
      [
        'Consider the following statements about the National Green Tribunal: 1. It was established under an Act of Parliament. 2. It has original jurisdiction over matters involving a substantial question relating to the environment.',
        'gs3:Environment and Biodiversity',
      ],
      [
        'Consider the following statements about money laundering and the Prevention of Money Laundering Act, and the role of the Financial Intelligence Unit.',
        'gs3:Internal Security',
      ],
      [
        'With reference to India’s space programme, consider the following statements about the Chandrayaan-3 mission and the soft landing of its lander module.',
        'gs3:Science and Technology',
      ],
    ];

    for (const [stem, expected] of cases) {
      assert.equal(topKey(stem), expected, `for: ${stem.slice(0, 60)}`);
    }
  });

  /**
   * An enumerated bullet is a list of separate topics, and a stem restates ONE
   * of them. Whole-label coverage cannot see that: 'plate tectonics' is 2 of the
   * 6 terms in 'Earth's interior, plate tectonics and rock systems', which is
   * 0.33 and below the gate. Splitting the bullet on its printed separators —
   * and requiring the fragment to match in FULL — is what recovers these four,
   * and it is the single change that moved the measured accuracy from 64% to
   * 75%.
   */
  it('matches one item of an enumerated bullet', () => {
    assert.equal(
      topKey('With reference to plate tectonics, consider the following statements about the formation of fold mountains at convergent plate boundaries.'),
      'gs1:Physical Geography of the World',
    );
    assert.equal(
      topKey('With reference to the anti-defection law in India, consider the following statements about the Tenth Schedule and the powers of the Speaker of the House to decide on disqualification.'),
      'gs2:Parliament and State Legislatures',
    );
    assert.equal(
      topKey('With reference to the Minimum Support Price announced by the Government of India for major crops, consider the following statements about its computation and the procurement that follows it.'),
      'gs3:Agriculture',
    );
    assert.equal(
      topKey('Consider the following statements regarding urbanisation in India and the problems of slums, congestion and municipal service delivery in large cities.'),
      'gs1:Social Issues',
    );
  });

  it('does not split a hyphenated term into two fragments', () => {
    // 'anti-defection' and 'Non-Cooperation' are single terms in this domain.
    // Splitting on the plain hyphen would turn the most specific phrases in the
    // syllabus into the least specific, so the enumeration separators
    // deliberately exclude it.
    assert.deepEqual(significantTerms('anti-defection'), ['anti', 'defection']);
    assert.equal(
      topKey('Consider the following statements about the anti-defection provisions and the disqualification of members.'),
      'gs2:Parliament and State Legislatures',
    );
  });

  it('keeps a genuinely two-sided question legible instead of picking a side', () => {
    // The Finance Commission is named by a leaf in both 'Constitutional Bodies'
    // and 'Federalism and Devolution'. The honest output is both, in the
    // shortlist, for a person to settle.
    const shortlist = keys(
      'With reference to the Finance Commission of India, consider the following statements: 1. It is constituted every fifth year by the President. 2. It recommends the distribution of the net proceeds of taxes between the Union and the States.',
    );
    assert.ok(shortlist.includes('gs2:Constitutional Bodies'), shortlist.join(' | '));
    assert.ok(shortlist.includes('gs2:Federalism and Devolution'), shortlist.join(' | '));
  });

  it('refuses rather than reaches, and the misses are legible', () => {
    // The four shapes of failure, pinned so a future loosening has to argue with
    // them. Every one of these returns nothing rather than something wrong, and
    // in the tool a person answers them with `/` or `s` in one keystroke.
    const misses = [
      // A stem that names an Act by number and uses none of the bullet's words.
      'With reference to the Government of India Act, 1935, consider the following statements: 1. It provided for the establishment of an All India Federation. 2. It introduced provincial autonomy and abolished dyarchy in the provinces.',
      // A scheme brand name. The syllabus names no scheme.
      'Which of the following are the stated objectives of the Pradhan Mantri Fasal Bima Yojana crop insurance scheme?',
      // A synonym the crude stemmer cannot bridge: 'highways' is not 'roads'.
      'With reference to the Bharatmala Pariyojana, consider the following statements about the development of national highways and economic corridors.',
      // A one-term fragment ('the Quad'), which is excluded on purpose: a
      // single common word matching in full is the accidental-overlap case.
      'Consider the following statements about the Quad grouping: 1. It comprises India, the United States, Japan and Australia. 2. It has a permanent secretariat.',
    ];
    for (const stem of misses) {
      assert.equal(topKey(stem), null, `expected a refusal for: ${stem.slice(0, 50)}`);
    }
  });

  it('works on a Mains paper when the candidate set is that paper', () => {
    const gs4 = ALL.filter((entry) => entry.paper === 'gs4');
    assert.equal(
      topKey(
        'With reference to the emotional intelligence of a civil servant, explain how self-awareness and empathy improve administrative decision making.',
        gs4,
      ),
      'gs4:Emotional Intelligence',
    );
  });
});

/* ------------------------------------------------------------------- shape */

describe('the shortlist itself', () => {
  it('returns at most `limit`, best first, and is deterministic', () => {
    const stem =
      'Consider the following statements about the Non-Cooperation Movement and the Khilafat agitation launched by the Congress.';
    const first = proposeSections(stem, PRELIMS, 3);
    assert.ok(first.length <= 3);
    for (let i = 1; i < first.length; i += 1) {
      assert.ok(first[i - 1].score >= first[i].score, 'not sorted by score');
    }
    // Re-running must produce the identical order. A session that re-ordered its
    // own options between runs would make a resumed session's muscle memory
    // wrong, which is a mis-keystroke waiting to happen.
    assert.deepEqual(proposeSections(stem, PRELIMS, 3), first);
  });

  it('carries the evidence that makes a wrong proposal dismissable', () => {
    const [top] = proposeSections(
      'Consider the following statements about the Non-Cooperation and Khilafat movements of 1920.',
      PRELIMS,
      1,
    );
    assert.equal(top.key, 'gs1:The Freedom Struggle');
    // The label that matched, verbatim, and the terms of it the stem restated.
    // Without these the shortlist is five section names and a number, and the
    // human has to re-derive the reasoning for every one of them.
    assert.ok(top.evidence.length > 0);
    assert.ok(top.matched.length > 0);
    assert.ok(top.matched.every((term) => significantTerms(top.evidence).includes(term)));
  });

  it('only ever proposes a section that exists in the entries it was given', () => {
    const valid = new Set(sectionsOf(PRELIMS).map((section) => section.key));
    const stems = [
      'Consider the following statements about inflation and monetary policy in India.',
      'Discuss the impact of climate change on the Indian monsoon and on agriculture.',
      'What are the challenges of urbanisation and the delivery of municipal services?',
    ];
    for (const stem of stems) {
      for (const proposal of proposeSections(stem, PRELIMS, 10)) {
        assert.ok(valid.has(proposal.key), `${proposal.key} is not a section of the candidate set`);
        assert.ok(['gs1', 'gs2', 'gs3'].includes(proposal.paper));
      }
    }
  });
});

/* ------------------------------------------------------- the leaf and search */

describe('the second step', () => {
  it('narrows 438 leaves to one section of between two and thirteen', () => {
    const sections = sectionsOf(ALL);
    assert.equal(sections.length, 86);
    assert.equal(ALL.length, 438);
    for (const section of sections) {
      const leaves = leavesOfSection(ALL, section.key);
      assert.ok(leaves.length >= 2 && leaves.length <= 13, `${section.key} has ${leaves.length}`);
      assert.deepEqual(
        leaves.map((leaf) => leaf.slug),
        section.leaves.map((leaf) => leaf.slug),
      );
    }
  });

  it('only ever offers slugs that exist in the syllabus', () => {
    // The tool writes `leaf.slug` verbatim into `syllabusSlug`, so this is the
    // whole of "never invent a slug" at the source. A slug that is not in
    // `SYLLABUS_V1` is a row the seeder will never match.
    const valid = new Set(ALL.map((entry) => entry.slug));
    for (const section of sectionsOf(ALL)) {
      for (const leaf of leavesOfSection(ALL, section.key)) {
        assert.ok(valid.has(leaf.slug), `${leaf.slug} is not a syllabus slug`);
      }
    }
  });

  it('returns nothing for a section key no entry produces', () => {
    // Reachable only when a syllabus correction lands under a resumed session.
    // That should cost one question, not the session, so it is [] and not a throw.
    assert.deepEqual(leavesOfSection(ALL, 'gs9:Nonexistent Section'), []);
  });

  it('searches sections by name, so a wrong shortlist is not a forced skip', () => {
    const found = searchSections(PRELIMS, 'security');
    assert.deepEqual(found.map((section) => section.key), ['gs3:Internal Security']);
    // A paper name works too — it is the other way a person thinks about this.
    assert.ok(searchSections(ALL, 'anthro_p2').length > 0);
    assert.deepEqual(searchSections(ALL, '   '), []);
  });
});

/* -------------------------------------------------------------- tokenisation */

describe('significantTerms', () => {
  it('normalises plural and tense but not derivation', () => {
    assert.deepEqual(significantTerms('movements'), ['movement']);
    assert.deepEqual(significantTerms('policies'), ['policy']);
    // Documented limit, not an oversight: 'India' and 'Indian' stay apart, and
    // so do 'nationalism' and 'nationalist'. Loosening this buys matches at the
    // price of false tags, which is the wrong trade for this tool.
    assert.notDeepEqual(significantTerms('Indian'), significantTerms('India'));
  });

  it('drops stopwords, punctuation and very short words', () => {
    assert.deepEqual(significantTerms('the Act of 1935 — is it?'), ['act', '1935']);
    assert.deepEqual(significantTerms('Representation of People’s Act'), [
      'representation',
      'people',
      'act',
    ]);
  });
});
