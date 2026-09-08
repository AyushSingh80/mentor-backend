import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildMonthlyCompilation,
  monthLabel,
  type CompilationSection,
} from '../src/lib/ca-compile';
import type { CaItemFacts } from '../src/lib/ca-types';

/* ------------------------------------------------------------- fixtures */

let nextId = 1;

function item(overrides: Partial<CaItemFacts> & { date: string }): CaItemFacts {
  return {
    id: nextId++,
    publishedAt: null,
    headline: 'A headline',
    sourceName: 'The Hindu',
    sourceUrl: 'https://example.test/a',
    kind: 'structural',
    noteMd: 'What changed, in ninety words or fewer.',
    evidence: [],
    syllabusTags: [],
    topicIds: [],
    anthroLink: null,
    anthroP1Slug: null,
    anthroP2Slug: null,
    readAt: null,
    digestId: 1,
    ...overrides,
  };
}

/** Three sections across two papers, with disjoint topic ids. */
const SECTIONS: readonly CompilationSection[] = [
  { paper: 'gs2', topic: 'Polity and Governance', topicIds: [10, 11] },
  { paper: 'gs3', topic: 'Indian Economy', topicIds: [20] },
  { paper: 'anthro_p2', topic: 'Tribal India', topicIds: [30] },
];

const OPTS = { month: '2026-11', generatedOn: '2026-12-01' } as const;

/* -------------------------------------------------------- month boundary */

describe('buildMonthlyCompilation — the month boundary', () => {
  /**
   * THE regression this file exists for.
   *
   * `date` is the digest day; `publishedAt` is when the source published. They
   * disagree most often at exactly a month boundary — a Sunday judgment lands
   * in Monday's digest — and filing on the wrong one silently misplaces items
   * in the artefact she carries into an exam.
   */
  it('files an October publication delivered in November under November', () => {
    const late = item({
      date: '2026-11-01',
      publishedAt: '2026-10-31T18:30:00Z',
      headline: 'Judgment reported on the 31st, delivered on the 1st',
      topicIds: [10],
    });

    const november = buildMonthlyCompilation([late], SECTIONS, OPTS);
    assert.equal(november.itemCount, 1, 'delivered in November, so it belongs to November');
    assert.match(november.markdown, /delivered on the 1st/);

    // And the converse: it must NOT also appear in October's compilation.
    const october = buildMonthlyCompilation([late], SECTIONS, {
      month: '2026-10',
      generatedOn: '2026-11-01',
    });
    assert.equal(october.itemCount, 0, 'publishedAt must not decide the filing');
  });

  it('files a November publication delivered in December under December', () => {
    const early = item({
      date: '2026-12-01',
      publishedAt: '2026-11-30T20:00:00Z',
      topicIds: [10],
    });

    assert.equal(buildMonthlyCompilation([early], SECTIONS, OPTS).itemCount, 0);
    assert.equal(
      buildMonthlyCompilation([early], SECTIONS, { month: '2026-12', generatedOn: '2026-12-31' })
        .itemCount,
      1,
    );
  });

  it("prints the source's own date only when it disagrees with the filing day", () => {
    const disagrees = buildMonthlyCompilation(
      [item({ date: '2026-11-01', publishedAt: '2026-10-31T18:30:00Z', topicIds: [10] })],
      SECTIONS,
      OPTS,
    );
    assert.match(disagrees.markdown, /published 2026-10-31/, 'the source date must not be lost');

    const agrees = buildMonthlyCompilation(
      [item({ date: '2026-11-04', publishedAt: '2026-11-04T09:00:00Z', topicIds: [10] })],
      SECTIONS,
      OPTS,
    );
    assert.doesNotMatch(agrees.markdown, /published 2026-11-04/, 'no point printing it twice');
  });

  /**
   * `new Date('2026-11')` is UTC midnight rendered in the device zone, which in
   * Asia/Kolkata is still October. The label is a lookup for that reason.
   */
  it('labels a month without going through Date', () => {
    assert.equal(monthLabel('2026-11'), 'November 2026');
    assert.equal(monthLabel('2026-01'), 'January 2026');
    assert.equal(monthLabel('2026-12'), 'December 2026');
    assert.equal(monthLabel('nonsense'), 'nonsense', 'a bad month must not crash the document');
    assert.equal(monthLabel('2026-13'), '2026-13');
  });
});

/* -------------------------------------------------------- empty sections */

describe('buildMonthlyCompilation — the empty-sections list', () => {
  /**
   * Not filler. A section with nothing in it means either a genuinely quiet
   * month or a source allowlist that does not reach it — and only the second
   * is a fixable bug. Omitting the section makes the two indistinguishable.
   */
  it('names every section that saw nothing, and only those', () => {
    const compilation = buildMonthlyCompilation(
      [item({ date: '2026-11-03', topicIds: [10] })],
      SECTIONS,
      OPTS,
    );

    const empty = compilation.emptySections.map((s) => s.topic);
    assert.deepEqual(empty, ['Indian Economy', 'Tribal India']);
    assert.ok(!empty.includes('Polity and Governance'), 'a populated section is not empty');

    assert.match(compilation.markdown, /## Sections with no material this month/);
    assert.match(compilation.markdown, /- Indian Economy/);
    assert.match(compilation.markdown, /- Tribal India/);
    assert.match(compilation.markdown, /2 of 3 sections saw nothing/);
  });

  it('counts a section reached only by a secondary tag as having material', () => {
    // One item, primary tag in Polity, secondary in Economy. The Economy
    // section has live material even though the item is written out elsewhere.
    const compilation = buildMonthlyCompilation(
      [item({ date: '2026-11-03', topicIds: [10, 20] })],
      SECTIONS,
      OPTS,
    );

    assert.deepEqual(
      compilation.emptySections.map((s) => s.topic),
      ['Tribal India'],
    );
    assert.match(compilation.markdown, /Also tagged here, written out in full elsewhere/);
  });

  it('reports every section as empty when the month produced nothing', () => {
    const compilation = buildMonthlyCompilation([], SECTIONS, OPTS);
    assert.equal(compilation.emptySections.length, 3);
    assert.match(compilation.markdown, /3 of 3 sections saw nothing/);
  });

  it('says so plainly when every section has material', () => {
    const compilation = buildMonthlyCompilation(
      [
        item({ date: '2026-11-03', topicIds: [10] }),
        item({ date: '2026-11-04', topicIds: [20] }),
        item({ date: '2026-11-05', topicIds: [30] }),
      ],
      SECTIONS,
      OPTS,
    );
    assert.deepEqual(compilation.emptySections, []);
    assert.match(compilation.markdown, /Every syllabus section saw at least one item/);
  });
});

/* ---------------------------------------------------------- anthropology */

describe('buildMonthlyCompilation — the Anthropology pairs', () => {
  /**
   * The rubric credits a P1 concept carried onto a P2 Indian instance. Half a
   * link earns nothing, so listing a half-link would teach the wrong shape.
   */
  it('lists only items carrying BOTH slugs', () => {
    const compilation = buildMonthlyCompilation(
      [
        item({
          date: '2026-11-02',
          headline: 'Both sides',
          topicIds: [30],
          anthroP1Slug: 'p1-kinship-descent',
          anthroP2Slug: 'p2-tribal-land-alienation',
          anthroLink: 'Descent rules explain the inheritance claim in the notified area.',
        }),
        item({
          date: '2026-11-03',
          headline: 'P1 only',
          topicIds: [30],
          anthroP1Slug: 'p1-social-stratification',
          anthroP2Slug: null,
        }),
        item({
          date: '2026-11-04',
          headline: 'P2 only',
          topicIds: [30],
          anthroP1Slug: null,
          anthroP2Slug: 'p2-forest-rights-act',
        }),
        item({
          date: '2026-11-05',
          headline: 'Neither',
          topicIds: [30],
        }),
        item({
          date: '2026-11-06',
          headline: 'Blank strings are not slugs',
          topicIds: [30],
          anthroP1Slug: '   ',
          anthroP2Slug: 'p2-something',
        }),
      ],
      SECTIONS,
      OPTS,
    );

    assert.deepEqual(
      compilation.anthropologyPairs.map((p) => p.headline),
      ['Both sides'],
    );
    assert.match(compilation.markdown, /\*\*p1-kinship-descent\*\* to \*\*p2-tribal-land-alienation\*\*/);
    assert.doesNotMatch(compilation.markdown, /p1-social-stratification/);
    assert.doesNotMatch(compilation.markdown, /p2-forest-rights-act/);
  });

  it('names the section even when the month produced no complete pair', () => {
    const compilation = buildMonthlyCompilation(
      [item({ date: '2026-11-02', topicIds: [10] })],
      SECTIONS,
      OPTS,
    );
    assert.deepEqual(compilation.anthropologyPairs, []);
    assert.match(compilation.markdown, /## Anthropology — Paper 1 concept to Paper 2 instance/);
    assert.match(compilation.markdown, /No item this month carried both/);
  });

  /** Pairs are not tables — the in-app renderer has no table support. */
  it('renders pairs as bullets the in-app markdown renderer can display', () => {
    const compilation = buildMonthlyCompilation(
      [
        item({
          date: '2026-11-02',
          topicIds: [30],
          anthroP1Slug: 'p1-a',
          anthroP2Slug: 'p2-b',
        }),
      ],
      SECTIONS,
      OPTS,
    );
    assert.doesNotMatch(compilation.markdown, /\|\s*---/, 'no pipe tables anywhere');
    assert.match(compilation.markdown, /^- \*\*p1-a\*\* to \*\*p2-b\*\*/m);
  });
});

/* ------------------------------------------------------------ determinism */

describe('buildMonthlyCompilation — determinism', () => {
  it('produces identical bytes for identical input and a fixed generatedOn', () => {
    const items = [
      item({ date: '2026-11-05', headline: 'Second', topicIds: [20] }),
      item({ date: '2026-11-02', headline: 'First', topicIds: [10] }),
      item({
        date: '2026-11-09',
        headline: 'Third',
        topicIds: [30],
        anthroP1Slug: 'p1-x',
        anthroP2Slug: 'p2-y',
      }),
    ];

    const a = buildMonthlyCompilation(items, SECTIONS, OPTS);
    const b = buildMonthlyCompilation(items, SECTIONS, OPTS);
    assert.equal(a.markdown, b.markdown);

    // Input order must not change the output — the module sorts by (date, id).
    const shuffled = buildMonthlyCompilation([items[2]!, items[0]!, items[1]!], SECTIONS, OPTS);
    assert.equal(shuffled.markdown, a.markdown, 'input order must not leak into the document');

    assert.ok(
      a.markdown.indexOf('First') < a.markdown.indexOf('Second'),
      'items run in date order within the document',
    );
  });

  it('stamps only the injected generatedOn, never the clock', () => {
    const items = [item({ date: '2026-11-02', topicIds: [10] })];
    const a = buildMonthlyCompilation(items, SECTIONS, { month: '2026-11', generatedOn: '2026-12-01' });
    const b = buildMonthlyCompilation(items, SECTIONS, { month: '2026-11', generatedOn: '2027-01-15' });

    assert.match(a.markdown, /Generated on 2026-12-01/);
    assert.match(b.markdown, /Generated on 2027-01-15/);
    // The date is the ONLY difference. Anything else varying means a hidden clock.
    assert.equal(a.markdown.replace('2026-12-01', 'X'), b.markdown.replace('2027-01-15', 'X'));
  });

  it('names the file after the month so a listing sorts chronologically', () => {
    assert.equal(buildMonthlyCompilation([], SECTIONS, OPTS).fileName, 'current-affairs-2026-11.md');
  });
});

/* ----------------------------------------------------------- empty month */

describe('buildMonthlyCompilation — an empty month', () => {
  /**
   * The week before an exam is not the moment to discover the generator throws
   * on a month she was on leave for.
   */
  it('produces a valid document rather than crashing', () => {
    const compilation = buildMonthlyCompilation([], SECTIONS, OPTS);

    assert.equal(compilation.itemCount, 0);
    assert.deepEqual(compilation.papers, []);
    assert.deepEqual(compilation.anthropologyPairs, []);
    assert.deepEqual(compilation.unfiled, []);

    assert.match(compilation.markdown, /^# Current affairs — November 2026$/m);
    assert.match(compilation.markdown, /- \*\*Items:\*\* 0/);
    assert.match(compilation.markdown, /## Nothing was filed this month/);
    // A month with no items must not be reported as a quiet month by omission.
    assert.match(compilation.markdown, /check the digest history for failed runs/);
    assert.match(compilation.markdown, /- \*\*Sources:\*\* none recorded/);
    assert.ok(compilation.markdown.length > 200, 'a document, not an empty string');
  });

  it('survives an empty section list as well as an empty month', () => {
    const compilation = buildMonthlyCompilation([], [], OPTS);
    assert.deepEqual(compilation.emptySections, []);
    assert.match(compilation.markdown, /Sections with material:\*\* 0 of 0/);
  });
});

/* --------------------------------------------------------------- filing */

describe('buildMonthlyCompilation — filing and provenance', () => {
  it('prints an item that resolved to no known section rather than dropping it', () => {
    const compilation = buildMonthlyCompilation(
      [
        item({
          date: '2026-11-07',
          headline: 'Tagged against a slug this build does not know',
          topicIds: [],
          syllabusTags: ['gs2-some-new-slug'],
        }),
      ],
      SECTIONS,
      OPTS,
    );

    assert.equal(compilation.unfiled.length, 1);
    assert.equal(compilation.itemCount, 1, 'an unfiled item is still an item in the month');
    assert.match(compilation.markdown, /## Unfiled/);
    assert.match(compilation.markdown, /Tagged against a slug this build does not know/);
    assert.match(compilation.markdown, /gs2-some-new-slug/, 'the raw tag is the actionable part');
    assert.match(compilation.markdown, /- \*\*Unfiled items:\*\* 1/);
  });

  it('writes an item out once, under its primary tag', () => {
    const compilation = buildMonthlyCompilation(
      [item({ date: '2026-11-03', headline: 'Cross tagged', topicIds: [20, 10] })],
      SECTIONS,
      OPTS,
    );

    const full = compilation.markdown.match(/#### 2026-11-03 — Cross tagged/g) ?? [];
    assert.equal(full.length, 1, 'a 130-item compilation must not print items twice');

    // Primary is the first resolvable topic id, which here is Economy.
    const economy = compilation.papers.find((p) => p.paper === 'gs3');
    assert.equal(economy?.sections[0]?.items.length, 1);
    const polity = compilation.papers.find((p) => p.paper === 'gs2');
    assert.equal(polity?.sections[0]?.items.length, 0);
    assert.equal(polity?.sections[0]?.crossReferences.length, 1);
  });

  it('orders papers by the syllabus, not by first appearance', () => {
    const compilation = buildMonthlyCompilation(
      [
        item({ date: '2026-11-02', topicIds: [30] }),
        item({ date: '2026-11-03', topicIds: [10] }),
        item({ date: '2026-11-04', topicIds: [20] }),
      ],
      SECTIONS,
      OPTS,
    );
    assert.deepEqual(
      compilation.papers.map((p) => p.paper),
      ['gs2', 'gs3', 'anthro_p2'],
    );
  });

  it('keeps a headline containing a newline from restructuring the document', () => {
    const compilation = buildMonthlyCompilation(
      [item({ date: '2026-11-03', headline: 'Broken\n\n## Injected heading', topicIds: [10] })],
      SECTIONS,
      OPTS,
    );
    assert.match(compilation.markdown, /#### 2026-11-03 — Broken ## Injected heading/);
    assert.doesNotMatch(compilation.markdown, /^## Injected heading$/m);
  });

  it('carries the source URL through, so a claim stays checkable from the file', () => {
    const compilation = buildMonthlyCompilation(
      [item({ date: '2026-11-03', topicIds: [10], sourceUrl: 'https://example.test/judgment' })],
      SECTIONS,
      OPTS,
    );
    assert.match(compilation.markdown, /Source: https:\/\/example\.test\/judgment/);
    assert.match(compilation.markdown, /- \*\*Sources:\*\* The Hindu/);
  });

  it('counts distinct digest days, not items', () => {
    const compilation = buildMonthlyCompilation(
      [
        item({ date: '2026-11-03', topicIds: [10] }),
        item({ date: '2026-11-03', topicIds: [10] }),
        item({ date: '2026-11-04', topicIds: [10] }),
      ],
      SECTIONS,
      OPTS,
    );
    assert.match(compilation.markdown, /- \*\*Digest days:\*\* 2/);
    assert.match(compilation.markdown, /- \*\*Items:\*\* 3/);
  });
});
