/**
 * Lecture backlog measurement. Pure — no RN, no expo-sqlite.
 *
 * SKELETON: types and constants are FROZEN. Bodies are owned by the backlog agent.
 *
 * ## The unit rule, which is the whole correctness story here
 *
 * Every quantity carries its unit in its name, because the one bug that will
 * silently ruin this feature is confusing CONTENT minutes with WALL-CLOCK
 * minutes. A backlog is a sum of `runtimeMin` — content at 1x. Watching at
 * 1.5x means 600 content-minutes cost 400 wall-clock minutes. Mixing them
 * produces a number that is wrong by exactly the playback speed: 33–50% off,
 * with no crash and no error, in the single figure this whole phase exists to
 * produce.
 *
 * Playback speed therefore enters the BACKWARD-looking rate only as observed
 * throughput — if she watches faster, she clears more content-minutes per day
 * and the measured rate already says so. The assumed `defaultPlaybackSpeed`
 * belongs only to the FORWARD-looking catch-up plan, where there is nothing to
 * observe yet.
 *
 * ## Skipped is not watched
 *
 * A skipped lecture LEAVES the backlog but must NOT enter the rate numerator:
 * it cleared without consuming time. Counting it inflates the rate and makes
 * days-to-clear optimistic exactly when she has just admitted she cannot keep
 * up. See `lectures.skippedOn` in the schema.
 *
 * ## Dates
 *
 * All comparisons are byte-wise on `YYYY-MM-DD` strings, never via `Date`.
 * The schema header documents what mixing timestamp formats does to a same-day
 * comparison; this module must not reintroduce it.
 */

import { COURSES, type CourseId } from '@/lib/papers';

export type { CourseId };

export interface LectureFact {
  id: number;
  course: CourseId;
  /** CONTENT minutes at 1x. */
  runtimeMin: number;
  releasedOn: string;
  watchedOn: string | null;
  skippedOn: string | null;
  playbackSpeed: number | null;
}

export interface BacklogSeriesPoint {
  date: string;
  releasedContentMin: number;
  watchedContentMin: number;
  skippedContentMin: number;
  /** Cumulative, never negative. */
  backlogContentMin: number;
}

export interface WatchRate {
  /** The window asked for. */
  windowDays: number;
  /**
   * The window actually covered by data. Distinct from `windowDays` on
   * purpose: with six days of history, dividing by fourteen halves the rate
   * and doubles days-to-clear — terrifying her in week one, precisely when the
   * app is trying to earn trust. Always display this.
   */
  sampleDays: number;
  contentMinPerDay: number;
  wallClockMinPerDay: number;
  observedSpeed: number | null;
}

export interface BacklogSummary {
  course: CourseId | 'all';
  asOf: string;
  releasedContentMin: number;
  watchedContentMin: number;
  skippedContentMin: number;
  backlogContentMin: number;
  rate: WatchRate;
  /** `null` when nothing was watched in the window — never `Infinity`. */
  daysToClear: number | null;
  /** From the catalogue total and the days remaining. Available on day one. */
  requiredContentMinPerDay: number | null;
  series: BacklogSeriesPoint[];
}

export interface BacklogAlert {
  fired: boolean;
  reason: 'growing' | 'behind_required_rate' | null;
  /** Counts back until a non-growth week, so the copy escalates rather than repeating. */
  consecutiveGrowthWeeks: number;
  samples: { date: string; backlogContentMin: number }[];
  growthContentMin: number;
  suppressedBy: 'insufficient_history' | 'single_release_date' | 'backlog_too_small' | null;
}

/**
 * Tunable in one place so the thresholds are testable rather than scattered.
 *
 * `rateWindowDays` equals `alertWeeks × 7` deliberately. If the rate were
 * measured over 28 days, the banner could say "your backlog has grown two
 * weeks running" while the number beside it still looked healthy, because half
 * its window predates the slowdown. Two numbers on one card contradicting each
 * other is worse than either being slightly wrong — she stops believing both.
 */
export const BACKLOG_RULES = {
  rateWindowDays: 14,
  alertWeeks: 2,
  /** Below this the alert is trivially true for every new user in week three. */
  minHistoryDays: 21,
  minBacklogContentMin: 120,
  minGrowthContentMin: 60,
  minGrowthFraction: 0.05,
  /** Stops a one-day bulk catalogue import reading as a two-week slowdown. */
  minDistinctReleaseDates: 3,
} as const;

/* ------------------------------------------------------------------ calendar */

/**
 * Calendar arithmetic without `Date`.
 *
 * `Date` is avoided outright rather than used carefully. `new Date('2026-03-15')`
 * parses as UTC midnight while `new Date(2026, 2, 15)` parses as local midnight,
 * so any code mixing the two drifts by a day either side of the date line — and
 * the drift is invisible in a test run in UTC. Hinnant's civil-days algorithm is
 * exact, total, and has no timezone to get wrong. Comparisons stay byte-wise on
 * the strings; only *arithmetic* goes through these.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Guards a corrupt `toIso` from spinning a day-by-day loop forever. */
const MAX_SERIES_DAYS = 3700;

/** How much history `summariseBacklog` hands the chart: two months of context. */
const SUMMARY_SERIES_DAYS = 56;

function daysFromCivil(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

function civilFromDays(dayNumber: number): { year: number; month: number; day: number } {
  const z = dayNumber + 719468;
  const era = Math.floor(z / 146097);
  const dayOfEra = z - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) /
      365,
  );
  const y = yearOfEra + era * 400;
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const mp = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  return { year: y + (month <= 2 ? 1 : 0), month, day };
}

function fromDayNumber(dayNumber: number): string {
  const { year, month, day } = civilFromDays(dayNumber);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** `null` for anything that is not a real `YYYY-MM-DD` date. */
function toDayNumber(iso: unknown): number | null {
  if (typeof iso !== 'string' || !ISO_DATE.test(iso)) return null;
  const dayNumber = daysFromCivil(
    Number(iso.slice(0, 4)),
    Number(iso.slice(5, 7)),
    Number(iso.slice(8, 10)),
  );
  // Only a real date round-trips, which is what rejects 2026-02-31 and 2026-13-01.
  return fromDayNumber(dayNumber) === iso ? dayNumber : null;
}

function isIsoDate(value: unknown): value is string {
  return toDayNumber(value) !== null;
}

function addDaysIso(iso: string, days: number): string | null {
  const dayNumber = toDayNumber(iso);
  return dayNumber === null ? null : fromDayNumber(dayNumber + days);
}

function daysBetween(fromIso: string, toIso: string): number | null {
  const from = toDayNumber(fromIso);
  const to = toDayNumber(toIso);
  return from === null || to === null ? null : to - from;
}

/** 0 = Sunday. Epoch day 0 (1970-01-01) was a Thursday. */
function dayOfWeekOf(dayNumber: number): number {
  return (((dayNumber + 4) % 7) + 7) % 7;
}

/** The most recent `dayOfWeek` on or before `iso`; `iso` itself if it matches. */
function mostRecentDayOfWeek(iso: string, dayOfWeek: number): string | null {
  const dayNumber = toDayNumber(iso);
  if (dayNumber === null || !Number.isFinite(dayOfWeek)) return null;
  const target = (((Math.trunc(dayOfWeek) % 7) + 7) % 7);
  const back = (dayOfWeekOf(dayNumber) - target + 7) % 7;
  return fromDayNumber(dayNumber - back);
}

/* ------------------------------------------------------------------- facts */

/**
 * A fact with its units settled once, so no downstream arithmetic has to think
 * about them again.
 *
 * `skippedOn` wins over `watchedOn` when a row somehow carries both: a skip is
 * an admission that the lecture will not be watched, and resolving the conflict
 * the other way would put time she never spent into the rate numerator. The
 * conservative direction is the one that never flatters the number.
 */
interface NormalFact {
  course: CourseId;
  /** CONTENT minutes at 1x. */
  runtimeMin: number;
  releasedOn: string;
  /** `null` whenever the lecture was skipped — skipped is not watched. */
  watchedOn: string | null;
  skippedOn: string | null;
  /** WALL-CLOCK minutes the watch actually consumed: `runtimeMin / speed`. */
  wallClockMin: number;
  playbackSpeed: number | null;
}

function normalise(facts: readonly LectureFact[], course?: CourseId): NormalFact[] {
  const out: NormalFact[] = [];

  for (const fact of facts) {
    if (course !== undefined && fact.course !== course) continue;
    // A row with no placeable release date cannot be put on the timeline at
    // all; including it would move the total without moving the trend.
    if (!isIsoDate(fact.releasedOn)) continue;

    const runtimeMin =
      typeof fact.runtimeMin === 'number' && Number.isFinite(fact.runtimeMin) && fact.runtimeMin > 0
        ? fact.runtimeMin
        : 0;

    const skippedOn = isIsoDate(fact.skippedOn) ? fact.skippedOn : null;
    const watchedOn = skippedOn === null && isIsoDate(fact.watchedOn) ? fact.watchedOn : null;

    // A zero, negative or NaN speed would divide the wall-clock figure into
    // nonsense. Unknown means 1x: never assume she went faster than recorded.
    const speed =
      typeof fact.playbackSpeed === 'number' &&
      Number.isFinite(fact.playbackSpeed) &&
      fact.playbackSpeed > 0
        ? fact.playbackSpeed
        : null;

    out.push({
      course: fact.course,
      runtimeMin,
      releasedOn: fact.releasedOn,
      watchedOn,
      skippedOn,
      wallClockMin: runtimeMin / (speed ?? 1),
      playbackSpeed: speed,
    });
  }

  return out;
}

/** Standing backlog on `iso`, in CONTENT minutes. Comparisons are byte-wise. */
function backlogAt(facts: readonly NormalFact[], iso: string): number {
  let released = 0;
  let cleared = 0;

  for (const fact of facts) {
    if (fact.releasedOn <= iso) released += fact.runtimeMin;
    if (fact.watchedOn !== null && fact.watchedOn <= iso) cleared += fact.runtimeMin;
    else if (fact.skippedOn !== null && fact.skippedOn <= iso) cleared += fact.runtimeMin;
  }

  return Math.max(0, released - cleared);
}

function earliestReleasedOn(facts: readonly NormalFact[], onOrBefore: string): string | null {
  let earliest: string | null = null;
  for (const fact of facts) {
    if (fact.releasedOn > onOrBefore) continue;
    if (earliest === null || fact.releasedOn < earliest) earliest = fact.releasedOn;
  }
  return earliest;
}

/**
 * Days from the first lecture she ever logged to `asOf`. `-1` when there is no
 * history at all, so it can never clear `minHistoryDays`.
 */
function logSpansDays(facts: readonly NormalFact[], asOf: string): number {
  const first = earliestReleasedOn(facts, asOf);
  if (first === null) return -1;
  return daysBetween(first, asOf) ?? -1;
}

function distinctReleaseDates(facts: readonly NormalFact[], fromIso: string, toIso: string): number {
  const dates = new Set<string>();
  for (const fact of facts) {
    if (fact.releasedOn >= fromIso && fact.releasedOn <= toIso) dates.add(fact.releasedOn);
  }
  return dates.size;
}

/**
 * Did the backlog grow by enough to be worth saying out loud?
 *
 * Both floors matter. The absolute one stops a rounding-sized wobble reading as
 * a slowdown; the fractional one stops a 60-minute drift on a 40-hour backlog —
 * noise at that size — from firing every week.
 */
function grew(earlierContentMin: number, laterContentMin: number): boolean {
  const floor = Math.max(
    BACKLOG_RULES.minGrowthContentMin,
    BACKLOG_RULES.minGrowthFraction * earlierContentMin,
  );
  return laterContentMin - earlierContentMin >= floor;
}

/** Weeks of unbroken growth ending at `w0`, counting back until a week that did not. */
function countGrowthWeeks(facts: readonly NormalFact[], w0: string): number {
  let weeks = 0;
  let laterIso = w0;
  let later = backlogAt(facts, w0);

  // Terminates on its own once it walks off the start of the log — two zero
  // samples cannot clear `minGrowthContentMin` — but is bounded anyway.
  for (let step = 0; step < 104; step += 1) {
    const earlierIso = addDaysIso(laterIso, -7);
    if (earlierIso === null) break;
    const earlier = backlogAt(facts, earlierIso);
    if (!grew(earlier, later)) break;
    weeks += 1;
    laterIso = earlierIso;
    later = earlier;
  }

  return weeks;
}

/* ------------------------------------------------------------------ series */

export function buildBacklogSeries(
  facts: LectureFact[],
  fromIso: string,
  toIso: string,
): BacklogSeriesPoint[] {
  const from = toDayNumber(fromIso);
  const to = toDayNumber(toIso);
  if (from === null || to === null || to < from) return [];

  const list = normalise(facts);
  const released = new Map<string, number>();
  const watched = new Map<string, number>();
  const skipped = new Map<string, number>();

  const add = (into: Map<string, number>, key: string, value: number) => {
    into.set(key, (into.get(key) ?? 0) + value);
  };

  for (const fact of list) {
    add(released, fact.releasedOn, fact.runtimeMin);
    if (fact.watchedOn !== null) add(watched, fact.watchedOn, fact.runtimeMin);
    if (fact.skippedOn !== null) add(skipped, fact.skippedOn, fact.runtimeMin);
  }

  const dayNet = (date: string) =>
    (released.get(date) ?? 0) - (watched.get(date) ?? 0) - (skipped.get(date) ?? 0);

  /**
   * Everything before the window folded into an opening balance, so a chart
   * that starts mid-history shows the backlog she actually has rather than one
   * that helpfully restarts at zero. Only dates carrying an event can move the
   * total, so the seed walks those rather than every intervening day; the
   * default string sort is chronological for `YYYY-MM-DD`.
   */
  let running = 0;
  const seedDates = [
    ...new Set([...released.keys(), ...watched.keys(), ...skipped.keys()]),
  ]
    .filter((date) => date < fromIso)
    .sort();
  for (const date of seedDates) running = Math.max(0, running + dayNet(date));

  const out: BacklogSeriesPoint[] = [];
  const lastOffset = Math.min(to - from, MAX_SERIES_DAYS - 1);

  for (let offset = 0; offset <= lastOffset; offset += 1) {
    const date = fromDayNumber(from + offset);
    const releasedContentMin = released.get(date) ?? 0;
    const watchedContentMin = watched.get(date) ?? 0;
    const skippedContentMin = skipped.get(date) ?? 0;

    // Clamped on the RUNNING total, not just on the emitted value: a total left
    // sitting at -300 would silently swallow the next five hours of releases.
    running = Math.max(0, running + releasedContentMin - watchedContentMin - skippedContentMin);

    out.push({
      date,
      releasedContentMin,
      watchedContentMin,
      skippedContentMin,
      backlogContentMin: running,
    });
  }

  return out;
}

/* ------------------------------------------------------------------- rate */

/**
 * Observed throughput over the last `rateWindowDays`, or over however much
 * history exists — whichever is shorter.
 *
 * The numerator is CONTENT minutes of lectures WATCHED. Skipped lectures are
 * absent by construction (`normalise` nulls their `watchedOn`), because a skip
 * clears the backlog without consuming any time.
 */
function watchRate(
  facts: readonly NormalFact[],
  asOf: string,
  firstReleasedOn: string | null,
): WatchRate {
  const windowDays = BACKLOG_RULES.rateWindowDays;
  const idle: WatchRate = {
    windowDays,
    sampleDays: 0,
    contentMinPerDay: 0,
    wallClockMinPerDay: 0,
    observedSpeed: null,
  };
  if (firstReleasedOn === null) return idle;

  const windowFloor = addDaysIso(asOf, -(windowDays - 1));
  if (windowFloor === null) return idle;

  let startIso = firstReleasedOn > windowFloor ? firstReleasedOn : windowFloor;
  if (startIso > asOf) startIso = asOf;
  const sampleDays = Math.max(1, (daysBetween(startIso, asOf) ?? 0) + 1);

  let contentMin = 0;
  let wallClockMin = 0;
  for (const fact of facts) {
    if (fact.watchedOn === null) continue;
    if (fact.watchedOn < startIso || fact.watchedOn > asOf) continue;
    contentMin += fact.runtimeMin;
    wallClockMin += fact.wallClockMin;
  }

  return {
    windowDays,
    sampleDays,
    contentMinPerDay: contentMin / sampleDays,
    wallClockMinPerDay: wallClockMin / sampleDays,
    // The conversion itself, measured rather than assumed: content over the
    // wall-clock time it actually took. 600 content minutes in 400 wall-clock
    // minutes is 1.5, whatever any individual row claims.
    observedSpeed: contentMin > 0 && wallClockMin > 0 ? contentMin / wallClockMin : null,
  };
}

/**
 * The rate the whole catalogue demands, not just the part already released.
 *
 * Computable on day one from the course total captured at onboarding, which is
 * the point: "you need 96 minutes a day to finish by March" is actionable in
 * week one, when the observed rate has nothing to say yet.
 */
function requiredRate(
  catalogueContentMin: number | null | undefined,
  watchedContentMin: number,
  skippedContentMin: number,
  asOf: string,
  targetIso: string,
): number | null {
  if (
    typeof catalogueContentMin !== 'number' ||
    !Number.isFinite(catalogueContentMin) ||
    catalogueContentMin <= 0
  ) {
    return null;
  }

  // Skipped counts as dealt with: she is not going to watch it.
  const remaining = Math.max(0, catalogueContentMin - watchedContentMin - skippedContentMin);
  if (remaining === 0) return 0;

  const daysRemaining = daysBetween(asOf, targetIso);
  // Past the target with work left, the honest answer is "no rate clears this",
  // which is `null`. `Infinity` renders as "∞ min/day" and means nothing.
  if (daysRemaining === null || daysRemaining <= 0) return null;

  return remaining / daysRemaining;
}

/* ---------------------------------------------------------------- summary */

export function summariseBacklog(
  facts: LectureFact[],
  opts: {
    asOf: string;
    course?: CourseId;
    targetIso: string;
    catalogueContentMin?: number | null;
  },
): BacklogSummary {
  const { asOf, course, targetIso, catalogueContentMin } = opts;
  const scope: CourseId | 'all' = course ?? 'all';

  const empty: BacklogSummary = {
    course: scope,
    asOf,
    releasedContentMin: 0,
    watchedContentMin: 0,
    skippedContentMin: 0,
    backlogContentMin: 0,
    rate: {
      windowDays: BACKLOG_RULES.rateWindowDays,
      sampleDays: 0,
      contentMinPerDay: 0,
      wallClockMinPerDay: 0,
      observedSpeed: null,
    },
    daysToClear: null,
    requiredContentMinPerDay: null,
    series: [],
  };
  if (!isIsoDate(asOf)) return empty;

  const scoped = course === undefined ? facts : facts.filter((fact) => fact.course === course);
  const list = normalise(scoped);

  let releasedContentMin = 0;
  let watchedContentMin = 0;
  let skippedContentMin = 0;
  for (const fact of list) {
    if (fact.releasedOn <= asOf) releasedContentMin += fact.runtimeMin;
    if (fact.watchedOn !== null && fact.watchedOn <= asOf) watchedContentMin += fact.runtimeMin;
    if (fact.skippedOn !== null && fact.skippedOn <= asOf) skippedContentMin += fact.runtimeMin;
  }

  const backlogContentMin = Math.max(
    0,
    releasedContentMin - watchedContentMin - skippedContentMin,
  );

  const firstReleasedOn = earliestReleasedOn(list, asOf);
  const rate = watchRate(list, asOf, firstReleasedOn);

  // Nothing to clear is zero days, not "unknown". Nothing WATCHED is unknown,
  // and unknown is `null` — never `Infinity`, which a card renders as "∞ days"
  // and a chart renders as nothing at all.
  const daysToClear =
    backlogContentMin === 0
      ? 0
      : rate.contentMinPerDay > 0
        ? backlogContentMin / rate.contentMinPerDay
        : null;

  let series: BacklogSeriesPoint[] = [];
  if (firstReleasedOn !== null) {
    const chartFloor = addDaysIso(asOf, -(SUMMARY_SERIES_DAYS - 1));
    const seriesFrom =
      chartFloor === null || firstReleasedOn > chartFloor ? firstReleasedOn : chartFloor;
    series = buildBacklogSeries(scoped, seriesFrom, asOf);
  }

  return {
    course: scope,
    asOf,
    releasedContentMin,
    watchedContentMin,
    skippedContentMin,
    backlogContentMin,
    rate,
    daysToClear,
    requiredContentMinPerDay: requiredRate(
      catalogueContentMin,
      watchedContentMin,
      skippedContentMin,
      asOf,
      targetIso,
    ),
    series,
  };
}

/* ------------------------------------------------------------------ alert */

/**
 * Fires when the backlog has grown in each of the last two weeks.
 *
 * A sustained two-hours-a-week deficit firing every single week is NOT a false
 * positive. Two hours a week is fifty hours by March; the whole reason recorded
 * courses end preparations is that nothing external ever says so out loud. The
 * guards below exist to keep the alert off things that only LOOK like that —
 * week-two noise, a bulk catalogue import — not to keep it quiet in general.
 *
 * KNOWN LIMIT, for whoever composes this into a screen: a course that releases
 * fortnightly can never fire. The backlog only grows on a release, so one of any
 * two consecutive weeks is flat and "grew in BOTH weeks" cannot hold — the
 * distinct-release-dates guard blocks it first, but the growth test would fail
 * anyway. Anthropology is exactly that shape. A falling-behind Anthropology is
 * therefore visible only in `summariseBacklog`, so do not build a screen that
 * renders the alert and hides the summary. `tests/backlog.test.ts` pins this.
 */
export function evaluateBacklogAlert(
  facts: LectureFact[],
  opts: { asOf: string; auditDayOfWeek: number; course?: CourseId },
): BacklogAlert {
  const { asOf, auditDayOfWeek, course } = opts;

  const nothing: BacklogAlert = {
    fired: false,
    reason: null,
    consecutiveGrowthWeeks: 0,
    samples: [],
    growthContentMin: 0,
    suppressedBy: 'insufficient_history',
  };
  if (!isIsoDate(asOf)) return nothing;

  const w0 = mostRecentDayOfWeek(asOf, auditDayOfWeek);
  if (w0 === null) return nothing;
  const w1 = addDaysIso(w0, -7);
  const w2 = addDaysIso(w0, -14);
  if (w1 === null || w2 === null) return nothing;

  const scoped = course === undefined ? facts : facts.filter((fact) => fact.course === course);
  const list = normalise(scoped);

  const b0 = backlogAt(list, w0);
  const b1 = backlogAt(list, w1);
  const b2 = backlogAt(list, w2);

  const base = {
    // Chronological, so a card can read them left to right.
    samples: [
      { date: w2, backlogContentMin: b2 },
      { date: w1, backlogContentMin: b1 },
      { date: w0, backlogContentMin: b0 },
    ],
    // The headline movement: how much deeper she is than a fortnight ago.
    growthContentMin: b0 - b2,
    // Reported even when suppressed — a screen may want to say "grew once" long
    // before it is willing to interrupt anyone about it.
    consecutiveGrowthWeeks: countGrowthWeeks(list, w0),
  };

  const suppressed = (by: NonNullable<BacklogAlert['suppressedBy']>): BacklogAlert => ({
    fired: false,
    reason: null,
    suppressedBy: by,
    ...base,
  });

  // Week three of any new log shows a backlog growing from nothing, because a
  // backlog growing from nothing is what starting a course looks like.
  if (logSpansDays(list, asOf) < BACKLOG_RULES.minHistoryDays) {
    return suppressed('insufficient_history');
  }

  // NOTE: there is deliberately no `b2 <= 0` guard here.
  //
  // One used to sit at this line, reasoning that "nothing was outstanding a
  // fortnight ago, so nothing has been compounding". That silenced the exact
  // case this feature exists for: someone perfectly caught up who then falls
  // behind for two solid weeks — 0 -> 3h -> 6h — never fired, because the alert
  // would only speak if she was ALREADY behind a fortnight earlier. It could
  // detect the continuation of a slowdown but never its onset.
  //
  // The guard also claimed to prevent a division by zero in the 5% floor.
  // `grew()` multiplies rather than divides (`max(60, 0.05 * earlier)`), so
  // there was never a division to protect: at zero the floor is simply the
  // 60-minute absolute one, which is the correct behaviour.
  //
  // Everything the guard was actually needed for is covered below and above:
  // `minHistoryDays` blocks a brand-new log, `minBacklogContentMin` blocks a
  // trivial backlog, and `minDistinctReleaseDates` blocks a bulk import.
  if (b0 < BACKLOG_RULES.minBacklogContentMin) return suppressed('backlog_too_small');

  // A 400-lecture catalogue dropped on one day is not a two-week slowdown, and
  // telling her it is on the day she enrols is how the alert loses its meaning
  // before it has ever been right.
  if (distinctReleaseDates(list, w2, w0) < BACKLOG_RULES.minDistinctReleaseDates) {
    return suppressed('single_release_date');
  }

  // Both weeks, not the fortnight in aggregate: one catastrophic week followed
  // by a recovery is not a trend, and saying it is trains her to ignore this.
  if (!grew(b1, b0) || !grew(b2, b1)) {
    return { fired: false, reason: null, suppressedBy: null, ...base };
  }

  // `behind_required_rate` needs a catalogue total and a target date, neither of
  // which this signature carries; it belongs to whatever composes this with a
  // `BacklogSummary`. Everything reachable from here is growth.
  return { fired: true, reason: 'growing', suppressedBy: null, ...base };
}

/* --------------------------------------------------------------- narration */

function courseLabel(course: CourseId | 'all'): string {
  if (course === 'all') return 'Lecture backlog';
  return `${COURSES.find((entry) => entry.value === course)?.label ?? course} backlog`;
}

function hours(contentMin: number): string {
  return (contentMin / 60).toFixed(1);
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

/** One sentence a screen reader can speak, since a View chart says nothing. */
export function describeBacklog(summary: BacklogSummary): string {
  const label = courseLabel(summary.course);

  if (summary.backlogContentMin <= 0) {
    return `${label}: nothing outstanding as of ${summary.asOf}. Every lecture released so far is watched or skipped.`;
  }

  const { sampleDays, contentMinPerDay, observedSpeed } = summary.rate;
  const head = `${label}: ${hours(summary.backlogContentMin)} hours of lecture content outstanding as of ${summary.asOf}`;

  // Spelled out because the two figures are not interchangeable and the gap
  // between them is the whole point: 10 hours of content is under 7 hours of
  // her evenings at 1.5x, and a plan built on the wrong one is 50% wrong.
  const cost =
    observedSpeed === null
      ? ''
      : `, about ${hours(summary.backlogContentMin / observedSpeed)} hours of your time at your measured ${observedSpeed.toFixed(2)} times speed`;

  const required =
    summary.requiredContentMinPerDay === null
      ? ''
      : ` Finishing the whole course on time needs ${hours(summary.requiredContentMinPerDay)} hours of content a day.`;

  if (summary.daysToClear === null) {
    return `${head}${cost}. Nothing watched in the last ${sampleDays} ${plural(sampleDays, 'day')}, so there is no rate to project a clearing date from.${required}`;
  }

  const days = Math.ceil(summary.daysToClear);
  return `${head}${cost}. At ${hours(contentMinPerDay)} hours of content a day over the last ${sampleDays} ${plural(sampleDays, 'day')}, that clears in about ${days} ${plural(days, 'day')}.${required}`;
}
