/**
 * What she actually did, per day, derived from work she was already doing.
 *
 * Pure. `db/activity.ts` gathers the timestamps; every clock reading is passed
 * in.
 *
 * ## Why nothing here asks her to log anything
 *
 * This is the input to burnout detection, and a burnout detector that depends
 * on a daily mood slider has no data exactly when it is needed — filling in a
 * mood slider is among the first things to go when someone is running on empty.
 * A detector that stops working at the onset of the thing it detects is worse
 * than no detector, because its silence reads as reassurance.
 *
 * So every signal below is a by-product: an answer written, a question
 * attempted, a revision reviewed, an outline submitted, a lecture logged, a
 * digest item opened. `study_sessions` carries mood and energy when she chooses
 * to record them, and they only ever ENRICH what is already known — nothing
 * here degrades when they are absent.
 *
 * ## Days, not sessions
 *
 * The unit is the local calendar day, byte-compared as `YYYY-MM-DD`. She writes
 * an answer at 09:40 and drills on the 22:15 commute home; that is one study
 * day, not two sessions, and counting it as two would make a light day look
 * busy. The day boundary is her timezone's, never UTC — a UTC day rolls over at
 * 05:30 IST, mid-morning, and would split every study block in half.
 */

/** The kinds of work that count as studying. A closed list. */
export const ACTIVITY_KINDS = [
  'answer',
  'mcq',
  'revision',
  'drill',
  'lecture',
  'reading',
] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** One timestamped thing she did. `day` is already local. */
export interface ActivityEvent {
  kind: ActivityKind;
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string;
  /** Minutes into the local day, 0–1439, or null when only the day is known. */
  minuteOfDay: number | null;
  /**
   * How much of it. Answers count 1, MCQ attempts count 1 each, a lecture
   * counts its runtime in minutes. Deliberately not normalised into a single
   * "effort" score: those are unfalsifiable, and the useful questions are
   * per-kind ones like "has she stopped writing answers".
   */
  weight: number;
}

/** One day, assembled. */
export interface ActivityDay {
  day: string;
  /** Every kind that saw at least one event. */
  kinds: ActivityKind[];
  /** Per-kind totals. Zero for kinds with nothing. */
  weights: Readonly<Record<ActivityKind, number>>;
  /** How many distinct kinds. The breadth signal. */
  breadth: number;
  /** Earliest and latest minute-of-day seen, or null when no event carried one. */
  firstMinute: number | null;
  lastMinute: number | null;
  /** Recorded on `study_sessions`, when she chose to. Enrichment only. */
  mood: number | null;
  energy: number | null;
}

function emptyWeights(): Record<ActivityKind, number> {
  return { answer: 0, mcq: 0, revision: 0, drill: 0, lecture: 0, reading: 0 };
}

export interface SelfReport {
  day: string;
  mood: number | null;
  energy: number | null;
}

/**
 * Events to days, over an explicit range.
 *
 * The range is passed in rather than inferred from the events, and that is the
 * whole point: a day with NO events must appear as a day with no events, not be
 * missing. Inferring the range from the data would make a fortnight off look
 * like a fortnight that never happened, and every rate computed from it would
 * be silently wrong in the flattering direction.
 */
export function activityByDay(
  events: readonly ActivityEvent[],
  days: readonly string[],
  reports: readonly SelfReport[] = [],
): ActivityDay[] {
  const byDay = new Map<string, ActivityDay>();

  for (const day of days) {
    byDay.set(day, {
      day,
      kinds: [],
      weights: emptyWeights(),
      breadth: 0,
      firstMinute: null,
      lastMinute: null,
      mood: null,
      energy: null,
    });
  }

  for (const event of events) {
    const entry = byDay.get(event.day);
    // An event outside the range is dropped rather than extending it: the
    // caller asked about a window and silently widening it would change every
    // denominator downstream.
    //
    // The final `days.map` below enforces the same thing independently, and the
    // redundancy is deliberate rather than an oversight — a mutation test found
    // that neither alone can be broken without the other also being broken.
    // Removing either leaves the property intact today and leaves it resting on
    // one line, so keep both.
    if (entry === undefined) continue;
    if (!ACTIVITY_KINDS.includes(event.kind)) continue;

    const weights = entry.weights as Record<ActivityKind, number>;
    weights[event.kind] += Math.max(0, event.weight);
    if (!entry.kinds.includes(event.kind)) entry.kinds.push(event.kind);

    if (event.minuteOfDay !== null && Number.isFinite(event.minuteOfDay)) {
      const minute = Math.min(1439, Math.max(0, Math.floor(event.minuteOfDay)));
      entry.firstMinute = entry.firstMinute === null ? minute : Math.min(entry.firstMinute, minute);
      entry.lastMinute = entry.lastMinute === null ? minute : Math.max(entry.lastMinute, minute);
    }
  }

  for (const report of reports) {
    const entry = byDay.get(report.day);
    if (entry === undefined) continue;
    entry.mood = report.mood;
    entry.energy = report.energy;
  }

  // Declared order, and days in ascending order, so two runs over the same
  // data produce the same array and a chart never redraws differently.
  return days.map((day) => {
    const entry = byDay.get(day)!;
    const kinds = ACTIVITY_KINDS.filter((kind) => entry.kinds.includes(kind));
    return { ...entry, kinds, breadth: kinds.length };
  });
}

/** True when anything at all happened. The definition of a "studied" day. */
export function wasActive(day: ActivityDay): boolean {
  return day.breadth > 0;
}

/* ------------------------------------------------------------ day arithmetic */

const MS_PER_DAY = 86_400_000;

/**
 * `n` consecutive days ending at `lastDay`, oldest first.
 *
 * Arithmetic on a LABEL anchored at UTC midnight, never a claim about an
 * instant — the same device `syllabus-coverage.ts` and `ca-request.ts` use, and
 * for the same reason: a comparison that went through local `Date` parsing
 * could be inverted by a format mismatch.
 */
export function dayRange(lastDay: string, n: number): string[] {
  const anchor = Date.parse(`${lastDay}T00:00:00.000Z`);
  if (!Number.isFinite(anchor) || n <= 0) return [];

  const out: string[] = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    out.push(new Date(anchor - i * MS_PER_DAY).toISOString().slice(0, 10));
  }
  return out;
}

/** Day-of-week for a calendar-day label, JS convention. `-1` if unparseable. */
export function dayOfWeek(day: string): number {
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(ms) ? new Date(ms).getUTCDay() : -1;
}
