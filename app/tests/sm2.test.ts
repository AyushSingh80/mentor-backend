/**
 * SM-2 tests.
 *
 * Organised by the pitfall list in `src/lib/sm2.ts`'s header rather than by
 * function, because that list is the actual specification: each `describe`
 * below names the bug it exists to prevent, so a future regression report says
 * which rule broke rather than which line moved.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  GRADE_BUTTONS,
  SM2,
  applyReview,
  isDue,
  isLeech,
  selectDueList,
  startOfDayIso,
  type ReviewGrade,
  type Sm2State,
} from '../src/lib/sm2';

/** A brand-new topic: never reviewed, default ease. */
const FRESH: Sm2State = { repetitions: 0, intervalDays: 0, easeFactor: 2.5, lapses: 0 };

/** Mid-evening, which is when a night-shift worker actually revises. */
const AT_2200 = '2026-09-07T22:00:00.000Z';

/** Grades an item repeatedly, returning every intermediate result. */
function run(state: Sm2State, grades: ReviewGrade[], atIso = AT_2200) {
  const results = [];
  let current = state;
  for (const grade of grades) {
    const next = applyReview(current, grade, atIso);
    results.push(next);
    current = {
      repetitions: next.repetitions,
      intervalDays: next.intervalDays,
      easeFactor: next.easeFactor,
      lapses: next.lapses,
    };
  }
  return results;
}

/* --------------------------------------------------- pitfall: ease floor 1.3 */

describe('ease floor', () => {
  it('never drops the ease below 1.3 across 20 consecutive failures', () => {
    const results = run(FRESH, Array(20).fill(2) as ReviewGrade[]);

    for (const [i, result] of results.entries()) {
      assert.ok(
        result.easeFactor >= SM2.minEase,
        `review ${i + 1} produced ease ${result.easeFactor}, below the ${SM2.minEase} floor`,
      );
    }
    assert.equal(results[19]!.easeFactor, SM2.minEase);
  });

  it('keeps intervals and due dates positive under the same 20 failures', () => {
    // The failure mode the floor exists to stop: unclamped, the ease goes
    // negative around the ninth failure, the interval follows, and `dueAt`
    // lands permanently in the past — so every item is due, forever.
    for (const result of run(FRESH, Array(20).fill(2) as ReviewGrade[])) {
      assert.ok(result.intervalDays > 0, `non-positive interval ${result.intervalDays}`);
      assert.ok(result.dueAt > AT_2200.slice(0, 10), `dueAt ${result.dueAt} is not in the future`);
    }
  });

  it('reaches the floor from the default ease and stays there', () => {
    // 2.5 -> 1.3 is 1.2 of penalty, i.e. four failures at -0.32 (-1.28).
    const results = run(FRESH, [2, 2, 2, 2]);
    // Tolerance, not equality: the accumulated `+ delta` and the literal
    // `2.5 - 0.32` are different float expressions. Only q=4's exact zero is
    // asserted strictly, and that is asserted for its own sake above.
    assert.ok(Math.abs(results[0]!.easeFactor - 2.18) < 1e-9);
    assert.equal(results[3]!.easeFactor, SM2.minEase);
  });

  it('applies the floor to the harshest possible grade too', () => {
    // q=0 is -0.80. Two of them would take 2.5 to 0.9 without the clamp.
    const results = run(FRESH, [0, 0]);
    assert.equal(results[1]!.easeFactor, SM2.minEase);
  });
});

/* ------------------------------------------- pitfall: first two intervals */

describe('the first two intervals are constants', () => {
  it('schedules the first review at 1 day, not ease-many days', () => {
    const first = applyReview(FRESH, 4, AT_2200);
    assert.equal(first.intervalDays, SM2.firstInterval);
    assert.notEqual(first.intervalDays, 2.5, 'applied I * EF from the first review');
    assert.equal(first.repetitions, 1);
  });

  it('schedules the second review at 6 days, not 1 * ease', () => {
    const [, second] = run(FRESH, [4, 4]);
    assert.equal(second!.intervalDays, SM2.secondInterval);
    assert.notEqual(second!.intervalDays, 3, 'applied I * EF at the second review');
    assert.equal(second!.repetitions, 2);
  });

  it('only multiplies by the ease from the third review onward', () => {
    const results = run(FRESH, [4, 4, 4, 4, 4, 4, 4]);
    // 6 * 2.5 = 15, 15 * 2.5 = 37.5 -> 38, 38 * 2.5 = 95, then the ceiling.
    assert.deepEqual(
      results.map((r) => r.intervalDays),
      [1, 6, 15, 38, 95, 180, 180],
    );
  });

  it('reads the repetition count, not the interval, to pick the rule', () => {
    // A stored interval of 6 with repetitions 0 is a restarted item, and must
    // get the 1-day interval — this is why `repetitions` is a stored column.
    const restarted: Sm2State = { repetitions: 0, intervalDays: 6, easeFactor: 2.5, lapses: 1 };
    assert.equal(applyReview(restarted, 4, AT_2200).intervalDays, SM2.firstInterval);
  });
});

/* ----------------------------------------------------- pitfall: the q=4 delta */

describe('the ease delta formula', () => {
  it('leaves the ease exactly unchanged at q = 4', () => {
    // 0.1 - 1 * (0.08 + 1 * 0.02) = 0. Exact in IEEE-754, so this is a strict
    // equality on purpose: the cheapest proof the formula was transcribed right.
    assert.equal(applyReview(FRESH, 4, AT_2200).easeFactor, 2.5);
  });

  it('still leaves it unchanged after ten q = 4 reviews', () => {
    // Guards against a delta that is near-zero rather than zero, which would
    // drift invisibly over the 18 months this app is meant to run.
    const results = run(FRESH, [4, 4, 4, 4, 4, 4, 4, 4, 4, 4]);
    for (const result of results) assert.equal(result.easeFactor, 2.5);
  });

  it('raises the ease at q = 5 and lowers it at q = 3', () => {
    assert.equal(applyReview(FRESH, 5, AT_2200).easeFactor, 2.6);
    assert.ok(Math.abs(applyReview(FRESH, 3, AT_2200).easeFactor - 2.36) < 1e-9);
  });

  it('penalises the four grading buttons in a strictly increasing order', () => {
    const eases = GRADE_BUTTONS.map((b) => applyReview(FRESH, b.grade, AT_2200).easeFactor);
    for (let i = 1; i < eases.length; i += 1) {
      assert.ok(eases[i]! > eases[i - 1]!, `${GRADE_BUTTONS[i]!.label} is not easier than the one before`);
    }
  });

  it('uses the documented -0.32 penalty for Again rather than -0.80', () => {
    // `Again` is deliberately q=2, not q=0. See the note on GRADE_BUTTONS.
    assert.equal(GRADE_BUTTONS[0]!.grade, 2);
    assert.ok(Math.abs(applyReview(FRESH, 2, AT_2200).easeFactor - (2.5 - 0.32)) < 1e-9);
  });
});

/* ------------------------------------------ pitfall: interval-1 absorbing state */

describe('the interval-1 absorbing state', () => {
  const atFloor: Sm2State = { repetitions: 3, intervalDays: 1, easeFactor: SM2.minEase, lapses: 4 };

  it('escapes an interval of 1 at the ease floor', () => {
    // round(1 * 1.3) is 1, so a plain multiply reschedules for tomorrow forever
    // however many times the item is passed.
    const next = applyReview(atFloor, 4, AT_2200);
    assert.equal(next.intervalDays, 2);
  });

  it('keeps growing on every subsequent pass at the floor', () => {
    const results = run(atFloor, [4, 4, 4, 4, 4]);
    assert.deepEqual(
      results.map((r) => r.intervalDays),
      [2, 3, 4, 5, 7],
    );
  });

  it('prefers the multiplied interval once the ease makes it larger', () => {
    // At interval 5, 5 * 1.3 = 6.5 -> 7 beats the +1 guard's 6.
    const state: Sm2State = { repetitions: 6, intervalDays: 5, easeFactor: SM2.minEase, lapses: 4 };
    assert.equal(applyReview(state, 4, AT_2200).intervalDays, 7);
  });

  it('is monotonic for every ease down to the floor', () => {
    for (const easeFactor of [1.3, 1.4, 1.6, 2.0, 2.5, 3.0]) {
      for (const intervalDays of [1, 2, 3, 10, 40]) {
        const state: Sm2State = { repetitions: 5, intervalDays, easeFactor, lapses: 0 };
        const next = applyReview(state, 4, AT_2200);
        assert.ok(
          next.intervalDays > intervalDays,
          `ease ${easeFactor} at interval ${intervalDays} did not grow (got ${next.intervalDays})`,
        );
      }
    }
  });
});

/* ----------------------------------------------- pitfall: the date boundary */

describe('the date boundary', () => {
  it('schedules a 22:00 review from 00:00 the next day, not 22:00', () => {
    const next = applyReview(FRESH, 4, '2026-09-07T22:00:00.000Z');
    assert.equal(next.intervalDays, 1);
    assert.equal(next.dueAt, '2026-09-08T00:00:00.000Z');
  });

  it('is due for the whole of the next morning study block', () => {
    const next = applyReview(FRESH, 4, '2026-09-07T22:00:00.000Z');

    // The bug this replaces: a full-timestamp `dueAt` of 2026-09-08T22:00 is
    // invisible at 08:00 and only surfaces at 22:00, missing the entire block.
    assert.equal(isDue(next.dueAt, '2026-09-08T00:00:00.000Z'), true, 'not due at midnight');
    assert.equal(isDue(next.dueAt, '2026-09-08T08:00:00.000Z'), true, 'not due at 08:00');
    assert.equal(isDue(next.dueAt, '2026-09-08T10:00:00.000Z'), true, 'not due at 10:00');
    assert.equal(isDue(next.dueAt, '2026-09-08T23:59:59.999Z'), true, 'not due late that night');
  });

  it('is not due on the day of the review itself', () => {
    const next = applyReview(FRESH, 4, '2026-09-07T22:00:00.000Z');
    assert.equal(isDue(next.dueAt, '2026-09-07T23:59:59.999Z'), false);
  });

  it('always writes a start-of-day timestamp, whatever the review time', () => {
    for (const at of ['T00:00:00.000Z', 'T07:15:00.000Z', 'T13:37:04.321Z', 'T23:59:59.999Z']) {
      const next = applyReview(FRESH, 4, `2026-09-07${at}`);
      assert.ok(
        next.dueAt.endsWith('T00:00:00.000Z'),
        `review at ${at} produced a non-midnight dueAt: ${next.dueAt}`,
      );
      assert.equal(next.dueAt, '2026-09-08T00:00:00.000Z');
    }
  });

  it('does calendar arithmetic across month and year boundaries', () => {
    assert.equal(applyReview(FRESH, 4, '2026-12-31T22:00:00.000Z').dueAt, '2027-01-01T00:00:00.000Z');
    assert.equal(applyReview(FRESH, 4, '2028-02-28T22:00:00.000Z').dueAt, '2028-02-29T00:00:00.000Z'); // leap year
    const sixDays = applyReview(
      { repetitions: 1, intervalDays: 1, easeFactor: 2.5, lapses: 0 },
      4,
      '2026-09-28T22:00:00.000Z',
    );
    assert.equal(sixDays.intervalDays, 6);
    assert.equal(sixDays.dueAt, '2026-10-04T00:00:00.000Z');
  });

  it('adds whole days across a daylight-saving transition', () => {
    // UTC-anchored arithmetic, so no 23- or 25-hour day can shift the date.
    assert.equal(applyReview(FRESH, 4, '2026-03-28T22:00:00.000Z').dueAt, '2026-03-29T00:00:00.000Z');
    assert.equal(applyReview(FRESH, 4, '2026-10-24T22:00:00.000Z').dueAt, '2026-10-25T00:00:00.000Z');
  });

  it('compares by date prefix in both directions', () => {
    assert.equal(isDue('2026-09-08T00:00:00.000Z', '2026-09-09T00:00:00.000Z'), true, 'overdue');
    assert.equal(isDue('2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z'), true, 'due today');
    assert.equal(isDue('2026-09-09T00:00:00.000Z', '2026-09-08T23:59:59.999Z'), false, 'tomorrow');
    // Plain YYYY-MM-DD, as `localDate()` returns it, must compare identically.
    assert.equal(isDue('2026-09-08T00:00:00.000Z', '2026-09-08'), true);
  });

  it('collapses any timestamp to the start of its own day', () => {
    assert.equal(startOfDayIso('2026-09-07T22:00:00.000Z'), '2026-09-07T00:00:00.000Z');
    assert.equal(startOfDayIso('2026-09-07T00:00:00.000Z'), '2026-09-07T00:00:00.000Z');
    assert.equal(startOfDayIso('2026-09-07'), '2026-09-07T00:00:00.000Z');
  });

  it('refuses to write a due date it cannot parse', () => {
    // Silently accepting garbage would put an uncomparable string in `due_at`,
    // and the item would never be due again.
    assert.throws(() => startOfDayIso('not a date'));
    assert.throws(() => startOfDayIso(''));
  });

  it('never throws while reading, however malformed the stored value', () => {
    // `isDue` is the read path behind the daily list; one bad row must not be
    // able to blank the whole screen.
    assert.doesNotThrow(() => isDue('', '2026-09-08'));
    assert.equal(isDue('garbage', '2026-09-08'), false);
  });
});

/* ------------------------------------------------------------ pitfall: lapses */

describe('lapses', () => {
  const mature: Sm2State = { repetitions: 5, intervalDays: 40, easeFactor: 2.2, lapses: 1 };

  it('resets repetitions and the interval to 1', () => {
    const next = applyReview(mature, 2, AT_2200);
    assert.equal(next.repetitions, 0);
    assert.equal(next.intervalDays, SM2.firstInterval);
    assert.equal(next.lapsed, true);
  });

  it('does NOT reset the ease factor', () => {
    const next = applyReview(mature, 2, AT_2200);
    assert.notEqual(next.easeFactor, 2.5, 'ease was reset to the default on a lapse');
    assert.ok(next.easeFactor < mature.easeFactor, 'ease did not move at all');
  });

  it('still applies the ease penalty on a failure', () => {
    // The delta applies on EVERY grade. Skipping it on failures is the mistake
    // that stops an item ever reaching the floor, so leeches never surface.
    const next = applyReview(mature, 2, AT_2200);
    assert.ok(Math.abs(next.easeFactor - (2.2 - 0.32)) < 1e-9);
  });

  it('increments the lapse count', () => {
    assert.equal(applyReview(mature, 2, AT_2200).lapses, 2);
  });

  it('does not increment the lapse count on a pass', () => {
    const next = applyReview(mature, 3, AT_2200);
    assert.equal(next.lapses, 1);
    assert.equal(next.lapsed, false);
  });

  it('treats q = 3 as the lowest passing grade', () => {
    assert.equal(SM2.passingGrade, 3);
    assert.equal(applyReview(mature, 3, AT_2200).lapsed, false);
    assert.equal(applyReview(mature, 2, AT_2200).lapsed, true);
  });

  it('makes a lapsed item due tomorrow, not today', () => {
    const next = applyReview(mature, 2, '2026-09-07T22:00:00.000Z');
    assert.equal(next.dueAt, '2026-09-08T00:00:00.000Z');
    assert.equal(isDue(next.dueAt, '2026-09-07T22:30:00.000Z'), false, 'relapsed into the same day');
  });

  it('flags a leech only once the failures pile up', () => {
    assert.equal(isLeech({ ...FRESH, lapses: SM2.leechThreshold - 1 }), false);
    assert.equal(isLeech({ ...FRESH, lapses: SM2.leechThreshold }), true);
    assert.equal(isLeech({ ...FRESH, lapses: SM2.leechThreshold + 5 }), true);
  });

  it('surfaces a leech after a run of failures rather than silently retrying it', () => {
    const results = run(FRESH, Array(SM2.leechThreshold).fill(2) as ReviewGrade[]);
    const final = results[results.length - 1]!;
    assert.equal(final.easeFactor, SM2.minEase);
    assert.equal(isLeech(final), true);
  });
});

/* -------------------------------------------------- pitfall: interval ceiling */

describe('the interval ceiling', () => {
  it('caps the interval at 180 days', () => {
    const long: Sm2State = { repetitions: 8, intervalDays: 170, easeFactor: 2.5, lapses: 0 };
    assert.equal(applyReview(long, 5, AT_2200).intervalDays, SM2.maxIntervalDays);
  });

  it('holds at the ceiling instead of overflowing past it', () => {
    const capped: Sm2State = {
      repetitions: 9,
      intervalDays: SM2.maxIntervalDays,
      easeFactor: 2.5,
      lapses: 0,
    };
    const results = run(capped, [5, 5, 5]);
    for (const result of results) assert.equal(result.intervalDays, SM2.maxIntervalDays);
  });

  it('caps the due date to six months out, not further', () => {
    const long: Sm2State = { repetitions: 8, intervalDays: 175, easeFactor: 2.5, lapses: 0 };
    assert.equal(applyReview(long, 5, '2026-09-07T22:00:00.000Z').dueAt, '2027-03-06T00:00:00.000Z');
  });

  it('still lets a failure pull a capped item straight back to 1 day', () => {
    const capped: Sm2State = {
      repetitions: 9,
      intervalDays: SM2.maxIntervalDays,
      easeFactor: 2.5,
      lapses: 0,
    };
    assert.equal(applyReview(capped, 2, AT_2200).intervalDays, 1);
  });
});

/* ------------------------------------------------ pitfall: due-day pile-up */

describe('selectDueList', () => {
  const TODAY = '2026-09-08';
  const items = [
    { id: 'a', dueAt: '2026-09-08T00:00:00.000Z' },
    { id: 'b', dueAt: '2026-09-01T00:00:00.000Z' },
    { id: 'c', dueAt: '2026-09-05T00:00:00.000Z' },
    { id: 'd', dueAt: '2026-09-09T00:00:00.000Z' },
    { id: 'e', dueAt: '2026-08-30T00:00:00.000Z' },
  ];

  it('returns the most overdue first', () => {
    assert.deepEqual(
      selectDueList(items, TODAY, 10).map((i) => i.id),
      ['e', 'b', 'c', 'a'],
    );
  });

  it('excludes anything not yet due', () => {
    assert.equal(
      selectDueList(items, TODAY, 10).some((i) => i.id === 'd'),
      false,
    );
  });

  it('includes items due exactly today', () => {
    assert.equal(
      selectDueList(items, TODAY, 10).some((i) => i.id === 'a'),
      true,
    );
  });

  it('caps the day rather than fuzzing the intervals', () => {
    // 80 topics enrolled on day one all fall due together. The cap is the only
    // defence: fuzzing would spread the load and corrupt every later interval.
    const pileUp = Array.from({ length: 80 }, (_, i) => ({
      id: `t${i}`,
      dueAt: '2026-09-08T00:00:00.000Z',
    }));
    const selected = selectDueList(pileUp, TODAY, 20);
    assert.equal(selected.length, 20);
    // Untouched due dates: the cap hides the overflow, it does not reschedule it.
    for (const item of selected) assert.equal(item.dueAt, '2026-09-08T00:00:00.000Z');
  });

  it('is deterministic — no randomness anywhere in the selection', () => {
    const pileUp = Array.from({ length: 40 }, (_, i) => ({
      id: `t${i}`,
      dueAt: '2026-09-08T00:00:00.000Z',
    }));
    const first = selectDueList(pileUp, TODAY, 15).map((i) => i.id);
    const second = selectDueList(pileUp, TODAY, 15).map((i) => i.id);
    assert.deepEqual(first, second);
  });

  it('keeps the caller ordering for items sharing a due date', () => {
    const sameDay = [
      { id: 'third', dueAt: '2026-09-08T00:00:00.000Z' },
      { id: 'first', dueAt: '2026-09-01T00:00:00.000Z' },
      { id: 'fourth', dueAt: '2026-09-08T00:00:00.000Z' },
      { id: 'second', dueAt: '2026-09-01T00:00:00.000Z' },
    ];
    assert.deepEqual(
      selectDueList(sameDay, TODAY, 10).map((i) => i.id),
      ['first', 'second', 'third', 'fourth'],
    );
  });

  it('does not mutate the array it was given', () => {
    const original = items.map((i) => i.id);
    selectDueList(items, TODAY, 10);
    assert.deepEqual(
      items.map((i) => i.id),
      original,
    );
  });

  it('returns nothing for a non-positive or nonsensical cap', () => {
    assert.deepEqual(selectDueList(items, TODAY, 0), []);
    assert.deepEqual(selectDueList(items, TODAY, -5), []);
    assert.deepEqual(selectDueList(items, TODAY, Number.NaN), []);
  });

  it('handles an empty queue', () => {
    assert.deepEqual(selectDueList([], TODAY, 20), []);
  });
});

/* ------------------------------------------------------- end-to-end schedule */

describe('a realistic 18-month schedule', () => {
  it('expands a well-known topic and keeps a shaky one close', () => {
    const easy = run(FRESH, [5, 5, 5, 5]).map((r) => r.intervalDays);
    const shaky = run(FRESH, [3, 3, 3, 3]).map((r) => r.intervalDays);

    assert.ok(
      easy[easy.length - 1]! > shaky[shaky.length - 1]!,
      `an easy topic (${easy.join(',')}) should outrun a shaky one (${shaky.join(',')})`,
    );
    assert.deepEqual(easy.slice(0, 2), [1, 6]);
    assert.deepEqual(shaky.slice(0, 2), [1, 6]);
  });

  it('recovers a lapsed item through the constant intervals again', () => {
    const mature: Sm2State = { repetitions: 5, intervalDays: 40, easeFactor: 2.2, lapses: 0 };
    // Fail (ease 2.2 -> 1.88, interval 40 -> 1), then 1, 6, and 6 * 1.88 -> 11.
    assert.deepEqual(
      run(mature, [2, 4, 4, 4]).map((r) => r.intervalDays),
      [1, 1, 6, 11],
    );
  });

  it('carries the reduced ease into the recovery, so it is slower the second time', () => {
    const mature: Sm2State = { repetitions: 5, intervalDays: 40, easeFactor: 2.5, lapses: 0 };
    const lapsedRun = run(mature, [2, 4, 4, 4]).map((r) => r.intervalDays);
    const cleanRun = run(FRESH, [4, 4, 4]).map((r) => r.intervalDays);

    // Both replay 1 then 6, but the lapsed item multiplies by 2.18, not 2.5.
    assert.equal(lapsedRun[lapsedRun.length - 1]! < cleanRun[cleanRun.length - 1]!, true);
  });
});
