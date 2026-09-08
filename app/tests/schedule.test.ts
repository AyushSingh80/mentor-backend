import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deriveNotifications,
  deriveStudyBlocks,
  notificationsRespectWorkHours,
  summariseCapacity,
  type ScheduleProfile,
} from '../src/lib/schedule';
import { toMinutes } from '../src/lib/time';

/** The real profile this app was built for: 2:30pm–11:30pm, Monday to Friday. */
const PROFILE: ScheduleProfile = {
  jobStartMinutes: toMinutes('14:30'),
  jobEndMinutes: toMinutes('23:30'),
  workDays: [1, 2, 3, 4, 5],
  commuteMinutesEachWay: 0,
  wakeMinutes: toMinutes('07:15'),
  sleepMinutes: toMinutes('00:45'),
};

describe('deriveStudyBlocks', () => {
  const blocks = deriveStudyBlocks(PROFILE);

  it('schedules blocks on all seven days', () => {
    const days = new Set(blocks.map((b) => b.dayOfWeek));
    assert.equal(days.size, 7);
  });

  it('never schedules a study block during work hours', () => {
    const workday = blocks.filter((b) => PROFILE.workDays.includes(b.dayOfWeek));
    for (const b of workday) {
      if (b.kind === 'micro') continue; // commute drills bracket the shift
      assert.ok(
        b.endMinutes <= PROFILE.jobStartMinutes,
        `${b.label} at ${b.startMinutes}–${b.endMinutes} overlaps the shift`,
      );
    }
  });

  it('puts active work before lecture watching — the energy rule', () => {
    const monday = blocks
      .filter((b) => b.dayOfWeek === 1)
      .sort((a, b) => a.startMinutes - b.startMinutes);
    const firstActive = monday.findIndex((b) => b.kind === 'active');
    const firstLecture = monday.findIndex((b) => b.kind === 'lecture');
    assert.ok(firstActive !== -1, 'expected an active block');
    assert.ok(firstLecture !== -1, 'expected a lecture block');
    assert.ok(firstActive < firstLecture, 'lectures must not precede active work');
  });

  it('protects active work when the day is short', () => {
    const squeezed = deriveStudyBlocks({
      ...PROFILE,
      wakeMinutes: toMinutes('12:00'), // only ~2.5 hrs before the shift
    });
    const monday = squeezed.filter((b) => b.dayOfWeek === 1);
    assert.ok(
      monday.some((b) => b.kind === 'active'),
      'active work must survive a short day',
    );
    assert.ok(
      !monday.some((b) => b.kind === 'lecture'),
      'lectures should be cut first, pushing the shortfall into the visible backlog',
    );
  });

  it('caps weekend backlog catch-up so it cannot eat both days', () => {
    const catchup = blocks.filter((b) => b.kind === 'catchup');
    const totalMinutes = catchup.reduce((sum, b) => sum + (b.endMinutes - b.startMinutes), 0);
    assert.ok(totalMinutes <= 180, `weekend catch-up was ${totalMinutes} min, cap is 180`);
  });

  it('schedules commute drills only when there is a commute', () => {
    assert.equal(blocks.filter((b) => b.kind === 'micro').length, 0);
    const withCommute = deriveStudyBlocks({ ...PROFILE, commuteMinutesEachWay: 40 });
    assert.equal(withCommute.filter((b) => b.kind === 'micro').length, 10); // 2 per workday
  });
});

describe('summariseCapacity', () => {
  it('lands in the expected range for a Mon–Fri evening shift', () => {
    const capacity = summariseCapacity(deriveStudyBlocks(PROFILE), PROFILE.workDays);
    assert.ok(
      capacity.weekdayHours >= 26 && capacity.weekdayHours <= 30,
      `weekday hours were ${capacity.weekdayHours}`,
    );
    assert.ok(
      capacity.weekendHours >= 16 && capacity.weekendHours <= 20,
      `weekend hours were ${capacity.weekendHours}`,
    );
    assert.ok(
      capacity.totalWeeklyHours >= 42 && capacity.totalWeeklyHours <= 50,
      `weekly total was ${capacity.totalWeeklyHours}`,
    );
  });

  it('projects hours to the first-pass target', () => {
    const capacity = summariseCapacity(deriveStudyBlocks(PROFILE), PROFILE.workDays);
    const hours = capacity.projectedHoursTo('2027-03-31', '2026-09-07');
    assert.ok(hours > 1100 && hours < 1500, `projected ${hours} hours`);
  });
});

describe('deriveNotifications', () => {
  it('never fires during work hours', () => {
    const guard = notificationsRespectWorkHours(PROFILE, deriveNotifications(PROFILE));
    assert.equal(guard.ok, true, `violations: ${JSON.stringify(guard.violations)}`);
  });

  it('catches a schedule that would notify mid-shift', () => {
    const bad = deriveNotifications(PROFILE).map((n) =>
      n.id === 'morning-briefing' ? { ...n, minutes: toMinutes('18:00') } : n,
    );
    const guard = notificationsRespectWorkHours(PROFILE, bad);
    assert.equal(guard.ok, false);
    assert.equal(guard.violations[0]?.id, 'morning-briefing');
  });

  it('puts the weekly audit on a day off', () => {
    const audit = deriveNotifications(PROFILE).find((n) => n.id === 'weekly-audit');
    assert.ok(audit);
    assert.ok(!PROFILE.workDays.includes(audit.dayOfWeek!), 'audit must fall on a free day');
  });
});
