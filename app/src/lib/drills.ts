/**
 * Drill attempt logic: what is written, what is missing, what it cost.
 *
 * Pure. No database, no clock of its own, no network — every instant is passed
 * in, so the same input always produces the same output and a test can assert
 * on it. `db/drills.ts` is the only thing that reads or writes rows.
 *
 * ## The one thing this module exists to do offline
 *
 * Tell her, instantly and with no signal, that her outline names three of the
 * seven available lenses and which four are open. Multi-dimensional coverage is
 * 25% of the essay rubric and it is the one dimension a machine can check
 * without judgement — a lens is either named or it is not. Spending a paid model
 * call to be told "you did not mention the environmental angle" would be absurd,
 * and waiting until she has signal to be told it is worse: the moment the
 * feedback is useful is while she is still looking at the outline.
 */

import {
  DRILL_RULES,
  ESSAY_DIMENSIONS,
  PARTS_OF_KIND,
  type DrillKind,
  type DrillPart,
  type DrillPartFacts,
  type EssayDimension,
} from '@/lib/drill-types';

/* ------------------------------------------------------------------ words */

/**
 * Words, counted the way `ca-map.ts` and `db/ca.ts` count them.
 *
 * One implementation of "how long is this" across the app, because two would
 * eventually disagree about a hyphen and the disagreement would show up as a
 * part that the editor says is long enough and the submit gate says is not.
 */
export function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

/* ------------------------------------------------------------- dimensions */

/**
 * Which lenses the dimensions part actually names.
 *
 * LABEL matching, not substring. `content.includes('political')` is true of any
 * outline that uses the word in a sentence — "the political classes have long
 * argued" — and an outline that mentions politics in passing has not worked the
 * topic through a political lens. The same mistake in `ca/ground.ts` would have
 * grounded fabrications; here it would tell her she has covered ground she has
 * not, which is the direction that costs marks.
 *
 * So a lens counts when it opens a line and is followed by a separator and a
 * real angle: `Political: federal friction over data localisation`. Bullets,
 * numbering, bold markers and the word "angle" are tolerated around it, because
 * she is writing notes at speed and not filling in a form.
 */
export function namedDimensions(content: string): EssayDimension[] {
  const found = new Set<EssayDimension>();

  for (const line of content.split(/\r?\n/)) {
    // Emphasis markers come off BEFORE the list furniture, and the order is
    // load-bearing: the bullet rule matches a leading `*`, so on `**Ethical**:`
    // it would eat one asterisk and leave `*Ethical**:`, which then fails the
    // label match for starting with punctuation. Same class of ordering trap as
    // stripping invisible characters before collapsing whitespace in
    // `ca-map.ts#normaliseHeadline` — first pass eats what the second needs.
    const stripped = line
      .replace(/[*_]{1,2}/g, '')
      .replace(/^\s*(?:[-•–—]|\d+[.)])\s*/, '')
      .trim();
    if (stripped === '') continue;

    const match = /^([A-Za-z][A-Za-z\s/&-]{0,40}?)\s*(?:[:：\-–—]|\bangle\b)\s*(.*)$/i.exec(
      stripped,
    );
    if (match === null) continue;

    const label = match[1]!.trim().toLowerCase().replace(/\s+angle$/, '').trim();
    const angle = match[2]!.trim();

    // A named lens with nothing after it is a heading, not an angle. Counting
    // it would let a full-marks dimension map be written as seven bare words,
    // which is exactly the padding the gate exists to prevent.
    if (wordCount(angle) < 3) continue;

    const dimension = ESSAY_DIMENSIONS.find((candidate) => candidate === label);
    if (dimension !== undefined) found.add(dimension);
  }

  // Declared order, not the order she wrote them in. Two outlines covering the
  // same ground then produce the same list, which is what lets a screen show
  // "3 of 7" without the row reshuffling between renders.
  return ESSAY_DIMENSIONS.filter((dimension) => found.has(dimension));
}

/** The lenses she has NOT named, in the order `ESSAY_DIMENSIONS` declares. */
export function openDimensions(content: string): EssayDimension[] {
  const named = new Set(namedDimensions(content));
  return ESSAY_DIMENSIONS.filter((dimension) => !named.has(dimension));
}

/* ------------------------------------------------------------- submission */

export type PartProblem =
  | 'missing'
  | 'too_short'
  | 'too_long'
  | 'too_few_dimensions'
  | 'too_many_dimensions';

export interface PartCheck {
  part: DrillPart;
  words: number;
  problem: PartProblem | null;
  /** Always populated when `problem` is set. Shown, not logged. */
  detail: string | null;
}

export interface SubmitCheck {
  ready: boolean;
  parts: PartCheck[];
  /** The first thing to fix, as a sentence. Null when ready. */
  blocker: string | null;
}

/**
 * Whether this attempt can be sent for scoring.
 *
 * Refuses rather than warns, and the refusals are cheap ones: an empty part, a
 * part of four words, a part that has become an essay, a dimension map naming
 * fewer than three lenses. Every one of them would come back from a paid model
 * call as "this part is too thin to score", which is a bad way to spend both
 * her morning and the month's budget.
 *
 * It does NOT judge quality. "Is this thesis any good" is the model's job and
 * this function must never pretend to it, because a local gate that rejects a
 * good answer teaches her to distrust the tool.
 */
export function checkSubmittable(
  kind: DrillKind,
  parts: readonly DrillPartFacts[],
): SubmitCheck {
  const byPart = new Map(parts.map((entry) => [entry.part, entry] as const));
  const checks: PartCheck[] = [];

  for (const part of PARTS_OF_KIND[kind]) {
    const written = byPart.get(part);
    const content = written?.content ?? '';
    const words = wordCount(content);

    let problem: PartProblem | null = null;
    let detail: string | null = null;

    if (words === 0) {
      problem = 'missing';
      detail = 'Nothing written yet.';
    } else if (words < DRILL_RULES.minPartWords) {
      problem = 'too_short';
      detail = `${words} words. A part under ${DRILL_RULES.minPartWords} is a heading, not an answer.`;
    } else if (words > DRILL_RULES.maxPartWords) {
      problem = 'too_long';
      detail = `${words} words against a ${DRILL_RULES.maxPartWords}-word ceiling. This has become prose — the point of an outline is that it is not.`;
    } else if (part === 'dimensions') {
      const named = namedDimensions(content).length;
      if (named < DRILL_RULES.minDimensions) {
        problem = 'too_few_dimensions';
        detail =
          named === 0
            ? `No lens is named. Label each line — "Political: ..." — so the angle is explicit rather than implied.`
            : `${named} of ${ESSAY_DIMENSIONS.length} lenses named, against a floor of ${DRILL_RULES.minDimensions}. Breadth is what separates an essay from a long GS answer.`;
      } else if (named > DRILL_RULES.maxDimensions) {
        problem = 'too_many_dimensions';
        detail = `${named} lenses. Past ${DRILL_RULES.maxDimensions} an outline is listing angles rather than choosing between them.`;
      }
    }

    checks.push({ part, words, problem, detail });
  }

  const firstProblem = checks.find((check) => check.problem !== null);
  return {
    ready: firstProblem === undefined,
    parts: checks,
    blocker: firstProblem === undefined ? null : `${firstProblem.part}: ${firstProblem.detail}`,
  };
}

/* ---------------------------------------------------------------- elapsed */

/**
 * Minutes between starting and submitting, or null.
 *
 * Capped, and that is the whole reason this is not a subtraction at the call
 * site. The drill screen can be left open while she goes to work: a raw
 * wall-clock difference would record a nine-hour outline, and `minutesSpent` is
 * the one number that says whether she is getting faster. One absurd row
 * poisons that average for months.
 *
 * The cap is generous — four times the target — because a genuinely slow first
 * attempt is information worth keeping, and only an obviously impossible one is
 * worth discarding. Over the cap returns null rather than the cap itself: an
 * unknown duration must not masquerade as a measured one.
 */
export function elapsedMinutes(
  kind: DrillKind,
  startedAt: string | null,
  submittedAt: string,
): number | null {
  if (startedAt === null) return null;

  const started = Date.parse(startedAt);
  const submitted = Date.parse(submittedAt);
  if (!Number.isFinite(started) || !Number.isFinite(submitted)) return null;
  if (submitted < started) return null;

  const minutes = Math.round((submitted - started) / 60_000);
  const target =
    kind === 'essay_outline' ? DRILL_RULES.essayOutlineMinutes : DRILL_RULES.ethicsCaseMinutes;
  return minutes > target * 4 ? null : minutes;
}

/** The minutes a drill of this kind is meant to take. */
export function targetMinutes(kind: DrillKind): number {
  return kind === 'essay_outline'
    ? DRILL_RULES.essayOutlineMinutes
    : DRILL_RULES.ethicsCaseMinutes;
}

/* ---------------------------------------------------------------- progress */

export interface DrillProgress {
  written: number;
  total: number;
  /** The next part with nothing in it, or null when all are started. */
  nextPart: DrillPart | null;
}

/** How far through the parts she is. Drives the header, not the submit gate. */
export function drillProgress(
  kind: DrillKind,
  parts: readonly DrillPartFacts[],
): DrillProgress {
  const byPart = new Map(parts.map((entry) => [entry.part, entry] as const));
  const all = PARTS_OF_KIND[kind];

  let written = 0;
  let nextPart: DrillPart | null = null;
  for (const part of all) {
    if (wordCount(byPart.get(part)?.content ?? '') > 0) written += 1;
    else if (nextPart === null) nextPart = part;
  }

  return { written, total: all.length, nextPart };
}
