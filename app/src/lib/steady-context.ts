/**
 * Gathering the counts a notification body needs.
 *
 * ## Every count is isolated
 *
 * Each one is wrapped so a failure degrades THAT number to zero rather than
 * emptying the whole context. The failure mode this avoids is specific: one
 * broken read would otherwise make `morningBriefing` see nothing outstanding,
 * return null, and schedule silence — an app that stops reminding her because a
 * query threw, reporting no error anywhere, on the morning she most needed it.
 *
 * Zero is the right degraded value because every builder treats it as "nothing
 * to say about this" and simply omits the clause.
 */

import { and, gte, isNull, lte, sql } from 'drizzle-orm';

import { db } from '@/db';
import { caItems, drills, flashcards, lectures, mcqQuestions, revisionQueue } from '@/db/schema';
import { activityByDay, dayRange } from '@/lib/activity';
import { hasCheckedIn, readActivityEvents, readSelfReports } from '@/db/activity';
import type { NotifyContext } from '@/lib/notify-plan';
import type { ScheduleProfile } from '@/lib/schedule';
import { consistency, STREAK_RULES } from '@/lib/streaks';
import { localDate } from '@/lib/time';

async function count(query: Promise<{ n: unknown }[]>): Promise<number> {
  try {
    const rows = await query;
    const n = Number(rows[0]?.n ?? 0);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

/**
 * The stored profile as `deriveNotifications` wants it, or null.
 *
 * `workDays` is JSON in the column and an array in the type; parsing it here
 * rather than at the call site keeps one place where a corrupt value becomes
 * the documented Mon–Fri default instead of a crash on a notification refresh.
 */
export function profileForSchedule(
  row: {
    jobStartMinutes: number;
    jobEndMinutes: number;
    workDays: string;
    commuteMinutesEachWay: number;
    wakeMinutes: number;
    sleepMinutes: number;
    timezone: string;
  } | null,
): { profile: ScheduleProfile; timezone: string } | null {
  if (row === null) return null;

  let workDays: number[] = [1, 2, 3, 4, 5];
  try {
    const parsed: unknown = JSON.parse(row.workDays);
    if (Array.isArray(parsed) && parsed.every((day) => typeof day === 'number')) {
      workDays = parsed as number[];
    }
  } catch {
    // The documented default. A corrupt column must not stop reminders.
  }

  return {
    timezone: row.timezone,
    profile: {
      jobStartMinutes: row.jobStartMinutes,
      jobEndMinutes: row.jobEndMinutes,
      workDays,
      commuteMinutesEachWay: row.commuteMinutesEachWay,
      wakeMinutes: row.wakeMinutes,
      sleepMinutes: row.sleepMinutes,
    },
  };
}

/**
 * Everything a notification body might mention.
 *
 * The counts are STOCK rather than events — "6 due for revision", not "you
 * revised 6" — because a `DAILY` OS trigger fixes the body at scheduling time
 * and stock changes slowly. A day-old stock figure is still true enough to act
 * on; a day-old event count would be a lie.
 */
export async function buildNotifyContext(timezone: string): Promise<NotifyContext> {
  const today = localDate(timezone);
  const nowIso = new Date().toISOString();

  const [
    revisionDue,
    cardsDue,
    lecturesBehind,
    unreadDigest,
    drillsBanked,
    mcqUnseen,
    loggedToday,
  ] = await Promise.all([
    count(
      db
        .select({ n: sql`count(*)` })
        .from(revisionQueue)
        .where(lte(revisionQueue.dueAt, nowIso)),
    ),
    count(
      db
        .select({ n: sql`count(*)` })
        .from(flashcards)
        .where(lte(flashcards.dueAt, nowIso)),
    ),
    count(
      db
        .select({ n: sql`count(*)` })
        .from(lectures)
        .where(and(isNull(lectures.watchedOn), isNull(lectures.skippedOn))),
    ),
    count(
      db
        .select({ n: sql`count(*)` })
        .from(caItems)
        .where(and(isNull(caItems.readAt), gte(caItems.date, dayRange(today, 4)[0]!))),
    ),
    count(
      db
        .select({ n: sql`count(*)` })
        .from(drills)
        .where(sql`${drills.status} = 'banked'`),
    ),
    count(
      db
        .select({ n: sql`count(*)` })
        .from(mcqQuestions)
        .where(isNull(mcqQuestions.disputedAt)),
    ),
    hasCheckedIn(today).catch(() => false),
  ]);

  let state = consistency({ days: [], studyDays: new Set<string>() });
  try {
    const days = dayRange(today, STREAK_RULES.windowDays);
    const [events, reports] = await Promise.all([
      readActivityEvents({ since: days[0]!, timezone }),
      readSelfReports({ since: days[0]!, timezone }),
    ]);
    state = consistency({
      days: activityByDay(events, days, reports),
      studyDays: new Set<string>(),
    });
  } catch {
    // An empty consistency reports `adherence: null`, which every builder reads
    // as "not enough history" — the honest degraded state rather than zero.
  }

  return {
    // Two decks, one number: she does not distinguish "a topic" from "a card"
    // when deciding whether to open the app, and two counts in one line is a
    // notification that has to be parsed rather than read.
    revisionDue: revisionDue + cardsDue,
    lecturesBehind,
    unreadDigest,
    drillsBanked,
    mcqUnseen,
    loggedToday,
    consistency: state,
  };
}
