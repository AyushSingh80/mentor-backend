/**
 * Phase 6 seams.
 *
 * Same charter as the four before it. The seam that matters most here is the
 * one between `deriveNotifications` (Phase 0, which decided WHEN) and
 * `notify-plan` (Phase 6, which decides WHAT): the ids are matched by string
 * across two files written eighteen months apart in project time, and an id
 * with no builder is a reminder that silently never fires.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { activityByDay, dayRange, type ActivityEvent } from '../src/lib/activity';
import { BURNOUT_RULES, detectBurnout } from '../src/lib/burnout';
import { contentFor, NOTIFY_RULES, type NotifyContext } from '../src/lib/notify-plan';
import {
  deriveNotifications,
  notificationsRespectWorkHours,
  type ScheduleProfile,
} from '../src/lib/schedule';
import { consistency, STREAK_RULES } from '../src/lib/streaks';

/** The reference profile from the README: 2:30pm–11:30pm, Mon–Fri. */
const PROFILE: ScheduleProfile = {
  jobStartMinutes: 14 * 60 + 30,
  jobEndMinutes: 23 * 60 + 30,
  workDays: [1, 2, 3, 4, 5],
  commuteMinutesEachWay: 45,
  wakeMinutes: 7 * 60 + 15,
  sleepMinutes: 24 * 60 + 45,
};

function ctx(overrides: Partial<NotifyContext> = {}): NotifyContext {
  const days = dayRange('2026-09-30', 28);
  return {
    revisionDue: 6,
    lecturesBehind: 2,
    unreadDigest: 3,
    drillsBanked: 6,
    mcqUnseen: 120,
    loggedToday: false,
    consistency: consistency({
      days: activityByDay(
        days.map((day): ActivityEvent => ({ kind: 'answer', day, minuteOfDay: 540, weight: 1 })),
        days,
      ),
      studyDays: new Set<string>(),
    }),
    ...overrides,
  };
}

/* ------------------------- seam 1: derived ids <-> content builders */

describe('seam: when a reminder fires <-> what it says', () => {
  it('has a content builder for every id the schedule derives', () => {
    // The load-bearing one. `deriveNotifications` and `contentFor` match on a
    // string across two files, and an id with no builder is a reminder that
    // silently never fires — no error, no log, just a channel that is quieter
    // than it should be.
    for (const derived of deriveNotifications(PROFILE)) {
      const content = contentFor(derived.id as never, ctx());
      assert.notEqual(content, null, `"${derived.id}" is derived but has no builder`);
    }
  });

  it('derives no more reminders than the daily ceiling allows', () => {
    const daily = deriveNotifications(PROFILE).filter((entry) => entry.dayOfWeek === null);
    assert.ok(daily.length <= NOTIFY_RULES.maxPerDay);
  });

  it('keeps every derived time outside her shift', () => {
    // Phase 0 asserted this; asserting it again here is what makes the
    // scheduling path — which now enforces it at runtime — trustworthy.
    const guard = notificationsRespectWorkHours(PROFILE, deriveNotifications(PROFILE));
    assert.equal(guard.ok, true, JSON.stringify(guard.violations));
  });

  it('keeps every built body inside the shade, on the worst-case context', () => {
    const worst = ctx({
      revisionDue: 999,
      lecturesBehind: 999,
      unreadDigest: 999,
      mcqUnseen: 0,
      drillsBanked: 0,
    });
    for (const derived of deriveNotifications(PROFILE)) {
      const content = contentFor(derived.id as never, worst);
      if (content === null) continue;
      assert.ok(
        content.body.length <= NOTIFY_RULES.maxBodyChars,
        `${derived.id}: ${content.body.length} chars`,
      );
    }
  });

  it('emits a weekly reminder on a day she does not work', () => {
    // A weekly audit scheduled on a Tuesday would be derived, pass the
    // work-hours guard on its minute, and still be useless.
    const weekly = deriveNotifications(PROFILE).filter((entry) => entry.dayOfWeek !== null);
    for (const entry of weekly) {
      assert.equal(
        PROFILE.workDays.includes(entry.dayOfWeek!),
        false,
        `${entry.id} lands on a work day`,
      );
    }
  });
});

/* ---------------------- seam 2: activity -> consistency -> notification */

describe('seam: activity -> consistency -> what the audit says', () => {
  it('carries the same denominator all the way to the notification body', () => {
    // The audit prints "20 of 28 study days". If the window the consistency was
    // computed over disagreed with the window the rate implies, that sentence
    // would be quietly wrong every week.
    const days = dayRange('2026-09-30', STREAK_RULES.windowDays);
    const state = consistency({
      days: activityByDay(
        days
          .slice(0, 20)
          .map((day): ActivityEvent => ({ kind: 'mcq', day, minuteOfDay: 600, weight: 10 })),
        days,
      ),
      studyDays: new Set<string>(),
    });
    assert.equal(state.studyDaysInWindow, STREAK_RULES.windowDays);
    assert.equal(state.activeDaysInWindow, 20);

    const body = contentFor('weekly-audit', ctx({ consistency: state })!)?.body ?? '';
    assert.match(body, new RegExp(`20 of ${STREAK_RULES.windowDays} study days`));
  });

  it('does not print a rate the consistency declined to compute', () => {
    const days = dayRange('2026-09-30', 3);
    const state = consistency({
      days: activityByDay([], days),
      studyDays: new Set<string>(),
    });
    assert.equal(state.adherence, null);
    const body = contentFor('weekly-audit', ctx({ consistency: state })!)?.body ?? '';
    assert.doesNotMatch(body, /0 of/);
  });
});

/* -------------------------------- seam 3: the windows agree with each other */

describe('seam: the windows three modules each assume', () => {
  it('gives burnout enough history for its own comparison', () => {
    // `detectBurnout` compares a window against the window before it, so it
    // needs twice its window. A history shorter than that would silently make
    // the volume check never run.
    assert.ok(BURNOUT_RULES.minDaysOfHistory >= BURNOUT_RULES.windowDays);
  });

  it('reads enough days for the volume comparison to have a baseline', () => {
    // The screen fetches 56 days. Below `windowDays * 2` the `previous` slice
    // is short and `volume_collapse` can never fire — a detector that is
    // silent for a structural reason rather than a clean one.
    const SCREEN_HISTORY_DAYS = 56;
    assert.ok(SCREEN_HISTORY_DAYS >= BURNOUT_RULES.windowDays * 2);
  });

  it('keeps the consistency window inside what the screen reads', () => {
    const SCREEN_HISTORY_DAYS = 56;
    assert.ok(STREAK_RULES.windowDays <= SCREEN_HISTORY_DAYS);
  });

  it('needs less history for a rate than for a burnout finding', () => {
    // She should see a consistency number weeks before the app is willing to
    // say anything about strain. The reverse would mean a strain warning on a
    // screen that admits it does not know how consistent she has been.
    assert.ok(STREAK_RULES.minDaysForRate < BURNOUT_RULES.minDaysOfHistory);
  });
});

/* ----------------------------- seam 4: passive signals, end to end */

describe('seam: the detector works with no self-reports at all', () => {
  it('finds strain from activity alone', () => {
    // The property the whole design rests on. A detector that needs a mood
    // slider has no data exactly when it is needed, and its silence then reads
    // as reassurance.
    const days = dayRange('2026-09-30', 28);
    const events = days.flatMap((day, index): ActivityEvent[] =>
      index >= 20 ? [{ kind: 'mcq', day, minuteOfDay: 100, weight: 10 }] : [
        { kind: 'answer', day, minuteOfDay: 540, weight: 1 },
        { kind: 'mcq', day, minuteOfDay: 600, weight: 10 },
      ],
    );
    const assembled = activityByDay(events, days);
    assert.equal(assembled.every((day) => day.energy === null), true, 'no reports at all');

    const finding = detectBurnout({ days: assembled });
    assert.equal(finding?.signal, 'late_night_drift');
  });

  it('is not made worse by reports arriving', () => {
    // Enrichment must never flip a finding off. A day she rated 5/5 while
    // studying at 01:40 is still a day she studied at 01:40.
    const days = dayRange('2026-09-30', 28);
    const events = days.flatMap((day, index): ActivityEvent[] =>
      index >= 20 ? [{ kind: 'mcq', day, minuteOfDay: 100, weight: 10 }] : [
        { kind: 'answer', day, minuteOfDay: 540, weight: 1 },
      ],
    );
    const withReports = activityByDay(
      events,
      days,
      days.map((day) => ({ day, mood: 5, energy: 5 })),
    );
    assert.equal(detectBurnout({ days: withReports })?.signal, 'late_night_drift');
  });
});
