/**
 * Local SQLite schema. This is the app's source of truth — every screen reads
 * from here, so everything except AI generation works with no network.
 *
 * Conventions:
 *  - Timestamps are ISO-8601 strings. Debuggable with a plain SELECT, and
 *    sortable as text.
 *  - Clock times are minutes from local midnight (14:30 -> 870). Avoids
 *    timezone arithmetic on values that are wall-clock by nature.
 *  - Booleans are integers in SQLite; drizzle's `mode: 'boolean'` handles it.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * One timestamp format, everywhere: ISO-8601 with a 'T' and milliseconds.
 *
 * SQLite's own `current_timestamp` emits `2026-09-07 08:00:00` — space
 * separator, second precision. Text comparison is byte-wise and ' ' (0x20)
 * sorts before 'T' (0x54), so a row defaulted by SQL always compares as
 * *earlier* than a same-day row written from JS, whatever the actual clock
 * says. That silently inverts every "is this due yet today?" check in the
 * spaced-repetition queue. Computing the default in JS keeps the two paths
 * byte-identical.
 */
const nowIso = () => new Date().toISOString();

/* ------------------------------------------------------------------ profile */

/**
 * Single row (id = 1) captured at onboarding. Every study block, notification
 * time and daily target is derived from this — nothing about the schedule is
 * hardcoded, because a 2:30pm–11:30pm shift breaks every default assumption
 * a study app would otherwise make.
 */
export const profile = sqliteTable('profile', {
  id: integer('id').primaryKey().default(1),

  jobStartMinutes: integer('job_start_minutes').notNull(),
  jobEndMinutes: integer('job_end_minutes').notNull(),
  /** JSON array of weekday numbers, 0 = Sunday. Mon–Fri is [1,2,3,4,5]. */
  workDays: text('work_days').notNull().default('[1,2,3,4,5]'),

  commuteMinutesEachWay: integer('commute_minutes_each_way').notNull().default(0),
  wakeMinutes: integer('wake_minutes').notNull(),
  sleepMinutes: integer('sleep_minutes').notNull(),

  defaultPlaybackSpeed: real('default_playback_speed').notNull().default(1.5),

  gsCourseTotalLectures: integer('gs_course_total_lectures'),
  gsCourseTotalRuntimeMin: integer('gs_course_total_runtime_min'),
  /** JSON array of weekday numbers for Anthropology classes. */
  anthroClassDays: text('anthro_class_days').notNull().default('[]'),

  /** First full pass target. Deliberately separate from the exam year. */
  targetFirstPassDate: text('target_first_pass_date').notNull().default('2027-03-31'),
  examYear: integer('exam_year').notNull().default(2028),

  /**
   * The past-question dataset last imported, for display and support.
   *
   * A RECORD, never a gate. `ensurePyqImported` re-plans on every launch the
   * way `ensureSyllabusSeeded` does, because a version check would skip the
   * diff on a device whose previous import was interrupted mid-way and leave it
   * permanently short of questions with nothing to say so. What it buys is the
   * ability to answer "which papers does this phone actually have?" without
   * counting rows.
   */
  pyqDatasetVersion: integer('pyq_dataset_version'),

  timezone: text('timezone').notNull().default('Asia/Kolkata'),
  onboardedAt: text('onboarded_at').notNull().$defaultFn(nowIso),
  updatedAt: text('updated_at').notNull().$defaultFn(nowIso),
});

/** Generated weekly plan. Regenerated from logged actual hours, not aspiration. */
export const studyBlocks = sqliteTable('study_blocks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dayOfWeek: integer('day_of_week').notNull(),
  startMinutes: integer('start_minutes').notNull(),
  endMinutes: integer('end_minutes').notNull(),
  /**
   * active     — answer writing, active recall. Highest-energy slot.
   * reading    — standard books, note consolidation.
   * lecture    — recorded class watching. Never scheduled in the best slot.
   * micro      — commute/break drills, 10–15 min, offline.
   * timed_set  — weekend full-length answer sets.
   * catchup    — capped lecture backlog recovery.
   */
  kind: text('kind').notNull(),
  label: text('label').notNull(),
  generatedAt: text('generated_at').notNull().$defaultFn(nowIso),
});

/* ----------------------------------------------------------------- lectures */

/**
 * The backlog tracker's data. Recorded classes have no external pacing
 * pressure, so backlog compounds silently — this table exists to make that
 * visible in week two rather than month five.
 */
export const lectures = sqliteTable('lectures', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  course: text('course').notNull(), // 'gs' | 'anthro'
  subject: text('subject').notNull(),
  title: text('title').notNull(),
  runtimeMin: integer('runtime_min').notNull(),
  releasedOn: text('released_on').notNull(),
  watchedOn: text('watched_on'),
  /**
   * Deliberately skipped, not watched — and it needs its own column because
   * the two calculations disagree about it. A skipped lecture must LEAVE the
   * backlog (she is not going to watch it) but must NOT enter the watch-rate
   * numerator (it consumed no time). Recording a skip as "watched" inflates
   * the rate and makes days-to-clear optimistic at exactly the moment she has
   * just admitted she cannot keep up. Deleting the row instead would rewrite
   * the released-hours history and redraw the whole backlog trend.
   */
  skippedOn: text('skipped_on'),
  playbackSpeed: real('playback_speed'),
  notesMade: integer('notes_made', { mode: 'boolean' }).notNull().default(false),
  syllabusTopicId: integer('syllabus_topic_id').references(() => syllabusTopics.id, {
    onDelete: 'set null',
  }),
  createdAt: text('created_at').notNull().$defaultFn(nowIso),
});

/* ---------------------------------------------------------------- syllabus */

export const syllabusTopics = sqliteTable(
  'syllabus_topics',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /**
     * Stable identity for re-seeding, independent of wording.
     *
     * The syllabus ships as seed data and will be corrected over 18 months —
     * a typo fixed, a subtopic split. Matching seed rows to existing rows on
     * (paper, topic, subtopic) text means any such edit fails to match, the
     * row is treated as new, and the user's status and confidence for that
     * topic are silently wiped. The slug is what makes re-seeding safe.
     */
    slug: text('slug').notNull(),
    paper: text('paper').notNull(),
    topic: text('topic').notNull(),
    subtopic: text('subtopic'),
    /** Display and revision order within a paper. */
    position: integer('position').notNull().default(0),
    /** 'not_started' | 'in_progress' | 'first_pass' | 'revised' */
    status: text('status').notNull().default('not_started'),
    firstPassAt: text('first_pass_at'),
    revisedAt: text('revised_at'),
    confidence: integer('confidence'), // 1–5, self-reported
    /**
     * Tombstone. The other half of safe re-seeding, and `slug` alone does not
     * cover it: `slug` survives a rename, but a topic REMOVED from a corrected
     * syllabus has no safe answer without this. Deleting the row cascades its
     * `revision_queue` entry away — destroying months of review history — and
     * NULLs the `syllabus_topic_id` on every lecture and evaluated answer that
     * referenced it. Leaving the row untouched instead permanently depresses
     * coverage with a topic that is no longer examinable. So: retire, never
     * delete, and exclude retired rows from coverage.
     */
    retiredAt: text('retired_at'),
  },
  (table) => [uniqueIndex('syllabus_topics_slug_key').on(table.slug)],
);

/* ----------------------------------------------------------- answer writing */

export const answers = sqliteTable('answers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  createdAt: text('created_at').notNull().$defaultFn(nowIso),
  paper: text('paper').notNull(),
  questionText: text('question_text').notNull(),
  directiveWord: text('directive_word'),
  wordLimit: integer('word_limit').notNull().default(250),
  /** JSON array of local file URIs for the scanned pages. */
  imagePaths: text('image_paths').notNull().default('[]'),
  syllabusTopicId: integer('syllabus_topic_id').references(() => syllabusTopics.id, {
    onDelete: 'set null',
  }),
  /** 'pending' | 'queued' | 'evaluated' | 'failed' — drives the offline queue. */
  syncStatus: text('sync_status').notNull().default('pending'),

  /**
   * The past paper this question was set in, when it was one.
   *
   * Not written by the importer — a Mains GS answer row is created when SHE
   * writes an answer, not when a paper is imported. The columns exist so that
   * act can record what it was answering: "my average on real 2019 GS2
   * questions" is a different and far more useful number than an average over
   * a mix of real and generated prompts, and it is unrecoverable afterwards if
   * the provenance was never stored.
   */
  pyqYear: integer('pyq_year'),
  pyqPaper: text('pyq_paper'),
});

export const evaluations = sqliteTable(
  'evaluations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    answerId: integer('answer_id')
      .notNull()
      .references(() => answers.id, { onDelete: 'cascade' }),
    model: text('model').notNull(),
    /** Content hash of the rubric that produced this score. */
    rubricVersion: text('rubric_version').notNull(),
    total: real('total').notNull(),
    max: real('max').notNull(),
    directiveWord: text('directive_word'),
    directiveCompliance: integer('directive_compliance', { mode: 'boolean' }),
    feedbackMd: text('feedback_md').notNull(),
    modelSkeletonMd: text('model_skeleton_md'),
    highestLeverageFix: text('highest_leverage_fix'),
    legibility: text('legibility'), // 'good' | 'mixed' | 'poor'
    wordLimitRespected: integer('word_limit_respected', { mode: 'boolean' }),
    confidence: text('confidence'), // 'high' | 'medium' | 'low'
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
  },
  (table) => [index('evaluations_answer_id_idx').on(table.answerId)],
);

/**
 * One row per rubric dimension per evaluation.
 *
 * Normalised rather than a JSON blob because the question this data exists to
 * answer — "which dimension am I weakest on, and is it improving?" — means
 * aggregating one field grouped by another *across* evaluations. That is a SQL
 * job. Doing it now costs nothing; doing it after a thousand evaluations means
 * writing a backfill.
 */
export const evaluationDimensions = sqliteTable(
  'evaluation_dimensions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    evaluationId: integer('evaluation_id')
      .notNull()
      .references(() => evaluations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    score: real('score').notNull(),
    max: real('max').notNull(),
    comment: text('comment'),
  },
  (table) => [index('evaluation_dimensions_evaluation_id_idx').on(table.evaluationId)],
);

/* --------------------------------------------------------------- prelims */

export const mcqQuestions = sqliteTable(
  'mcq_questions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    syllabusTopicId: integer('syllabus_topic_id').references(() => syllabusTopics.id, {
      onDelete: 'set null',
    }),
    stem: text('stem').notNull(),
    /** JSON array of four option strings. */
    optionsJson: text('options_json').notNull(),
    correctIndex: integer('correct_index').notNull(),
    /** Why each wrong option is wrong — the part that actually teaches. */
    eliminationLogic: text('elimination_logic'),
    difficulty: text('difficulty').notNull().default('medium'),
    source: text('source'), // 'generated' | 'pyq'

    /**
     * Provenance, and it belongs on screen.
     *
     * A past question's key is UPSC's; a generated key is a model's, and she is
     * entitled to weight them differently. Showing which is which is what makes
     * "this looks wrong" a reasonable thing to tap rather than an accusation.
     * Repository invariant: `source = 'pyq'` implies `pyqYear` is set.
     */
    pyqYear: integer('pyq_year'),
    pyqPaper: text('pyq_paper'),

    /**
     * The generation run this came from.
     *
     * A bad generation run is a systemic failure, not N independent bad
     * questions — so it has to be quarantinable as a unit when the dispute rate
     * for a batch crosses the threshold.
     */
    batchId: text('batch_id'),
    /** Server-side id, so a client-side timeout can re-fetch rather than re-bill. */
    externalId: text('external_id'),
    /** Normalised stem, for duplicate suppression on insert. */
    stemFingerprint: text('stem_fingerprint').notNull().default(''),

    /**
     * Dispute state. "Quarantined" is the predicate
     * `disputedAt IS NOT NULL AND disputeResolvedAt IS NULL` — no extra column.
     *
     * A question she believes is wrong must stop being served IMMEDIATELY and
     * offline. An AI-generated key that is wrong does not merely fail to teach;
     * spaced repetition drills the falsehood to mastery.
     */
    disputedAt: text('disputed_at'),
    disputeReason: text('dispute_reason'), // 'wrong_key' | 'ambiguous' | 'outdated'
    disputeNote: text('dispute_note'),
    disputeResolvedAt: text('dispute_resolved_at'),
    disputeVerdict: text('dispute_verdict'), // 'upheld' | 'rejected'

    createdAt: text('created_at').notNull().$defaultFn(nowIso),
  },
  (table) => [
    uniqueIndex('mcq_questions_external_id_key').on(table.externalId),
    index('mcq_questions_fingerprint_idx').on(table.stemFingerprint),
    index('mcq_questions_batch_idx').on(table.batchId),
  ],
);

/**
 * One drill. Micro (a commute) or timed (a measured set).
 *
 * The marking scheme is frozen per session for the same reason
 * `evaluations.rubricVersion` is stored per evaluation: a session scored under
 * one scheme and re-rendered later under another silently rewrites her history.
 * UPSC's CSAT scheme changed in 2015; assume it can change again.
 */
export const mcqSessions = sqliteTable(
  'mcq_sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    mode: text('mode').notNull(), // 'micro' | 'timed'
    status: text('status').notNull().default('in_progress'),
    /** Real instant. */
    startedAt: text('started_at').notNull().$defaultFn(nowIso),
    endedAt: text('ended_at'),
    /**
     * Local calendar day, captured at START and never recomputed.
     *
     * The two-clocks rule again. A session begun at 23:50 and finished at 00:10
     * belongs to the day it started; recomputing at the end would move a
     * finished session to another day and silently change yesterday's totals.
     */
    studyDate: text('study_date').notNull(),
    /** `count(attempts)` cannot tell a 12-question session abandoned at 5 from a 5-question one. */
    plannedCount: integer('planned_count').notNull(),
    durationTargetSec: integer('duration_target_sec'),
    markPerCorrect: real('mark_per_correct').notNull().default(2),
    /**
     * The exact IEEE-754 double for −2/3, not a 4-decimal transcription of it.
     *
     * This default was `-0.6667`, which looks like the same scheme and is not:
     * scoring 100 questions at 25% accuracy gives −0.0025 instead of exactly 0,
     * so the break-even identity — the one line that catches every possible
     * sign or fraction error in the scoring code — would fail by a hair and
     * invite someone to "fix" it with an epsilon. `75 * (-2/3)` rounds to
     * exactly −50 in floating point, so the identity holds precisely.
     *
     * `resolveScheme` in `lib/mcq-score.ts` also snaps near values onto the
     * exact rational; that stays as defence in depth for rows written by an
     * older build, rather than being the thing holding the arithmetic together.
     */
    markPerWrong: real('mark_per_wrong').notNull().default(-0.6666666666666666),
    /** Which tier of the selection ladder dealt this session. */
    selectionReason: text('selection_reason'),
  },
  (table) => [index('mcq_sessions_study_date_idx').on(table.studyDate)],
);

/**
 * SM-2 over individual QUESTIONS, deliberately separate from `revisionQueue`.
 *
 * A wrong MCQ must never grade its syllabus topic. `revisionQueue` holds one
 * row per topic, so applying a failing grade there would reset the entire
 * spaced schedule for a whole syllabus leaf over a single missed fact — and
 * eight misses would mark the leaf a leech and eject it from the deck. A topic
 * is large; one fact is not evidence of topic-level forgetting.
 *
 * Unlike `revisionQueue`, this table is NOT capped: every wrong or skipped
 * question enrols, reaching thousands of rows over eighteen months and queried
 * on every deal. Hence the `dueAt` index that `revisionQueue` deliberately
 * does without.
 */
export const mcqReviewQueue = sqliteTable(
  'mcq_review_queue',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    questionId: integer('question_id')
      .notNull()
      .references(() => mcqQuestions.id, { onDelete: 'cascade' }),
    dueAt: text('due_at').notNull(),
    intervalDays: real('interval_days').notNull().default(1),
    easeFactor: real('ease_factor').notNull().default(2.5),
    repetitions: integer('repetitions').notNull().default(0),
    lapses: integer('lapses').notNull().default(0),
    lastReviewedAt: text('last_reviewed_at'),
    enrolledAt: text('enrolled_at').notNull().$defaultFn(nowIso),
  },
  (table) => [
    // Required, not merely tidy: `onConflictDoNothing({ target })` needs a real
    // matching constraint or it fails outright.
    uniqueIndex('mcq_review_queue_question_key').on(table.questionId),
    index('mcq_review_queue_due_at_idx').on(table.dueAt),
  ],
);

/**
 * The refill ledger.
 *
 * Batch metadata is derivable from `mcqQuestions.batchId` — but a FAILED refill
 * produces no questions and therefore no rows. "The last three top-ups failed"
 * is exactly what she needs to know BEFORE a commute, so a silent supply
 * failure has to leave a trace somewhere. This is that somewhere.
 */
export const mcqBankRefills = sqliteTable(
  'mcq_bank_refills',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Idempotency key, written BEFORE the call so a timeout cannot re-bill. */
    requestId: text('request_id').notNull(),
    requestedAt: text('requested_at').notNull().$defaultFn(nowIso),
    completedAt: text('completed_at'),
    status: text('status').notNull().default('pending'),
    trigger: text('trigger').notNull(), // 'auto' | 'post_session' | 'manual'
    requestedCount: integer('requested_count').notNull(),
    receivedCount: integer('received_count'),
    acceptedCount: integer('accepted_count'),
    batchId: text('batch_id'),
    error: text('error'),
    /** The plan that produced this request — makes a badly-aimed bank explicable later. */
    planJson: text('plan_json'),
  },
  (table) => [uniqueIndex('mcq_bank_refills_request_id_key').on(table.requestId)],
);

export const mcqAttempts = sqliteTable(
  'mcq_attempts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    questionId: integer('question_id')
      .notNull()
      .references(() => mcqQuestions.id, { onDelete: 'cascade' }),
    /**
     * A skip IS `chosenIndex === null`. There is deliberately no separate
     * boolean: a redundant flag is state that can drift, and under negative
     * marking a skip mis-read as a wrong answer costs 0.667 marks in a figure
     * nothing else would flag. The CHECK below makes the identity enforceable
     * rather than conventional.
     */
    chosenIndex: integer('chosen_index'),
    correct: integer('correct', { mode: 'boolean' }).notNull(),
    /**
     * Advisory only — it may never influence scoring or selection, so a
     * duration poisoned by backgrounded time stays cosmetic.
     */
    timeTakenSec: integer('time_taken_sec'),
    /**
     * Her own "I'm guessing" flag. Not derivable from anything else, and it is
     * what makes the highest-value Prelims skill measurable: with a −1/3
     * penalty, guessing pays only above 25% accuracy, so knowing WHEN not to
     * guess is worth marks on its own.
     */
    guessed: integer('guessed', { mode: 'boolean' }).notNull().default(false),
    /**
     * `restrict`, not `cascade`. The attempt log is the most expensive data
     * this app accumulates over eighteen months and must not be deletable as a
     * side effect of removing a session row.
     */
    sessionId: integer('session_id').references(() => mcqSessions.id, { onDelete: 'restrict' }),
    attemptedAt: text('attempted_at').notNull().$defaultFn(nowIso),
  },
  (table) => [
    // The highest-cardinality table here — tens of thousands of rows over 18
    // months, queried per-question on every drill.
    index('mcq_attempts_question_id_idx').on(table.questionId),
    index('mcq_attempts_session_id_idx').on(table.sessionId),
    /**
     * One answer per question per session, enforced rather than assumed.
     *
     * The drill screen guards against a double-tap in the render gap, but that
     * guard lives in a component and a component can be rewritten. This is the
     * invariant the repository already relies on — `recordAttempt` treats "this
     * question was already answered in this session" as impossible — so making
     * it actually impossible costs one index. A second row would double-count
     * the mark, push `attempts.length` past `plannedCount` so the resume
     * position derived from it is wrong, and run SM-2 twice for one answer.
     */
    uniqueIndex('mcq_attempts_session_question_key').on(table.sessionId, table.questionId),
    // A skip must never be recorded as correct. Three outcomes, not two.
    check(
      'mcq_attempts_skip_not_correct',
      sql`(${table.chosenIndex} is not null) or (${table.correct} = 0)`,
    ),
  ],
);

/* ------------------------------------------------------------- revision */

export const flashcards = sqliteTable(
  'flashcards',
  {
  id: integer('id').primaryKey({ autoIncrement: true }),
  syllabusTopicId: integer('syllabus_topic_id').references(() => syllabusTopics.id, {
    onDelete: 'set null',
  }),
  front: text('front').notNull(),
  back: text('back').notNull(),
  dueAt: text('due_at').notNull().$defaultFn(nowIso),
  intervalDays: real('interval_days').notNull().default(1),
  easeFactor: real('ease_factor').notNull().default(2.5),
  /**
   * SM-2 needs the repetition count, not just the interval: the first two
   * successful reviews use fixed intervals (1 day, then 6) and only the third
   * onward multiplies by the ease factor. Without this the algorithm cannot
   * tell a brand-new card from a mature one, and `revisionQueue` already
   * carries it — the omission here was an oversight, not a design choice.
   */
  repetitions: integer('repetitions').notNull().default(0),
  lastReviewedAt: text('last_reviewed_at'),
  /** Failed reviews. SM-2's terminal failure is a "leech" — an item ground to
   *  the 1.3 ease floor that you fail forever. Without a count there is no way
   *  to surface it, and it silently eats review time every single day. */
  lapses: integer('lapses').notNull().default(0),
  /**
   * The current-affairs item this card was kept from, if any.
   *
   * `set null`, deliberately not `cascade`: deleting or retracting an item must
   * not destroy months of SM-2 history for the card it spawned. Same argument
   * `mcqAttempts.sessionId` makes with `restrict` — the review record is the
   * expensive thing, and it outlives what produced it.
   */
  caItemId: integer('ca_item_id').references(() => caItems.id, { onDelete: 'set null' }),
  createdAt: text('created_at').notNull().$defaultFn(nowIso),
  },
  // The daily due query runs on every app open — the one hot path in Phase 2.
  (table) => [index('flashcards_due_at_idx').on(table.dueAt)],
);

/** SM-2 spaced repetition over topics rather than individual cards. */
export const revisionQueue = sqliteTable(
  'revision_queue',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    syllabusTopicId: integer('syllabus_topic_id')
      .notNull()
      .references(() => syllabusTopics.id, { onDelete: 'cascade' }),
    dueAt: text('due_at').notNull(),
    intervalDays: real('interval_days').notNull().default(1),
    easeFactor: real('ease_factor').notNull().default(2.5),
    repetitions: integer('repetitions').notNull().default(0),
    lastReviewedAt: text('last_reviewed_at'),
    /** See the note on flashcards.lapses — leech detection. */
    lapses: integer('lapses').notNull().default(0),
  },
  (table) => [
    // One row per topic is the intended invariant; nothing enforced it before.
    // Not optional: `enrolPendingTopics` relies on this index existing for its
    // `onConflictDoNothing({ target: syllabusTopicId })`, which needs a real
    // matching constraint or it fails outright rather than merely running slow.
    uniqueIndex('revision_queue_topic_key').on(table.syllabusTopicId),
    // No index on `dueAt`. `buildDeck` fetches every row and filters in JS, and
    // this table is hard-capped at one row per syllabus topic (~438) for the
    // whole preparation — an index would be pure write cost for a scan that is
    // already microseconds.
  ],
);

/**
 * Audit log of every SM-2 review.
 *
 * Same argument as `evaluationDimensions`: free to add now, a backfill later.
 * It is the only way to answer "which topics do I keep forgetting", and the
 * only way to debug an interval that looks wrong — the queue row holds just
 * the current state, so without this a bad schedule is unexplainable.
 *
 * Two nullable foreign keys with a CHECK rather than a polymorphic id, because
 * every other relation here is concrete and cascades correctly.
 */
export const revisionReviews = sqliteTable(
  'revision_reviews',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    syllabusTopicId: integer('syllabus_topic_id').references(() => syllabusTopics.id, {
      onDelete: 'cascade',
    }),
    flashcardId: integer('flashcard_id').references(() => flashcards.id, {
      onDelete: 'cascade',
    }),
    grade: integer('grade').notNull(),
    prevIntervalDays: real('prev_interval_days').notNull(),
    newIntervalDays: real('new_interval_days').notNull(),
    prevEase: real('prev_ease').notNull(),
    newEase: real('new_ease').notNull(),
    reviewedAt: text('reviewed_at').notNull().$defaultFn(nowIso),
  },
  (table) => [
    index('revision_reviews_topic_idx').on(table.syllabusTopicId),
    index('revision_reviews_flashcard_idx').on(table.flashcardId),
    /**
     * Exactly one target, enforced rather than merely intended.
     *
     * The comment above always claimed this shape; nothing checked it. Today
     * `gradeTopic` is the only writer and always sets one side, but there is no
     * flashcard repository yet, and its grading path is precisely the
     * copy-paste-and-forget that would write both or neither. A review row
     * belonging to nothing, or to two things, is unattributable afterwards.
     * Free to add now, while no device has ever created this table.
     */
    check(
      'revision_reviews_exactly_one_target',
      sql`(${table.syllabusTopicId} is not null) <> (${table.flashcardId} is not null)`,
    ),
  ],
);

/* ------------------------------------------------------- current affairs */

/**
 * One day's digest run.
 *
 * The `mcqBankRefills` argument, verbatim: a FAILED digest produces no
 * `ca_items` and is therefore invisible without a row of its own — and "the
 * last three digests failed" is exactly what she needs to know before she
 * stops trusting the feed. This also carries the idempotency key, written
 * BEFORE the network call, which is the only thing stopping a client timeout
 * from re-billing a digest the server already generated.
 */
export const caDigests = sqliteTable(
  'ca_digests',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    requestId: text('request_id').notNull(),
    /** Local calendar day. One digest per day, enforced. */
    date: text('date').notNull(),
    requestedAt: text('requested_at').notNull().$defaultFn(nowIso),
    completedAt: text('completed_at'),
    /** 'pending' | 'completed' | 'partial' | 'failed' */
    status: text('status').notNull().default('pending'),
    trigger: text('trigger').notNull(),
    model: text('model'),
    /** Content hash of the prompts + schema that produced this run. */
    promptVersion: text('prompt_version'),
    /** Content hash of the source allowlist. A feed change is visible here. */
    sourceSetVersion: text('source_set_version'),
    consideredCount: integer('considered_count'),
    shortlistedCount: integer('shortlisted_count'),
    keptCount: integer('kept_count'),
    droppedCount: integer('dropped_count'),
    /** JSON histogram. Rendered, not just logged — it teaches the filter. */
    dropReasonsJson: text('drop_reasons_json'),
    /** JSON array. A feed that 404s must not look like a quiet news day. */
    sourceFailuresJson: text('source_failures_json'),
    error: text('error'),
  },
  (table) => [
    uniqueIndex('ca_digests_request_id_key').on(table.requestId),
    uniqueIndex('ca_digests_date_key').on(table.date),
  ],
);

export const caItems = sqliteTable(
  'ca_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** The DIGEST day this item was delivered on. */
    date: text('date').notNull(),
    /**
     * When the SOURCE published it, which is not the same thing.
     *
     * A Sunday judgment lands in Monday's digest. Conflating the two makes the
     * monthly compilation wrong at every month boundary — and the compilation
     * is the artefact she takes into the exam hall.
     */
    publishedAt: text('published_at'),
    headline: text('headline').notNull(),
    sourceUrl: text('source_url'),
    sourceName: text('source_name'),
    /** Tracking params stripped, for duplicate suppression across outlets. */
    sourceUrlCanonical: text('source_url_canonical'),
    /**
     * 'structural' | 'report' | 'judgment' | 'scheme' | 'data' | 'event'
     *
     * The selection rule turns on this: a cabinet decision is structural and
     * earns a slot; a bilateral visit is an event and mostly does not. The
     * difference is whether the answer to "what changed?" is a rule or a
     * happening — and recovering that from prose later is impossible.
     */
    itemKind: text('item_kind').notNull().default('event'),
    /** JSON array of raw server-proposed tags, including unresolvable ones. */
    syllabusTags: text('syllabus_tags').notNull().default('[]'),
    noteMd: text('note_md').notNull(),
    /**
     * JSON array of verbatim quotes from the fetched page.
     *
     * The proof, and it is stored rather than discarded for two reasons: when
     * she doubts a note the quote must be inspectable OFFLINE, and it is what
     * any future re-verification compares against. Without it, "this came from
     * a real page" is an unverifiable claim about a past run.
     */
    evidenceJson: text('evidence_json').notNull().default('[]'),
    /** One deployable sentence. Narrowed from the old free-text field. */
    anthroLink: text('anthro_link'),
    /**
     * The Paper 1 concept and the Paper 2 Indian instance, as slugs.
     *
     * Stored as a PAIR because the rubric weights P1-theory-linked-to-P2-example
     * above everything else in the optional. Left as prose, building the
     * compilation's Anthropology table becomes a text-parsing job over 18
     * months of free text.
     */
    anthroP1Slug: text('anthro_p1_slug'),
    anthroP2Slug: text('anthro_p2_slug'),
    /** Volume discipline has to be MEASURED. This is the only input to it. */
    readAt: text('read_at'),
    /** 14-day duplicate window across outlets and across days of one story. */
    headlineFingerprint: text('headline_fingerprint').notNull().default(''),
    digestId: integer('digest_id').references(() => caDigests.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
  },
  (table) => [
    index('ca_items_date_idx').on(table.date),
    index('ca_items_fingerprint_idx').on(table.headlineFingerprint),
    index('ca_items_canonical_url_idx').on(table.sourceUrlCanonical),
    index('ca_items_digest_idx').on(table.digestId),
  ],
);

/**
 * Resolved syllabus links for a current-affairs item.
 *
 * The `evaluationDimensions` argument again: the question this exists to answer
 * — "which syllabus sections have live material and which have none" — means
 * aggregating one field grouped by another, across rows. That is a SQL join,
 * and a JSON array cannot join `syllabus_topics`. Free now; a backfill later.
 *
 * `caItems.syllabusTags` keeps the RAW strings so a syllabus re-seed can
 * re-resolve tags this build could not.
 */
export const caItemTopics = sqliteTable(
  'ca_item_topics',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    caItemId: integer('ca_item_id')
      .notNull()
      .references(() => caItems.id, { onDelete: 'cascade' }),
    syllabusTopicId: integer('syllabus_topic_id')
      .notNull()
      .references(() => syllabusTopics.id, { onDelete: 'cascade' }),
    /** Rank order, so the primary tag drives the flashcard's topic. */
    rank: integer('rank').notNull().default(0),
  },
  (table) => [
    uniqueIndex('ca_item_topics_key').on(table.caItemId, table.syllabusTopicId),
    index('ca_item_topics_topic_idx').on(table.syllabusTopicId),
  ],
);

/* ---------------------------------------------------- essay & ethics drills */

/**
 * One drill: a banked prompt, and the attempt against it.
 *
 * A row is created EMPTY, at bank time, and filled in when she answers it. That
 * is the same device `mcq_questions` uses and for the same reason: a drill she
 * cannot start on a morning with no signal is a drill she does not do, and the
 * only way to guarantee that is to have the prompt already on the phone.
 *
 * Essay outlines and ethics cases share this table rather than having one each.
 * They differ in their PARTS, which live in `drill_parts`, and in nothing else
 * that a row here records — kind, prompt, timing, status and score are the same
 * questions for both. Two tables would mean two of every query and two chances
 * for the status vocabulary to drift.
 */
export const drills = sqliteTable(
  'drills',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** `'essay_outline' | 'ethics_case'`. See `lib/drill-types.ts`. */
    kind: text('kind').notNull(),
    /**
     * `'banked' | 'in_progress' | 'submitted' | 'evaluated' | 'failed'`.
     *
     * `submitted` and `evaluated` are separate states because the evaluation is
     * a network call that can fail on a train. Her writing is saved the moment
     * she submits; the score arrives whenever it can.
     */
    status: text('status').notNull().default('banked'),
    /** The topic, or the one-line framing of the case. Never edited here. */
    promptText: text('prompt_text').notNull(),
    /** Situational detail for a case. Null for an essay topic — see the CHECK. */
    caseDetail: text('case_detail'),
    syllabusTopicId: integer('syllabus_topic_id').references(() => syllabusTopics.id, {
      onDelete: 'set null',
    }),
    /** Local calendar day this was banked, `YYYY-MM-DD`. Byte-compared. */
    bankedOn: text('banked_on').notNull(),
    /** The batch that produced it, for retroactively purging a bad cohort. */
    batchId: text('batch_id'),
    promptVersion: text('prompt_version'),
    /** ISO instants. The elapsed minutes are derived, not trusted from a timer. */
    startedAt: text('started_at'),
    submittedAt: text('submitted_at'),
    /**
     * Minutes she actually spent, written at submit.
     *
     * Stored rather than derived from the two timestamps because the screen can
     * be left open overnight: a wall-clock difference would report a
     * twelve-hour outline and quietly destroy the one number that says whether
     * she is getting faster.
     */
    minutesSpent: integer('minutes_spent'),
    total: real('total'),
    max: real('max'),
    feedbackMd: text('feedback_md'),
    highestLeverageFix: text('highest_leverage_fix'),
    /** Content hash of the rubric that scored this. */
    rubricVersion: text('rubric_version'),
    model: text('model'),
    /** Populated when an evaluation failed, so the retry has something to show. */
    error: text('error'),

    /**
     * `'generated' | 'pyq'`. Null reads as generated — every row written before
     * the importer existed is one.
     *
     * It belongs on screen for the reason `mcq_questions.source` does: a real
     * 2016 essay topic and a model's guess at one are not the same exercise,
     * and she is entitled to know which she is being asked to spend ninety
     * minutes on. It also keeps past papers out of the refill ceiling — see
     * `KindStock.bankedPyq` in `lib/drill-bank.ts`.
     */
    source: text('source'),
    pyqYear: integer('pyq_year'),
    pyqPaper: text('pyq_paper'),

    /**
     * The importer's permanent id, `pyq-<exam>-<year>-<set>-q<NNN>`. Null for
     * anything generated.
     *
     * Uniquely indexed, which is what makes a re-import a diff rather than a
     * duplication. SQLite treats NULLs as distinct in a UNIQUE index, so the
     * hundreds of generated rows that will never have one do not collide.
     */
    externalId: text('external_id'),

    /**
     * Withdrawn by a dataset revision, never deleted.
     *
     * `drill_parts` and `drill_scores` both cascade from this row, so deleting
     * a prompt she has already written against destroys the writing and its
     * score — the same failure `syllabus_topics.retiredAt` exists to avoid.
     * `mcq_questions` can express this through its dispute columns; `drills`
     * has none, so retirement is its quarantine.
     */
    retiredAt: text('retired_at'),

    createdAt: text('created_at').notNull().$defaultFn(nowIso),
  },
  (table) => [
    index('drills_status_idx').on(table.status, table.kind),
    index('drills_banked_on_idx').on(table.bankedOn),
    uniqueIndex('drills_external_id_key').on(table.externalId),
    /**
     * A case without its situation is unanswerable as a case — it degrades into
     * a theory question wearing a case's clothes, which is the exact failure the
     * ethics rubric warns about. An outline with case detail is a generation bug.
     */
    check(
      'drills_case_detail_matches_kind',
      sql`(${table.kind} = 'ethics_case' and ${table.caseDetail} is not null)
          or (${table.kind} <> 'ethics_case' and ${table.caseDetail} is null)`,
    ),
    /** A duplicate prompt wastes a slot in a bank of twelve. */
    uniqueIndex('drills_prompt_key').on(table.kind, table.promptText),
  ],
);

/**
 * One part of one attempt, as she wrote it.
 *
 * Normalised rather than a JSON blob on `drills`, for the reason
 * `evaluation_dimensions` gives: the question this exists to answer is "which
 * part am I weakest on, and is it improving?", which means aggregating one
 * column grouped by another ACROSS drills. That is a SQL job, and doing it now
 * costs nothing where doing it after two hundred drills means a backfill.
 */
export const drillParts = sqliteTable(
  'drill_parts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    drillId: integer('drill_id')
      .notNull()
      .references(() => drills.id, { onDelete: 'cascade' }),
    /** A key from `PARTS_OF_KIND`. The join key to `drill_scores`. */
    part: text('part').notNull(),
    content: text('content').notNull(),
    /** Display order, so a part list never depends on insertion order. */
    ordinal: integer('ordinal').notNull().default(0),
    updatedAt: text('updated_at').notNull().$defaultFn(nowIso),
  },
  (table) => [uniqueIndex('drill_parts_key').on(table.drillId, table.part)],
);

/**
 * One part's score.
 *
 * Separate from `drill_parts` rather than two more columns on it, because a
 * re-evaluation must be able to replace every score without touching a word she
 * wrote. Merged, a failed retry could truncate her own answer.
 */
export const drillScores = sqliteTable(
  'drill_scores',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    drillId: integer('drill_id')
      .notNull()
      .references(() => drills.id, { onDelete: 'cascade' }),
    part: text('part').notNull(),
    score: real('score').notNull(),
    max: real('max').notNull(),
    comment: text('comment'),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
  },
  (table) => [
    uniqueIndex('drill_scores_key').on(table.drillId, table.part),
    /** A part scored above its own ceiling is a wire bug, not a good answer. */
    check('drill_scores_within_max', sql`${table.score} >= 0 and ${table.score} <= ${table.max}`),
  ],
);

/**
 * Quotes, examples, thinkers and figures, filed against the syllabus.
 *
 * The essay rubric gives "quotes, examples and anecdotes" 10%, which understates
 * it: their ABSENCE is what makes an essay read as generic, and a decorative or
 * misattributed one costs more than it gains. The bank is how a specific example
 * gets into an essay written eight months after she read it.
 *
 * `caItemId` is the join to Phase 4. An item she kept as a flashcard is already
 * a fact she found worth carrying; making it available as essay material too is
 * the cheapest use the digest has.
 */
export const materialBank = sqliteTable(
  'material_bank',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** `'quote' | 'example' | 'anecdote' | 'thinker' | 'data'`. */
    kind: text('kind').notNull(),
    content: text('content').notNull(),
    /** Who said or did it. Null is honest; a guess is worse than nothing. */
    attribution: text('attribution'),
    /** Where she found it, so a doubtful one can be checked rather than dropped. */
    sourceNote: text('source_note'),
    syllabusTopicId: integer('syllabus_topic_id').references(() => syllabusTopics.id, {
      onDelete: 'set null',
    }),
    caItemId: integer('ca_item_id').references(() => caItems.id, { onDelete: 'set null' }),
    /**
     * How often it has been used in a drill.
     *
     * Drives surfacing: a quote used in four essays is one she reaches for
     * automatically and does not need reminding of, and the bank's job is to
     * surface the material she has forgotten she has.
     */
    timesUsed: integer('times_used').notNull().default(0),
    lastUsedAt: text('last_used_at'),
    retiredAt: text('retired_at'),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
  },
  (table) => [
    index('material_bank_topic_idx').on(table.syllabusTopicId),
    index('material_bank_kind_idx').on(table.kind),
    /** The same quote twice is a bank that lies about how much she has. */
    uniqueIndex('material_bank_content_key').on(table.content),
  ],
);

/* ------------------------------------------------------------ discipline */

export const studySessions = sqliteTable('study_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  date: text('date').notNull(),
  block: text('block'), // matches studyBlocks.kind
  plannedHours: real('planned_hours'),
  actualHours: real('actual_hours').notNull().default(0),
  /** JSON array of subject strings. */
  subjects: text('subjects').notNull().default('[]'),
  mood: integer('mood'), // 1–5
  energy: integer('energy'), // 1–5, the burnout signal that matters on a night shift
  notes: text('notes'),
  createdAt: text('created_at').notNull().$defaultFn(nowIso),
});

/* ------------------------------------------------------------------- DAF */

/**
 * One DAF field and its value.
 *
 * Key/value rather than a wide row, because the form is a list of independent
 * facts she fills in over two years in no particular order, and a wide row
 * would make "which fields are still empty" a check against sixteen nullable
 * columns rather than a count.
 *
 * `field` is unique: this is her form, and a second value for `home_district`
 * is a correction rather than a second district.
 */
export const dafProfile = sqliteTable(
  'daf_profile',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** A key from `DAF_FIELDS`. See `lib/daf-types.ts`. */
    field: text('field').notNull(),
    value: text('value').notNull(),
    updatedAt: text('updated_at').notNull().$defaultFn(nowIso),
  },
  (table) => [uniqueIndex('daf_profile_field_key').on(table.field)],
);

/**
 * A question a board might ask, generated from her own DAF.
 *
 * ## No column can hold an answer
 *
 * `notes` is hers and nothing writes it but her. There is deliberately no
 * `suggestedAnswer`, no `context`, no `background` — see the header of
 * `server/src/interview/types.ts`. A fabricated fact about her home district,
 * stored here, is one she would repeat to a board that knows the real figure.
 *
 * ## Why the generated text is never edited
 *
 * `question` is what the model produced and stays that way. If she wants to
 * reword it she is really writing a note, and letting her edit the question
 * would quietly turn the bank into a list of questions she finds comfortable —
 * which is the opposite of what it is for.
 */
export const interviewQuestions = sqliteTable(
  'interview_questions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** The DAF field it follows from. Null for a general question. */
    field: text('field'),
    /** A short noun phrase grouping related questions. The unit of readiness. */
    area: text('area').notNull(),
    question: text('question').notNull(),
    /** `'certain' | 'likely' | 'possible'`. Drives ordering, never scoring. */
    likelihood: text('likelihood').notNull().default('possible'),
    /** `'not_started' | 'notes_made' | 'rehearsed'`. */
    prep: text('prep').notNull().default('not_started'),
    /** Her own preparation. The only column she writes. */
    notes: text('notes'),
    /**
     * Marked as one she does not want to be asked.
     *
     * Kept rather than deleted, and shown FIRST rather than hidden: the
     * question she flinches at is the one to prepare, and an app that let her
     * bury it would be helping her avoid the interview rather than prepare for
     * it.
     */
    flagged: integer('flagged', { mode: 'boolean' }).notNull().default(false),
    /** The batch that produced it, for discarding a bad cohort. */
    batchId: text('batch_id'),
    promptVersion: text('prompt_version'),
    createdAt: text('created_at').notNull().$defaultFn(nowIso),
  },
  (table) => [
    index('interview_questions_area_idx').on(table.area),
    index('interview_questions_prep_idx').on(table.prep),
    /** The same question twice is a bank that lies about how much is left. */
    uniqueIndex('interview_questions_text_key').on(table.question),
  ],
);

/* ----------------------------------------------------------------- usage */

/** Local mirror of the server ledger, so spend is visible offline. */
export const apiUsage = sqliteTable('api_usage', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  date: text('date').notNull(),
  endpoint: text('endpoint').notNull(),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  estCostUsd: real('est_cost_usd').notNull().default(0),
  createdAt: text('created_at').notNull().$defaultFn(nowIso),
});
