/**
 * Phase 4 seams: the handoffs between modules, not the modules.
 *
 * Same charter as `phase2-integration.test.ts` and `phase3-integration.test.ts`,
 * both of which caught defects their unit suites structurally could not. A unit
 * test proves a function is right about its own inputs. It cannot prove two
 * functions agree about the value passing between them, and every module here
 * was built by a different agent working from a written interface.
 *
 * Nothing below re-tests internals. Each case wires two real modules together
 * and asserts the value crossing between them is one the receiver accepts.
 *
 * ## What this file does NOT cover
 *
 * The request body. That seam crosses a package boundary, so it lives in
 * `ca-request-contract.test.ts` with a counterpart under `server/tests/`. It is
 * also the seam that actually broke: every field name differed and `/ca/digest`
 * answered 400 to every request, with both suites green.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { digestBudget, estimateReadMinutes } from '../src/lib/ca-budget';
import { buildMonthlyCompilation, type CompilationSection } from '../src/lib/ca-compile';
import { mapDigestItem, type CaMapContext, type IngestableCaItem } from '../src/lib/ca-map';
import { itemCapFor } from '../src/lib/ca-request';
import { buildTagIndex, sectionKeyOf, tagVocabulary, type TagFact } from '../src/lib/ca-tags';
import { CA_RULES, type CaItemFacts } from '../src/lib/ca-types';
import { canKeep, draftCardFromItem } from '../src/lib/flashcards';
import type { PaperValue } from '../src/lib/papers';
import type { TopicStatus } from '../src/lib/syllabus-coverage';

/* ------------------------------------------------------------------ fixtures */

let nextId = 0;
function leaf(
  paper: PaperValue,
  topic: string,
  slug: string,
  status: TopicStatus = 'in_progress',
  subtopic: string | null = null,
): TagFact {
  nextId += 1;
  return { id: nextId, slug, paper, topic, subtopic, status, retiredAt: null };
}

const SYLLABUS: TagFact[] = [
  leaf('gs2', 'Indian Constitution', 'gs2-fundamental-rights', 'in_progress', 'Fundamental Rights'),
  leaf('gs2', 'Indian Constitution', 'gs2-dpsp', 'in_progress', 'Directive Principles'),
  leaf('gs3', 'Environment', 'gs3-biodiversity', 'not_started', 'Biodiversity'),
  leaf('anthro_p2', 'Tribal India', 'ap2-scheduled-tribes', 'first_pass', 'Scheduled Tribes'),
];

const TAG_INDEX = buildTagIndex(SYLLABUS);

function context(overrides: Partial<CaMapContext> = {}): CaMapContext {
  return {
    date: '2026-09-07',
    tagIndex: TAG_INDEX,
    knownCanonicalUrls: new Set<string>(),
    knownFingerprints: new Set<string>(),
    ...overrides,
  };
}

/**
 * One `item` frame, in the SERVER's field names.
 *
 * Copied from `GroundedItem` in `server/src/ca/types.ts`, which is frozen and
 * is what `routes/ca.ts` serialises onto the wire. Written out here rather than
 * built from the app's own `IngestableCaItem`, because a fixture shaped like
 * the receiver proves only that the receiver reads itself.
 */
function serverItemFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: 'https://pib.gov.in/PressReleasePage.aspx?PRID=2098765?utm_source=rss',
    sourceUrl: 'https://pib.gov.in/PressReleasePage.aspx?PRID=2098765?utm_source=rss',
    canonicalUrl: 'https://pib.gov.in/PressReleasePage.aspx?PRID=2098765',
    sourceName: 'Press Information Bureau',
    publishedAt: '2026-09-06',
    headline: 'Cabinet approves revised Forest Rights implementation framework',
    kind: 'structural',
    noteMd:
      'The Cabinet approved a revised framework for implementing the Forest Rights Act. ' +
      'It moves title verification to the district level and sets a 90-day disposal clock.',
    sentenceEvidence: [0, 1],
    evidence: [
      { quote: 'The Cabinet approved a revised framework', at: 12 },
      { quote: 'a 90-day disposal clock', at: 240 },
    ],
    syllabusSlugs: ['gs2-fundamental-rights'],
    sectionKeys: [sectionKeyOf('anthro_p2', 'Tribal India')],
    anthro: {
      p1Slug: 'ap1-social-stratification',
      p2Slug: 'ap2-scheduled-tribes',
      usageLine: 'Use as a live instance of legal pluralism in tribal administration.',
    },
    headlineFingerprint: 'e4b1c9f2',
    ...overrides,
  };
}

/** The mapper's accepted output, or a failed assertion naming why it was not. */
function mapped(frame: Record<string, unknown> = serverItemFrame()): IngestableCaItem {
  const outcome = mapDigestItem(frame, context());
  assert.ok(outcome.ok, `mapper rejected a real server frame: ${JSON.stringify(outcome)}`);
  return outcome.item;
}

/* ------------------------------------------- seam 1: vocabulary <-> tag index */

describe('seam: what the server may tag with <-> what the device can resolve', () => {
  it('resolves every slug the vocabulary offers', () => {
    // Both are derived from the same `TagFact[]`, so this holds by construction
    // TODAY. It is asserted because the two derivations are independent: teach
    // `tagVocabulary` to offer retired topics, or change the section key format
    // in one of the two, and the server tags exactly as instructed while every
    // item lands untagged. Nothing throws, and the digest just quietly stops
    // linking to the syllabus.
    const vocabulary = tagVocabulary(SYLLABUS);
    assert.ok(vocabulary.length > 0);

    for (const entry of vocabulary) {
      assert.ok(
        TAG_INDEX.bySlug.has(entry.slug),
        `vocabulary offers "${entry.slug}" (${entry.level}) but the index cannot resolve it`,
      );
    }
  });

  it('never offers a retired topic', () => {
    const withRetired = [
      ...SYLLABUS,
      { ...leaf('gs1', 'Art and Culture', 'gs1-temple-architecture'), retiredAt: '2026-01-01' },
    ];
    const offered = tagVocabulary(withRetired).map((entry) => entry.slug);
    assert.equal(offered.includes('gs1-temple-architecture'), false);
    // And the shelf it was the only leaf of is gone too — offering a section
    // whose every leaf is retired spends a slot on dead material.
    assert.equal(offered.includes(sectionKeyOf('gs1', 'Art and Culture')), false);
  });
});

/* ------------------------------------ seam 2: server item frame -> app mapper */

describe('seam: the server`s item frame -> the device`s row', () => {
  it('accepts a frame in the server`s own field names', () => {
    const item = mapped();
    assert.equal(item.headline, serverItemFrame().headline);
    assert.equal(item.kind, 'structural');
    assert.equal(item.date, '2026-09-07', 'the DIGEST day comes from the context, not the wire');
    assert.equal(item.publishedAt, '2026-09-06', 'the SOURCE date comes from the wire');
  });

  it('reads `anthro` out of the nested object the server sends', () => {
    // The server nests these under `anthro`; the app stores three flat columns.
    // A rename on either side loses the optional's highest-value output with no
    // error anywhere — the Anthropology column simply renders empty.
    const item = mapped();
    assert.equal(item.anthroP1Slug, 'ap1-social-stratification');
    assert.equal(item.anthroP2Slug, 'ap2-scheduled-tribes');
    assert.match(item.anthroLink ?? '', /legal pluralism/);
  });

  it('reads evidence out of `{quote, at}` spans', () => {
    // The server carries an offset the device has no column for. Dropping it is
    // correct; failing to find `quote` inside the object is not.
    const item = mapped();
    assert.deepEqual(item.evidence.map((e) => e.quote), [
      'The Cabinet approved a revised framework',
      'a 90-day disposal clock',
    ]);
  });

  it('merges `syllabusSlugs` and `sectionKeys` into one resolved list', () => {
    // The server keeps them apart; the device resolves both through one index.
    // A section tag that resolved to nothing would cost the item its topic and
    // therefore its ability to become a flashcard.
    const item = mapped();
    assert.deepEqual(item.unknownTags, []);
    assert.equal(item.topicIds.length, 2, 'one leaf slug and one section key both resolved');
  });

  it('canonicalises the URL itself rather than trusting the wire`s', () => {
    // The device's duplicate window is keyed on THIS function's output, so two
    // canonicalisers would drift and re-deliver stories the server excluded.
    const item = mapped();
    assert.doesNotMatch(item.sourceUrlCanonical, /utm_source/);
  });

  it('rejects a note over the word budget the server also enforces', () => {
    // Both sides cap at `CA_RULES.maxNoteWords`. The device check is the one
    // that must hold: it is what a stale server build cannot talk it out of.
    const outcome = mapDigestItem(
      serverItemFrame({ noteMd: Array.from({ length: CA_RULES.maxNoteWords + 1 }, () => 'word').join(' ') }),
      context(),
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.reason, 'note_too_long');
  });
});

/* ------------------------------------------- seam 3: mapped item -> compilation */

describe('seam: an ingested row -> the monthly compilation', () => {
  /** The row as `db/ca.ts` reads it back. `insertCaItem` assigns the id. */
  function asFacts(item: IngestableCaItem, id = 1): CaItemFacts {
    return {
      id,
      date: item.date,
      publishedAt: item.publishedAt,
      headline: item.headline,
      sourceName: item.sourceName,
      sourceUrl: item.sourceUrl,
      kind: item.kind,
      noteMd: item.noteMd,
      evidence: item.evidence,
      syllabusTags: item.syllabusTags,
      topicIds: item.topicIds,
      anthroLink: item.anthroLink,
      anthroP1Slug: item.anthroP1Slug,
      anthroP2Slug: item.anthroP2Slug,
      readAt: null,
      digestId: 1,
    };
  }

  /** Sections built from the same syllabus the tag index was built from. */
  const SECTIONS: CompilationSection[] = [
    { paper: 'gs2', topic: 'Indian Constitution', topicIds: [1, 2] },
    { paper: 'gs3', topic: 'Environment', topicIds: [3] },
    { paper: 'anthro_p2', topic: 'Tribal India', topicIds: [4] },
  ];

  it('files an accepted item under a section, in full, exactly once', () => {
    const compilation = buildMonthlyCompilation(
      [asFacts(mapped())],
      SECTIONS,
      { month: '2026-09', generatedOn: '2026-10-01' },
    );

    const filed = compilation.papers
      .flatMap((paper) => paper.sections)
      .flatMap((section) => section.items);
    assert.equal(filed.length, 1, 'an item the mapper accepted must be compilable');

    const crossed = compilation.papers
      .flatMap((paper) => paper.sections)
      .flatMap((section) => section.crossReferences);
    assert.equal(crossed.length, 1, 'its second tag becomes a cross-reference, not a copy');
  });

  it('files by DIGEST day, so a month-end publication lands in the right month', () => {
    // The item was published on 31 August and delivered on 1 September. Filing
    // on `publishedAt` would move it out of the compilation she actually read.
    const august = mapped(
      serverItemFrame({ publishedAt: '2026-08-31', canonicalUrl: 'https://pib.gov.in/x' }),
    );
    const compilation = buildMonthlyCompilation(
      [{ ...asFacts(august), date: '2026-09-01' }],
      SECTIONS,
      { month: '2026-09', generatedOn: '2026-10-01' },
    );
    assert.equal(
      compilation.papers.flatMap((p) => p.sections).flatMap((s) => s.items).length,
      1,
    );
  });

  it('carries the anthropology pair through to the compilation', () => {
    const compilation = buildMonthlyCompilation(
      [asFacts(mapped())],
      SECTIONS,
      { month: '2026-09', generatedOn: '2026-10-01' },
    );
    assert.equal(compilation.anthropologyPairs.length, 1);
    assert.equal(compilation.anthropologyPairs[0]?.p2Slug, 'ap2-scheduled-tribes');
  });
});

/* --------------------------------------------- seam 4: the caps agree with each other */

describe('seam: three modules that each decide how big a digest is', () => {
  it('agrees between `itemCapFor` and `digestBudget`', () => {
    // `itemCapFor` sizes the REQUEST; `digestBudget` sizes what the screen
    // promises. Disagreeing means asking for eight and telling her six, or the
    // reverse — a number she can see being wrong about a number she cannot.
    //
    // 2026-09-12 is a Saturday, 2026-09-13 a Sunday.
    assert.equal(itemCapFor('2026-09-12'), digestBudget({ dayOfWeek: 6, recentReadRate: null }).items);
    assert.equal(itemCapFor('2026-09-13'), digestBudget({ dayOfWeek: 0, recentReadRate: null }).items);
    assert.equal(itemCapFor('2026-09-07'), digestBudget({ dayOfWeek: 1, recentReadRate: null }).items);
  });

  it('sizes Saturday off `weekendItemCap` and every other day off `dailyItemCap`', () => {
    assert.equal(itemCapFor('2026-09-12'), CA_RULES.weekendItemCap);
    assert.equal(itemCapFor('2026-09-07'), CA_RULES.dailyItemCap);
    // Sunday takes the WEEKDAY cap. `ca-budget.ts` explains why at length; the
    // assertion is here because `itemCapFor` calls its own helper `isWeekend`,
    // which returns true for Sunday, and only `CA_RULES` keeps them in step.
    assert.equal(digestBudget({ dayOfWeek: 0, recentReadRate: null }).items, CA_RULES.dailyItemCap);
  });

  it('keeps a full digest inside the reading half of the daily block', () => {
    // `ca-types.ts` splits the 20 minutes roughly 5 reading to 15 writing. A
    // full six-item digest that ate the whole block would leave nothing for the
    // part that does the work.
    const full = Array.from({ length: CA_RULES.dailyItemCap }, () => ({
      headline: serverItemFrame().headline as string,
      noteMd: serverItemFrame().noteMd as string,
    }));
    const minutes = estimateReadMinutes(full);
    assert.ok(minutes > 0);
    assert.ok(
      minutes < CA_RULES.dailyBudgetMinutes,
      `a full digest reads in ${minutes}min against a ${CA_RULES.dailyBudgetMinutes}min block`,
    );
  });

  it('asks for no more than the server will grant', () => {
    // MAX_DAILY_ITEMS in `server/src/ca/types.ts`. Raising a cap here without
    // raising it there is a 400 on Saturdays only.
    assert.ok(CA_RULES.weekendItemCap <= 8);
    assert.ok(CA_RULES.dailyItemCap >= 1);
  });
});

/* ------------------------------------------- seam 5: kept item -> flashcard row */

describe('seam: a kept item -> a row `flashcards` will accept', () => {
  const TOPIC = {
    id: 4,
    paper: 'anthro_p2',
    topic: 'Tribal India',
    subtopic: 'Scheduled Tribes',
  };

  it('produces every NOT NULL column the schema demands', () => {
    // `front`, `back`, `dueAt`, `intervalDays`, `easeFactor`, `repetitions` and
    // `lapses` are all NOT NULL in `db/schema.ts`. A draft missing one fails at
    // the INSERT, which happens behind a button she has already tapped.
    const item = mapped();
    const draft = draftCardFromItem({ ...item, id: 1 }, TOPIC, '2026-09-07');

    for (const column of ['front', 'back', 'dueAt'] as const) {
      assert.equal(typeof draft[column], 'string');
      assert.notEqual(draft[column].trim(), '', `${column} is NOT NULL and must not be blank`);
    }
    for (const column of ['intervalDays', 'easeFactor', 'repetitions', 'lapses'] as const) {
      assert.equal(typeof draft[column], 'number');
      assert.ok(Number.isFinite(draft[column]), `${column} must be a finite number`);
    }
    assert.equal(draft.syllabusTopicId, TOPIC.id);
    assert.equal(draft.caItemId, 1);
  });

  it('schedules the first recall for tomorrow, as a calendar day', () => {
    // Not "+24 hours". A card scheduled at 22:00 for a real day later is
    // invisible through the whole of the next morning's study block.
    const draft = draftCardFromItem({ ...mapped(), id: 1 }, TOPIC, '2026-09-07');
    assert.match(draft.dueAt, /^2026-09-08/);
    assert.equal(draft.repetitions, 0, 'reading a note is not a graded recall');
  });

  it('lets an item with a resolved topic through the keep gate, and caps the day', () => {
    const item = mapped();
    assert.ok(item.topicIds.length > 0, 'the mapper resolved a topic to build a cue from');

    const first = canKeep({ keptToday: 0, hasTopic: true, alreadyKept: false });
    assert.equal(first.allowed, true);

    const capped = canKeep({
      keptToday: CA_RULES.maxKeepsPerDay,
      hasTopic: true,
      alreadyKept: false,
    });
    assert.equal(capped.allowed, false);
    assert.notEqual(capped.reason.trim(), '', 'a disabled button that says nothing is a bug report');
  });

  it('refuses an untagged item, which is the case the mapper deliberately allows', () => {
    // An unknown slug never rejects an item — `ca-types.ts` is explicit that a
    // syllabus correction must not be able to empty the feed. The consequence
    // lands HERE: such an item is readable but has no topic to build a cue
    // from, so it cannot become a card.
    const untagged = mapDigestItem(
      serverItemFrame({ syllabusSlugs: ['gs9-not-a-real-slug'], sectionKeys: [] }),
      context(),
    );
    assert.ok(untagged.ok, 'an unknown tag must not reject the item');
    assert.deepEqual(untagged.item.topicIds, []);
    assert.deepEqual(untagged.item.unknownTags, ['gs9-not-a-real-slug']);

    const gate = canKeep({ keptToday: 0, hasTopic: false, alreadyKept: false });
    assert.equal(gate.allowed, false);
  });
});
