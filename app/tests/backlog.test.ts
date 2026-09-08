/**
 * Lecture backlog measurement.
 *
 * Every fixture here is built so that the two readings of a number — CONTENT
 * minutes at 1x versus WALL-CLOCK minutes actually spent — differ by far more
 * than rounding. A swap between them is wrong by exactly the playback speed,
 * which is 33–50%, produces no crash, and lands in the single figure this
 * feature exists to produce. A test that could pass under either reading is
 * worse than no test, so the deltas below are always hours, never minutes.
 *
 * The same technique as `tests/trend.test.ts`: make the wrong answer a
 * different NUMBER, not a slightly different one.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BACKLOG_RULES,
  buildBacklogSeries,
  describeBacklog,
  evaluateBacklogAlert,
  summariseBacklog,
  type LectureFact,
} from '../src/lib/backlog';

/* ------------------------------------------------------------------ fixture */

/** A Thursday, so the audit-day arithmetic is exercised against a real weekday. */
const DAY0 = '2026-01-01';
const TARGET = '2027-03-31';

/**
 * Day arithmetic for fixtures only. `Date` is banned inside `lib/backlog.ts`;
 * here it is pinned to UTC and never used for a comparison, so it cannot
 * reintroduce the drift the module avoids.
 */
function iso(offsetDays: number, from: string = DAY0): string {
  const base = Date.UTC(
    Number(from.slice(0, 4)),
    Number(from.slice(5, 7)) - 1,
    Number(from.slice(8, 10)),
  );
  return new Date(base + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/** 0 = Sunday, matching `auditDayOfWeek`. */
function dowOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

let nextId = 1;

function lecture(partial: Partial<LectureFact> & { runtimeMin: number; releasedOn: string }): LectureFact {
  return {
    id: nextId++,
    course: 'gs',
    watchedOn: null,
    skippedOn: null,
    playbackSpeed: null,
    ...partial,
  };
}

/** Floating-point comparison. Every tolerance here is far below a whole minute. */
function approx(actual: number | null, expected: number, message: string): void {
  assert.ok(actual !== null, `${message}: got null`);
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${message}: expected ${expected}, got ${actual}`,
  );
}

/**
 * A working aspirant's normal week: seven lectures released, five watched.
 *
 * 7 × 60 released − 5 × 60 watched = 120 content-minutes a week left behind —
 * a sustained two-hours-a-week deficit, which is the exact shape this feature
 * exists to catch. Backlog therefore reads 120 at the end of week one, 240 at
 * week two, and so on.
 */
function dripDays(days: number, opts: { course?: 'gs' | 'anthro'; speed?: number } = {}): LectureFact[] {
  const out: LectureFact[] = [];
  for (let day = 0; day < days; day += 1) {
    out.push(
      lecture({
        course: opts.course ?? 'gs',
        runtimeMin: 60,
        releasedOn: iso(day),
        watchedOn: day % 7 < 5 ? iso(day) : null,
        playbackSpeed: opts.speed ?? 1.5,
      }),
    );
  }
  return out;
}

const summaryAt = (facts: LectureFact[], asOf: string, course?: 'gs' | 'anthro') =>
  summariseBacklog(facts, { asOf, targetIso: TARGET, course });

const alertAt = (facts: LectureFact[], asOf: string, course?: 'gs' | 'anthro') =>
  evaluateBacklogAlert(facts, { asOf, auditDayOfWeek: dowOf(asOf), course });

/* ------------------------------------------------- content vs wall clock */

describe('watch rate — content minutes are not wall-clock minutes', () => {
  /**
   * THE regression this file exists for.
   *
   * 600 content-minutes watched at 1.5x cost 400 wall-clock minutes. The two
   * figures differ by 200 minutes — three hours twenty against six hours forty
   * — so no rounding, no window choice and no off-by-one can make one look
   * like the other.
   */
  it('reports 600 content-minutes watched at 1.5x as 400 wall-clock minutes', () => {
    const facts = [
      // 600 content-minutes watched, at 1.5x.
      lecture({ runtimeMin: 150, releasedOn: iso(0, '2026-03-02'), watchedOn: '2026-03-06', playbackSpeed: 1.5 }),
      lecture({ runtimeMin: 150, releasedOn: iso(1, '2026-03-02'), watchedOn: '2026-03-07', playbackSpeed: 1.5 }),
      lecture({ runtimeMin: 150, releasedOn: iso(2, '2026-03-02'), watchedOn: '2026-03-08', playbackSpeed: 1.5 }),
      lecture({ runtimeMin: 150, releasedOn: iso(3, '2026-03-02'), watchedOn: '2026-03-09', playbackSpeed: 1.5 }),
      // 600 content-minutes still outstanding.
      lecture({ runtimeMin: 150, releasedOn: iso(4, '2026-03-02') }),
      lecture({ runtimeMin: 150, releasedOn: iso(5, '2026-03-02') }),
      lecture({ runtimeMin: 150, releasedOn: iso(6, '2026-03-02') }),
      lecture({ runtimeMin: 150, releasedOn: iso(7, '2026-03-02') }),
    ];

    const summary = summaryAt(facts, '2026-03-15');

    assert.equal(summary.rate.windowDays, 14);
    assert.equal(summary.rate.sampleDays, 14, 'history reaches the full window');

    // The two figures, stated in the units their names promise.
    approx(summary.rate.contentMinPerDay * summary.rate.sampleDays, 600, 'content minutes watched');
    approx(summary.rate.wallClockMinPerDay * summary.rate.sampleDays, 400, 'wall-clock minutes spent');

    // Speed is measured, not assumed: content over the time it actually took.
    assert.equal(summary.rate.observedSpeed, 1.5);
    approx(summary.rate.contentMinPerDay / summary.rate.wallClockMinPerDay, 1.5, 'ratio is the speed');

    // Backlog is CONTENT, so it is 600 — not the 400 wall-clock minutes it
    // would cost her to clear, and not the 1200 released.
    assert.equal(summary.releasedContentMin, 1200);
    assert.equal(summary.watchedContentMin, 600);
    assert.equal(summary.backlogContentMin, 600);

    // 600 content ÷ (600/14) content per day = 14 days. Dividing the backlog by
    // the WALL-CLOCK rate instead gives 21 — a 50% error and the exact bug this
    // asserts against.
    approx(summary.daysToClear, 14, 'days to clear at the observed content rate');
    assert.ok(
      Math.abs((summary.daysToClear ?? 0) - 21) > 6,
      'days-to-clear must not be the wall-clock answer of 21',
    );
  });

  it('measures the rate as throughput, so speed moves wall-clock minutes and not the content rate', () => {
    const build = (speed: number): LectureFact[] => [
      lecture({ runtimeMin: 150, releasedOn: iso(0, '2026-03-02'), watchedOn: '2026-03-06', playbackSpeed: speed }),
      lecture({ runtimeMin: 150, releasedOn: iso(1, '2026-03-02'), watchedOn: '2026-03-07', playbackSpeed: speed }),
      lecture({ runtimeMin: 150, releasedOn: iso(2, '2026-03-02'), watchedOn: '2026-03-08', playbackSpeed: speed }),
      lecture({ runtimeMin: 150, releasedOn: iso(3, '2026-03-02'), watchedOn: '2026-03-09', playbackSpeed: speed }),
      lecture({ runtimeMin: 600, releasedOn: iso(4, '2026-03-02') }),
    ];

    const atOneX = summaryAt(build(1), '2026-03-15');
    const atOneAndAHalf = summaryAt(build(1.5), '2026-03-15');

    // Same 600 content-minutes cleared either way, so the same content rate and
    // the same days-to-clear. Speed is not a second helping of progress.
    approx(atOneX.rate.contentMinPerDay, atOneAndAHalf.rate.contentMinPerDay, 'content rate');
    approx(atOneX.daysToClear, atOneAndAHalf.daysToClear ?? 0, 'days to clear');

    // What speed does change is how much of her evening those minutes cost.
    approx(atOneX.rate.wallClockMinPerDay * 14, 600, '600 content-minutes at 1x cost 600 minutes');
    approx(atOneAndAHalf.rate.wallClockMinPerDay * 14, 400, 'the same content at 1.5x costs 400');
    assert.equal(atOneX.rate.observedSpeed, 1);
    assert.equal(atOneAndAHalf.rate.observedSpeed, 1.5);
  });

  it('treats an unrecorded playback speed as 1x rather than flattering the figure', () => {
    const summary = summaryAt(
      [lecture({ runtimeMin: 600, releasedOn: '2026-03-02', watchedOn: '2026-03-05', playbackSpeed: null })],
      '2026-03-15',
    );

    approx(summary.rate.wallClockMinPerDay * 14, 600, 'unknown speed costs full wall-clock time');
    assert.equal(summary.rate.observedSpeed, 1);
  });
});

/* ---------------------------------------------------------- sample window */

describe('watch rate — sampleDays is reported, not assumed', () => {
  it('divides six days of history by six and says so', () => {
    // First release is five days before `asOf`, so the log spans six days.
    const facts = [
      lecture({ runtimeMin: 200, releasedOn: '2026-03-10', watchedOn: '2026-03-13', playbackSpeed: 1.5 }),
      lecture({ runtimeMin: 200, releasedOn: '2026-03-11', watchedOn: '2026-03-13', playbackSpeed: 1.5 }),
      lecture({ runtimeMin: 200, releasedOn: '2026-03-12', watchedOn: '2026-03-13', playbackSpeed: 1.5 }),
      lecture({ runtimeMin: 300, releasedOn: '2026-03-14' }),
    ];

    const summary = summaryAt(facts, '2026-03-15');

    assert.equal(summary.rate.windowDays, 14, 'the window asked for is still fourteen');
    assert.equal(summary.rate.sampleDays, 6, 'but only six days of it are covered by data');

    // 600 content-minutes over six days is 100 a day. Dividing by fourteen
    // would say 42.9 a day and turn a three-day catch-up into a seven-day one,
    // in week one, which is when the app is still earning her trust.
    assert.equal(summary.rate.contentMinPerDay, 100);
    assert.equal(summary.backlogContentMin, 300);
    assert.equal(summary.daysToClear, 3);

    assert.ok(
      describeBacklog(summary).includes('last 6 days'),
      'the spoken description must carry the sample size',
    );
  });

  it('counts the sample window inclusively at both ends', () => {
    const start = '2026-03-02'; // asOf − 13
    const summary = summaryAt(
      [
        lecture({ runtimeMin: 60, releasedOn: '2026-02-01', watchedOn: '2026-03-01', playbackSpeed: 1 }), // one day early
        lecture({ runtimeMin: 120, releasedOn: start, watchedOn: start, playbackSpeed: 1 }), // first day in
        lecture({ runtimeMin: 180, releasedOn: start, watchedOn: '2026-03-15', playbackSpeed: 1 }), // asOf itself
      ],
      '2026-03-15',
    );

    assert.equal(summary.rate.sampleDays, 14);
    // 120 + 180 counted, the 60 outside the window not.
    approx(summary.rate.contentMinPerDay * 14, 300, 'both boundary days count, the day before does not');
  });

  it('reports a zero-day sample and no rate when nothing has been logged at all', () => {
    const summary = summaryAt([], '2026-03-15');

    assert.equal(summary.rate.sampleDays, 0);
    assert.equal(summary.rate.contentMinPerDay, 0);
    assert.equal(summary.rate.observedSpeed, null);
    assert.equal(summary.backlogContentMin, 0);
    assert.deepEqual(summary.series, []);
  });
});

/* -------------------------------------------------------- days to clear */

describe('daysToClear', () => {
  it('is null, never Infinity, when nothing was watched', () => {
    const summary = summaryAt(
      [
        lecture({ runtimeMin: 300, releasedOn: '2026-03-04' }),
        lecture({ runtimeMin: 300, releasedOn: '2026-03-07' }),
      ],
      '2026-03-15',
    );

    assert.equal(summary.backlogContentMin, 600);
    assert.equal(summary.rate.contentMinPerDay, 0);
    assert.equal(summary.rate.observedSpeed, null);

    assert.equal(summary.daysToClear, null);
    assert.notEqual(summary.daysToClear, Infinity);
    // `Infinity` survives arithmetic and dies at JSON, so a card renders "∞" or
    // "null" depending on the path it took. `null` is the same value everywhere.
    assert.equal(JSON.parse(JSON.stringify({ d: summary.daysToClear })).d, null);

    const spoken = describeBacklog(summary);
    assert.ok(spoken.includes('Nothing watched'), spoken);
    assert.ok(!spoken.includes('Infinity') && !spoken.includes('∞'), spoken);
  });

  it('is zero, not null, when there is nothing left to clear', () => {
    const summary = summaryAt(
      [lecture({ runtimeMin: 300, releasedOn: '2026-03-04', watchedOn: '2026-03-04', playbackSpeed: 2 })],
      '2026-03-15',
    );

    assert.equal(summary.backlogContentMin, 0);
    assert.equal(summary.daysToClear, 0);
  });
});

/* --------------------------------------------------- skipped is not watched */

describe('skipped lectures', () => {
  const released = [
    lecture({ runtimeMin: 600, releasedOn: '2026-03-02', watchedOn: '2026-03-05', playbackSpeed: 1 }),
    lecture({ runtimeMin: 600, releasedOn: '2026-03-04' }),
  ];

  it('leaves the backlog without entering the rate numerator', () => {
    const skipped = summaryAt(
      [...released, lecture({ runtimeMin: 600, releasedOn: '2026-03-03', skippedOn: '2026-03-06' })],
      '2026-03-15',
    );
    const watchedInstead = summaryAt(
      [
        ...released,
        lecture({ runtimeMin: 600, releasedOn: '2026-03-03', watchedOn: '2026-03-06', playbackSpeed: 1 }),
      ],
      '2026-03-15',
    );

    // Identical backlog: the skipped lecture left, exactly as a watched one would.
    assert.equal(skipped.backlogContentMin, 600);
    assert.equal(watchedInstead.backlogContentMin, 600);
    assert.equal(skipped.skippedContentMin, 600);
    assert.equal(skipped.watchedContentMin, 600);
    assert.equal(watchedInstead.watchedContentMin, 1200);

    // But the rate must not move. Ten hours of content in the numerator against
    // twenty is a doubled rate and a halved days-to-clear, handed to her in the
    // same breath as admitting she cannot keep up.
    approx(skipped.rate.contentMinPerDay * 14, 600, 'only watched content counts');
    approx(watchedInstead.rate.contentMinPerDay * 14, 1200, 'control: watching does count');
    approx(skipped.daysToClear, 14, 'skipping does not accelerate the plan');
    approx(watchedInstead.daysToClear, 7, 'control: watching does');
  });

  it('produces no rate at all from skips alone', () => {
    const summary = summaryAt(
      [
        lecture({ runtimeMin: 600, releasedOn: '2026-03-02', skippedOn: '2026-03-05' }),
        lecture({ runtimeMin: 600, releasedOn: '2026-03-03' }),
      ],
      '2026-03-15',
    );

    assert.equal(summary.skippedContentMin, 600);
    assert.equal(summary.rate.contentMinPerDay, 0);
    assert.equal(summary.rate.observedSpeed, null);
    assert.equal(summary.daysToClear, null);
  });

  it('resolves a row carrying both dates as skipped, the reading that never flatters the rate', () => {
    const summary = summaryAt(
      [
        lecture({
          runtimeMin: 600,
          releasedOn: '2026-03-02',
          watchedOn: '2026-03-05',
          skippedOn: '2026-03-06',
          playbackSpeed: 1.5,
        }),
        lecture({ runtimeMin: 600, releasedOn: '2026-03-03' }),
      ],
      '2026-03-15',
    );

    assert.equal(summary.skippedContentMin, 600);
    assert.equal(summary.watchedContentMin, 0);
    assert.equal(summary.rate.contentMinPerDay, 0);
  });
});

/* ------------------------------------------------------------------ series */

describe('buildBacklogSeries', () => {
  it('never emits a negative backlogContentMin', () => {
    const facts = [
      // Released long before the window, watched inside it: the window opens
      // holding 300 minutes it never saw released.
      lecture({ runtimeMin: 300, releasedOn: '2026-01-01', watchedOn: '2026-03-05', playbackSpeed: 1.5 }),
      // A mistyped release date — watched before it existed.
      lecture({ runtimeMin: 500, releasedOn: '2026-03-20', watchedOn: '2026-03-04', playbackSpeed: 1.5 }),
      // A skip with no matching release inside the window either.
      lecture({ runtimeMin: 400, releasedOn: '2025-12-20', skippedOn: '2026-03-07' }),
    ];

    const series = buildBacklogSeries(facts, '2026-03-01', '2026-03-10');

    assert.equal(series.length, 10);
    for (const point of series) {
      assert.ok(
        point.backlogContentMin >= 0,
        `${point.date} went negative: ${point.backlogContentMin}`,
      );
    }

    // The opening balance is carried in, not helpfully reset to zero: 300 + 400
    // released before the window and still outstanding on the first day shown.
    assert.equal(series[0].date, '2026-03-01');
    assert.equal(series[0].backlogContentMin, 700);
    // …and it clears as those two are dealt with, rather than being swallowed by
    // a running total sitting below zero.
    assert.equal(series[series.length - 1].backlogContentMin, 0);
  });

  it('stays non-negative across a long ragged drip', () => {
    const facts = dripDays(40);
    facts.push(lecture({ runtimeMin: 90, releasedOn: iso(3), skippedOn: iso(9) }));
    facts.push(lecture({ runtimeMin: 90, releasedOn: iso(30), watchedOn: iso(12), playbackSpeed: 2 }));

    const series = buildBacklogSeries(facts, iso(0), iso(39));
    assert.equal(series.length, 40);
    for (const point of series) assert.ok(point.backlogContentMin >= 0, point.date);

    // Per-day figures stay in content minutes and add up to the catalogue: the
    // forty drip lectures plus both ninety-minute strays, which are released on
    // days 3 and 30 and so both land inside the window.
    const releasedTotal = series.reduce((sum, p) => sum + p.releasedContentMin, 0);
    assert.equal(releasedTotal, 40 * 60 + 90 + 90);
  });

  it('returns nothing for a reversed or unparseable range', () => {
    const facts = dripDays(10);
    assert.deepEqual(buildBacklogSeries(facts, '2026-03-10', '2026-03-01'), []);
    assert.deepEqual(buildBacklogSeries(facts, 'yesterday', '2026-03-01'), []);
    assert.deepEqual(buildBacklogSeries(facts, '2026-02-30', '2026-03-01'), []);
  });

  it('emits one point per day inclusive of both ends', () => {
    const series = buildBacklogSeries(dripDays(10), iso(0), iso(6));
    assert.equal(series.length, 7);
    assert.equal(series[0].date, iso(0));
    assert.equal(series[6].date, iso(6));
    // Week one of the standard drip: seven hours released, five watched.
    assert.equal(series[6].backlogContentMin, 120);
  });
});

/* ------------------------------------------------------------------- alert */

describe('evaluateBacklogAlert — the history floor', () => {
  it('stays silent through weeks one to three of a normal drip', () => {
    const facts = dripDays(35);

    for (const day of [6, 13, 20]) {
      const alert = alertAt(facts, iso(day));
      assert.equal(alert.fired, false, `fired on day ${day}`);
      assert.equal(
        alert.suppressedBy,
        'insufficient_history',
        `day ${day} must be suppressed by the history floor, not by luck`,
      );
    }

    // The backlog really is growing every one of those weeks — the alert is
    // being held back on purpose, not because there is nothing to see.
    assert.equal(summaryAt(facts, iso(6)).backlogContentMin, 120);
    assert.equal(summaryAt(facts, iso(13)).backlogContentMin, 240);
    assert.equal(summaryAt(facts, iso(20)).backlogContentMin, 360);
  });

  it('fires the day the log is old enough, and not before', () => {
    const facts = dripDays(35);

    assert.equal(alertAt(facts, iso(20)).suppressedBy, 'insufficient_history');
    assert.equal(BACKLOG_RULES.minHistoryDays, 21);

    const onDay21 = alertAt(facts, iso(21));
    assert.equal(onDay21.fired, true);
    assert.equal(onDay21.suppressedBy, null);
    assert.equal(onDay21.reason, 'growing');
  });
});

describe('evaluateBacklogAlert — a sustained two-hours-a-week deficit', () => {
  const facts = dripDays(35);
  const asOf = iso(34);

  it('fires after 21+ days and reports the growth in content minutes', () => {
    const alert = alertAt(facts, asOf);

    assert.equal(alert.fired, true);
    assert.equal(alert.reason, 'growing');
    assert.equal(alert.suppressedBy, null);

    // Sampled at the audit day, a week back, and a fortnight back.
    assert.deepEqual(
      alert.samples.map((s) => s.date),
      [iso(20), iso(27), iso(34)],
    );
    assert.deepEqual(
      alert.samples.map((s) => s.backlogContentMin),
      [360, 480, 600],
    );

    // 120 content-minutes a week, twice over: two hours a week, four hours in
    // the fortnight. Left alone that is roughly fifty hours by March.
    assert.equal(alert.growthContentMin, 240);
    assert.equal(alert.samples[2].backlogContentMin - alert.samples[1].backlogContentMin, 120);
    assert.equal(alert.samples[1].backlogContentMin - alert.samples[0].backlogContentMin, 120);
  });

  it('counts back to the first non-growth week so the copy can escalate', () => {
    // Weeks ending on days 34, 27, 20, 13 and 6 all grew; the week before the
    // log started did not, which is where the count stops. Asked a fortnight
    // earlier the same walk finds three, so the copy escalates over time
    // instead of repeating one number forever.
    assert.equal(alertAt(facts, asOf).consecutiveGrowthWeeks, 5);
    assert.equal(alertAt(facts, iso(21)).consecutiveGrowthWeeks, 3);
    assert.ok(
      alertAt(facts, asOf).consecutiveGrowthWeeks > alertAt(facts, iso(21)).consecutiveGrowthWeeks,
    );
  });

  /**
   * Deliberately asserted as a REQUIREMENT, not tolerated as noise.
   *
   * Two hours a week compounds to roughly fifty by March. An alert that went
   * quiet after the first week to avoid nagging would be silent through exactly
   * the stretch it exists to interrupt, so once the history floor is cleared it
   * must keep firing for as long as the deficit is sustained.
   */
  it('keeps firing every week for as long as the deficit is sustained', () => {
    for (let day = 21; day <= 34; day += 1) {
      const alert = alertAt(facts, iso(day));
      assert.equal(alert.fired, true, `went quiet on day ${day}`);
      assert.equal(alert.growthContentMin, 240, `day ${day} growth`);
    }
  });

  it('does not fire when only one of the two weeks grew', () => {
    // Same drip, but the missed lectures of the final week get caught up.
    const recovered = dripDays(35).map((fact) =>
      fact.watchedOn === null && fact.releasedOn > iso(27)
        ? { ...fact, watchedOn: iso(34), playbackSpeed: 1.5 }
        : fact,
    );

    const alert = alertAt(recovered, asOf);
    assert.equal(alert.fired, false);
    // Not a guard: the guards all passed and the second week simply did not grow.
    assert.equal(alert.suppressedBy, null);
  });

  it('stays quiet while the backlog is too small to be worth interrupting for', () => {
    // Twenty-minute lectures, five of seven watched: 40 content-minutes a week,
    // so day 34 sits at 200 — over the 120 floor — but two weeks earlier is 120.
    const small: LectureFact[] = [];
    for (let day = 0; day < 35; day += 1) {
      small.push(
        lecture({
          runtimeMin: 20,
          releasedOn: iso(day),
          watchedOn: day % 7 < 5 ? iso(day) : null,
          playbackSpeed: 1.5,
        }),
      );
    }

    // 40 a week never clears the 60-content-minute absolute growth floor.
    const alert = alertAt(small, asOf);
    assert.equal(alert.fired, false);
    assert.equal(alert.suppressedBy, null);
    assert.equal(alert.growthContentMin, 80);
  });
});

describe('evaluateBacklogAlert — the bulk catalogue import', () => {
  /** A drip that stops on day 18, so the alert window holds only import dates. */
  function dripThenStop(): LectureFact[] {
    const out: LectureFact[] = [];
    for (let day = 0; day < 19; day += 1) {
      out.push(
        lecture({
          runtimeMin: 60,
          releasedOn: iso(day),
          watchedOn: day % 7 < 5 ? iso(day) : null,
          playbackSpeed: 1.5,
        }),
      );
    }
    return out;
  }

  function catalogue(count: number, onDays: number[]): LectureFact[] {
    const out: LectureFact[] = [];
    for (let i = 0; i < count; i += 1) {
      out.push(lecture({ runtimeMin: 60, releasedOn: iso(onDays[i % onDays.length]) }));
    }
    return out;
  }

  const asOf = iso(34);

  it('does not read a single-day 400-lecture import as a two-week slowdown', () => {
    const facts = [...dripThenStop(), ...catalogue(400, [30])];

    const alert = alertAt(facts, asOf);
    assert.equal(alert.fired, false);
    assert.equal(alert.suppressedBy, 'single_release_date');

    // Everything else about it screams: 404 hours outstanding, up from 4.
    assert.equal(summaryAt(facts, asOf).backlogContentMin, 240 + 400 * 60);
    assert.ok(alert.growthContentMin > 20_000);
    assert.equal(BACKLOG_RULES.minDistinctReleaseDates, 3);
  });

  it('does fire on the same volume once it is genuinely dripping across dates', () => {
    // Identical 400 lectures and identical total, released on three dates
    // inside the window instead of one.
    const facts = [...dripThenStop(), ...catalogue(400, [21, 25, 30])];

    const alert = alertAt(facts, asOf);
    assert.equal(alert.suppressedBy, null, 'three release dates clears the guard');
    assert.equal(alert.fired, true);
    assert.equal(alert.reason, 'growing');

    assert.equal(
      summaryAt(facts, asOf).backlogContentMin,
      summaryAt([...dripThenStop(), ...catalogue(400, [30])], asOf).backlogContentMin,
      'same backlog either way — only the release pattern differs',
    );
  });

  it('does not fire on a single bad week, however sharp', () => {
    // 22 days of history so the floor clears, but nothing outstanding until the
    // last few days: one week of growth, not two. Declining here is the growth
    // test doing its job, so there is no suppression reason to report — one bad
    // week followed by a recovery is not a trend, and calling it one is how the
    // alert stops being believed.
    const facts: LectureFact[] = [];
    for (let day = 0; day < 26; day += 1) {
      facts.push(
        lecture({
          runtimeMin: 60,
          releasedOn: iso(day),
          watchedOn: day <= 20 ? iso(day) : null,
          playbackSpeed: 1.5,
        }),
      );
    }

    const alert = alertAt(facts, iso(25));
    assert.equal(alert.fired, false);
    assert.equal(alert.suppressedBy, null, 'the backlog is real; it simply has not grown twice');
  });

  it('fires when a caught-up fortnight turns into a sustained slowdown', () => {
    /**
     * The onset case, and the whole reason this feature exists.
     *
     * A `b2 <= 0` guard used to sit in the predicate, reasoning that nothing
     * had been "compounding" if the backlog was empty a fortnight ago. That
     * silenced exactly this: someone perfectly up to date who then falls behind
     * for two solid weeks. The alert could only ever detect the CONTINUATION of
     * a slowdown, never its START — which is the one moment intervening is
     * still cheap.
     */
    const facts: LectureFact[] = [];
    for (let day = 0; day < 36; day += 1) {
      facts.push(
        lecture({
          runtimeMin: 60,
          releasedOn: iso(day),
          // Watched on the day, right up until the slowdown begins.
          watchedOn: day <= 21 ? iso(day) : null,
          playbackSpeed: day <= 21 ? 1.5 : null,
        }),
      );
    }

    const alert = alertAt(facts, iso(35));

    assert.equal(alert.fired, true, 'two weeks of growth from zero must be surfaced');
    assert.equal(alert.reason, 'growing');
    assert.equal(alert.suppressedBy, null);
    assert.equal(alert.samples[0]?.backlogContentMin, 0, 'she was genuinely caught up');
    assert.ok(alert.growthContentMin > 0);
    assert.ok(alert.consecutiveGrowthWeeks >= 2);
  });
});

/* --------------------------------------------------------------- per course */

describe('per-course measurement', () => {
  /**
   * The blended-figure failure: GS bulk-drips and falls behind while
   * Anthropology's fortnightly classes are watched on the day. One number for
   * both would either alarm her about Anthropology or reassure her about GS.
   */
  const facts = [
    ...dripDays(35, { course: 'gs' }),
    ...[4, 11, 18, 25, 32].map((day) =>
      lecture({
        course: 'anthro',
        runtimeMin: 90,
        releasedOn: iso(day),
        watchedOn: iso(day),
        playbackSpeed: 1.25,
      }),
    ),
  ];
  const asOf = iso(34);

  it('splits the backlog by course', () => {
    assert.equal(summaryAt(facts, asOf, 'gs').backlogContentMin, 600);
    assert.equal(summaryAt(facts, asOf, 'anthro').backlogContentMin, 0);
    assert.equal(summaryAt(facts, asOf).backlogContentMin, 600);

    // The combined figure really does mix both catalogues — the split above is
    // a filter, not two disconnected datasets.
    assert.equal(summaryAt(facts, asOf).releasedContentMin, 35 * 60 + 5 * 90);
    assert.equal(summaryAt(facts, asOf, 'gs').releasedContentMin, 35 * 60);
    assert.equal(summaryAt(facts, asOf, 'anthro').releasedContentMin, 5 * 90);
  });

  it('alerts on the course that is behind and leaves the current one alone', () => {
    assert.equal(alertAt(facts, asOf, 'gs').fired, true);
    assert.equal(alertAt(facts, asOf, 'anthro').fired, false);
    assert.equal(alertAt(facts, asOf, 'anthro').suppressedBy, 'backlog_too_small');
    assert.equal(alertAt(facts, asOf).fired, true, 'the combined view still sees it');
  });

  /**
   * A documented limit of the alert predicate, pinned here so it is a known
   * property rather than a surprise.
   *
   * Anthropology drips two classes a fortnight, and the backlog only ever grows
   * on a release. In any two consecutive weeks of a fortnightly course one week
   * has no release at all, so that week is flat and the "grew in BOTH weeks"
   * test can never pass — with or without the distinct-release-dates guard,
   * which also blocks it at two dates in the window. A falling-behind
   * Anthropology is therefore surfaced by the SUMMARY, not by the alert, and a
   * screen that shows only alerts would show nothing at all.
   */
  it('cannot raise a growth alert on a fortnightly course, so the summary must carry it', () => {
    const fortnightly = [0, 14, 28, 42].flatMap((day) => [
      lecture({ course: 'anthro', runtimeMin: 90, releasedOn: iso(day) }),
      lecture({ course: 'anthro', runtimeMin: 90, releasedOn: iso(day) }),
    ]);
    const sixWeeksIn = iso(42);

    const alert = alertAt(fortnightly, sixWeeksIn, 'anthro');
    assert.equal(alert.fired, false);
    // The off week is flat, so the growth predicate could not have passed either.
    assert.equal(alert.samples[1].backlogContentMin - alert.samples[0].backlogContentMin, 0);

    // What does carry it: six hours outstanding and no rate to clear them with.
    const summary = summaryAt(fortnightly, sixWeeksIn, 'anthro');
    assert.equal(summary.backlogContentMin, 720);
    assert.equal(summary.daysToClear, null);
    assert.ok(summaryAt(fortnightly, iso(28), 'anthro').backlogContentMin < summary.backlogContentMin);
  });

  it('names the course in the spoken description', () => {
    assert.ok(describeBacklog(summaryAt(facts, asOf, 'anthro')).startsWith('Anthropology backlog'));
    assert.ok(describeBacklog(summaryAt(facts, asOf, 'gs')).startsWith('General Studies backlog'));
    assert.ok(describeBacklog(summaryAt(facts, asOf)).startsWith('Lecture backlog'));
  });

  it('carries the course through to the summary', () => {
    assert.equal(summaryAt(facts, asOf, 'gs').course, 'gs');
    assert.equal(summaryAt(facts, asOf).course, 'all');
  });
});

/* ------------------------------------------------------- required rate */

describe('requiredContentMinPerDay', () => {
  it('is available on day one, before a single lecture is logged', () => {
    const summary = summariseBacklog([], {
      asOf: '2026-01-01',
      targetIso: '2026-04-01', // 90 days
      catalogueContentMin: 27_000,
    });

    assert.equal(summary.requiredContentMinPerDay, 300);
    assert.equal(summary.rate.contentMinPerDay, 0, 'nothing observed yet');
  });

  it('shrinks as the catalogue is worked through, counting skips as dealt with', () => {
    const summary = summariseBacklog(
      [
        lecture({ runtimeMin: 6_000, releasedOn: '2026-01-01', watchedOn: '2026-01-01', playbackSpeed: 1.5 }),
        lecture({ runtimeMin: 3_000, releasedOn: '2026-01-01', skippedOn: '2026-01-01' }),
      ],
      { asOf: '2026-01-01', targetIso: '2026-04-01', catalogueContentMin: 27_000 },
    );

    assert.equal(summary.requiredContentMinPerDay, (27_000 - 6_000 - 3_000) / 90);
  });

  it('is null rather than Infinity once the target has passed', () => {
    const summary = summariseBacklog([], {
      asOf: '2026-04-02',
      targetIso: '2026-04-01',
      catalogueContentMin: 27_000,
    });

    assert.equal(summary.requiredContentMinPerDay, null);
    assert.notEqual(summary.requiredContentMinPerDay, Infinity);
  });

  it('is null when no catalogue total was captured, and zero when it is finished', () => {
    const base = { asOf: '2026-01-01', targetIso: '2026-04-01' };
    assert.equal(summariseBacklog([], base).requiredContentMinPerDay, null);
    assert.equal(
      summariseBacklog([], { ...base, catalogueContentMin: null }).requiredContentMinPerDay,
      null,
    );
    assert.equal(
      summariseBacklog(
        [lecture({ runtimeMin: 27_000, releasedOn: '2026-01-01', watchedOn: '2026-01-01', playbackSpeed: 1 })],
        { ...base, catalogueContentMin: 27_000 },
      ).requiredContentMinPerDay,
      0,
    );
  });
});

/* --------------------------------------------------------------- narration */

describe('describeBacklog', () => {
  it('states content hours and the wall-clock cost separately', () => {
    // 600 content-minutes outstanding, watched history at 1.5x: ten hours of
    // content, six and a bit hours of her evenings.
    const summary = summaryAt(
      [
        lecture({ runtimeMin: 300, releasedOn: '2026-03-02', watchedOn: '2026-03-03', playbackSpeed: 1.5 }),
        lecture({ runtimeMin: 600, releasedOn: '2026-03-04' }),
      ],
      '2026-03-15',
    );

    const spoken = describeBacklog(summary);
    assert.ok(spoken.includes('10.0 hours of lecture content'), spoken);
    assert.ok(spoken.includes('6.7 hours of your time'), spoken);
    assert.ok(spoken.includes('1.50 times speed'), spoken);
    assert.ok(spoken.includes('last 14 days'), spoken);
  });

  it('says there is nothing outstanding rather than reciting a zero', () => {
    const spoken = describeBacklog(
      summaryAt(
        [lecture({ runtimeMin: 300, releasedOn: '2026-03-02', watchedOn: '2026-03-02', playbackSpeed: 1.5 })],
        '2026-03-15',
      ),
    );
    assert.ok(spoken.includes('nothing outstanding'), spoken);
  });
});

/* ------------------------------------------------------------ date handling */

describe('date handling', () => {
  it('compares dates byte-wise, so a lecture watched on asOf itself counts', () => {
    const summary = summaryAt(
      [lecture({ runtimeMin: 600, releasedOn: '2026-03-15', watchedOn: '2026-03-15', playbackSpeed: 1.5 })],
      '2026-03-15',
    );

    assert.equal(summary.releasedContentMin, 600);
    assert.equal(summary.watchedContentMin, 600);
    assert.equal(summary.backlogContentMin, 0);
  });

  it('ignores lectures released after asOf', () => {
    const summary = summaryAt(
      [
        lecture({ runtimeMin: 600, releasedOn: '2026-03-14' }),
        lecture({ runtimeMin: 600, releasedOn: '2026-03-16' }),
      ],
      '2026-03-15',
    );
    assert.equal(summary.backlogContentMin, 600);
  });

  it('drops rows whose dates cannot be placed on a calendar', () => {
    const summary = summaryAt(
      [
        lecture({ runtimeMin: 600, releasedOn: '2026-02-30' }), // no such day
        lecture({ runtimeMin: 300, releasedOn: '2026-03-14' }),
        lecture({ runtimeMin: 120, releasedOn: '2026-03-10', watchedOn: '15/03/2026', playbackSpeed: 1.5 }),
      ],
      '2026-03-15',
    );

    assert.equal(summary.releasedContentMin, 420);
    // The unparseable watch date is treated as no watch at all, never as today.
    assert.equal(summary.watchedContentMin, 0);
    assert.equal(summary.backlogContentMin, 420);
  });

  it('resolves the audit day to the most recent matching weekday on or before asOf', () => {
    const facts = dripDays(35);
    const wednesday = alertAt(facts, iso(34)); // iso(34) is itself the audit day
    assert.equal(wednesday.samples[2].date, iso(34));

    // Asking on the following Saturday still audits the same Wednesday.
    const later = evaluateBacklogAlert(facts, { asOf: iso(37), auditDayOfWeek: dowOf(iso(34)) });
    assert.equal(later.samples[2].date, iso(34));
    assert.deepEqual(
      later.samples.map((s) => s.date),
      [iso(20), iso(27), iso(34)],
    );
  });
});
