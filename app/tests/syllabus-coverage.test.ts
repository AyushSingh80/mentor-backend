/**
 * Coverage and the first-pass projection.
 *
 * Two things are being defended here. The first is that a retired topic never
 * counts — a syllabus correction that drops a bullet must not leave coverage
 * permanently depressed by a topic that is no longer examinable. The second is
 * that a projection with no evidence behind it says so, rather than dividing by
 * zero or quietly claiming she is on track.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  coverageByPaper,
  coverageBySection,
  projectFirstPass,
  type TopicFact,
  type TopicStatus,
} from '../src/lib/syllabus-coverage';
import { SYLLABUS_V1 } from '../src/data/syllabus-v1';
import { PAPERS } from '../src/lib/papers';

/* ------------------------------------------------------------------ helpers */

let nextId = 1;

function fact(overrides: Partial<TopicFact> = {}): TopicFact {
  const id = nextId++;
  return {
    id,
    slug: `t-${id}`,
    paper: 'gs2',
    topic: 'Polity',
    status: 'not_started',
    confidence: null,
    firstPassAt: null,
    retiredAt: null,
    ...overrides,
  };
}

/** `n` topics of one status in one section. */
function many(n: number, overrides: Partial<TopicFact> = {}): TopicFact[] {
  return Array.from({ length: n }, () => fact(overrides));
}

function passedOn(day: string, overrides: Partial<TopicFact> = {}): TopicFact {
  return fact({ status: 'first_pass', firstPassAt: `${day}T09:00:00.000Z`, ...overrides });
}

function find<T extends { key: string }>(rows: T[], key: string): T {
  const row = rows.find((r) => r.key === key);
  assert.ok(row, `expected a row keyed ${key}`);
  return row;
}

/** The real dataset as untouched facts — the shape the app starts life in. */
function freshFacts(): TopicFact[] {
  return SYLLABUS_V1.entries.map((entry, index) => ({
    id: index + 1,
    slug: entry.slug,
    paper: entry.paper,
    topic: entry.topic,
    status: 'not_started' as TopicStatus,
    confidence: null,
    firstPassAt: null,
    retiredAt: null,
  }));
}

/* ------------------------------------------------------------ by paper */

describe('coverageByPaper', () => {
  it('counts revised as having passed, because it has', () => {
    const rows = coverageByPaper([
      ...many(5, { status: 'not_started' }),
      ...many(2, { status: 'in_progress' }),
      ...many(2, { status: 'first_pass' }),
      ...many(1, { status: 'revised' }),
    ]);

    const gs2 = find(rows, 'gs2');
    assert.equal(gs2.total, 10);
    assert.equal(gs2.notStarted, 5);
    assert.equal(gs2.inProgress, 2);
    assert.equal(gs2.firstPass, 2);
    assert.equal(gs2.revised, 1);
    assert.equal(gs2.percentFirstPass, 30, 'first_pass + revised');
    assert.equal(gs2.percentRevised, 10);
  });

  it('excludes retired topics from every total', () => {
    const withRetired = coverageByPaper([
      ...many(3, { status: 'first_pass' }),
      ...many(1, { status: 'not_started' }),
      // Dropped from a corrected syllabus. Its status is intact on the row, but
      // it is no longer examinable and must not drag coverage down forever.
      ...many(6, { status: 'not_started', retiredAt: '2026-09-01T00:00:00.000Z' }),
    ]);

    const gs2 = find(withRetired, 'gs2');
    assert.equal(gs2.total, 4, 'retired rows are not part of the denominator');
    assert.equal(gs2.notStarted, 1);
    assert.equal(gs2.percentFirstPass, 75);
  });

  it('does not count a retired topic that had been passed', () => {
    const rows = coverageByPaper([
      ...many(2, { status: 'not_started' }),
      ...many(2, { status: 'revised', retiredAt: '2026-09-01T00:00:00.000Z' }),
    ]);
    assert.equal(find(rows, 'gs2').total, 2);
    assert.equal(find(rows, 'gs2').percentFirstPass, 0);
  });

  it('omits a paper with no live topics rather than reporting it at zero', () => {
    const rows = coverageByPaper([
      ...many(2, { paper: 'gs1' }),
      ...many(2, { paper: 'gs3', retiredAt: '2026-09-01T00:00:00.000Z' }),
    ]);
    assert.deepEqual(
      rows.map((r) => r.key),
      ['gs1'],
      'a paper that is entirely retired has no coverage, which is not 0%',
    );
  });

  it('returns papers in the order PAPERS declares, not insertion order', () => {
    const rows = coverageByPaper([
      fact({ paper: 'anthro_p2' }),
      fact({ paper: 'gs1' }),
      fact({ paper: 'essay' }),
      fact({ paper: 'gs3' }),
    ]);
    assert.deepEqual(
      rows.map((r) => r.key),
      ['gs1', 'gs3', 'essay', 'anthro_p2'],
    );
  });

  it('keys by PaperValue and labels from PAPERS, so a row can be navigated from', () => {
    const rows = coverageByPaper(freshFacts());
    assert.equal(rows.length, PAPERS.length, 'v1 covers every paper');
    for (const row of rows) {
      const paper = PAPERS.find((p) => p.value === row.key);
      assert.ok(paper, `key ${row.key} is not a PaperValue`);
      assert.equal(row.label, paper.label);
    }
  });

  it('averages confidence over rated topics only', () => {
    const rows = coverageByPaper([
      fact({ confidence: 4 }),
      fact({ confidence: 2 }),
      fact({ confidence: null }),
      fact({ confidence: null }),
    ]);
    // Not 1.5 — an unrated topic is not a topic rated zero.
    assert.equal(find(rows, 'gs2').meanConfidence, 3);
  });

  it('reports no mean confidence when nothing has been rated', () => {
    assert.equal(find(coverageByPaper(many(4)), 'gs2').meanConfidence, null);
  });

  it('ignores confidence on retired topics', () => {
    const rows = coverageByPaper([
      fact({ confidence: 5 }),
      fact({ confidence: 1, retiredAt: '2026-09-01T00:00:00.000Z' }),
    ]);
    assert.equal(find(rows, 'gs2').meanConfidence, 5);
  });

  it('returns nothing at all for no facts', () => {
    assert.deepEqual(coverageByPaper([]), []);
  });

  it('starts the real syllabus at zero across the board', () => {
    for (const row of coverageByPaper(freshFacts())) {
      assert.equal(row.percentFirstPass, 0, row.key);
      assert.equal(row.notStarted, row.total, row.key);
      assert.equal(row.meanConfidence, null, row.key);
    }
  });
});

/* ----------------------------------------------------------- by section */

describe('coverageBySection', () => {
  const facts: TopicFact[] = [
    ...many(4, { paper: 'gs2', topic: 'Polity', status: 'first_pass' }),
    ...many(4, { paper: 'gs2', topic: 'Polity', status: 'not_started' }),
    ...many(2, { paper: 'gs2', topic: 'International Relations', status: 'revised' }),
    ...many(3, { paper: 'gs1', topic: 'Indian Society', status: 'first_pass' }),
  ];

  it('groups on (paper, topic) and excludes other papers', () => {
    const rows = coverageBySection(facts, 'gs2');
    assert.deepEqual(
      rows.map((r) => r.label),
      ['Polity', 'International Relations'],
      'gs1 sections must not leak in',
    );
    assert.equal(find(rows, 'gs2:Polity').total, 8);
    assert.equal(find(rows, 'gs2:Polity').percentFirstPass, 50);
    assert.equal(find(rows, 'gs2:International Relations').percentRevised, 100);
  });

  it('namespaces the key by paper so two papers never collide', () => {
    const gs1 = coverageBySection(facts, 'gs1');
    const gs2 = coverageBySection(facts, 'gs2');
    const keys = new Set([...gs1, ...gs2].map((r) => r.key));
    assert.equal(keys.size, gs1.length + gs2.length);
  });

  it('is the unit that actually moves — one topic is visible in a section', () => {
    const all = freshFacts();
    const before = coverageByPaper(all).find((r) => r.key === 'gs2');
    assert.ok(before);

    // Mark exactly one leaf of GS2's Polity section.
    const target = all.find((f) => f.paper === 'gs2');
    assert.ok(target);
    target.status = 'first_pass';

    const paperAfter = coverageByPaper(all).find((r) => r.key === 'gs2');
    const sectionAfter = find(coverageBySection(all, 'gs2'), `gs2:${target.topic}`);
    assert.ok(paperAfter);

    // The paper barely twitches; the section clearly moves. That gap is the
    // entire argument for reporting sections at all.
    assert.ok(paperAfter.percentFirstPass < 2, 'one leaf must not visibly move a paper');
    assert.ok(sectionAfter.percentFirstPass >= 8, 'but it must visibly move its section');
  });

  it('returns nothing for a paper with no live topics', () => {
    assert.deepEqual(coverageBySection(facts, 'gs4'), []);
    assert.deepEqual(
      coverageBySection(many(3, { paper: 'gs4', retiredAt: '2026-09-01T00:00:00.000Z' }), 'gs4'),
      [],
    );
  });

  it('excludes retired leaves from a section that still exists', () => {
    const rows = coverageBySection(
      [
        ...many(2, { paper: 'gs3', topic: 'Agriculture', status: 'first_pass' }),
        ...many(8, {
          paper: 'gs3',
          topic: 'Agriculture',
          status: 'not_started',
          retiredAt: '2026-09-01T00:00:00.000Z',
        }),
      ],
      'gs3',
    );
    assert.equal(find(rows, 'gs3:Agriculture').total, 2);
    assert.equal(find(rows, 'gs3:Agriculture').percentFirstPass, 100);
  });

  it('covers every section of every paper in the real dataset', () => {
    const all = freshFacts();
    let sections = 0;
    for (const paper of PAPERS) {
      const rows = coverageBySection(all, paper.value);
      assert.ok(rows.length > 0, `${paper.value} has no sections`);
      const covered = rows.reduce((sum, r) => sum + r.total, 0);
      const expected = all.filter((f) => f.paper === paper.value).length;
      assert.equal(covered, expected, `${paper.value} loses leaves when grouped`);
      sections += rows.length;
    }
    // Sections are the unit she works in; there must be enough of them for a
    // paper to be legible but few enough that each one means something.
    assert.ok(sections >= 40 && sections <= 120, `unexpected section count: ${sections}`);
  });
});

/* -------------------------------------------------------------- projection */

describe('projectFirstPass', () => {
  const TARGET = '2027-03-31';

  it('projects from the rate over the window', () => {
    // 14 topics passed in the last 14 days = 1/day; 100 left = 100 days.
    const passed = Array.from({ length: 14 }, (_, i) =>
      passedOn(`2026-09-${String(i + 1).padStart(2, '0')}`),
    );
    const projection = projectFirstPass([...passed, ...many(100)], {
      asOf: '2026-09-14',
      targetIso: TARGET,
    });

    assert.equal(projection.sampleDays, 14);
    assert.equal(projection.topicsPerDay, 1);
    assert.equal(projection.remainingTopics, 100);
    assert.equal(projection.daysToFirstPass, 100);
    assert.equal(projection.projectedDateIso, '2026-12-23');
    assert.equal(projection.behindTarget, false);
    assert.equal(projection.targetIso, TARGET);
  });

  it('flags being behind when the projection lands past the target', () => {
    const projection = projectFirstPass([passedOn('2026-09-14'), ...many(400)], {
      asOf: '2026-09-14',
      targetIso: TARGET,
    });
    assert.ok(projection.projectedDateIso);
    assert.ok(projection.projectedDateIso > TARGET);
    assert.equal(projection.behindTarget, true);
  });

  it('never divides by zero when nothing has moved', () => {
    const projection = projectFirstPass(many(438), { asOf: '2026-09-14', targetIso: TARGET });

    assert.equal(projection.sampleDays, 0, 'no history means no sample, honestly reported');
    assert.equal(projection.topicsPerDay, 0);
    assert.equal(projection.daysToFirstPass, null, 'never Infinity, never NaN, never 0');
    assert.equal(projection.projectedDateIso, null);
    assert.equal(projection.remainingTopics, 438);
    // A fresh install has moved nothing. Firing "behind target" on day one is
    // the false alarm that makes every later true one ignorable.
    assert.equal(projection.behindTarget, false);
  });

  it('returns null rather than Infinity when the window is empty but history exists', () => {
    const projection = projectFirstPass([passedOn('2026-01-05'), ...many(50)], {
      asOf: '2026-09-14',
      targetIso: TARGET,
    });
    assert.equal(projection.topicsPerDay, 0, 'nothing passed inside the window');
    assert.equal(projection.daysToFirstPass, null);
    assert.ok(Number.isFinite(projection.topicsPerDay));
  });

  it('reports sampleDays as the history it has, not the window it asked for', () => {
    // Six days of data. Dividing by fourteen would understate the rate by more
    // than half and double the projection, in week one of all weeks.
    const passed = Array.from({ length: 6 }, (_, i) =>
      passedOn(`2026-09-${String(i + 9).padStart(2, '0')}`),
    );
    const projection = projectFirstPass([...passed, ...many(60)], {
      asOf: '2026-09-14',
      targetIso: TARGET,
    });

    assert.equal(projection.sampleDays, 6);
    assert.equal(projection.topicsPerDay, 1);
    assert.equal(projection.daysToFirstPass, 60);
  });

  it('caps sampleDays at the window once there is more history than that', () => {
    const passed = [passedOn('2026-01-01'), passedOn('2026-09-14')];
    const projection = projectFirstPass([...passed, ...many(10)], {
      asOf: '2026-09-14',
      targetIso: TARGET,
      windowDays: 14,
    });
    assert.equal(projection.sampleDays, 14);
    // Only the one inside the window counts toward the rate.
    assert.ok(Math.abs(projection.topicsPerDay - 1 / 14) < 1e-12);
  });

  it('honours an explicit window, so a recent burst is visible in a short one', () => {
    // A slow first week (one a day) then a fast one (three a day). A 30-day
    // window averages the two together; a 5-day window sees only the burst.
    const slow = Array.from({ length: 5 }, (_, i) =>
      passedOn(`2026-09-0${i + 1}`),
    );
    const fast = Array.from({ length: 5 }, (_, i) => [
      passedOn(`2026-09-1${i}`),
      passedOn(`2026-09-1${i}`),
      passedOn(`2026-09-1${i}`),
    ]).flat();
    const facts = [...slow, ...fast, ...many(30)];

    const wide = projectFirstPass(facts, {
      asOf: '2026-09-14',
      targetIso: TARGET,
      windowDays: 30,
    });
    const narrow = projectFirstPass(facts, {
      asOf: '2026-09-14',
      targetIso: TARGET,
      windowDays: 5,
    });

    assert.equal(wide.sampleDays, 14, 'capped by the history available, not by 30');
    assert.equal(narrow.sampleDays, 5);
    assert.ok(Math.abs(wide.topicsPerDay - 20 / 14) < 1e-12);
    assert.equal(narrow.topicsPerDay, 3);
    assert.ok(narrow.topicsPerDay > wide.topicsPerDay, 'a shorter window sees the recent burst');
  });

  it('falls back to the default window on a nonsensical one', () => {
    const passed = Array.from({ length: 20 }, (_, i) =>
      passedOn(`2026-09-${String(i + 1).padStart(2, '0')}`),
    );
    for (const windowDays of [0, -5, Number.NaN]) {
      const projection = projectFirstPass([...passed, ...many(10)], {
        asOf: '2026-09-20',
        targetIso: TARGET,
        windowDays,
      });
      assert.equal(projection.sampleDays, 14, `windowDays ${windowDays}`);
      assert.ok(Number.isFinite(projection.topicsPerDay));
    }
  });

  it('excludes retired topics from the remaining count and the rate', () => {
    const projection = projectFirstPass(
      [
        passedOn('2026-09-14'),
        // Retired and passed — must not inflate the rate.
        passedOn('2026-09-14', { retiredAt: '2026-09-15T00:00:00.000Z' }),
        ...many(9),
        // Retired and unstarted — must not inflate what is left to do.
        ...many(50, { retiredAt: '2026-09-15T00:00:00.000Z' }),
      ],
      { asOf: '2026-09-14', targetIso: TARGET },
    );

    assert.equal(projection.remainingTopics, 9);
    assert.equal(projection.sampleDays, 1);
    assert.equal(projection.topicsPerDay, 1);
    assert.equal(projection.daysToFirstPass, 9);
  });

  it('counts a revised topic as passed', () => {
    const projection = projectFirstPass(
      [
        fact({ status: 'revised', firstPassAt: '2026-09-14T09:00:00.000Z' }),
        fact({ status: 'in_progress' }),
      ],
      { asOf: '2026-09-14', targetIso: TARGET },
    );
    assert.equal(projection.remainingTopics, 1, 'in_progress is not a pass');
    assert.equal(projection.topicsPerDay, 1);
  });

  it('ignores a stale timestamp on a topic that was demoted', () => {
    // She moved it back to in_progress. The old stamp is kept as history but is
    // no longer evidence of a pass she currently holds.
    const projection = projectFirstPass(
      [fact({ status: 'in_progress', firstPassAt: '2026-09-14T09:00:00.000Z' }), ...many(5)],
      { asOf: '2026-09-14', targetIso: TARGET },
    );
    assert.equal(projection.topicsPerDay, 0);
    assert.equal(projection.remainingTopics, 6);
    assert.equal(projection.daysToFirstPass, null);
  });

  it('says nothing is left when everything has passed', () => {
    const projection = projectFirstPass([passedOn('2026-09-10'), passedOn('2026-09-12')], {
      asOf: '2026-09-14',
      targetIso: TARGET,
    });
    assert.equal(projection.remainingTopics, 0);
    assert.equal(projection.daysToFirstPass, 0, 'done is zero days away, not an unknown');
    assert.equal(projection.projectedDateIso, '2026-09-14');
    assert.equal(projection.behindTarget, false);
  });

  it('is behind when the target has already passed and work remains', () => {
    const projection = projectFirstPass([passedOn('2027-04-01'), ...many(5)], {
      asOf: '2027-04-01',
      targetIso: TARGET,
    });
    assert.equal(projection.behindTarget, true);
  });

  it('accepts a full timestamp for asOf as well as a date', () => {
    const facts = [passedOn('2026-09-14'), ...many(9)];
    const fromDate = projectFirstPass(facts, { asOf: '2026-09-14', targetIso: TARGET });
    const fromStamp = projectFirstPass(facts, {
      asOf: '2026-09-14T23:41:02.000Z',
      targetIso: `${TARGET}T00:00:00.000Z`,
    });
    assert.deepEqual(fromStamp, fromDate);
  });

  it('handles an empty database without producing a number', () => {
    const projection = projectFirstPass([], { asOf: '2026-09-14', targetIso: TARGET });
    assert.equal(projection.remainingTopics, 0);
    assert.equal(projection.daysToFirstPass, 0);
    assert.equal(projection.sampleDays, 0);
    assert.equal(projection.behindTarget, false);
  });
});
