/**
 * Gathering what the decision engine needs.
 *
 * The impure half of the pair — `lib/today-decision.ts` is the pure half and
 * holds every rule. This file does reads and nothing else: no arithmetic, no
 * ordering, no thresholds. The split is the same one `steady-context.ts` and
 * `notify-plan.ts` already use, and it is what makes the decision testable at
 * all, since anything importing `@/db/*` cannot load under Node.
 *
 * ## Every read degrades on its own
 *
 * Each query is individually wrapped and falls back to a value the engine reads
 * as "not known". One broken query must cost one number, never the whole card —
 * a decision card that says "nothing to do" because a count threw is worse than
 * one missing a line, because the first is indistinguishable from a real answer.
 *
 * ## What is NOT read here
 *
 * `revisionDue` is a parameter of `decideToday`, not a read. The Today screen
 * already computes `deck.totalDue` through `buildDeck`, and a second count here
 * would be a second definition of "due today" on one screen. Two figures that
 * can disagree is a bug this app has already shipped once.
 *
 * `projectedHours` likewise arrives from the derived plan the screen already
 * holds. Recomputing it would be a second answer to a question already answered
 * six lines up the same file.
 */

import { count, eq, inArray } from 'drizzle-orm';

import { db } from './index';
import { readActivityEvents } from './activity';
import { topicFacts } from './syllabus';
import { answers, drills, lectures } from './schema';
import { activityByDay, dayRange, type ActivityEvent } from '@/lib/activity';
import { detectBurnout } from '@/lib/burnout';
import { FIRST_PASS_ORDER } from '@/data/first-pass-order';
import { addDays } from '@/lib/days';
import { projectFirstPass, type TopicFact } from '@/lib/syllabus-coverage';
import type { DecisionContext } from '@/lib/today-decision';

/**
 * Runs a read, returning `fallback` if it throws.
 *
 * Copied in spirit from `steady-context.ts#count`. The catch is deliberate and
 * total: the caller cannot do anything useful with a failed count except leave
 * that line off the card.
 */
async function safely<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

/** Statuses that mean an answer is captured but not yet marked. */
const UNMARKED: readonly string[] = ['pending', 'queued', 'failed'];

/** Enough history for `detectBurnout` to have anything to say. */
const BURNOUT_WINDOW_DAYS = 28;

export interface BuildContextInput {
  /** Local day in her timezone. Byte-compared, never re-parsed. */
  today: string;
  timezone: string;
  targetFirstPassIso: string;
  prelimsIso: string;
  /** From the derived plan the screen already holds. */
  projectedHours: number;
  todayBlocks: readonly { kind: string }[];
  /** `null` means the deck has not resolved yet — see the header. */
  revisionDue: number | null;
  /** Whether the last health check succeeded. Gates the retry act. */
  serverReachable: boolean;
}

export async function buildDecisionContext(input: BuildContextInput): Promise<DecisionContext> {
  const topics: TopicFact[] = await safely(() => topicFacts(), []);

  const openDrill = await safely(async () => {
    const rows = await db
      .select({ id: drills.id, kind: drills.kind })
      .from(drills)
      .where(eq(drills.status, 'in_progress'))
      .limit(1);
    return rows[0] ?? null;
  }, null);

  const queuedAnswers = await safely(async () => {
    const rows = await db
      .select({ n: count() })
      .from(answers)
      .where(inArray(answers.syncStatus, [...UNMARKED]));
    return rows[0]?.n ?? 0;
  }, 0);

  const lecturesLogged = await safely(async () => {
    const rows = await db.select({ n: count() }).from(lectures);
    return rows[0]?.n ?? 0;
  }, 0);

  /**
   * The burnout suggestion, or null.
   *
   * Null on ANY failure, and that is the safe direction: a missing finding
   * costs a restraint that would have shrunk the day, while a spurious one
   * would shrink every day for a reason that does not exist.
   */
  const burnoutSuggestion = await safely(async () => {
    const events: ActivityEvent[] = await readActivityEvents({
      since: addDays(input.today, -BURNOUT_WINDOW_DAYS),
      timezone: input.timezone,
    });
    // `dayRange` supplies the gaps: an inactive day must be present as a day
    // with no work, not absent. `detectBurnout` counts consecutive days, and a
    // missing day would silently join the two either side of it.
    const days = activityByDay(events, dayRange(input.today, BURNOUT_WINDOW_DAYS));
    // `scoreFractions` deliberately omitted: the absorption check must stay
    // silent rather than run on nothing, which is what the option's own comment
    // says. Wiring real scores in is a follow-up, not a default.
    const finding = detectBurnout({ days });
    return finding?.suggestion ?? null;
  }, null);

  /**
   * Inherited whole, never recomputed.
   *
   * `projectFirstPass` already refuses to report a rate with no evidence, and
   * that refusal is the property keeping a fresh install from being told it is
   * behind on day one. A second definition of "behind" here is a second thing
   * that can disagree with the Progress screen.
   */
  const projection = projectFirstPass(topics, {
    asOf: input.today,
    targetIso: input.targetFirstPassIso,
  });

  return {
    today: input.today,
    targetFirstPassIso: input.targetFirstPassIso,
    prelimsIso: input.prelimsIso,
    topics,
    projectedHours: input.projectedHours,
    todayBlocks: input.todayBlocks,
    revisionDue: input.revisionDue,
    openDrill,
    queuedAnswers,
    serverReachable: input.serverReachable,
    lecturesLogged,
    burnoutSuggestion,
    order: FIRST_PASS_ORDER,
    projection: {
      topicsPerDay: projection.topicsPerDay,
      sampleDays: projection.sampleDays,
      behindTarget: projection.behindTarget,
      projectedDateIso: projection.projectedDateIso,
    },
  };
}

/** Re-exported so the screen imports one module rather than two. */
export type { DecisionContext };
