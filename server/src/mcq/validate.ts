/**
 * The free half of the validation pipeline. Pure functions, no I/O, no clock.
 *
 * WHY THIS FILE IS THE POINT OF THE ENDPOINT: a wrong answer key does not
 * degrade gracefully. She cannot detect it — that is why she is drilling the
 * topic — and spaced repetition will faithfully drill the false fact to
 * mastery. The cost of shipping a bad question is therefore not "one bad
 * question", it is a durable false belief plus the effort of unlearning it.
 * Against that, dropping a good question costs one API call.
 *
 * So every check here is biased toward rejection, and UNDER-DELIVERY IS A
 * CORRECT OUTCOME. Twelve questions she can trust beat twenty she cannot.
 *
 * Ordering is deliberate: everything in this file is free and runs before the
 * paid blind-verification call. Paying a model to check a question that a
 * regex could have rejected is pure waste.
 */

import { MAX_STATEMENTS, OPTION_COUNT } from './schema.js';
import type { Difficulty, QuestionDraft, QuestionForm, RejectionReason } from './types.js';
import { QUESTION_FORMS } from './types.js';

export interface Rejection {
  ok: false;
  reason: RejectionReason;
  detail: string;
}

export interface Acceptance {
  ok: true;
  /** Recomputed from `statements[].isTrue`; equals `draft.answerIndex`. */
  derivedAnswerIndex: number;
}

export type ValidationResult = Acceptance | Rejection;

function reject(reason: RejectionReason, detail: string): Rejection {
  return { ok: false, reason, detail };
}

/* ---------------------------------------------------- option subset parsing */

/**
 * The set of statement numbers an option denotes, or null if it denotes none.
 *
 * "1 and 3 only" -> {1,3}. "Neither 1 nor 2" -> {}. "Bengaluru" -> null.
 *
 * Returning a SET rather than a string is what makes the distinctness check
 * meaningful: "1 and 2 only" and "Both 1 and 2" are different strings and the
 * same option, and a question with two identical options is a question with
 * three options — the guess rate silently rises from 25% to 33% and the
 * elimination logic she is meant to be practising stops working.
 */
export function parseOptionSubset(option: string, statementCount: number): Set<number> | null {
  const text = option.trim().toLowerCase();
  if (text === '') return null;

  const numbers = [...text.matchAll(/\d+/g)].map((m) => Number(m[0]));

  // "Neither 1 nor 2", "None of the statements given above is correct".
  const isNegated = /\b(neither|none|no statement)\b/.test(text);
  if (isNegated) {
    // "Neither 1 nor 2" names the statements it excludes, so any numbers found
    // are exclusions, not members. Either way the denoted set is empty.
    return new Set();
  }

  if (numbers.length === 0) {
    // "All of them" is a subset expression but an unnumbered one; it is also
    // on the prohibited list, so it is rejected either way. Anything else with
    // no digits does not denote a subset at all.
    if (/\ball\b/.test(text)) return new Set(rangeFrom(statementCount));
    return null;
  }

  const set = new Set<number>();
  for (const n of numbers) {
    if (!Number.isInteger(n) || n < 1 || n > statementCount) return null;
    set.add(n);
  }
  return set;
}

function rangeFrom(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i + 1);
}

export function setsEqual(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/** Stable key for a subset, so duplicates can be found with a Set of strings. */
export function subsetKey(set: Set<number>): string {
  return [...set].sort((x, y) => x - y).join(',');
}

/* ------------------------------------------------------------- prohibitions */

/**
 * Words that make a fact expire.
 *
 * A question banked today and drilled in fourteen months must still be true
 * then. "The current account deficit is currently..." is not a fact, it is a
 * snapshot, and spaced repetition will keep asserting it long after it stopped
 * being true.
 */
export const TIME_VARYING_PATTERN = /\b(current|currently|latest|present|recent|as of)\b/i;

/**
 * Office HOLDERS, not offices.
 *
 * "The President may promulgate ordinances under Article 123" is timeless and
 * is most of the Polity syllabus. "The President is X" expires at the next
 * election. Only the holder constructions are matched, because rejecting every
 * mention of an office would reject Polity itself — under-delivery is correct,
 * delivering nothing is not.
 */
const OFFICE =
  'president|vice[-\\s]president|prime\\s+minister|chief\\s+justice|chief\\s+minister|governor|speaker|deputy\\s+speaker|chairperson|chairman|secretary[-\\s]general|chief\\s+election\\s+commissioner|attorney\\s+general|solicitor\\s+general|comptroller\\s+and\\s+auditor\\s+general|cabinet\\s+secretary|director\\s+general';

export const OFFICE_HOLDER_PATTERNS: RegExp[] = [
  new RegExp(`\\bwho\\s+(is|are|was|were)\\s+(the\\s+)?(${OFFICE})\\b`, 'i'),
  // "The Prime Minister is Someone", "The Chief Justice, Someone Name, ..."
  new RegExp(`\\b(${OFFICE})\\b[^.]{0,40}?\\bis\\s+(currently\\s+)?[A-Z][a-z]+\\s+[A-Z][a-z]+`, ''),
  new RegExp(`\\b(incumbent|sitting|serving|present)\\s+(${OFFICE})\\b`, 'i'),
  new RegExp(`\\b(${OFFICE})\\s+(since|until)\\s+\\d{4}\\b`, 'i'),
  /\bheaded\s+by\s+[A-Z][a-z]+\s+[A-Z][a-z]+/,
];

/** Things whose count only ever goes up, so a stated total expires. */
const GROWABLE =
  'ramsar\\s+sites?|tiger\\s+reserves?|biosphere\\s+reserves?|world\\s+heritage\\s+sites?|gi\\s+tags?|national\\s+parks?|wildlife\\s+sanctuaries|elephant\\s+reserves?|smart\\s+cities|districts?|airports?|member\\s+states|signatories|unicorns?|start[-\\s]?ups?';

export const GROWING_COUNT_PATTERNS: RegExp[] = [
  new RegExp(`\\b(number|total|count)\\s+of\\s+(\\w+\\s+){0,3}(${GROWABLE})\\b`, 'i'),
  new RegExp(`\\bhow\\s+many\\s+(\\w+\\s+){0,3}(${GROWABLE})\\b`, 'i'),
  new RegExp(`\\b(there\\s+are|india\\s+has)\\s+\\d+\\s+(\\w+\\s+){0,3}(${GROWABLE})\\b`, 'i'),
  new RegExp(`\\b\\d+\\s+(${GROWABLE})\\b`, 'i'),
  /\bhas\s+(grown|risen|increased|climbed)\s+to\b/i,
];

/**
 * "All of the above" and "None of the above".
 *
 * Both are answerable without knowing the subject: a candidate who is sure of
 * two statements can resolve them by arithmetic. They test option-set reading,
 * not the syllabus.
 *
 * Note this is narrower than it looks — "None of the statements given above is
 * correct" is a legitimate UPSC option denoting the empty subset, and does not
 * match. Only the literal cliché does.
 */
export const ABOVE_OPTION_PATTERN = /\b(all|none|both)\s+of\s+the\s+above\b/i;

/** Correct option longer than this multiple of the mean of the others. */
export const LENGTH_CUE_RATIO = 1.6;

/**
 * Additive smoothing for the length-cue ratio.
 *
 * Without it the check divides by zero in the case it most needs to catch:
 * three bare subset options ("2 only", "Both 1 and 2") measure zero content,
 * so a mean of zero either skips the check or makes every question infinitely
 * over the ratio. Smoothing by a few characters makes "three bare options and
 * one carrying a paragraph of qualifiers" fire, and leaves "four bare options"
 * alone.
 */
const LENGTH_CUE_SMOOTHING = 8;

/**
 * Words that are subset-expression scaffolding rather than content.
 *
 * The length cue is about QUALIFICATION, not about boilerplate. Measured
 * naively, "Neither 1 nor 2" is 2.5x the length of "1 only" and every
 * perfectly ordinary UPSC option set would be rejected — the endpoint would
 * under-deliver to zero, which is not the kind of under-delivery that is
 * correct. Stripping the scaffolding leaves the thing the tell is actually
 * about: an option padded with the qualifiers that make it true.
 */
const OPTION_SCAFFOLD =
  /\b(only|both|neither|nor|and|none|no|of|the|statements?|given|above|is|are|correct|incorrect|not|all)\b/gi;

export function optionContentLength(option: string): number {
  return option.replace(OPTION_SCAFFOLD, '').replace(/[^a-z]/gi, '').length;
}

/* --------------------------------------------------------------- the checks */

export interface ValidationContext {
  difficulty: Difficulty;
}

/**
 * How many options are ruled out by learning the truth value of one statement.
 *
 * An option denotes a set S. For `statements_correct`, S is the claim "exactly
 * these statements are true", so learning that statement s IS true kills every
 * option whose set omits s, and learning it is NOT true kills every option
 * whose set contains it. `statements_incorrect` inverts which learning does
 * which, and the pair of counts is the same either way — so this is
 * form-independent by construction.
 */
export function eliminationPower(subsets: Set<number>[], statementIndex: number): number {
  let contains = 0;
  for (const s of subsets) if (s.has(statementIndex)) contains += 1;
  const omits = subsets.length - contains;
  return Math.min(contains, omits);
}

/**
 * The elimination requirement.
 *
 * A Prelims question is an elimination instrument, not a recall prompt: the
 * skill it trains is converting partial knowledge into a smaller option set.
 * If no single statement, resolved either way, kills at least two of the four
 * options, then partial knowledge buys nothing and the question is pure
 * recall wearing a Prelims costume.
 *
 * Enforced for `foundation` and `standard`, where building the habit is the
 * whole point. `challenging` is allowed to be knowledge-dense.
 */
export function hasEliminationPower(
  subsets: Set<number>[],
  statementCount: number,
  difficulty: Difficulty,
): boolean {
  if (difficulty === 'challenging') return true;
  for (let i = 1; i <= statementCount; i += 1) {
    if (eliminationPower(subsets, i) >= 2) return true;
  }
  return false;
}

/** The set of statements the verdicts say the key must name. */
export function deriveExpectedSet(
  form: QuestionForm,
  statements: readonly { index: number; isTrue: boolean }[],
): Set<number> {
  const wanted = form === 'statements_correct';
  const out = new Set<number>();
  for (const s of statements) if (s.isTrue === wanted) out.add(s.index);
  return out;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Everything free, in cost order. Returns the first failure, never a list:
 * the question is dropped either way and the first reason is the actionable
 * one for the rejection histogram.
 */
export function validateQuestion(draft: QuestionDraft, ctx: ValidationContext): ValidationResult {
  /* ------------------------------------------------------- 1. structural */

  if (!(QUESTION_FORMS as readonly string[]).includes(draft.form)) {
    return reject('structure', `unknown form ${String(draft.form)}`);
  }
  if (!isNonEmptyString(draft.stem)) return reject('structure', 'empty stem');
  if (!isNonEmptyString(draft.factKey)) return reject('structure', 'missing factKey');
  if (!isNonEmptyString(draft.verifiabilityAnchor)) {
    return reject('structure', 'missing verifiabilityAnchor');
  }

  if (!Array.isArray(draft.options) || draft.options.length !== OPTION_COUNT) {
    return reject('structure', `expected ${OPTION_COUNT} options`);
  }
  if (!draft.options.every(isNonEmptyString)) return reject('structure', 'an option is empty');

  const trimmed = draft.options.map((o) => o.trim().toLowerCase());
  if (new Set(trimmed).size !== OPTION_COUNT) {
    return reject('structure', 'two options are textually identical');
  }

  if (
    !Number.isInteger(draft.answerIndex) ||
    draft.answerIndex < 0 ||
    draft.answerIndex >= OPTION_COUNT
  ) {
    return reject('structure', `answerIndex ${String(draft.answerIndex)} out of range`);
  }

  if (
    !Array.isArray(draft.eliminationRationale) ||
    draft.eliminationRationale.length !== OPTION_COUNT ||
    !draft.eliminationRationale.every(isNonEmptyString)
  ) {
    // Including one for the key: without it the app can explain why three
    // options are wrong and not why the fourth is right, which is the half
    // that teaches.
    return reject('structure', `expected ${OPTION_COUNT} non-empty eliminationRationale entries`);
  }

  if (!Array.isArray(draft.statements) || draft.statements.length < 2) {
    return reject('structure', 'at least two statements are required');
  }
  if (draft.statements.length > MAX_STATEMENTS) {
    return reject('structure', `at most ${MAX_STATEMENTS} statements`);
  }
  const statementCount = draft.statements.length;
  const seenIndices = new Set<number>();
  for (const s of draft.statements) {
    if (!isNonEmptyString(s?.text)) return reject('structure', 'a statement is empty');
    if (typeof s.isTrue !== 'boolean') return reject('structure', 'a statement has no isTrue');
    if (!Number.isInteger(s.index) || s.index < 1 || s.index > statementCount) {
      return reject('structure', `statement index ${String(s.index)} out of range`);
    }
    if (seenIndices.has(s.index)) return reject('structure', 'duplicate statement index');
    seenIndices.add(s.index);
  }

  /* -------------------------------------- 1a. options denote distinct sets */

  const subsets: Set<number>[] = [];
  for (const option of draft.options) {
    const parsed = parseOptionSubset(option, statementCount);
    if (parsed === null) {
      return reject('option_subsets', `option does not denote a statement subset: ${option}`);
    }
    subsets.push(parsed);
  }
  const keys = subsets.map(subsetKey);
  if (new Set(keys).size !== OPTION_COUNT) {
    return reject('option_subsets', 'two options denote the same set of statements');
  }

  /* --------------------------------------------- 1b. elimination is possible */

  if (!hasEliminationPower(subsets, statementCount, ctx.difficulty)) {
    return reject(
      'elimination_power',
      'no statement, resolved either way, rules out two or more options',
    );
  }

  /* ------------------------------------------------------ 2. self-consistency */

  const expected = deriveExpectedSet(draft.form, draft.statements);
  const derivedAnswerIndex = subsets.findIndex((s) => setsEqual(s, expected));
  if (derivedAnswerIndex === -1) {
    return reject(
      'self_consistency',
      `no option matches the statements' own verdicts {${subsetKey(expected)}}`,
    );
  }
  if (derivedAnswerIndex !== draft.answerIndex) {
    // The most common real failure mode, and the most dangerous: the reasoning
    // is right and the translation from key to option is wrong. Without this
    // check it is invisible, because every rationale reads plausibly.
    return reject(
      'self_consistency',
      `answerIndex ${draft.answerIndex} but the verdicts imply ${derivedAnswerIndex}`,
    );
  }

  /* ---------------------------------------------------------- 3. prohibitions */

  const prose = [
    draft.stem,
    ...draft.statements.map((s) => s.text),
    ...draft.options,
    ...draft.eliminationRationale,
  ].join('\n');

  if (TIME_VARYING_PATTERN.test(prose)) {
    return reject('time_varying', 'contains a time-varying qualifier');
  }
  for (const pattern of OFFICE_HOLDER_PATTERNS) {
    if (pattern.test(prose)) return reject('time_varying', 'names an office holder');
  }
  for (const pattern of GROWING_COUNT_PATTERNS) {
    if (pattern.test(prose)) return reject('time_varying', 'states a count that grows over time');
  }

  for (const option of draft.options) {
    if (ABOVE_OPTION_PATTERN.test(option)) {
      return reject('above_option', 'uses an "all/none of the above" option');
    }
  }

  const correct = draft.options[draft.answerIndex] as string;
  const others = draft.options.filter((_, i) => i !== draft.answerIndex);
  const meanOtherLength =
    others.reduce((sum, o) => sum + optionContentLength(o), 0) / others.length;
  if (
    optionContentLength(correct) + LENGTH_CUE_SMOOTHING >
    LENGTH_CUE_RATIO * (meanOtherLength + LENGTH_CUE_SMOOTHING)
  ) {
    // The oldest tell in multiple choice: the writer qualifies the true option
    // into accuracy and leaves the distractors short. She would learn to pick
    // the long one, which is a test-taking reflex that transfers to nothing.
    return reject('length_cue', 'the correct option is conspicuously longer than the others');
  }

  return { ok: true, derivedAnswerIndex };
}
