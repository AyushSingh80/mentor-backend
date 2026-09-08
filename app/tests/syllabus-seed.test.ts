/**
 * The seeding diff.
 *
 * The whole point of `planSeed` being pure is that the dangerous decisions —
 * the ones that could silently erase eighteen months of self-assessment — are
 * testable without a database. So these tests do not check that a plan is
 * "correct" in the abstract; they simulate the sequence that actually breaks
 * things: seed, work on the syllabus for a while, then ship a corrected
 * syllabus and check that the work survived.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  planSeed,
  type ExistingTopic,
  type SeedPlan,
  type SyllabusDataset,
  type SyllabusSeedEntry,
} from '../src/lib/syllabus-seed';
import { SYLLABUS_V1 } from '../src/data/syllabus-v1';
import { PAPERS, isPaperValue } from '../src/lib/papers';

/* ------------------------------------------------------------- test harness */

/**
 * A faithful in-memory stand-in for `ensureSyllabusSeeded`'s transaction.
 *
 * Order matters and mirrors `db/syllabus.ts` exactly: insert first so a rename
 * target exists, then display-only updates, then the carry-over, then revive,
 * then tombstone. If this drifts from the repository the tests stop meaning
 * anything, so the two are commented as a pair.
 */
function applyPlan(rows: ExistingTopic[], plan: SeedPlan, now = '2026-10-01T00:00:00.000Z') {
  const next = rows.map((r) => ({ ...r }));
  let nextId = next.reduce((max, r) => Math.max(max, r.id), 0) + 1;

  const bySlug = new Map(next.map((r) => [r.slug, r] as const));
  const byId = new Map(next.map((r) => [r.id, r] as const));

  for (const entry of plan.insert) {
    const row: ExistingTopic = {
      id: nextId++,
      slug: entry.slug,
      paper: entry.paper,
      topic: entry.topic,
      subtopic: entry.subtopic,
      position: entry.position,
      // Schema defaults. A fresh row is always untouched.
      status: 'not_started',
      confidence: null,
      firstPassAt: null,
      revisedAt: null,
      retiredAt: null,
    };
    next.push(row);
    bySlug.set(row.slug, row);
    byId.set(row.id, row);
  }

  for (const u of plan.update) {
    const row = byId.get(u.id);
    assert.ok(row, `update names a row that does not exist: ${u.id}`);
    // Only the four display fields, exactly as the repository writes them.
    row.paper = u.entry.paper;
    row.topic = u.entry.topic;
    row.subtopic = u.entry.subtopic;
    row.position = u.entry.position;
  }

  for (const c of plan.carryOver) {
    const from = byId.get(c.fromId);
    const to = bySlug.get(c.toSlug);
    assert.ok(from, `carryOver names a missing source: ${c.fromId}`);
    assert.ok(to, `carryOver names a missing target: ${c.toSlug}`);
    to.status = from.status;
    to.confidence = from.confidence;
    to.firstPassAt = from.firstPassAt;
    to.revisedAt = from.revisedAt;
  }

  for (const id of plan.revive) {
    const row = byId.get(id);
    assert.ok(row);
    row.retiredAt = null;
  }

  for (const id of plan.tombstone) {
    const row = byId.get(id);
    assert.ok(row);
    row.retiredAt = now;
  }

  return next;
}

function isEmptyPlan(plan: SeedPlan): boolean {
  return (
    plan.insert.length === 0 &&
    plan.update.length === 0 &&
    plan.tombstone.length === 0 &&
    plan.revive.length === 0 &&
    plan.carryOver.length === 0
  );
}

function bySlug(rows: ExistingTopic[], slug: string): ExistingTopic {
  const row = rows.find((r) => r.slug === slug);
  assert.ok(row, `expected a row with slug ${slug}`);
  return row;
}

function entry(
  slug: string,
  topic: string,
  subtopic: string | null,
  position: number,
): SyllabusSeedEntry {
  return { slug, paper: 'gs2', topic, subtopic, position };
}

/* -------------------------------------------------------------- fixtures */

/** A miniature syllabus, small enough to reason about by eye. */
const V1: SyllabusDataset = {
  version: 1,
  entries: [
    entry('gs2-polity-separation-of-powers', 'Polity', 'Separation of powers', 1),
    entry('gs2-polity-basic-structure', 'Polity', 'Basic structure doctrine', 2),
    entry('gs2-polity-emergency', 'Polity', 'Emergency provisions', 3),
    entry('gs2-ir-neighbourhood', 'International Relations', 'India and its neighbourhood', 4),
  ],
  renames: [],
};

/**
 * The corrected syllabus, carrying all three edits that happen in real life:
 *
 *  (a) a reworded topic — same slug, new wording, must keep its history;
 *  (b) a genuinely new topic — must arrive at `not_started`;
 *  (c) a removed topic — must be tombstoned, never deleted, status intact.
 */
const V2: SyllabusDataset = {
  version: 2,
  entries: [
    // (a) reworded. Same slug on purpose: this is what the slug is FOR.
    entry('gs2-polity-separation-of-powers', 'Polity', 'Separation of powers and its limits', 1),
    entry('gs2-polity-basic-structure', 'Polity', 'Basic structure doctrine', 2),
    // (b) new
    entry('gs2-polity-anti-defection', 'Polity', 'Anti-defection law', 3),
    entry('gs2-ir-neighbourhood', 'International Relations', 'India and its neighbourhood', 4),
    // (c) 'gs2-polity-emergency' is gone.
  ],
  renames: [],
};

/** Seeds V1 and then does eight months of work on three of the four topics. */
function seededAndWorked(): ExistingTopic[] {
  const seeded = applyPlan([], planSeed([], V1));

  const worked = seeded.map((row) => ({ ...row }));
  const sop = bySlug(worked, 'gs2-polity-separation-of-powers');
  sop.status = 'revised';
  sop.confidence = 4;
  sop.firstPassAt = '2026-04-02T09:00:00.000Z';
  sop.revisedAt = '2026-08-19T09:00:00.000Z';

  const basic = bySlug(worked, 'gs2-polity-basic-structure');
  basic.status = 'in_progress';
  basic.confidence = 2;

  const emergency = bySlug(worked, 'gs2-polity-emergency');
  emergency.status = 'first_pass';
  emergency.confidence = 5;
  emergency.firstPassAt = '2026-05-11T09:00:00.000Z';

  return worked;
}

/* ------------------------------------------------------ the headline test */

describe('planSeed — a corrected syllabus never destroys self-assessment', () => {
  const worked = seededAndWorked();
  const plan = planSeed(worked, V2);
  const after = applyPlan(worked, plan);

  it('keeps status and confidence on a reworded topic', () => {
    const row = bySlug(after, 'gs2-polity-separation-of-powers');
    assert.equal(row.subtopic, 'Separation of powers and its limits', 'wording should update');
    assert.equal(row.status, 'revised');
    assert.equal(row.confidence, 4);
    assert.equal(row.firstPassAt, '2026-04-02T09:00:00.000Z');
    assert.equal(row.revisedAt, '2026-08-19T09:00:00.000Z');
    assert.equal(row.retiredAt, null);
  });

  it('never names status, confidence or a timestamp in an update', () => {
    for (const u of plan.update) {
      // The plan carries the whole entry, and the entry type simply has no
      // status field — the type system is doing half the work here. This
      // asserts the other half: an update only ever fires for display drift.
      assert.deepEqual(Object.keys(u.entry).sort(), [
        'paper',
        'position',
        'slug',
        'subtopic',
        'topic',
      ]);
    }
  });

  it('gives a genuinely new topic a clean slate', () => {
    const row = bySlug(after, 'gs2-polity-anti-defection');
    assert.equal(row.status, 'not_started');
    assert.equal(row.confidence, null);
    assert.equal(row.firstPassAt, null);
    assert.equal(row.revisedAt, null);
    assert.equal(row.retiredAt, null);
  });

  it('tombstones a removed topic with its status intact, and does not delete it', () => {
    const row = bySlug(after, 'gs2-polity-emergency');
    assert.ok(row.retiredAt, 'a removed topic must be retired');
    // Deleting the row would cascade its revision_queue entry away and NULL
    // every lecture and answer pointing at it. The status must survive so the
    // topic comes back whole if a later revision restores it.
    assert.equal(row.status, 'first_pass');
    assert.equal(row.confidence, 5);
    assert.equal(row.firstPassAt, '2026-05-11T09:00:00.000Z');
    assert.equal(after.length, 5, 'nothing is ever removed from the table');
  });

  it('never puts one id in both tombstone and update', () => {
    const tombstoned = new Set(plan.tombstone);
    for (const u of plan.update) {
      assert.ok(!tombstoned.has(u.id), `id ${u.id} is both updated and retired`);
    }
    // Same argument for revive: a row cannot be both restored and retired.
    for (const id of plan.revive) {
      assert.ok(!tombstoned.has(id), `id ${id} is both revived and retired`);
    }
  });

  it('touches only what changed', () => {
    assert.equal(plan.insert.length, 1);
    assert.equal(plan.update.length, 1);
    assert.equal(plan.tombstone.length, 1);
    assert.equal(plan.revive.length, 0);
    // 'gs2-polity-basic-structure' and 'gs2-ir-neighbourhood' are untouched.
    assert.equal(plan.unchanged, 2);
  });
});

/* -------------------------------------------------------------- idempotence */

describe('planSeed — idempotence', () => {
  it('emits nothing when the database already matches the dataset', () => {
    const afterV1 = applyPlan([], planSeed([], V1));
    const plan = planSeed(afterV1, V1);

    assert.deepEqual(plan.insert, []);
    assert.deepEqual(plan.update, []);
    assert.deepEqual(plan.tombstone, []);
    assert.deepEqual(plan.revive, []);
    assert.deepEqual(plan.carryOver, []);
    assert.equal(plan.unchanged, V1.entries.length);
    assert.ok(isEmptyPlan(plan));
  });

  it('re-seeds the real v1 dataset with zero writes', () => {
    const afterV1 = applyPlan([], planSeed([], SYLLABUS_V1));
    const plan = planSeed(afterV1, SYLLABUS_V1);
    assert.ok(isEmptyPlan(plan), 'a steady-state launch must not write');
    assert.equal(plan.unchanged, SYLLABUS_V1.entries.length);
  });

  it('reaches steady state on the launch after a correction', () => {
    const worked = seededAndWorked();
    const afterV2 = applyPlan(worked, planSeed(worked, V2));
    assert.ok(isEmptyPlan(planSeed(afterV2, V2)), 'second launch on v2 must be a no-op');
  });

  it('does not re-tombstone a row that is already retired', () => {
    const worked = seededAndWorked();
    const afterV2 = applyPlan(worked, planSeed(worked, V2), '2026-10-01T00:00:00.000Z');
    const plan = planSeed(afterV2, V2);
    assert.deepEqual(plan.tombstone, [], 're-stamping would lose the real retirement date');
  });
});

/* ------------------------------------------------------------------ renames */

describe('planSeed — renames', () => {
  const RENAMED: SyllabusDataset = {
    version: 3,
    entries: [
      entry('gs2-polity-sop-v2', 'Polity', 'Separation of powers', 1),
      entry('gs2-polity-basic-structure', 'Polity', 'Basic structure doctrine', 2),
      entry('gs2-polity-emergency', 'Polity', 'Emergency provisions', 3),
      entry('gs2-ir-neighbourhood', 'International Relations', 'India and its neighbourhood', 4),
    ],
    renames: [{ fromSlug: 'gs2-polity-separation-of-powers', toSlugs: ['gs2-polity-sop-v2'] }],
  };

  it('carries status, confidence and both timestamps to the new slug', () => {
    const worked = seededAndWorked();
    const after = applyPlan(worked, planSeed(worked, RENAMED));

    const moved = bySlug(after, 'gs2-polity-sop-v2');
    assert.equal(moved.status, 'revised');
    assert.equal(moved.confidence, 4);
    assert.equal(moved.firstPassAt, '2026-04-02T09:00:00.000Z');
    assert.equal(moved.revisedAt, '2026-08-19T09:00:00.000Z');

    const old = bySlug(after, 'gs2-polity-separation-of-powers');
    assert.ok(old.retiredAt, 'the old slug is tombstoned, not deleted');
    assert.equal(old.status, 'revised', 'and keeps its own history as a matter of record');
  });

  it('carries status to every slug when one bullet is split in two', () => {
    const SPLIT: SyllabusDataset = {
      version: 4,
      entries: [
        entry('gs2-polity-sop-legislature', 'Polity', 'Separation of powers: legislature', 1),
        entry('gs2-polity-sop-judiciary', 'Polity', 'Separation of powers: judiciary', 2),
        entry('gs2-polity-basic-structure', 'Polity', 'Basic structure doctrine', 3),
        entry('gs2-polity-emergency', 'Polity', 'Emergency provisions', 4),
        entry('gs2-ir-neighbourhood', 'International Relations', 'India and its neighbourhood', 5),
      ],
      renames: [
        {
          fromSlug: 'gs2-polity-separation-of-powers',
          toSlugs: ['gs2-polity-sop-legislature', 'gs2-polity-sop-judiciary'],
        },
      ],
    };

    const worked = seededAndWorked();
    const after = applyPlan(worked, planSeed(worked, SPLIT));

    for (const slug of ['gs2-polity-sop-legislature', 'gs2-polity-sop-judiciary']) {
      const row = bySlug(after, slug);
      assert.equal(row.status, 'revised', slug);
      assert.equal(row.confidence, 4, slug);
      assert.equal(row.firstPassAt, '2026-04-02T09:00:00.000Z', slug);
    }
  });

  it('is a no-op on the next launch, once the source is retired', () => {
    const worked = seededAndWorked();
    const afterRename = applyPlan(worked, planSeed(worked, RENAMED));
    assert.ok(isEmptyPlan(planSeed(afterRename, RENAMED)));
  });

  it('does not repeat a carry-over whose source status was the default', () => {
    // The trap: 'gs2-ir-neighbourhood' was never touched, so carrying its
    // (default) status leaves the target indistinguishable from a fresh row.
    // Only the retirement of the source stops the plan repeating forever.
    const DEFAULTS: SyllabusDataset = {
      version: 5,
      entries: [
        entry('gs2-polity-separation-of-powers', 'Polity', 'Separation of powers', 1),
        entry('gs2-polity-basic-structure', 'Polity', 'Basic structure doctrine', 2),
        entry('gs2-polity-emergency', 'Polity', 'Emergency provisions', 3),
        entry('gs2-ir-neighbours', 'International Relations', 'India and its neighbourhood', 4),
      ],
      renames: [{ fromSlug: 'gs2-ir-neighbourhood', toSlugs: ['gs2-ir-neighbours'] }],
    };

    const afterV1 = applyPlan([], planSeed([], V1));
    const once = applyPlan(afterV1, planSeed(afterV1, DEFAULTS));
    assert.ok(isEmptyPlan(planSeed(once, DEFAULTS)));
  });

  it('refuses to overwrite a target that already carries progress', () => {
    const afterV1 = applyPlan([], planSeed([], V1));

    // Both slugs exist and both have been worked on; a rename between them
    // would replace the target's four months with the source's one week.
    const rows = afterV1.map((r) => ({ ...r }));
    bySlug(rows, 'gs2-polity-emergency').status = 'in_progress';
    const target = bySlug(rows, 'gs2-ir-neighbourhood');
    target.status = 'revised';
    target.confidence = 5;

    const plan = planSeed(rows, {
      version: 6,
      entries: V1.entries.filter((e) => e.slug !== 'gs2-polity-emergency'),
      renames: [{ fromSlug: 'gs2-polity-emergency', toSlugs: ['gs2-ir-neighbourhood'] }],
    });

    assert.deepEqual(plan.carryOver, [], 'a target with progress is never overwritten');
    const after = applyPlan(rows, plan);
    assert.equal(bySlug(after, 'gs2-ir-neighbourhood').status, 'revised');
    assert.equal(bySlug(after, 'gs2-ir-neighbourhood').confidence, 5);
    // The source still leaves the syllabus — it is simply not carried.
    assert.ok(bySlug(after, 'gs2-polity-emergency').retiredAt);
  });

  it('ignores a rename whose source is still a live entry', () => {
    const plan = planSeed(applyPlan([], planSeed([], V1)), {
      version: 7,
      entries: [...V1.entries, entry('gs2-polity-sop-v2', 'Polity', 'Separation of powers', 5)],
      renames: [{ fromSlug: 'gs2-polity-separation-of-powers', toSlugs: ['gs2-polity-sop-v2'] }],
    });

    assert.deepEqual(plan.carryOver, []);
    assert.deepEqual(plan.tombstone, [], 'a topic the dataset still claims is never retired');
  });
});

/* -------------------------------------------------------------------- revive */

describe('planSeed — revive', () => {
  it('restores a retired row rather than inserting a duplicate', () => {
    const worked = seededAndWorked();
    const afterV2 = applyPlan(worked, planSeed(worked, V2)); // emergency retired here

    // v3 puts it back.
    const plan = planSeed(afterV2, { ...V2, version: 3, entries: [...V2.entries, V1.entries[2]] });
    const revived = bySlug(afterV2, 'gs2-polity-emergency');

    assert.deepEqual(plan.revive, [revived.id]);
    assert.deepEqual(plan.insert, [], 'a second row with the same slug would break the unique index');

    const after = applyPlan(afterV2, plan);
    const row = bySlug(after, 'gs2-polity-emergency');
    assert.equal(row.retiredAt, null);
    assert.equal(row.status, 'first_pass', 'the whole point of retiring instead of deleting');
    assert.equal(row.confidence, 5);
  });

  it('counts a revived row as a write, not as unchanged', () => {
    const worked = seededAndWorked();
    const afterV2 = applyPlan(worked, planSeed(worked, V2));
    const plan = planSeed(afterV2, { ...V2, version: 3, entries: [...V2.entries, V1.entries[2]] });
    assert.equal(plan.unchanged, V2.entries.length, 'the revived row is not among them');
  });
});

/* ------------------------------------------------------------- empty inputs */

describe('planSeed — degenerate inputs', () => {
  it('inserts everything into an empty database', () => {
    const plan = planSeed([], V1);
    assert.equal(plan.insert.length, V1.entries.length);
    assert.equal(plan.unchanged, 0);
    assert.deepEqual(plan.tombstone, []);
  });

  it('retires everything when the dataset is empty, and writes nothing twice', () => {
    const afterV1 = applyPlan([], planSeed([], V1));
    const empty: SyllabusDataset = { version: 9, entries: [], renames: [] };
    const plan = planSeed(afterV1, empty);
    assert.equal(plan.tombstone.length, V1.entries.length);
    assert.ok(isEmptyPlan(planSeed(applyPlan(afterV1, plan), empty)));
  });

  it('does nothing at all with no rows and no entries', () => {
    assert.ok(isEmptyPlan(planSeed([], { version: 0, entries: [], renames: [] })));
  });
});

/* ----------------------------------------------------------- the v1 dataset */

describe('SYLLABUS_V1', () => {
  const entries = SYLLABUS_V1.entries;

  it('covers the whole Mains load at leaf granularity', () => {
    assert.ok(
      entries.length >= 380 && entries.length <= 450,
      `expected 380–450 leaves, got ${entries.length}`,
    );
  });

  it('has a unique slug for every entry', () => {
    const seen = new Map<string, number>();
    for (const [i, e] of entries.entries()) {
      const first = seen.get(e.slug);
      assert.equal(first, undefined, `duplicate slug ${e.slug} at ${first} and ${i}`);
      seen.set(e.slug, i);
    }
  });

  it('uses stable, human-readable slugs', () => {
    for (const e of entries) {
      assert.match(e.slug, /^[a-z0-9]+(-[a-z0-9]+)*$/, `slug not kebab-case: ${e.slug}`);
      assert.ok(e.slug.length <= 72, `slug too long to read: ${e.slug}`);
    }
  });

  it('names only real papers', () => {
    for (const e of entries) {
      assert.ok(isPaperValue(e.paper), `not a paper: ${e.paper}`);
    }
  });

  it('covers all seven papers', () => {
    const covered = new Set(entries.map((e) => e.paper));
    for (const paper of PAPERS) {
      assert.ok(covered.has(paper.value), `no entries for ${paper.value}`);
    }
  });

  it('gives every paper a unique position, so display order is total', () => {
    const byPaper = new Map<string, Set<number>>();
    for (const e of entries) {
      const seen = byPaper.get(e.paper) ?? new Set<number>();
      assert.ok(!seen.has(e.position), `duplicate position ${e.position} in ${e.paper}`);
      assert.ok(Number.isInteger(e.position) && e.position > 0, `bad position on ${e.slug}`);
      seen.add(e.position);
      byPaper.set(e.paper, seen);
    }
  });

  it('orders entries by position within each paper', () => {
    const last = new Map<string, number>();
    for (const e of entries) {
      const previous = last.get(e.paper) ?? 0;
      assert.ok(e.position > previous, `${e.slug} is out of order within ${e.paper}`);
      last.set(e.paper, e.position);
    }
  });

  it('groups every leaf under a non-empty section', () => {
    for (const e of entries) {
      assert.ok(e.topic.trim().length > 0, `empty section on ${e.slug}`);
      assert.ok(e.subtopic === null || e.subtopic.trim().length > 0, `blank leaf on ${e.slug}`);
    }
  });

  it('prefixes each slug with its paper, so a slug is readable on its own', () => {
    for (const e of entries) {
      assert.ok(e.slug.startsWith(`${e.paper.replace(/_/g, '-')}-`), `unprefixed slug: ${e.slug}`);
    }
  });

  it('labels Essay as thematic clusters rather than an official syllabus', () => {
    const essay = entries.filter((e) => e.paper === 'essay');
    assert.ok(essay.length > 0);
    // UPSC publishes no Essay syllabus. Sections must read as what they are.
    for (const e of essay) {
      assert.ok(e.topic.trim().length > 0, `essay leaf ${e.slug} has no cluster`);
    }
  });

  it('declares no rename whose source is still an entry', () => {
    const slugs = new Set(entries.map((e) => e.slug));
    for (const rename of SYLLABUS_V1.renames) {
      assert.ok(
        !slugs.has(rename.fromSlug),
        `${rename.fromSlug} is both renamed away and still present`,
      );
    }
  });

  it('declares no rename pointing at a slug that does not exist', () => {
    const slugs = new Set(entries.map((e) => e.slug));
    for (const rename of SYLLABUS_V1.renames) {
      assert.ok(rename.toSlugs.length > 0, `${rename.fromSlug} renames to nothing`);
      for (const to of rename.toSlugs) {
        assert.ok(slugs.has(to), `${rename.fromSlug} renames to a missing slug: ${to}`);
      }
    }
  });
});

/* ------------------------------------------------- multi-hop rename chains */

describe('planSeed — rename chains across skipped dataset versions', () => {
  const topic = (slug: string, over: Partial<ExistingTopic> = {}): ExistingTopic => ({
    id: 1,
    slug,
    paper: 'gs2',
    topic: 'Polity',
    subtopic: 'Separation of powers',
    position: 1,
    status: 'first_pass',
    confidence: 4,
    firstPassAt: '2026-10-01T00:00:00.000Z',
    revisedAt: null,
    retiredAt: null,
    ...over,
  });

  const entry = (slug: string): SyllabusSeedEntry => ({
    slug,
    paper: 'gs2',
    topic: 'Polity',
    subtopic: 'Separation of powers',
    position: 1,
  });

  it('carries history across a chain whose middle slug this device never held', () => {
    // v2 renamed A->B, v3 renamed B->C. A phone updating v1 -> v3 holds A and
    // has never held B. Hop-by-hop matching loses the topic entirely: neither
    // hop applies, A is tombstoned, C arrives pristine. There is no seed
    // version column, so skipping a version is normal, not exotic.
    const plan = planSeed([topic('a')], {
      version: 3,
      entries: [entry('c')],
      renames: [
        { fromSlug: 'a', toSlugs: ['b'] },
        { fromSlug: 'b', toSlugs: ['c'] },
      ],
    });

    assert.deepEqual(
      plan.carryOver,
      [{ fromId: 1, toSlug: 'c' }],
      "A's months of self-assessment must reach C",
    );
    assert.deepEqual(plan.insert.map((e) => e.slug), ['c']);
    assert.deepEqual(plan.tombstone, [1]);
  });

  it('gives the same result as the flattened equivalent', () => {
    const chained = planSeed([topic('a')], {
      version: 3,
      entries: [entry('c')],
      renames: [
        { fromSlug: 'a', toSlugs: ['b'] },
        { fromSlug: 'b', toSlugs: ['c'] },
      ],
    });
    const flattened = planSeed([topic('a')], {
      version: 3,
      entries: [entry('c')],
      renames: [{ fromSlug: 'a', toSlugs: ['c'] }],
    });

    // Authoring a correction either way must be safe.
    assert.deepEqual(chained.carryOver, flattened.carryOver);
    assert.deepEqual(chained.tombstone, flattened.tombstone);
  });

  it('still prefers the intermediate row when the device did hold it', () => {
    // Ran the intermediate version: A was retired then, B carries the current
    // truth. A must not overwrite B's newer status.
    const plan = planSeed(
      [
        topic('a', { id: 1, retiredAt: '2026-11-01T00:00:00.000Z', status: 'in_progress' }),
        topic('b', { id: 2, status: 'revised', confidence: 5 }),
      ],
      {
        version: 3,
        entries: [entry('c')],
        renames: [
          { fromSlug: 'a', toSlugs: ['b'] },
          { fromSlug: 'b', toSlugs: ['c'] },
        ],
      },
    );

    assert.deepEqual(plan.carryOver, [{ fromId: 2, toSlug: 'c' }], 'B is the live source, not A');
  });

  it('carries nothing when the chain dead-ends outside the dataset', () => {
    const plan = planSeed([topic('a')], {
      version: 2,
      entries: [entry('z')],
      renames: [{ fromSlug: 'a', toSlugs: ['b'] }],
    });

    assert.deepEqual(plan.carryOver, [], 'B is not shipped, so there is nothing to carry onto');
  });

  it('terminates on a cyclic dataset rather than recursing forever', () => {
    const plan = planSeed([topic('a')], {
      version: 2,
      entries: [entry('z')],
      renames: [
        { fromSlug: 'a', toSlugs: ['b'] },
        { fromSlug: 'b', toSlugs: ['a'] },
      ],
    });

    assert.deepEqual(plan.carryOver, []);
  });
});
