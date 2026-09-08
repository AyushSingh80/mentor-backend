/**
 * The vocabulary the server is constrained to, and the resolution of what it
 * sends back.
 *
 * Two properties are worth more than the rest and both are tested here:
 *
 * - The payload is BOUNDED and correctly biased. Every section is always
 *   offered; leaves are offered only for sections she has actually started. A
 *   body whose size grew with her progress would make the digest slower and
 *   more expensive over eighteen months precisely as she made headway.
 * - An unknown slug NEVER rejects anything. It is reported and nothing else.
 *   `ca-types.ts` states the reason on `TagResolution.unknown`, and it is the
 *   same one `mcq-generate-map` gives: if a key this build has not learned
 *   about yet could reject a payload, one syllabus correction on the server
 *   would become a total outage on the device — an offline failure caused by
 *   being online.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EMPTY_TAG_INDEX,
  MAX_VOCABULARY_ENTRIES,
  VOCABULARY_BUDGET_BYTES,
  buildTagIndex,
  isStarted,
  resolveTags,
  sectionKeyOf,
  tagVocabulary,
  type TagFact,
} from '../src/lib/ca-tags';
import type { PaperValue } from '../src/lib/papers';
import type { TopicStatus } from '../src/lib/syllabus-coverage';

/* ------------------------------------------------------------------ helpers */

let nextId = 0;

function leaf(
  paper: PaperValue,
  topic: string,
  slug: string,
  status: TopicStatus = 'not_started',
  overrides: Partial<TagFact> = {},
): TagFact {
  nextId += 1;
  return {
    id: nextId,
    slug,
    paper,
    topic,
    subtopic: `${slug} bullet`,
    status,
    retiredAt: null,
    ...overrides,
  };
}

/** Two papers, four sections, one of which she has started. */
function syllabus(): TagFact[] {
  return [
    leaf('gs1', 'Modern Indian History', 'gs1-modern-history-1857', 'first_pass'),
    leaf('gs1', 'Modern Indian History', 'gs1-modern-history-inc', 'in_progress'),
    leaf('gs1', 'Indian Society', 'gs1-society-urbanisation'),
    leaf('gs1', 'Indian Society', 'gs1-society-diversity'),
    leaf('gs2', 'Polity', 'gs2-polity-fr', 'revised'),
    leaf('gs2', 'Polity', 'gs2-polity-dpsp'),
    leaf('gs2', 'Governance', 'gs2-governance-egov'),
  ];
}

/* --------------------------------------------------------------- vocabulary */

describe('tagVocabulary — what the server is allowed to tag with', () => {
  it('offers every section, whether or not she has started it', () => {
    const entries = tagVocabulary(syllabus());
    const sections = entries.filter((entry) => entry.level === 'section').map((e) => e.slug);

    assert.deepEqual(sections.sort(), [
      sectionKeyOf('gs1', 'Indian Society'),
      sectionKeyOf('gs1', 'Modern Indian History'),
      sectionKeyOf('gs2', 'Governance'),
      sectionKeyOf('gs2', 'Polity'),
    ].sort());
  });

  it('offers leaves ONLY for sections she has started', () => {
    const entries = tagVocabulary(syllabus());
    const leaves = entries.filter((entry) => entry.level === 'leaf').map((e) => e.slug);

    // Modern Indian History has a `first_pass` leaf and Polity a `revised` one,
    // so both sections travel whole — one started leaf is enough.
    assert.deepEqual(leaves.sort(), [
      'gs1-modern-history-1857',
      'gs1-modern-history-inc',
      'gs2-polity-dpsp',
      'gs2-polity-fr',
    ]);

    // Nothing from a section she has never opened.
    assert.ok(!leaves.includes('gs1-society-urbanisation'));
    assert.ok(!leaves.includes('gs2-governance-egov'));
  });

  it('counts every started status, and only those', () => {
    for (const status of ['in_progress', 'first_pass', 'revised'] as const) {
      assert.equal(isStarted(status), true, `${status} means she has opened it`);
    }
    assert.equal(isStarted('not_started'), false);
  });

  it('drops retired topics from both halves', () => {
    const facts = syllabus();
    // Retire the whole of Polity — no longer examinable, so tagging today's
    // news to it would spend a slot linking to dead material.
    for (const fact of facts) {
      if (fact.topic === 'Polity') fact.retiredAt = '2026-01-01T00:00:00.000Z';
    }

    const slugs = tagVocabulary(facts).map((entry) => entry.slug);
    assert.ok(!slugs.includes(sectionKeyOf('gs2', 'Polity')));
    assert.ok(!slugs.includes('gs2-polity-fr'));
  });

  it('labels a leaf by its own bullet and a section by its heading', () => {
    const entries = tagVocabulary(syllabus());
    const section = entries.find((entry) => entry.slug === sectionKeyOf('gs2', 'Polity'));
    const bullet = entries.find((entry) => entry.slug === 'gs2-polity-fr');

    assert.equal(section?.label, 'Polity');
    assert.equal(bullet?.label, 'gs2-polity-fr bullet');
    assert.equal(bullet?.paper, 'gs2');
  });

  it('falls back to the section heading when a leaf carries no bullet text', () => {
    // `TopicFact` has no `subtopic`, so a caller reading through
    // `db/syllabus.ts` legitimately supplies none.
    const facts = [leaf('gs1', 'Modern Indian History', 'gs1-mh-1857', 'in_progress', {
      subtopic: null,
    })];
    const bullet = tagVocabulary(facts).find((entry) => entry.level === 'leaf');
    assert.equal(bullet?.label, 'Modern Indian History');
  });

  it('is deterministic — two runs over one syllabus produce one payload', () => {
    const facts = syllabus();
    assert.equal(JSON.stringify(tagVocabulary(facts)), JSON.stringify(tagVocabulary(facts)));
  });

  it('orders papers as PAPERS declares them', () => {
    const papers = tagVocabulary(syllabus())
      .filter((entry) => entry.level === 'section')
      .map((entry) => entry.paper);
    assert.deepEqual(papers, ['gs1', 'gs1', 'gs2', 'gs2']);
  });
});

/* ------------------------------------------------------------------ bounds */

describe('tagVocabulary — bounded, whatever the syllabus does', () => {
  /** 86 sections of five leaves — the real shape, with every leaf started. */
  function wholeSyllabus(started: boolean): TagFact[] {
    const facts: TagFact[] = [];
    for (let section = 0; section < 86; section += 1) {
      const paper: PaperValue = section % 2 === 0 ? 'gs1' : 'gs2';
      for (let bullet = 0; bullet < 5; bullet += 1) {
        facts.push(
          leaf(
            paper,
            `Section ${section} with a heading long enough to be realistic prose`,
            `${paper}-section-${section}-leaf-${bullet}`,
            started ? 'first_pass' : 'not_started',
          ),
        );
      }
    }
    return facts;
  }

  it('stays inside the entry ceiling with every leaf started', () => {
    const entries = tagVocabulary(wholeSyllabus(true));
    assert.ok(
      entries.length <= MAX_VOCABULARY_ENTRIES,
      `${entries.length} entries must not exceed ${MAX_VOCABULARY_ENTRIES}`,
    );
  });

  it('stays well inside a 64KB body', () => {
    const bytes = Buffer.byteLength(JSON.stringify(tagVocabulary(wholeSyllabus(true))), 'utf8');
    assert.ok(bytes < 64 * 1024, `${bytes} bytes must be inside a 64KB body`);
    assert.ok(bytes <= VOCABULARY_BUDGET_BYTES, `${bytes} bytes must respect the budget`);
  });

  it('lands in the expected 130–210 range for a realistic mid-preparation state', () => {
    // 86 sections, plus the leaves of the dozen sections she has opened.
    const facts = wholeSyllabus(false);
    for (let i = 0; i < 12 * 5; i += 1) {
      const fact = facts[i];
      if (fact) fact.status = 'in_progress';
    }

    const entries = tagVocabulary(facts);
    assert.ok(entries.length >= 130 && entries.length <= 210, `${entries.length} entries`);
  });

  it('trims LEAVES rather than sections when a ceiling bites', () => {
    // A shelf is always offered: an item with no section to link to has nothing
    // at all, whereas one missing a bullet merely links a level up.
    const entries = tagVocabulary(wholeSyllabus(true), { maxEntries: 100 });
    assert.equal(entries.length, 100);
    assert.equal(entries.filter((entry) => entry.level === 'section').length, 86);
    assert.equal(entries.filter((entry) => entry.level === 'leaf').length, 14);
  });

  it('respects a byte budget as well as an entry count', () => {
    const entries = tagVocabulary(wholeSyllabus(true), { maxBytes: 4_000 });
    const bytes = Buffer.byteLength(JSON.stringify(entries), 'utf8');
    // The estimate deliberately over-counts, so the real payload is under it.
    assert.ok(bytes <= 4_000, `${bytes} bytes must respect a 4,000-byte budget`);
    assert.ok(entries.length > 0);
  });

  it('sends every leaf when explicitly asked to, and the budget allows', () => {
    // The diagnostic path. It has to opt out of BOTH ceilings, which is the
    // point: the default budget alone trims a whole-syllabus payload, so the
    // daily digest cannot accidentally start sending one.
    const entries = tagVocabulary(wholeSyllabus(false), {
      includeAllLeaves: true,
      maxEntries: 1_000,
      maxBytes: 200_000,
    });
    assert.equal(entries.filter((entry) => entry.level === 'leaf').length, 86 * 5);
  });

  it('trims a whole-syllabus payload under the DEFAULT budget', () => {
    const entries = tagVocabulary(wholeSyllabus(false), { includeAllLeaves: true });
    assert.ok(
      entries.filter((entry) => entry.level === 'leaf').length < 86 * 5,
      'the default budget must bite before the whole syllabus is on the wire',
    );
    assert.equal(entries.filter((entry) => entry.level === 'section').length, 86);
  });
});

/* ------------------------------------------------------------------- index */

describe('buildTagIndex', () => {
  it('resolves a leaf slug to its own id', () => {
    const facts = syllabus();
    const index = buildTagIndex(facts);
    const target = facts.find((fact) => fact.slug === 'gs2-polity-fr');
    assert.equal(index.bySlug.get('gs2-polity-fr'), target?.id);
  });

  it('resolves a section key to its anchor — the first live leaf', () => {
    const facts = syllabus();
    const index = buildTagIndex(facts);
    const anchor = facts.find((fact) => fact.topic === 'Polity');
    assert.equal(index.bySlug.get(sectionKeyOf('gs2', 'Polity')), anchor?.id);
  });

  it('excludes retired rows, matching db/syllabus.ts#topicIdBySlug', () => {
    const facts = syllabus();
    const retired = facts[0];
    if (retired) retired.retiredAt = '2026-01-01T00:00:00.000Z';

    const index = buildTagIndex(facts);
    assert.equal(index.bySlug.get('gs1-modern-history-1857'), undefined);
    // The section survives on its next live leaf rather than vanishing.
    assert.equal(
      index.bySlug.get(sectionKeyOf('gs1', 'Modern Indian History')),
      facts[1]?.id,
    );
  });

  it('counts what it holds', () => {
    const index = buildTagIndex(syllabus());
    assert.equal(index.leafCount, 7);
    assert.equal(index.sectionCount, 4);
  });
});

/* -------------------------------------------------------------- resolution */

describe('resolveTags — an unknown slug never rejects anything', () => {
  it('reports an unknown slug and resolves the rest', () => {
    const index = buildTagIndex(syllabus());
    const resolution = resolveTags(
      ['gs2-polity-fr', 'gs9-quantum-diplomacy', 'gs1-modern-history-1857'],
      index,
    );

    assert.deepEqual(resolution.unknown, ['gs9-quantum-diplomacy']);
    assert.deepEqual(resolution.resolved, ['gs2-polity-fr', 'gs1-modern-history-1857']);
    assert.equal(resolution.topicIds.length, 2);
  });

  it('resolves nothing, and complains about nothing, on an empty index', () => {
    const resolution = resolveTags(['gs2-polity-fr'], EMPTY_TAG_INDEX);
    assert.deepEqual(resolution.topicIds, []);
    assert.deepEqual(resolution.unknown, ['gs2-polity-fr']);
  });

  it('preserves rank order — the first tag drives the flashcard topic', () => {
    const facts = syllabus();
    const index = buildTagIndex(facts);
    const fr = facts.find((f) => f.slug === 'gs2-polity-fr')?.id;
    const inc = facts.find((f) => f.slug === 'gs1-modern-history-inc')?.id;

    assert.deepEqual(resolveTags(['gs2-polity-fr', 'gs1-modern-history-inc'], index).topicIds, [
      fr,
      inc,
    ]);
    assert.deepEqual(resolveTags(['gs1-modern-history-inc', 'gs2-polity-fr'], index).topicIds, [
      inc,
      fr,
    ]);
  });

  it('collapses a section and its own anchor leaf to one id', () => {
    // `ca_item_topics` is unique on `(item, topic)`; a repeated id would be a
    // silent insert failure rather than a no-op.
    const index = buildTagIndex(syllabus());
    const resolution = resolveTags(
      [sectionKeyOf('gs2', 'Polity'), 'gs2-polity-fr'],
      index,
    );
    assert.equal(resolution.topicIds.length, 1);
    assert.equal(resolution.resolved.length, 2);
  });

  it('forgives a casing difference introduced in transit', () => {
    // The server is echoing keys this app sent it; a case change through a
    // model is a transcription artefact, not vocabulary drift, and filing it as
    // one would raise a false alarm and lose a plainly correct link.
    const index = buildTagIndex(syllabus());
    const resolution = resolveTags(['GS2-Polity-FR'], index);
    assert.equal(resolution.unknown.length, 0);
    assert.equal(resolution.topicIds.length, 1);
  });

  it('survives every malformed tag list without throwing', () => {
    const index = buildTagIndex(syllabus());
    for (const input of [null, undefined, 'gs2-polity-fr', 42, {}, [null, 7, {}, '', '   ']]) {
      const resolution = resolveTags(input, index);
      assert.deepEqual(resolution.topicIds, [], `${JSON.stringify(input)} resolves to nothing`);
      assert.deepEqual(resolution.unknown, []);
    }
  });

  it('deduplicates a repeated raw tag', () => {
    const index = buildTagIndex(syllabus());
    const resolution = resolveTags(['gs2-polity-fr', 'gs2-polity-fr'], index);
    assert.deepEqual(resolution.resolved, ['gs2-polity-fr']);
    assert.equal(resolution.topicIds.length, 1);
  });
});
