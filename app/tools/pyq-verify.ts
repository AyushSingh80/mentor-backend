/**
 * `pyq-verify` — the gate between an extracted past paper and the app.
 *
 * Node-only. Nothing in `src/` may import it, and it imports nothing that needs
 * a device: `data/pyq/types.ts` and `lib/mcq-types.ts` are both pure.
 *
 *     node --import tsx tools/pyq-verify.ts <set.json> [--sample [N]]
 *
 * ## What this is for
 *
 * `lib/pyq-import.ts` already validates a QUESTION: four options, none empty,
 * none duplicated, a key in range, a stem that is not blank. Every one of those
 * is a property of one row and none of them is repeated here.
 *
 * The errors that actually reach a device are not row-shaped. They are
 * shaped like a WHOLE SET: a segmenter that swallowed question 47 and left a
 * hundred perfectly valid rows numbered 1–46 and 48–101; a layout parser that
 * pasted a running header into six stems; a key column read one row out of
 * alignment so that every answer is a real letter and every answer is wrong.
 * None of those produces an invalid question. Each produces a set that is
 * invalid AS A SET, which is the only level at which it can be seen.
 *
 * ## Two rules, and they are the whole design
 *
 * **1. A failing invariant BLOCKS.** The process exits non-zero and says so in
 * plain words. A warning is a thing a tired person scrolls past at 1 a.m., and
 * the cost of scrolling past this particular warning is a year of spaced
 * repetition drilling a wrong answer to mastery — the better the scheduler
 * works, the more thoroughly the falsehood is learned.
 *
 * **2. This tool NEVER repairs anything.** There is no write path in this file;
 * `node:fs` is imported for `readFileSync` and nothing else. A tool that
 * silently strips the `(cid:` it found would destroy the only evidence that the
 * layout parser is broken, and the next paper through it would be broken in the
 * same way with nothing left to notice. It reports; a human fixes the extractor
 * and runs it again.
 *
 * ## What it cannot do
 *
 * Stated plainly because a gate that is trusted beyond its reach is worse than
 * no gate. The key-distribution check catches a key that COLLAPSED — a mis-read
 * column, a parse that defaulted to 'a', a booklet key pasted in a constant
 * shift. It cannot catch a key that is wrong but still uniform, because a
 * uniform wrong key and a uniform right key are the same histogram. That case
 * has exactly one defence and it is the `--sample` mode: a human, holding the
 * paper, reading a weighted handful of questions off the screen.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import {
  PYQ_NUMBER_DIGITS,
  isPyqBooklet,
  isPyqExam,
  pyqSetKey,
  type PyqBooklet,
  type PyqDropReason,
  type PyqExam,
  type PyqVerification,
} from '../src/data/pyq/types';
import { OPTION_LETTERS } from '../src/lib/mcq-types';

/* -------------------------------------------------------------- the input */

/**
 * The slice of a set these checks read.
 *
 * Structurally a supertype of `PyqSet`, so a real set passes straight in, while
 * the JSON path is spared having to INVENT the fields no check here inspects. A
 * parser obliged to produce a full `PyqSet` would have to make up a `difficulty`
 * for a question whose extraction omitted one, and making up a field is the
 * first move of repairing one.
 *
 * `dropped.reason` widens to `string` deliberately. `PyqDropReason` makes a bad
 * reason unrepresentable in TypeScript; JSON off a disk is under no such
 * obligation, and "every dropped question carries a reason" is precisely one of
 * the things this tool exists to check.
 */
export interface VerifiableMcq {
  number: number;
  stem: string;
  options: readonly string[];
  correctIndex: number;
}

export interface VerifiableWritten {
  number: number;
  promptText: string;
  caseDetail: string | null;
}

export interface VerifiableDropped {
  number: number;
  reason: string;
  note?: string | null;
}

export interface VerifiableSet {
  exam: PyqExam;
  year: number;
  booklet: PyqBooklet;
  verification: PyqVerification | null;
  mcqs: readonly VerifiableMcq[];
  written: readonly VerifiableWritten[];
  dropped: readonly VerifiableDropped[];
}

/* ------------------------------------------------------------- the verdict */

export type PyqCheckName =
  | 'numbering'
  | 'drop_accounting'
  | 'key_distribution'
  | 'key_runs'
  | 'duplicate_stems'
  | 'pdf_artefacts'
  | 'suspicious_stems';

/**
 * `fail` is the only status that stops the set. `attention` is for findings a
 * human must READ and no machine can adjudicate; `skipped` is for a check that
 * could not run, and it is a distinct status rather than a silent pass so that
 * "we did not check this" never renders as "this is fine".
 */
export type PyqCheckStatus = 'pass' | 'fail' | 'attention' | 'skipped';

export interface PyqCheckOutcome {
  check: PyqCheckName;
  status: PyqCheckStatus;
  /** Human-readable. Each line names the questions it is about. */
  messages: readonly string[];
  /** Every question number implicated, ascending. Empty on a clean pass. */
  numbers: readonly number[];
}

export interface PyqVerifyReport {
  setKey: string;
  /** How many questions the paper is taken to contain. Null when unknown. */
  expectedTotal: number | null;
  checks: readonly PyqCheckOutcome[];
  /** True when at least one check failed. The whole point of the tool. */
  blocked: boolean;
}

export function isBlocking(outcome: PyqCheckOutcome): boolean {
  return outcome.status === 'fail';
}

/* ------------------------------------------------------------- thresholds */

/**
 * UPSC Prelims GS Paper I is 100 questions. Always, every year of this format.
 *
 * Hardcoded so the completeness check has something to compare against even
 * when nobody passed `--expected`, because the failure it guards — the last
 * three questions of the last page never making it out of the segmenter —
 * leaves behind a set that is internally perfect and quietly short.
 */
const EXPECTED_TOTAL_BY_EXAM: Readonly<Partial<Record<PyqExam, number>>> = {
  'prelims-gs1': 100,
};

/**
 * How far one answer letter may run ahead of a quarter before the set is
 * refused, expressed in standard deviations rather than as a flat percentage.
 *
 * Under a correctly-keyed paper each letter's count is ~Binomial(n, 1/4), so
 * the standard deviation of its SHARE is sqrt(0.25 * 0.75 / n) — 4.33 points at
 * n = 100. `4.6` sigma puts the n = 100 threshold at 25% + 4.6 * 4.33% ≈ 45%,
 * which is the number a human would have picked by eye, and it keeps that same
 * strictness at other paper lengths instead of being loose at n = 400 and
 * absurd at n = 30.
 *
 * The one-sided tail at 4.6 sigma is ~2e-6 per letter, ~8e-6 across four. A
 * lifetime of importing thirty papers therefore risks a false block at roughly
 * one in four thousand. That asymmetry is the entire justification: a false
 * block costs a human ten minutes of re-checking a good paper, and a false pass
 * costs a year of drilling answers that are wrong.
 */
const KEY_SKEW_SIGMA = 4.6;

/**
 * Below this the histogram has no power to say anything and pretending
 * otherwise would be worse than silence, so the check reports `skipped`.
 *
 * At n = 20 the threshold is already 25% + 4.6 * 9.7% ≈ 70% — 14 of 20 — which
 * a genuine key clears about once in a hundred thousand. Under 20 the number
 * exceeds 100% and the check can only ever pass, which is a check that lies.
 */
const KEY_SKEW_MIN_QUESTIONS = 20;

/**
 * A letter appearing ZERO times is the other tail of the same failure: an
 * off-by-one in the option-index mapping folds four letters into three.
 *
 * Only meaningful once absence is itself improbable. P(a given letter absent
 * from n) = 0.75^n, which is 1.0e-5 at n = 40 and a far less comfortable 3e-3
 * at n = 20.
 */
const KEY_ABSENT_MIN_QUESTIONS = 40;

/**
 * The longest allowed run of identical consecutive answers.
 *
 * This is the signal the share threshold misses. A key column that slips for
 * one page — twenty-five questions all reading 'a' — moves 'a' to about 43% of
 * a hundred, under the 45% line, while leaving a run no real paper produces.
 *
 * Expected number of runs of length >= k in n draws is about n * 4^-(k-1), so
 * k = ceil(log4 n) + 4 holds the false-positive rate near 0.6% whatever the
 * paper length: 8 at n = 100, 9 at n = 400.
 */
function maxPlausibleKeyRun(n: number): number {
  return Math.ceil(Math.log(n) / Math.log(4)) + 4;
}

/**
 * A line repeated across this many DIFFERENT questions is not question content.
 *
 * Three, because a running header lands once per page and a hundred questions
 * fit on a dozen pages: two occurrences could be coincidence, three across
 * questions that are pages apart is furniture.
 */
const HEADER_MIN_QUESTIONS = 3;

/** Headers are labels. Eighty characters is already a generous label. */
const HEADER_MAX_LENGTH = 80;

/**
 * Stock UPSC phrasing that legitimately repeats across a paper.
 *
 * Without this list the repeated-line detector would block every real Prelims
 * paper ever printed, and a gate that blocks everything is a gate that gets
 * commented out. Normalised the same way candidate lines are; extend at the
 * command line with `--allow-line`, never by the tool editing anything.
 *
 * Kept short on purpose. Lines ending in `.`, `?`, `:`, `;` or `!` are already
 * excluded as sentences, which covers most of the formulaic phrasing; these are
 * the handful that habitually appear with no terminal punctuation at all.
 */
export const STOCK_REPEATED_LINES: readonly string[] = [
  'select the correct answer using the code given below',
  'select the correct answer using the codes given below',
  'which of the statements given above is/are correct',
  'which of the above statements is/are correct',
  'how many of the above statements are correct',
  'how many of the pairs given above are correctly matched',
  'consider the following statements',
  'consider the following pairs',
];

/**
 * The share of an eyeball sample spent on negation-bearing stems.
 *
 * A negation question is where extraction error is both most likely — a dropped
 * "NOT" inverts the question while leaving perfectly grammatical English — and
 * most damaging, because the resulting card teaches the exact opposite of the
 * truth. They are roughly a fifth to a third of a real paper, so 60% of the
 * sample over-weights them about two to three times over.
 *
 * Not 100%: the remaining 40% is what covers a segmenter that went wrong at
 * page seven, which negation-weighting alone would step straight over.
 */
const SAMPLE_NEGATION_SHARE = 0.6;

/** Fifteen questions per hundred. The brief's number, and about ten minutes. */
const SAMPLE_PER_HUNDRED = 15;

/** Beyond this many question numbers a message stops informing and starts scrolling. */
const NUMBER_LIST_CAP = 24;

/* ---------------------------------------------------------------- helpers */

/** `q007`. Zero-padded so a list of numbers sorts and scans the way ids do. */
export function qLabel(n: number): string {
  return `q${String(n).padStart(PYQ_NUMBER_DIGITS, '0')}`;
}

function formatNumbers(numbers: readonly number[]): string {
  const sorted = [...numbers].sort((a, b) => a - b);
  const shown = sorted.slice(0, NUMBER_LIST_CAP).map(qLabel).join(', ');
  if (sorted.length <= NUMBER_LIST_CAP) return shown;
  return `${shown} … and ${sorted.length - NUMBER_LIST_CAP} more`;
}

function ascending(numbers: Iterable<number>): number[] {
  return [...new Set(numbers)].sort((a, b) => a - b);
}

function outcome(
  check: PyqCheckName,
  status: PyqCheckStatus,
  messages: readonly string[],
  numbers: Iterable<number> = [],
): PyqCheckOutcome {
  return { check, status, messages, numbers: ascending(numbers) };
}

/**
 * Normalised stem, for the duplicate test only.
 *
 * Deliberately NOT `lib/pyq-import.ts`'s `stemFingerprint`, which truncates to
 * 200 characters. That truncation is right for its job — colliding an imported
 * question with a generated near-twin — and wrong for this one: UPSC routinely
 * prints two different questions that open with the same long "Consider the
 * following statements" preamble, and a truncating comparator would call them
 * duplicates and block a perfectly good paper.
 */
export function normaliseStem(stem: string): string {
  return stem
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .join(' ');
}

/** Line-level normalisation, for repeated-header detection. */
function normaliseLine(line: string): string {
  return line.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * `not`, `except`, `incorrect` — on word boundaries.
 *
 * The boundary matters: `\bnot\b` leaves `cannot`, `note` and `nothing` alone,
 * and flagging every stem containing the letters n-o-t would flag the whole
 * paper and mean nothing.
 */
const NEGATION_PATTERN = /\b(?:not|except|incorrect(?:ly)?)\b/i;

export function hasNegation(stem: string): boolean {
  return NEGATION_PATTERN.test(stem);
}

/** One piece of question text, tagged with where it came from. */
interface TextField {
  number: number;
  where: string;
  text: string;
}

function optionLabel(index: number): string {
  return index < OPTION_LETTERS.length ? OPTION_LETTERS[index] : `#${index + 1}`;
}

function textFields(set: VerifiableSet): TextField[] {
  const fields: TextField[] = [];
  for (const mcq of set.mcqs) {
    fields.push({ number: mcq.number, where: 'stem', text: mcq.stem });
    mcq.options.forEach((option, index) => {
      fields.push({ number: mcq.number, where: `option ${optionLabel(index)}`, text: option });
    });
  }
  for (const written of set.written) {
    fields.push({ number: written.number, where: 'prompt', text: written.promptText });
    if (written.caseDetail !== null) {
      fields.push({ number: written.number, where: 'case detail', text: written.caseDetail });
    }
  }
  return fields;
}

/** Every stem in the set, whichever form the paper takes. */
function stems(set: VerifiableSet): readonly { number: number; text: string }[] {
  return [
    ...set.mcqs.map((mcq) => ({ number: mcq.number, text: mcq.stem })),
    ...set.written.map((written) => ({ number: written.number, text: written.promptText })),
  ];
}

function shippedNumbers(set: VerifiableSet): number[] {
  return [...set.mcqs.map((m) => m.number), ...set.written.map((w) => w.number)];
}

/** The count the paper is taken to have. Explicit beats per-exam default. */
export function resolveExpectedTotal(
  set: VerifiableSet,
  explicit: number | null | undefined,
): number | null {
  if (explicit !== null && explicit !== undefined) return explicit;
  return EXPECTED_TOTAL_BY_EXAM[set.exam] ?? null;
}

/* -------------------------------------------------------- 1. numbering */

/**
 * Shipped plus dropped must be exactly 1..N, once each.
 *
 * A gap is the signature of a segmenter that swallowed a question: everything
 * either side of it is valid, the count is plausible, and the only trace left
 * is a number that is not there. A duplicate is the same bug from the other
 * end — one question split into two, or two pages of a scan overlapping.
 *
 * N comes from `expectedTotal` when it is known. When it is not, N is the
 * highest number present, and the check says so, because questions lost off the
 * END of the paper are invisible to an inferred N by construction.
 */
export function checkNumbering(
  set: VerifiableSet,
  expectedTotal: number | null = null,
): PyqCheckOutcome {
  const shipped = shippedNumbers(set);
  const dropped = set.dropped.map((d) => d.number);
  const all = [...shipped, ...dropped];

  if (all.length === 0) {
    return outcome('numbering', 'fail', [
      'the set contains no questions and no drops — the extraction produced nothing',
    ]);
  }

  const malformed = all.filter((n) => !Number.isInteger(n));
  const messages: string[] = [];
  const implicated: number[] = [];

  if (malformed.length > 0) {
    messages.push(
      `${malformed.length} question number(s) are not whole numbers: ${malformed.join(', ')}`,
    );
  }

  const whole = all.filter((n) => Number.isInteger(n));
  const total = expectedTotal ?? Math.max(...whole);

  const seen = new Map<number, number>();
  for (const n of whole) seen.set(n, (seen.get(n) ?? 0) + 1);

  const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([n]) => n);
  if (duplicates.length > 0) {
    messages.push(
      `${duplicates.length} question number(s) appear more than once — the segmenter split a question in two: ${formatNumbers(duplicates)}`,
    );
    implicated.push(...duplicates);
  }

  const outOfRange = [...seen.keys()].filter((n) => n < 1 || n > total);
  if (outOfRange.length > 0) {
    messages.push(
      `${outOfRange.length} question number(s) fall outside 1..${total}: ${formatNumbers(outOfRange)}`,
    );
    implicated.push(...outOfRange);
  }

  const missing: number[] = [];
  for (let n = 1; n <= total; n += 1) if (!seen.has(n)) missing.push(n);
  if (missing.length > 0) {
    messages.push(
      `${missing.length} question number(s) are in neither the shipped nor the dropped list — the segmenter swallowed them: ${formatNumbers(missing)}`,
    );
    implicated.push(...missing);
  }

  if (messages.length > 0) return outcome('numbering', 'fail', messages, implicated);

  const note =
    expectedTotal === null
      ? ` (N inferred from the highest number present — questions lost after ${qLabel(total)} cannot be seen by this check; pass --expected to close that hole)`
      : '';
  return outcome('numbering', 'pass', [
    `${qLabel(1)}–${qLabel(total)} each present exactly once across ${shipped.length} shipped and ${dropped.length} dropped${note}`,
  ]);
}

/* --------------------------------------------------- 2. drop accounting */

/**
 * Runtime mirror of `PyqDropReason`.
 *
 * The `satisfies Record<PyqDropReason, true>` makes the compiler prove the list
 * is complete: add a reason to `data/pyq/types.ts` and this stops compiling,
 * rather than silently starting to reject the new reason at run time.
 */
const DROP_REASONS = Object.keys({
  map_or_diagram: true,
  match_the_following: true,
  table_in_stem: true,
  unreadable_scan: true,
  withdrawn_by_upsc: true,
  no_verified_key: true,
} satisfies Record<PyqDropReason, true>);

/**
 * A drop is a refusal, and a refusal without a reason is an omission wearing a
 * refusal's clothes.
 *
 * "94 of 100 imported, 6 dropped" is only a checkable sentence if the six say
 * why; otherwise it is indistinguishable from a bug in the extractor that lost
 * six questions and noticed.
 */
export function checkDropAccounting(
  set: VerifiableSet,
  expectedTotal: number | null = null,
): PyqCheckOutcome {
  const messages: string[] = [];
  const implicated: number[] = [];

  const reasonless = set.dropped.filter(
    (d) => typeof d.reason !== 'string' || d.reason.trim() === '',
  );
  if (reasonless.length > 0) {
    messages.push(
      `${reasonless.length} dropped question(s) carry no reason: ${formatNumbers(reasonless.map((d) => d.number))}`,
    );
    implicated.push(...reasonless.map((d) => d.number));
  }

  const unknown = set.dropped.filter(
    (d) =>
      typeof d.reason === 'string' &&
      d.reason.trim() !== '' &&
      !DROP_REASONS.includes(d.reason.trim()),
  );
  if (unknown.length > 0) {
    for (const d of unknown) {
      messages.push(
        `${qLabel(d.number)} was dropped for "${d.reason}", which is not a PyqDropReason (${DROP_REASONS.join(', ')})`,
      );
    }
    implicated.push(...unknown.map((d) => d.number));
  }

  const shipped = shippedNumbers(set).length;
  const dropped = set.dropped.length;

  if (expectedTotal === null) {
    if (messages.length > 0) return outcome('drop_accounting', 'fail', messages, implicated);
    return outcome('drop_accounting', 'skipped', [
      `${shipped} shipped + ${dropped} dropped = ${shipped + dropped}, but nothing says how many questions this paper has — pass --expected N to make completeness checkable`,
    ]);
  }

  if (shipped + dropped !== expectedTotal) {
    messages.push(
      `${shipped} shipped + ${dropped} dropped = ${shipped + dropped}, but the paper has ${expectedTotal} questions — ${Math.abs(expectedTotal - shipped - dropped)} question(s) are accounted for nowhere`,
    );
  }

  if (messages.length > 0) return outcome('drop_accounting', 'fail', messages, implicated);
  return outcome('drop_accounting', 'pass', [
    `${shipped} shipped + ${dropped} dropped = ${expectedTotal}, every drop with a reason`,
  ]);
}

/* ------------------------------------------------- 3. key distribution */

export interface KeyDistribution {
  counts: Readonly<Record<string, number>>;
  /** Questions whose `correctIndex` names no option letter at all. */
  unclassified: readonly number[];
  total: number;
}

export function keyDistribution(set: VerifiableSet): KeyDistribution {
  const counts: Record<string, number> = {};
  for (const letter of OPTION_LETTERS) counts[letter] = 0;
  const unclassified: number[] = [];
  for (const mcq of set.mcqs) {
    const letter =
      Number.isInteger(mcq.correctIndex) &&
      mcq.correctIndex >= 0 &&
      mcq.correctIndex < OPTION_LETTERS.length
        ? OPTION_LETTERS[mcq.correctIndex]
        : null;
    if (letter === null) unclassified.push(mcq.number);
    else counts[letter] += 1;
  }
  return { counts, unclassified, total: set.mcqs.length };
}

/** 25% plus `KEY_SKEW_SIGMA` standard deviations of a Binomial(n, 1/4) share. */
export function keySkewThreshold(n: number): number {
  return 0.25 + KEY_SKEW_SIGMA * Math.sqrt((0.25 * 0.75) / n);
}

/**
 * **The check that catches the booklet/key catastrophe.**
 *
 * UPSC prints the same paper as four booklets with the questions and options in
 * different orders and publishes a different key for each. Extract booklet A's
 * questions and read booklet C's key against them and every single row is
 * valid, plausible, and wrong — there is nothing to see in any one question,
 * because no one question is malformed.
 *
 * What that class of accident tends to leave behind is a histogram that a real
 * paper does not produce: a key column read from the wrong place collapses
 * toward one letter, and an option-index mapping that is off by one drops a
 * letter entirely. Both tails are tested here.
 *
 * The honest limit, stated where the check is: a mis-keyed set whose key is
 * still uniform passes this cleanly. A histogram cannot tell a right uniform
 * key from a wrong one. `--sample` is the answer to that case and this is not.
 */
export function checkKeyDistribution(set: VerifiableSet): PyqCheckOutcome {
  const { counts, unclassified, total } = keyDistribution(set);

  if (unclassified.length > 0) {
    return outcome(
      'key_distribution',
      'fail',
      [
        `${unclassified.length} question(s) have a correctIndex that names no option — the key cannot be read at all: ${formatNumbers(unclassified)}`,
      ],
      unclassified,
    );
  }

  if (total === 0) {
    return outcome('key_distribution', 'skipped', ['no objective questions in this set']);
  }

  const shareOf = (letter: string): string =>
    `${letter}=${counts[letter]} (${Math.round((counts[letter] / total) * 100)}%)`;
  const histogram = OPTION_LETTERS.map(shareOf).join('  ');

  if (total < KEY_SKEW_MIN_QUESTIONS) {
    return outcome('key_distribution', 'skipped', [
      `only ${total} keyed questions — under ${KEY_SKEW_MIN_QUESTIONS} the histogram cannot distinguish a real key from a broken one, so nothing was concluded: ${histogram}`,
    ]);
  }

  const threshold = keySkewThreshold(total);
  const messages: string[] = [];
  const implicated: number[] = [];

  for (const letter of OPTION_LETTERS) {
    if (counts[letter] / total <= threshold) continue;
    const numbers = set.mcqs
      .filter((mcq) => OPTION_LETTERS[mcq.correctIndex] === letter)
      .map((mcq) => mcq.number);
    messages.push(
      `key '${letter}' takes ${counts[letter]} of ${total} answers (${Math.round((counts[letter] / total) * 100)}%), over the ${Math.round(threshold * 100)}% ceiling for a ${total}-question paper — a real key is near-uniform, so this is a key read from the wrong column or the wrong booklet: ${formatNumbers(numbers)}`,
    );
    implicated.push(...numbers);
  }

  if (total >= KEY_ABSENT_MIN_QUESTIONS) {
    const absent = OPTION_LETTERS.filter((letter) => counts[letter] === 0);
    if (absent.length > 0) {
      messages.push(
        `key '${absent.join("', '")}' never occurs in ${total} questions — an option-index mapping that is off by one folds four letters into three: ${histogram}`,
      );
    }
  }

  if (messages.length > 0) return outcome('key_distribution', 'fail', messages, implicated);
  return outcome('key_distribution', 'pass', [
    `${histogram} across ${total} questions, all within the ${Math.round(threshold * 100)}% ceiling`,
  ]);
}

/* -------------------------------------------------------- 4. key runs */

/**
 * The failure the share threshold steps over.
 *
 * One page of a key table read out of alignment gives twenty-five consecutive
 * identical answers. That moves the letter's share to roughly 43% of a hundred
 * — under the ceiling, invisible — while leaving a run of twenty-five that a
 * real key produces about once in 4^24 papers.
 *
 * Not in the brief. Included because it is fifteen lines and it covers the
 * PARTIAL version of exactly the catastrophe the brief names.
 */
export function checkKeyRuns(set: VerifiableSet): PyqCheckOutcome {
  const inPrintedOrder = [...set.mcqs].sort((a, b) => a.number - b.number);
  const total = inPrintedOrder.length;

  if (total < KEY_SKEW_MIN_QUESTIONS) {
    return outcome('key_runs', 'skipped', [
      `only ${total} keyed questions — too few for a run length to mean anything`,
    ]);
  }

  const limit = maxPlausibleKeyRun(total);
  let longestStart = 0;
  let longestLength = 1;
  let runStart = 0;

  for (let i = 1; i <= inPrintedOrder.length; i += 1) {
    const same =
      i < inPrintedOrder.length &&
      inPrintedOrder[i].correctIndex === inPrintedOrder[runStart].correctIndex;
    if (same) continue;
    if (i - runStart > longestLength) {
      longestLength = i - runStart;
      longestStart = runStart;
    }
    runStart = i;
  }

  if (longestLength > limit) {
    const run = inPrintedOrder.slice(longestStart, longestStart + longestLength);
    const letter = optionLabel(run[0].correctIndex);
    return outcome(
      'key_runs',
      'fail',
      [
        `${longestLength} consecutive questions all answer '${letter}' (limit ${limit} for a ${total}-question paper) — a key table read out of alignment for one page looks exactly like this: ${formatNumbers(run.map((mcq) => mcq.number))}`,
      ],
      run.map((mcq) => mcq.number),
    );
  }

  return outcome('key_runs', 'pass', [
    `longest run of one answer letter is ${longestLength}, within the limit of ${limit}`,
  ]);
}

/* --------------------------------------------------- 5. duplicate stems */

/**
 * Two questions with the same stem means the segmenter split in the wrong place
 * — a page boundary read twice, or one question's options attached to the
 * previous question's text.
 *
 * Compared on the normalised stem so that a difference in a comma or a line
 * break does not hide the duplication.
 */
export function checkDuplicateStems(set: VerifiableSet): PyqCheckOutcome {
  const byNormalised = new Map<string, number[]>();
  for (const { number, text } of stems(set)) {
    const key = normaliseStem(text);
    if (key === '') continue;
    const bucket = byNormalised.get(key);
    if (bucket === undefined) byNormalised.set(key, [number]);
    else bucket.push(number);
  }

  const messages: string[] = [];
  const implicated: number[] = [];
  for (const [key, numbers] of byNormalised) {
    if (numbers.length < 2) continue;
    const preview = key.length > 70 ? `${key.slice(0, 70)}…` : key;
    messages.push(
      `${numbers.length} questions share one stem — the segmenter split in the wrong place: ${formatNumbers(numbers)} — "${preview}"`,
    );
    implicated.push(...numbers);
  }

  if (messages.length > 0) return outcome('duplicate_stems', 'fail', messages, implicated);
  return outcome('duplicate_stems', 'pass', [
    `${byNormalised.size} distinct stems, no repeats`,
  ]);
}

/* ---------------------------------------------------- 6. PDF artefacts */

const CID_MARKER = '(cid:';
const FORM_FEED = '\f';

/**
 * A line that is page furniture and nothing else.
 *
 * `28` alone is also a perfectly good option for "how many states are there",
 * which is why this is only ever applied to a line of a MULTI-line field: page
 * furniture arrives NEXT TO content, whereas a numeric answer IS the content.
 */
const BARE_PAGE_NUMBER = /^(?:\d{1,3}|-\s*\d{1,3}\s*-|page\s+\d{1,3}(?:\s+of\s+\d{1,3})?)$/i;

/** Sentences are content. Headers are labels. */
const SENTENCE_END = /[.?:;!]$/;

/**
 * Furniture that the layout parser leaked into the content.
 *
 * `(cid:` is a PDF font-encoding failure escaping as literal text and means the
 * extraction of that glyph FAILED — the character it stands for is simply gone,
 * so the stem is not the stem. A form feed is a raw page break. A running
 * header or a bare page number is the page's chrome pasted into a question.
 *
 * All four are blocking, and none is repaired here: a stripped `(cid:` leaves a
 * stem with a hole in it that reads perfectly well, which is worse than one
 * that visibly announces the parser is broken.
 */
export function checkPdfArtefacts(
  set: VerifiableSet,
  allowLines: readonly string[] = [],
): PyqCheckOutcome {
  const messages: string[] = [];
  const implicated: number[] = [];
  const allowed = new Set([...STOCK_REPEATED_LINES, ...allowLines.map(normaliseLine)]);
  const fields = textFields(set);

  /** normalised line -> the distinct questions it turned up in */
  const repeated = new Map<string, Set<number>>();

  for (const field of fields) {
    if (field.text.includes(CID_MARKER)) {
      messages.push(
        `${qLabel(field.number)} ${field.where} contains "${CID_MARKER}" — a PDF font-encoding failure, so at least one character of this text was never extracted`,
      );
      implicated.push(field.number);
    }
    if (field.text.includes(FORM_FEED)) {
      messages.push(
        `${qLabel(field.number)} ${field.where} contains a form feed — a raw page break landed inside the content`,
      );
      implicated.push(field.number);
    }

    const lines = field.text.split('\n');
    if (lines.length < 2) continue;

    for (const raw of lines) {
      const line = normaliseLine(raw);
      if (line === '') continue;
      if (BARE_PAGE_NUMBER.test(line)) {
        messages.push(
          `${qLabel(field.number)} ${field.where} has "${raw.trim()}" on a line of its own — a page number inside the question text`,
        );
        implicated.push(field.number);
        continue;
      }
      if (line.length > HEADER_MAX_LENGTH || SENTENCE_END.test(line)) continue;
      if (allowed.has(line)) continue;
      const seenIn = repeated.get(line);
      if (seenIn === undefined) repeated.set(line, new Set([field.number]));
      else seenIn.add(field.number);
    }
  }

  for (const [line, questions] of repeated) {
    if (questions.size < HEADER_MIN_QUESTIONS) continue;
    messages.push(
      `"${line}" appears inside ${questions.size} different questions as a line of its own — a running header the layout parser pasted into the content: ${formatNumbers([...questions])} (if it really is content, re-run with --allow-line "${line}")`,
    );
    implicated.push(...questions);
  }

  if (messages.length > 0) return outcome('pdf_artefacts', 'fail', messages, implicated);
  return outcome('pdf_artefacts', 'pass', [
    `no (cid: markers, form feeds, page numbers or running headers in ${fields.length} text fields`,
  ]);
}

/* -------------------------------------------------- 7. suspicious stems */

/**
 * Never blocks. This one is a pointer for the human, not a verdict.
 *
 * A negation question is where an extraction error is simultaneously most
 * likely and most costly: lose the word "NOT" and what remains is fluent,
 * well-formed, and asks the opposite question, with a key that now marks the
 * true statement wrong. No machine can tell whether the "NOT" survived. What a
 * machine can do is point at the questions worth a human's eyes first, which is
 * also what `--sample` weights by.
 */
export function checkSuspiciousStems(set: VerifiableSet): PyqCheckOutcome {
  const all = stems(set);
  const flagged = all.filter((s) => hasNegation(s.text)).map((s) => s.number);
  if (flagged.length === 0) {
    return outcome('suspicious_stems', 'pass', [
      `no negation words (not / except / incorrect) in ${all.length} stems`,
    ]);
  }
  return outcome(
    'suspicious_stems',
    'attention',
    [
      `${flagged.length} of ${all.length} stems carry a negation word (not / except / incorrect) — a dropped "NOT" leaves fluent English asking the opposite question, so check these against the paper first: ${formatNumbers(flagged)}`,
    ],
    flagged,
  );
}

/* ------------------------------------------------------------ the report */

export interface PyqVerifyOptions {
  /** How many questions the paper claims. Overrides the per-exam default. */
  expectedTotal?: number | null;
  /** Repeated lines a human has declared to be content, not furniture. */
  allowLines?: readonly string[];
}

/** Every invariant, in the order a human would want to read them. */
export function verifySet(set: VerifiableSet, options: PyqVerifyOptions = {}): PyqVerifyReport {
  const expectedTotal = resolveExpectedTotal(set, options.expectedTotal);
  const checks: PyqCheckOutcome[] = [
    checkNumbering(set, expectedTotal),
    checkDropAccounting(set, expectedTotal),
    checkKeyDistribution(set),
    checkKeyRuns(set),
    checkDuplicateStems(set),
    checkPdfArtefacts(set, options.allowLines ?? []),
    checkSuspiciousStems(set),
  ];
  return {
    setKey: pyqSetKey(set.exam, set.year, set.booklet),
    expectedTotal,
    checks,
    blocked: checks.some(isBlocking),
  };
}

/* -------------------------------------------------------------- sampling */

export interface PyqSampleItem {
  number: number;
  stem: string;
  /** In the order this booklet prints them. Empty for a written paper. */
  options: readonly string[];
  /** The letter the paper's key should show beside this question. */
  keyLetter: string | null;
  negation: boolean;
}

/** Fifteen per hundred, never zero for a non-empty set, never more than exists. */
export function defaultSampleSize(questionCount: number): number {
  if (questionCount === 0) return 0;
  return Math.min(questionCount, Math.max(1, Math.round((questionCount * SAMPLE_PER_HUNDRED) / 100)));
}

/**
 * Evenly spaced picks, not random ones.
 *
 * A sample is meant to cover the paper. Random picks clump, and a clump leaves
 * a whole stretch of pages unlooked-at — which is exactly where a segmenter
 * that went wrong at page seven hides. Spacing is also deterministic, so
 * re-running the tool gives the same list to compare against the same paper.
 */
function spread<T>(items: readonly T[], take: number): T[] {
  if (take <= 0) return [];
  if (take >= items.length) return [...items];
  const picked: T[] = [];
  for (let i = 0; i < take; i += 1) {
    picked.push(items[Math.floor(((i + 0.5) * items.length) / take)]);
  }
  return picked;
}

function sampleItems(set: VerifiableSet): PyqSampleItem[] {
  const items: PyqSampleItem[] = [
    ...set.mcqs.map((mcq) => ({
      number: mcq.number,
      stem: mcq.stem,
      options: mcq.options,
      keyLetter: optionLabel(mcq.correctIndex),
      negation: hasNegation(mcq.stem),
    })),
    ...set.written.map((written) => ({
      number: written.number,
      stem: written.promptText,
      options: [] as readonly string[],
      keyLetter: null,
      negation: hasNegation(written.promptText),
    })),
  ];
  return items.sort((a, b) => a.number - b.number);
}

/**
 * The questions a human should read off the screen with the paper in hand.
 *
 * Weighted toward negation because that is where an extraction error is both
 * likeliest and most damaging, and NOT made entirely of them because the
 * remaining share is what covers the ordinary questions a segmenter can lose.
 *
 * This is the only defence against the one failure no check in this file can
 * see — a key that is wrong and still uniform. Everything else here is
 * arithmetic; this is the part where somebody actually looks.
 */
export function sampleForEyeCheck(set: VerifiableSet, size: number): readonly PyqSampleItem[] {
  const all = sampleItems(set);
  const want = Math.max(0, Math.min(size, all.length));
  if (want === 0) return [];

  const negation = all.filter((item) => item.negation);
  const plain = all.filter((item) => !item.negation);

  let fromNegation = Math.min(negation.length, Math.ceil(want * SAMPLE_NEGATION_SHARE));
  let fromPlain = want - fromNegation;
  if (fromPlain > plain.length) {
    fromPlain = plain.length;
    fromNegation = Math.min(negation.length, want - fromPlain);
  }

  return [...spread(negation, fromNegation), ...spread(plain, fromPlain)].sort(
    (a, b) => a.number - b.number,
  );
}

/* ------------------------------------------------------------- rendering */

const STATUS_LABEL: Readonly<Record<PyqCheckStatus, string>> = {
  pass: 'PASS',
  fail: 'FAIL',
  attention: 'LOOK',
  skipped: 'SKIP',
};

function verificationLine(set: VerifiableSet): string {
  const v = set.verification;
  if (v === null) {
    return 'verification: NONE — planPyqImport will refuse this set whatever this tool says';
  }
  return `verification: ${v.keySource} — ${v.verifiedBy} on ${v.verifiedOn}`;
}

export function renderReport(set: VerifiableSet, report: PyqVerifyReport): string[] {
  const lines: string[] = [];
  lines.push('='.repeat(76));
  lines.push(report.setKey);
  lines.push(
    `${set.mcqs.length + set.written.length} shipped, ${set.dropped.length} dropped, paper total ${report.expectedTotal ?? 'unknown'}`,
  );
  lines.push(verificationLine(set));
  lines.push('='.repeat(76));
  for (const check of report.checks) {
    lines.push(`${STATUS_LABEL[check.status]}  ${check.check}`);
    for (const message of check.messages) lines.push(`      ${message}`);
  }
  return lines;
}

export function renderSample(items: readonly PyqSampleItem[], total: number): string[] {
  const lines: string[] = [];
  lines.push('');
  lines.push('-'.repeat(76));
  lines.push(
    `SAMPLE — ${items.length} of ${total} questions, weighted toward negation stems.`,
  );
  lines.push('Read each one off this screen against the paper in hand: the stem, the');
  lines.push('options IN THIS ORDER, and the key letter. This is the only check that can');
  lines.push('catch a key that is wrong but evenly spread.');
  lines.push('-'.repeat(76));
  for (const item of items) {
    lines.push('');
    lines.push(`${qLabel(item.number)}${item.negation ? '   [negation]' : ''}`);
    for (const stemLine of item.stem.split('\n')) lines.push(`    ${stemLine}`);
    item.options.forEach((option, index) => {
      lines.push(`      ${optionLabel(index)}. ${option}`);
    });
    if (item.keyLetter !== null) lines.push(`    key: ${item.keyLetter}`);
  }
  return lines;
}

/* --------------------------------------------------------- reading input */

export type PyqParseResult =
  | { ok: true; sets: readonly VerifiableSet[] }
  | { ok: false; errors: readonly string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMcq(value: unknown, at: string, errors: string[]): VerifiableMcq | null {
  if (!isRecord(value)) {
    errors.push(`${at} is not an object`);
    return null;
  }
  const { number, stem, options, correctIndex } = value;
  let bad = false;
  if (typeof number !== 'number') {
    errors.push(`${at}.number is missing or not a number`);
    bad = true;
  }
  if (typeof stem !== 'string') {
    errors.push(`${at}.stem is missing or not a string`);
    bad = true;
  }
  if (!Array.isArray(options) || options.some((o) => typeof o !== 'string')) {
    errors.push(`${at}.options is missing or not an array of strings`);
    bad = true;
  }
  if (typeof correctIndex !== 'number') {
    errors.push(`${at}.correctIndex is missing or not a number`);
    bad = true;
  }
  if (bad) return null;
  return {
    number: number as number,
    stem: stem as string,
    options: options as string[],
    correctIndex: correctIndex as number,
  };
}

function parseWritten(value: unknown, at: string, errors: string[]): VerifiableWritten | null {
  if (!isRecord(value)) {
    errors.push(`${at} is not an object`);
    return null;
  }
  const { number, promptText, caseDetail } = value;
  let bad = false;
  if (typeof number !== 'number') {
    errors.push(`${at}.number is missing or not a number`);
    bad = true;
  }
  if (typeof promptText !== 'string') {
    errors.push(`${at}.promptText is missing or not a string`);
    bad = true;
  }
  if (caseDetail !== undefined && caseDetail !== null && typeof caseDetail !== 'string') {
    errors.push(`${at}.caseDetail is neither a string nor null`);
    bad = true;
  }
  if (bad) return null;
  return {
    number: number as number,
    promptText: promptText as string,
    caseDetail: typeof caseDetail === 'string' ? caseDetail : null,
  };
}

/**
 * A drop with no `reason` key at all parses to `reason: ''` rather than being
 * rejected here, so that `checkDropAccounting` is the thing that reports it.
 * A parse error would name the JSON path; the check names the question.
 */
function parseDropped(value: unknown, at: string, errors: string[]): VerifiableDropped | null {
  if (!isRecord(value)) {
    errors.push(`${at} is not an object`);
    return null;
  }
  if (typeof value.number !== 'number') {
    errors.push(`${at}.number is missing or not a number`);
    return null;
  }
  return {
    number: value.number,
    reason: typeof value.reason === 'string' ? value.reason : '',
    note: typeof value.note === 'string' ? value.note : null,
  };
}

function parseVerification(value: unknown): PyqVerification | null {
  if (!isRecord(value)) return null;
  const { verifiedBy, verifiedOn, keySource, sourceUrl, note } = value;
  if (typeof verifiedBy !== 'string' || typeof verifiedOn !== 'string') return null;
  if (
    keySource !== 'upsc_official' &&
    keySource !== 'upsc_revised' &&
    keySource !== 'published_consensus'
  ) {
    return null;
  }
  return {
    verifiedBy,
    verifiedOn,
    keySource,
    sourceUrl: typeof sourceUrl === 'string' ? sourceUrl : null,
    note: typeof note === 'string' ? note : null,
  };
}

function parseSet(value: unknown, at: string, errors: string[]): VerifiableSet | null {
  if (!isRecord(value)) {
    errors.push(`${at} is not an object`);
    return null;
  }
  const before = errors.length;
  if (!isPyqExam(value.exam)) errors.push(`${at}.exam is not one of the known PYQ_EXAMS`);
  if (typeof value.year !== 'number') errors.push(`${at}.year is missing or not a number`);
  if (!isPyqBooklet(value.booklet)) {
    errors.push(`${at}.booklet is not one of the known PYQ_BOOKLETS`);
  }

  const mcqsRaw = value.mcqs ?? [];
  const writtenRaw = value.written ?? [];
  const droppedRaw = value.dropped ?? [];
  if (!Array.isArray(mcqsRaw)) errors.push(`${at}.mcqs is not an array`);
  if (!Array.isArray(writtenRaw)) errors.push(`${at}.written is not an array`);
  if (!Array.isArray(droppedRaw)) errors.push(`${at}.dropped is not an array`);
  if (errors.length > before) return null;

  const mcqs = (mcqsRaw as unknown[]).map((m, i) => parseMcq(m, `${at}.mcqs[${i}]`, errors));
  const written = (writtenRaw as unknown[]).map((w, i) =>
    parseWritten(w, `${at}.written[${i}]`, errors),
  );
  const dropped = (droppedRaw as unknown[]).map((d, i) =>
    parseDropped(d, `${at}.dropped[${i}]`, errors),
  );
  if (errors.length > before) return null;

  return {
    exam: value.exam as PyqExam,
    year: value.year as number,
    booklet: value.booklet as PyqBooklet,
    verification: parseVerification(value.verification),
    mcqs: mcqs as VerifiableMcq[],
    written: written as VerifiableWritten[],
    dropped: dropped as VerifiableDropped[],
  };
}

/**
 * Accepts one set, an array of sets, or a `{ sets: [...] }` dataset.
 *
 * Shape only. It refuses what it cannot READ — a missing stem, a `correctIndex`
 * that is a string — and judges nothing: option counts, key ranges and empty
 * stems belong to `validateMcq` in `lib/pyq-import.ts` and are not re-litigated
 * here. Nothing absent is filled in with a plausible value.
 */
export function parseSetsJson(text: string): PyqParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`not valid JSON: ${(error as Error).message}`] };
  }

  const errors: string[] = [];
  let raw: unknown[];
  if (Array.isArray(value)) raw = value;
  else if (isRecord(value) && Array.isArray(value.sets)) raw = value.sets;
  else raw = [value];

  const sets = raw.map((entry, i) => parseSet(entry, `sets[${i}]`, errors));
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, sets: sets as VerifiableSet[] };
}

/* ------------------------------------------------------------------- CLI */

/** Clean. */
export const EXIT_OK = 0;
/** At least one invariant failed. The set must not be imported. */
export const EXIT_BLOCKED = 1;
/** The tool could not run at all — bad arguments, unreadable file, bad shape. */
export const EXIT_UNUSABLE = 2;

export interface CliOptions {
  path: string | null;
  /** Null means no sample was asked for. */
  sample: number | null;
  expectedTotal: number | null;
  allowLines: string[];
  json: boolean;
  help: boolean;
}

export function usageLines(): string[] {
  return [
    'pyq-verify — mechanical invariants for an extracted UPSC question set.',
    '',
    '  node --import tsx tools/pyq-verify.ts <set.json> [options]',
    '',
    '  --sample [N]      print N questions for a human to check against the paper,',
    `                    weighted toward negation stems (default ${SAMPLE_PER_HUNDRED} per 100)`,
    '  --expected N      how many questions the paper has (prelims-gs1 defaults to 100)',
    '  --allow-line S    a repeated line that is content, not a running header;',
    '                    repeatable',
    '  --json            machine-readable report on stdout',
    '  -h, --help        this',
    '',
    `Exit ${EXIT_OK} clean, ${EXIT_BLOCKED} when an invariant failed, ${EXIT_UNUSABLE} when the input could not be read.`,
    'This tool never writes anything. It reports; a human fixes the extractor.',
  ];
}

export function parseArgs(argv: readonly string[]): { options: CliOptions } | { error: string } {
  const options: CliOptions = {
    path: null,
    sample: null,
    expectedTotal: null,
    allowLines: [],
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--sample') {
      const next = argv[i + 1];
      if (next !== undefined && /^\d+$/.test(next)) {
        options.sample = Number(next);
        i += 1;
      } else {
        // Resolved against the set's own size once it is known.
        options.sample = -1;
      }
    } else if (arg === '--expected') {
      const next = argv[i + 1];
      if (next === undefined || !/^\d+$/.test(next)) return { error: '--expected needs a number' };
      options.expectedTotal = Number(next);
      i += 1;
    } else if (arg === '--allow-line') {
      const next = argv[i + 1];
      if (next === undefined) return { error: '--allow-line needs a line of text' };
      options.allowLines.push(next);
      i += 1;
    } else if (arg.startsWith('-')) {
      return { error: `unknown option ${arg}` };
    } else if (options.path !== null) {
      return { error: `more than one input file given (${options.path}, ${arg})` };
    } else {
      options.path = arg;
    }
  }

  return { options };
}

export interface CliResult {
  exitCode: number;
  lines: string[];
}

/**
 * `readFile` is a parameter so the whole CLI is testable without a disk and
 * without `mock.module`, which the tests' CommonJS emit cannot use.
 */
export function runCli(argv: readonly string[], readFile: (path: string) => string): CliResult {
  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    return { exitCode: EXIT_UNUSABLE, lines: [`pyq-verify: ${parsed.error}`, '', ...usageLines()] };
  }
  const options = parsed.options;
  if (options.help) return { exitCode: EXIT_OK, lines: usageLines() };
  if (options.path === null) {
    return { exitCode: EXIT_UNUSABLE, lines: ['pyq-verify: no input file given', '', ...usageLines()] };
  }

  let text: string;
  try {
    text = readFile(options.path);
  } catch (error) {
    return {
      exitCode: EXIT_UNUSABLE,
      lines: [`pyq-verify: cannot read ${options.path}: ${(error as Error).message}`],
    };
  }

  const parsedSets = parseSetsJson(text);
  if (!parsedSets.ok) {
    return {
      exitCode: EXIT_UNUSABLE,
      lines: [
        `pyq-verify: ${options.path} is not a readable question set`,
        ...parsedSets.errors.map((e) => `  ${e}`),
      ],
    };
  }
  if (parsedSets.sets.length === 0) {
    return { exitCode: EXIT_UNUSABLE, lines: [`pyq-verify: ${options.path} contains no sets`] };
  }

  const reports = parsedSets.sets.map((set) =>
    verifySet(set, { expectedTotal: options.expectedTotal, allowLines: options.allowLines }),
  );
  const samples = parsedSets.sets.map((set) => {
    if (options.sample === null) return [];
    const count = set.mcqs.length + set.written.length;
    const size = options.sample === -1 ? defaultSampleSize(count) : options.sample;
    return sampleForEyeCheck(set, size);
  });
  const blocked = reports.some((report) => report.blocked);

  if (options.json) {
    return {
      exitCode: blocked ? EXIT_BLOCKED : EXIT_OK,
      lines: [JSON.stringify({ blocked, reports, samples }, null, 2)],
    };
  }

  const lines: string[] = [];
  parsedSets.sets.forEach((set, i) => {
    lines.push(...renderReport(set, reports[i]));
    if (samples[i].length > 0) {
      lines.push(...renderSample(samples[i], set.mcqs.length + set.written.length));
    }
    lines.push('');
  });

  const failed = reports.reduce((n, report) => n + report.checks.filter(isBlocking).length, 0);
  const totalChecks = reports.reduce((n, report) => n + report.checks.length, 0);
  lines.push('='.repeat(76));
  if (blocked) {
    lines.push(`BLOCKED — ${failed} of ${totalChecks} checks failed. Do not import this set.`);
    lines.push('Fix the extractor and run it again. Nothing on disk has been changed by this');
    lines.push('tool, and nothing here has been repaired: the artefacts above are evidence.');
  } else {
    lines.push(`OK — ${totalChecks} checks passed or were noted.`);
    lines.push('A pass is NOT a verified key. These are mechanical invariants; they cannot');
    lines.push('see a key that is wrong and evenly spread. Run --sample and check those');
    lines.push('questions against the paper before writing a PyqVerification.');
  }
  lines.push('='.repeat(76));

  return { exitCode: blocked ? EXIT_BLOCKED : EXIT_OK, lines };
}

/**
 * Run only when this file IS the program.
 *
 * Neither `require.main === module` nor `import.meta.url` type-checks under
 * both tsconfigs in this repo — the tests emit CommonJS and the app config does
 * not — and the test file imports this module for its pure functions, so the
 * body must not execute on import. The invoked script's basename is the one
 * signal both configurations agree on, and it distinguishes the two cases
 * cleanly: under `node --test tests/pyq-verify.test.ts` the basename here is
 * the TEST file's, never this one's.
 */
const invokedAs = basename(process.argv[1] ?? '');
if (invokedAs === 'pyq-verify.ts' || invokedAs === 'pyq-verify.js') {
  const result = runCli(process.argv.slice(2), (path) => readFileSync(path, 'utf8'));
  process.stdout.write(`${result.lines.join('\n')}\n`);
  process.exitCode = result.exitCode;
}
