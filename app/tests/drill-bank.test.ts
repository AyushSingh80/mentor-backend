/**
 * The drill prompt bank and its refill gate.
 *
 * The property worth more than the rest: a bank that is stocked in TOTAL but
 * empty of one kind must still refill. She drills whichever the morning calls
 * for, and "twelve essay topics and no ethics cases" is not a stocked bank — a
 * total would report it as one, which is the bug this file exists to prevent.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  bankStock,
  labelOf,
  refillTargets,
  shouldRefillPrompts,
  type BankStock,
  type RefillGate,
} from '../src/lib/drill-bank';
import { DRILL_KINDS, DRILL_RULES } from '../src/lib/drill-types';

const NOW = '2026-09-07T08:00:00.000Z';

function stock(
  essay: number,
  ethics: number,
  overrides: Partial<Parameters<typeof bankStock>[0]> = {},
): BankStock {
  return bankStock({
    counts: [
      { kind: 'essay_outline', banked: essay, inProgress: 0 },
      { kind: 'ethics_case', banked: ethics, inProgress: 0 },
    ],
    lastRefillAttemptAt: null,
    ...overrides,
  });
}

function gate(overrides: Partial<RefillGate> = {}): RefillGate {
  return {
    stock: stock(2, 2),
    trigger: 'auto',
    now: NOW,
    spendCapAllows: true,
    refillInFlight: false,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ stock */

describe('bankStock', () => {
  it('reports every kind, including ones with no rows at all', () => {
    // A kind missing from the counts is a kind with nothing banked, not a kind
    // that does not exist. Omitting it would hide an empty bank.
    const empty = bankStock({ counts: [], lastRefillAttemptAt: null });
    assert.deepEqual(
      empty.kinds.map((entry) => entry.kind),
      [...DRILL_KINDS],
    );
    assert.equal(empty.totalBanked, 0);
    assert.equal(empty.belowLowWater, true);
  });

  it('is below low water when ANY kind is short, not when the total is', () => {
    const lopsided = stock(DRILL_RULES.targetBankedPrompts, 0);
    assert.ok(lopsided.totalBanked > DRILL_RULES.lowWaterPrompts);
    assert.equal(lopsided.belowLowWater, true, 'no ethics cases is not a stocked bank');
  });

  it('is above low water only when both kinds are', () => {
    const both = stock(DRILL_RULES.lowWaterPrompts, DRILL_RULES.lowWaterPrompts);
    assert.equal(both.belowLowWater, false);
  });

  it('does not count in-progress prompts as stock', () => {
    // A started drill is resumable, not available. Counting it would report a
    // bank she cannot draw a fresh prompt from.
    const started = bankStock({
      counts: [{ kind: 'essay_outline', banked: 0, inProgress: 6 }],
      lastRefillAttemptAt: null,
    });
    assert.equal(started.totalBanked, 0);
    assert.equal(started.kinds[0]?.inProgress, 6);
  });

  it('floors negative or fractional counts rather than propagating them', () => {
    const odd = bankStock({
      counts: [{ kind: 'essay_outline', banked: -3, inProgress: 2.7 }],
      lastRefillAttemptAt: null,
    });
    assert.equal(odd.kinds[0]?.banked, 0);
    assert.equal(odd.kinds[0]?.inProgress, 2);
  });
});

/* ---------------------------------------------------------------- targets */

describe('refillTargets', () => {
  it('aims at the shortfall rather than splitting evenly', () => {
    // Ten essay topics and one case needs cases. An even split would spend half
    // the batch deepening the surplus.
    const targets = refillTargets(stock(10, 1));
    assert.equal(targets[0]?.kind, 'ethics_case');
    assert.ok((targets[0]?.count ?? 0) > (targets[1]?.count ?? 0));
  });

  it('splits an EMPTY bank across both kinds', () => {
    // The device-found bug. Both kinds are short by the same amount on a first
    // top-up; filling the neediest to exhaustion sent the whole batch to essay
    // outlines, leaving no ethics cases and a six-hour cooldown before the next
    // attempt. The first top-up is exactly this case, so it is the one that
    // must not be lopsided.
    const targets = refillTargets(stock(0, 0));
    assert.equal(targets.length, 2, 'an empty bank must get both kinds');
    for (const entry of targets) {
      assert.ok(entry.count > 0, `${entry.kind} got nothing`);
    }
    assert.deepEqual(
      targets.map((entry) => entry.count).sort(),
      [DRILL_RULES.promptBatchSize / 2, DRILL_RULES.promptBatchSize / 2],
      'an even shortfall splits evenly',
    );
  });

  it('never asks for more than one batch', () => {
    const targets = refillTargets(stock(0, 0));
    const total = targets.reduce((sum, entry) => sum + entry.count, 0);
    assert.equal(total, DRILL_RULES.promptBatchSize);
  });

  it('asks for less than a batch when the bank is nearly full', () => {
    // A ceiling, not a quota. Padding to the batch size would push the bank
    // past the point where a topic is still live.
    const targets = refillTargets(stock(DRILL_RULES.targetBankedPrompts - 1, DRILL_RULES.targetBankedPrompts));
    assert.deepEqual(targets, [{ kind: 'essay_outline', count: 1 }]);
  });

  it('asks for nothing when both kinds are at target', () => {
    const full = stock(DRILL_RULES.targetBankedPrompts, DRILL_RULES.targetBankedPrompts);
    assert.deepEqual(refillTargets(full), []);
  });

  it('is deterministic when both kinds are equally short', () => {
    // Two runs over the same bank must produce the same request, or the same
    // shortage is filled differently on each attempt.
    const a = refillTargets(stock(3, 3));
    const b = refillTargets(stock(3, 3));
    assert.deepEqual(a, b);
  });
});

/* ------------------------------------------------------------------- gate */

describe('shouldRefillPrompts', () => {
  it('refills when a kind is under the floor', () => {
    const decision = shouldRefillPrompts(gate({ stock: stock(10, 1) }));
    assert.equal(decision.refill, true);
    assert.equal(decision.want[0]?.kind, 'ethics_case');
    assert.match(decision.reason, /ethics case/);
  });

  it('declines while one is already running, before mentioning anything else', () => {
    // A different fact from "you topped up an hour ago", and telling her the
    // wrong one sends her looking in the wrong place.
    const decision = shouldRefillPrompts(
      gate({ refillInFlight: true, stock: stock(0, 0), spendCapAllows: false }),
    );
    assert.equal(decision.refill, false);
    assert.match(decision.reason, /already running/);
  });

  it('declines a full bank, and says why a topic bank stays small', () => {
    const decision = shouldRefillPrompts(
      gate({ stock: stock(DRILL_RULES.targetBankedPrompts, DRILL_RULES.targetBankedPrompts) }),
    );
    assert.equal(decision.refill, false);
    assert.match(decision.reason, /last season/);
    assert.deepEqual(decision.want, []);
  });

  it('declines when the spend cap is reached', () => {
    const decision = shouldRefillPrompts(gate({ stock: stock(0, 0), spendCapAllows: false }));
    assert.equal(decision.refill, false);
    assert.match(decision.reason, /spend cap/);
  });

  it('lets a manual top-up skip the cooldown and the floor', () => {
    // She can see the bank on the same screen as the button. Second-guessing
    // her here is just the app being wrong out loud.
    const decision = shouldRefillPrompts(
      gate({
        trigger: 'manual',
        stock: stock(8, 8, { lastRefillAttemptAt: '2026-09-07T07:30:00.000Z' }),
      }),
    );
    assert.equal(decision.refill, true);
    assert.match(decision.reason, /You asked/);
  });

  it('does NOT let a manual top-up skip the spend cap', () => {
    const decision = shouldRefillPrompts(
      gate({ trigger: 'manual', stock: stock(0, 0), spendCapAllows: false }),
    );
    assert.equal(decision.refill, false);
  });

  it('does NOT let a manual top-up refill a full bank', () => {
    const decision = shouldRefillPrompts(
      gate({
        trigger: 'manual',
        stock: stock(DRILL_RULES.targetBankedPrompts, DRILL_RULES.targetBankedPrompts),
      }),
    );
    assert.equal(decision.refill, false);
  });

  it('holds an automatic top-up inside the cooldown, and says how long is left', () => {
    const decision = shouldRefillPrompts(
      gate({ stock: stock(0, 0, { lastRefillAttemptAt: '2026-09-07T06:00:00.000Z' }) }),
    );
    assert.equal(decision.refill, false);
    assert.match(decision.reason, /Next automatic one in about 4h/);
  });

  it('refills once the cooldown has passed', () => {
    const decision = shouldRefillPrompts(
      gate({ stock: stock(0, 0, { lastRefillAttemptAt: '2026-09-06T20:00:00.000Z' }) }),
    );
    assert.equal(decision.refill, true);
  });

  it('declines an automatic top-up above the floor even with room to grow', () => {
    const decision = shouldRefillPrompts(
      gate({ stock: stock(DRILL_RULES.lowWaterPrompts, DRILL_RULES.lowWaterPrompts) }),
    );
    assert.equal(decision.refill, false);
    assert.match(decision.reason, /enough to drill from/);
    // Still short of target, so a MANUAL top-up would be allowed.
    assert.ok(refillTargets(decision.want.length ? stock(0, 0) : stock(DRILL_RULES.lowWaterPrompts, DRILL_RULES.lowWaterPrompts)).length > 0);
  });

  it('treats an unparseable last-attempt instant as no evidence, not as recent', () => {
    // Failing the other way would wedge the bank shut permanently on one bad row.
    const decision = shouldRefillPrompts(
      gate({ stock: stock(0, 0, { lastRefillAttemptAt: 'yesterday' }) }),
    );
    assert.equal(decision.refill, true);
  });

  it('always populates a reason', () => {
    const cases: RefillGate[] = [
      gate(),
      gate({ refillInFlight: true }),
      gate({ spendCapAllows: false }),
      gate({ trigger: 'manual' }),
      gate({ stock: stock(DRILL_RULES.targetBankedPrompts, DRILL_RULES.targetBankedPrompts) }),
    ];
    for (const each of cases) {
      assert.notEqual(shouldRefillPrompts(each).reason.trim(), '');
    }
  });
});

describe('labelOf', () => {
  it('names both kinds readably', () => {
    for (const kind of DRILL_KINDS) {
      assert.notEqual(labelOf(kind), kind, 'a raw enum value is not a sentence');
      assert.doesNotMatch(labelOf(kind), /_/);
    }
  });
});

describe('past-paper stock and the refill ceiling', () => {
  it('does not let imported past papers suppress generation', () => {
    // The bug this pins: `targetBankedPrompts` is 12, and counting past papers
    // against it means importing eighty real UPSC essay topics puts the bank
    // permanently "full". Current-affairs-aimed generation then stops for good,
    // with no error and no way to notice. The ceiling's own reasoning — "a bank
    // of eighty topics would mostly be last autumn's news" — is an argument
    // about generated prompts. A 2016 essay topic does not go stale.
    const stock = bankStock({
      counts: [
        { kind: 'essay_outline', banked: 0, inProgress: 0, bankedPyq: 80 },
        { kind: 'ethics_case', banked: 0, inProgress: 0, bankedPyq: 60 },
      ],
      lastRefillAttemptAt: null,
    });

    assert.equal(stock.belowLowWater, true, 'no generated stock means the bank is short');
    for (const kind of stock.kinds) {
      assert.equal(kind.belowLowWater, true, `${kind.kind} has zero generated prompts`);
    }
  });

  it('still counts past papers as work she can do', () => {
    // Excluded from the TRIGGER, included in the total. A screen reporting
    // "0 prompts" while holding 140 real ones is the same class of lie as the
    // runway card reporting zero days against a full question bank.
    const stock = bankStock({
      counts: [{ kind: 'essay_outline', banked: 2, inProgress: 0, bankedPyq: 8 }],
      lastRefillAttemptAt: null,
    });
    assert.equal(stock.totalBanked, 10);
  });

  it('treats an absent bankedPyq as zero', () => {
    // Every existing caller omits it. Behaviour must be byte-identical to before.
    const stock = bankStock({
      counts: [{ kind: 'essay_outline', banked: 5, inProgress: 1 }],
      lastRefillAttemptAt: null,
    });
    assert.equal(stock.kinds[0]?.bankedPyq, 0);
    assert.equal(stock.totalBanked, 5);
  });
});
