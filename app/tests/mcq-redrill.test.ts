/**
 * MCQ re-drill tests.
 *
 * Organised by the rule each group defends rather than by function, because
 * the rules are the specification. Two of them are load-bearing beyond this
 * module:
 *
 *  - **A skip never increments `lapses`.** A skip is a declined recall, not a
 *    failed one. Grading skips as failures would let one cautious commute walk
 *    every question in the bank toward leech status, and under UPSC's −1/3
 *    marking declining to answer is frequently the correct play.
 *
 *  - **The intervals are `sm2.ts`'s, not a second implementation.** The
 *    sequence asserted below for wrong -> correct -> correct -> correct is the
 *    same sequence `sm2.test.ts` already asserts for grades [2, 4, 4, 4] on the
 *    same starting state. If this module ever grew its own arithmetic, that
 *    equality is what would break.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  NEVER_TODAY,
  OUTCOME_GRADE,
  outcomeOf,
  redrillEffect,
  type McqOutcome,
  type RedrillWrite,
} from '../src/lib/mcq-redrill';
import { GRADE_BUTTONS, applyReview, isDue, type Sm2State } from '../src/lib/sm2';

const QUESTION = 4242;

/** Mid-evening, which is when a night-shift worker actually drills. */
const AT_2200 = '2026-09-07T22:00:00.000Z';
const TOMORROW = '2026-09-08T00:00:00.000Z';

/** A question that has never been enrolled in the re-drill queue. */
const UNENROLLED = null;

/** The mature state `sm2.test.ts` uses for its lapse-and-recover sequence. */
const MATURE: Sm2State = { repetitions: 5, intervalDays: 40, easeFactor: 2.2, lapses: 0 };

function stateOf(write: RedrillWrite): Sm2State {
  return {
    repetitions: write.repetitions,
    intervalDays: write.intervalDays,
    easeFactor: write.easeFactor,
    lapses: write.lapses,
  };
}

/** Threads one outcome into the next, the way the runtime agent's loop does. */
function run(start: Sm2State | null, outcomes: McqOutcome[], atIso = AT_2200): RedrillWrite[] {
  const writes: RedrillWrite[] = [];
  let current = start;
  for (const outcome of outcomes) {
    const write = redrillEffect(outcome, current, atIso, QUESTION);
    writes.push(write);
    // A `'none'` writes nothing, so the next call sees the unchanged row.
    current = write.kind === 'none' ? current : stateOf(write);
  }
  return writes;
}

/* ------------------------------------------------------- the grade mapping */

describe('the grade mapping', () => {
  it('maps correct to 4, wrong to 2 and skipped to no grade at all', () => {
    assert.equal(OUTCOME_GRADE.correct, 4);
    assert.equal(OUTCOME_GRADE.wrong, 2);
    assert.equal(OUTCOME_GRADE.skipped, null);
  });

  it('uses the same grade for wrong as the Again button', () => {
    // Not q=0: at −0.80 two misses would drive a fresh question straight to
    // the 1.3 ease floor and it would never leave the front of the queue.
    assert.equal(OUTCOME_GRADE.wrong, GRADE_BUTTONS[0]!.grade);
    assert.equal(GRADE_BUTTONS[0]!.label, 'Again');
  });

  it('leaves the ease exactly unchanged on a correct answer', () => {
    // q=4 is the intended neutral: `0.1 - 1 * (0.08 + 1 * 0.02)` is exactly 0
    // in IEEE-754, so this is a strict equality on purpose.
    const [write] = run(MATURE, ['correct']);
    assert.equal(write!.easeFactor, MATURE.easeFactor);
  });

  it('applies the documented −0.32 penalty on a wrong answer', () => {
    const [write] = run(MATURE, ['wrong']);
    assert.ok(Math.abs(write!.easeFactor - (MATURE.easeFactor - 0.32)) < 1e-9);
  });

  it('reads the outcome off an attempt, with the skip as a null choice', () => {
    assert.equal(outcomeOf({ chosenIndex: null, correct: false }), 'skipped');
    assert.equal(outcomeOf({ chosenIndex: 2, correct: true }), 'correct');
    assert.equal(outcomeOf({ chosenIndex: 2, correct: false }), 'wrong');
    // A row claiming a correct skip is still a skip. The schema's CHECK makes
    // this unreachable; the identity is asserted anyway because it is the one
    // place a skip could be silently rescored as an answer.
    assert.equal(outcomeOf({ chosenIndex: null, correct: true }), 'skipped');
  });
});

/* -------------------------------------------------------------- the skip */

describe('a skip is a declined recall, not a failed one', () => {
  it('never increments lapses, however many times it is skipped', () => {
    const writes = run(MATURE, Array(20).fill('skipped') as McqOutcome[]);
    for (const [i, write] of writes.entries()) {
      assert.equal(write.lapses, MATURE.lapses, `skip ${i + 1} incremented the lapse count`);
    }
  });

  it('never increments lapses from the unenrolled state either', () => {
    const writes = run(UNENROLLED, Array(20).fill('skipped') as McqOutcome[]);
    for (const write of writes) assert.equal(write.lapses, 0);
  });

  it('never moves the ease factor', () => {
    const writes = run(MATURE, ['skipped', 'skipped', 'skipped']);
    for (const write of writes) assert.equal(write.easeFactor, MATURE.easeFactor);
  });

  it('never resets the interval the way a failure does', () => {
    const [skip] = run(MATURE, ['skipped']);
    const [fail] = run(MATURE, ['wrong']);
    assert.equal(skip!.intervalDays, MATURE.intervalDays);
    assert.equal(fail!.intervalDays, 1, 'a wrong answer should reset the interval');
  });

  it('still enrols a question that was never in the queue', () => {
    const [write] = run(UNENROLLED, ['skipped']);
    assert.equal(write!.kind, 'insert');
    assert.equal(write!.repetitions, 0);
    assert.equal(write!.lapses, 0);
    // The `mcq_review_queue` column defaults, so an ungraded enrolment writes
    // exactly what the schema would have defaulted to.
    assert.equal(write!.intervalDays, 1);
    assert.equal(write!.easeFactor, 2.5);
  });

  it('enrols at the start of tomorrow, mirroring enrolmentDueAt', () => {
    const [write] = run(UNENROLLED, ['skipped']);
    assert.match(write!.dueAt, /T00:00:00\.000Z$/);
    assert.equal(write!.dueAt, TOMORROW);
    // The date-boundary bug this guards: a 22:00 enrolment scheduled as a full
    // timestamp is invisible for the whole of the next 08:00–10:00 block.
    assert.equal(isDue(write!.dueAt, '2026-09-08T08:00:00.000Z'), true);
  });

  it('does nothing at all once the question is already enrolled', () => {
    const [write] = run(MATURE, ['skipped']);
    assert.equal(write!.kind, 'none');
    assert.deepEqual(stateOf(write!), MATURE);
  });

  it('applies no grade, so the schedule after a skip is the schedule before it', () => {
    // The proof that a skip is not a lenient grade but no grade: skipping
    // fifty times then answering correctly gives exactly the same result as
    // answering correctly straight away.
    const skippedFirst = run(MATURE, [...(Array(50).fill('skipped') as McqOutcome[]), 'correct']);
    const [direct] = run(MATURE, ['correct']);
    assert.deepEqual(stateOf(skippedFirst[skippedFirst.length - 1]!), stateOf(direct!));
  });
});

/* ---------------------------------------------------------- what enrols */

describe('what joins the re-drill queue', () => {
  it('enrols a wrong answer that was never enrolled', () => {
    const [write] = run(UNENROLLED, ['wrong']);
    assert.equal(write!.kind, 'insert');
    assert.equal(write!.lapses, 1);
    assert.equal(write!.repetitions, 0);
    assert.equal(write!.intervalDays, 1);
    assert.ok(Math.abs(write!.easeFactor - 2.18) < 1e-9);
  });

  it('does NOT enrol a question answered correctly the first time', () => {
    // Tier 4 of the ladder brings it back after three weeks straight from the
    // attempt log — genuine spaced retrieval rather than remediation.
    const [write] = run(UNENROLLED, ['correct']);
    assert.equal(write!.kind, 'none');
  });

  it('updates rather than inserts once the question is enrolled', () => {
    for (const outcome of ['correct', 'wrong'] as McqOutcome[]) {
      assert.equal(redrillEffect(outcome, MATURE, AT_2200, QUESTION).kind, 'update');
    }
  });

  it('carries the question id through on every path', () => {
    for (const outcome of ['correct', 'wrong', 'skipped'] as McqOutcome[]) {
      for (const current of [UNENROLLED, MATURE]) {
        assert.equal(redrillEffect(outcome, current, AT_2200, QUESTION).questionId, QUESTION);
      }
    }
  });
});

/* ------------------------------------------------- delegation, not a copy */

describe('the intervals come from sm2.ts', () => {
  it('reproduces the sequence sm2.test.ts asserts for grades 2, 4, 4, 4', () => {
    // `sm2.test.ts` — "recovers a lapsed item through the constant intervals
    // again" — asserts exactly [1, 1, 6, 11] for this state and these grades.
    // Fail (ease 2.2 -> 1.88, interval 40 -> 1), then 1, 6, and 6 * 1.88 -> 11.
    const writes = run(MATURE, ['wrong', 'correct', 'correct', 'correct']);
    assert.deepEqual(
      writes.map((w) => w.intervalDays),
      [1, 1, 6, 11],
    );
  });

  it('matches applyReview field for field on every graded outcome', () => {
    // The strongest available statement that nothing here re-implements SM-2:
    // for the mapped grade, every column is the algorithm's own output.
    for (const [outcome, grade] of [
      ['correct', 4],
      ['wrong', 2],
    ] as const) {
      const write = redrillEffect(outcome, MATURE, AT_2200, QUESTION);
      const expected = applyReview(MATURE, grade, AT_2200);
      assert.deepEqual(stateOf(write), {
        repetitions: expected.repetitions,
        intervalDays: expected.intervalDays,
        easeFactor: expected.easeFactor,
        lapses: expected.lapses,
      });
      assert.equal(write.dueAt, expected.dueAt);
    }
  });

  it('seeds a first wrong answer from the unseen state applyReview expects', () => {
    const write = redrillEffect('wrong', UNENROLLED, AT_2200, QUESTION);
    const expected = applyReview(
      { repetitions: 0, intervalDays: 0, easeFactor: 2.5, lapses: 0 },
      2,
      AT_2200,
    );
    assert.equal(write.intervalDays, expected.intervalDays);
    assert.equal(write.easeFactor, expected.easeFactor);
    assert.equal(write.dueAt, expected.dueAt);
  });

  it('inherits the ease floor rather than clamping separately', () => {
    const writes = run(MATURE, Array(20).fill('wrong') as McqOutcome[]);
    for (const write of writes) assert.ok(write.easeFactor >= 1.3);
    assert.equal(writes[19]!.easeFactor, 1.3);
  });

  it('inherits the 180-day interval ceiling', () => {
    const long: Sm2State = { repetitions: 8, intervalDays: 175, easeFactor: 2.5, lapses: 0 };
    assert.equal(redrillEffect('correct', long, AT_2200, QUESTION).intervalDays, 180);
  });
});

/* ------------------------------------------------------- the date boundary */

describe('the date boundary', () => {
  it('always writes a start-of-day dueAt, whatever the time of day', () => {
    for (const at of ['T00:00:00.000Z', 'T07:15:00.000Z', 'T13:37:04.321Z', 'T23:59:59.999Z']) {
      for (const outcome of ['correct', 'wrong', 'skipped'] as McqOutcome[]) {
        for (const current of [UNENROLLED, MATURE]) {
          const write = redrillEffect(outcome, current, `2026-09-07${at}`, QUESTION);
          assert.match(
            write.dueAt,
            /T00:00:00\.000Z$/,
            `${outcome} at ${at} produced a non-midnight dueAt: ${write.dueAt}`,
          );
        }
      }
    }
  });

  it('never schedules anything for today, on any path', () => {
    // Including a `'none'`, which carries a full row precisely so that
    // executing one by mistake cannot re-deal the question in this session.
    assert.match(NEVER_TODAY, /never today/);
    for (const outcome of ['correct', 'wrong', 'skipped'] as McqOutcome[]) {
      for (const current of [UNENROLLED, MATURE]) {
        const write = redrillEffect(outcome, current, AT_2200, QUESTION);
        assert.equal(
          isDue(write.dueAt, AT_2200),
          false,
          `${outcome} scheduled a re-drill for the same day`,
        );
      }
    }
  });

  it('refuses to write a due date it cannot parse', () => {
    // Silently substituting a date would put an uncomparable string in
    // `due_at` and the question would never be due again. A throw inside the
    // caller's synchronous transaction rolls it back instead.
    for (const outcome of ['correct', 'wrong', 'skipped'] as McqOutcome[]) {
      assert.throws(() => redrillEffect(outcome, MATURE, 'not a date', QUESTION));
      assert.throws(() => redrillEffect(outcome, UNENROLLED, '', QUESTION));
    }
  });
});
