/**
 * Selection, which is where the digest earns its keep.
 *
 * Every test here is about a reason to say NO. The one positive property under
 * test is that under-delivery is reported as a normal outcome rather than
 * papered over — because the failure mode of a current-affairs system is never
 * "too few items", it is six mediocre ones crowding out the two that mattered.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.ANTHROPIC_API_KEY ??= 'sk-ant-test-not-real';
process.env.MODEL_EVALUATION ??= 'eval-model-1';
process.env.MODEL_BULK ??= 'bulk-model-1';
process.env.APP_BEARER_TOKEN ??= 'test-token';

const {
  DURABLE_KINDS,
  ITEM_KINDS,
  MAX_EVENT_ITEMS_PER_DAY,
  MAX_ITEMS_PER_SECTION_PER_WEEK,
  anthroLinkRateIsSuspicious,
  headlineFingerprint,
  isItemKind,
  prepareCandidates,
  sanitiseAnthro,
  scoreItem,
  selectItems,
} = await import('../src/ca/select.js');

type SelectionRequest = Parameters<typeof selectItems>[1];
type Item = Parameters<typeof selectItems>[0][number];

const SUBJECTS = [
  'inter-state water allocation',
  'the coastal regulation zone notification',
  'the tribal sub-plan outlay',
  'municipal solid waste rules',
  'the minimum support price mechanism',
  'appointments to the appellate tribunal',
  'the forest rights recognition process',
  'the fiscal transfer formula',
  'the cooperative sugar mill framework',
  'the district mineral foundation',
] as const;

function item(n: number, overrides: Partial<Item> = {}): Item {
  const subject = SUBJECTS[(n - 1) % SUBJECTS.length] as string;
  return {
    url: `https://example.test/story-${n}`,
    canonicalUrl: `https://example.test/story-${n}`,
    sourceUrl: `https://example.test/story-${n}`,
    sourceName: 'Example',
    publishedAt: '2026-09-06T04:00:00.000Z',
    headline: `Cabinet revises ${subject}`,
    kind: 'structural',
    noteMd: `The threshold for ${subject} was revised.`,
    sentenceEvidence: [0],
    evidence: [{ quote: `The threshold for ${subject} was revised.`, at: 10 }],
    sectionKeys: [`section-${n}`],
    syllabusSlugs: ['gs2/polity'],
    anthro: null,
    headlineFingerprint: '',
    ...overrides,
  } as Item;
}

function request(overrides: Partial<SelectionRequest> = {}): SelectionRequest {
  return {
    syllabusSlugs: ['gs2/polity', 'gs3/economy', 'anthro_p2/tribes'],
    maxItems: 6,
    seenCanonicalUrls: [],
    seenFingerprints: [],
    sectionCountsThisWeek: {},
    ...overrides,
  };
}

function reasons(outcome: ReturnType<typeof selectItems>): string[] {
  return outcome.drops.map((d) => d.reason);
}

/* ------------------------------------------------------------- the vocabulary */

describe('the kind vocabulary', () => {
  it('treats every kind but event as durable', () => {
    assert.deepEqual([...ITEM_KINDS].filter((k) => !DURABLE_KINDS.has(k)), ['event']);
    assert.equal(DURABLE_KINDS.size, 5);
  });

  it('recognises only the six kinds', () => {
    for (const kind of ITEM_KINDS) assert.equal(isItemKind(kind), true);
    assert.equal(isItemKind('announcement'), false);
    assert.equal(isItemKind(null), false);
  });
});

/* ------------------------------------- rule 1: no syllabus hook, no slot */

describe('the syllabus filter', () => {
  it('drops an item that resolves to nothing the request asked for', () => {
    // The highest-value filter in the system, and it is free. An item she
    // cannot file under something she is studying is an item she reads once.
    const outcome = selectItems([item(1, { syllabusSlugs: ['gs1/history'] })], request());
    assert.equal(outcome.kept.length, 0);
    assert.deepEqual(reasons(outcome), ['no_syllabus_tag']);
  });

  it('drops an item with no tags at all rather than letting it through untagged', () => {
    const outcome = selectItems([item(1, { syllabusSlugs: [] })], request());
    assert.equal(outcome.kept.length, 0);
    assert.deepEqual(reasons(outcome), ['no_syllabus_tag']);
  });

  it('keeps only the slugs the REQUEST supplied, discarding invented ones', () => {
    const outcome = selectItems(
      [item(1, { syllabusSlugs: ['gs2/polity', 'gs9/does-not-exist'] })],
      request(),
    );
    assert.deepEqual(outcome.kept[0]?.syllabusSlugs, ['gs2/polity']);
  });

  it('runs BEFORE the section cap, so the histogram names the real problem', () => {
    const outcome = selectItems(
      [item(1, { syllabusSlugs: ['gs1/history'], sectionKeys: ['full'] })],
      request({ sectionCountsThisWeek: { full: 3 } }),
    );
    assert.deepEqual(reasons(outcome), ['no_syllabus_tag']);
  });
});

/* ------------------------------------------- rule 2: durable, or the one event */

describe('the durability rule', () => {
  it('gives events exactly one slot a day', () => {
    const events = [1, 2, 3, 4].map((n) => item(n, { kind: 'event' }));
    const outcome = selectItems(events, request());

    assert.equal(outcome.kept.length, MAX_EVENT_ITEMS_PER_DAY);
    assert.equal(outcome.kept[0]?.kind, 'event');
    assert.deepEqual(reasons(outcome), ['event_only', 'event_only', 'event_only']);
  });

  it('lets every durable kind through without an event-style cap', () => {
    const items = [...DURABLE_KINDS].map((kind, i) => item(i + 1, { kind }));
    const outcome = selectItems(items, request({ maxItems: 8 }));
    assert.equal(outcome.kept.length, 5);
  });

  it('spends the single event slot on the best-ranked event, not the first seen', () => {
    // A cabinet decision is structural, a bilateral visit is an event. When two
    // events compete, ranking must decide — otherwise fetch order does.
    const weak = item(1, { kind: 'event', canonicalUrl: 'https://a.test/weak', evidence: [
      { quote: 'one', at: 0 },
    ] });
    const strong = item(2, {
      kind: 'event',
      canonicalUrl: 'https://a.test/strong',
      syllabusSlugs: ['gs2/polity', 'gs3/economy'],
      anthro: { p1Slug: 'p1/x', p2Slug: 'p2/y', usageLine: 'A line.' },
      evidence: [
        { quote: 'one', at: 0 },
        { quote: 'two', at: 4 },
        { quote: 'three', at: 8 },
      ],
    });
    const outcome = selectItems([weak, strong], request());
    assert.equal(outcome.kept.length, 1);
    assert.equal(outcome.kept[0]?.canonicalUrl, 'https://a.test/strong');
  });
});

/* --------------------------------------------------- rule 3: not a duplicate */

describe('duplicate suppression', () => {
  it('drops a canonical url already on the device', () => {
    const outcome = selectItems(
      [item(1)],
      request({ seenCanonicalUrls: ['https://example.test/story-1'] }),
    );
    assert.deepEqual(reasons(outcome), ['duplicate']);
  });

  it('drops the same story from a second outlet by headline fingerprint', () => {
    // The URL check cannot see this one, and it is the common case: three
    // outlets, one story, three different domains, the same words reordered.
    const a = item(1, { headline: 'Supreme Court quashes the electoral bonds scheme' });
    const b = item(2, {
      headline: 'Electoral bond scheme quashed: Supreme Court',
      canonicalUrl: 'https://other.test/story',
      sectionKeys: ['section-1'],
    });
    const outcome = selectItems([a, b], request());
    assert.equal(outcome.kept.length, 1);
    assert.deepEqual(reasons(outcome), ['duplicate']);
  });

  it('deduplicates within the run, not only against history', () => {
    const outcome = selectItems([item(1), item(1)], request());
    assert.equal(outcome.kept.length, 1);
    assert.deepEqual(reasons(outcome), ['duplicate']);
  });

  it('honours a fingerprint the caller already computed', () => {
    const outcome = selectItems(
      [item(1, { headlineFingerprint: 'known-print' })],
      request({ seenFingerprints: ['known-print'] }),
    );
    assert.deepEqual(reasons(outcome), ['duplicate']);
  });

  it('collapses word order and regular plurals but not different stories', () => {
    // Word order is what varies across outlets reporting the same thing, so a
    // SORTED fingerprint is the whole trick. It is crude on purpose: a false
    // positive costs one item, a false negative costs her reading the story
    // twice, and neither is worth a real stemmer.
    assert.equal(
      headlineFingerprint('Supreme Court quashes electoral bonds'),
      headlineFingerprint('Electoral bond quashed by the Supreme Court'),
    );
    assert.notEqual(
      headlineFingerprint('Supreme Court quashes electoral bonds'),
      headlineFingerprint('Cabinet clears the new telecom bill'),
    );
  });
});

/* --------------------------------------------------- rule 4: the section cap */

describe('the section cap', () => {
  it('refuses a section that already has its week', () => {
    // One running story must not eat a month.
    const outcome = selectItems(
      [item(1, { sectionKeys: ['polity'] })],
      request({ sectionCountsThisWeek: { polity: MAX_ITEMS_PER_SECTION_PER_WEEK } }),
    );
    assert.deepEqual(reasons(outcome), ['over_section_cap']);
  });

  it('counts items selected in THIS run against the same cap', () => {
    const items = [1, 2, 3, 4, 5].map((n) =>
      item(n, { sectionKeys: ['polity'], syllabusSlugs: ['gs2/polity'] }),
    );
    const outcome = selectItems(items, request({ maxItems: 8 }));
    assert.equal(outcome.kept.length, MAX_ITEMS_PER_SECTION_PER_WEEK);
    assert.equal(reasons(outcome).filter((r) => r === 'over_section_cap').length, 2);
  });

  it('does not let an untagged section become an unlimited bucket', () => {
    const items = [1, 2, 3, 4, 5].map((n) => item(n, { sectionKeys: [] }));
    const outcome = selectItems(items, request({ maxItems: 8 }));
    assert.equal(outcome.kept.length, MAX_ITEMS_PER_SECTION_PER_WEEK);
  });
});

/* ------------------------------------------------------ the anthropology pair */

describe('the anthropology theory-instance pair', () => {
  it('accepts a claim only when both halves and the usage line are real', () => {
    const good = { p1Slug: 'p1/kinship', p2Slug: 'p2/toda', usageLine: 'A deployable line.' };
    assert.deepEqual(sanitiseAnthro(good), { anthro: good, reason: null });
  });

  it('strips a concept with no Indian instance — that is the 240 answer', () => {
    const outcome = sanitiseAnthro({ p1Slug: 'p1/kinship', p2Slug: null, usageLine: 'Vague.' });
    assert.equal(outcome.anthro, null);
    assert.equal(outcome.reason, 'anthro_no_p2');
  });

  it('strips an instance with no concept and no usage line', () => {
    assert.equal(sanitiseAnthro({ p1Slug: null, p2Slug: 'p2/toda', usageLine: '' }).reason,
      'anthro_overreach');
  });

  it('treats an all-empty claim as no claim, not as a failure', () => {
    assert.deepEqual(sanitiseAnthro({ p1Slug: '', p2Slug: '', usageLine: '' }),
      { anthro: null, reason: null });
    assert.deepEqual(sanitiseAnthro(null), { anthro: null, reason: null });
  });

  it('KEEPS the item when the link is stripped — a weak link says nothing about the item', () => {
    const outcome = selectItems(
      [item(1, { anthro: { p1Slug: 'p1/kinship', p2Slug: null, usageLine: 'Vague.' } })],
      request(),
    );
    assert.equal(outcome.kept.length, 1, 'the item must survive');
    assert.equal(outcome.kept[0]?.anthro, null, 'the link must not');
    assert.deepEqual(reasons(outcome), ['anthro_no_p2']);
  });

  it('reports the link rate rather than trimming links to hit a ratio', () => {
    const linked = [1, 2, 3].map((n) =>
      item(n, { anthro: { p1Slug: 'p1/x', p2Slug: 'p2/y', usageLine: 'Line.' } }),
    );
    const outcome = selectItems([...linked, item(4)], request({ maxItems: 8 }));
    assert.equal(outcome.kept.length, 4);
    assert.equal(outcome.anthroLinkRate, 0.75);
    assert.equal(anthroLinkRateIsSuspicious(outcome.anthroLinkRate), true);
    assert.equal(anthroLinkRateIsSuspicious(0.25), false);
  });
});

/* ------------------------------------------------------- ranking and the cap */

describe('ranking and under-delivery', () => {
  it('ranks a judgment above an event', () => {
    const judgment = item(1, { kind: 'judgment' });
    const event = item(2, { kind: 'event' });
    assert.ok(scoreItem(judgment, request()) > scoreItem(event, request()));
  });

  it('rewards a second syllabus hook and a real anthropology pair', () => {
    const plain = item(1);
    const rich = item(1, {
      syllabusSlugs: ['gs2/polity', 'gs3/economy'],
      anthro: { p1Slug: 'p1/x', p2Slug: 'p2/y', usageLine: 'Line.' },
    });
    assert.ok(scoreItem(rich, request()) > scoreItem(plain, request()));
  });

  it('takes the top N and reports the rest as over the daily cap', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => item(n));
    const outcome = selectItems(items, request({ maxItems: 3 }));
    assert.equal(outcome.kept.length, 3);
    assert.equal(reasons(outcome).filter((r) => r === 'over_daily_cap').length, 5);
  });

  it('UNDER-DELIVERS on a quiet day without lowering a bar', () => {
    // Four items against a cap of six is a good answer, not a failure.
    const items = [1, 2, 3, 4].map((n) => item(n));
    const outcome = selectItems(items, request({ maxItems: 6 }));
    assert.equal(outcome.kept.length, 4);
    assert.equal(outcome.drops.length, 0);
  });

  it('is deterministic across runs over the same input', () => {
    const items = [1, 2, 3, 4, 5, 6, 7].map((n) => item(n, { kind: n % 2 ? 'report' : 'scheme' }));
    const a = selectItems(items, request({ maxItems: 4 })).kept.map((i) => i.canonicalUrl);
    const b = selectItems(items, request({ maxItems: 4 })).kept.map((i) => i.canonicalUrl);
    assert.deepEqual(a, b);
  });

  it('never mutates the items it was handed', () => {
    const original = item(1, { anthro: { p1Slug: 'p1/x', p2Slug: null, usageLine: 'V.' } });
    const snapshot = JSON.parse(JSON.stringify(original));
    selectItems([original], request());
    assert.deepEqual(JSON.parse(JSON.stringify(original)), snapshot);
  });
});

/* -------------------------------------------------- candidate preparation */

describe('candidate preparation', () => {
  const entry = (n: number, title: string) => ({
    url: `https://example.test/c-${n}`,
    canonicalUrl: `https://example.test/c-${n}`,
    sourceName: 'Example',
    title,
    lede: null,
    publishedAt: null,
    feedId: 'feed',
  });

  it('numbers candidates from zero so the model can return an index', () => {
    const prepared = prepareCandidates([entry(1, 'Alpha bill cleared'), entry(2, 'Beta rules issued')]);
    assert.deepEqual(prepared.map((c) => c.index), [0, 1]);
  });

  it('removes duplicates BEFORE the model sees them', () => {
    // A candidate list carrying the same story three times spends a third of
    // the model's attention choosing between identical options.
    const prepared = prepareCandidates([
      entry(1, 'Supreme Court quashes electoral bonds'),
      entry(2, 'Electoral bond quashed by the Supreme Court'),
      entry(3, 'Cabinet clears the telecom bill'),
    ]);
    assert.equal(prepared.length, 2);
  });

  it('drops candidates already delivered', () => {
    const prepared = prepareCandidates([entry(1, 'Alpha bill cleared')], {
      seenCanonicalUrls: ['https://example.test/c-1'],
    });
    assert.equal(prepared.length, 0);
  });

  it('caps the list so call one cannot be handed an unbounded sweep', () => {
    const many = Array.from({ length: 200 }, (_, i) => entry(i, `Distinct headline number ${i}`));
    assert.equal(prepareCandidates(many).length, 40);
    assert.equal(prepareCandidates(many, { limit: 5 }).length, 5);
  });
});
