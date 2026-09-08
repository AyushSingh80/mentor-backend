/**
 * MCQ re-drill — one attempt outcome turned into one SM-2 write, and nothing else.
 *
 * Pure. No RN, no expo-sqlite. Safe value imports only (`@/lib/sm2`).
 *
 * ## THE HARD BOUNDARY: this module writes NOTHING in Phase 2
 *
 * Phase 3 performs **zero writes** to `revision_queue`, `revision_reviews`,
 * `flashcards` or `syllabus_topics.confidence`. Not "few", not "only on a
 * lapse" — zero. If you are here to "helpfully" wire a wrong MCQ through to
 * its syllabus topic, read this first and then don't.
 *
 * `revision_queue` has a UNIQUE index on `syllabus_topic_id`, so a syllabus
 * leaf has exactly one row and exactly one interval. Applying a failing grade
 * there means `applyReview` at grade 2 sets `repetitions = 0`,
 * `intervalDays = 1`, `lapses += 1` and drops the ease by 0.32 — **one missed
 * fact would destroy the entire spaced schedule for a whole syllabus leaf**,
 * and eight of them would mark it a leech and eject it from the deck
 * altogether. A topic is large. One fact is not evidence of topic-level
 * forgetting.
 *
 * `flashcards` is refused for a different reason: converting an MCQ to a
 * front/back card discards the distractors, and the distractors plus
 * `eliminationLogic` ARE the pedagogical content. There is nothing left to
 * teach with.
 *
 * So a wrong MCQ enrols the **question itself** in `mcq_review_queue`, which
 * exists in the schema for exactly this, and reuses `lib/sm2.ts` unchanged.
 * The link to the syllabus topic is READ-ONLY — `mcqWeakTopics()` in
 * `db/mcq-questions.ts` renders it, and writes nothing.
 *
 * ## One SM-2, delegated
 *
 * Every interval, every ease delta, every date boundary comes from
 * `applyReview`. This module chooses a grade and hands over. It is a thin
 * delegation on purpose: a second SM-2 living here would drift from the first
 * one silently, and the drift would only be visible as a schedule that is
 * subtly wrong months later. Nothing below re-implements a rule — if you find
 * yourself computing an interval here, you are writing the bug.
 *
 * ## The grade mapping — frozen, and deterministic on purpose
 *
 *   `correct` -> grade **4**. `applyReview` leaves the ease exactly unchanged
 *      at q = 4 (`0.1 - 1 * (0.08 + 1 * 0.02) === 0`), which is the intended
 *      neutral: getting a question right should advance the interval without
 *      also declaring the item easy.
 *
 *   `wrong`   -> grade **2**, matching `GRADE_BUTTONS`' "Again". Not q = 0:
 *      that is a −0.80 penalty, so two misses would drive a fresh question
 *      straight to the 1.3 ease floor and it would never leave the front of
 *      the queue again.
 *
 *   `skipped` -> **no grade at all.** It enrols the question if it is not
 *      already enrolled, at the unseen state, due tomorrow — and applies
 *      nothing otherwise. A skip is a *declined* recall, not a failed one.
 *      Under UPSC's −1/3 marking, declining to answer is often the correct
 *      play, and grading it as a failure would let one cautious commute drive
 *      every question in the bank toward leech status. The enrolment date
 *      mirrors `enrolmentDueAt` in `db/revision.ts`: `applyReview` computes it
 *      so the date boundary is handled in the one place that owns it, and only
 *      `dueAt` is taken from the result — the row keeps its column defaults,
 *      because declining to answer is not a graded recall and must not consume
 *      an SM-2 repetition.
 *
 * ## Why there is deliberately no MCQ review audit table
 *
 * `revision_reviews` exists because a topic's grade comes from a human tapping
 * one of four buttons, and without a log a schedule that looks wrong cannot be
 * explained. Here the grade is a **deterministic pure function of the
 * outcome** — the table above, with no free choice anywhere in it — so the
 * whole interval history is reconstructible from `mcq_attempts` plus
 * `applyReview`. That reconstructibility is a design constraint, not a happy
 * accident: the moment anything in this file becomes non-deterministic (a
 * difficulty weighting, a streak bonus, a random tie-break), the history stops
 * being recoverable and the audit table has to be added back before the change
 * ships.
 *
 * ## The seam with the runtime agent
 *
 * This module exports the RULE; the runtime agent owns the WRITE. Their
 * synchronous transaction reads the current queue row with `.get()`, calls
 * `redrillEffect`, and executes the result with `.run()`. Keeping the decision
 * pure is what makes it unit-testable at all — anything importing `@/db/*`
 * transitively imports `expo-sqlite` and cannot run under Node.
 */

import { applyReview, type ReviewGrade, type Sm2State } from '@/lib/sm2';

/**
 * The three outcomes, and there are exactly three.
 *
 * `AttemptRecord` in `mcq-types.ts` encodes them as `chosenIndex === null` for
 * a skip plus a `correct` boolean; `outcomeOf` below is the single conversion,
 * so no caller has to remember which of the two fields carries the skip.
 */
export type McqOutcome = 'correct' | 'wrong' | 'skipped';

/**
 * The frozen mapping, as data rather than as branches, so a test can assert it
 * directly and a reader can check it against the header in one glance.
 *
 * `null` for a skip is the whole point: there is no grade, not a lenient one.
 */
export const OUTCOME_GRADE = {
  correct: 4,
  wrong: 2,
  skipped: null,
} as const satisfies Record<McqOutcome, ReviewGrade | null>;

/**
 * What the runtime agent's transaction should execute.
 *
 * `kind` is the verb; the rest are the column values. Deliberately flat and
 * fully populated on every path — including `'none'` — so the write site is a
 * switch over one field rather than a set of optional-property checks.
 */
export interface RedrillWrite {
  kind: 'insert' | 'update' | 'none';
  questionId: number;
  /** ISO, always the start of the due day. Never today — see `NEVER_TODAY`. */
  dueAt: string;
  intervalDays: number;
  easeFactor: number;
  repetitions: number;
  lapses: number;
}

/**
 * The state handed to `applyReview` for a question that has never been
 * enrolled. `intervalDays: 0` is a sentinel meaning "no interval yet": at
 * `repetitions === 0` the algorithm takes its constant branch and never reads
 * it. Identical to `UNSEEN` in `db/revision.ts`, and for the same reason.
 */
const UNSEEN: Sm2State = { repetitions: 0, intervalDays: 0, easeFactor: 2.5, lapses: 0 };

/**
 * The `mcq_review_queue` column defaults, restated so an ungraded enrolment
 * writes exactly what the schema would have defaulted to.
 *
 * `intervalDays` is 1 here and 0 in `UNSEEN` above, and the difference is
 * deliberate: 0 is an input sentinel that is never stored, 1 is the real
 * column default for a row that has not been reviewed yet.
 */
const NEW_ENROLMENT = { intervalDays: 1, easeFactor: 2.5, repetitions: 0, lapses: 0 } as const;

/**
 * Reads the outcome off an attempt.
 *
 * A skip IS `chosenIndex === null` — there is no separate flag, and the schema
 * has a CHECK constraint making the identity enforceable rather than
 * conventional. `correct` is consulted only once a choice was actually made,
 * so a row that somehow claims a correct skip still reads as a skip.
 */
export function outcomeOf(attempt: { chosenIndex: number | null; correct: boolean }): McqOutcome {
  // `== null` catches both null and undefined, matching `mcq-score.outcomeOf`
  // exactly. See the note there: a divergence would let one attempt score as a
  // skip while scheduling as a wrong answer.
  if (attempt.chosenIndex == null) return 'skipped';
  return attempt.correct ? 'correct' : 'wrong';
}

/**
 * One attempt outcome -> one queue write. Pure, total, and delegating.
 *
 * `current` is the existing `mcq_review_queue` row's SM-2 state, or `null`
 * when the question has never been enrolled. The four interesting cases:
 *
 *   - **wrong, not enrolled**    -> `insert`, graded 2 from the unseen state.
 *   - **wrong/correct, enrolled** -> `update`, graded 2 / 4 from `current`.
 *   - **correct, not enrolled**  -> `none`. A question answered right the
 *     first time does not join the re-drill queue at all; tier 4 of the
 *     selection ladder brings it back after three weeks straight from the
 *     attempt log, which is genuine spaced retrieval rather than remediation.
 *   - **skipped**                -> `insert` at the unseen state due tomorrow
 *     if not enrolled, otherwise `none`. Never a grade, so **a skip can never
 *     increment `lapses`** and can never move the ease.
 *
 * Throws only what `applyReview` throws: an unparseable `todayIso`. That is
 * deliberate on a write path — silently substituting a date would put an
 * uncomparable string in `due_at` and the question would never be due again.
 * A throw inside the caller's synchronous transaction rolls the whole thing
 * back and nothing is half-written.
 *
 * `questionId` trails the three arguments of the agreed seam so the result is
 * a single object the transaction can execute without re-threading the id.
 */
export function redrillEffect(
  outcome: McqOutcome,
  current: Sm2State | null,
  todayIso: string,
  questionId: number,
): RedrillWrite {
  // Tomorrow, at the start of the day, computed by the module that owns the
  // date boundary rather than by local arithmetic here. Exactly the trick
  // `enrolmentDueAt` in `db/revision.ts` uses, and for the same reason: both
  // halves of the rule — collapse the instant to its calendar day, then add
  // whole days — live in `lib/sm2.ts` so no caller can get one of them wrong.
  const dueTomorrow = () => applyReview(UNSEEN, 4, todayIso).dueAt;

  if (outcome === 'skipped') {
    // Already enrolled: the schedule is whatever the last real grade made it,
    // and declining to answer is not new evidence about recall.
    if (current) {
      return {
        kind: 'none',
        questionId,
        // A `'none'` still carries a full, safe row. See the note below.
        dueAt: dueTomorrow(),
        intervalDays: current.intervalDays,
        easeFactor: current.easeFactor,
        repetitions: current.repetitions,
        lapses: current.lapses,
      };
    }
    return { kind: 'insert', questionId, dueAt: dueTomorrow(), ...NEW_ENROLMENT };
  }

  if (!current) {
    if (outcome === 'correct') {
      return { kind: 'none', questionId, dueAt: dueTomorrow(), ...NEW_ENROLMENT };
    }
    const seeded = applyReview(UNSEEN, OUTCOME_GRADE.wrong, todayIso);
    return {
      kind: 'insert',
      questionId,
      dueAt: seeded.dueAt,
      intervalDays: seeded.intervalDays,
      easeFactor: seeded.easeFactor,
      repetitions: seeded.repetitions,
      lapses: seeded.lapses,
    };
  }

  const next = applyReview(current, OUTCOME_GRADE[outcome], todayIso);
  return {
    kind: 'update',
    questionId,
    dueAt: next.dueAt,
    intervalDays: next.intervalDays,
    easeFactor: next.easeFactor,
    repetitions: next.repetitions,
    lapses: next.lapses,
  };
}

/**
 * Why a `'none'` still carries a complete row.
 *
 * The safe failure mode. A caller that ignores `kind` and executes every
 * result as a write must not be able to do damage: the values are the current
 * state unchanged, and `dueAt` is tomorrow — **never today**. Executing a
 * `'none'` by mistake therefore cannot resurface the question inside the
 * session that just dealt it, which is the one outcome the selection ladder
 * promises will never happen. Wrong in the harmless direction, on purpose.
 */
export const NEVER_TODAY =
  'A RedrillWrite of kind "none" is due tomorrow, never today, so executing one by mistake cannot re-deal the question in the current session.' as const;
