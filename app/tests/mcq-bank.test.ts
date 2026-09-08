/**
 * The question bank: depth, trigger and aim.
 *
 * Four things are being defended here, and each one has a specific way of
 * failing silently in production.
 *
 * 1. THE PLAN'S ARITHMETIC. A plan whose lines sum to 29 or 31 is untestable —
 *    every assertion downstream becomes "about thirty" — and a section quietly
 *    taking half a batch is invisible until she notices every question is
 *    Modern History. So: exact sums, and a hard 25% ceiling.
 * 2. LAPLACE SMOOTHING. Unsmoothed, one wrong answer out of one attempt reads
 *    as a 100% error rate and monopolises the next batch on the strength of a
 *    single tap. That bug produces a plausible-looking plan, which is why it
 *    needs a test rather than a code review.
 * 3. THE EXPLORATION SHARE. A greedy rule cannot rank a section with no
 *    attempts, so a never-drilled section stays never-drilled forever. This is
 *    the only mechanism that breaks that loop, and it is one `Math.round` away
 *    from silently rounding to zero.
 * 4. p75 RATHER THAN THE MEAN. The two statistics agree on a series with no
 *    zero-days, so the test that matters is the one with them.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BANK_RULES,
  computeRunway,
  dailyDemand,
  normaliseStem,
  laplaceErrorRate,
  planBankRefill,
  scoreSection,
  shouldRefill,
  stemFingerprint,
  type BankInventory,
  type DailyDrillCount,
  type RefillGate,
} from '../src/lib/mcq-bank';
import type { BankRunway, SectionDemand } from '../src/lib/mcq-types';

/* ------------------------------------------------------------------ helpers */

const TODAY = '2026-09-07';

function section(overrides: Partial<SectionDemand> = {}): SectionDemand {
  const paper = overrides.paper ?? 'gs1';
  const label = overrides.label ?? 'Modern History';
  return {
    sectionKey: `${paper}:${label}`,
    syllabusSlugs: [`${paper}-${label.toLowerCase().replace(/\s+/g, '-')}-1`],
    paper,
    label,
    eligible: true,
    percentFirstPass: 50,
    attempted: 10,
    wrong: 3,
    unseenStock: 10,
    lastDrilledDay: TODAY,
    ...overrides,
  };
}

/** A board of `count` interchangeable eligible sections. */
function board(count: number, overrides: Partial<SectionDemand> = {}): SectionDemand[] {
  return Array.from({ length: count }, (_, i) =>
    section({ label: `Section ${i + 1}`, ...overrides }),
  );
}

function totalOf(quotas: readonly { count: number }[]): number {
  return quotas.reduce((sum, line) => sum + line.count, 0);
}

function inventory(overrides: Partial<BankInventory> = {}): BankInventory {
  return {
    unseenEligible: 100,
    totalBanked: 120,
    quarantined: 0,
    redrillDueToday: 0,
    lastSuccessfulRefillAt: null,
    ...overrides,
  };
}

function gate(overrides: Partial<RefillGate> = {}): RefillGate {
  const runway: BankRunway =
    overrides.runway ??
    computeRunway(inventory({ unseenEligible: 12, totalBanked: 12 }), 10);

  return {
    trigger: 'auto',
    runway,
    now: '2026-09-07T09:00:00.000Z',
    lastRefillAttemptAt: null,
    healthOk: true,
    spendCapAllows: true,
    insideMicroBlock: false,
    refillInFlight: false,
    ...overrides,
  };
}

/* --------------------------------------------------------------- fingerprint */

describe('stemFingerprint', () => {
  it('collapses case, whitespace and punctuation', () => {
    const canonical = stemFingerprint(
      'Which of the following statements about the Doctrine of Lapse is correct?',
    );

    const variants = [
      'which of the following statements about the doctrine of lapse is correct',
      'WHICH OF THE FOLLOWING STATEMENTS ABOUT THE DOCTRINE OF LAPSE IS CORRECT?',
      'Which   of the  following statements about the Doctrine of Lapse\nis correct?',
      '  Which of the following statements, about the Doctrine of Lapse, is correct?!  ',
      'Which of the following statements about the “Doctrine of Lapse” is correct —?',
    ];

    for (const variant of variants) {
      assert.equal(
        stemFingerprint(variant),
        canonical,
        `should have collapsed to the same fingerprint: ${variant}`,
      );
    }
  });

  it('treats an apostrophe as absent rather than as a word break', () => {
    assert.equal(normaliseStem("Nehru's cabinet"), normaliseStem('Nehrus cabinet'));
    // And not as a space, which would make it collide with a genuine two-word form.
    assert.notEqual(normaliseStem("Nehru's cabinet"), normaliseStem('Nehru s cabinet'));
  });

  it('does NOT collide two genuine paraphrases', () => {
    // Same subject, same answer, different question. A fingerprint that
    // collapsed these would drop the second on insert and nothing would ever
    // report it missing — which is why normalisation stops at case, spacing and
    // punctuation and does not sort words or strip stopwords.
    const a = stemFingerprint('Which of the following is NOT a fundamental right?');
    const b = stemFingerprint('Which of the following IS a fundamental right?');
    assert.notEqual(a, b);

    // The pair that matters most: the SAME words in a different order, with
    // opposite answers. UPSC writes these constantly, and a normaliser that
    // sorted or bagged its tokens would fingerprint them identically — the
    // second would be dropped on insert and nothing would report it missing.
    const c = stemFingerprint(
      'Which of the following is a fundamental right but not a fundamental duty?',
    );
    const d = stemFingerprint(
      'Which of the following is a fundamental duty but not a fundamental right?',
    );
    assert.notEqual(c, d, 'word order is meaning; reordering must not collide');

    const e = stemFingerprint('Dalhousie introduced the Doctrine of Lapse.');
    const f = stemFingerprint('The Doctrine of Lapse introduced Dalhousie.');
    assert.notEqual(e, f, 'subject and object are not interchangeable');
  });

  it('is stable, 16 hex characters, and never empty', () => {
    const value = stemFingerprint('Article 21 of the Constitution');
    assert.match(value, /^[0-9a-f]{16}$/);
    assert.equal(value, stemFingerprint('Article 21 of the Constitution'));
    assert.match(stemFingerprint(''), /^[0-9a-f]{16}$/);
  });

  it('keeps two different non-Latin stems apart rather than collapsing both to empty', () => {
    // The fallback path. If the normaliser stripped a whole script, every stem
    // in that script would fingerprint identically and the bank would accept
    // exactly one of them.
    assert.notEqual(stemFingerprint('मौर्य साम्राज्य'), stemFingerprint('गुप्त साम्राज्य'));
  });
});

/* -------------------------------------------------------------------- demand */

describe('dailyDemand', () => {
  it('uses p75, not the mean, on a series containing zero-days', () => {
    // Four drilling days of 40 in a fortnight, ten days of nothing.
    const counts: DailyDrillCount[] = [
      { day: '2026-09-07', count: 40 },
      { day: '2026-09-05', count: 40 },
      { day: '2026-09-02', count: 40 },
      { day: '2026-08-30', count: 40 },
    ];

    const mean = 160 / BANK_RULES.demandWindowDays; // ≈ 11.4
    const demand = dailyDemand(counts, { asOfDay: TODAY });

    assert.equal(demand, 40, 'p75 of the 14-day series is a drilling day, not an average day');
    assert.ok(demand > mean * 3, 'the mean would have sized the bank for the wrong day');
  });

  it('counts days with no drill as real zeros', () => {
    // One enormous day and thirteen empty ones must NOT read as demand 90: the
    // 75th percentile of that series is still zero, so the floor takes over.
    const demand = dailyDemand([{ day: TODAY, count: 90 }], { asOfDay: TODAY });
    assert.equal(demand, BANK_RULES.minDemandPerDay);
  });

  it('never returns less than the floor', () => {
    assert.equal(dailyDemand([], { asOfDay: TODAY }), BANK_RULES.minDemandPerDay);
    assert.equal(
      dailyDemand([{ day: TODAY, count: 2 }], { asOfDay: TODAY }),
      BANK_RULES.minDemandPerDay,
    );
  });

  it('ignores days outside the window', () => {
    const stale: DailyDrillCount[] = Array.from({ length: 14 }, (_, i) => ({
      day: `2026-08-${String(i + 1).padStart(2, '0')}`,
      count: 60,
    }));
    assert.equal(dailyDemand(stale, { asOfDay: TODAY }), BANK_RULES.minDemandPerDay);
  });

  it('sizes for a busy day once there are enough of them', () => {
    const counts: DailyDrillCount[] = Array.from({ length: 14 }, (_, i) => ({
      day: `2026-08-${String(25 + i).padStart(2, '0')}`,
      count: 25,
    }));
    // 25 August + 13 days lands on 7 September, so the whole series is in window.
    assert.equal(dailyDemand(counts, { asOfDay: TODAY }), 25);
  });
});

/* ------------------------------------------------------------------- runway */

describe('computeRunway', () => {
  it('reports days, not rows', () => {
    const runway = computeRunway(inventory({ unseenEligible: 60 }), 10);
    assert.equal(runway.runwayDays, 6);
    assert.equal(runway.belowLowWater, false);
  });

  it('fires the low-water flag under three days', () => {
    const runway = computeRunway(inventory({ unseenEligible: 25 }), 10);
    assert.equal(runway.runwayDays, 2.5);
    assert.equal(runway.belowLowWater, true);
  });

  it('applies the hard floor even when the ratio looks comfortable', () => {
    // 35 unseen against a floor-level demand of 10 reads as 3.5 days — above
    // the low-water mark — and would be emptied by two sets in one evening.
    const runway = computeRunway(inventory({ unseenEligible: 35 }), 10);
    assert.ok(runway.runwayDays > BANK_RULES.lowWaterRunwayDays);
    assert.equal(runway.belowLowWater, true, 'the hard floor must outrank the ratio');
  });

  it('does not count redrills as runway', () => {
    const runway = computeRunway(
      inventory({ unseenEligible: 0, redrillDueToday: 200 }),
      10,
    );
    assert.equal(runway.runwayDays, 0);
    assert.equal(runway.redrillDueToday, 200);
    assert.equal(runway.belowLowWater, true);
  });
});

/* ------------------------------------------------------------------ trigger */

describe('shouldRefill', () => {
  const low = computeRunway(inventory({ unseenEligible: 12, totalBanked: 12 }), 10);
  const healthy = computeRunway(inventory({ unseenEligible: 200, totalBanked: 220 }), 10);

  it('fires once when the bank is low, and does not re-fire inside the cooldown', () => {
    const first = shouldRefill(gate({ runway: low, lastRefillAttemptAt: null }));
    assert.equal(first.refill, true, 'a low bank with no recent attempt must fire');

    // Same board, one minute later, with the attempt recorded.
    const second = shouldRefill(
      gate({
        runway: low,
        now: '2026-09-07T09:01:00.000Z',
        lastRefillAttemptAt: '2026-09-07T09:00:00.000Z',
      }),
    );
    assert.equal(second.refill, false);
    assert.match(second.reason, /hours ago/);

    // Still inside the six-hour window.
    const third = shouldRefill(
      gate({
        runway: low,
        now: '2026-09-07T14:30:00.000Z',
        lastRefillAttemptAt: '2026-09-07T09:00:00.000Z',
      }),
    );
    assert.equal(third.refill, false);

    // Past it.
    const fourth = shouldRefill(
      gate({
        runway: low,
        now: '2026-09-07T15:30:00.000Z',
        lastRefillAttemptAt: '2026-09-07T09:00:00.000Z',
      }),
    );
    assert.equal(fourth.refill, true);
  });

  it('stops firing once the bank is healthy again', () => {
    const decision = shouldRefill(gate({ runway: healthy }));
    assert.equal(decision.refill, false);
    assert.match(decision.reason, /days of questions in hand/);
  });

  it('never spends her drill window on a network call', () => {
    const decision = shouldRefill(gate({ runway: low, insideMicroBlock: true }));
    assert.equal(decision.refill, false);
    assert.match(decision.reason, /commute/i);
  });

  it('does not fire on foreground when the server is unreachable', () => {
    assert.equal(shouldRefill(gate({ runway: low, healthOk: false })).refill, false);
  });

  it('lets a manual top-up through the runway, cooldown and commute gates', () => {
    const decision = shouldRefill(
      gate({
        trigger: 'manual',
        runway: healthy,
        insideMicroBlock: true,
        healthOk: false,
        lastRefillAttemptAt: '2026-09-07T08:59:00.000Z',
      }),
    );
    assert.equal(decision.refill, true, '"I have wifi and I am about to travel" is the point');
  });

  it('refuses everything, manual included, at the spend cap or the bank ceiling', () => {
    assert.equal(
      shouldRefill(gate({ trigger: 'manual', runway: low, spendCapAllows: false })).refill,
      false,
    );

    const full = computeRunway(
      inventory({ unseenEligible: 5, totalBanked: BANK_RULES.bankCeiling }),
      10,
    );
    assert.equal(shouldRefill(gate({ trigger: 'manual', runway: full })).refill, false);
  });

  it('post-session respects the cooldown and the low-water mark', () => {
    assert.equal(shouldRefill(gate({ trigger: 'post_session', runway: low })).refill, true);
    assert.equal(shouldRefill(gate({ trigger: 'post_session', runway: healthy })).refill, false);
    assert.equal(
      shouldRefill(
        gate({
          trigger: 'post_session',
          runway: low,
          now: '2026-09-07T10:00:00.000Z',
          lastRefillAttemptAt: '2026-09-07T09:00:00.000Z',
        }),
      ).refill,
      false,
    );
  });

  it('never runs two refills at once', () => {
    assert.equal(
      shouldRefill(gate({ trigger: 'manual', runway: low, refillInFlight: true })).refill,
      false,
    );
  });
});

/* --------------------------------------------------------------------- plan */

describe('planBankRefill — arithmetic', () => {
  it('sums to exactly batchSize', () => {
    // Deliberately awkward: seven sections cannot divide thirty evenly, so
    // rounding each share independently would land on 28 or 35.
    const plan = planBankRefill({ sections: board(7), asOfDay: TODAY });

    assert.equal(plan.batchSize, BANK_RULES.batchSize);
    assert.equal(totalOf(plan.quotas), BANK_RULES.batchSize);
  });

  it('sums to exactly batchSize across a range of board shapes', () => {
    for (let count = 5; count <= 40; count += 1) {
      const sections = board(count).map((entry, i) =>
        // Vary the signals so the weights are genuinely uneven.
        ({ ...entry, attempted: 10 + i, wrong: i % 7, percentFirstPass: (i * 13) % 100 }),
      );
      const plan = planBankRefill({ sections, asOfDay: TODAY });
      assert.equal(
        totalOf(plan.quotas),
        plan.batchSize,
        `quotas must sum to the plan's own batch size (${count} sections)`,
      );
      assert.equal(plan.batchSize, BANK_RULES.batchSize);
    }
  });

  it('caps any one section at 25% of the batch', () => {
    // One catastrophically weak section against seven healthy ones.
    const sections = [
      section({
        label: 'Modern History',
        attempted: 40,
        wrong: 39,
        percentFirstPass: 5,
        unseenStock: 0,
        lastDrilledDay: null,
      }),
      ...board(7, { attempted: 40, wrong: 2, percentFirstPass: 95 }),
    ];

    const plan = planBankRefill({ sections, asOfDay: TODAY });
    const cap = Math.floor(BANK_RULES.batchSize * BANK_RULES.maxSectionShare);

    for (const line of plan.quotas) {
      assert.ok(line.count <= cap, `${line.sectionKey} took ${line.count}, cap is ${cap}`);
    }
    assert.equal(totalOf(plan.quotas), plan.batchSize);
    assert.equal(plan.quotas[0]?.count, cap, 'the weakest section should be at the cap');
  });

  it('shrinks the batch rather than breaching the cap when few sections are eligible', () => {
    // Three sections at a cap of seven cannot absorb thirty. A plan that asked
    // for thirty anyway would either breach the cap or not add up.
    const plan = planBankRefill({ sections: board(3), asOfDay: TODAY });
    const cap = Math.floor(BANK_RULES.batchSize * BANK_RULES.maxSectionShare);

    assert.equal(plan.batchSize, 3 * cap);
    assert.equal(totalOf(plan.quotas), plan.batchSize);
    assert.match(plan.rationale, /Asked for 30/);
  });
});

describe('planBankRefill — aim', () => {
  it('smooths a one-wrong-of-one section instead of reading it as 100% weak', () => {
    assert.equal(laplaceErrorRate(1, 1), 2 / 3);
    assert.ok(laplaceErrorRate(1, 1) < 1, 'unsmoothed this is exactly 1 — the maximum');
    assert.ok(laplaceErrorRate(0, 0) > 0, 'and no-attempts is never a confident zero either');
    // Monotonic where it should be: more wrong out of the same attempts is worse.
    assert.ok(laplaceErrorRate(30, 100) < laplaceErrorRate(70, 100));
  });

  it('does not let one-wrong-of-one outrank thirty-wrong-of-a-hundred', () => {
    // The fluke has a single bad tap and near-complete coverage. The genuine
    // section has a hundred attempts, a 30% error rate and a coverage gap more
    // than ten times as wide. Any sane aim points at the second one.
    const fluke = scoreSection(
      section({ label: 'Fluke', attempted: 1, wrong: 1, percentFirstPass: 95 }),
      { asOfDay: TODAY },
    );
    const genuine = scoreSection(
      section({ label: 'Genuine', attempted: 100, wrong: 30, percentFirstPass: 30 }),
      { asOfDay: TODAY },
    );

    // Unsmoothed the fluke's error term is 0.5 against the genuine section's
    // 0.15 — a 0.35 lead that the 0.195 coverage-gap advantage cannot close, so
    // one tap wins. Smoothed the lead is 0.18 and the evidence wins instead.
    assert.ok(
      genuine.priority > fluke.priority,
      `a single wrong answer must not outrank a hundred attempts: ` +
        `fluke ${fluke.priority.toFixed(3)}, genuine ${genuine.priority.toFixed(3)}`,
    );
  });

  it('does not hand the fluke a bigger quota than the measured weakness', () => {
    const sections = [
      section({ label: 'Fluke', attempted: 1, wrong: 1, percentFirstPass: 95, unseenStock: 0 }),
      section({ label: 'Genuine', attempted: 100, wrong: 30, percentFirstPass: 30, unseenStock: 0 }),
      // Middling filler, deliberately: enough weight of its own that neither of
      // the two above saturates the 25% cap, which would flatten them together
      // and make this assertion pass for the wrong reason.
      ...board(14, { attempted: 40, wrong: 12, percentFirstPass: 60, unseenStock: 40 }),
    ];

    const plan = planBankRefill({ sections, asOfDay: TODAY });
    const byKey = new Map(plan.quotas.map((line) => [line.sectionKey, line.count] as const));
    const fluke = byKey.get('gs1:Fluke') ?? 0;
    const genuine = byKey.get('gs1:Genuine') ?? 0;

    // Unsmoothed the fluke takes three and the genuine section two. Smoothed
    // they are level, which is the honest reading: one wrong answer is real but
    // thin evidence, so it buys a share, not a lead.
    assert.ok(fluke <= genuine, `fluke ${fluke}, genuine ${genuine}`);
    assert.equal(totalOf(plan.quotas), plan.batchSize);
  });

  it('gives a strictly positive share to a zero-attempt section the greedy rule would starve', () => {
    // A board designed so the greedy rule genuinely gives the blind section
    // nothing: twenty-five sections with a measured 79% error rate and a 90%
    // coverage gap, against one never-drilled section that already holds all
    // the stock. Proportionally the blind section's share rounds to zero.
    const sections = [
      ...board(25, {
        attempted: 50,
        wrong: 40,
        percentFirstPass: 10,
        unseenStock: 0,
        lastDrilledDay: TODAY,
      }),
      section({
        label: 'Post-Independence India',
        attempted: 0,
        wrong: 0,
        percentFirstPass: 100,
        unseenStock: 400,
        lastDrilledDay: null,
      }),
    ];

    const plan = planBankRefill({ sections, asOfDay: TODAY });
    const explorer = plan.quotas.find(
      (line) => line.sectionKey === 'gs1:Post-Independence India',
    );

    // Without the exploration share this section stays never-drilled forever:
    // no attempts means no error rate, no error rate means no priority, and no
    // priority means it is never sampled to acquire one.
    assert.ok(explorer !== undefined, 'a zero-attempt section must appear in the plan');
    assert.equal(
      explorer.count,
      Math.round(BANK_RULES.batchSize * BANK_RULES.explorationShare),
      'the whole exploration share goes to the only blind section',
    );
    assert.match(explorer.reason, /never drilled/);
    assert.equal(totalOf(plan.quotas), plan.batchSize);
  });

  it('spreads the exploration share evenly over every zero-attempt section', () => {
    const sections = [
      ...board(25, {
        attempted: 50,
        wrong: 40,
        percentFirstPass: 10,
        unseenStock: 0,
        lastDrilledDay: TODAY,
      }),
      ...['Blind A', 'Blind B', 'Blind C'].map((label) =>
        section({
          label,
          attempted: 0,
          wrong: 0,
          percentFirstPass: 100,
          unseenStock: 400,
          lastDrilledDay: null,
        }),
      ),
    ];

    const plan = planBankRefill({ sections, asOfDay: TODAY });
    const blind = plan.quotas.filter((line) => /Blind/.test(line.sectionKey));

    assert.equal(blind.length, 3, 'every blind section gets a share, not just the first');
    // Evenly, because there is nothing to rank them by — inventing a ranking
    // over three sections with no data would be pretending otherwise.
    for (const line of blind) assert.equal(line.count, 2);
    assert.equal(totalOf(plan.quotas), plan.batchSize);
  });

  it('does not round the exploration share away on a small batch', () => {
    const sections = [
      ...board(25, {
        attempted: 50,
        wrong: 40,
        percentFirstPass: 10,
        unseenStock: 0,
        lastDrilledDay: TODAY,
      }),
      section({
        label: 'Blind',
        attempted: 0,
        wrong: 0,
        percentFirstPass: 100,
        unseenStock: 400,
        lastDrilledDay: null,
      }),
    ];

    // round(4 * 0.2) is 1, but a batch of two would round it to zero — and an
    // exploration share that rounds away is not an exploration share.
    const plan = planBankRefill({ sections, asOfDay: TODAY, batchSize: 4 });
    const blind = plan.quotas.find((line) => line.sectionKey === 'gs1:Blind');

    assert.ok(blind !== undefined && blind.count > 0);
    assert.equal(totalOf(plan.quotas), plan.batchSize);
  });

  it('gives 100% to the greedy pool when no section has zero attempts', () => {
    const plan = planBankRefill({ sections: board(8), asOfDay: TODAY });
    assert.equal(totalOf(plan.quotas), BANK_RULES.batchSize);
    assert.match(plan.rationale, /0 of them go to 0 sections/);
  });

  it('prefers a stale section over an identically-scored fresh one', () => {
    const sections = [
      section({ label: 'Fresh', lastDrilledDay: TODAY }),
      section({ label: 'Stale', lastDrilledDay: '2026-06-01' }),
      ...board(6),
    ];

    const plan = planBankRefill({ sections, asOfDay: TODAY });
    const byKey = new Map(plan.quotas.map((line) => [line.sectionKey, line.count] as const));

    assert.ok((byKey.get('gs1:Stale') ?? 0) >= (byKey.get('gs1:Fresh') ?? 0));
    const staleLine = plan.quotas.find((line) => line.sectionKey === 'gs1:Stale');
    assert.match(staleLine?.reason ?? '', /last drilled \d+ days ago/);
  });

  it('discounts a section that already holds most of the unseen stock', () => {
    const hoarder = section({ label: 'Hoarder', unseenStock: 400 });
    const starved = section({ label: 'Starved', unseenStock: 0 });
    const sections = [hoarder, starved, ...board(6, { unseenStock: 10 })];

    const plan = planBankRefill({ sections, asOfDay: TODAY });
    const byKey = new Map(plan.quotas.map((line) => [line.sectionKey, line.count] as const));

    assert.ok(
      (byKey.get('gs1:Starved') ?? 0) > (byKey.get('gs1:Hoarder') ?? 0),
      'existing stock must suppress an otherwise identical section',
    );
  });
});

describe('planBankRefill — the two hard gates', () => {
  it('gives a not-started section quota 0 even when it is the weakest on the board', () => {
    const sections = [
      section({
        label: 'Never Opened',
        eligible: false,
        percentFirstPass: 0,
        attempted: 0,
        wrong: 0,
        unseenStock: 0,
        lastDrilledDay: null,
      }),
      ...board(6, { percentFirstPass: 95, attempted: 50, wrong: 1 }),
    ];

    const plan = planBankRefill({ sections, asOfDay: TODAY });

    assert.equal(
      plan.quotas.find((line) => line.sectionKey === 'gs1:Never Opened'),
      undefined,
      'drilling material she has never read produces a 20% score and destroys trust',
    );
    assert.equal(totalOf(plan.quotas), plan.batchSize);
  });

  it('gives Anthropology, Essay and GS4 quota 0 even when they are the weakest coverage', () => {
    const nonPrelims: SectionDemand[] = [
      section({
        paper: 'anthro_p1',
        label: 'Fieldwork Traditions',
        percentFirstPass: 0,
        attempted: 30,
        wrong: 29,
        unseenStock: 0,
        lastDrilledDay: null,
      }),
      section({
        paper: 'essay',
        label: 'Philosophical Themes',
        percentFirstPass: 2,
        attempted: 30,
        wrong: 28,
        unseenStock: 0,
        lastDrilledDay: null,
      }),
      section({
        paper: 'gs4',
        label: 'Ethics & Human Interface',
        percentFirstPass: 1,
        attempted: 30,
        wrong: 30,
        unseenStock: 0,
        lastDrilledDay: null,
      }),
    ];

    const plan = planBankRefill({
      sections: [...nonPrelims, ...board(6, { percentFirstPass: 99, attempted: 80, wrong: 1 })],
      asOfDay: TODAY,
    });

    for (const line of plan.quotas) {
      assert.ok(
        line.sectionKey.startsWith('gs1:') ||
          line.sectionKey.startsWith('gs2:') ||
          line.sectionKey.startsWith('gs3:'),
        `there is no Prelims paper for ${line.sectionKey} — generating it burns spend`,
      );
    }
    assert.equal(totalOf(plan.quotas), plan.batchSize);
  });

  it('returns an empty, explained plan when nothing is eligible', () => {
    const plan = planBankRefill({
      sections: board(5, { eligible: false }),
      asOfDay: TODAY,
    });

    assert.equal(plan.batchSize, 0);
    assert.deepEqual(plan.quotas, []);
    assert.match(plan.rationale, /no Prelims section has a topic you have started/i);
  });

  it('skips an eligible section that has no syllabus leaves to aim at', () => {
    const plan = planBankRefill({
      sections: [section({ label: 'Ghost', syllabusSlugs: [] }), ...board(5)],
      asOfDay: TODAY,
    });
    assert.equal(plan.quotas.find((line) => line.sectionKey === 'gs1:Ghost'), undefined);
    assert.equal(totalOf(plan.quotas), plan.batchSize);
  });
});

describe('planBankRefill — explicability', () => {
  it('gives every quota a sentence a human can argue with', () => {
    const plan = planBankRefill({
      sections: [
        section({ label: 'Modern History', percentFirstPass: 41, attempted: 9, wrong: 4 }),
        ...board(6),
      ],
      asOfDay: TODAY,
    });

    const line = plan.quotas.find((entry) => entry.sectionKey === 'gs1:Modern History');
    assert.ok(line !== undefined);
    // "12 from Modern History — 41% coverage, 4 of your last 9 wrong"
    assert.match(line.reason, /^\d+ from Modern History — 41% coverage, 4 of your last 9 wrong/);
    assert.equal(line.syllabusSlug, 'gs1-modern-history-1');
  });

  it('passes the exclude list through, bounded', () => {
    const hashes = Array.from({ length: 900 }, (_, i) => `hash-${i}`);
    const plan = planBankRefill({
      sections: board(6),
      asOfDay: TODAY,
      excludeStemHashes: hashes,
    });

    assert.ok(plan.excludeStemHashes.length > 0);
    assert.ok(plan.excludeStemHashes.length <= 600);
    assert.equal(plan.excludeStemHashes[0], 'hash-0');
  });

  it('states the cap and the exploration split in the rationale', () => {
    const plan = planBankRefill({
      sections: [section({ label: 'Blind', attempted: 0, lastDrilledDay: null }), ...board(6)],
      asOfDay: TODAY,
    });
    assert.match(plan.rationale, /No section may take more than 7\./);
    assert.match(plan.rationale, /never drilled/);
  });
});
