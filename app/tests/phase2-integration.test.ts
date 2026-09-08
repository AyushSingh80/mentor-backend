/**
 * Phase 2 cross-module integration.
 *
 * Four agents wrote `backlog.ts`, `catchup.ts`, `syllabus-seed.ts` and `sm2.ts`
 * in parallel against frozen type contracts. Each has its own unit suite, and
 * each passes. What no unit suite can catch is a disagreement at the SEAM —
 * two modules that both typecheck and both behave correctly in isolation while
 * meaning different things by the same number.
 *
 * So this file deliberately does not re-test any module's internals. It wires
 * the real modules together, with the real syllabus dataset and the real
 * derived schedule for the actual user this app is for, and asserts the
 * handoffs.
 *
 * Nothing here touches SQLite or React Native — every module under test is
 * pure, which is precisely why they were separated from their repositories.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evaluateBacklogAlert, summariseBacklog, type LectureFact } from '../src/lib/backlog';
import { planCatchUp, summariseCatchUpCapacity } from '../src/lib/catchup';
import { deriveStudyBlocks, type ScheduleProfile } from '../src/lib/schedule';
import { planSeed, type ExistingTopic, type SyllabusDataset } from '../src/lib/syllabus-seed';
import { coverageByPaper, projectFirstPass, type TopicFact } from '../src/lib/syllabus-coverage';
import { applyReview, isDue, SM2, type Sm2State } from '../src/lib/sm2';
import { SYLLABUS_V1 } from '../src/data/syllabus-v1';
import { toMinutes } from '../src/lib/time';

/** The real profile: job 2:30–11:30pm Mon–Fri, wake 7:15, sleep 12:45am. */
const REFERENCE_PROFILE: ScheduleProfile = {
  jobStartMinutes: toMinutes('14:30'),
  jobEndMinutes: toMinutes('23:30'),
  workDays: [1, 2, 3, 4, 5],
  commuteMinutesEachWay: 0,
  wakeMinutes: toMinutes('07:15'),
  sleepMinutes: toMinutes('00:45'),
};

const DAY_MS = 86_400_000;

function iso(dayOffset: number, from = '2026-09-07'): string {
  return new Date(Date.parse(`${from}T00:00:00Z`) + dayOffset * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Ten weeks of a course releasing 3 lectures a week on three separate days,
 * with a deliberate two-week slowdown in weeks 6 and 7.
 *
 * Three distinct release days a week matters: a single bulk release would trip
 * the `minDistinctReleaseDates` guard and the alert would be suppressed for a
 * reason unrelated to the thing under test.
 */
function dripCourse(): LectureFact[] {
  const facts: LectureFact[] = [];
  let id = 1;

  for (let week = 0; week < 10; week += 1) {
    // Weeks 5 and 6 (zero-indexed) are the slowdown: released, never watched.
    const slowdown = week === 5 || week === 6;

    for (const dayInWeek of [0, 2, 4]) {
      const released = week * 7 + dayInWeek;
      facts.push({
        id: id++,
        course: 'gs',
        runtimeMin: 60,
        releasedOn: iso(released),
        watchedOn: slowdown ? null : iso(released + 1),
        skippedOn: null,
        playbackSpeed: slowdown ? null : 1.5,
      });
    }
  }

  return facts;
}

describe('seam: backlog -> catch-up plan', () => {
  const facts = dripCourse();

  /**
   * Day 50, so the alert's two sample weeks land ON the slowdown.
   *
   * Day 0 is a Monday, so Sundays fall on days 6, 13, ... 48 — and audit day 0
   * (Sunday) is the first day off for a Mon–Fri worker, the same day
   * `deriveNotifications` picks for the weekly review. From day 50 the sampler
   * anchors at w0 = day 48, w1 = 41, w2 = 34, which brackets weeks 5 and 6
   * exactly.
   */
  const asOf = iso(50);

  const summary = summariseBacklog(facts, {
    asOf,
    targetIso: '2027-03-31',
    catalogueContentMin: 30 * 60,
  });

  it('the alert is silent through the healthy opening weeks', () => {
    for (const day of [6, 13, 20, 27]) {
      const alert = evaluateBacklogAlert(facts, { asOf: iso(day), auditDayOfWeek: 0 });
      assert.equal(
        alert.fired,
        false,
        `alert fired on day ${day}, during a period where she was keeping up`,
      );
    }
  });

  it('the alert fires during the sustained two-week slowdown', () => {
    const alert = evaluateBacklogAlert(facts, { asOf, auditDayOfWeek: 0 });
    assert.equal(alert.fired, true, 'a two-week slowdown must be surfaced');
    assert.equal(alert.reason, 'growing');
    assert.ok(alert.growthContentMin > 0);
    assert.ok(alert.consecutiveGrowthWeeks >= 2);
  });

  it('goes quiet once she catches up again, even though the backlog is still large', () => {
    // This is the alert's nature and it is easy to mistake for a bug: it
    // detects a TREND, not a STATE. Three weeks after the slowdown ends she is
    // watching everything again, so the fortnight before day 69 shows no
    // growth — and the banner correctly disappears while she is still hours
    // behind.
    //
    // Which is precisely why the summary, not the alert, is the thing that must
    // always be on screen. The same property is what makes a falling-behind
    // Anthropology invisible to the alert (a fortnightly course can never grow
    // in two consecutive weeks), and it is why Progress leads with
    // required-rate-vs-actual instead.
    const later = evaluateBacklogAlert(facts, { asOf: iso(69), auditDayOfWeek: 0 });
    assert.equal(later.fired, false, 'no growth in the sampled fortnight');

    const stillBehind = summariseBacklog(facts, {
      asOf: iso(69),
      targetIso: '2027-03-31',
      catalogueContentMin: null,
    });
    assert.ok(
      stillBehind.backlogContentMin > 0,
      'the backlog is still real — only the growth stopped',
    );
  });

  it('hands the catch-up planner a backlog it prices in the same units', () => {
    // THE SEAM. `summariseBacklog` emits content-minutes; `planCatchUp` spends
    // wall-clock minutes. If either module silently meant the other, the plan
    // would be wrong by exactly the playback speed with no error anywhere.
    const blocks = deriveStudyBlocks(REFERENCE_PROFILE);
    const plan = planCatchUp({
      summary,
      blocks,
      workDays: REFERENCE_PROFILE.workDays,
      playbackSpeed: 1.5,
      targetIso: '2027-03-31',
      asOf,
    });

    assert.ok(summary.backlogContentMin > 0, 'the fixture must actually be behind');

    const spend = plan.steps.reduce((sum, step) => sum + step.wallClockMinPerWeek, 0);
    const content = plan.steps.reduce((sum, step) => sum + step.contentMinPerWeek, 0);

    if (plan.steps.length > 0) {
      // Content must exceed wall-clock at any speed above 1x. Equal values mean
      // one of the two modules dropped the conversion entirely.
      assert.ok(
        content > spend,
        `content (${content}) must exceed wall-clock (${spend}) at 1.5x — the conversion was lost`,
      );
    }
  });

  it('never proposes more catch-up than the derived weekend cap', () => {
    const blocks = deriveStudyBlocks(REFERENCE_PROFILE);
    const capacity = summariseCatchUpCapacity(blocks, REFERENCE_PROFILE.workDays);

    // A brutal backlog, to force the planner to its limits.
    const brutal = summariseBacklog(
      [
        ...facts,
        ...Array.from({ length: 200 }, (_, i) => ({
          id: 1000 + i,
          course: 'gs' as const,
          runtimeMin: 60,
          releasedOn: iso(40 + (i % 20)),
          watchedOn: null,
          skippedOn: null,
          playbackSpeed: null,
        })),
      ],
      { asOf, targetIso: '2027-03-31', catalogueContentMin: null },
    );

    const plan = planCatchUp({
      summary: brutal,
      blocks,
      workDays: REFERENCE_PROFILE.workDays,
      playbackSpeed: 1.5,
      targetIso: '2027-03-31',
      asOf,
    });

    const catchupSpend = plan.steps
      .filter((s) => /catch|weekend/i.test(s.text))
      .reduce((sum, s) => sum + s.wallClockMinPerWeek, 0);

    assert.ok(
      catchupSpend <= capacity.catchupWallClockMinPerWeek + 1e-6,
      `plan spends ${catchupSpend} min/week of catch-up against a derived cap of ${capacity.catchupWallClockMinPerWeek}`,
    );

    // 200 hours behind is not recoverable; saying so is the honest outcome.
    assert.equal(plan.tier, 'must_drop');
    assert.ok(plan.lecturesToDrop > 0);
  });

  it('protects active work no matter how far behind she is', () => {
    // Structural, not a check: `active` and `timed_set` minutes never enter the
    // capacity budget, so nothing assembled from it can reach them.
    const blocks = deriveStudyBlocks(REFERENCE_PROFILE);
    const capacity = summariseCatchUpCapacity(blocks, REFERENCE_PROFILE.workDays);

    const activeMinutes = blocks
      .filter((b) => b.kind === 'active' || b.kind === 'timed_set')
      .reduce((sum, b) => sum + (b.endMinutes - b.startMinutes), 0);

    assert.ok(activeMinutes > 0, 'the reference schedule must contain active work');

    const budget =
      capacity.catchupWallClockMinPerWeek +
      capacity.lectureWallClockMinPerWeek +
      capacity.reallocatableReadingMinPerWeek;

    const allBlockMinutes = blocks.reduce((sum, b) => sum + (b.endMinutes - b.startMinutes), 0);
    assert.ok(
      budget < allBlockMinutes - activeMinutes + 1e-6,
      'the catch-up budget must exclude every minute of active and timed-set work',
    );
  });
});

describe('seam: real syllabus dataset -> seed plan -> coverage', () => {
  it('seeds the whole dataset on a fresh install', () => {
    const plan = planSeed([], SYLLABUS_V1 as SyllabusDataset);
    assert.equal(plan.insert.length, SYLLABUS_V1.entries.length);
    assert.equal(plan.update.length, 0);
    assert.equal(plan.tombstone.length, 0);
    assert.ok(plan.insert.length > 300, 'the real syllabus should be several hundred leaves');
  });

  it('is idempotent against the real dataset — a second launch writes nothing', () => {
    const existing: ExistingTopic[] = SYLLABUS_V1.entries.map((entry, i) => ({
      id: i + 1,
      slug: entry.slug,
      paper: entry.paper,
      topic: entry.topic,
      subtopic: entry.subtopic,
      position: entry.position,
      status: 'not_started',
      confidence: null,
      firstPassAt: null,
      revisedAt: null,
      retiredAt: null,
    }));

    const plan = planSeed(existing, SYLLABUS_V1 as SyllabusDataset);
    assert.equal(plan.insert.length, 0);
    assert.equal(plan.update.length, 0);
    assert.equal(plan.tombstone.length, 0);
    assert.equal(plan.revive.length, 0);
    assert.equal(plan.unchanged, SYLLABUS_V1.entries.length);
  });

  it('never puts an id in both tombstone and update', () => {
    const existing: ExistingTopic[] = SYLLABUS_V1.entries.slice(0, 50).map((entry, i) => ({
      id: i + 1,
      slug: entry.slug,
      paper: entry.paper,
      topic: `${entry.topic} (reworded)`,
      subtopic: entry.subtopic,
      position: entry.position,
      status: 'first_pass',
      confidence: 4,
      firstPassAt: '2026-10-01T00:00:00.000Z',
      revisedAt: null,
      retiredAt: null,
    }));

    const plan = planSeed(existing, SYLLABUS_V1 as SyllabusDataset);
    const updated = new Set(plan.update.map((u) => u.id));
    for (const id of plan.tombstone) {
      assert.ok(!updated.has(id), `id ${id} is both tombstoned and updated`);
    }
  });

  it('a reworded topic keeps its status through a re-seed', () => {
    const first = SYLLABUS_V1.entries[0]!;
    const existing: ExistingTopic[] = [
      {
        id: 1,
        slug: first.slug,
        paper: first.paper,
        // Wording drifted; the slug did not.
        topic: 'An older wording of this section',
        subtopic: 'An older wording of this bullet',
        position: first.position,
        status: 'first_pass',
        confidence: 5,
        firstPassAt: '2026-10-01T00:00:00.000Z',
        revisedAt: null,
        retiredAt: null,
      },
    ];

    const plan = planSeed(existing, {
      version: 1,
      entries: [first],
      renames: [],
    });

    assert.equal(plan.update.length, 1);
    assert.equal(plan.tombstone.length, 0);

    // The decisive assertion: the update payload has no field that could carry
    // status away. If `SyllabusSeedEntry` ever gains one, this fails loudly.
    const keys = Object.keys(plan.update[0]!.entry).sort();
    assert.deepEqual(keys, ['paper', 'position', 'slug', 'subtopic', 'topic']);
  });

  it('coverage over the real dataset is per-section, not just per-paper', () => {
    const facts: TopicFact[] = SYLLABUS_V1.entries.map((entry, i) => ({
      id: i + 1,
      slug: entry.slug,
      paper: entry.paper,
      topic: entry.topic,
      status: i < 40 ? 'first_pass' : 'not_started',
      confidence: i < 40 ? 4 : null,
      firstPassAt: i < 40 ? '2026-10-01T00:00:00.000Z' : null,
      retiredAt: null,
    }));

    const byPaper = coverageByPaper(facts);
    assert.ok(byPaper.length >= 6, 'every paper in the dataset should be represented');

    const total = byPaper.reduce((sum, row) => sum + row.total, 0);
    assert.equal(total, SYLLABUS_V1.entries.length);

    const passed = byPaper.reduce((sum, row) => sum + row.firstPass + row.revised, 0);
    assert.equal(passed, 40);
  });

  it('projects the first pass against the March 2027 target', () => {
    const facts: TopicFact[] = SYLLABUS_V1.entries.map((entry, i) => ({
      id: i + 1,
      slug: entry.slug,
      paper: entry.paper,
      topic: entry.topic,
      status: i < 14 ? 'first_pass' : 'not_started',
      confidence: null,
      // One topic a day for a fortnight.
      firstPassAt: i < 14 ? `${iso(i)}T00:00:00.000Z` : null,
      retiredAt: null,
    }));

    const projection = projectFirstPass(facts, { asOf: iso(13), targetIso: '2027-03-31' });

    assert.ok(projection.topicsPerDay > 0, 'a fortnight of steady work is a measurable rate');
    assert.equal(projection.remainingTopics, SYLLABUS_V1.entries.length - 14);
    assert.ok(projection.sampleDays > 0 && projection.sampleDays <= 14);
    // ~420 topics left at ~1/day lands well past March 2027 — she should be told.
    assert.equal(projection.behindTarget, true);
  });
});

describe('seam: first pass -> revision schedule', () => {
  it('carries a freshly passed topic through a realistic review run', () => {
    // 12 reviews with a lapse at the fifth — the shape of a topic that felt
    // solid, was forgotten once, and recovered.
    let state: Sm2State = { repetitions: 0, intervalDays: 0, easeFactor: 2.5, lapses: 0 };
    let day = 0;
    const intervals: number[] = [];

    for (let review = 1; review <= 12; review += 1) {
      const grade = review === 5 ? 2 : 4;
      const result = applyReview(state, grade, iso(day));
      intervals.push(result.intervalDays);

      assert.ok(
        result.easeFactor >= SM2.minEase,
        `ease fell below the floor at review ${review}: ${result.easeFactor}`,
      );
      assert.ok(result.intervalDays <= SM2.maxIntervalDays);
      assert.match(result.dueAt, /T00:00:00\.000Z$/, 'dueAt must be start-of-day');

      state = result;
      day += Math.round(result.intervalDays);
    }

    // The signature of SM-2's opening: fixed 1 then 6, never 1 x EF.
    assert.equal(intervals[0], 1);
    assert.equal(intervals[1], 6);

    // The lapse reset the interval but not the ease.
    assert.equal(intervals[4], 1, 'a failed review restarts the interval');
    assert.ok(state.lapses === 1, 'the lapse must be counted');
    assert.ok(state.easeFactor < 2.5, 'the ease penalty must persist past the lapse');

    // And it recovered rather than sticking at 1 forever.
    assert.ok(
      intervals[intervals.length - 1]! > 6,
      'the schedule must grow again after a lapse, not stall',
    );
  });

  it('a topic reviewed late at night is due from midnight, not that hour', () => {
    // The bug this guards: a card reviewed at 22:00 and scheduled "+1 day" as a
    // timestamp is invisible through the entire 08:00-10:00 morning block and
    // only appears at 22:00 — she concludes the queue is broken.
    const result = applyReview(
      { repetitions: 0, intervalDays: 0, easeFactor: 2.5, lapses: 0 },
      4,
      '2026-09-07T22:00:00.000Z',
    );

    assert.equal(result.dueAt.slice(0, 10), '2026-09-08');
    assert.equal(isDue(result.dueAt, '2026-09-08'), true, 'due from the start of the day');
    assert.equal(isDue(result.dueAt, '2026-09-07'), false, 'not due the evening it was reviewed');
  });
});
