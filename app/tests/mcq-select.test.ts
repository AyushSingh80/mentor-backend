/**
 * Selection ladder tests.
 *
 * Organised by the promise each group defends. The promise the whole module
 * exists for is that **an empty drill is never rendered while a usable
 * question exists** — an empty screen at 07:45 on a train is indistinguishable
 * from a broken app, and it is what stops the habit. Most of what follows is
 * that promise stated four different ways, plus the one rule that outranks it:
 * a question whose key is in doubt is dealt by NO tier, at any level of
 * scarcity, because spaced repetition drills a falsehood to mastery.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  STALE_CORRECT_DAYS,
  TIER_ORDER,
  isRepeatTier,
  selectForSession,
  selectionReason,
  type SelectionCandidate,
  type SelectionRequest,
} from '../src/lib/mcq-select';
import { OPTION_COUNT, type SelectionTier } from '../src/lib/mcq-types';

const TODAY = '2026-09-08';

const TARGETED = 'gs1:Modern Indian History';
const ELIGIBLE_ONLY = 'gs2:Polity and Governance';
const NEVER_STUDIED = 'gs3:Internal Security';

const OPTIONS = ['First', 'Second', 'Third', 'Fourth'];

function candidate(
  questionId: number,
  overrides: Partial<SelectionCandidate> = {},
): SelectionCandidate {
  return {
    questionId,
    stem: `Question ${questionId}`,
    options: [...OPTIONS],
    correctIndex: 0,
    eliminationLogic: null,
    difficulty: 'medium',
    source: 'generated',
    pyqYear: null,
    pyqPaper: null,
    paper: 'gs1',
    sectionKey: TARGETED,
    sectionLabel: 'Modern Indian History',
    syllabusTopicId: 7,
    quarantined: false,
    priorAttempts: 0,
    lastCorrectAt: null,
    redrillDueAt: null,
    ...overrides,
  };
}

/** Unseen, in a section the refill aimed at. Tier 1. */
const tier1 = (id: number, over: Partial<SelectionCandidate> = {}) =>
  candidate(id, { sectionKey: TARGETED, ...over });

/** Unseen, in a studied section nobody aimed at. Tier 2. */
const tier2 = (id: number, over: Partial<SelectionCandidate> = {}) =>
  candidate(id, { sectionKey: ELIGIBLE_ONLY, paper: 'gs2', ...over });

/** Wrong once, re-drill due today. Tier 3. */
const tier3 = (id: number, dueAt = `${TODAY}T00:00:00.000Z`, over: Partial<SelectionCandidate> = {}) =>
  candidate(id, { sectionKey: ELIGIBLE_ONLY, priorAttempts: 1, redrillDueAt: dueAt, ...over });

/** Answered correctly long ago, never enrolled. Tier 4. */
const tier4 = (id: number, lastCorrectAt = '2026-07-01T09:00:00.000Z', over: Partial<SelectionCandidate> = {}) =>
  candidate(id, { sectionKey: ELIGIBLE_ONLY, priorAttempts: 1, lastCorrectAt, ...over });

function request(
  candidates: SelectionCandidate[],
  over: Partial<SelectionRequest> = {},
): SelectionRequest {
  return {
    candidates,
    targetSectionKeys: [TARGETED],
    eligibleSectionKeys: [TARGETED, ELIGIBLE_ONLY],
    count: 10,
    todayIso: TODAY,
    preferPyq: false,
    seed: 1,
    ...over,
  };
}

const tiersOf = (questions: { tier: SelectionTier }[]) => questions.map((q) => q.tier);
const idsOf = (questions: { questionId: number }[]) => questions.map((q) => q.questionId);

/* -------------------------------------------------------------- the ladder */

describe('the four tiers are walked in order', () => {
  const oneOfEach = [tier4(40), tier3(30), tier2(20), tier1(10)];

  it('deals tier 1, then 2, then 3, then 4', () => {
    // Deliberately supplied in reverse, so the result reflects the ladder and
    // not the order the rows happened to arrive in.
    const dealt = selectForSession(request(oneOfEach, { count: 4 }));
    assert.deepEqual(tiersOf(dealt), [...TIER_ORDER]);
    assert.deepEqual(idsOf(dealt), [10, 20, 30, 40]);
  });

  it('exhausts tier 1 before touching tier 2', () => {
    const dealt = selectForSession(
      request([tier1(11), tier1(12), tier1(13), tier2(21)], { count: 3 }),
    );
    assert.deepEqual(tiersOf(dealt), ['unseen_targeted', 'unseen_targeted', 'unseen_targeted']);
  });

  it('relaxes targeting before it relaxes freshness', () => {
    // An unseen question from the wrong section still teaches something new;
    // a repeat dressed up as new does not.
    const dealt = selectForSession(request([tier3(30), tier2(20)], { count: 1 }));
    assert.deepEqual(tiersOf(dealt), ['unseen_any']);
  });

  it('falls through to the re-drill tier when no unseen stock is left', () => {
    const dealt = selectForSession(request([tier4(40), tier3(30)], { count: 2 }));
    assert.deepEqual(tiersOf(dealt), ['redrill_due', 'stale_correct']);
  });

  it('deals the last tier rather than nothing', () => {
    // The whole promise of the ladder: something usable exists, so something
    // usable is shown.
    const dealt = selectForSession(request([tier4(40)], { count: 5 }));
    assert.deepEqual(tiersOf(dealt), ['stale_correct']);
  });

  it('never exceeds the requested count', () => {
    const many = Array.from({ length: 40 }, (_, i) => tier1(100 + i));
    assert.equal(selectForSession(request(many, { count: 12 })).length, 12);
  });
});

/* ------------------------------------------------------------- quarantine */

describe('a disputed question is dealt by NO tier', () => {
  it('excludes it at every one of the four tiers', () => {
    // Each case supplies exactly one candidate, so a leak cannot hide behind
    // another tier having filled the deal.
    const cases: [SelectionTier, SelectionCandidate][] = [
      ['unseen_targeted', tier1(10, { quarantined: true })],
      ['unseen_any', tier2(20, { quarantined: true })],
      ['redrill_due', tier3(30, `${TODAY}T00:00:00.000Z`, { quarantined: true })],
      ['stale_correct', tier4(40, '2026-06-01T09:00:00.000Z', { quarantined: true })],
    ];

    for (const [tier, only] of cases) {
      assert.deepEqual(
        selectForSession(request([only], { count: 10 })),
        [],
        `a quarantined question leaked through tier ${tier}`,
      );
    }
  });

  it('excludes it even when the bank has nothing else at all', () => {
    // Scarcity is never a reason to show it. Running dry is the better
    // failure: showing a wrong key teaches the falsehood a second time.
    const allDisputed = [
      tier1(10, { quarantined: true }),
      tier2(20, { quarantined: true }),
      tier3(30, `${TODAY}T00:00:00.000Z`, { quarantined: true }),
      tier4(40, '2026-06-01T09:00:00.000Z', { quarantined: true }),
    ];
    assert.deepEqual(selectForSession(request(allDisputed, { count: 20 })), []);
  });

  it('deals its neighbours normally', () => {
    const dealt = selectForSession(
      request([tier1(10, { quarantined: true }), tier1(11), tier1(12)], { count: 10 }),
    );
    // Sorted: within a tier the order is the seeded shuffle, and this test is
    // about which questions survive the filter, not about their order.
    assert.deepEqual([...idsOf(dealt)].sort(), [11, 12]);
  });
});

/* --------------------------------------------------------------- no repeats */

describe('no question appears twice in one session', () => {
  it('deals a question that qualifies for two tiers only once', () => {
    // Due for re-drill AND last answered correctly three months ago.
    const both = tier3(30, `${TODAY}T00:00:00.000Z`, {
      lastCorrectAt: '2026-06-01T09:00:00.000Z',
    });
    const dealt = selectForSession(request([both], { count: 10 }));
    assert.equal(dealt.length, 1);
    assert.deepEqual(tiersOf(dealt), ['redrill_due'], 'the higher tier should claim it');
  });

  it('deals a question that qualifies for both unseen tiers only once', () => {
    // A targeted section is also an eligible one, so every tier-1 candidate is
    // a tier-2 candidate too. Without the dedup the deal would be doubled.
    const dealt = selectForSession(request([tier1(10), tier1(11)], { count: 10 }));
    assert.deepEqual([...idsOf(dealt)].sort(), [10, 11]);
  });

  it('survives the same row arriving twice from a fanned-out join', () => {
    const dealt = selectForSession(request([tier1(10), tier1(10), tier1(10)], { count: 10 }));
    assert.deepEqual(idsOf(dealt), [10]);
  });

  it('holds across a full-size deal from a mixed bank', () => {
    const bank = [
      ...Array.from({ length: 15 }, (_, i) => tier1(100 + i)),
      ...Array.from({ length: 15 }, (_, i) => tier2(200 + i)),
      ...Array.from({ length: 15 }, (_, i) => tier3(300 + i, `2026-09-0${(i % 8) + 1}T00:00:00.000Z`)),
      ...Array.from({ length: 15 }, (_, i) => tier4(400 + i, `2026-0${(i % 6) + 1}-15T09:00:00.000Z`)),
    ];
    const dealt = selectForSession(request(bank, { count: 60 }));
    assert.equal(new Set(idsOf(dealt)).size, dealt.length);
    assert.equal(dealt.length, 60);
  });
});

/* ----------------------------------------------------------------- repeats */

describe('repeats are labelled so the score agent can exclude them', () => {
  it('flags every tier 3 and tier 4 question as a repeat', () => {
    const dealt = selectForSession(request([tier1(10), tier2(20), tier3(30), tier4(40)]));
    for (const question of dealt) {
      if (isRepeatTier(question.tier)) {
        assert.ok(question.priorAttempts > 0, `${question.tier} was not flagged as a repeat`);
      } else {
        assert.equal(question.priorAttempts, 0);
      }
    }
  });

  it('forces the flag even when the attempt aggregate disagrees', () => {
    // Structural rather than trusted: a repeat rendering as new would quietly
    // count toward headline accuracy, and a remembered answer is not a known
    // one. A re-drill enrolment is independent evidence she has seen it, so
    // the question is not dealt as unseen even though the aggregate says zero.
    const inconsistent = tier3(30, `${TODAY}T00:00:00.000Z`, { priorAttempts: 0 });
    const [dealt] = selectForSession(request([inconsistent], { count: 1 }));
    assert.equal(dealt!.tier, 'redrill_due');
    assert.ok(dealt!.priorAttempts > 0);
  });

  it('preserves a real prior count rather than flattening it to one', () => {
    const seenFiveTimes = tier4(40, '2026-06-01T09:00:00.000Z', { priorAttempts: 5 });
    const [dealt] = selectForSession(request([seenFiveTimes], { count: 1 }));
    assert.equal(dealt!.priorAttempts, 5);
  });
});

/* ------------------------------------------------------------- eligibility */

describe('a section she has never studied is never drilled', () => {
  it('excludes it from both unseen tiers', () => {
    const unstudied = candidate(50, { sectionKey: NEVER_STUDIED, paper: 'gs3' });
    assert.deepEqual(selectForSession(request([unstudied], { count: 10 })), []);
  });

  it('excludes it even when the deal would otherwise be empty', () => {
    // Being drilled on material the app knows she has not reached reads as the
    // app not knowing where she is, which is the trust this feature runs on.
    const unstudied = Array.from({ length: 20 }, (_, i) =>
      candidate(50 + i, { sectionKey: NEVER_STUDIED, paper: 'gs3' }),
    );
    assert.deepEqual(selectForSession(request(unstudied, { count: 20 })), []);
  });

  it('still deals a due re-drill from any section', () => {
    // She has already attempted it, so "material you have not reached" cannot
    // apply — and withholding a correction she has earned is strictly worse.
    const dueElsewhere = tier3(30, `${TODAY}T00:00:00.000Z`, {
      sectionKey: NEVER_STUDIED,
      paper: 'gs3',
    });
    assert.deepEqual(tiersOf(selectForSession(request([dueElsewhere], { count: 5 }))), [
      'redrill_due',
    ]);
  });

  it('deals nothing unseen before the first topic reaches first pass', () => {
    const dealt = selectForSession(
      request([tier1(10), tier2(20)], { eligibleSectionKeys: [], count: 10 }),
    );
    assert.deepEqual(dealt, []);
  });

  it('starts at tier 2 when nothing is targeted', () => {
    const dealt = selectForSession(
      request([tier1(10), tier2(20)], { targetSectionKeys: [], count: 10 }),
    );
    assert.deepEqual(tiersOf(dealt), ['unseen_any', 'unseen_any']);
  });
});

/* ------------------------------------------------------------ tier 3 and 4 */

describe('the re-drill tier', () => {
  it('takes the most overdue first', () => {
    const dealt = selectForSession(
      request(
        [
          tier3(31, '2026-09-08T00:00:00.000Z'),
          tier3(32, '2026-09-01T00:00:00.000Z'),
          tier3(33, '2026-09-05T00:00:00.000Z'),
        ],
        { count: 3 },
      ),
    );
    assert.deepEqual(idsOf(dealt), [32, 33, 31]);
  });

  it('ignores a re-drill that is not due yet', () => {
    const notYet = tier3(30, '2026-09-20T00:00:00.000Z');
    assert.deepEqual(selectForSession(request([notYet], { count: 5 })), []);
  });

  it('includes one due exactly today', () => {
    const dealt = selectForSession(request([tier3(30, `${TODAY}T00:00:00.000Z`)], { count: 5 }));
    assert.deepEqual(idsOf(dealt), [30]);
  });
});

describe('the stale-correct tier', () => {
  it('takes the oldest correct answer first', () => {
    const dealt = selectForSession(
      request(
        [
          tier4(41, '2026-08-01T09:00:00.000Z'),
          tier4(42, '2026-05-01T09:00:00.000Z'),
          tier4(43, '2026-07-01T09:00:00.000Z'),
        ],
        { count: 3 },
      ),
    );
    assert.deepEqual(idsOf(dealt), [42, 43, 41]);
  });

  it('waits the full three weeks', () => {
    const dayBefore = new Date(
      Date.parse(`${TODAY}T00:00:00.000Z`) - (STALE_CORRECT_DAYS - 1) * 86_400_000,
    ).toISOString();
    const exactly = new Date(
      Date.parse(`${TODAY}T00:00:00.000Z`) - STALE_CORRECT_DAYS * 86_400_000,
    ).toISOString();

    assert.deepEqual(selectForSession(request([tier4(41, dayBefore)], { count: 5 })), []);
    assert.deepEqual(idsOf(selectForSession(request([tier4(42, exactly)], { count: 5 }))), [42]);
  });

  it('leaves an enrolled question to its own SM-2 schedule', () => {
    // Answered correctly in June but enrolled and not due until October.
    // Pulling it early would silently override the interval SM-2 computed.
    const enrolledNotDue = tier4(40, '2026-06-01T09:00:00.000Z', {
      redrillDueAt: '2026-10-20T00:00:00.000Z',
    });
    assert.deepEqual(selectForSession(request([enrolledNotDue], { count: 5 })), []);
  });

  it('never deals a question that was never answered correctly', () => {
    const neverRight = candidate(60, { priorAttempts: 3, lastCorrectAt: null });
    assert.deepEqual(selectForSession(request([neverRight], { count: 5 })), []);
  });
});

/* ---------------------------------------------------------- PYQ preference */

describe('past questions lead a timed set and not a micro drill', () => {
  const pyqs = Array.from({ length: 2 }, (_, i) =>
    tier1(70 + i, { source: 'pyq', pyqYear: 2019 + i, pyqPaper: 'GS Paper I' }),
  );
  const generated = Array.from({ length: 10 }, (_, i) => tier1(80 + i));
  const bank = [...pyqs, ...generated];

  /** The same bank with the provenance erased, to isolate its effect. */
  const sourceless = bank.map((c) => ({ ...c, source: 'generated' as const, pyqYear: null }));

  it('deals past questions first when preferPyq is set', () => {
    // A timed set is a measurement, and a real paper's distractors were
    // written to catch the mistakes candidates actually make.
    const dealt = selectForSession(request(bank, { count: 2, preferPyq: true, seed: 7 }));
    assert.deepEqual(
      dealt.map((q) => q.source),
      ['pyq', 'pyq'],
    );
  });

  it('ignores provenance entirely in a micro drill', () => {
    // The exact statement of the rule: with `preferPyq` false the deal is the
    // seeded order and nothing else, so erasing every `source` cannot change
    // it. A commute drill is for coverage, where the generated bank's breadth
    // is the point and a PYQ bias would re-serve the same small pool.
    for (const seed of [1, 2, 7, 12345]) {
      assert.deepEqual(
        idsOf(selectForSession(request(bank, { count: 12, preferPyq: false, seed }))),
        idsOf(selectForSession(request(sourceless, { count: 12, preferPyq: false, seed }))),
        `micro ordering changed with the source at seed ${seed}`,
      );
    }
  });

  it('leaves the past questions mid-pack in a micro drill', () => {
    // The concrete difference the rule above buys, at a seed where the two
    // orders visibly diverge.
    const timed = idsOf(selectForSession(request(bank, { count: 12, preferPyq: true, seed: 7 })));
    const micro = idsOf(selectForSession(request(bank, { count: 12, preferPyq: false, seed: 7 })));
    assert.deepEqual(timed.slice(0, 2), [70, 71]);
    assert.notDeepEqual(micro.slice(0, 2), [70, 71]);
    assert.deepEqual([...micro].sort(), [...timed].sort(), 'the same questions, differently ordered');
  });

  it('still fills the deal from generated questions once the PYQs run out', () => {
    const dealt = selectForSession(request(bank, { count: 6, preferPyq: true, seed: 7 }));
    assert.equal(dealt.length, 6);
    assert.equal(dealt.filter((q) => q.source === 'pyq').length, 2);
  });
});

/* ------------------------------------------------------------ determinism */

describe('the deal is deterministic', () => {
  const bank = Array.from({ length: 30 }, (_, i) => tier1(100 + i));

  it('gives the same deal twice for the same seed', () => {
    const first = idsOf(selectForSession(request(bank, { count: 10, seed: 12345 })));
    const second = idsOf(selectForSession(request(bank, { count: 10, seed: 12345 })));
    assert.deepEqual(first, second);
  });

  it('gives a different deal for a different seed', () => {
    const a = idsOf(selectForSession(request(bank, { count: 10, seed: 1 })));
    const b = idsOf(selectForSession(request(bank, { count: 10, seed: 2 })));
    assert.notDeepEqual(a, b);
  });

  it('does not depend on the order the rows arrived in', () => {
    // The deal is a function of the seed and the ids, so a change to the
    // repository's ORDER BY cannot silently change what she is drilled on.
    const forwards = idsOf(selectForSession(request(bank, { count: 10, seed: 7 })));
    const backwards = idsOf(selectForSession(request([...bank].reverse(), { count: 10, seed: 7 })));
    assert.deepEqual(forwards, backwards);
  });

  it('does not always deal the lowest ids, which would starve the newest batch', () => {
    const dealt = idsOf(selectForSession(request(bank, { count: 10, seed: 7 })));
    assert.notDeepEqual(dealt, [...dealt].sort((a, b) => a - b));
  });

  it('does not mutate the candidate list it was given', () => {
    const original = idsOf(bank);
    selectForSession(request(bank, { count: 10 }));
    assert.deepEqual(idsOf(bank), original);
  });
});

/* ------------------------------------------------------------ running dry */

describe('running dry returns an empty deal rather than throwing', () => {
  it('handles an empty bank', () => {
    assert.deepEqual(selectForSession(request([])), []);
  });

  it('handles a nonsensical count', () => {
    for (const count of [0, -5, Number.NaN, Number.POSITIVE_INFINITY * 0]) {
      assert.deepEqual(selectForSession(request([tier1(10)], { count })), []);
    }
  });

  it('deals everything it has when asked for more than exists', () => {
    const dealt = selectForSession(request([tier1(10), tier2(20)], { count: 500 }));
    assert.equal(dealt.length, 2);
  });

  it('drops a question with the wrong number of options', () => {
    // A three-option question renders a broken pad.
    const short = tier1(10, { options: ['One', 'Two', 'Three'] });
    const long = tier1(11, { options: [...OPTIONS, 'Fifth'] });
    assert.deepEqual(selectForSession(request([short, long], { count: 5 })), []);
    assert.equal(OPTION_COUNT, 4);
  });

  it('drops a question with a blank option or an out-of-range key', () => {
    const blank = tier1(10, { options: ['One', '   ', 'Three', 'Four'] });
    const offEnd = tier1(11, { correctIndex: 4 });
    const negative = tier1(12, { correctIndex: -1 });
    assert.deepEqual(selectForSession(request([blank, offEnd, negative], { count: 5 })), []);
  });

  it('never throws on a malformed stored date', () => {
    const rubbish = [
      tier3(30, 'not a date'),
      tier4(40, ''),
      tier4(41, 'garbage'),
      tier1(10),
    ];
    assert.doesNotThrow(() => selectForSession(request(rubbish, { count: 10 })));
    assert.doesNotThrow(() => selectForSession(request(rubbish, { todayIso: 'nonsense' })));
    // The one good candidate still gets dealt.
    assert.deepEqual(idsOf(selectForSession(request(rubbish, { count: 10 }))), [10]);
  });
});

/* ----------------------------------------------------------------- reason */

describe('the deal explains itself', () => {
  it('names each tier and how many it contributed', () => {
    const dealt = selectForSession(request([tier1(10), tier1(11), tier3(30)], { count: 3 }));
    assert.equal(
      selectionReason(dealt),
      '2 new in your weak sections, 1 due for re-drill',
    );
  });

  it('orders the sentence by the ladder rather than by size', () => {
    const dealt = selectForSession(
      request([tier1(10), tier3(31), tier3(32), tier3(33)], { count: 4 }),
    );
    assert.match(selectionReason(dealt), /^1 new in your weak sections, 3 due for re-drill$/);
  });

  it('says so when there was nothing to deal', () => {
    assert.equal(selectionReason([]), 'nothing available');
  });
});

describe('past questions from sections she has not started', () => {
  const UNSTUDIED = 'gs2:Polity and Governance';

  function pyq(id: number) {
    return candidate(id, {
      sectionKey: UNSTUDIED,
      source: 'pyq',
      pyqYear: 2023,
      pyqPaper: 'Prelims GS-I',
    });
  }

  it('deals them in a timed set', () => {
    // Without this, importing two thousand real past questions deals exactly
    // zero of them until every section has been opened — one topic is touched
    // today. Tiers 3 and 4 cannot rescue it either: both require a prior
    // attempt, which an unseen question does not have.
    const dealt = selectForSession(
      request([pyq(1), pyq(2), pyq(3)], {
        eligibleSectionKeys: [],
        targetSectionKeys: [],
        count: 3,
        preferPyq: true,
        allowUnstudiedPyq: true,
      }),
    );
    assert.equal(dealt.length, 3, 'a measured set must be able to use real past questions');
  });

  it('does NOT deal them in a micro drill', () => {
    // The eligibility gate exists because drilling a section she has never
    // opened destroys trust. That argument holds in full for a micro drill,
    // which is for consolidating studied material rather than measuring.
    const dealt = selectForSession(
      request([pyq(1), pyq(2)], {
        eligibleSectionKeys: [],
        targetSectionKeys: [],
        count: 2,
        preferPyq: false,
        allowUnstudiedPyq: false,
      }),
    );
    assert.equal(dealt.length, 0);
  });

  it('does not relax the gate for GENERATED questions, even in a timed set', () => {
    // A generated key is a model's guess. The relaxation is specifically about
    // a past paper, whose key is UPSC's.
    const dealt = selectForSession(
      request([candidate(1, { sectionKey: UNSTUDIED }), candidate(2, { sectionKey: UNSTUDIED })], {
        eligibleSectionKeys: [],
        targetSectionKeys: [],
        count: 2,
        preferPyq: true,
        allowUnstudiedPyq: true,
      }),
    );
    assert.equal(dealt.length, 0);
  });

  it('keeps today’s behaviour when the flag is absent', () => {
    // Every existing caller omits it. Absent must read as false.
    const dealt = selectForSession(
      request([pyq(1)], { eligibleSectionKeys: [], targetSectionKeys: [], count: 1 }),
    );
    assert.equal(dealt.length, 0);
  });
});
