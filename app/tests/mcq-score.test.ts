/**
 * Marks and calibration tests.
 *
 * Organised by the bug each block exists to prevent rather than by function.
 * The arithmetic here is the arithmetic the whole Prelims half of the app rests
 * on: there is no second opinion anywhere in the codebase, no server-side
 * recomputation, and a sign error in it would be invisible on every screen.
 *
 * Every expected value below is hand-computed and written out longhand in a
 * comment. A test that asserts `score.netMarks === score.netMarks` proves
 * nothing, and the temptation to write one is strongest exactly here.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MARKS } from '../src/lib/mcq-types';
import type { AttemptRecord, SessionFacts } from '../src/lib/mcq-types';
import {
  BREAK_EVEN_ACCURACY,
  INSTRUMENT_MIN_ATTEMPTS,
  ONE_ELIMINATION_ACCURACY,
  breakEvenAccuracy,
  calibration,
  expectedMarks,
  netMarksTrend,
  outcomeOf,
  resolveScheme,
  scoreSession,
} from '../src/lib/mcq-score';

/* ------------------------------------------------------------- fixtures */

const AT = '2026-09-07T18:30:00.000Z';

function session(over: Partial<SessionFacts> = {}): SessionFacts {
  return {
    sessionId: 1,
    mode: 'micro',
    status: 'completed',
    studyDate: '2026-09-07',
    plannedCount: 10,
    markPerCorrect: MARKS.perCorrect,
    markPerWrong: MARKS.perWrong,
    ...over,
  };
}

let nextId = 1000;

function attempt(over: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    questionId: (nextId += 1),
    chosenIndex: 0,
    correct: false,
    guessed: false,
    timeTakenSec: 30,
    attemptedAt: AT,
    ...over,
  };
}

/** A right answer. */
const right = (over: Partial<AttemptRecord> = {}) =>
  attempt({ chosenIndex: 2, correct: true, ...over });

/** A wrong answer — she chose an option and it was not the key. */
const wrong = (over: Partial<AttemptRecord> = {}) =>
  attempt({ chosenIndex: 1, correct: false, ...over });

/** A SKIP. `chosenIndex === null` and nothing else. Never "correct". */
const skip = (over: Partial<AttemptRecord> = {}) =>
  attempt({ chosenIndex: null, correct: false, ...over });

function repeat(times_: number, make: () => AttemptRecord): AttemptRecord[] {
  return Array.from({ length: times_ }, make);
}

/* ------------------------------------------------------ three outcomes */

describe('three outcomes, not two', () => {
  it('scores a wrong answer at exactly −2/3', () => {
    const score = scoreSession(session(), [wrong()]);

    assert.equal(score.netMarks, -2 / 3);
    assert.equal(score.perAttempt[0].marks, -2 / 3);
    assert.equal(score.perAttempt[0].outcome, 'wrong');
    assert.equal(score.wrong, 1);
  });

  it('scores a correct answer at exactly +2', () => {
    const score = scoreSession(session(), [right()]);

    assert.equal(score.netMarks, 2);
    assert.equal(score.perAttempt[0].outcome, 'correct');
  });

  /**
   * THE most expensive bug available in this file.
   *
   * Collapsing a skip into a wrong answer invents a 0.667-mark penalty she
   * never incurred, in a figure nothing else on any screen contradicts.
   */
  it('scores a skip at exactly 0 — and NOT at −2/3', () => {
    const score = scoreSession(session(), [skip()]);

    assert.equal(score.netMarks, 0);
    assert.equal(score.perAttempt[0].marks, 0);
    assert.notEqual(score.perAttempt[0].marks, -2 / 3);
    assert.equal(score.perAttempt[0].outcome, 'skipped');
    assert.equal(score.skipped, 1);
    assert.equal(score.wrong, 0, 'a skip is not a wrong answer');
    assert.equal(score.answered, 0, 'a skip is not an answer');
  });

  it('separates the three outcomes in one session', () => {
    // 2 right, 1 wrong, 3 skipped:  2(2) + 1(−2/3) + 3(0) = 4 − 0.6667 = 3.3333
    const score = scoreSession(session(), [right(), right(), wrong(), skip(), skip(), skip()]);

    assert.equal(score.correct, 2);
    assert.equal(score.wrong, 1);
    assert.equal(score.skipped, 3);
    assert.equal(score.answered, 3);
    assert.equal(score.netMarks, 4 - 2 / 3);
  });

  it('reads a row claiming a correct skip as a skip, never as +2', () => {
    // Forbidden by the mcq_attempts_skip_not_correct CHECK, but a corrupt row
    // must not be paid 2 marks for a question that was never answered.
    assert.equal(outcomeOf({ chosenIndex: null, correct: true }), 'skipped');
    const score = scoreSession(session(), [skip({ correct: true })]);
    assert.equal(score.netMarks, 0);
    assert.equal(score.correct, 0);
  });
});

/* ------------------------------------------------- THE BREAK-EVEN IDENTITY */

describe('THE BREAK-EVEN IDENTITY', () => {
  /**
   * One line that catches essentially every possible sign or fraction error.
   *
   * A full Prelims paper answered at exactly the blind-guess rate is worth
   * exactly nothing:
   *
   *     25 × (+2)  +  75 × (−2/3)  =  50 − 50  =  0
   *
   * Flip a sign, use −1/3, use −0.67, collapse a skip into a wrong answer,
   * accumulate the total one row at a time — any of them moves this off zero.
   * `assert.equal` on a bare `0` is deliberate: no epsilon, no tolerance. If a
   * change here needs an epsilon to pass, the change is wrong.
   */
  it('100 questions, 25 correct, 75 wrong, 0 skipped → net exactly 0', () => {
    const attempts = [...repeat(25, () => right()), ...repeat(75, () => wrong())];
    const score = scoreSession(session({ plannedCount: 100 }), attempts);

    assert.equal(score.correct, 25);
    assert.equal(score.wrong, 75);
    assert.equal(score.skipped, 0);
    assert.equal(score.netMarks, 0);
    assert.equal(score.netPer100, 0);
  });

  it('holds with the rows interleaved, so it is not an artefact of ordering', () => {
    const attempts = Array.from({ length: 100 }, (_, i) => (i % 4 === 0 ? right() : wrong()));
    const score = scoreSession(session({ plannedCount: 100 }), attempts);

    assert.equal(score.correct, 25);
    assert.equal(score.netMarks, 0);
  });

  it('holds for a session frozen at the schema default of −0.6667', () => {
    // `mcq_sessions.mark_per_wrong` defaults to the four-decimal transcription
    // of −2/3. It is the same scheme, so break-even must still be exactly zero.
    const attempts = [...repeat(25, () => right()), ...repeat(75, () => wrong())];
    const score = scoreSession(session({ plannedCount: 100, markPerWrong: -0.6667 }), attempts);

    assert.equal(score.scheme.perWrong, -2 / 3);
    assert.equal(score.netMarks, 0);
  });

  it('honours a genuinely different frozen scheme rather than snapping it', () => {
    // −1/3 is a different marking scheme, not a rounding of −2/3.
    const score = scoreSession(session({ markPerWrong: -1 / 3 }), [wrong()]);
    assert.equal(score.scheme.perWrong, -1 / 3);
    assert.equal(score.netMarks, -1 / 3);
  });

  it('derives the break-even from the scheme, and it is 25% — not 1/3', () => {
    // EV(p) = 2p − (2/3)(1 − p) = (8/3)p − 2/3, zero at p = 1/4. Straight from
    // the MARKS comment in mcq-types.ts, which is frozen and authoritative.
    assert.equal(BREAK_EVEN_ACCURACY, 0.25);
    assert.equal(breakEvenAccuracy(MARKS), 0.25);
    assert.equal(expectedMarks(0.25), 0);
    assert.ok(expectedMarks(0.26) > 0, 'above 25% an attempt pays');
    assert.ok(expectedMarks(0.24) < 0, 'below 25% an attempt costs');

    // The 33.3% figure is the accuracy of a guess after ONE elimination. It is
    // the trainable target, comfortably above break-even — not the threshold.
    assert.notEqual(BREAK_EVEN_ACCURACY, ONE_ELIMINATION_ACCURACY);
    assert.ok(ONE_ELIMINATION_ACCURACY > BREAK_EVEN_ACCURACY);
  });
});

/* --------------------------------------------------- guess-bucket signs */

describe('guess bucket — break-even, and the sign of marksPer10', () => {
  /**
   * A guess made after eliminating one of four options lands 1 in 3.
   *
   *     12 flagged guesses, 4 right, 8 wrong
   *     4(2) + 8(−2/3) = 8 − 5.3333 = 2.6667 marks
   *     per 10 = 2.6667 / 12 × 10 = +2.2222
   *
   * POSITIVE. This is the whole lesson: eliminate one, then guess.
   */
  it('a 33.3% guess bucket is above break-even and marksPer10 is POSITIVE', () => {
    const attempts = [
      ...repeat(4, () => right({ guessed: true })),
      ...repeat(8, () => wrong({ guessed: true })),
    ];
    const result = calibration(attempts);
    const guessed = result.buckets.find((b) => b.key === 'answered_guessed')!;

    assert.equal(guessed.attempts, 12);
    assert.equal(guessed.accuracy, 1 / 3);
    assert.ok(Math.abs((guessed.accuracy ?? 0) - 0.333) < 0.001, 'the 33.3% bucket');
    assert.equal(guessed.aboveBreakEven, true);
    assert.ok((guessed.marksPer10 ?? 0) > 0, 'sign must be positive');
    assert.ok(Math.abs((guessed.marksPer10 ?? 0) - 2.2222) < 1e-4);
  });

  /**
   * A blind four-way guess: 5 right, 15 wrong out of 20.
   *
   *     5(2) + 15(−2/3) = 10 − 10 = 0 marks, exactly.
   */
  it('a 25% guess bucket is worth exactly nothing — marksPer10 is exactly 0', () => {
    const attempts = [
      ...repeat(5, () => right({ guessed: true })),
      ...repeat(15, () => wrong({ guessed: true })),
    ];
    const guessed = calibration(attempts).buckets.find((b) => b.key === 'answered_guessed')!;

    assert.equal(guessed.accuracy, 0.25);
    assert.equal(guessed.netMarks, 0);
    assert.equal(guessed.marksPer10, 0);
    assert.equal(guessed.aboveBreakEven, false, 'break-even is not ABOVE break-even');
  });

  /**
   * Guessing worse than chance: 4 right, 16 wrong out of 20 (20%).
   *
   *     4(2) + 16(−2/3) = 8 − 10.6667 = −2.6667
   *     per 10 = −1.3333.  NEGATIVE.
   */
  it('a 20% guess bucket has a NEGATIVE marksPer10', () => {
    const attempts = [
      ...repeat(4, () => right({ guessed: true })),
      ...repeat(16, () => wrong({ guessed: true })),
    ];
    const result = calibration(attempts);
    const guessed = result.buckets.find((b) => b.key === 'answered_guessed')!;

    assert.equal(guessed.accuracy, 0.2);
    assert.ok((guessed.marksPer10 ?? 0) < 0, 'sign must be negative');
    assert.ok(Math.abs((guessed.marksPer10 ?? 0) + 1.3333) < 1e-4);
    assert.equal(guessed.aboveBreakEven, false);
    assert.match(result.verdict, /below the 25% break-even/);
  });

  it('gives the skipped bucket no accuracy and no marks', () => {
    const skippedBucket = calibration([skip(), skip()]).buckets.find((b) => b.key === 'skipped')!;

    assert.equal(skippedBucket.attempts, 2);
    assert.equal(skippedBucket.accuracy, null, 'a skip has no accuracy');
    assert.equal(skippedBucket.netMarks, 0);
    assert.equal(skippedBucket.aboveBreakEven, null);
  });
});

/* ------------------------------------------------ netPer100 normalisation */

describe('netPer100 — the only cross-session comparable figure', () => {
  /**
   * A 10-question drill and a 25-question set on one axis.
   *
   *   10 questions: 5 right, 3 wrong, 2 skipped
   *       5(2) + 3(−2/3) = 10 − 2 = 8 marks over 10 → 80 per 100
   *   25 questions: 12 right, 6 wrong, 7 skipped
   *       12(2) + 6(−2/3) = 24 − 4 = 20 marks over 25 → 80 per 100
   *
   * Raw marks say 20 > 8 — a 2.5× gap. Normalised they are identical, which is
   * the point: the same argument as percent-normalising answer scores across
   * papers in db/answers.ts.
   */
  it('puts a 10-question drill and a 25-question set on the same axis', () => {
    const micro = scoreSession(session({ sessionId: 1, plannedCount: 10 }), [
      ...repeat(5, () => right()),
      ...repeat(3, () => wrong()),
      ...repeat(2, () => skip()),
    ]);
    const timed = scoreSession(session({ sessionId: 2, mode: 'timed', plannedCount: 25 }), [
      ...repeat(12, () => right()),
      ...repeat(6, () => wrong()),
      ...repeat(7, () => skip()),
    ]);

    assert.equal(micro.netMarks, 8);
    assert.equal(timed.netMarks, 20);
    assert.notEqual(micro.netMarks, timed.netMarks, 'raw marks are NOT comparable');

    assert.equal(micro.netPer100, 80);
    assert.equal(timed.netPer100, 80);
    assert.equal(micro.netPer100, timed.netPer100);
  });

  it('normalises over counted questions, so a dispute cannot drag it down', () => {
    // 5 right, 3 wrong, 1 wrong-but-disputed, 2 skipped = 11 rows, 10 counted.
    const bad = wrong();
    const score = scoreSession(
      session({ plannedCount: 11 }),
      [...repeat(5, () => right()), ...repeat(3, () => wrong()), bad, ...repeat(2, () => skip())],
      [bad.questionId],
    );

    assert.equal(score.counted, 10);
    assert.equal(score.netMarks, 8);
    assert.equal(score.netPer100, 80, 'identical to the clean 10-question session');
  });

  it('has no netPer100 when nothing countable was attempted', () => {
    assert.equal(scoreSession(session(), []).netPer100, null);
  });
});

/* ------------------------------------------------------ counterfactuals */

describe('counterfactual one — what the guesses cost', () => {
  /**
   * 2 flagged guesses, both wrong, alongside 4 confident right answers.
   *
   *     guesses actually scored 0(2) + 2(−2/3) = −1.3333
   *     skipping them would have scored 0
   *     delta = 0 − (−1.3333) = +1.3333 → "1.3 marks more"
   */
  it('prices the guesses in marks against having skipped them', () => {
    const score = scoreSession(session(), [
      ...repeat(4, () => right()),
      ...repeat(2, () => wrong({ guessed: true })),
    ]);
    const cf = score.counterfactuals.guessing;

    assert.equal(cf.guesses, 2);
    assert.equal(cf.correct, 0);
    assert.equal(cf.wrong, 2);
    assert.equal(cf.actualMarks, -4 / 3);
    assert.equal(cf.skippedMarks, 0);
    assert.equal(cf.deltaMarks, 4 / 3);
    assert.equal(cf.message, 'You guessed 2 times and got 0 right. Skipping those would have scored 1.3 marks more.');
  });

  /**
   * Guesses that paid: 3 flagged, 2 right, 1 wrong.
   *
   *     2(2) + 1(−2/3) = 4 − 0.6667 = +3.3333 actual
   *     delta = 0 − 3.3333 = −3.3333 → skipping would have COST her 3.3
   */
  it('says so when the guesses paid, rather than always preaching restraint', () => {
    const score = scoreSession(session(), [
      ...repeat(2, () => right({ guessed: true })),
      wrong({ guessed: true }),
    ]);
    const cf = score.counterfactuals.guessing;

    assert.equal(cf.actualMarks, 4 - 2 / 3);
    assert.equal(cf.deltaMarks, -(4 - 2 / 3));
    assert.match(cf.message, /would have cost you 3\.3 marks — those guesses paid/);
  });

  it('claims nothing about guesses she never made', () => {
    const cf = scoreSession(session(), [right(), wrong()]).counterfactuals.guessing;
    assert.equal(cf.guesses, 0);
    assert.equal(cf.deltaMarks, 0);
    assert.match(cf.message, /flagged no guesses/);
  });
});

describe('counterfactual two — what the skips forwent', () => {
  /**
   * 3 flagged guesses (1 right, 2 wrong) and 4 skips.
   *
   *     her own guess rate p = 1/3 = 33%
   *     EV per guess = 2(1/3) − (2/3)(2/3) = 0.6667 − 0.4444 = +0.2222
   *     4 skips × 0.2222 = +0.8889 → "+0.9"
   */
  it('prices the skips at her own guess rate, in marks', () => {
    const score = scoreSession(session(), [
      right({ guessed: true }),
      ...repeat(2, () => wrong({ guessed: true })),
      ...repeat(4, () => skip()),
    ]);
    const cf = score.counterfactuals.skipping;

    assert.equal(cf.skips, 4);
    assert.equal(cf.guessAccuracy, 1 / 3);
    assert.ok(Math.abs((cf.expectedMarksPerGuess ?? 0) - 2 / 9) < 1e-12);
    assert.ok(Math.abs((cf.deltaMarks ?? 0) - 8 / 9) < 1e-12);
    assert.equal(cf.message, 'You skipped 4. At your own guess rate of 33%, guessing would have been worth +0.9.');
  });

  /**
   * A guess rate below break-even makes the skips the right call.
   *
   *     4 flagged guesses, 0 right → p = 0
   *     EV per guess = −2/3;  3 skips × (−2/3) = −2.0
   */
  it('endorses the skips when her own rate is below break-even', () => {
    const score = scoreSession(session(), [
      ...repeat(4, () => wrong({ guessed: true })),
      ...repeat(3, () => skip()),
    ]);
    const cf = score.counterfactuals.skipping;

    assert.equal(cf.guessAccuracy, 0);
    assert.equal(cf.deltaMarks, -2);
    assert.match(cf.message, /guessing would have cost 2\.0 — the skips were right/);
  });

  it('is null, not zero, when she flagged no guesses at all', () => {
    const cf = scoreSession(session(), [right(), wrong(), skip()]).counterfactuals.skipping;

    assert.equal(cf.skips, 1);
    assert.equal(cf.guessAccuracy, null);
    assert.equal(cf.expectedMarksPerGuess, null);
    assert.equal(cf.deltaMarks, null, 'an unknown rate must not be reported as zero');
    assert.match(cf.message, /no rate of your own/);
  });
});

/* ----------------------------------------------------------- abandoned */

describe('abandoned sessions', () => {
  /**
   * A 3-of-12 session is an interrupted commute, not a 25% score. Its answers
   * are still the most expensive data this app collects, so `perAttempt` stays
   * complete — only the SCOREBOARD claim is withdrawn.
   */
  it('is not scoreable, while perAttempt stays fully populated', () => {
    const score = scoreSession(session({ status: 'abandoned', plannedCount: 12 }), [
      right(),
      wrong(),
      skip(),
    ]);

    assert.equal(score.scoreable, false);
    assert.ok(score.notScoreableReason);
    assert.match(score.notScoreableReason ?? '', /Abandoned at 3 of 12/);

    assert.equal(score.perAttempt.length, 3);
    assert.deepEqual(
      score.perAttempt.map((a) => a.outcome),
      ['correct', 'wrong', 'skipped'],
    );
    assert.equal(score.correct, 1);
    assert.equal(score.wrong, 1);
    assert.equal(score.skipped, 1);
    assert.equal(score.netMarks, 2 - 2 / 3, 'marks are still computed, just not claimed');
    assert.equal(score.attemptRate, 2 / 3);
    assert.equal(score.accuracy, 0.5);
  });

  it('is not scoreable while still in progress either', () => {
    const score = scoreSession(session({ status: 'in_progress' }), [right()]);
    assert.equal(score.scoreable, false);
    assert.match(score.notScoreableReason ?? '', /Still in progress/);
  });

  it('is kept out of the net-marks trend, which completed sessions still enter', () => {
    const done = scoreSession(session({ sessionId: 1, studyDate: '2026-09-05' }), [
      ...repeat(5, () => right()),
      ...repeat(3, () => wrong()),
      ...repeat(2, () => skip()),
    ]);
    const bailed = scoreSession(
      session({ sessionId: 2, status: 'abandoned', studyDate: '2026-09-06', plannedCount: 12 }),
      [wrong(), wrong(), wrong()],
    );
    const alsoDone = scoreSession(session({ sessionId: 3, studyDate: '2026-09-07' }), [
      ...repeat(12, () => right()),
      ...repeat(6, () => wrong()),
      ...repeat(7, () => skip()),
    ]);

    const points = netMarksTrend([alsoDone, bailed, done]);

    assert.deepEqual(
      points.map((p) => p.sessionId),
      [1, 3],
      'oldest-first, and the abandoned session is absent',
    );
    assert.deepEqual(
      points.map((p) => p.netPer100),
      [80, 80],
    );
  });

  it('every abandoned attempt still counts toward calibration', () => {
    // The lifetime view takes raw attempts and never sees a session status.
    const result = calibration([right(), wrong(), skip()]);
    assert.equal(result.total, 3);
    assert.equal(result.answered, 2);
    assert.equal(result.skipped, 1);
  });
});

/* ------------------------------------------------------------ disputes */

describe('disputed attempts', () => {
  /**
   * A bad key must not both teach a falsehood and tell her she is worse than
   * she is: the attempt scores zero AND leaves the denominator.
   */
  it('contributes 0 marks and reduces maxMarks', () => {
    const bad = wrong();
    const clean = [right(), right(), wrong()];
    const withDispute = scoreSession(session(), [...clean, bad], [bad.questionId]);
    const withoutIt = scoreSession(session(), clean);

    // 2(2) + 1(−2/3) = 3.3333 either way.
    assert.equal(withDispute.netMarks, withoutIt.netMarks);
    assert.equal(withDispute.netMarks, 4 - 2 / 3);

    assert.equal(withDispute.seen, 4);
    assert.equal(withDispute.counted, 3);
    assert.equal(withDispute.excluded, 1);
    assert.equal(withDispute.maxMarks, 6, '3 counted × 2, not 4 × 2');
    assert.equal(withoutIt.maxMarks, 6);

    const row = withDispute.perAttempt.find((a) => a.questionId === bad.questionId)!;
    assert.equal(row.excluded, true);
    assert.equal(row.marks, 0);
    assert.equal(row.outcome, 'wrong', 'the outcome is still recorded truthfully');
  });

  it('excludes a disputed correct answer too — a bad key cuts both ways', () => {
    const lucky = right();
    const score = scoreSession(session(), [right(), lucky], [lucky.questionId]);

    assert.equal(score.netMarks, 2);
    assert.equal(score.maxMarks, 2);
    assert.equal(score.correct, 1);
  });

  it('keeps disputed rows out of accuracy and out of the counterfactuals', () => {
    const bad = wrong({ guessed: true });
    const score = scoreSession(
      session(),
      [right(), wrong(), bad, skip()],
      [bad.questionId],
    );

    assert.equal(score.accuracy, 0.5, '1 of 2 counted answers');
    assert.equal(score.attemptRate, 2 / 3, '2 answered of 3 counted');
    assert.equal(score.counterfactuals.guessing.guesses, 0, 'a disputed guess is not evidence');
  });
});

/* ------------------------------------------------------------- repeats */

describe('repeats', () => {
  it('flags them and keeps them out of headline accuracy', () => {
    const seenBefore = right();
    const fresh = right();
    const missed = wrong();
    const priors = new Map<number, number>([[seenBefore.questionId, 2]]);

    const score = scoreSession(session(), [seenBefore, fresh, missed], [], priors);

    assert.equal(score.repeats, 1);
    assert.equal(score.perAttempt[0].repeat, true);
    assert.equal(score.perAttempt[0].priorAttempts, 2);
    assert.equal(score.perAttempt[1].repeat, false);

    // Headline: first sightings only — 1 right of 2. A remembered answer is
    // not a known one.
    assert.equal(score.accuracy, 0.5);
    // With repeats: 2 right of 3.
    assert.equal(score.accuracyWithRepeats, 2 / 3);
    // Marks are unaffected: she really did score them.
    assert.equal(score.netMarks, 4 - 2 / 3);
  });

  it('has no headline accuracy when every answer was a repeat', () => {
    const a = right();
    const b = wrong();
    const priors = new Map<number, number>([
      [a.questionId, 1],
      [b.questionId, 3],
    ]);
    const score = scoreSession(session(), [a, b], [], priors);

    assert.equal(score.accuracy, null);
    assert.equal(score.accuracyWithRepeats, 0.5);
  });
});

/* --------------------------------------------------------- attempt rate */

describe('attempt rate is first-class', () => {
  /**
   * Over-correcting into skipping everything is a real failure mode and is
   * completely invisible in an accuracy figure.
   */
  it('exposes the failure mode a 100% accuracy hides', () => {
    const score = scoreSession(session({ plannedCount: 20 }), [
      ...repeat(2, () => right()),
      ...repeat(18, () => skip()),
    ]);

    assert.equal(score.accuracy, 1, 'accuracy alone says she is perfect');
    assert.equal(score.attemptRate, 0.1, 'attempt rate says she answered one in ten');
    assert.equal(score.netMarks, 4);
    assert.equal(score.netPer100, 20, 'and 20 per 100 is what she would actually score');
  });

  it('flags over-correction in the lifetime calibration', () => {
    const result = calibration([...repeat(5, () => right()), ...repeat(45, () => skip())]);

    assert.equal(result.attemptRate, 0.1);
    assert.equal(result.overCorrecting, true);
    assert.match(result.verdict, /you attempted only 10% of what you saw/);
  });

  it('has no attempt rate at all with nothing on record', () => {
    assert.equal(scoreSession(session(), []).attemptRate, null);
    assert.equal(calibration([]).attemptRate, null);
  });
});

/* --------------------------------------------------- instrument trust */

describe('the instrument must know when it is broken', () => {
  /**
   * The "I'm guessing" flag is opt-in and will be under-reported: guessing
   * feels like knowing. If the answers she did NOT flag are barely better than
   * chance over a real sample, the flag is not measuring what it claims and
   * every bucket split by it is fiction.
   */
  it('distrusts itself when the confident bucket is only 50% right over 40 attempts', () => {
    const attempts = [
      ...repeat(20, () => right()), // confident, right
      ...repeat(20, () => wrong()), // confident, wrong  → 50% over 40
      ...repeat(6, () => right({ guessed: true })),
      ...repeat(4, () => wrong({ guessed: true })), // flagged guesses land 60%
    ];
    const result = calibration(attempts);

    assert.equal(result.confidentAccuracy, 0.5);
    assert.equal(result.buckets.find((b) => b.key === 'answered_confident')!.attempts, 40);
    assert.equal(result.instrumentTrusted, false);
    assert.ok(result.instrumentNote);
    assert.match(result.instrumentNote ?? '', /under-reported/);

    // And the verdict falls back: no claim is made about the guess bucket,
    // even though a flattering 60% one is sitting right there.
    assert.equal(result.verdictBasis, 'aggregate');
    assert.doesNotMatch(result.verdict, /flagged guesses/);
    assert.match(result.verdict, /You attempt 100% of what you see and land 52% of those/);
  });

  it('trusts itself when the confident bucket is 80% right over the same sample', () => {
    const attempts = [
      ...repeat(32, () => right()),
      ...repeat(8, () => wrong()), // 80% over 40
      ...repeat(6, () => right({ guessed: true })),
      ...repeat(4, () => wrong({ guessed: true })),
    ];
    const result = calibration(attempts);

    assert.equal(result.confidentAccuracy, 0.8);
    assert.equal(result.instrumentTrusted, true);
    assert.equal(result.verdictBasis, 'buckets');
    assert.match(result.verdict, /Your flagged guesses land 60%/);
  });

  it('does not cry broken on a small sample', () => {
    // 20 confident attempts at 50% is noise, not a broken instrument.
    const attempts = [
      ...repeat(10, () => right()),
      ...repeat(10, () => wrong()),
      ...repeat(2, () => right({ guessed: true })),
    ];
    const result = calibration(attempts);

    assert.ok(20 < INSTRUMENT_MIN_ATTEMPTS);
    assert.equal(result.confidentAccuracy, 0.5);
    assert.equal(result.instrumentTrusted, true);
    assert.equal(result.verdictBasis, 'buckets');
  });

  it('falls back to aggregate framing when she has flagged nothing at all', () => {
    const result = calibration([...repeat(7, () => right()), ...repeat(3, () => wrong())]);

    assert.equal(result.guessAccuracy, null);
    assert.equal(result.instrumentTrusted, true, 'unused is not the same as broken');
    assert.equal(result.verdictBasis, 'aggregate');
    assert.match(result.verdict, /land 70% of those/);
  });
});

/* ----------------------------------------------------------- scheme */

describe('resolveScheme', () => {
  it('falls back to the current scheme with no session', () => {
    assert.deepEqual(resolveScheme(), { ...MARKS });
  });

  it('survives a corrupt row rather than producing NaN marks', () => {
    const scheme = resolveScheme({ markPerCorrect: Number.NaN, markPerWrong: Number.NaN });
    assert.equal(scheme.perCorrect, MARKS.perCorrect);
    assert.equal(scheme.perWrong, MARKS.perWrong);
  });
});
