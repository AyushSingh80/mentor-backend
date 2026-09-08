/**
 * Revision repository — the SM-2 queue over syllabus topics.
 *
 * Thin on purpose, like every repository here. All of the algorithm and all of
 * the date handling live in `lib/sm2.ts`, which is pure and therefore actually
 * unit-testable; anything that imports `db/index` transitively imports
 * `expo-sqlite` and cannot run under Node, so logic placed in this file is
 * logic that can never be tested. What is left here is enrolment, two queries
 * and one transaction.
 *
 * ## Lazy enrolment
 *
 * There is no "add to revision" action anywhere in the app. A topic joins the
 * queue the first time a due list is built after it reaches `first_pass` or
 * `revised`, which means the queue can never drift out of sync with coverage
 * and there is no migration to write when the syllabus is re-seeded.
 *
 * The cost is that enrolment runs on EVERY due-list build, so it must be
 * idempotent under concurrency. `revision_queue` has a UNIQUE index on
 * `syllabus_topic_id`; a plain insert throws the second time. Hence
 * `onConflictDoNothing` — not because a conflict is expected in the happy
 * path (the LEFT JOIN below already excludes enrolled topics) but because two
 * builds racing on app open would otherwise take the screen down with a
 * constraint error.
 *
 * ## Two clocks, deliberately
 *
 * Scheduling uses the LOCAL CALENDAR DAY — `localDate(profile.timezone)`, a
 * bare `YYYY-MM-DD`. The audit log uses the real INSTANT. They are separate
 * parameters throughout and must not be collapsed into one: at 02:00 in
 * Asia/Kolkata `new Date().toISOString()` still carries yesterday's UTC date,
 * so scheduling from it would make a just-reviewed topic fall due again the
 * same local day. See the date-boundary note in `lib/sm2.ts`.
 *
 * ## What this module does NOT write
 *
 * `syllabusTopics.status`, `revisedAt` and `confidence` belong to
 * `db/syllabus.ts`. `confidence` in particular is a standing self-report on a
 * 1–5 scale and is NOT the SM-2 recall grade — deriving one from the other is
 * the single worst thing this module could do, so it touches neither.
 *
 * Readers over `revision_reviews` ("which topics do I keep forgetting") are
 * deliberately not built yet; the table is written now so that screen is a
 * query rather than a backfill.
 */

import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

import { db } from './index';
import { revisionQueue, revisionReviews, syllabusTopics } from './schema';
import { paperLabel } from '@/lib/papers';
import {
  applyReview,
  isDue,
  isLeech,
  selectDueList,
  startOfDayIso,
  type ReviewGrade,
  type Sm2Result,
  type Sm2State,
} from '@/lib/sm2';

export type RevisionQueueRow = typeof revisionQueue.$inferSelect;

/**
 * How many topics a single day's list may contain.
 *
 * The pile-up defence. Reaching `first_pass` on eighty topics in one week puts
 * eighty items on one due date and, without a cap, on the same date forever
 * after. Fuzzing the intervals would spread them out and corrupt every
 * subsequent interval, so the list is capped instead and the overflow simply
 * waits — it stays overdue and sorts to the front tomorrow.
 *
 * Twenty topics is roughly a 25-minute block, which is what actually exists
 * before a 2:30pm shift.
 */
export const DAILY_REVIEW_CAP = 20;

/** Topic statuses that belong in the revision queue. */
const REVISABLE_STATUSES = ['first_pass', 'revised'] as const;

/**
 * The state an unseen topic is in. Matches the `revision_queue` column
 * defaults, and exists here so `enrolmentDueAt` can ask `applyReview` for a
 * date without inventing a second notion of "new".
 */
/**
 * `intervalDays: 0` deliberately differs from the column default of 1: this
 * value is never written, only handed to `applyReview`, which at
 * `repetitions === 0` takes the constant branch and never reads it. Zero says
 * "no interval yet" rather than implying a one-day schedule that does not exist.
 */
const UNSEEN: Sm2State = { repetitions: 0, intervalDays: 0, easeFactor: 2.5, lapses: 0 };

export interface DueTopic {
  topicId: number;
  slug: string;
  paper: string;
  paperLabel: string;
  topic: string;
  subtopic: string | null;
  dueAt: string;
  lastReviewedAt: string | null;
  /** 0 means due today. Positive means it was missed on that many earlier days. */
  daysOverdue: number;
  /** Ground down to the ease floor and failed repeatedly. Needs re-reading, not re-testing. */
  isLeech: boolean;
  state: Sm2State;
}

export interface RevisionDeck {
  /** Capped, most-overdue-first. The list the screen actually walks through. */
  due: DueTopic[];
  /** Due today but past the cap. They stay overdue and lead tomorrow's list. */
  heldBack: number;
  /** Leeches due today but past the cap. See the note where this is computed. */
  leechesHeldBack: number;
  /** Due today and flagged as leeches. Surfaced apart from `due` — see below. */
  leeches: DueTopic[];
  /** Everything due today, leeches included, before the cap. */
  totalDue: number;
  /**
   * Every non-retired topic in the queue, due or not. Distinguishes the two
   * empty states that look identical on screen and are not: "nothing is due,
   * come back tomorrow" and "no topic has reached first pass yet".
   */
  queued: number;
  /** Topics this build enrolled. Zero on every steady-state open. */
  enrolled: number;
}

/* ------------------------------------------------------------------ dates */

const MS_PER_DAY = 86_400_000;

/**
 * `max(firstPassAt + 1 day, today)` — the frozen enrolment rule.
 *
 * The "+ 1 day" is computed by `applyReview` rather than by local date
 * arithmetic on purpose. `lib/sm2.ts` owns the date boundary — collapse the
 * instant to its calendar day, then add whole days — and its header is
 * explicit that both halves live there so no caller can get it wrong.
 * Re-deriving it here would be a second implementation of the exact rule that
 * module exists to centralise.
 *
 * It is also not a trick to reach a date helper: a topic that has had its
 * first pass IS an unseen item that has just been studied once, so the seed
 * state and the passing grade are the literal truth. Only `dueAt` is taken
 * from the result — the queue row keeps the column defaults, because studying
 * a topic is not a graded recall and must not consume an SM-2 repetition.
 *
 * The `max` matters for a topic first passed months ago: without it the row
 * arrives with a due date deep in the past and sorts to the head of the list
 * ahead of things genuinely missed yesterday.
 */
function enrolmentDueAt(firstPassAt: string | null, todayIso: string): string {
  const today = startOfDayIso(todayIso);
  // A topic can reach `first_pass` with no timestamp — status edited by hand,
  // or seeded. Starting today is the only honest answer.
  if (!firstPassAt) return today;

  let scheduled: string;
  try {
    scheduled = applyReview(UNSEEN, 4, firstPassAt).dueAt;
  } catch {
    // Unparseable `first_pass_at`. Enrol anyway rather than leaving the topic
    // permanently outside the queue, which is the silent failure here.
    return today;
  }

  // `isDue(scheduled, today)` is true exactly when `scheduled <= today`.
  return isDue(scheduled, today) ? today : scheduled;
}

/**
 * Whole days between two calendar days. Never throws: this is on the read path
 * behind the daily list, and one hand-edited row must not blank the screen.
 */
function daysBetween(fromIso: string, toIso: string): number {
  try {
    return Math.round(
      (Date.parse(startOfDayIso(toIso)) - Date.parse(startOfDayIso(fromIso))) / MS_PER_DAY,
    );
  } catch {
    return 0;
  }
}

/* --------------------------------------------------------------- enrolment */

/**
 * Enrols every revisable topic that has no queue row yet. Idempotent.
 *
 * Returns the number of rows actually inserted, which is zero on every launch
 * after the first — worth having, because a non-zero count on a steady-state
 * open means something upstream is churning topic statuses.
 */
export async function enrolPendingTopics(todayIso: string): Promise<number> {
  // Retired topics are excluded for the same reason coverage excludes them:
  // they are tombstones, and a topic removed from a corrected syllabus should
  // not start consuming review time.
  const pending = await db
    .select({ id: syllabusTopics.id, firstPassAt: syllabusTopics.firstPassAt })
    .from(syllabusTopics)
    .leftJoin(revisionQueue, eq(revisionQueue.syllabusTopicId, syllabusTopics.id))
    .where(
      and(
        isNull(syllabusTopics.retiredAt),
        inArray(syllabusTopics.status, [...REVISABLE_STATUSES]),
        isNull(revisionQueue.id),
      ),
    );

  if (pending.length === 0) return 0;

  const inserted = await db
    .insert(revisionQueue)
    .values(
      pending.map((topic) => ({
        syllabusTopicId: topic.id,
        dueAt: enrolmentDueAt(topic.firstPassAt, todayIso),
      })),
    )
    // UNIQUE on `syllabus_topic_id`, and this runs on every due-list build.
    .onConflictDoNothing({ target: revisionQueue.syllabusTopicId })
    .returning({ id: revisionQueue.id });

  return inserted.length;
}

/* ------------------------------------------------------------------ reads */

/**
 * Today's revision, enrolling anything new on the way past.
 *
 * Leeches are split out of `due` rather than filtered or left in. Left in,
 * a handful of topics she reliably fails would consume the daily cap every
 * single day and crowd out material that is actually moving. Filtered out,
 * they would vanish silently, which is worse — the whole point of counting
 * lapses is to make them visible. So they get their own, smaller list and
 * their own treatment: re-read the notes, do not grind the recall.
 */
export async function buildDeck(
  todayIso: string,
  cap: number = DAILY_REVIEW_CAP,
): Promise<RevisionDeck> {
  const enrolled = await enrolPendingTopics(todayIso);

  const rows = await db
    .select({
      topicId: syllabusTopics.id,
      slug: syllabusTopics.slug,
      paper: syllabusTopics.paper,
      topic: syllabusTopics.topic,
      subtopic: syllabusTopics.subtopic,
      dueAt: revisionQueue.dueAt,
      lastReviewedAt: revisionQueue.lastReviewedAt,
      intervalDays: revisionQueue.intervalDays,
      easeFactor: revisionQueue.easeFactor,
      repetitions: revisionQueue.repetitions,
      lapses: revisionQueue.lapses,
    })
    .from(revisionQueue)
    .innerJoin(syllabusTopics, eq(syllabusTopics.id, revisionQueue.syllabusTopicId))
    .where(isNull(syllabusTopics.retiredAt))
    // Syllabus order. `selectDueList` sorts by due date with a stable sort, so
    // this is what breaks ties — and it is why the list is the same list on
    // every rebuild rather than reshuffling under her as she works through it.
    .orderBy(asc(syllabusTopics.paper), asc(syllabusTopics.position), asc(syllabusTopics.id));

  const all = rows.map<DueTopic>((row) => {
    const state: Sm2State = {
      repetitions: row.repetitions,
      intervalDays: row.intervalDays,
      easeFactor: row.easeFactor,
      lapses: row.lapses,
    };
    return {
      topicId: row.topicId,
      slug: row.slug,
      paper: row.paper,
      paperLabel: paperLabel(row.paper),
      topic: row.topic,
      subtopic: row.subtopic,
      dueAt: row.dueAt,
      lastReviewedAt: row.lastReviewedAt,
      daysOverdue: Math.max(0, daysBetween(row.dueAt, todayIso)),
      isLeech: isLeech(state),
      state,
    };
  });

  const dueNow = all.filter((item) => isDue(item.dueAt, todayIso));
  const ordinary = dueNow.filter((item) => !item.isLeech);

  const leeches = dueNow.filter((item) => item.isLeech);

  return {
    due: selectDueList(ordinary, todayIso, cap),
    heldBack: Math.max(0, ordinary.length - cap),
    leeches: selectDueList(leeches, todayIso, cap),
    // Reported for the same reason as `heldBack`: the leech list is capped
    // too, and without a counter the deck would simply show fewer leeches
    // than exist with nothing saying so. Leeches are the items already eating
    // review time every day — silently hiding some of them is the wrong
    // direction to be wrong in.
    leechesHeldBack: Math.max(0, leeches.length - cap),
    totalDue: dueNow.length,
    queued: all.length,
    enrolled,
  };
}

/* ----------------------------------------------------------------- writes */

export interface GradeInput {
  topicId: number;
  grade: ReviewGrade;
  /**
   * The LOCAL calendar day, from `localDate(profile.timezone)`. This drives the
   * schedule, and it is not interchangeable with the instant below — see the
   * "two clocks" note at the top of this file.
   */
  todayIso: string;
  /** The real instant, for the audit log and `lastReviewedAt`. Defaults to now. */
  reviewedAtIso?: string;
}

export interface GradedReview {
  topicId: number;
  previous: Sm2State;
  result: Sm2Result;
}

/**
 * Records one graded review.
 *
 * The queue update and the audit row are one transaction. A partial write is
 * the worst outcome available here: the queue row alone leaves an interval
 * that jumped for no recorded reason and cannot be explained months later,
 * and the audit row alone claims a review that never affected the schedule.
 * The audit table is the only way to debug a schedule that looks wrong, so it
 * has to be exactly as trustworthy as the schedule itself.
 */
export async function gradeTopic(input: GradeInput): Promise<GradedReview> {
  const reviewedAt = input.reviewedAtIso ?? new Date().toISOString();

  const [row] = await db
    .select()
    .from(revisionQueue)
    .where(eq(revisionQueue.syllabusTopicId, input.topicId))
    .limit(1);

  if (!row) throw new Error(`Topic ${input.topicId} is not in the revision queue`);

  const previous: Sm2State = {
    repetitions: row.repetitions,
    intervalDays: row.intervalDays,
    easeFactor: row.easeFactor,
    lapses: row.lapses,
  };

  // Scheduled from the local DAY, logged at the real INSTANT.
  const result = applyReview(previous, input.grade, input.todayIso);

  // SYNCHRONOUS callback with `.run()` on every statement.
  //
  // `drizzle-orm/expo-sqlite` is a "sync" driver: its `session.transaction`
  // calls `transaction(tx)` WITHOUT awaiting and runs COMMIT on the next line.
  // An `async` callback returns a pending promise immediately, so COMMIT fired
  // before either statement below had executed and both ran as independent
  // autocommits — no atomicity, and no rollback either, since an async function
  // cannot throw synchronously for the driver's `catch` to see.
  //
  // This path runs on every graded review — thousands of times over the
  // preparation — and a partial write here means a schedule advanced with no
  // audit row, or an audit row for a review that never moved the schedule.
  db.transaction((tx) => {
    tx.update(revisionQueue)
      .set({
        dueAt: result.dueAt,
        intervalDays: result.intervalDays,
        easeFactor: result.easeFactor,
        repetitions: result.repetitions,
        lapses: result.lapses,
        lastReviewedAt: reviewedAt,
      })
      .where(eq(revisionQueue.id, row.id))
      .run();

    tx.insert(revisionReviews)
      .values({
        syllabusTopicId: input.topicId,
        flashcardId: null,
        grade: input.grade,
        prevIntervalDays: previous.intervalDays,
        newIntervalDays: result.intervalDays,
        prevEase: previous.easeFactor,
        newEase: result.easeFactor,
        reviewedAt,
      })
      .run();
  });

  return { topicId: input.topicId, previous, result };
}
