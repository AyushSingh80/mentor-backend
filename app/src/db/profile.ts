/**
 * Profile repository.
 *
 * The profile is a single row. Saving it always regenerates the study blocks,
 * so the plan can never drift out of sync with the schedule it was derived
 * from — the failure mode where an app shows a stale plan built on last
 * month's job timings.
 */

import { eq } from 'drizzle-orm';
import { db } from './index';
import { profile, studyBlocks } from './schema';
import {
  deriveNotifications,
  deriveStudyBlocks,
  notificationsRespectWorkHours,
  summariseCapacity,
  type ScheduleProfile,
} from '@/lib/schedule';

export type ProfileRow = typeof profile.$inferSelect;

export interface ProfileInput {
  jobStartMinutes: number;
  jobEndMinutes: number;
  workDays: number[];
  commuteMinutesEachWay: number;
  wakeMinutes: number;
  sleepMinutes: number;
  defaultPlaybackSpeed: number;
  gsCourseTotalLectures?: number | null;
  gsCourseTotalRuntimeMin?: number | null;
  anthroClassDays: number[];
  targetFirstPassDate?: string;
  examYear?: number;
  timezone?: string;
}

export async function getProfile(): Promise<ProfileRow | null> {
  const rows = await db.select().from(profile).where(eq(profile.id, 1)).limit(1);
  return rows[0] ?? null;
}

/** Parsed view of the stored row, for pre-populating the edit form. */
export async function getProfileForm(): Promise<
  (ProfileInput & { exists: true }) | { exists: false }
> {
  const row = await getProfile();
  if (!row) return { exists: false };
  return {
    exists: true,
    jobStartMinutes: row.jobStartMinutes,
    jobEndMinutes: row.jobEndMinutes,
    workDays: JSON.parse(row.workDays) as number[],
    commuteMinutesEachWay: row.commuteMinutesEachWay,
    wakeMinutes: row.wakeMinutes,
    sleepMinutes: row.sleepMinutes,
    defaultPlaybackSpeed: row.defaultPlaybackSpeed,
    gsCourseTotalLectures: row.gsCourseTotalLectures,
    gsCourseTotalRuntimeMin: row.gsCourseTotalRuntimeMin,
    anthroClassDays: JSON.parse(row.anthroClassDays) as number[],
    targetFirstPassDate: row.targetFirstPassDate,
    examYear: row.examYear,
    timezone: row.timezone,
  };
}

export function toScheduleProfile(row: ProfileRow): ScheduleProfile {
  return {
    jobStartMinutes: row.jobStartMinutes,
    jobEndMinutes: row.jobEndMinutes,
    workDays: JSON.parse(row.workDays) as number[],
    commuteMinutesEachWay: row.commuteMinutesEachWay,
    wakeMinutes: row.wakeMinutes,
    sleepMinutes: row.sleepMinutes,
  };
}

export async function saveProfile(input: ProfileInput): Promise<ProfileRow> {
  const now = new Date().toISOString();

  const values = {
    id: 1,
    jobStartMinutes: input.jobStartMinutes,
    jobEndMinutes: input.jobEndMinutes,
    workDays: JSON.stringify(input.workDays),
    commuteMinutesEachWay: input.commuteMinutesEachWay,
    wakeMinutes: input.wakeMinutes,
    sleepMinutes: input.sleepMinutes,
    defaultPlaybackSpeed: input.defaultPlaybackSpeed,
    gsCourseTotalLectures: input.gsCourseTotalLectures ?? null,
    gsCourseTotalRuntimeMin: input.gsCourseTotalRuntimeMin ?? null,
    anthroClassDays: JSON.stringify(input.anthroClassDays),
    targetFirstPassDate: input.targetFirstPassDate ?? '2027-03-31',
    examYear: input.examYear ?? 2028,
    timezone: input.timezone ?? 'Asia/Kolkata',
    updatedAt: now,
  };

  await db
    .insert(profile)
    .values({ ...values, onboardedAt: now })
    .onConflictDoUpdate({ target: profile.id, set: values });

  await regenerateStudyBlocks();

  const saved = await getProfile();
  if (!saved) throw new Error('Profile save failed');
  return saved;
}

export async function regenerateStudyBlocks(): Promise<void> {
  const row = await getProfile();
  if (!row) return;

  const sched = toScheduleProfile(row);
  const blocks = deriveStudyBlocks(sched);

  // Transactional: a kill between the delete and the insert — plausible on
  // mobile, and this runs on every save — would otherwise leave the schedule
  // permanently empty until the user saved again. Also stops a double-tap on
  // Save from interleaving into duplicated rows.
  // SYNCHRONOUS callback, and every statement forced with `.run()`.
  //
  // `drizzle-orm/expo-sqlite` registers a "sync" driver, and its
  // `session.transaction` does `const result = transaction(tx)` WITHOUT
  // awaiting, then runs COMMIT on the very next line. Passing an `async`
  // callback therefore returns a pending promise immediately, COMMIT fires
  // before a single statement has executed, and every statement inside runs
  // afterwards as its own autocommit. There is no atomicity and no rollback:
  // an async function cannot throw synchronously, so the driver's `catch`
  // never sees it either.
  //
  // Here that meant the delete could commit and the insert then fail, leaving
  // the schedule permanently empty — exactly the failure the transaction was
  // added to prevent.
  db.transaction((tx) => {
    tx.delete(studyBlocks).run();
    if (blocks.length > 0) {
      tx.insert(studyBlocks)
        .values(
          blocks.map((b) => ({
            dayOfWeek: b.dayOfWeek,
            startMinutes: b.startMinutes,
            endMinutes: b.endMinutes,
            kind: b.kind,
            label: b.label,
          })),
        )
        .run();
    }
  });
}

/** Everything a screen needs to show the derived plan, computed in one place. */
export function derivePlan(row: ProfileRow) {
  const sched = toScheduleProfile(row);
  const blocks = deriveStudyBlocks(sched);
  const capacity = summariseCapacity(blocks, sched.workDays);
  const notifications = deriveNotifications(sched);
  const guard = notificationsRespectWorkHours(sched, notifications);

  return {
    schedule: sched,
    blocks,
    capacity,
    notifications,
    notificationGuard: guard,
    projectedHours: capacity.projectedHoursTo(row.targetFirstPassDate),
  };
}
