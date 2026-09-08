/**
 * Phase 3 cross-module integration.
 *
 * Four agents wrote `mcq-score`, `mcq-bank`, `mcq-select`, `mcq-redrill` and
 * `mcq-session` in parallel against one frozen vocabulary file. Each has its own
 * unit suite and each passes. What no unit suite can catch is a disagreement at
 * the SEAM — two modules that both typecheck and both behave correctly alone
 * while meaning different things by the same number.
 *
 * So this re-tests nothing internal. It wires the real modules together and
 * asserts the handoffs, the way `phase2-integration.test.ts` does.
 *
 * Nothing here touches SQLite or React Native: every module under test is pure,
 * which is exactly why they were separated from their repositories.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BREAK_EVEN_ACCURACY,
  ONE_ELIMINATION_ACCURACY,
  expectedMarks,
  resolveScheme,
  outcomeOf as scoreOutcomeOf,
  scoreSession,
} from '../src/lib/mcq-score';
import { planBankRefill, scoreSection, stemFingerprint } from '../src/lib/mcq-bank';
import { TIER_ORDER, isRepeatTier, selectForSession } from '../src/lib/mcq-select';
import { outcomeOf, redrillEffect } from '../src/lib/mcq-redrill';
import { applyReview, isDue } from '../src/lib/sm2';
import { MARKS, PRELIMS_PAPERS } from '../src/lib/mcq-types';
import type {
  AttemptRecord,
  SectionDemand,
  SessionFacts,
} from '../src/lib/mcq-types';
import type { SelectionCandidate } from '../src/lib/mcq-select';

const TODAY = '2026-11-16';

function session(over: Partial<SessionFacts> = {}): SessionFacts {
  return {
    sessionId: 1,
    mode: 'micro',
    status: 'completed',
    studyDate: TODAY,
    plannedCount: 10,
    markPerCorrect: MARKS.perCorrect,
    markPerWrong: MARKS.perWrong,
    ...over,
  };
}

function attempt(over: Partial<AttemptRecord> & { questionId: number }): AttemptRecord {
  return {
    chosenIndex: 0,
    correct: true,
    guessed: false,
    timeTakenSec: 40,
    attemptedAt: `${TODAY}T08:${String(over.questionId % 60).padStart(2, '0')}:00.000Z`,
    ...over,
  };
}

function candidate(over: Partial<SelectionCandidate> & { questionId: number }): SelectionCandidate {
  return {
    stem: `Consider the following statements about topic ${over.questionId}.`,
    options: ['1 only', '2 only', 'Both 1 and 2', 'Neither 1 nor 2'],
    correctIndex: 2,
    eliminationLogic: 'Statement 1 holds; statement 2 does not.',
    difficulty: 'medium',
    source: 'generated',
    pyqYear: null,
    pyqPaper: null,
    paper: 'gs2',
    sectionKey: 'gs2:Polity',
    sectionLabel: 'Polity',
    syllabusTopicId: 1,
    quarantined: false,
    priorAttempts: 0,
    lastCorrectAt: null,
    redrillDueAt: null,
    ...over,
  };
}

function section(over: Partial<SectionDemand> & { sectionKey: string }): SectionDemand {
  return {
    syllabusSlugs: [`${over.sectionKey}-slug`],
    paper: 'gs2',
    label: over.sectionKey,
    eligible: true,
    percentFirstPass: 50,
    attempted: 0,
    wrong: 0,
    unseenStock: 0,
    lastDrilledDay: null,
    ...over,
  };
}

describe('seam: the marking scheme is one number everywhere', () => {
  it('break-even is 25%, and that is derived rather than typed', () => {
    // The single identity that catches essentially every possible sign or
    // fraction error in the scoring code, asserted with NO epsilon. If a future
    // change needs a tolerance here, the change is wrong: 75 * (-2/3) rounds to
    // exactly -50 in IEEE-754, so this is exact arithmetic, not luck.
    assert.equal(BREAK_EVEN_ACCURACY, 0.25);
    assert.equal(expectedMarks(0.25), 0);

    const attempts: AttemptRecord[] = [];
    for (let i = 1; i <= 100; i += 1) {
      attempts.push(attempt({ questionId: i, chosenIndex: 0, correct: i <= 25 }));
    }
    const score = scoreSession(session({ plannedCount: 100 }), attempts);

    assert.equal(score.correct, 25);
    assert.equal(score.wrong, 75);
    assert.equal(score.netMarks, 0);
  });

  it('does not confuse break-even with the one-elimination target', () => {
    // 33.3% is the accuracy of a guess after ruling out one of four — the
    // TRAINABLE target, comfortably above break-even. Conflating the two would
    // teach her to skip questions that were worth answering.
    assert.notEqual(BREAK_EVEN_ACCURACY, ONE_ELIMINATION_ACCURACY);
    assert.ok(ONE_ELIMINATION_ACCURACY > BREAK_EVEN_ACCURACY);
    assert.ok(expectedMarks(ONE_ELIMINATION_ACCURACY) > 0);
  });

  it('survives the schema default, which is a transcription of -2/3', () => {
    // The stored default is the exact double for -2/3. A 4-decimal
    // transcription (-0.6667) scores 100 questions at 25% as -0.0025 rather
    // than 0 — near enough to look right and wrong enough to break the identity.
    const scheme = resolveScheme({ markPerCorrect: 2, markPerWrong: -0.6666666666666666 });
    assert.equal(scheme.perWrong, MARKS.perWrong);
    assert.equal(25 * scheme.perCorrect + 75 * scheme.perWrong, 0);
  });

  it('a skip is exactly zero and is not a wrong answer', () => {
    // Three outcomes, not two. Under negative marking, a skip mis-read as wrong
    // costs 0.667 marks in a figure nothing else would flag.
    const attempts = [
      attempt({ questionId: 1, chosenIndex: 0, correct: true }),
      attempt({ questionId: 2, chosenIndex: 1, correct: false }),
      attempt({ questionId: 3, chosenIndex: null, correct: false }),
    ];
    const score = scoreSession(session({ plannedCount: 3 }), attempts);

    assert.equal(score.correct, 1);
    assert.equal(score.wrong, 1);
    assert.equal(score.skipped, 1);
    assert.equal(score.netMarks, MARKS.perCorrect + MARKS.perWrong);

    assert.equal(outcomeOf({ chosenIndex: null, correct: false }), 'skipped');
    assert.equal(outcomeOf({ chosenIndex: 1, correct: false }), 'wrong');
  });
});

describe('seam: a drill outcome becomes a review schedule', () => {
  it('carries a wrong answer into the re-drill queue and back out again', () => {
    // THE SEAM. `mcq-redrill` owns the rule and is pure; `db/mcq-sessions.ts`
    // owns the write. If the two disagreed about what a grade means, the
    // schedule would move for reasons no attempt row explains.
    const wrong = redrillEffect('wrong', null, TODAY, 42);
    assert.equal(wrong.kind, 'insert');
    assert.equal(wrong.questionId, 42);
    assert.match(wrong.dueAt, /T00:00:00\.000Z$/, 'dueAt must be start-of-day');

    // A wrong answer is grade 2, so it must match what sm2's own suite asserts
    // for grade 2 — proving delegation rather than a second SM-2 living here.
    const direct = applyReview(
      { repetitions: 0, intervalDays: 0, easeFactor: 2.5, lapses: 0 },
      2,
      TODAY,
    );
    assert.equal(wrong.intervalDays, direct.intervalDays);
    assert.equal(wrong.easeFactor, direct.easeFactor);
    assert.equal(wrong.lapses, direct.lapses);
  });

  it('a skip enrols but never grades', () => {
    // A skip is a DECLINED recall, not a failed one. Grading skips as failures
    // would let one cautious commute drive every question in the bank toward
    // leech status.
    const fresh = redrillEffect('skipped', null, TODAY, 7);
    assert.equal(fresh.kind, 'insert');
    assert.equal(fresh.lapses, 0, 'a skip must never increment lapses');

    const mature = { repetitions: 4, intervalDays: 30, easeFactor: 2.3, lapses: 1 };
    const again = redrillEffect('skipped', mature, TODAY, 7);
    assert.equal(again.kind, 'none', 'an enrolled question is left exactly as it was');
  });

  it('a question due today is due from midnight, not from the hour it was graded', () => {
    // The date-boundary bug, at integration scale: a question graded at 22:00
    // and scheduled "+1 day" as a timestamp would be invisible through the
    // whole 08:00–10:00 morning block and appear at 22:00.
    const write = redrillEffect('wrong', null, '2026-11-16T22:00:00.000Z', 9);
    assert.equal(write.dueAt.slice(0, 10), '2026-11-17');
    assert.equal(isDue(write.dueAt, '2026-11-17'), true);
    assert.equal(isDue(write.dueAt, '2026-11-16'), false);
  });
});

describe('seam: the ladder never deals an empty drill while a question exists', () => {
  it('walks the tiers in order and marks repeats as repeats', () => {
    const candidates: SelectionCandidate[] = [
      // Tier 1: unseen, in the targeted section.
      candidate({ questionId: 1, sectionKey: 'gs2:Polity' }),
      // Tier 2: unseen, eligible but not targeted.
      candidate({ questionId: 2, sectionKey: 'gs3:Economy', paper: 'gs3' }),
      // Tier 3: a re-drill that is due.
      candidate({ questionId: 3, priorAttempts: 1, redrillDueAt: `${TODAY}T00:00:00.000Z` }),
      // Tier 4: answered correctly long ago.
      candidate({ questionId: 4, priorAttempts: 1, lastCorrectAt: '2026-09-01T08:00:00.000Z' }),
    ];

    const dealt = selectForSession({
      candidates,
      targetSectionKeys: ['gs2:Polity'],
      eligibleSectionKeys: ['gs2:Polity', 'gs3:Economy'],
      count: 4,
      todayIso: TODAY,
      preferPyq: false,
      seed: 1,
    });

    assert.equal(dealt.length, 4);
    assert.deepEqual(dealt.map((q) => q.tier), [...TIER_ORDER]);

    // Tiers 3 and 4 are repeats: a remembered answer is not a known one, so the
    // score module keeps them out of headline accuracy.
    assert.equal(isRepeatTier(dealt[2]!.tier), true);
    assert.equal(isRepeatTier(dealt[3]!.tier), true);
    assert.equal(isRepeatTier(dealt[0]!.tier), false);
  });

  it('excludes a quarantined question at every tier', () => {
    // A disputed key must stop being served IMMEDIATELY and offline. It cannot
    // be allowed to teach the false fact a second time through a lower tier.
    const quarantined = [
      candidate({ questionId: 1, quarantined: true }),
      candidate({ questionId: 2, quarantined: true, priorAttempts: 1, redrillDueAt: `${TODAY}T00:00:00.000Z` }),
      candidate({ questionId: 3, quarantined: true, priorAttempts: 1, lastCorrectAt: '2026-09-01T08:00:00.000Z' }),
    ];

    const dealt = selectForSession({
      candidates: quarantined,
      targetSectionKeys: ['gs2:Polity'],
      eligibleSectionKeys: ['gs2:Polity'],
      count: 10,
      todayIso: TODAY,
      preferPyq: false,
      seed: 1,
    });

    assert.deepEqual(dealt, [], 'no tier may serve a quarantined question');
  });

  it('returns an empty deal rather than throwing or repeating when genuinely dry', () => {
    const dealt = selectForSession({
      candidates: [],
      targetSectionKeys: [],
      eligibleSectionKeys: [],
      count: 10,
      todayIso: TODAY,
      preferPyq: false,
      seed: 1,
    });
    assert.deepEqual(dealt, []);
  });

  it('never deals the same question twice in one session', () => {
    const dealt = selectForSession({
      candidates: [candidate({ questionId: 1 }), candidate({ questionId: 2 })],
      targetSectionKeys: ['gs2:Polity'],
      eligibleSectionKeys: ['gs2:Polity'],
      count: 10,
      todayIso: TODAY,
      preferPyq: false,
      seed: 1,
    });
    assert.equal(new Set(dealt.map((q) => q.questionId)).size, dealt.length);
  });
});

describe('seam: the bank aims at studied weakness, and only at Prelims papers', () => {
  it('gives strictly more to her weakest studied section', () => {
    const sections: SectionDemand[] = [
      section({
        sectionKey: 'gs3:Economy',
        paper: 'gs3',
        percentFirstPass: 30,
        attempted: 20,
        wrong: 14,
      }),
      section({
        sectionKey: 'gs1:Art and Culture',
        paper: 'gs1',
        percentFirstPass: 85,
        attempted: 20,
        wrong: 2,
      }),
    ];

    const weak = scoreSection(sections[0]!, { asOfDay: TODAY });
    const strong = scoreSection(sections[1]!, { asOfDay: TODAY });

    // Assert on the SCORER, not on the quotas.
    //
    // Allocation is lossy by design: the 25%-per-section cap flattens the top
    // of a small board, so with two sections both land on the same count even
    // though their priorities differ by more than 2x. That is why `mcq-bank`
    // exports `scoreSection` separately — testing the aim only through
    // `planBankRefill` would pass with the scoring badly wrong, and the same
    // scorer is what `dealForSession` uses to pick tier-1 targets.
    assert.ok(
      weak.priority > strong.priority * 2,
      `weak ${weak.priority.toFixed(3)} must clearly outrank strong ${strong.priority.toFixed(3)}`,
    );

    // On a board wide enough for the cap not to bind, the aim shows through.
    const wide: SectionDemand[] = [
      ...sections,
      section({ sectionKey: 'gs2:Polity', percentFirstPass: 80, attempted: 20, wrong: 1 }),
      section({ sectionKey: 'gs2:Governance', percentFirstPass: 78, attempted: 20, wrong: 1 }),
      section({ sectionKey: 'gs1:Geography', paper: 'gs1', percentFirstPass: 82, attempted: 20, wrong: 1 }),
    ];
    const plan = planBankRefill({ sections: wide, asOfDay: TODAY, batchSize: 40 });
    const byKey = new Map(plan.quotas.map((q) => [q.sectionKey, q.count]));
    assert.ok(
      (byKey.get('gs3:Economy') ?? 0) > (byKey.get('gs2:Polity') ?? 0),
      'the batch must aim at the weaker section',
    );
  });

  it('gives zero to Anthropology even when it is the weakest board on the page', () => {
    // There is no Anthropology Prelims paper. Generating those would spend money
    // on questions she can never be examined on, and crowd out the three that
    // matter.
    const sections: SectionDemand[] = [
      section({
        sectionKey: 'anthro_p1:Kinship',
        paper: 'anthro_p1',
        percentFirstPass: 5,
        attempted: 30,
        wrong: 27,
      }),
      section({ sectionKey: 'gs2:Polity', paper: 'gs2', percentFirstPass: 70, attempted: 10, wrong: 2 }),
    ];

    const plan = planBankRefill({ sections, asOfDay: TODAY });
    const anthro = plan.quotas.filter((q) => q.sectionKey.startsWith('anthro'));
    assert.deepEqual(anthro, [], 'no Prelims-irrelevant paper may enter a plan');
    assert.ok(plan.quotas.length > 0, 'the eligible GS section still gets questions');
  });

  it('gives zero to a section she has never studied', () => {
    // Drilling unread material produces a 20% score and destroys trust in the
    // feature in week one.
    const sections: SectionDemand[] = [
      section({ sectionKey: 'gs1:Unread', eligible: false, percentFirstPass: 0 }),
      section({ sectionKey: 'gs2:Polity', percentFirstPass: 60, attempted: 8, wrong: 3 }),
    ];

    const plan = planBankRefill({ sections, asOfDay: TODAY });
    assert.deepEqual(
      plan.quotas.filter((q) => q.sectionKey === 'gs1:Unread'),
      [],
    );
  });

  it('plans exactly the batch size it was asked for', () => {
    // A plan that silently asks for 29 or 31 has arithmetic nothing can assert.
    const sections = ['gs1:A', 'gs2:B', 'gs3:C', 'gs1:D', 'gs2:E'].map((key, i) =>
      section({
        sectionKey: key,
        paper: key.split(':')[0]!,
        percentFirstPass: 20 + i * 12,
        attempted: 5 + i * 3,
        wrong: 4 - Math.min(i, 3),
      }),
    );

    for (const batchSize of [10, 30, 47]) {
      const plan = planBankRefill({ sections, asOfDay: TODAY, batchSize });
      const total = plan.quotas.reduce((sum, q) => sum + q.count, 0);
      assert.equal(total, batchSize, `quotas must sum to exactly ${batchSize}`);
    }
  });

  it('agrees with the drill about which papers are Prelims papers', () => {
    // Both modules read `PRELIMS_PAPERS` from the frozen vocabulary rather than
    // each keeping a list. This asserts the shared constant is what it claims.
    assert.deepEqual([...PRELIMS_PAPERS], ['gs1', 'gs2', 'gs3']);
  });
});

describe('seam: one commute, end to end', () => {
  it('deals, scores and schedules a ten-question drill consistently', () => {
    const candidates = Array.from({ length: 10 }, (_, i) =>
      candidate({ questionId: i + 1 }),
    );

    const dealt = selectForSession({
      candidates,
      targetSectionKeys: ['gs2:Polity'],
      eligibleSectionKeys: ['gs2:Polity'],
      count: 10,
      todayIso: TODAY,
      preferPyq: false,
      seed: 99,
    });
    assert.equal(dealt.length, 10);

    // Five right, three wrong, two skipped — an ordinary commute.
    const attempts = dealt.map((question, i) =>
      attempt({
        questionId: question.questionId,
        chosenIndex: i >= 8 ? null : i < 5 ? question.correctIndex : 0,
        correct: i < 5,
        guessed: i >= 5 && i < 8,
      }),
    );

    const score = scoreSession(session(), attempts);
    assert.equal(score.correct, 5);
    assert.equal(score.wrong, 3);
    assert.equal(score.skipped, 2);
    assert.equal(
      score.netMarks,
      5 * MARKS.perCorrect + 3 * MARKS.perWrong,
      'skips contribute nothing at all',
    );

    // Only the failures enrol. A first-time-correct answer deliberately does
    // NOT: the re-drill queue is for what she got wrong or declined, and tier 4
    // of the ladder already brings back correct answers after 21 days. Enrolling
    // everything would fill the queue with material she has demonstrated she
    // knows, and crowd out the questions that actually need another look.
    const writes = attempts.map((a) => ({
      outcome: outcomeOf(a),
      write: redrillEffect(outcomeOf(a), null, TODAY, a.questionId),
    }));

    const enrolled = writes.filter((w) => w.write.kind !== 'none');
    assert.equal(enrolled.length, 5, 'three wrong plus two skipped');
    assert.deepEqual(
      new Set(enrolled.map((w) => w.outcome)),
      new Set(['wrong', 'skipped']),
    );
    assert.equal(
      writes.filter((w) => w.write.lapses > 0).length,
      3,
      'only the three wrong answers count as lapses — a skip is a declined recall',
    );
  });

  it('an abandoned session still teaches, but never enters the trend', () => {
    // The `skippedOn` vs `watchedOn` distinction again: the event happened and
    // must not enter the rate. A 3-of-12 session is an interrupted commute, not
    // a 25% score.
    const attempts = [
      attempt({ questionId: 1, correct: true }),
      attempt({ questionId: 2, chosenIndex: 1, correct: false }),
      attempt({ questionId: 3, correct: true }),
    ];
    const score = scoreSession(
      session({ status: 'abandoned', plannedCount: 12 }),
      attempts,
    );

    assert.equal(score.scoreable, false);
    assert.ok(score.notScoreableReason);
    assert.equal(score.perAttempt.length, 3, 'the attempts still count for accuracy');
  });

  it('a disputed question scores zero and shrinks the paper', () => {
    // A bad key must not both teach a falsehood AND tell her she is worse than
    // she is.
    const attempts = [
      attempt({ questionId: 1, correct: true }),
      attempt({ questionId: 2, chosenIndex: 1, correct: false }),
    ];

    const clean = scoreSession(session({ plannedCount: 2 }), attempts);
    const disputed = scoreSession(session({ plannedCount: 2 }), attempts, [2]);

    assert.equal(disputed.excluded, 1);
    assert.equal(disputed.netMarks, MARKS.perCorrect, 'the disputed mark is voided');
    assert.ok(disputed.maxMarks < clean.maxMarks, 'the paper is scored out of one fewer');
  });
});

describe('seam: duplicate suppression', () => {
  it('collapses cosmetic differences but not genuine rewordings', () => {
    // The bank sends fingerprints to the server as an exclusion list and also
    // rejects on receipt. Collapsing too aggressively silently starves the
    // bank; collapsing too little fills it with repeats.
    const base = 'Consider the following statements about the Finance Commission.';
    assert.equal(
      stemFingerprint(base),
      stemFingerprint('  CONSIDER the following   statements about the Finance Commission!  '),
    );
    assert.notEqual(
      stemFingerprint(base),
      stemFingerprint('Which of the following describes the Finance Commission correctly?'),
    );
  });
});

describe('seam: the two outcome classifiers must never disagree', () => {
  it('agrees on every input, including the one no code path produces today', () => {
    // `outcomeOf` exists in BOTH `mcq-score` and `mcq-redrill`, and each file's
    // header claims to be the only place the three-way branch is written. They
    // are only actually the same rule if they agree on every input — and one
    // used `=== null` while the other used `=== null || === undefined`.
    //
    // Nothing constructs `chosenIndex: undefined` today (the column is nullable
    // rather than optional, and `commitAnswer` normalises to null), so the
    // divergence was invisible. But a fixture built with `Partial<AttemptRecord>`
    // would hit it, and the result would be an attempt that scores as a skip
    // while incrementing `lapses` as a wrong answer — breaking the invariant
    // both files state.
    const cases: { chosenIndex: number | null | undefined; correct: boolean }[] = [
      { chosenIndex: null, correct: false },
      { chosenIndex: undefined, correct: false },
      { chosenIndex: undefined, correct: true },
      { chosenIndex: 0, correct: true },
      { chosenIndex: 0, correct: false },
      { chosenIndex: 3, correct: false },
    ];

    for (const input of cases) {
      const attempt = input as unknown as Parameters<typeof outcomeOf>[0];
      assert.equal(
        scoreOutcomeOf(attempt),
        outcomeOf(attempt),
        `classifiers disagree on ${JSON.stringify(input)}`,
      );
    }
  });

  it('never grades a skip, however it was expressed', () => {
    for (const chosenIndex of [null, undefined]) {
      const attempt = { chosenIndex, correct: false } as unknown as Parameters<typeof outcomeOf>[0];
      assert.equal(outcomeOf(attempt), 'skipped');
      const write = redrillEffect('skipped', null, TODAY, 1);
      assert.equal(write.lapses, 0, 'a skip is a declined recall, never a failure');
    }
  });
});
