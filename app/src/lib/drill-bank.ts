/**
 * The drill prompt bank: what is on the phone, and whether to fetch more.
 *
 * Pure — every clock reading is passed in. `db/drills.ts` reads the rows,
 * `drill-refill.ts` runs the network call, and neither decision lives here
 * except as a function of the numbers it is handed.
 *
 * ## Why a bank at all
 *
 * The same reason Phase 3 banks MCQs, and it is not a performance argument. Her
 * writing block is 8:00–10:00 on a weekday morning; a drill she cannot start
 * without signal is a drill she does not do, and "the app needed the internet"
 * is a sentence that ends a habit rather than delaying it. So prompts are
 * generated ahead in small batches and sit on the device until used.
 *
 * ## Why the bank is SMALL
 *
 * Twelve, against an MCQ bank of six hundred. An MCQ about Article 21 is as good
 * in March as it was in September; an essay topic is not. Half of what makes a
 * topic worth drilling is that it is live — the debate is running, the examples
 * are fresh, and she has read something about it this month. A bank of eighty
 * topics would mostly be last autumn's news, and it would crowd out the ones
 * worth writing.
 */

import { DRILL_RULES, DRILL_KINDS, type DrillKind } from '@/lib/drill-types';

/* ------------------------------------------------------------------ status */

/** What the bank holds for one kind. */
export interface KindStock {
  kind: DrillKind;
  /**
   * Unattempted GENERATED prompts. The only ones the refill ceiling counts.
   *
   * Past-paper prompts are excluded on purpose — see `bankedPyq`.
   */
  banked: number;
  /**
   * Unattempted prompts imported from past papers.
   *
   * Stock she can work from, and deliberately NOT counted against the refill
   * ceiling. That ceiling exists because "a bank of eighty topics would mostly
   * be last autumn's news" — an argument about GENERATED prompts, which are
   * aimed at current affairs and go stale. A 2016 UPSC essay topic does not.
   *
   * Counted together, importing eighty real essay topics would put the bank
   * permanently over its twelve-prompt ceiling and silently stop current-affairs
   * generation for good.
   */
  bankedPyq: number;
  /** Started and not submitted. Resumable, and not stock. */
  inProgress: number;
  belowLowWater: boolean;
}

export interface BankStock {
  kinds: readonly KindStock[];
  totalBanked: number;
  /** True when ANY kind is short. A refill tops up whichever is thinnest. */
  belowLowWater: boolean;
  /** ISO instant of the last refill ATTEMPT, successful or not. */
  lastRefillAttemptAt: string | null;
}

export interface StockInput {
  /** One row per kind, in any order. `bankedPyq` absent reads as zero. */
  counts: readonly {
    kind: DrillKind;
    banked: number;
    inProgress: number;
    bankedPyq?: number;
  }[];
  lastRefillAttemptAt: string | null;
}

/**
 * The bank, per kind and in total.
 *
 * Per kind because the two are not substitutes: a bank of twelve essay topics
 * and no ethics cases is not a stocked bank, and a total would report it as
 * one. She drills whichever the morning calls for, and the shortage that
 * matters is the one in front of her.
 */
export function bankStock(input: StockInput): BankStock {
  const byKind = new Map(input.counts.map((entry) => [entry.kind, entry] as const));

  const kinds: KindStock[] = DRILL_KINDS.map((kind) => {
    const entry = byKind.get(kind);
    const banked = Math.max(0, Math.floor(entry?.banked ?? 0));
    const bankedPyq = Math.max(0, Math.floor(entry?.bankedPyq ?? 0));
    return {
      kind,
      banked,
      bankedPyq,
      inProgress: Math.max(0, Math.floor(entry?.inProgress ?? 0)),
      /**
       * Generated stock only.
       *
       * A bank full of past papers is not a reason to stop generating: the two
       * are not substitutes. A past topic is calibration against what UPSC has
       * actually asked; a generated one is aimed at what she read this month.
       */
      belowLowWater: banked < DRILL_RULES.lowWaterPrompts,
    };
  });

  return {
    kinds,
    /** Everything she can work from, both sources. Display, not a trigger. */
    totalBanked: kinds.reduce((total, entry) => total + entry.banked + entry.bankedPyq, 0),
    belowLowWater: kinds.some((entry) => entry.belowLowWater),
    lastRefillAttemptAt: input.lastRefillAttemptAt,
  };
}

/* ------------------------------------------------------------- the refill */

export type RefillTrigger = 'auto' | 'manual';

export interface RefillGate {
  stock: BankStock;
  trigger: RefillTrigger;
  /** ISO instant. Injected so a test is not clock-dependent. */
  now: string;
  spendCapAllows: boolean;
  refillInFlight: boolean;
}

export interface RefillDecision {
  refill: boolean;
  /** Always populated. "Nothing happened" must be explicable on screen. */
  reason: string;
  /** How many of each kind to ask for. Empty when `refill` is false. */
  want: readonly { kind: DrillKind; count: number }[];
}

function hoursSince(from: string | null, now: string): number | null {
  if (from === null) return null;
  const a = Date.parse(from);
  const b = Date.parse(now);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (b - a) / 3_600_000;
}

/**
 * How many of each kind a batch should ask for.
 *
 * Aimed at the SHORTFALL rather than split evenly: a bank holding ten essay
 * topics and one ethics case needs cases, and an even split would spend half
 * the batch deepening the surplus. The batch size is a ceiling, not a quota, so
 * a nearly-full bank asks for less rather than padding to the ceiling.
 */
export function refillTargets(stock: BankStock): { kind: DrillKind; count: number }[] {
  // Allocated ONE AT A TIME to whichever kind is currently thinnest, rather
  // than filling the neediest kind to exhaustion before starting the next.
  //
  // Filling in order looks equivalent and is not. On an EMPTY bank both kinds
  // are short by the same amount, the tie broke alphabetically, and the entire
  // first batch went to essay outlines — leaving her with six essay prompts,
  // no ethics cases, and a six-hour cooldown before the next attempt. Found by
  // running it on a device, where the first top-up is exactly this case.
  const held = new Map<DrillKind, number>(stock.kinds.map((entry) => [entry.kind, entry.banked]));
  const wanted = new Map<DrillKind, number>();

  for (let i = 0; i < DRILL_RULES.promptBatchSize; i += 1) {
    // Thinnest first; ties broken by declared order so the result is stable.
    const next = [...held.entries()]
      .filter(([, banked]) => banked < DRILL_RULES.targetBankedPrompts)
      .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))[0];
    if (next === undefined) break;

    const [kind, banked] = next;
    held.set(kind, banked + 1);
    wanted.set(kind, (wanted.get(kind) ?? 0) + 1);
  }

  // Declared order, so the request body is byte-identical across two runs over
  // the same bank.
  return DRILL_KINDS.filter((kind) => (wanted.get(kind) ?? 0) > 0).map((kind) => ({
    kind,
    count: wanted.get(kind)!,
  }));
}

const NO_REFILL = (reason: string): RefillDecision => ({ refill: false, reason, want: [] });

/**
 * Whether to spend a model call topping the bank up.
 *
 * Order matters and is chosen so the reason is the actionable one: an in-flight
 * refill is reported before a cooldown, because "one is already running" is a
 * different fact from "you topped up an hour ago" and telling her the wrong one
 * sends her looking in the wrong place.
 */
export function shouldRefillPrompts(gate: RefillGate): RefillDecision {
  if (gate.refillInFlight) {
    return NO_REFILL('A top-up is already running.');
  }

  const want = refillTargets(gate.stock);
  if (want.length === 0) {
    return NO_REFILL(
      `The bank is full at ${DRILL_RULES.targetBankedPrompts} prompts of each kind. ` +
        'Past that a topic bank is mostly last season’s news.',
    );
  }

  if (!gate.spendCapAllows) {
    return NO_REFILL('The spend cap is reached, so no prompts can be generated until it resets.');
  }

  // Manual is the honest answer to "I have wifi now and I want to drill
  // tomorrow". It skips the cooldown and the low-water threshold — she can see
  // the bank on the same screen as the button, so the app second-guessing her
  // here would just be the app being wrong out loud. The cap still binds.
  if (gate.trigger === 'manual') {
    return { refill: true, reason: 'You asked for a top-up.', want };
  }

  const sinceLast = hoursSince(gate.stock.lastRefillAttemptAt, gate.now);
  if (sinceLast !== null && sinceLast < DRILL_RULES.refillCooldownHours) {
    const remaining = Math.max(1, Math.ceil(DRILL_RULES.refillCooldownHours - sinceLast));
    return NO_REFILL(
      `The last top-up was under ${DRILL_RULES.refillCooldownHours} hours ago. ` +
        `Next automatic one in about ${remaining}h.`,
    );
  }

  if (!gate.stock.belowLowWater) {
    const thinnest = [...gate.stock.kinds].sort((a, b) => a.banked - b.banked)[0];
    return NO_REFILL(
      `The bank holds enough to drill from — ${thinnest?.banked ?? 0} of the thinnest kind, ` +
        `against a floor of ${DRILL_RULES.lowWaterPrompts}.`,
    );
  }

  const short = gate.stock.kinds.filter((entry) => entry.belowLowWater);
  return {
    refill: true,
    reason:
      short.length === 1
        ? `${short[0]!.banked} ${labelOf(short[0]!.kind)} prompts left, under the floor of ${DRILL_RULES.lowWaterPrompts}.`
        : `Both kinds are under the floor of ${DRILL_RULES.lowWaterPrompts} prompts.`,
    want,
  };
}

/** Human-readable kind name. Rendered in sentences, never parsed. */
export function labelOf(kind: DrillKind): string {
  return kind === 'essay_outline' ? 'essay outline' : 'ethics case';
}
