/**
 * Drill runtime tests.
 *
 * Organised by the rule each block defends rather than by function, the way
 * `sm2.test.ts` is: a regression report should say WHICH rule broke, not which
 * line moved. Four of these blocks exist because the rule they pin is a
 * measurement property that a duration setting cannot express, and getting one
 * of them wrong produces a number that looks plausible and is wrong.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EXTEND_STEP,
  MAX_QUESTION_SECONDS,
  MICRO_PRESET,
  PRESETS,
  TIMED_PRESET,
  activeMillis,
  activeSeconds,
  advance,
  answeredIds,
  autoSubmitSkips,
  canExtend,
  closureStatus,
  commit,
  commitAnswer,
  extendedCount,
  isResumable,
  isSameStudyDay,
  isSessionMode,
  nextIndex,
  presetFor,
  remainingSeconds,
  reopen,
  sessionBudgetSeconds,
  skipAnswer,
  startMachine,
  toggleGuess,
  type ClockEvent,
  type SessionLifecycle,
} from '../src/lib/mcq-session';
import { outcomeOf } from '../src/lib/mcq-redrill';
import { OPTION_COUNT } from '../src/lib/mcq-types';
import type { AttemptRecord, DrillQuestion } from '../src/lib/mcq-types';

/* ------------------------------------------------------------- fixtures */

function question(questionId: number, correctIndex = 0): DrillQuestion {
  return {
    questionId,
    stem: `Stem ${questionId}`,
    options: ['1 only', '2 only', '1 and 2', 'Neither'],
    correctIndex,
    eliminationLogic: null,
    difficulty: 'medium',
    source: 'generated',
    pyqYear: null,
    pyqPaper: null,
    paper: 'gs1',
    sectionLabel: null,
    syllabusTopicId: null,
    priorAttempts: 0,
    tier: 'unseen_any',
  };
}

function attempt(questionId: number, chosenIndex: number | null = 0): AttemptRecord {
  return {
    questionId,
    chosenIndex,
    correct: chosenIndex === 0,
    guessed: false,
    timeTakenSec: 30,
    attemptedAt: '2026-09-07T07:44:00.000Z',
  };
}

function lifecycle(over: Partial<SessionLifecycle> = {}): SessionLifecycle {
  return {
    mode: 'micro',
    status: 'in_progress',
    studyDate: '2026-09-07',
    plannedCount: 12,
    answeredCount: 3,
    ...over,
  };
}

const T0 = Date.parse('2026-09-07T07:44:00.000Z');
const SECOND = 1000;

/* ------------------------------------------------------------- presets */

describe('presets — the four differences a duration setting cannot express', () => {
  it('reveals per question in micro and only at the end in timed', () => {
    // A set that shows the answer mid-way is not a measurement.
    assert.equal(MICRO_PRESET.revealMode, 'per_question');
    assert.equal(TIMED_PRESET.revealMode, 'at_end');
  });

  it('shows a countdown only in timed, at UPSC’s own 72 s a question', () => {
    // 100 questions in 120 minutes is exactly 72 s each. A measured set that
    // runs gentler than the exam measures something other than the exam.
    assert.equal(MICRO_PRESET.secondsPerQuestion, null);
    assert.equal(TIMED_PRESET.secondsPerQuestion, 72);

    assert.equal(sessionBudgetSeconds(MICRO_PRESET, 10), null);
    assert.equal(sessionBudgetSeconds(TIMED_PRESET, 25), 1800);
  });

  it('never surfaces a remaining time in micro, however much has elapsed', () => {
    assert.equal(remainingSeconds(MICRO_PRESET, 10, 0), null);
    assert.equal(remainingSeconds(MICRO_PRESET, 10, 99_999), null);
  });

  it('counts a timed set down to zero and no further', () => {
    assert.equal(remainingSeconds(TIMED_PRESET, 25, 0), 1800);
    assert.equal(remainingSeconds(TIMED_PRESET, 25, 1799.4), 1);
    assert.equal(remainingSeconds(TIMED_PRESET, 25, 1800), 0);
    assert.equal(remainingSeconds(TIMED_PRESET, 25, 5000), 0);
  });

  it('is resumable within the day in micro and never in timed', () => {
    assert.equal(MICRO_PRESET.resumableWithinDay, true);
    assert.equal(TIMED_PRESET.resumableWithinDay, false);
  });

  it('deals 10 for a commute and 25 for a measured set', () => {
    // 10 x (45 s to answer + 30 s to read the elimination) is 12.5 minutes.
    assert.equal(MICRO_PRESET.questionCount, 10);
    assert.equal(TIMED_PRESET.questionCount, 25);
  });

  it('extends a micro set in fives to twenty, and a timed set never', () => {
    assert.equal(EXTEND_STEP, 5);

    assert.equal(canExtend(MICRO_PRESET, 10), true);
    assert.equal(extendedCount(MICRO_PRESET, 10), 15);
    assert.equal(extendedCount(MICRO_PRESET, 15), 20);
    // The ceiling holds rather than overshooting to 25.
    assert.equal(extendedCount(MICRO_PRESET, 20), 20);
    assert.equal(canExtend(MICRO_PRESET, 20), false);

    // Extending a measured set mid-flight changes the denominator of the thing
    // being measured, so `maxQuestionCount === questionCount` forbids it.
    assert.equal(canExtend(TIMED_PRESET, 25), false);
    assert.equal(extendedCount(TIMED_PRESET, 25), 25);
  });

  it('resolves modes and rejects anything that is not one', () => {
    assert.equal(presetFor('micro'), MICRO_PRESET);
    assert.equal(presetFor('timed'), TIMED_PRESET);
    assert.equal(PRESETS.micro.mode, 'micro');

    assert.equal(isSessionMode('micro'), true);
    assert.equal(isSessionMode('timed'), true);
    assert.equal(isSessionMode('TIMED'), false);
    assert.equal(isSessionMode(undefined), false);
    assert.equal(isSessionMode(2), false);
  });
});

/* --------------------------------------------------------------- timer */

describe('activeSeconds — foreground-only, and hard-clamped', () => {
  it('counts the whole window when nothing interrupted it', () => {
    assert.equal(activeSeconds([], T0, T0 + 45 * SECOND), 45);
  });

  it('excludes a background gap entirely', () => {
    // Ten seconds of reading, an hour in a pocket, ten seconds to answer.
    const events: ClockEvent[] = [
      { atMs: T0 + 10 * SECOND, active: false },
      { atMs: T0 + 3610 * SECOND, active: true },
    ];
    const seconds = activeSeconds(events, T0, T0 + 3620 * SECOND);

    assert.equal(seconds, 20);
    // Without the exclusion this single attempt would record an hour and drag
    // every mean it touches.
    assert.notEqual(seconds, 3620);
  });

  it('clamps a three-hour question to ten minutes', () => {
    // No events at all: she never backgrounded the app, she just put the phone
    // face down. The clamp is the only defence left.
    assert.equal(activeSeconds([], T0, T0 + 3 * 3600 * SECOND), MAX_QUESTION_SECONDS);
    assert.equal(MAX_QUESTION_SECONDS, 600);
  });

  it('opens in the state the last event before the window set', () => {
    // Backgrounded before the question was even dealt — a notification tap
    // that landed the wrong way.
    const events: ClockEvent[] = [
      { atMs: T0 - 5 * SECOND, active: false },
      { atMs: T0 + 30 * SECOND, active: true },
    ];
    assert.equal(activeSeconds(events, T0, T0 + 40 * SECOND), 10);
  });

  it('does not care what order the events arrive in', () => {
    const ordered: ClockEvent[] = [
      { atMs: T0 + 10 * SECOND, active: false },
      { atMs: T0 + 20 * SECOND, active: true },
    ];
    const shuffled = [ordered[1], ordered[0]];
    assert.equal(
      activeSeconds(shuffled, T0, T0 + 30 * SECOND),
      activeSeconds(ordered, T0, T0 + 30 * SECOND),
    );
  });

  it('ignores events after the window closes', () => {
    const events: ClockEvent[] = [{ atMs: T0 + 500 * SECOND, active: false }];
    assert.equal(activeSeconds(events, T0, T0 + 20 * SECOND), 20);
  });

  it('survives a nonsense window rather than emitting NaN', () => {
    assert.equal(activeSeconds([], Number.NaN, T0), 0);
    // Ended before it started: zero, never negative.
    assert.equal(activeSeconds([], T0, T0 - 10 * SECOND), 0);
  });

  it('leaves the session clock unclamped — the 600 s ceiling is per question', () => {
    // The set-level countdown runs to 1800 s, so it reads `activeMillis`
    // directly. Clamping there would auto-submit a timed set at ten minutes.
    assert.equal(activeMillis([], T0, T0 + 1800 * SECOND), 1800 * SECOND);
  });
});

/* ------------------------------------------------- resume and closure */

describe('isResumable — a measured set is never picked back up', () => {
  it('resumes a micro session for the rest of the local day', () => {
    assert.equal(isResumable(lifecycle(), '2026-09-07'), true);
    // Date-prefix comparison, never a timestamp comparison: 22:00 on the same
    // local day is still the same day.
    assert.equal(isResumable(lifecycle(), '2026-09-07T22:00:00.000Z'), true);
  });

  it('refuses a timed session on the very same day', () => {
    // The break is exactly the variable the set exists to control.
    assert.equal(isResumable(lifecycle({ mode: 'timed' }), '2026-09-07'), false);
  });

  it('refuses anything across the local day boundary', () => {
    assert.equal(isResumable(lifecycle(), '2026-09-08'), false);
    assert.equal(isResumable(lifecycle({ studyDate: '2026-09-06' }), '2026-09-07'), false);
  });

  it('refuses a session that is already closed', () => {
    assert.equal(isResumable(lifecycle({ status: 'completed' }), '2026-09-07'), false);
    assert.equal(isResumable(lifecycle({ status: 'abandoned' }), '2026-09-07'), false);
  });

  it('compares calendar days, not instants', () => {
    assert.equal(isSameStudyDay('2026-09-07', '2026-09-07T23:59:59.999Z'), true);
    assert.equal(isSameStudyDay('2026-09-07', '2026-09-08T00:00:00.000Z'), false);
  });
});

describe('closureStatus — what a stale in-progress row becomes', () => {
  it('abandons a partially answered session that went stale', () => {
    assert.equal(closureStatus(lifecycle({ answeredCount: 3 }), '2026-09-08'), 'abandoned');
  });

  it('leaves today’s micro session alone', () => {
    assert.equal(closureStatus(lifecycle({ answeredCount: 3 }), '2026-09-07'), 'in_progress');
  });

  it('abandons an unfinished timed session immediately — it can never resume', () => {
    assert.equal(
      closureStatus(lifecycle({ mode: 'timed', plannedCount: 25, answeredCount: 3 }), '2026-09-07'),
      'abandoned',
    );
  });

  it('completes a session that reached its count but never stamped an end', () => {
    // The app died between the last answer and the summary. Every attempt is
    // durable, so this is a finished set rather than an abandoned one.
    assert.equal(
      closureStatus(lifecycle({ plannedCount: 12, answeredCount: 12 }), '2026-09-09'),
      'completed',
    );
  });

  it('never reopens a session that is already closed', () => {
    assert.equal(closureStatus(lifecycle({ status: 'completed' }), '2026-09-09'), 'completed');
    assert.equal(closureStatus(lifecycle({ status: 'abandoned' }), '2026-09-09'), 'abandoned');
  });
});

/* ------------------------------------------------------- auto-submit */

describe('timed auto-submit — skips, never wrong answers', () => {
  const questions = [question(1), question(2), question(3), question(4), question(5)];

  it('commits every unanswered question as a skip', () => {
    const done = [attempt(1), attempt(2)];
    const pending = autoSubmitSkips(questions, done);

    assert.equal(pending.length, 3);
    assert.deepEqual(
      pending.map((p) => p.questionId),
      [3, 4, 5],
    );

    for (const item of pending) {
      // A skip IS `chosenIndex === null`. There is no separate flag.
      assert.equal(item.chosenIndex, null);
      assert.equal(item.correct, false);
      // Running out of time is not a guess either.
      assert.equal(item.guessed, false);
      // Read through the module that owns the classification, so the seam is
      // pinned rather than assumed: three outcomes, and this is the third.
      assert.equal(outcomeOf(item), 'skipped');
      assert.notEqual(outcomeOf(item), 'wrong');
    }
  });

  it('charges nothing: marking them wrong would cost 2/3 of a mark each', () => {
    const pending = autoSubmitSkips(questions, []);
    assert.equal(pending.length, 5);
    assert.equal(
      pending.filter((p) => outcomeOf(p) === 'wrong').length,
      0,
    );
  });

  it('has nothing to submit once the set is complete', () => {
    const done = questions.map((q) => attempt(q.questionId));
    assert.deepEqual(autoSubmitSkips(questions, done), []);
  });
});

/* ----------------------------------------------------------- machine */

describe('nextIndex — the position is derived, never stored', () => {
  const questions = [question(1), question(2), question(3), question(4)];

  it('starts at the first question', () => {
    assert.equal(nextIndex(questions, []), 0);
  });

  it('advances past every question that already has an attempt', () => {
    assert.equal(nextIndex(questions, [attempt(1)]), 1);
    assert.equal(nextIndex(questions, [attempt(1), attempt(2)]), 2);
    assert.equal(nextIndex(questions, [attempt(1), attempt(2), attempt(3)]), 3);
  });

  it('returns null at the end of the set', () => {
    const all = questions.map((q) => attempt(q.questionId));
    assert.equal(nextIndex(questions, all), null);
  });

  it('returns the first UNANSWERED position, not a count', () => {
    // Attempts arriving out of order cannot desynchronise the cursor, because
    // there is no cursor.
    assert.equal(nextIndex(questions, [attempt(3)]), 0);
    assert.equal(nextIndex(questions, [attempt(1), attempt(3)]), 1);
  });

  it('tracks answered ids as a set', () => {
    assert.deepEqual([...answeredIds([attempt(1), attempt(3)])], [1, 3]);
  });
});

describe('the advance machine', () => {
  const questions = [question(1), question(2), question(3)];
  const fresh = startMachine(questions, []);

  it('restores from what SQLite holds, never on a reveal', () => {
    assert.deepEqual(fresh, { index: 0, phase: 'answering', guessing: false });

    const resumed = startMachine(questions, [attempt(1), attempt(2)]);
    // A resumed micro session must not open on the previous question's answer.
    assert.deepEqual(resumed, { index: 2, phase: 'answering', guessing: false });

    const done = startMachine(questions, questions.map((q) => attempt(q.questionId)));
    assert.equal(done.phase, 'finished');
  });

  it('stops on the reveal in micro', () => {
    const after = commit({ ...fresh, guessing: true }, MICRO_PRESET, questions.length);
    assert.equal(after.phase, 'revealed');
    assert.equal(after.index, 0);
    // The flag survives into the reveal so the explanation can mention it.
    assert.equal(after.guessing, true);
  });

  it('moves straight on in timed, showing nothing', () => {
    const after = commit(fresh, TIMED_PRESET, questions.length);
    assert.equal(after.phase, 'answering');
    assert.equal(after.index, 1);
  });

  it('finishes on the last commit in timed', () => {
    const last = { index: 2, phase: 'answering' as const, guessing: false };
    assert.equal(commit(last, TIMED_PRESET, questions.length).phase, 'finished');
  });

  it('advances only on an explicit tap in micro, and resets the guess flag', () => {
    const revealed = commit({ ...fresh, guessing: true }, MICRO_PRESET, questions.length);
    const next = advance(revealed, questions.length);

    assert.deepEqual(next, { index: 1, phase: 'answering', guessing: false });
  });

  it('finishes rather than running off the end', () => {
    const last = { index: 2, phase: 'revealed' as const, guessing: false };
    const done = advance(last, questions.length);
    assert.equal(done.phase, 'finished');
    assert.equal(done.index, 2);
    // Idempotent: tapping again cannot walk past the end.
    assert.deepEqual(advance(done, questions.length), done);
    assert.deepEqual(commit(done, MICRO_PRESET, questions.length), done);
  });

  it('re-opens a finished micro set when it is extended', () => {
    const done = { index: 2, phase: 'finished' as const, guessing: false };
    assert.deepEqual(reopen(done, 5), { index: 3, phase: 'answering', guessing: false });
    // Only a finished machine re-opens; anything else is untouched.
    assert.deepEqual(reopen(fresh, 5), fresh);
  });

  it('toggles the guess flag without moving', () => {
    const guessing = toggleGuess(fresh);
    assert.equal(guessing.guessing, true);
    assert.equal(guessing.index, fresh.index);
    assert.equal(toggleGuess(guessing).guessing, false);
  });
});

/* ------------------------------------------------------------ commits */

describe('commitAnswer — the single place `correct` is decided', () => {
  const q = question(7, 2);

  it('marks a matching index correct and anything else wrong', () => {
    assert.equal(commitAnswer(q, 2, false, 30).correct, true);
    assert.equal(commitAnswer(q, 1, false, 30).correct, false);
  });

  it('records a skip as a null index, never as a wrong answer', () => {
    const skipped = skipAnswer(q, 12);
    assert.equal(skipped.chosenIndex, null);
    assert.equal(skipped.correct, false);
    assert.equal(outcomeOf(skipped), 'skipped');
  });

  it('treats an out-of-range index as a skip rather than inventing a wrong answer', () => {
    // Only reachable from a bug, and inventing a wrong answer out of a bug both
    // costs a mark and enrols the question in the re-drill queue.
    for (const bad of [-1, OPTION_COUNT, 99, 1.5]) {
      const pending = commitAnswer(q, bad, true, 30);
      assert.equal(pending.chosenIndex, null);
      assert.equal(pending.correct, false);
    }
  });

  it('never records a skip as a guess', () => {
    // Skips flagged as guesses would inflate the guess rate with the exact
    // decisions that prove she is not guessing.
    assert.equal(commitAnswer(q, null, true, 30).guessed, false);
    assert.equal(commitAnswer(q, 2, true, 30).guessed, true);
  });

  it('clamps the recorded duration on the way in as well', () => {
    assert.equal(commitAnswer(q, 2, false, 4000).timeTakenSec, MAX_QUESTION_SECONDS);
    assert.equal(commitAnswer(q, 2, false, Number.NaN).timeTakenSec, 0);
    assert.equal(commitAnswer(q, 2, false, -5).timeTakenSec, 0);
  });
});
