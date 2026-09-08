/**
 * What to do today, decided rather than reported.
 *
 * ## The gap this closes
 *
 * Every card on the Today screen reports state: days remaining, blocks, hours,
 * what is due, what is banked. Not one of them decides anything. The app knows
 * 438 syllabus leaves, that one is touched, that the target is 204 days away and
 * that ~36 hours a week are available — and renders those as four numbers on
 * four cards. It never puts them together and says the obvious thing.
 *
 * This module says it.
 *
 * ## Pure, deliberately
 *
 * No `@/db/*`, no network, no `Date.now()`. Everything arrives in
 * `DecisionContext` and the output is a function of it — which is what makes the
 * one property that actually matters testable: calling this twice with the same
 * context must produce the same prescription. The card re-renders on focus and
 * on pull-to-refresh, and advice that changes between renders is advice she
 * cannot act on.
 *
 * ## What it refuses to do
 *
 * It never claims she is behind when there is no history to be behind against.
 * `projectFirstPass` already refuses to report a rate with no evidence, and this
 * module inherits that refusal rather than computing its own — a fresh install
 * telling her she is behind on day one is the false alarm that makes every later
 * true one ignorable.
 *
 * It also never prescribes more than `MENTOR_RULES.maxLeavesPerDay`. A
 * prescription of eight leaves is one she will not follow, and a prescription
 * she does not follow teaches her to distrust the next one.
 */

import { addDays, dayOf, daysBetween } from './days';
import { PAPERS, type PaperValue } from './papers';
import type { TopicFact } from './syllabus-coverage';

export const MENTOR_RULES = {
  /** Acts on the card, headline included. Beyond three it is a list again. */
  maxActs: 3,
  /** Leaves named in one day. Three is about one morning block. */
  maxLeavesPerDay: 3,
  minLeavesPerDay: 1,
  /** When a burnout finding is standing, the day shrinks to this. */
  restrainedLeavesPerDay: 1,
} as const;

/** A section heading, `${paper}:${topic}` — `coverageBySection`'s key exactly. */
export type SectionKey = string;

export interface DecisionLeaf {
  topicId: number;
  slug: string;
  label: string;
}

export type ActKind =
  | 'finish_open_drill'
  | 'retry_queued_answer'
  | 'revise_due'
  | 'continue_section'
  | 'start_section'
  | 'log_lecture_catalogue';

export interface DecisionAct {
  kind: ActKind;
  /** Imperative, one line. Rendered as written; never parsed. */
  title: string;
  /** Why THIS and not something else. One sentence. */
  because: string;
  /** An expo-router path, or null when the act has no screen of its own. */
  route: string | null;
  leaves: readonly DecisionLeaf[];
}

export interface Pace {
  remainingTopics: number;
  daysToTarget: number;
  /** Topics per day needed. `null` once the target date has passed. */
  requiredPerDay: number | null;
  /**
   * Topics per day actually achieved. `null` means NO HISTORY — never 0.
   *
   * The distinction is the whole point: zero would render as "you are doing
   * nothing", which on day one is both true and useless, and after a rest week
   * is a lie. Null renders as "no rate yet".
   */
  actualPerDay: number | null;
  sampleDays: number;
  /** Hours available per remaining topic. `null` when capacity is unknown. */
  hoursPerTopic: number | null;
  /** Only ever true when `actualPerDay` is non-null. Inherited, not computed. */
  behindTarget: boolean;
  /** Which date the arithmetic is against. Switches when the first pass lapses. */
  against: 'first_pass' | 'prelims';
  /** Where the current rate lands, `YYYY-MM-DD`. Null without a rate. */
  projectedDateIso: string | null;
}

export type DecisionState = 'no_syllabus' | 'fresh' | 'running' | 'complete';

export interface TodayDecision {
  state: DecisionState;
  /** Null only in `no_syllabus`, where every figure would be invented. */
  pace: Pace | null;
  headline: DecisionAct | null;
  /** At most `maxActs - 1`, and usually empty. */
  then: readonly DecisionAct[];
  /** Set when a burnout finding shrank the day. Rendered beside the act. */
  restraint: string | null;
}

export type BlockKind = string;

export interface DecisionContext {
  /** Local day in her timezone, from `lib/time.ts#localDate`. */
  today: string;
  targetFirstPassIso: string;
  prelimsIso: string;
  topics: readonly TopicFact[];
  /** Hours available between now and the target, from the derived plan. */
  projectedHours: number;
  /** Today's schedule. Only the kinds are read. */
  todayBlocks: readonly { kind: BlockKind }[];
  /**
   * Revision items due today, or `null` for NOT KNOWN YET.
   *
   * A parameter rather than a read, and nullable, because the Today screen
   * already computes `deck.totalDue`. A second count here would be a second
   * definition of "due today" on one screen, and two figures that can disagree
   * is a bug the backlog card has already shipped once. Null means the deck has
   * not resolved and the decision simply does not mention revision.
   */
  revisionDue: number | null;
  openDrill: { id: number; kind: string } | null;
  queuedAnswers: number;
  /** True when the server answered a health check. Gates the retry act. */
  serverReachable: boolean;
  lecturesLogged: number;
  /** The standing burnout suggestion, or null. Never overridden here. */
  burnoutSuggestion: string | null;
  /** Injected so tests can vary it. `FIRST_PASS_ORDER` in the app. */
  order: readonly string[];
  /** From `projectFirstPass`. Inherited whole — see `Pace.behindTarget`. */
  projection: {
    topicsPerDay: number;
    sampleDays: number;
    behindTarget: boolean;
    projectedDateIso: string | null;
  };
}

/* ------------------------------------------------------------------- pace */

function isPassed(fact: TopicFact): boolean {
  return fact.status === 'first_pass' || fact.status === 'revised';
}

function liveTopics(topics: readonly TopicFact[]): TopicFact[] {
  // Retired topics are excluded everywhere, and `syllabus-coverage.ts` owns
  // that decision. This mirrors it rather than re-litigating it: a decision
  // counting retired topics would prescribe work that is no longer examinable.
  return topics.filter((fact) => fact.retiredAt === null);
}

export function computePace(input: {
  topics: readonly TopicFact[];
  today: string;
  targetIso: string;
  prelimsIso: string;
  projectedHours: number;
  projection: DecisionContext['projection'];
}): Pace {
  const live = liveTopics(input.topics);
  const remainingTopics = live.filter((fact) => !isPassed(fact)).length;

  const today = dayOf(input.today);
  let against: Pace['against'] = 'first_pass';
  let daysToTarget = daysBetween(today, dayOf(input.targetIso));

  // The first-pass date lapsing is not hypothetical — it is 204 days out with
  // almost no slack. Designing the branch now beats patching it in March 2027,
  // and it is the difference between switching denominator silently and
  // dividing by zero on the screen she opens every morning.
  if (daysToTarget <= 0) {
    against = 'prelims';
    daysToTarget = Math.max(0, daysBetween(today, dayOf(input.prelimsIso)));
  }

  const requiredPerDay = daysToTarget > 0 ? remainingTopics / daysToTarget : null;

  // `sampleDays === 0` means nothing has ever been marked. `projectFirstPass`
  // already refuses to report a rate in that case; this converts its 0 into a
  // null so nothing downstream can render it as "zero topics a day".
  const hasHistory = input.projection.sampleDays > 0;
  const actualPerDay = hasHistory ? input.projection.topicsPerDay : null;

  return {
    remainingTopics,
    daysToTarget,
    requiredPerDay,
    actualPerDay,
    sampleDays: input.projection.sampleDays,
    hoursPerTopic:
      remainingTopics > 0 && input.projectedHours > 0
        ? input.projectedHours / remainingTopics
        : null,
    // Inherited, never recomputed. A second definition of "behind" is a second
    // thing that can disagree with the Progress screen.
    behindTarget: actualPerDay === null ? false : input.projection.behindTarget,
    against,
    projectedDateIso: actualPerDay === null ? null : input.projection.projectedDateIso,
  };
}

/* -------------------------------------------------------------- the section */

interface SectionSummary {
  sectionKey: SectionKey;
  paper: PaperValue;
  label: string;
  leaves: TopicFact[];
  inProgress: number;
  passed: number;
  total: number;
  /** Lowest printed position among the section's leaves. */
  position: number;
}

function summarise(topics: readonly TopicFact[]): SectionSummary[] {
  const grouped = new Map<SectionKey, TopicFact[]>();
  for (const fact of liveTopics(topics)) {
    const key = `${fact.paper}:${fact.topic}`;
    const bucket = grouped.get(key);
    if (bucket) bucket.push(fact);
    else grouped.set(key, [fact]);
  }

  const out: SectionSummary[] = [];
  for (const [sectionKey, leaves] of grouped) {
    out.push({
      sectionKey,
      paper: leaves[0]!.paper,
      label: leaves[0]!.topic,
      leaves,
      inProgress: leaves.filter((leaf) => leaf.status === 'in_progress').length,
      passed: leaves.filter(isPassed).length,
      total: leaves.length,
      // `TopicFact` carries no position, so identity order stands in. Rows come
      // from `topicFacts()` already sorted by printed position, so the first
      // leaf's id is a faithful proxy for where the section appears.
      position: Math.min(...leaves.map((leaf) => leaf.id)),
    });
  }
  return out;
}

/**
 * The section to work on, or null when the first pass is complete.
 *
 * The comparator is TOTAL — every pair is separated by some criterion, ending
 * in a string compare. Without that final tie-break, `Array.sort` stability
 * would be doing load-bearing work, and stability is not something to rely on
 * across engines for advice she is meant to trust.
 */
export function chooseSection(input: {
  topics: readonly TopicFact[];
  order: readonly string[];
}): SectionSummary | null {
  const rank = new Map(input.order.map((key, index) => [key, index] as const));
  const unfinished = summarise(input.topics).filter((section) => section.passed < section.total);
  if (unfinished.length === 0) return null;

  const paperRank = new Map(PAPERS.map((paper, index) => [paper.value, index] as const));

  unfinished.sort((a, b) => {
    // 1. Finish what is open before starting anything new. A trail of half-done
    //    sections is how a first pass never completes, and `db/drills.ts`
    //    already encodes the same rule for drills.
    const aOpen = a.inProgress > 0 ? 0 : 1;
    const bOpen = b.inProgress > 0 ? 0 : 1;
    if (aOpen !== bOpen) return aOpen - bOpen;

    // 2. Among open sections, the one closest to done.
    if (aOpen === 0) {
      const aShare = a.passed / a.total;
      const bShare = b.passed / b.total;
      if (aShare !== bShare) return bShare - aShare;
    }

    // 3. The declared opening order. Unlisted sections sort after listed ones,
    //    so a syllabus revision that adds a section ranks it last rather than
    //    breaking the comparator.
    const aRank = rank.get(a.sectionKey) ?? Number.MAX_SAFE_INTEGER;
    const bRank = rank.get(b.sectionKey) ?? Number.MAX_SAFE_INTEGER;
    if (aRank !== bRank) return aRank - bRank;

    // 4. Declared paper order, then 5. printed position, then 6. the key.
    const aPaper = paperRank.get(a.paper) ?? Number.MAX_SAFE_INTEGER;
    const bPaper = paperRank.get(b.paper) ?? Number.MAX_SAFE_INTEGER;
    if (aPaper !== bPaper) return aPaper - bPaper;
    if (a.position !== b.position) return a.position - b.position;
    return a.sectionKey.localeCompare(b.sectionKey);
  });

  return unfinished[0] ?? null;
}

/**
 * How many leaves to name today.
 *
 * Capped at three regardless of what the arithmetic asks for. When the required
 * rate is forty a day the honest response is to say the target is unreachable,
 * not to prescribe forty — a number she cannot act on is not advice.
 */
export function sizeToday(input: {
  requiredPerDay: number | null;
  todayBlocks: readonly { kind: BlockKind }[];
  restrained: boolean;
}): number {
  if (input.restrained) return MENTOR_RULES.restrainedLeavesPerDay;

  // A day with no study block is a work day. One leaf is a real ask; three is a
  // prescription that will be missed, and a missed prescription is worse than a
  // small one because it teaches her the card is not serious.
  const hasStudyBlock = input.todayBlocks.some(
    (block) => block.kind === 'active' || block.kind === 'reading' || block.kind === 'timed_set',
  );
  if (!hasStudyBlock) return MENTOR_RULES.minLeavesPerDay;

  const wanted = Math.ceil(input.requiredPerDay ?? MENTOR_RULES.minLeavesPerDay);
  return Math.min(
    MENTOR_RULES.maxLeavesPerDay,
    Math.max(MENTOR_RULES.minLeavesPerDay, Number.isFinite(wanted) ? wanted : 1),
  );
}

function toLeaves(section: SectionSummary, size: number): DecisionLeaf[] {
  // Not-started before in-progress is wrong here: an in-progress leaf is one she
  // has opened and not finished, and finishing it costs less than starting a new
  // one. Same argument as rule 1 in the comparator, one level down.
  const ordered = [...section.leaves]
    .filter((leaf) => !isPassed(leaf))
    .sort((a, b) => {
      const aOpen = a.status === 'in_progress' ? 0 : 1;
      const bOpen = b.status === 'in_progress' ? 0 : 1;
      if (aOpen !== bOpen) return aOpen - bOpen;
      return a.id - b.id;
    });

  return ordered.slice(0, size).map((leaf) => ({
    topicId: leaf.id,
    slug: leaf.slug,
    // The LEAF, falling back to the section only where the syllabus prints a
    // heading with no bullets. Using `topic` unconditionally is what rendered
    // "Indian Constitution" three times on the card's first run.
    label: leaf.subtopic ?? leaf.topic,
  }));
}

/* ---------------------------------------------------------------- the ladder */

function pluralLeaves(count: number): string {
  return count === 1 ? 'one topic' : `${count} topics`;
}

export function decideToday(ctx: DecisionContext): TodayDecision {
  // The syllabus has not seeded yet — a real frame on first launch. Rendering
  // "0 of 0 topics, 0.0 a day" here would be a confident wrong number, which is
  // the failure the lecture screen already shipped once as "Nothing outstanding"
  // on a failed read.
  if (liveTopics(ctx.topics).length === 0) {
    return { state: 'no_syllabus', pace: null, headline: null, then: [], restraint: null };
  }

  const pace = computePace({
    topics: ctx.topics,
    today: ctx.today,
    targetIso: ctx.targetFirstPassIso,
    prelimsIso: ctx.prelimsIso,
    projectedHours: ctx.projectedHours,
    projection: ctx.projection,
  });

  const restrained = ctx.burnoutSuggestion !== null;
  const size = sizeToday({
    requiredPerDay: pace.requiredPerDay,
    todayBlocks: ctx.todayBlocks,
    restrained,
  });

  const acts: DecisionAct[] = [];

  if (ctx.openDrill !== null) {
    acts.push({
      kind: 'finish_open_drill',
      title: 'Finish the drill you started',
      because: 'It is already open, and an abandoned drill is time spent for no mark.',
      route: `/drill/${ctx.openDrill.id}`,
      leaves: [],
    });
  }

  // Gated on reachability: prescribing a retry with no server is a lever that
  // does nothing, which is the failure the catch-up plan already had.
  if (ctx.queuedAnswers > 0 && ctx.serverReachable) {
    acts.push({
      kind: 'retry_queued_answer',
      title:
        ctx.queuedAnswers === 1
          ? 'Send the answer waiting to be marked'
          : `Send the ${ctx.queuedAnswers} answers waiting to be marked`,
      because: 'The server is reachable now, and an unmarked answer teaches nothing.',
      route: '/(tabs)/history',
      leaves: [],
    });
  }

  if (ctx.revisionDue !== null && ctx.revisionDue > 0) {
    acts.push({
      kind: 'revise_due',
      title: `Clear ${ctx.revisionDue} due for revision`,
      because: 'Revision decays if it slips; new coverage only waits.',
      route: '/(tabs)/revise',
      leaves: [],
    });
  }

  const section = chooseSection({ topics: ctx.topics, order: ctx.order });
  if (section !== null) {
    const leaves = toLeaves(section, size);
    const continuing = section.inProgress > 0 || section.passed > 0;
    acts.push({
      kind: continuing ? 'continue_section' : 'start_section',
      title: continuing ? `Continue ${section.label}` : `Start ${section.label}`,
      because: continuing
        ? section.inProgress > 0
          ? `${section.inProgress} open, ${section.passed} of ${section.total} done — finishing beats opening something new.`
          : `${section.passed} of ${section.total} done — finishing it beats opening something new.`
        : restrained
          ? 'One topic today. The pattern above is worth respecting.'
          : pace.actualPerDay === null
            ? `Nothing is marked yet. ${pluralLeaves(leaves.length)} is about one block.`
            : `${pluralLeaves(leaves.length)} today keeps the first pass on its date.`,
      route: `/syllabus/${section.paper}`,
      leaves,
    });
  }

  // Exactly one setup nudge, and only this one. The backlog tracker and the
  // catch-up plan are both dead until a lecture catalogue exists, so it is the
  // single piece of missing setup that disables a whole feature.
  if (ctx.lecturesLogged === 0) {
    acts.push({
      kind: 'log_lecture_catalogue',
      title: 'Log what your course has released',
      because: 'The backlog tracker cannot tell you anything until it knows the catalogue.',
      route: '/lecture/log',
      leaves: [],
    });
  }

  const state: DecisionState =
    pace.remainingTopics === 0
      ? 'complete'
      : pace.actualPerDay === null
        ? 'fresh'
        : 'running';

  const chosen = acts.slice(0, MENTOR_RULES.maxActs);
  return {
    state,
    pace,
    headline: chosen[0] ?? null,
    then: chosen.slice(1),
    restraint: ctx.burnoutSuggestion,
  };
}

/**
 * Where the current rate lands, as a day label — or null without a rate.
 *
 * Exposed so the card can lead with an achievable date rather than a shortfall.
 * "At your current rate the first pass lands in August 2027" and "you are 1.7
 * topics a day short" are the same fact, and only one of them is an accusation
 * repeated every morning.
 */
export function achievableDate(pace: Pace, today: string): string | null {
  if (pace.actualPerDay === null || pace.actualPerDay <= 0) return null;
  if (pace.projectedDateIso !== null) return pace.projectedDateIso;
  return addDays(dayOf(today), Math.ceil(pace.remainingTopics / pace.actualPerDay));
}
