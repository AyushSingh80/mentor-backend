/**
 * Syllabus coverage. Pure — no RN, no expo-sqlite.
 *
 * SKELETON: types are FROZEN. Bodies are owned by the syllabus agent.
 *
 * ## Why coverage is reported per section, not only per paper
 *
 * The official syllabus at leaf granularity is roughly 380–450 bullets. One
 * completed leaf therefore moves a paper's coverage by about 0.22 points,
 * which renders as no movement at all. A tracker that never visibly moves is a
 * tracker she stops opening. Grouping by `(paper, topic)` — the section — gives
 * units small enough to show progress and large enough to mean something.
 *
 * ## Retired topics
 *
 * Rows with `retiredAt` set are excluded from every total. Including them
 * permanently depresses coverage with topics that are no longer examinable.
 *
 * ## Essay
 *
 * Essay has no official syllabus. Its entries are past-paper thematic clusters
 * and the UI must say so — "Essay 40% covered" otherwise asserts something the
 * user will reasonably misread as official.
 */

import { PAPERS, type PaperValue } from '@/lib/papers';

/**
 * Two weeks, matching `BACKLOG_RULES.rateWindowDays`.
 *
 * The two cards sit on the same screen. If one measured over 14 days and the
 * other over 28, they could disagree about whether the last fortnight went
 * well — and two numbers contradicting each other is worse than either being
 * slightly wrong, because she stops believing both.
 */
const DEFAULT_WINDOW_DAYS = 14;

export type TopicStatus = 'not_started' | 'in_progress' | 'first_pass' | 'revised';

export interface TopicFact {
  id: number;
  slug: string;
  paper: PaperValue;
  /** The SECTION heading. `coverageBySection` groups on it. */
  topic: string;
  /**
   * The leaf — the bullet printed under the section heading.
   *
   * Absent from this type until the decision card needed it, which is why the
   * card's first render on a device named the same section three times instead
   * of three topics. Every screen before it displayed coverage at section level
   * and never had cause to notice.
   *
   * Null where the syllabus prints a section with no bullets under it, so a
   * caller must fall back to `topic` rather than render an empty line.
   */
  subtopic?: string | null;
  status: TopicStatus;
  confidence: number | null;
  firstPassAt: string | null;
  retiredAt: string | null;
}

export interface Coverage {
  key: string;
  label: string;
  total: number;
  notStarted: number;
  inProgress: number;
  firstPass: number;
  revised: number;
  /** 0–100. Counts both `first_pass` and `revised` — revised implies passed. */
  percentFirstPass: number;
  percentRevised: number;
  meanConfidence: number | null;
}

export interface MilestoneProjection {
  targetIso: string;
  /** Topics reaching first pass per day, over the recent window. */
  topicsPerDay: number;
  /** How many days at the current rate. `null` when nothing is moving. */
  daysToFirstPass: number | null;
  projectedDateIso: string | null;
  /** True when the projection lands after the target. */
  behindTarget: boolean;
  remainingTopics: number;
  sampleDays: number;
}

/**
 * A calendar day, `YYYY-MM-DD`.
 *
 * Timestamps here are full ISO-8601 strings written by JS (see the note in
 * `schema.ts`); dates are the first ten characters of one. Every comparison in
 * this module is byte-wise on that ten-character prefix and never goes through
 * `Date` parsing, so a same-day comparison cannot be inverted by a format
 * mismatch.
 */
function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

/** UTC midnight of a `YYYY-MM-DD`, in ms. Only ever used to difference two days. */
function dayMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

const MS_PER_DAY = 86_400_000;

/** Whole days from `from` to `to`. Negative when `to` precedes `from`. */
function daysBetween(from: string, to: string): number {
  const a = dayMs(from);
  const b = dayMs(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / MS_PER_DAY);
}

function addDays(day: string, count: number): string {
  const base = dayMs(day);
  if (!Number.isFinite(base)) return day;
  return new Date(base + count * MS_PER_DAY).toISOString().slice(0, 10);
}

/** A topic already at first pass. `revised` implies it, so both count. */
function hasPassed(fact: TopicFact): boolean {
  return fact.status === 'first_pass' || fact.status === 'revised';
}

/**
 * Retired topics are excluded from every total, everywhere, and this is the one
 * function that decides it. Including them permanently depresses coverage with
 * topics that are no longer examinable.
 */
function live(facts: TopicFact[]): TopicFact[] {
  return facts.filter((fact) => fact.retiredAt === null);
}

function tally(key: string, label: string, facts: TopicFact[]): Coverage {
  let notStarted = 0;
  let inProgress = 0;
  let firstPass = 0;
  let revised = 0;
  let confidenceSum = 0;
  let confidenceCount = 0;

  for (const fact of facts) {
    if (fact.status === 'revised') revised += 1;
    else if (fact.status === 'first_pass') firstPass += 1;
    else if (fact.status === 'in_progress') inProgress += 1;
    else notStarted += 1;

    // Only topics she has actually rated. Averaging unrated topics as zero
    // would make an untouched paper look like a paper she is failing at.
    if (fact.confidence !== null) {
      confidenceSum += fact.confidence;
      confidenceCount += 1;
    }
  }

  const total = facts.length;

  return {
    key,
    label,
    total,
    notStarted,
    inProgress,
    firstPass,
    revised,
    // `revised` implies a first pass was made, so it counts toward both.
    percentFirstPass: total === 0 ? 0 : ((firstPass + revised) / total) * 100,
    percentRevised: total === 0 ? 0 : (revised / total) * 100,
    meanConfidence: confidenceCount === 0 ? null : confidenceSum / confidenceCount,
  };
}

/**
 * One row per paper, in the order `PAPERS` declares.
 *
 * A paper with no live topics is omitted rather than reported as 0% — a paper
 * that is not in the dataset has no coverage, and "0% covered" is a different
 * and untrue claim. `key` is the `PaperValue`, so a caller can navigate from it.
 */
export function coverageByPaper(facts: TopicFact[]): Coverage[] {
  const grouped = new Map<PaperValue, TopicFact[]>();
  for (const fact of live(facts)) {
    const bucket = grouped.get(fact.paper);
    if (bucket) bucket.push(fact);
    else grouped.set(fact.paper, [fact]);
  }

  const out: Coverage[] = [];
  for (const paper of PAPERS) {
    const bucket = grouped.get(paper.value);
    if (bucket) out.push(tally(paper.value, paper.label, bucket));
  }
  return out;
}

/**
 * One row per section within a paper, in first-appearance order.
 *
 * This is the unit the whole module exists for. At 438 leaves one topic moves a
 * paper by 0.23 points and renders as no movement at all; the same topic moves
 * its section by several points, which is visible. Order follows the caller's
 * array, which the repository sorts by `position` — the printed syllabus order.
 */
export function coverageBySection(facts: TopicFact[], paper: PaperValue): Coverage[] {
  const grouped = new Map<string, TopicFact[]>();
  for (const fact of live(facts)) {
    if (fact.paper !== paper) continue;
    const bucket = grouped.get(fact.topic);
    if (bucket) bucket.push(fact);
    else grouped.set(fact.topic, [fact]);
  }

  // `key` is namespaced by paper so it stays unique if two papers' sections are
  // ever rendered in one list.
  return [...grouped.entries()].map(([topic, bucket]) => tally(`${paper}:${topic}`, topic, bucket));
}

/**
 * How the first full pass is tracking against 31 March 2027.
 *
 * The rate is measured over a recent window rather than over all history,
 * because a rate averaged since day one keeps quoting the enthusiasm of week
 * one for months after it ended.
 *
 * `sampleDays` is reported honestly, exactly as the backlog module does: it is
 * the history actually available, not the window asked for. With six days of
 * data, dividing by twenty-eight would quarter the rate and quadruple the
 * projection — terrifying her in week one, when the app is still earning trust.
 */
export function projectFirstPass(
  facts: TopicFact[],
  opts: { asOf: string; targetIso: string; windowDays?: number },
): MilestoneProjection {
  const asOf = dayOf(opts.asOf);
  const targetIso = dayOf(opts.targetIso);
  const windowDays =
    Number.isFinite(opts.windowDays) && (opts.windowDays ?? 0) > 0
      ? Math.floor(opts.windowDays as number)
      : DEFAULT_WINDOW_DAYS;

  const rows = live(facts);
  const remainingTopics = rows.filter((fact) => !hasPassed(fact)).length;

  // The evidence: topics currently at first pass that carry a date. A topic
  // demoted back to `in_progress` is deliberately not evidence of a pass held.
  const passDays: string[] = [];
  for (const fact of rows) {
    if (!hasPassed(fact) || fact.firstPassAt === null) continue;
    passDays.push(dayOf(fact.firstPassAt));
  }

  // Inclusive window: `windowDays` of 14 covers today and the thirteen before.
  const windowStart = addDays(asOf, -(windowDays - 1));
  const passedInWindow = passDays.filter((day) => day >= windowStart && day <= asOf).length;

  // How much history exists at all, capped at the window. Zero when nothing has
  // ever been marked — and that zero is what stops the division below.
  let earliest: string | null = null;
  for (const day of passDays) if (earliest === null || day < earliest) earliest = day;
  const historyDays = earliest === null ? 0 : Math.max(0, daysBetween(earliest, asOf) + 1);
  const sampleDays = Math.min(windowDays, historyDays);

  const topicsPerDay = sampleDays > 0 ? passedInWindow / sampleDays : 0;

  let daysToFirstPass: number | null;
  let projectedDateIso: string | null;

  if (remainingTopics === 0) {
    // Already done. Not "no rate" — there is simply nothing left to project.
    daysToFirstPass = 0;
    projectedDateIso = asOf;
  } else if (topicsPerDay > 0) {
    daysToFirstPass = Math.ceil(remainingTopics / topicsPerDay);
    projectedDateIso = addDays(asOf, daysToFirstPass);
  } else {
    // Never Infinity and never 0 — both render as a number the user would read
    // as a claim. `null` is the honest answer and the card renders it in words.
    daysToFirstPass = null;
    projectedDateIso = null;
  }

  return {
    targetIso,
    topicsPerDay,
    daysToFirstPass,
    projectedDateIso,
    // Deliberately false when there is no projection at all. A fresh install has
    // moved nothing, and firing "behind target" on day one is the false alarm
    // that makes every later true one ignorable. The card says "nothing has
    // moved yet" instead, which is louder and honest.
    behindTarget: projectedDateIso !== null && projectedDateIso > targetIso,
    remainingTopics,
    sampleDays,
  };
}
