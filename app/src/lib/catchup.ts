/**
 * The catch-up plan. Pure — no RN, no expo-sqlite.
 *
 * SKELETON: types are FROZEN. Bodies are owned by the dashboard agent.
 *
 * ## What makes this different from "study more"
 *
 * A backlog alert that says "you are 40 hours behind" is an anxiety generator.
 * A plan is only useful if it is sized from hours she ACTUALLY has, which is
 * why every number here is derived from `deriveStudyBlocks` rather than
 * invented. The planner already encodes the two rules that matter:
 *
 * - Weekend lecture catch-up is capped (90 min/day). If a plan proposes more
 *   than the cap, catch-up has quietly eaten both her rest days.
 * - Active work — answer writing, timed sets — is protected. A plan that
 *   proposes cutting `active` or `timed_set` blocks trades the habit that
 *   takes longest to build for the one that is easiest to rebuild. Never do it.
 *
 * `reading` is the only reducible block, and only down to its planner-declared
 * minimum of 45 minutes.
 *
 * ## Units
 *
 * Capacity is WALL-CLOCK minutes (time she sits down for). Backlog is CONTENT
 * minutes. Playback speed is the conversion, and it is the assumed
 * `defaultPlaybackSpeed` here rather than the observed rate, because this looks
 * forward at hours not yet spent. Getting this backwards makes the plan wrong
 * by 33–50%.
 */

import type { DerivedBlock } from '@/lib/schedule';
import type { BacklogSummary } from '@/lib/backlog';

/**
 * Escalating, so week five reads differently from week one.
 * `must_drop` is a real outcome: sometimes the honest advice is that the
 * backlog cannot be cleared and some modules have to go.
 */
export type CatchUpTier = 'within_cap' | 'raise_speed' | 'reallocate_reading' | 'must_drop';

export interface CatchUpCapacity {
  /** Sum of blocks with kind 'catchup'. */
  catchupWallClockMinPerWeek: number;
  /** Sum of blocks with kind 'lecture'. */
  lectureWallClockMinPerWeek: number;
  /** Reading time above the planner's 45-minute slot minimum — the only slack. */
  reallocatableReadingMinPerWeek: number;
}

export interface CatchUpStep {
  text: string;
  wallClockMinPerWeek: number;
  contentMinPerWeek: number;
}

export interface CatchUpPlan {
  tier: CatchUpTier;
  headline: string;
  steps: CatchUpStep[];
  weeksToClear: number | null;
  clearsBy: string | null;
  capacity: CatchUpCapacity;
  /** Non-zero only at `must_drop`: how many lectures have to be abandoned. */
  lecturesToDrop: number;
}

/* ------------------------------------------------------------------ tunables */

/**
 * The planner's declared floor for a `reading` slot (`Slot.min` on both the
 * workday and off-day reading entries in `lib/schedule.ts`). Mirrored rather
 * than imported because the slot tables are module-private there; the pair is
 * pinned by `tests/catchup.test.ts`, which re-derives the slack from real
 * blocks and asserts no reading block is ever taken below this.
 */
const READING_SLOT_MIN_MINUTES = 45;

/**
 * Hard ceiling on playback speed, whatever the caller asks for.
 *
 * Above 2× comprehension collapses, so a plan built on 2.5× is not an
 * aggressive plan — it is a fiction that will be silently missed, which is
 * worse than an honest `must_drop`.
 */
const MAX_PLAYBACK_SPEED = 2;

/**
 * Floor for a stored speed. Below this it is corruption, not a preference —
 * but 0.75× is a real setting and must NOT be rounded up to 1×, which would
 * make the plan a third more optimistic than the hours behind it.
 */
const MIN_PLAYBACK_SPEED = 0.5;

/** Used only when the stored speed is missing or nonsense. */
const DEFAULT_PLAYBACK_SPEED = 1;

/** Players expose 1.25/1.5/1.75/2. Advising "watch at 1.62×" is not advice. */
const SPEED_INCREMENT = 0.25;

/**
 * How long a catch-up may take before the next lever is pulled.
 *
 * Beyond about a month it is not a catch-up plan, it is a new lifestyle, and
 * she will have accrued a fresh backlog on top before it lands. Escalating
 * instead keeps every tier's promise inside a horizon she can actually picture.
 */
const CATCHUP_HORIZON_WEEKS = 4;

/** Wall-clock advice is rounded to this, because a 7-minute step is noise. */
const STEP_ROUNDING_MIN = 5;

/**
 * Only used to turn a `must_drop` shortfall into a count of lectures, never
 * into capacity. A typical GS coaching lecture runs about an hour; the exact
 * figure moves the "drop N" number a little and nothing else.
 */
const ASSUMED_LECTURE_CONTENT_MIN = 60;

/** Float slack, so a plan that exactly meets the need is not judged short. */
const EPSILON = 1e-6;

/* ------------------------------------------------------------------- helpers */

function blockMinutes(block: DerivedBlock): number {
  return Math.max(0, block.endMinutes - block.startMinutes);
}

function ceilTo(value: number, step: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.ceil(value / step - EPSILON) * step;
}

function clampSpeed(speed: number | undefined): number {
  if (speed === undefined || !Number.isFinite(speed) || speed <= 0) return DEFAULT_PLAYBACK_SPEED;
  return Math.min(MAX_PLAYBACK_SPEED, Math.max(MIN_PLAYBACK_SPEED, speed));
}

/**
 * Whole days between two `YYYY-MM-DD` dates.
 *
 * Parsed at UTC midnight from the date part only, so a timestamp with a local
 * offset cannot shift the day — the same rule the schema documents for every
 * other date comparison in this codebase.
 */
function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso.slice(0, 10)}T00:00:00Z`);
  const to = Date.parse(`${toIso.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return (to - from) / 86_400_000;
}

function addDaysIso(fromIso: string, days: number): string {
  const from = Date.parse(`${fromIso.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(from)) return fromIso.slice(0, 10);
  return new Date(from + days * 86_400_000).toISOString().slice(0, 10);
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** `2027-03-31` -> `31 March 2027`. Kept off `Date` so no timezone can shift it. */
function longDate(iso: string): string {
  const [year, month, day] = iso.slice(0, 10).split('-');
  const index = Number(month) - 1;
  if (!year || !day || index < 0 || index > 11) return iso;
  return `${Number(day)} ${MONTHS[index]} ${year}`;
}

function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours === 0) return `${mins} min`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

function formatSpeed(speed: number): string {
  const rounded = Math.round(speed * 100) / 100;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(2).replace(/0$/, '')}×`;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/* ------------------------------------------------------------------ capacity */

/**
 * The three numbers a plan is allowed to spend, read straight off the blocks.
 *
 * `workDays` is load-bearing rather than decorative:
 *
 * - Catch-up is counted only on REST days. The 90-min/day cap is a rest-day
 *   rule, so a catch-up block that somehow landed inside a working week is not
 *   the thing the cap governs and is left out rather than quietly inflating it.
 * - Reallocatable reading is counted only on WORK days. Rest-day reading sits
 *   directly beside the capped catch-up slot; moving it into lectures would be
 *   weekend catch-up above 90 minutes wearing a different label, which is
 *   exactly the failure the cap exists to prevent.
 *
 * `active` and `timed_set` minutes appear in none of the three, so no plan
 * assembled from this budget can reach them. That is the whole enforcement
 * mechanism for the protected-work rule: it is structural, not a check.
 */
export function summariseCatchUpCapacity(
  blocks: DerivedBlock[],
  workDays: number[],
): CatchUpCapacity {
  const work = new Set(workDays);

  let catchupWallClockMinPerWeek = 0;
  let lectureWallClockMinPerWeek = 0;
  let reallocatableReadingMinPerWeek = 0;

  for (const block of blocks) {
    const minutes = blockMinutes(block);
    const onWorkDay = work.has(block.dayOfWeek);

    if (block.kind === 'catchup') {
      if (!onWorkDay) catchupWallClockMinPerWeek += minutes;
    } else if (block.kind === 'lecture') {
      lectureWallClockMinPerWeek += minutes;
    } else if (block.kind === 'reading' && onWorkDay) {
      reallocatableReadingMinPerWeek += Math.max(0, minutes - READING_SLOT_MIN_MINUTES);
    }
  }

  return {
    catchupWallClockMinPerWeek,
    lectureWallClockMinPerWeek,
    reallocatableReadingMinPerWeek,
  };
}

/* ---------------------------------------------------------------------- plan */

function clearedPlan(capacity: CatchUpCapacity, asOf: string): CatchUpPlan {
  return {
    tier: 'within_cap',
    headline: 'No lecture backlog. Nothing to catch up on.',
    steps: [],
    weeksToClear: 0,
    clearsBy: asOf.slice(0, 10),
    capacity,
    lecturesToDrop: 0,
  };
}

/**
 * Chooses the cheapest lever that clears the backlog inside the horizon.
 *
 * The levers are pulled in order and each one is spent only as far as it needs
 * to be, so a small backlog gets a small plan. Every wall-clock minute the plan
 * proposes comes from exactly two pools — the rest-day catch-up slots (capped)
 * and the work-day reading slack above 45 minutes — which is why no output of
 * this function can touch `active` or `timed_set` time.
 */
export function planCatchUp(args: {
  summary: BacklogSummary;
  blocks: DerivedBlock[];
  workDays: number[];
  playbackSpeed: number;
  /** Above this, comprehension collapses and the "plan" is a fiction. */
  maxPlaybackSpeed?: number;
  targetIso: string;
  asOf: string;
}): CatchUpPlan {
  const { summary, blocks, workDays, playbackSpeed, maxPlaybackSpeed, targetIso, asOf } = args;

  const capacity = summariseCatchUpCapacity(blocks, workDays);
  const backlogContentMin = Math.max(0, Math.round(summary.backlogContentMin));
  if (backlogContentMin === 0) return clearedPlan(capacity, asOf);

  // FORWARD-looking, so the ASSUMED speed, not `summary.rate.observedSpeed`.
  // The observed rate describes hours already spent; this plan is about hours
  // that have not happened yet, at the speed she intends to watch them.
  const baseSpeed = clampSpeed(playbackSpeed);
  const ceilingSpeed = Math.max(baseSpeed, clampSpeed(maxPlaybackSpeed ?? MAX_PLAYBACK_SPEED));

  // A target already past still gets a one-week horizon rather than a divide by
  // zero; the tiering then reports honestly that it cannot be done.
  const weeksToTarget = Math.max(0, daysBetween(asOf, targetIso) / 7);
  const horizonWeeks = Math.max(1, Math.min(CATCHUP_HORIZON_WEEKS, Math.ceil(weeksToTarget)));
  const neededContentPerWeek = backlogContentMin / horizonWeeks;

  const restDays = [0, 1, 2, 3, 4, 5, 6].filter((day) => !workDays.includes(day)).length;
  const catchupCap = capacity.catchupWallClockMinPerWeek;
  const readingSlack = capacity.reallocatableReadingMinPerWeek;

  const contentFor = (catchWall: number, readWall: number, speed: number) =>
    (catchWall + readWall) * speed;
  const enough = (content: number) => content + EPSILON >= neededContentPerWeek;

  // Lever 1 — the catch-up slots the planner already reserved, at her speed.
  let tier: CatchUpTier = 'within_cap';
  let speed = baseSpeed;
  let catchWall = Math.min(catchupCap, ceilTo(neededContentPerWeek / speed, STEP_ROUNDING_MIN));
  let readWall = 0;

  if (!enough(contentFor(catchWall, readWall, speed))) {
    // Lever 2 — raise playback. Buys content minutes without buying hours.
    tier = 'raise_speed';
    const wantedSpeed = catchupCap > 0 ? neededContentPerWeek / catchupCap : Infinity;
    speed = Math.min(ceilingSpeed, Math.max(baseSpeed, ceilTo(wantedSpeed, SPEED_INCREMENT)));
    catchWall = Math.min(catchupCap, ceilTo(neededContentPerWeek / speed, STEP_ROUNDING_MIN));

    if (!enough(contentFor(catchWall, readWall, speed))) {
      // Lever 3 — the only reducible block. Work-day reading only, never below
      // its 45-minute floor, and never a minute of answer writing.
      tier = 'reallocate_reading';
      speed = ceilingSpeed;
      catchWall = catchupCap;
      const shortfallContent = neededContentPerWeek - contentFor(catchWall, 0, speed);
      readWall = Math.min(readingSlack, ceilTo(shortfallContent / speed, STEP_ROUNDING_MIN));

      if (!enough(contentFor(catchWall, readWall, speed))) {
        // Lever 4 — there is no fifth lever. Saying so is the honest answer.
        tier = 'must_drop';
        readWall = readingSlack;
      }
    }
  }

  const contentPerWeek = contentFor(catchWall, readWall, speed);
  const steps: CatchUpStep[] = [];

  // Step order is part of the contract: the catch-up slot step is always first,
  // so its wall-clock can be read against the cap without guessing.
  if (catchWall > 0) {
    const perDay = restDays > 0 ? Math.round(catchWall / restDays) : catchWall;
    // Only claim the whole slot when it really is the whole slot. Telling her
    // a 40-minute ask has used up her capped catch-up time is the same lie as
    // proposing more than the cap, just in the other direction.
    const wholeSlot = catchWall >= catchupCap - EPSILON;
    steps.push({
      text:
        `Spend ${formatDuration(catchWall)} a week — about ${formatDuration(perDay)} on each of ` +
        `your ${restDays} ${plural(restDays, 'rest day', 'rest days')} — in the catch-up slot, ` +
        `on backlog lectures only. ` +
        (wholeSlot
          ? `That is the whole slot: it is capped so catch-up cannot quietly eat both your days off.`
          : `Your catch-up slot holds ${formatDuration(catchupCap)} a week, so the rest of your ` +
            `days off stay yours.`),
      wallClockMinPerWeek: Math.round(catchWall),
      contentMinPerWeek: Math.round(catchWall * baseSpeed),
    });
  }

  // `catchWall > 0` is load-bearing, not defensive. On a tight rest day the
  // planner's `allocate()` drops the catch-up slot entirely (it is last in
  // OFFDAY_SLOTS and takes whatever is left), so `catchupCap` can legitimately
  // be zero. Escalation still raises `speed` to the ceiling, and without this
  // guard the plan advised watching faster across zero minutes — "Same 0 min,
  // 0 more content-minutes a week", presented as a lever. Advice that does
  // nothing is worse than one fewer step, because it reads as progress.
  if (speed > baseSpeed + EPSILON && catchWall > 0) {
    steps.push({
      text:
        `Watch backlog lectures at ${formatSpeed(speed)} instead of ${formatSpeed(baseSpeed)}. ` +
        `Same ${formatDuration(catchWall)}, ${Math.round(catchWall * (speed - baseSpeed))} more ` +
        `content-minutes a week. ${formatSpeed(MAX_PLAYBACK_SPEED)} is the ceiling — past that ` +
        `you stop retaining what you watched.`,
      wallClockMinPerWeek: 0,
      contentMinPerWeek: Math.round(catchWall * (speed - baseSpeed)),
    });
  }

  if (readWall > 0) {
    steps.push({
      text:
        `Move ${formatDuration(readWall)} a week of weekday reading into lectures. Reading still ` +
        `gets its full ${READING_SLOT_MIN_MINUTES}-minute floor every working day, and answer ` +
        `writing and timed sets are not touched.`,
      wallClockMinPerWeek: Math.round(readWall),
      contentMinPerWeek: Math.round(readWall * speed),
    });
  }

  let lecturesToDrop = 0;
  let weeksToClear: number | null = null;

  if (tier === 'must_drop') {
    const clearable = contentPerWeek * horizonWeeks;
    const shortfall = Math.max(0, backlogContentMin - clearable);
    lecturesToDrop = Math.max(1, Math.ceil(shortfall / ASSUMED_LECTURE_CONTENT_MIN));
    steps.push({
      text:
        `Choose roughly ${lecturesToDrop} ${plural(lecturesToDrop, 'lecture', 'lectures')} to ` +
        `abandon outright — the ones furthest from your weakest papers. Every hour above what ` +
        `fits comes out of answer writing otherwise, and that is the one thing worth protecting.`,
      wallClockMinPerWeek: 0,
      contentMinPerWeek: 0,
    });
  } else if (contentPerWeek > 0) {
    weeksToClear = Math.max(1, Math.ceil(backlogContentMin / contentPerWeek));
  }

  const clearsBy = weeksToClear === null ? null : addDaysIso(asOf, weeksToClear * 7);
  const backlogLabel = formatDuration(backlogContentMin);

  let headline: string;
  if (tier === 'within_cap') {
    headline =
      weeksToClear === null
        ? `${backlogLabel} behind, and no catch-up time in your week to spend on it.`
        : `${backlogLabel} behind. Your catch-up slots clear it in ` +
          `${weeksToClear} ${plural(weeksToClear, 'week', 'weeks')} at ` +
          `${formatSpeed(baseSpeed)}, without touching anything else.`;
  } else if (tier === 'raise_speed') {
    headline =
      `${backlogLabel} behind — more than your catch-up slots hold at ${formatSpeed(baseSpeed)}. ` +
      `At ${formatSpeed(speed)} they clear it in ${weeksToClear} ` +
      `${plural(weeksToClear ?? 0, 'week', 'weeks')}, with no extra hours.`;
  } else if (tier === 'reallocate_reading') {
    headline =
      `${backlogLabel} behind. Catch-up plus ${formatSpeed(speed)} is not enough, so ` +
      `${formatDuration(readWall)} a week of weekday reading has to move to lectures — ` +
      `${weeksToClear} ${plural(weeksToClear ?? 0, 'week', 'weeks')} to clear.`;
  } else {
    headline =
      `${backlogLabel} behind, and it will not clear. Even at ${formatSpeed(speed)} with every ` +
      `spare reading minute, you are about ${lecturesToDrop} ` +
      `${plural(lecturesToDrop, 'lecture', 'lectures')} over what fits before ` +
      `${longDate(targetIso)}. Pick which ones go.`;
  }

  return { tier, headline, steps, weeksToClear, clearsBy, capacity, lecturesToDrop };
}
