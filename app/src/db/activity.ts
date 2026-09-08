/**
 * Gathering the timestamped work she has already done.
 *
 * Six reads, one per kind, unioned into `ActivityEvent`s and handed to
 * `lib/activity.ts` to bucket. No transaction: every read is independent and a
 * decorative transaction would be worse than none.
 *
 * ## Local days, from UTC instants
 *
 * Most of these columns are ISO instants (`attempted_at`, `reviewed_at`) and
 * some are already local calendar days (`watched_on`, `ca_items.date`). The two
 * are converted differently and conflating them is how a 22:15 commute drill
 * lands on tomorrow: an instant must go through `localDate` in HER timezone,
 * where a day label is already local and must not be re-parsed at all.
 */

import { and, gte, isNotNull, sql } from 'drizzle-orm';

import { db } from './index';
import {
  answers,
  caItems,
  drills,
  lectures,
  mcqAttempts,
  revisionReviews,
  studySessions,
} from './schema';
import type { ActivityEvent, SelfReport } from '@/lib/activity';
import { localDate } from '@/lib/time';

/** An ISO instant to `{ day, minuteOfDay }` in her zone, or null if unparseable. */
function localise(iso: string | null, timezone: string): { day: string; minute: number } | null {
  if (iso === null || iso === '') return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;

  const day = localDate(timezone, at);
  // The minute-of-day is derived from the same formatted local time the day
  // came from, never from `getHours()` — that reads the DEVICE's zone, which
  // is hers today and is not guaranteed to be tomorrow.
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;

  // `en-GB` renders midnight as "24" in some ICU builds. Folding it to 0 keeps
  // the small-hours burnout check — which tests `firstMinute < 240` — from
  // reading a midnight session as a 24:00 one it can never match.
  return { day, minute: (hour % 24) * 60 + minute };
}

export interface ActivityWindow {
  /** Oldest local day to include, `YYYY-MM-DD`. Byte-compared. */
  since: string;
  timezone: string;
}

/**
 * Every study event in the window.
 *
 * Weights are per-kind and deliberately not normalised into one "effort" score:
 * those are unfalsifiable, and the useful questions — "has she stopped writing
 * answers" — are per-kind ones. A lecture carries its runtime because an
 * eighty-minute lecture and a five-minute one are not the same day's work; the
 * rest carry 1 because the count is the meaningful unit.
 */
export async function readActivityEvents(window: ActivityWindow): Promise<ActivityEvent[]> {
  const { since, timezone } = window;
  // Instants are compared against the START of the window day in her zone. A
  // byte comparison against a bare date would drop the whole first day.
  const sinceInstant = `${since}T00:00:00.000Z`;

  const [answerRows, mcqRows, revisionRows, drillRows, lectureRows, readingRows] =
    await Promise.all([
      db
        .select({ at: answers.createdAt })
        .from(answers)
        .where(gte(answers.createdAt, sinceInstant)),

      db
        .select({ at: mcqAttempts.attemptedAt })
        .from(mcqAttempts)
        .where(gte(mcqAttempts.attemptedAt, sinceInstant)),

      db
        .select({ at: revisionReviews.reviewedAt })
        .from(revisionReviews)
        .where(gte(revisionReviews.reviewedAt, sinceInstant)),

      db
        .select({ at: drills.submittedAt })
        .from(drills)
        .where(and(isNotNull(drills.submittedAt), gte(drills.submittedAt, sinceInstant))),

      // Already a LOCAL day label. Not re-parsed — see the header.
      db
        .select({ day: lectures.watchedOn, runtimeMin: lectures.runtimeMin })
        .from(lectures)
        .where(and(isNotNull(lectures.watchedOn), gte(lectures.watchedOn, since))),

      db
        .select({ at: caItems.readAt })
        .from(caItems)
        .where(and(isNotNull(caItems.readAt), gte(caItems.readAt, sinceInstant))),
    ]);

  const events: ActivityEvent[] = [];

  const pushInstant = (rows: { at: string | null }[], kind: ActivityEvent['kind']) => {
    for (const row of rows) {
      const local = localise(row.at, timezone);
      if (local === null || local.day < since) continue;
      events.push({ kind, day: local.day, minuteOfDay: local.minute, weight: 1 });
    }
  };

  pushInstant(answerRows, 'answer');
  pushInstant(mcqRows, 'mcq');
  pushInstant(revisionRows, 'revision');
  pushInstant(drillRows, 'drill');
  pushInstant(readingRows, 'reading');

  for (const row of lectureRows) {
    if (row.day === null) continue;
    events.push({
      kind: 'lecture',
      day: row.day,
      // A lecture row records the DAY it was watched and not the time, so it
      // carries no minute. Inventing one would put a fabricated point into the
      // small-hours check, which is the one signal that must not be guessed at.
      minuteOfDay: null,
      weight: Math.max(1, row.runtimeMin),
    });
  }

  return events;
}

/** Mood and energy she chose to record. Enrichment only — never required. */
export async function readSelfReports(window: ActivityWindow): Promise<SelfReport[]> {
  const rows = await db
    .select({
      date: studySessions.date,
      mood: studySessions.mood,
      energy: studySessions.energy,
    })
    .from(studySessions)
    .where(gte(studySessions.date, window.since));

  // One row per day: the latest wins, because a second check-in on a day is a
  // correction rather than a second data point.
  const byDay = new Map<string, SelfReport>();
  for (const row of rows) {
    byDay.set(row.date, { day: row.date, mood: row.mood, energy: row.energy });
  }
  return [...byDay.values()];
}

export interface CheckInInput {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string;
  mood: number | null;
  energy: number | null;
  actualHours?: number;
  notes?: string | null;
}

/**
 * Records a check-in.
 *
 * Replaces the day's row rather than appending, so a correction is a
 * correction. Nothing else in the app depends on this existing — see the header
 * of `lib/activity.ts` for why the burnout signals are passive.
 */
export async function saveCheckIn(input: CheckInInput): Promise<void> {
  const existing = await db
    .select({ id: studySessions.id })
    .from(studySessions)
    .where(sql`${studySessions.date} = ${input.date}`)
    .limit(1);

  const values = {
    date: input.date,
    mood: input.mood,
    energy: input.energy,
    actualHours: input.actualHours ?? 0,
    notes: input.notes ?? null,
  };

  if (existing[0] === undefined) {
    await db.insert(studySessions).values(values);
    return;
  }
  await db
    .update(studySessions)
    .set(values)
    .where(sql`${studySessions.id} = ${existing[0].id}`);
}

/** Whether anything at all has been recorded for a day. Drives the checkpoint. */
export async function hasCheckedIn(date: string): Promise<boolean> {
  const rows = await db
    .select({ id: studySessions.id })
    .from(studySessions)
    .where(sql`${studySessions.date} = ${date}`)
    .limit(1);
  return rows.length > 0;
}
