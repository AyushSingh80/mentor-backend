import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { planCatchUp, summariseCatchUpCapacity, type CatchUpPlan } from '../src/lib/catchup';
import { deriveStudyBlocks, type DerivedBlock, type ScheduleProfile } from '../src/lib/schedule';
import { toMinutes } from '../src/lib/time';
import type { BacklogSummary } from '../src/lib/backlog';

/** The real profile this app was built for: 2:30pm–11:30pm, Monday to Friday. */
const PROFILE: ScheduleProfile = {
  jobStartMinutes: toMinutes('14:30'),
  jobEndMinutes: toMinutes('23:30'),
  workDays: [1, 2, 3, 4, 5],
  commuteMinutesEachWay: 0,
  wakeMinutes: toMinutes('07:15'),
  sleepMinutes: toMinutes('00:45'),
};

const BLOCKS = deriveStudyBlocks(PROFILE);

const AS_OF = '2026-09-07';
const TARGET = '2027-03-31';

/** The planner's own floor for a reading slot. Mirrored from `lib/schedule.ts`. */
const READING_FLOOR = 45;

function minutes(block: DerivedBlock): number {
  return block.endMinutes - block.startMinutes;
}

/**
 * THE cap, re-derived from the planner rather than written down.
 *
 * Everything in this file measures against this, never against 180. A planner
 * change that shortens the catch-up slot has to move these tests with it; an
 * implementation that hardcodes the reference profile's number has to fail on
 * the other profiles below.
 */
function catchUpCap(blocks: DerivedBlock[], workDays: number[]): number {
  return blocks
    .filter((b) => b.kind === 'catchup' && !workDays.includes(b.dayOfWeek))
    .reduce((total, b) => total + minutes(b), 0);
}

/** Reading time above the planner's floor, on work days only. */
function readingSlack(blocks: DerivedBlock[], workDays: number[]): number {
  return blocks
    .filter((b) => b.kind === 'reading' && workDays.includes(b.dayOfWeek))
    .reduce((total, b) => total + Math.max(0, minutes(b) - READING_FLOOR), 0);
}

/**
 * A backlog summary with only the fields the planner reads filled in honestly.
 *
 * `rate` is deliberately given an observed speed that disagrees with the
 * assumed one in several tests below — the planner must ignore it.
 */
function summaryOf(backlogContentMin: number, over: Partial<BacklogSummary> = {}): BacklogSummary {
  return {
    course: 'all',
    asOf: AS_OF,
    releasedContentMin: backlogContentMin,
    watchedContentMin: 0,
    skippedContentMin: 0,
    backlogContentMin,
    rate: {
      windowDays: 14,
      sampleDays: 14,
      contentMinPerDay: 0,
      wallClockMinPerDay: 0,
      observedSpeed: null,
    },
    daysToClear: null,
    requiredContentMinPerDay: null,
    series: [],
    ...over,
  };
}

function plan(
  backlogHours: number,
  over: { speed?: number; maxSpeed?: number; blocks?: DerivedBlock[]; workDays?: number[] } = {},
): CatchUpPlan {
  return planCatchUp({
    summary: summaryOf(backlogHours * 60),
    blocks: over.blocks ?? BLOCKS,
    workDays: over.workDays ?? PROFILE.workDays,
    playbackSpeed: over.speed ?? 1.5,
    ...(over.maxSpeed === undefined ? {} : { maxPlaybackSpeed: over.maxSpeed }),
    targetIso: TARGET,
    asOf: AS_OF,
  });
}

function totalWallClock(p: CatchUpPlan): number {
  return p.steps.reduce((total, step) => total + step.wallClockMinPerWeek, 0);
}

/**
 * Spends a plan's wall-clock minutes against the real schedule, the way the
 * copy tells the user to: rest-day catch-up slots first (they are already
 * reserved for exactly this), then work-day reading above its floor.
 *
 * Returns the week she would actually be living, so the protected-work rule
 * can be asserted on BLOCKS rather than on prose. `unfunded` is the giveaway:
 * anything left over is time the plan asked for that does not exist in either
 * permitted pool, which could only have come out of answer writing.
 */
function applyPlan(blocks: DerivedBlock[], p: CatchUpPlan, workDays: number[]) {
  const work = new Set(workDays);
  const after = blocks.map((b) => ({ kind: b.kind, dayOfWeek: b.dayOfWeek, minutes: minutes(b) }));
  let unfunded = totalWallClock(p);

  for (const block of after) {
    if (block.kind !== 'catchup' || work.has(block.dayOfWeek)) continue;
    // The catch-up slot is USED, not shortened — it was always lecture time.
    unfunded -= Math.min(block.minutes, unfunded);
  }

  for (const block of after) {
    if (block.kind !== 'reading' || !work.has(block.dayOfWeek)) continue;
    const take = Math.min(Math.max(0, block.minutes - READING_FLOOR), unfunded);
    block.minutes -= take;
    unfunded -= take;
  }

  return { after, unfunded };
}

/* ------------------------------------------------------------------ capacity */

describe('summariseCatchUpCapacity', () => {
  it('reads the cap off the derived blocks rather than inventing it', () => {
    const capacity = summariseCatchUpCapacity(BLOCKS, PROFILE.workDays);
    const expected = catchUpCap(BLOCKS, PROFILE.workDays);

    assert.ok(expected > 0, 'the reference profile must actually have catch-up slots');
    assert.equal(capacity.catchupWallClockMinPerWeek, expected);
  });

  /**
   * The anti-hardcode test. Three profiles whose derived caps differ; a body
   * that returned a constant would satisfy at most one of them.
   */
  it('tracks the planner when the profile changes the cap', () => {
    const sixDayWeek = { ...PROFILE, workDays: [1, 2, 3, 4, 5, 6] };
    const lateWake = { ...PROFILE, wakeMinutes: toMinutes('12:30') };

    const cases: ScheduleProfile[] = [PROFILE, sixDayWeek, lateWake];
    const caps = cases.map((profile) => {
      const blocks = deriveStudyBlocks(profile);
      return {
        derived: catchUpCap(blocks, profile.workDays),
        reported: summariseCatchUpCapacity(blocks, profile.workDays).catchupWallClockMinPerWeek,
      };
    });

    for (const { derived, reported } of caps) assert.equal(reported, derived);

    const distinct = new Set(caps.map((c) => c.derived));
    assert.equal(distinct.size, 3, `expected three different caps, got ${[...distinct].join(', ')}`);
  });

  it('counts reading slack only above the planner’s 45-minute floor', () => {
    const capacity = summariseCatchUpCapacity(BLOCKS, PROFILE.workDays);
    assert.equal(
      capacity.reallocatableReadingMinPerWeek,
      readingSlack(BLOCKS, PROFILE.workDays),
    );

    // A reading block already at the floor contributes nothing.
    const atFloor: DerivedBlock[] = [
      { id: 'a', dayOfWeek: 1, startMinutes: 0, endMinutes: READING_FLOOR, kind: 'reading', label: 'r' },
    ];
    assert.equal(
      summariseCatchUpCapacity(atFloor, [1]).reallocatableReadingMinPerWeek,
      0,
    );
  });

  it('never counts active or timed-set minutes as spendable', () => {
    const protectedOnly: DerivedBlock[] = [
      { id: 'a', dayOfWeek: 0, startMinutes: 0, endMinutes: 600, kind: 'active', label: 'answers' },
      { id: 'b', dayOfWeek: 0, startMinutes: 600, endMinutes: 1200, kind: 'timed_set', label: 'set' },
      { id: 'c', dayOfWeek: 1, startMinutes: 0, endMinutes: 600, kind: 'active', label: 'answers' },
    ];
    const capacity = summariseCatchUpCapacity(protectedOnly, [1, 2, 3, 4, 5]);

    assert.equal(capacity.catchupWallClockMinPerWeek, 0);
    assert.equal(capacity.reallocatableReadingMinPerWeek, 0);
    assert.equal(capacity.lectureWallClockMinPerWeek, 0);
  });
});

/* ---------------------------------------------------------------- the two rules */

describe('planCatchUp — the weekend cap', () => {
  const CAP = catchUpCap(BLOCKS, PROFILE.workDays);
  const SLACK = readingSlack(BLOCKS, PROFILE.workDays);

  it('never proposes more weekend catch-up than the planner reserved', () => {
    // Across four orders of magnitude of backlog and every plausible speed.
    for (const hours of [0.5, 2, 4, 8, 16, 40, 80, 160, 400, 1000]) {
      for (const speed of [1, 1.25, 1.5, 1.75, 2]) {
        const p = plan(hours, { speed });
        // The catch-up-slot step is first by contract; the speed step and the
        // drop step cost no wall-clock at all.
        const catchupStep = p.steps[0]?.wallClockMinPerWeek ?? 0;
        assert.ok(
          catchupStep <= CAP,
          `${hours}h at ${speed}x proposed ${catchupStep} min of catch-up against a ${CAP} min cap`,
        );
        assert.ok(
          totalWallClock(p) <= CAP + SLACK + 1e-9,
          `${hours}h at ${speed}x proposed ${totalWallClock(p)} min against ${CAP} + ${SLACK} available`,
        );
      }
    }
  });

  it('fits entirely inside the catch-up slots and work-day reading slack', () => {
    for (const hours of [4, 40, 400]) {
      const { unfunded } = applyPlan(BLOCKS, plan(hours), PROFILE.workDays);
      assert.equal(unfunded, 0, `${hours}h backlog asked for ${unfunded} min that do not exist`);
    }
  });
});

describe('planCatchUp — active work is protected', () => {
  it('leaves every active and timed-set block untouched, at any backlog', () => {
    const before = BLOCKS.filter((b) => b.kind === 'active' || b.kind === 'timed_set');
    assert.ok(before.length > 0, 'the reference profile must have protected work to protect');

    for (const hours of [4, 12, 40, 140, 500]) {
      const { after } = applyPlan(BLOCKS, plan(hours), PROFILE.workDays);
      const protectedAfter = after.filter((b) => b.kind === 'active' || b.kind === 'timed_set');

      assert.equal(protectedAfter.length, before.length);
      protectedAfter.forEach((block, i) => {
        assert.equal(
          block.minutes,
          minutes(before[i]),
          `${hours}h backlog shortened a ${block.kind} block from ${minutes(before[i])} to ${block.minutes}`,
        );
      });
    }
  });

  it('never takes a reading block below 45 minutes', () => {
    for (const hours of [4, 12, 40, 140, 500, 2000]) {
      const { after } = applyPlan(BLOCKS, plan(hours), PROFILE.workDays);
      for (const block of after) {
        if (block.kind !== 'reading') continue;
        assert.ok(
          block.minutes >= READING_FLOOR,
          `${hours}h backlog cut reading to ${block.minutes} min, below the ${READING_FLOOR} min floor`,
        );
      }
    }
  });

  it('does not spend rest-day reading, which would be uncapped weekend catch-up', () => {
    const restDayReading = BLOCKS.filter(
      (b) => b.kind === 'reading' && !PROFILE.workDays.includes(b.dayOfWeek),
    );
    assert.ok(restDayReading.length > 0, 'the reference profile must have rest-day reading');

    const capacity = summariseCatchUpCapacity(BLOCKS, PROFILE.workDays);
    const restSlack = restDayReading.reduce(
      (total, b) => total + Math.max(0, minutes(b) - READING_FLOOR),
      0,
    );

    assert.ok(restSlack > 0);
    assert.equal(
      capacity.reallocatableReadingMinPerWeek,
      readingSlack(BLOCKS, PROFILE.workDays),
      'rest-day reading must not be in the spendable pool',
    );
  });
});

/* ----------------------------------------------------------------------- tiers */

describe('planCatchUp — tiers escalate', () => {
  it('clears a four-hour backlog inside the cap', () => {
    const p = plan(4);
    assert.equal(p.tier, 'within_cap');
    assert.ok(p.weeksToClear !== null && p.weeksToClear > 0);
    assert.ok(p.clearsBy !== null);
    assert.equal(p.lecturesToDrop, 0);
  });

  it('does not pretend a forty-hour backlog fits inside the cap', () => {
    const p = plan(40);
    assert.notEqual(p.tier, 'within_cap');
    assert.ok(
      p.steps.length >= 2,
      'escalating past the cap must add a lever, not just reword the headline',
    );
  });

  it('reaches for speed before it reaches for reading time', () => {
    const raise = plan(20, { speed: 1 });
    assert.equal(raise.tier, 'raise_speed');
    assert.equal(
      raise.steps.filter((s) => s.wallClockMinPerWeek > 0).length,
      1,
      'raising speed must not cost any new hours',
    );
  });

  it('says plainly that a huge backlog cannot be cleared', () => {
    const p = plan(200);
    assert.equal(p.tier, 'must_drop');
    assert.equal(p.weeksToClear, null, 'dropping lectures is not clearing them');
    assert.equal(p.clearsBy, null);
    assert.ok(p.lecturesToDrop > 0);
    assert.match(p.headline, /will not clear/);
    // Still bounded by the same two pools — must_drop does not license a raid
    // on answer writing.
    const { unfunded } = applyPlan(BLOCKS, p, PROFILE.workDays);
    assert.equal(unfunded, 0);
  });

  it('reports nothing to do when there is no backlog', () => {
    const p = plan(0);
    assert.equal(p.tier, 'within_cap');
    assert.deepEqual(p.steps, []);
    assert.equal(p.weeksToClear, 0);
    assert.equal(p.lecturesToDrop, 0);
  });

  it('escalates monotonically as the backlog grows', () => {
    const order = ['within_cap', 'raise_speed', 'reallocate_reading', 'must_drop'];
    let previous = -1;
    for (const hours of [1, 4, 12, 20, 30, 40, 80, 200, 600]) {
      const rank = order.indexOf(plan(hours, { speed: 1 }).tier);
      assert.ok(rank >= previous, `tier went backwards at ${hours}h`);
      previous = rank;
    }
    assert.equal(previous, order.length - 1, 'the largest backlog must reach must_drop');
  });
});

/* ------------------------------------------------------------------- the units */

describe('planCatchUp — content minutes are not wall-clock minutes', () => {
  const CAP = catchUpCap(BLOCKS, PROFILE.workDays);

  /**
   * THE regression this file exists for.
   *
   * 1400 content-minutes at 2× costs 700 wall-clock minutes: 175 a week over
   * the four-week horizon, comfortably inside the 180-minute cap. An
   * implementation that treated the cap as content minutes would see only
   * 180 × 4 = 720 available against 1400 needed and escalate. The two readings
   * differ by 94%, not by rounding.
   */
  it('converts wall-clock capacity to content at the playback speed', () => {
    const p = plan(1400 / 60, { speed: 2 });

    assert.equal(p.tier, 'within_cap', 'confusing the units here escalates a plan that fits');

    const step = p.steps[0];
    assert.equal(step.wallClockMinPerWeek, 175);
    assert.equal(step.contentMinPerWeek, 350);
    assert.equal(step.contentMinPerWeek, step.wallClockMinPerWeek * 2);
    assert.ok(step.wallClockMinPerWeek <= CAP);

    // Same hours, half the speed: half the content, and no longer within cap.
    const slower = plan(1400 / 60, { speed: 1 });
    assert.notEqual(slower.tier, 'within_cap');
  });

  it('uses the assumed speed, not the observed one', () => {
    // Observed throughput says 1×; the plan is about hours not yet spent, so
    // it must price them at the speed she intends to watch at.
    const p = planCatchUp({
      summary: summaryOf(1400, {
        rate: {
          windowDays: 14,
          sampleDays: 14,
          contentMinPerDay: 30,
          wallClockMinPerDay: 30,
          observedSpeed: 1,
        },
      }),
      blocks: BLOCKS,
      workDays: PROFILE.workDays,
      playbackSpeed: 2,
      targetIso: TARGET,
      asOf: AS_OF,
    });

    assert.equal(p.steps[0].contentMinPerWeek, p.steps[0].wallClockMinPerWeek * 2);
    assert.equal(p.tier, 'within_cap');
  });

  it('caps playback at 2x however optimistic the caller is', () => {
    const p = plan(60, { speed: 1, maxSpeed: 4 });

    for (const step of p.steps) {
      if (step.wallClockMinPerWeek === 0) continue;
      assert.ok(
        step.contentMinPerWeek <= step.wallClockMinPerWeek * 2 + 1,
        `step implies ${step.contentMinPerWeek / step.wallClockMinPerWeek}x playback`,
      );
    }

    const content = p.steps.reduce((total, s) => total + s.contentMinPerWeek, 0);
    const wall = totalWallClock(p);
    assert.ok(content <= wall * 2 + 1, `${content} content minutes from ${wall} wall-clock`);
    assert.doesNotMatch(p.headline, /2\.\d+×|[3-9](\.\d+)?×/);
  });

  it('does not round a 0.75x watcher up to real time', () => {
    const slow = plan(6, { speed: 0.75, maxSpeed: 0.75 });
    assert.equal(slow.steps[0].contentMinPerWeek, Math.round(slow.steps[0].wallClockMinPerWeek * 0.75));
  });
});

/* -------------------------------------------------------------- degenerate weeks */

describe('planCatchUp — weeks with no slack', () => {
  it('does not invent capacity when there are no rest days', () => {
    const alwaysWorking = { ...PROFILE, workDays: [0, 1, 2, 3, 4, 5, 6] };
    const blocks = deriveStudyBlocks(alwaysWorking);
    const p = plan(40, { blocks, workDays: alwaysWorking.workDays });

    assert.equal(p.capacity.catchupWallClockMinPerWeek, 0);
    const { unfunded } = applyPlan(blocks, p, alwaysWorking.workDays);
    assert.equal(unfunded, 0);
    assert.ok(totalWallClock(p) <= p.capacity.reallocatableReadingMinPerWeek);
  });

  it('cannot clear anything from an empty schedule', () => {
    const p = plan(10, { blocks: [], workDays: PROFILE.workDays });
    assert.equal(p.tier, 'must_drop');
    assert.equal(p.weeksToClear, null);
    assert.equal(totalWallClock(p), 0);
    assert.ok(p.lecturesToDrop > 0);
  });

  it('treats an already-passed target as one week, not a divide by zero', () => {
    const p = planCatchUp({
      summary: summaryOf(240),
      blocks: BLOCKS,
      workDays: PROFILE.workDays,
      playbackSpeed: 1.5,
      targetIso: '2026-01-01',
      asOf: AS_OF,
    });
    assert.ok(Number.isFinite(totalWallClock(p)));
    assert.ok(p.weeksToClear === null || Number.isFinite(p.weeksToClear));
  });
});

describe('planCatchUp — no step may be a no-op', () => {
  it('does not advise raising playback speed when the catch-up slot is empty', () => {
    // A tight rest day makes `allocate()` drop the catch-up slot entirely, so
    // the cap is legitimately zero. Escalation still raises the speed, and the
    // step was being emitted across zero minutes: "Same 0 min, 0 more
    // content-minutes a week", dressed up as a lever.
    const blocks = BLOCKS.filter((b) => b.kind !== 'catchup');
    assert.equal(catchUpCap(blocks, PROFILE.workDays), 0, 'fixture must have no catch-up slot');

    const p = planCatchUp({
      summary: summaryOf(600), // ten hours behind
      blocks,
      workDays: PROFILE.workDays,
      playbackSpeed: 1.5,
      targetIso: TARGET,
      asOf: AS_OF,
    });

    for (const step of p.steps) {
      assert.ok(
        step.wallClockMinPerWeek > 0 ||
          step.contentMinPerWeek > 0 ||
          /drop|abandon/i.test(step.text),
        `every step must do something: "${step.text}"`,
      );
    }
    assert.ok(
      !p.steps.some((s) => /instead of/i.test(s.text) && s.contentMinPerWeek === 0),
      'no zero-effect speed step',
    );
  });
});
