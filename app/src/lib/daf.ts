/**
 * DAF completeness and interview readiness.
 *
 * Pure. `db/daf.ts` reads the rows.
 *
 * ## Readiness is per AREA, not per question
 *
 * A board does not ask a question; it opens an area and follows it. Being ready
 * on four of twelve district questions is not four-twelfths ready — the fifth
 * question is the one that lands, and preparation that stops partway through an
 * area is preparation for the questions she happened to enjoy.
 *
 * ## And it is ordered by LIKELIHOOD, not by count
 *
 * The home district and the optional come up in almost every interview. A
 * screen ordered by "most questions outstanding" would bury them under whichever
 * field happened to generate the longest list — which is usually hobbies,
 * because hobbies are easy to ask about and therefore easy to generate.
 */

import {
  DAF_FIELDS,
  DAF_RULES,
  DECIDE_EARLY,
  FIELD_LABELS,
  GROUP_OF_FIELD,
  type AreaReadiness,
  type DafEntry,
  type DafField,
  type DafGroup,
  type InterviewQuestion,
  type Likelihood,
} from '@/lib/daf-types';

/* ------------------------------------------------------------ the form */

export interface FieldState {
  field: DafField;
  group: DafGroup;
  value: string;
  words: number;
  /** Nothing entered at all. */
  empty: boolean;
  /**
   * Entered, but too short to defend.
   *
   * "Reading" is a hobby a board takes apart in ninety seconds; "Reading —
   * mainly Indian political history, currently Guha" is one she can hold. A
   * nudge, never a refusal: it is her form and a one-word answer may be the
   * true one.
   */
  thin: boolean;
  /** On the list of fields whose answer is determined by what she does now. */
  decideEarly: boolean;
}

export function wordCount(value: string): number {
  const trimmed = value.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

/**
 * Every field, whether or not she has filled it.
 *
 * All sixteen, always, in declared order. A form that showed only what had been
 * answered would make the gaps invisible, and the gaps are the product.
 */
export function formState(entries: readonly DafEntry[]): FieldState[] {
  const byField = new Map(entries.map((entry) => [entry.field, entry] as const));

  return DAF_FIELDS.map((field) => {
    const value = byField.get(field)?.value.trim() ?? '';
    const words = wordCount(value);
    return {
      field,
      group: GROUP_OF_FIELD[field],
      value,
      words,
      empty: words === 0,
      thin: words > 0 && words < DAF_RULES.thinValueWords,
      decideEarly: DECIDE_EARLY.includes(field),
    };
  });
}

export interface FormSummary {
  filled: number;
  total: number;
  /** Filled but too short to defend. */
  thin: number;
  /** Unfilled fields whose answer is decided by what she does now. */
  earlyGaps: DafField[];
}

export function summariseForm(state: readonly FieldState[]): FormSummary {
  return {
    filled: state.filter((entry) => !entry.empty).length,
    total: state.length,
    thin: state.filter((entry) => entry.thin).length,
    earlyGaps: state
      .filter((entry) => entry.decideEarly && (entry.empty || entry.thin))
      .map((entry) => entry.field),
  };
}

/**
 * The one sentence worth saying about the form, or null.
 *
 * Null when there is nothing actionable — an app that always has an opinion is
 * one whose opinions stop being read. Leads with the early-decision gaps
 * because those are the only ones where waiting costs anything.
 */
export function describeForm(summary: FormSummary, monthsToDaf: number | null): string | null {
  if (summary.earlyGaps.length > 0) {
    const names = summary.earlyGaps.map((field) => FIELD_LABELS[field].toLowerCase());
    const when =
      monthsToDaf === null
        ? 'before the form is due'
        : `and the form is about ${monthsToDaf} months away`;
    // Oxford-style join. `join(' and ')` produced "hobbies and sports and
    // extra-curriculars and employment", which reads as one run-on item.
    const listed =
      names.length === 1
        ? names[0]!
        : `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`;

    return `${listed} ${
      summary.earlyGaps.length === 1 ? 'is' : 'are'
    } still open ${when}. These are the fields you can still change — the rest you will report, these you decide.`;
  }

  if (summary.thin > 0) {
    return `${summary.thin} ${
      summary.thin === 1 ? 'answer is' : 'answers are'
    } a word or two long. A board takes a one-word entry to its floor in about ninety seconds.`;
  }

  if (summary.filled < summary.total) {
    return `${summary.filled} of ${summary.total} filled in. No hurry on the rest — the form is not due for a while.`;
  }

  return null;
}

/* --------------------------------------------------------------- readiness */

const LIKELIHOOD_RANK: Readonly<Record<Likelihood, number>> = {
  certain: 0,
  likely: 1,
  possible: 2,
};

/**
 * Readiness per area, most-likely-to-be-asked first.
 *
 * An area's likelihood is the HIGHEST of its questions': one certain question
 * makes the area certain, because the board reaching that question is what
 * opens the area, and everything after it follows.
 */
export function readinessByArea(questions: readonly InterviewQuestion[]): AreaReadiness[] {
  const byArea = new Map<string, AreaReadiness>();

  for (const question of questions) {
    const existing = byArea.get(question.area);
    const entry: AreaReadiness = existing ?? {
      area: question.area,
      field: question.field,
      likelihood: question.likelihood,
      total: 0,
      rehearsed: 0,
      notesMade: 0,
      notStarted: 0,
    };

    if (LIKELIHOOD_RANK[question.likelihood] < LIKELIHOOD_RANK[entry.likelihood]) {
      entry.likelihood = question.likelihood;
    }

    entry.total += 1;
    if (question.prep === 'rehearsed') entry.rehearsed += 1;
    else if (question.prep === 'notes_made') entry.notesMade += 1;
    else entry.notStarted += 1;

    byArea.set(question.area, entry);
  }

  return [...byArea.values()].sort(
    (a, b) =>
      LIKELIHOOD_RANK[a.likelihood] - LIKELIHOOD_RANK[b.likelihood] ||
      // Then least ready first: within equally likely areas, the one she has
      // done least on is the one to open.
      readyShare(a) - readyShare(b) ||
      (a.area < b.area ? -1 : 1),
  );
}

/**
 * How much of an area is ready, 0–1.
 *
 * Notes count HALF. Reading about an area and being able to say it out loud
 * under a board's gaze are different skills, and an interview is entirely the
 * second — but notes are real progress and counting them zero would make the
 * number useless as a measure of effort.
 */
export function readyShare(area: AreaReadiness): number {
  if (area.total === 0) return 0;
  return (area.rehearsed + area.notesMade * 0.5) / area.total;
}

export interface ReadinessSummary {
  areas: number;
  /** Areas at or above `DAF_RULES.readyShare`. */
  ready: number;
  /** The most-likely area that is not ready, or null. */
  weakest: AreaReadiness | null;
  questions: number;
  rehearsed: number;
  /** Questions she flagged. Surfaced, never hidden. */
  flagged: number;
}

export function summariseReadiness(
  areas: readonly AreaReadiness[],
  questions: readonly InterviewQuestion[],
): ReadinessSummary {
  const ready = areas.filter((area) => readyShare(area) >= DAF_RULES.readyShare);
  // `readinessByArea` already sorts most-likely-then-least-ready, so the first
  // unready area IS the weakest by both measures. Re-sorting here would risk
  // the two disagreeing.
  const weakest = areas.find((area) => readyShare(area) < DAF_RULES.readyShare) ?? null;

  return {
    areas: areas.length,
    ready: ready.length,
    weakest,
    questions: questions.length,
    rehearsed: questions.filter((question) => question.prep === 'rehearsed').length,
    flagged: questions.filter((question) => question.flagged).length,
  };
}

/**
 * Questions in the order to work through them.
 *
 * Flagged first, and that ordering is the point: the question she flinched at
 * is the one to prepare. An app that let her bury it would be helping her avoid
 * the interview rather than prepare for it.
 */
export function questionOrder(questions: readonly InterviewQuestion[]): InterviewQuestion[] {
  const PREP_RANK = { not_started: 0, notes_made: 1, rehearsed: 2 } as const;
  return [...questions].sort(
    (a, b) =>
      Number(b.flagged) - Number(a.flagged) ||
      LIKELIHOOD_RANK[a.likelihood] - LIKELIHOOD_RANK[b.likelihood] ||
      PREP_RANK[a.prep] - PREP_RANK[b.prep] ||
      a.id - b.id,
  );
}

/**
 * Whole months from today to the DAF, or null.
 *
 * The DAF is submitted with the Mains application, which for a 2028 attempt is
 * roughly August 2028. Approximate on purpose — the exact date is announced a
 * year ahead and this is a planning horizon, not a countdown.
 */
export function monthsToDaf(today: string, examYear: number): number | null {
  const now = Date.parse(`${today}T00:00:00.000Z`);
  const daf = Date.parse(`${examYear}-08-01T00:00:00.000Z`);
  if (!Number.isFinite(now) || !Number.isFinite(daf)) return null;
  const months = Math.round((daf - now) / (30.44 * 86_400_000));
  return months < 0 ? 0 : months;
}
