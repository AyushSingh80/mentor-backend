/**
 * Consistency and burnout.
 *
 * The property worth more than any single case: **silence is the normal
 * output**. An app that always has a concern is one whose concerns are scrolled
 * past, so most of this file asserts that ordinary weeks produce nothing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ACTIVITY_KINDS,
  activityByDay,
  dayOfWeek,
  dayRange,
  wasActive,
  type ActivityDay,
  type ActivityEvent,
  type ActivityKind,
} from '../src/lib/activity';
import { BURNOUT_RULES, describeSteadiness, detectBurnout } from '../src/lib/burnout';
import { STREAK_RULES, consistency, describeConsistency } from '../src/lib/streaks';

/* ------------------------------------------------------------------ helpers */

function event(
  day: string,
  kind: ActivityKind,
  minuteOfDay: number | null = 540,
  weight = 1,
): ActivityEvent {
  return { kind, day, minuteOfDay, weight };
}

/** `n` days ending 2026-09-30, each with the given kinds at 09:00. */
function history(
  n: number,
  build: (day: string, index: number) => ActivityEvent[],
): ActivityDay[] {
  const days = dayRange('2026-09-30', n);
  return activityByDay(days.flatMap((day, index) => build(day, index)), days);
}

const BUSY = (day: string): ActivityEvent[] => [
  event(day, 'answer'),
  event(day, 'mcq', 600, 10),
  event(day, 'revision', 620, 5),
];

/* ----------------------------------------------------------------- activity */

describe('activityByDay', () => {
  it('keeps a day with nothing on it', () => {
    // The whole reason the range is passed in. Inferring it from the events
    // would make a fortnight off look like a fortnight that never happened,
    // and every rate computed from it would be wrong in the flattering
    // direction.
    const days = activityByDay([event('2026-08-01', 'answer')], dayRange('2026-09-03', 3));
    assert.equal(days.length, 3);
    assert.equal(days.every((day) => !wasActive(day)), true, 'the event is outside the range');
  });

  it('drops an event outside the range rather than widening it', () => {
    const days = activityByDay(
      [event('2026-08-01', 'answer'), event('2026-09-30', 'answer')],
      dayRange('2026-09-30', 3),
    );
    assert.equal(days.length, 3);
    assert.equal(days.at(-1)?.weights.answer, 1);
  });

  it('folds several events of a day into one study day', () => {
    // Morning answer plus a commute drill is one study day, not two sessions.
    const days = activityByDay(
      [event('2026-09-30', 'answer', 540), event('2026-09-30', 'mcq', 1335, 10)],
      ['2026-09-30'],
    );
    assert.equal(days[0]?.breadth, 2);
    assert.equal(days[0]?.firstMinute, 540);
    assert.equal(days[0]?.lastMinute, 1335);
  });

  it('returns kinds in declared order, whatever order the events arrived', () => {
    const days = activityByDay(
      [event('2026-09-30', 'revision'), event('2026-09-30', 'answer')],
      ['2026-09-30'],
    );
    assert.deepEqual(days[0]?.kinds, ['answer', 'revision']);
  });

  it('ignores a kind this build does not know', () => {
    const days = activityByDay(
      [{ kind: 'yoga' as ActivityKind, day: '2026-09-30', minuteOfDay: 540, weight: 1 }],
      ['2026-09-30'],
    );
    assert.equal(wasActive(days[0]!), false);
  });

  it('takes mood and energy from a self-report without needing one', () => {
    const withReport = activityByDay(
      [event('2026-09-30', 'answer')],
      ['2026-09-30'],
      [{ day: '2026-09-30', mood: 3, energy: 2 }],
    );
    assert.equal(withReport[0]?.energy, 2);

    const without = activityByDay([event('2026-09-30', 'answer')], ['2026-09-30']);
    assert.equal(without[0]?.energy, null);
    assert.equal(wasActive(without[0]!), true, 'activity must not depend on a report');
  });

  it('builds a day range as label arithmetic, oldest first', () => {
    assert.deepEqual(dayRange('2026-03-01', 3), ['2026-02-27', '2026-02-28', '2026-03-01']);
  });

  it('returns nothing for an unparseable anchor rather than NaN days', () => {
    assert.deepEqual(dayRange('not-a-day', 3), []);
  });

  it('reads day-of-week off the label, not the device offset', () => {
    assert.equal(dayOfWeek('2026-09-12'), 6); // Saturday
    assert.equal(dayOfWeek('2026-09-13'), 0); // Sunday
  });
});

/* -------------------------------------------------------------- consistency */

describe('consistency', () => {
  const everyDay = new Set<string>();

  it('counts a run of study days', () => {
    const state = consistency({ days: history(10, BUSY), studyDays: everyDay });
    assert.equal(state.currentStreak, 10);
    assert.equal(state.adherence, 1);
  });

  it('does NOT break a streak on a planned rest day', () => {
    // A streak that demands seven days a week demands she never rest, on a
    // schedule where rest is the scarce input.
    const days = history(10, (day, index) => (index === 3 ? [] : BUSY(day)));
    const studyDays = new Set(days.filter((_d, index) => index !== 3).map((day) => day.day));
    const state = consistency({ days, studyDays });
    // SPANS the rest day rather than merely surviving it: six study days
    // worked, with a planned day off in the middle that is not counted either
    // way. A streak that reset to three here would be telling her the day off
    // cost her something.
    assert.equal(state.currentStreak, 9);
    assert.equal(state.adherence, 1, 'a rest day is not a miss');
  });

  it('breaks a streak on a missed STUDY day', () => {
    const days = history(7, (day, index) => (index === 5 ? [] : BUSY(day)));
    const state = consistency({ days, studyDays: everyDay });
    assert.equal(state.currentStreak, 1, 'only the final day');
    assert.ok((state.adherence ?? 1) < 1);
  });

  it('keeps the longest run as a record that cannot be lost', () => {
    // The property the live counter lacks, and the reason it is kept.
    const days = history(14, (day, index) => (index === 12 ? [] : BUSY(day)));
    const state = consistency({ days, studyDays: everyDay });
    assert.equal(state.currentStreak, 1);
    assert.equal(state.longestStreak, 12);
  });

  it('returns null rather than zero when there is too little history', () => {
    // Reporting 0% on day three is a false alarm that teaches her the number
    // is noise.
    const state = consistency({ days: history(3, BUSY), studyDays: everyDay });
    assert.equal(state.adherence, null);
    assert.equal(state.belowConcern, false);
  });

  it('counts days since active over CALENDAR days, not study days', () => {
    const days = history(10, (day, index) => (index < 6 ? BUSY(day) : []));
    const state = consistency({ days, studyDays: everyDay });
    assert.equal(state.daysSinceActive, 4);
  });

  it('flags a rate below the concern floor, and only with enough history', () => {
    const days = history(14, (day, index) => (index % 3 === 0 ? BUSY(day) : []));
    const state = consistency({ days, studyDays: everyDay });
    assert.ok((state.adherence ?? 1) < STREAK_RULES.concernRate);
    assert.equal(state.belowConcern, true);
  });

  it('exposes its own denominator, so the rate is checkable', () => {
    const days = history(14, (day, index) => (index < 10 ? BUSY(day) : []));
    const state = consistency({ days, studyDays: everyDay });
    assert.equal(state.studyDaysInWindow, 14);
    assert.equal(state.activeDaysInWindow, 10);
    assert.equal(state.adherence, 10 / 14);
  });
});

describe('describeConsistency', () => {
  const everyDay = new Set<string>();

  it('leads with the rate, not the chain', () => {
    const state = consistency({ days: history(14, BUSY), studyDays: everyDay });
    assert.match(describeConsistency(state), /^14 of the last 14 study days/);
  });

  it('never renders a broken streak as loss', () => {
    // The moment the app most needs not to rub it in.
    const days = history(20, (day, index) => (index < 15 ? BUSY(day) : []));
    const text = describeConsistency(consistency({ days, studyDays: everyDay }));
    assert.doesNotMatch(text, /streak/i);
    assert.doesNotMatch(text, /lost|broken|reset/i);
    assert.match(text, /one week does not undo a month/);
  });

  it('says something honest when there is no history', () => {
    const state = consistency({ days: history(2, BUSY), studyDays: everyDay });
    assert.match(describeConsistency(state), /fortnight|Not enough history/);
  });

  it('is always populated', () => {
    for (const n of [1, 3, 7, 14, 28]) {
      for (const build of [BUSY, () => []]) {
        const state = consistency({ days: history(n, build), studyDays: everyDay });
        assert.notEqual(describeConsistency(state).trim(), '');
      }
    }
  });
});

/* ----------------------------------------------------------------- burnout */

describe('detectBurnout — silence is the normal output', () => {
  it('says nothing about a steady month', () => {
    assert.equal(detectBurnout({ days: history(28, BUSY) }), null);
  });

  it('says nothing without enough history', () => {
    // Half a fortnight of nothing on day ten is a new user, not a burnout.
    assert.equal(detectBurnout({ days: history(10, () => []) }), null);
  });

  it('says nothing about one bad week inside a good month', () => {
    const days = history(28, (day, index) => (index >= 21 && index <= 25 ? [] : BUSY(day)));
    assert.equal(detectBurnout({ days }), null);
  });

  it('says nothing about a 20% dip, which is a normal fortnight', () => {
    const days = history(28, (day, index) =>
      index < 14 ? BUSY(day) : [event(day, 'answer'), event(day, 'mcq', 600, 9)],
    );
    assert.equal(detectBurnout({ days }), null);
  });
});

describe('detectBurnout — the small-hours signal', () => {
  it('catches work starting in the small hours', () => {
    // The direction is load-bearing: her shift ends at 23:30, so a 01:40
    // session falls on the NEXT calendar day at minute 100 — a SMALL number.
    // Testing a late `lastMinute` instead looks right and is backwards.
    const days = history(28, (day, index) =>
      index >= 20 ? [event(day, 'mcq', 100, 10)] : BUSY(day),
    );
    const finding = detectBurnout({ days });
    assert.equal(finding?.signal, 'late_night_drift');
    assert.match(finding?.observation ?? '', /small hours/);
  });

  it('does NOT catch a 23:45 session, which is normal on this shift', () => {
    const days = history(28, (day) => [event(day, 'mcq', 1425, 10), event(day, 'answer', 540)]);
    const finding = detectBurnout({ days });
    assert.notEqual(finding?.signal, 'late_night_drift');
  });

  it('does not fire on a single late night', () => {
    const days = history(28, (day, index) =>
      index === 27 ? [event(day, 'mcq', 90, 10)] : BUSY(day),
    );
    assert.equal(detectBurnout({ days }), null);
  });

  it('is reported before anything else, because sleep debt compounds', () => {
    // A fortnight that is BOTH narrow and in the small hours reports the sleep.
    const days = history(28, (day, index) =>
      index >= 14 ? [event(day, 'mcq', 120, 10)] : BUSY(day),
    );
    assert.equal(detectBurnout({ days })?.signal, 'late_night_drift');
  });
});

describe('detectBurnout — the other signals', () => {
  it('catches a real volume collapse', () => {
    const days = history(28, (day, index) => (index < 14 ? BUSY(day) : []));
    const finding = detectBurnout({ days });
    assert.equal(finding?.signal, 'volume_collapse');
    assert.match(finding?.observation ?? '', /down about \d+%/);
  });

  it('catches narrowing onto one surface, and names it', () => {
    // "You are only doing one thing" is a shrug. "You have only been drilling
    // MCQs" is something she recognises.
    const days = history(28, (day, index) =>
      index >= 14 ? [event(day, 'mcq', 600, 12)] : BUSY(day),
    );
    const finding = detectBurnout({ days });
    assert.equal(finding?.signal, 'narrowing');
    assert.match(finding?.observation ?? '', /MCQ drilling/);
  });

  it('catches low self-reported energy when she has reported it', () => {
    const range = dayRange('2026-09-30', 28);
    const days = activityByDay(
      range.flatMap((day) => BUSY(day)),
      range,
      range.slice(-6).map((day) => ({ day, mood: 2, energy: 2 })),
    );
    const finding = detectBurnout({ days });
    assert.equal(finding?.signal, 'low_energy');
  });

  it('does not run the energy check on one or two reports', () => {
    const range = dayRange('2026-09-30', 28);
    const days = activityByDay(
      range.flatMap((day) => BUSY(day)),
      range,
      [{ day: range.at(-1)!, mood: 1, energy: 1 }],
    );
    assert.equal(detectBurnout({ days }), null);
  });

  it('catches effort holding while scores fall', () => {
    const days = history(28, BUSY);
    const finding = detectBurnout({
      days,
      scoreFractions: [0.62, 0.6, 0.61, 0.48, 0.47, 0.46],
    });
    assert.equal(finding?.signal, 'effort_without_absorption');
  });

  it('stays silent on the absorption check when there are no scores', () => {
    // A check with no data must be silent, not clean.
    assert.equal(detectBurnout({ days: history(28, BUSY) }), null);
    assert.equal(detectBurnout({ days: history(28, BUSY), scoreFractions: [] }), null);
  });

  it('does not call falling scores absorption when the volume also collapsed', () => {
    // Then it is the volume finding, which comes first and is the true one.
    const days = history(28, (day, index) => (index < 14 ? BUSY(day) : []));
    const finding = detectBurnout({ days, scoreFractions: [0.7, 0.7, 0.7, 0.5, 0.5, 0.5] });
    assert.equal(finding?.signal, 'volume_collapse');
  });

  it('gives every finding one small thing to do', () => {
    const cases: ActivityDay[][] = [
      history(28, (day, index) => (index >= 20 ? [event(day, 'mcq', 100, 10)] : BUSY(day))),
      history(28, (day, index) => (index < 14 ? BUSY(day) : [])),
      history(28, (day, index) => (index >= 14 ? [event(day, 'mcq', 600, 12)] : BUSY(day))),
    ];
    for (const days of cases) {
      const finding = detectBurnout({ days });
      assert.notEqual(finding, null);
      assert.notEqual(finding?.suggestion.trim(), '');
      assert.notEqual(finding?.observation.trim(), '');
      // A list is a way of declining to prioritise.
      assert.ok((finding?.suggestion.match(/\./g) ?? []).length <= 3);
    }
  });
});

describe('describeSteadiness', () => {
  it('says nothing without enough history', () => {
    assert.equal(describeSteadiness(history(10, BUSY)), null);
  });

  it('says nothing when nothing has happened', () => {
    assert.equal(describeSteadiness(history(28, () => [])), null);
  });

  it('reports the shape of a steady month', () => {
    const text = describeSteadiness(history(28, BUSY));
    assert.match(text ?? '', /study days in the last 14/);
    assert.match(text ?? '', /kinds of work/);
  });
});

describe('the rules themselves', () => {
  it('sets thresholds a normal bad week cannot trip', () => {
    assert.ok(BURNOUT_RULES.volumeDropShare >= 0.4, 'a 20% dip is a normal fortnight');
    assert.ok(BURNOUT_RULES.lateNightCount >= 3, 'one bad night is not a pattern');
    assert.ok(BURNOUT_RULES.minDaysOfHistory >= 14, 'a new user is not a burnout');
  });

  it('keeps the small-hours bound before any legitimate start', () => {
    // Study starts at 08:00 on her derived schedule.
    assert.ok(BURNOUT_RULES.smallHoursEndMinute <= 5 * 60);
  });

  it('covers every activity kind in the weight record', () => {
    const days = activityByDay([], ['2026-09-30']);
    for (const kind of ACTIVITY_KINDS) {
      assert.equal(days[0]?.weights[kind], 0, `${kind} missing from the weights`);
    }
  });
});
