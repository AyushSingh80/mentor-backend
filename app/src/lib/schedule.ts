/**
 * Derives study blocks and notification times from the user's actual shift.
 *
 * Two rules are encoded here rather than left to discipline:
 *
 * 1. ENERGY ORDER. Active work (answer writing, recall) is scheduled first,
 *    into the freshest hours. Passive lecture watching goes last. Spending a
 *    sharp morning on recorded lectures is the most common way a working
 *    aspirant wastes their best time.
 *
 * 2. ACTIVE WORK IS PROTECTED. When the day is short, lectures get cut, never
 *    answer writing. That deliberately pushes the shortfall into the lecture
 *    backlog where the tracker can see it, instead of silently eroding the
 *    habit that takes longest to build.
 */

import { durationHours, MINUTES_PER_DAY } from './time';

export type BlockKind = 'active' | 'reading' | 'lecture' | 'micro' | 'timed_set' | 'catchup';

export interface ScheduleProfile {
  jobStartMinutes: number;
  jobEndMinutes: number;
  workDays: number[];
  commuteMinutesEachWay: number;
  wakeMinutes: number;
  sleepMinutes: number;
}

export interface DerivedBlock {
  /** Stable across a render — safe as a React list key, unique across all days. */
  id: string;
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
  kind: BlockKind;
  label: string;
}

function blockId(dayOfWeek: number, kind: BlockKind, startMinutes: number): string {
  return `${dayOfWeek}-${kind}-${startMinutes}`;
}

interface Slot {
  kind: BlockKind;
  label: string;
  /** Ideal length in minutes. */
  target: number;
  /** Below this the slot is dropped rather than shrunk into uselessness. */
  min: number;
}

/** Minutes between waking and being able to actually study. */
const READY_BUFFER = 45;
/** Gap between blocks. */
const BREAK = 15;
/** Reserved before leaving for work: the 2-minute log plus getting ready. */
const PRE_SHIFT_BUFFER = 20;
/** Weekend lecture catch-up is capped; it must not eat both days. */
const WEEKEND_CATCHUP_CAP_PER_DAY = 90;

const WORKDAY_SLOTS: Slot[] = [
  { kind: 'active', label: 'Answer writing & active recall', target: 120, min: 60 },
  { kind: 'reading', label: 'Reading & note consolidation', target: 120, min: 45 },
  { kind: 'lecture', label: 'Recorded lectures (at your playback speed)', target: 120, min: 30 },
];

const OFFDAY_SLOTS: Slot[] = [
  { kind: 'timed_set', label: 'Timed answer set (exam conditions)', target: 120, min: 60 },
  { kind: 'active', label: 'Anthropology depth work', target: 105, min: 45 },
  { kind: 'reading', label: 'Reading & note consolidation', target: 120, min: 45 },
  { kind: 'lecture', label: 'Recorded lectures (at your playback speed)', target: 105, min: 30 },
  { kind: 'catchup', label: 'Lecture backlog catch-up (capped)', target: WEEKEND_CATCHUP_CAP_PER_DAY, min: 30 },
];

/**
 * Fits slots into the available window in priority order, shrinking the tail
 * before the head. Returns only the slots that survived at usable length.
 */
function allocate(slots: Slot[], availableMinutes: number): (Slot & { length: number })[] {
  const out: (Slot & { length: number })[] = [];
  let remaining = availableMinutes;

  for (let i = 0; i < slots.length; i += 1) {
    const slot = slots[i]!;
    const needsBreak = out.length > 0 ? BREAK : 0;
    const usable = remaining - needsBreak;

    if (usable < slot.min) break; // Nothing left worth scheduling.

    const length = Math.min(slot.target, usable);
    out.push({ ...slot, length });
    remaining = usable - length;
  }

  return out;
}

function layOut(
  dayOfWeek: number,
  startMinutes: number,
  allocated: (Slot & { length: number })[],
): DerivedBlock[] {
  const blocks: DerivedBlock[] = [];
  let cursor = startMinutes;

  for (const slot of allocated) {
    if (blocks.length > 0) cursor += BREAK;
    blocks.push({
      id: blockId(dayOfWeek, slot.kind, cursor),
      dayOfWeek,
      startMinutes: cursor,
      endMinutes: cursor + slot.length,
      kind: slot.kind,
      label: slot.label,
    });
    cursor += slot.length;
  }

  return blocks;
}

export function deriveStudyBlocks(profile: ScheduleProfile): DerivedBlock[] {
  const workDays = new Set(profile.workDays);
  const blocks: DerivedBlock[] = [];
  const studyStart = profile.wakeMinutes + READY_BUFFER;

  for (let day = 0; day < 7; day += 1) {
    if (workDays.has(day)) {
      const studyEnd =
        profile.jobStartMinutes - profile.commuteMinutesEachWay - PRE_SHIFT_BUFFER;
      const available = studyEnd - studyStart;
      if (available > 0) {
        blocks.push(...layOut(day, studyStart, allocate(WORKDAY_SLOTS, available)));
      }

      // Commute drills, both directions. Offline by design — these run on
      // patchy mobile data or none at all.
      if (profile.commuteMinutesEachWay >= 10) {
        const outbound = profile.jobStartMinutes - profile.commuteMinutesEachWay;
        blocks.push({
          id: blockId(day, 'micro', outbound),
          dayOfWeek: day,
          startMinutes: outbound,
          endMinutes: outbound + profile.commuteMinutesEachWay,
          kind: 'micro',
          label: 'Commute drill — MCQ & flashcards',
        });
        blocks.push({
          id: blockId(day, 'micro', profile.jobEndMinutes),
          dayOfWeek: day,
          startMinutes: profile.jobEndMinutes,
          endMinutes: profile.jobEndMinutes + profile.commuteMinutesEachWay,
          kind: 'micro',
          label: 'Commute drill — light revision only',
        });
      }
    } else {
      // Off day. Sleep is the constraint, not the job.
      const sleepAt =
        profile.sleepMinutes < profile.wakeMinutes
          ? profile.sleepMinutes + MINUTES_PER_DAY
          : profile.sleepMinutes;
      const available = Math.max(0, sleepAt - 120 - studyStart);
      blocks.push(...layOut(day, studyStart, allocate(OFFDAY_SLOTS, available)));
    }
  }

  return blocks;
}

export interface CapacitySummary {
  weekdayHours: number;
  weekendHours: number;
  totalWeeklyHours: number;
  /** Weeks until the first-pass target, and the hours that implies. */
  projectedHoursTo(targetIso: string, fromIso?: string): number;
}

export function summariseCapacity(blocks: DerivedBlock[], workDays: number[]): CapacitySummary {
  const work = new Set(workDays);
  let weekdayHours = 0;
  let weekendHours = 0;

  for (const b of blocks) {
    // Commute drills are real study time but not focused hours; count at half.
    const weight = b.kind === 'micro' ? 0.5 : 1;
    const hours = durationHours(b.startMinutes, b.endMinutes) * weight;
    if (work.has(b.dayOfWeek)) weekdayHours += hours;
    else weekendHours += hours;
  }

  const totalWeeklyHours = weekdayHours + weekendHours;

  return {
    weekdayHours: Number(weekdayHours.toFixed(2)),
    weekendHours: Number(weekendHours.toFixed(2)),
    totalWeeklyHours: Number(totalWeeklyHours.toFixed(2)),
    projectedHoursTo(targetIso: string, fromIso?: string) {
      const from = fromIso ? new Date(fromIso) : new Date();
      const to = new Date(targetIso);
      const weeks = Math.max(0, (to.getTime() - from.getTime()) / (7 * 24 * 60 * 60 * 1000));
      return Math.round(weeks * totalWeeklyHours);
    },
  };
}

/* ------------------------------------------------------------ notifications */

export interface DerivedNotification {
  id: string;
  label: string;
  /** 0–6, or null for "every study day". */
  dayOfWeek: number | null;
  minutes: number;
  body: string;
}

export function deriveNotifications(profile: ScheduleProfile): DerivedNotification[] {
  const studyStart = profile.wakeMinutes + READY_BUFFER;
  const preShift = profile.jobStartMinutes - profile.commuteMinutesEachWay - PRE_SHIFT_BUFFER;
  const firstOffDay = [0, 1, 2, 3, 4, 5, 6].find((d) => !profile.workDays.includes(d)) ?? 0;

  return [
    {
      id: 'morning-briefing',
      label: 'Morning briefing',
      dayOfWeek: null,
      minutes: Math.max(0, studyStart - 15),
      body: "Today's targets, revision due, and one question to attempt.",
    },
    {
      id: 'pre-shift-checkpoint',
      label: 'Pre-shift checkpoint',
      dayOfWeek: null,
      minutes: preShift,
      body: 'Two minutes: log what you actually finished this morning.',
    },
    {
      id: 'weekly-audit',
      label: 'Weekly audit',
      dayOfWeek: firstOffDay,
      minutes: 19 * 60,
      body: 'Coverage, score trend, lecture backlog, and next week.',
    },
  ];
}

/**
 * Guard: no notification may fire during work hours. This is asserted rather
 * than assumed, because a schedule bug here is silent and infuriating —
 * you would just start ignoring the app.
 */
export function notificationsRespectWorkHours(
  profile: ScheduleProfile,
  notifications: DerivedNotification[],
): { ok: boolean; violations: DerivedNotification[] } {
  const violations = notifications.filter((n) => {
    const appliesToWorkDay = n.dayOfWeek === null || profile.workDays.includes(n.dayOfWeek);
    if (!appliesToWorkDay) return false;
    return n.minutes >= profile.jobStartMinutes && n.minutes <= profile.jobEndMinutes;
  });
  return { ok: violations.length === 0, violations };
}
