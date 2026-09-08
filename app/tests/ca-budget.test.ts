/**
 * Volume discipline.
 *
 * Three things are being defended here, and only the first is arithmetic.
 *
 * 1. A FULL digest fits the block. Six weekday items and eight Saturday ones,
 *    each at the maximum note length, must estimate under the 20- and
 *    40-minute budgets — otherwise the cap and the budget contradict each other
 *    and the pair of numbers in `CA_RULES` is decorative.
 * 2. A read rate under the floor shrinks the cap by exactly ONE, and says so.
 *    By one, because the feedback has to be gentle enough to be survivable and
 *    visible enough to be noticed; and with a reason, because a cap that
 *    changes silently teaches nothing.
 * 3. `null` NEVER shrinks the cap. This is `projectFirstPass`'s day-one rule —
 *    a false alarm on a fresh install is what makes every later true one
 *    ignorable — and it is defended twice: `readRate` refuses to score items
 *    that have not had their reading window yet, and `digestBudget` refuses to
 *    treat "no evidence" as a zero.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  digestBudget,
  estimateReadMinutes,
  readRate,
  shouldRequestDigest,
  type DeliveredItem,
  type DigestGate,
  type ReadableItem,
} from '../src/lib/ca-budget';
import { CA_RULES } from '../src/lib/ca-types';

/* ------------------------------------------------------------------ helpers */

const SUNDAY = 0;
const MONDAY = 1;
const FRIDAY = 5;
const SATURDAY = 6;

/** An item at the maximum permitted note length, plus a long headline. */
function maxItem(): ReadableItem {
  return {
    headline: 'Cabinet approves a wide-ranging overhaul of the central welfare scheme architecture',
    noteMd: Array.from({ length: CA_RULES.maxNoteWords }, (_, i) => `word${i}`).join(' '),
  };
}

function fullDigest(count: number): ReadableItem[] {
  return Array.from({ length: count }, maxItem);
}

function delivered(date: string, read: boolean): DeliveredItem {
  return { date, readAt: read ? `${date}T09:30:00.000Z` : null };
}

function gate(overrides: Partial<DigestGate> = {}): DigestGate {
  return {
    trigger: 'auto',
    now: '2026-09-14T06:00:00.000Z',
    todayStatus: 'none',
    lastAttemptAt: null,
    healthOk: true,
    spendCapAllows: true,
    ...overrides,
  };
}

/* -------------------------------------------------------- estimateReadMinutes */

describe('estimateReadMinutes', () => {
  it('costs nothing for an empty digest', () => {
    assert.equal(estimateReadMinutes([]), 0);
  });

  it('reads at CA_RULES.readWordsPerMinute', () => {
    // Exactly two minutes of words, split across the headline and the note so
    // both fields are proved to count.
    const words = CA_RULES.readWordsPerMinute * 2;
    const item: ReadableItem = {
      headline: 'one two three four five',
      noteMd: Array.from({ length: words - 5 }, (_, i) => `w${i}`).join(' '),
    };
    assert.equal(estimateReadMinutes([item]), 2);
  });

  it('rounds up, so a short digest is never a zero-minute promise', () => {
    assert.equal(estimateReadMinutes([{ headline: 'a b c', noteMd: 'd e' }]), 1);
  });

  it('ignores whitespace-only fields rather than counting them as words', () => {
    assert.equal(estimateReadMinutes([{ headline: '   ', noteMd: '\n\n' }]), 0);
  });
});

/* --------------------------------------------------------------- the budget */

describe('digestBudget', () => {
  it('gives six items on a weekday', () => {
    for (const day of [MONDAY, 2, 3, 4, FRIDAY]) {
      const budget = digestBudget({ dayOfWeek: day, recentReadRate: null });
      assert.equal(budget.items, 6, `day ${day}`);
      assert.equal(budget.items, CA_RULES.dailyItemCap);
      assert.equal(budget.minutes, CA_RULES.dailyBudgetMinutes);
    }
  });

  it('gives eight items on Saturday', () => {
    const budget = digestBudget({ dayOfWeek: SATURDAY, recentReadRate: null });
    assert.equal(budget.items, 8);
    assert.equal(budget.items, CA_RULES.weekendItemCap);
    assert.equal(budget.minutes, CA_RULES.weekendBudgetMinutes);
  });

  it('keeps Sunday at the weekday cap — it is her most committed day', () => {
    // Sunday is an off day but it is not spare: `OFFDAY_SLOTS` opens it with a
    // timed answer set and closes it with the capped lecture-backlog catch-up.
    // Saturday is where the slack actually is.
    assert.equal(digestBudget({ dayOfWeek: SUNDAY, recentReadRate: null }).items, 6);
  });

  it('falls back to the smaller cap on a nonsensical day', () => {
    for (const day of [Number.NaN, -1, 7, 6.5]) {
      assert.equal(digestBudget({ dayOfWeek: day, recentReadRate: null }).items, 6, `day ${day}`);
    }
  });

  it('a full weekday digest fits the 20-minute budget', () => {
    const budget = digestBudget({ dayOfWeek: MONDAY, recentReadRate: null });
    const minutes = estimateReadMinutes(fullDigest(budget.items));
    assert.equal(budget.minutes, 20);
    assert.ok(
      minutes <= budget.minutes,
      `six maximum-length items estimate ${minutes} minutes, over the ${budget.minutes}-minute budget`,
    );
  });

  it('a full Saturday digest fits the 40-minute budget', () => {
    const budget = digestBudget({ dayOfWeek: SATURDAY, recentReadRate: null });
    const minutes = estimateReadMinutes(fullDigest(budget.items));
    assert.equal(budget.minutes, 40);
    assert.ok(
      minutes <= budget.minutes,
      `eight maximum-length items estimate ${minutes} minutes, over the ${budget.minutes}-minute budget`,
    );
  });

  it('shrinks the cap by exactly one when the read rate is under the floor', () => {
    const weekday = digestBudget({ dayOfWeek: MONDAY, recentReadRate: 0.4 });
    assert.equal(weekday.items, CA_RULES.dailyItemCap - 1);
    assert.equal(weekday.reduced, true);

    const saturday = digestBudget({ dayOfWeek: SATURDAY, recentReadRate: 0.4 });
    assert.equal(saturday.items, CA_RULES.weekendItemCap - 1);
    assert.equal(saturday.reduced, true);
  });

  it('says WHY it shrank — the rate, the floor and both numbers', () => {
    const budget = digestBudget({ dayOfWeek: MONDAY, recentReadRate: 0.4 });
    assert.match(budget.reason, /40%/);
    assert.match(budget.reason, /60%/);
    assert.match(budget.reason, /5 items, not 6/);
    // The whole argument, in the words she actually reads.
    assert.match(budget.reason, /5 a day you read beats 6 you do not/);
  });

  it('leaves the cap alone at exactly the floor', () => {
    // The rule is "below the floor", not "at or below it".
    const budget = digestBudget({ dayOfWeek: MONDAY, recentReadRate: CA_RULES.readRateFloor });
    assert.equal(budget.items, 6);
    assert.equal(budget.reduced, false);
  });

  it('never shrinks the cap on a null read rate — the day-one rule', () => {
    for (const day of [SUNDAY, MONDAY, FRIDAY, SATURDAY]) {
      const withRate = digestBudget({ dayOfWeek: day, recentReadRate: 1 });
      const noRate = digestBudget({ dayOfWeek: day, recentReadRate: null });
      assert.equal(noRate.items, withRate.items, `day ${day}`);
      assert.equal(noRate.reduced, false);
      assert.match(noRate.reason, /history/);
    }
  });

  it('treats a NaN rate as no evidence, not as a zero', () => {
    const budget = digestBudget({ dayOfWeek: MONDAY, recentReadRate: Number.NaN });
    assert.equal(budget.items, 6);
    assert.equal(budget.reduced, false);
  });

  it('keeps the minutes budget fixed when the item cap shrinks', () => {
    // The block is a fact about her shift, not about her reading discipline.
    const budget = digestBudget({ dayOfWeek: MONDAY, recentReadRate: 0.1 });
    assert.equal(budget.minutes, CA_RULES.dailyBudgetMinutes);
  });

  it('never drops below one item', () => {
    // Defensive: a cap of zero is the feed being switched off by accident.
    const budget = digestBudget({ dayOfWeek: MONDAY, recentReadRate: 0 });
    assert.ok(budget.items >= 1);
  });
});

/* ------------------------------------------------------------- the read rate */

describe('readRate', () => {
  const ASOF = '2026-09-14';

  it('is null with no items at all', () => {
    assert.equal(readRate([], ASOF), null);
  });

  it('is null on day one, when the only digest is still inside its reading window', () => {
    // The first defence against the day-one false alarm. Six items arrived this
    // morning and none is read yet; scoring that 0/6 would shrink tomorrow's
    // cap before she had a chance to read anything.
    const today = Array.from({ length: 6 }, () => delivered(ASOF, false));
    assert.equal(readRate(today, ASOF), null);
  });

  it('ignores items that have not yet had their full catch-up window', () => {
    const items = [
      delivered('2026-09-14', false), // today
      delivered('2026-09-13', false),
      delivered('2026-09-12', false), // still readable — 2 days old
      delivered('2026-09-11', true), // settled, and read
    ];
    assert.equal(readRate(items, ASOF), 1);
  });

  it('ignores items older than the window', () => {
    const items = [
      delivered('2026-08-31', true), // one day before the window opens
      delivered('2026-09-01', false), // the oldest day in the window
    ];
    assert.equal(readRate(items, ASOF), 0);
  });

  it('scores the settled items in the window', () => {
    const items = [
      delivered('2026-09-02', true),
      delivered('2026-09-03', true),
      delivered('2026-09-05', false),
      delivered('2026-09-08', false),
    ];
    assert.equal(readRate(items, ASOF), 0.5);
  });

  it('treats an empty readAt as unread rather than as read', () => {
    const items = [{ date: '2026-09-05', readAt: '' }];
    assert.equal(readRate(items, ASOF), 0);
  });

  it('is null rather than throwing on an unparseable day', () => {
    assert.equal(readRate([delivered('2026-09-05', true)], 'not-a-date'), null);
  });

  it('feeds digestBudget: a genuinely ignored fortnight shrinks the cap', () => {
    // The loop, end to end. Eleven settled days, two of them read.
    const items = [
      delivered('2026-09-01', true),
      delivered('2026-09-03', true),
      delivered('2026-09-04', false),
      delivered('2026-09-05', false),
      delivered('2026-09-08', false),
      delivered('2026-09-09', false),
      delivered('2026-09-10', false),
    ];
    const rate = readRate(items, ASOF);
    assert.ok(rate !== null && rate < CA_RULES.readRateFloor);
    assert.equal(digestBudget({ dayOfWeek: MONDAY, recentReadRate: rate }).items, 5);
  });
});

/* --------------------------------------------------------------- the trigger */

describe('shouldRequestDigest', () => {
  it('requests when there is no digest for today', () => {
    const decision = shouldRequestDigest(gate());
    assert.equal(decision.request, true);
    assert.match(decision.reason, /No digest for today/);
  });

  it('refuses while one is already being built', () => {
    assert.equal(shouldRequestDigest(gate({ todayStatus: 'pending' })).request, false);
  });

  it('refuses when today already has a digest — one a day, enforced by the schema', () => {
    // `ca_digests` has a UNIQUE index on `date`; a second request is not merely
    // wasteful, it is a constraint error.
    assert.equal(shouldRequestDigest(gate({ todayStatus: 'completed' })).request, false);
  });

  it('treats a partial digest as delivered — a short batch is a success', () => {
    const decision = shouldRequestDigest(gate({ todayStatus: 'partial' }));
    assert.equal(decision.request, false);
    assert.match(decision.reason, /short/);
  });

  it('retries a failed digest, which produced nothing at all', () => {
    const decision = shouldRequestDigest(gate({ todayStatus: 'failed' }));
    assert.equal(decision.request, true);
    assert.match(decision.reason, /failed/);
  });

  it('refuses inside the cooldown, and says how long is left', () => {
    const decision = shouldRequestDigest(
      gate({ lastAttemptAt: '2026-09-14T04:00:00.000Z' }), // two hours ago
    );
    assert.equal(decision.request, false);
    assert.match(decision.reason, new RegExp(`${CA_RULES.digestCooldownHours} hours`));
    assert.match(decision.reason, /about 4h/);
  });

  it('allows a retry once the cooldown has expired', () => {
    const decision = shouldRequestDigest(
      gate({ todayStatus: 'failed', lastAttemptAt: '2026-09-13T20:00:00.000Z' }),
    );
    assert.equal(decision.request, true);
  });

  it('refuses automatically when the server is unreachable', () => {
    assert.equal(shouldRequestDigest(gate({ healthOk: false })).request, false);
  });

  it('refuses at the spend cap even when she asked for it', () => {
    // The cap is not a preference.
    const decision = shouldRequestDigest(gate({ trigger: 'manual', spendCapAllows: false }));
    assert.equal(decision.request, false);
    assert.match(decision.reason, /spend cap/);
  });

  it('lets a manual request past the cooldown and a dead health probe', () => {
    const decision = shouldRequestDigest(
      gate({ trigger: 'manual', healthOk: false, lastAttemptAt: '2026-09-14T05:59:00.000Z' }),
    );
    assert.equal(decision.request, true);
  });

  it('does not let a manual request past today’s existing digest', () => {
    // Manual can skip a policy. It cannot skip the unique index.
    assert.equal(
      shouldRequestDigest(gate({ trigger: 'manual', todayStatus: 'completed' })).request,
      false,
    );
  });

  it('treats a catch-up request for a missed day as a deliberate one', () => {
    // `db/ca.ts` has a third trigger. It is her asking, so it is gated like
    // `manual` — past the cooldown and the health probe, but not past the
    // unique index on `ca_digests.date`.
    assert.equal(
      shouldRequestDigest(gate({ trigger: 'catch_up', healthOk: false })).request,
      true,
    );
    assert.equal(
      shouldRequestDigest(gate({ trigger: 'catch_up', todayStatus: 'completed' })).request,
      false,
    );
  });

  it('always gives a reason, whatever it decides', () => {
    const statuses = ['none', 'pending', 'completed', 'partial', 'failed'] as const;
    for (const todayStatus of statuses) {
      for (const trigger of ['auto', 'manual', 'catch_up'] as const) {
        const decision = shouldRequestDigest(gate({ todayStatus, trigger }));
        assert.ok(decision.reason.length > 0, `${trigger}/${todayStatus} decided without a reason`);
      }
    }
  });
});
