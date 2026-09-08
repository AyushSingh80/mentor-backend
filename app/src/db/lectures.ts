/**
 * Lecture repository.
 *
 * SKELETON: signatures are FROZEN. Bodies are owned by the backlog agent.
 *
 * Deliberately thin. Everything interesting lives in `lib/backlog.ts`, which is
 * pure and therefore unit-testable; this module only maps rows to `LectureFact`
 * and writes. Anything that imports `db/index` transitively imports
 * `expo-sqlite` and cannot run under Node, so logic placed here is logic that
 * can never be tested.
 */

import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { db } from './index';
import { lectures } from './schema';
import type { CourseId, LectureFact } from '@/lib/backlog';

export type LectureRow = typeof lectures.$inferSelect;

/** Subjects offered per course. Populates the log screen's picker. */
export const SUBJECTS: readonly { course: CourseId; value: string; label: string }[] = [
  { course: 'gs', value: 'polity', label: 'Polity' },
  { course: 'gs', value: 'economy', label: 'Economy' },
  { course: 'gs', value: 'modern_history', label: 'Modern History' },
  { course: 'gs', value: 'ancient_medieval', label: 'Ancient & Medieval' },
  { course: 'gs', value: 'art_culture', label: 'Art & Culture' },
  { course: 'gs', value: 'geography', label: 'Geography' },
  { course: 'gs', value: 'environment', label: 'Environment' },
  { course: 'gs', value: 'science_tech', label: 'Science & Tech' },
  { course: 'gs', value: 'ir', label: 'International Relations' },
  { course: 'gs', value: 'society', label: 'Society' },
  { course: 'gs', value: 'ethics', label: 'Ethics' },
  { course: 'gs', value: 'current_affairs', label: 'Current Affairs' },

  { course: 'anthro', value: 'physical', label: 'Physical Anthropology' },
  { course: 'anthro', value: 'socio_cultural', label: 'Socio-Cultural' },
  { course: 'anthro', value: 'theory', label: 'Theory & Thinkers' },
  { course: 'anthro', value: 'archaeology', label: 'Archaeology' },
  { course: 'anthro', value: 'indian_anthro', label: 'Indian Anthropology' },
  { course: 'anthro', value: 'tribal', label: 'Tribal India' },
  { course: 'anthro', value: 'applied', label: 'Applied Anthropology' },
];

export interface NewLecture {
  course: CourseId;
  subject: string;
  title: string;
  /** CONTENT minutes at 1x, as the platform reports it. */
  runtimeMin: number;
  releasedOn: string;
  syllabusTopicId?: number | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Every date this table stores is a plain calendar day, and every comparison
 * downstream is byte-wise on the string. One `2026-3-4` or one ISO timestamp
 * with a `T` in it sorts wrongly against its neighbours forever after, so bad
 * input is rejected at the door rather than repaired later.
 */
function assertIsoDate(value: string, field: string): string {
  if (!ISO_DATE.test(value)) {
    throw new Error(`${field} must be a YYYY-MM-DD date, got “${value}”`);
  }
  return value;
}

/**
 * Playback speed only ever divides. A zero, a negative or a NaN would turn the
 * wall-clock figure into Infinity or NaN and poison the one number this whole
 * feature exists to produce, so anything unusable is stored as "unknown".
 */
function cleanSpeed(speed: number | null | undefined): number | null {
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed <= 0) return null;
  return speed;
}

/** The only seam the dashboard reads. Retired/skipped handling lives downstream. */
export async function lectureFacts(): Promise<LectureFact[]> {
  const rows = await db
    .select({
      id: lectures.id,
      course: lectures.course,
      runtimeMin: lectures.runtimeMin,
      releasedOn: lectures.releasedOn,
      watchedOn: lectures.watchedOn,
      skippedOn: lectures.skippedOn,
      playbackSpeed: lectures.playbackSpeed,
    })
    .from(lectures);

  return rows.map((row) => ({
    ...row,
    // A row whose course is no longer in COURSES is kept rather than dropped.
    // The combined backlog is the headline this feature exists to produce, and
    // silently shrinking it is a worse failure than a per-course filter that
    // never matches such a row. `createLecture` is the only writer and its
    // input is typed, so this is a cast for a case that should not arise.
    course: row.course as CourseId,
  }));
}

export async function listLectures(opts?: {
  course?: CourseId;
  unwatchedOnly?: boolean;
}): Promise<LectureRow[]> {
  const filters = [];
  if (opts?.course !== undefined) filters.push(eq(lectures.course, opts.course));
  // Unwatched means neither watched nor skipped: a skipped lecture has been
  // dealt with and must not reappear in the queue asking to be dealt with again.
  if (opts?.unwatchedOnly) filters.push(isNull(lectures.watchedOn), isNull(lectures.skippedOn));

  return db
    .select()
    .from(lectures)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(
      // Outstanding lectures come oldest-first: the top of that list is what
      // has been rotting longest and is the next thing worth watching. Every
      // other listing is a log, and a log reads newest-first.
      ...(opts?.unwatchedOnly
        ? [asc(lectures.releasedOn), asc(lectures.id)]
        : [desc(lectures.releasedOn), desc(lectures.id)]),
    );
}

export async function createLecture(input: NewLecture): Promise<number> {
  const runtimeMin = Math.round(input.runtimeMin);
  if (!Number.isFinite(runtimeMin) || runtimeMin <= 0) {
    throw new Error(`runtimeMin must be a positive number of content minutes, got “${input.runtimeMin}”`);
  }

  const [row] = await db
    .insert(lectures)
    .values({
      course: input.course,
      subject: input.subject.trim(),
      title: input.title.trim(),
      // CONTENT minutes at 1x, exactly as the platform reports them. Never the
      // wall-clock time a faster playback would take.
      runtimeMin,
      releasedOn: assertIsoDate(input.releasedOn, 'releasedOn'),
      syllabusTopicId: input.syllabusTopicId ?? null,
    })
    .returning({ id: lectures.id });

  if (!row) throw new Error('Failed to create lecture');
  return row.id;
}

export async function markWatched(
  id: number,
  opts: { watchedOn: string; playbackSpeed?: number | null; notesMade?: boolean },
): Promise<void> {
  await db
    .update(lectures)
    .set({
      watchedOn: assertIsoDate(opts.watchedOn, 'watchedOn'),
      playbackSpeed: cleanSpeed(opts.playbackSpeed),
      notesMade: opts.notesMade ?? false,
      // Watching something previously written off clears the skip, so the two
      // columns stay mutually exclusive and the row has one honest reading.
      skippedOn: null,
    })
    .where(eq(lectures.id, id));
}

/**
 * Skipped, not watched — see the note on `lectures.skippedOn`. This must not
 * write `watchedOn`, or the watch rate silently inflates.
 */
export async function markSkipped(id: number, skippedOn: string): Promise<void> {
  await db
    .update(lectures)
    .set({ skippedOn: assertIsoDate(skippedOn, 'skippedOn') })
    .where(eq(lectures.id, id));
}
