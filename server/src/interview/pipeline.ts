/**
 * Deciding which generated questions reach the device.
 *
 * ## The fact check is the point of this file
 *
 * The prompt tells the model not to state facts. That is necessary and it is
 * not sufficient: a prompt instruction is a request, and the one failure this
 * phase cannot absorb is a fabricated fact about her home district reaching her
 * notes. So `looksLikeAnAnswer` runs on every question, deterministically, with
 * no model in the loop — the same relationship `ca/ground.ts` has to the
 * current-affairs prompt.
 *
 * It is a crude check and crude is the specification. It catches the shapes a
 * model actually produces when it slips — an appositive clause supplying a fact
 * ("your district, known for its silk weaving, ..."), a parenthetical gloss, a
 * figure the question has no business knowing. A false positive costs one
 * question out of eight. A false negative costs her the interview.
 */

import {
  MAX_AREA_CHARS,
  MAX_QUESTION_CHARS,
  isDafField,
  type DafEntryInput,
  type DafField,
  type QuestionDraft,
  type QuestionDropReason,
} from './types.js';
import type { GenerateRunner, InterviewUsage } from './runner.js';

const ZERO_USAGE: InterviewUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

/* ------------------------------------------------------------ the fact check */

/**
 * Phrases that introduce a fact the question has no business supplying.
 *
 * Each is an appositive or gloss pattern — the specific shape a model produces
 * when it decorates a question with knowledge it should have withheld. Matched
 * case-insensitively and only when they follow something, which is what makes
 * "known for" a gloss rather than a legitimate "what is it known for?".
 */
const GLOSS_PATTERNS: readonly RegExp[] = [
  // ", known for its silk weaving," and ", famous for ..."
  /,\s*(?:which is\s+)?(?:known|famous|noted|renowned)\s+(?:for|as)\b/i,
  // ", the largest producer of ..." — an appositive claim
  /,\s*the\s+(?:largest|biggest|oldest|first|only|highest|lowest)\b/i,
  // "(literacy 74%)" or "(pop. 1.6 million)" — a parenthetical fact.
  //
  // No trailing `\b`: `%` is not a word character and neither is `)`, so a
  // word boundary between them never matches and "(literacy 74%)" would slip
  // through the check written the obvious way. The word-ish units keep their
  // own boundary; the symbols do not need one.
  /\([^)]*\b\d[\d.,]*\s*(?:%|(?:percent|per cent|lakh|crore|million|billion|km)\b)[^)]*\)/i,
  // ", where the literacy rate is 74%" — a relative clause supplying a figure
  /,\s*where\b[^?]*\b\d/i,
  // "given that X is Y" — a premise handed to her
  /\bgiven that\b[^?]*\bis\b/i,
];

/**
 * Whether a question is smuggling an answer.
 *
 * Numbers alone are NOT enough to reject: "what is the sex ratio of your
 * district?" contains no digit, but "your district's 2011 sex ratio" does and
 * naming a census year is legitimate. The test is the gloss SHAPE, not the
 * presence of a fact-like token — a numeric filter would reject half the good
 * questions and teach nobody anything.
 */
export function looksLikeAnAnswer(question: string): boolean {
  return GLOSS_PATTERNS.some((pattern) => pattern.test(question));
}

/**
 * Whether it is a question at all.
 *
 * A board's prompts are sometimes imperative — "Take me through your decision
 * to leave engineering" — so a bare `?` test would drop real ones. The rule is
 * that it must ASK: end in a question mark, or open with an imperative that
 * invites an answer.
 */
export function isAskable(question: string): boolean {
  if (question.trim().endsWith('?')) return true;
  return /^(?:tell me|take me through|walk me through|describe|explain|talk about|convince me|suppose|imagine|you are|how would)\b/i.test(
    question.trim(),
  );
}

/* ------------------------------------------------------------- generation */

export interface AcceptedQuestion extends QuestionDraft {
  /** Normalised form used for duplicate detection. Never persisted. */
  fingerprint: string;
}

export interface QuestionDrop {
  question: string;
  reason: QuestionDropReason;
  detail: string;
}

export interface GenerationSummary {
  requested: number;
  returned: number;
  kept: number;
  dropped: number;
  dropReasons: Partial<Record<QuestionDropReason, number>>;
  underDelivered: boolean;
}

export interface GenerationOutcome {
  questions: AcceptedQuestion[];
  drops: QuestionDrop[];
  summary: GenerationSummary;
  usage: InterviewUsage;
  provenance: 'model' | 'fake';
  stopReason: string | null;
}

/**
 * A question's identity, for duplicate detection.
 *
 * Sorted significant word stems, the same device `ca/select.ts` and
 * `drills/pipeline.ts` use. It catches a REWORDING — "what is your district
 * known for" and "what is your district famous for" differ by one stem and
 * survive; "what is your district known for" and "for what is your district
 * known" collapse. Catching a true paraphrase needs an embedding, which is a
 * paid call to save one question out of eight.
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'did', 'do', 'does', 'for',
  'from', 'has', 'have', 'how', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'to',
  'was', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'you', 'your',
]);

export function questionFingerprint(question: string): string {
  const words = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word))
    .map((word) => word.replace(/(ing|ed|es|s)$/, ''))
    .filter((word) => word.length > 2);

  const stems = [...new Set(words)].sort().slice(0, 10).join('-');
  return stems === '' ? question.toLowerCase().replace(/\s+/g, ' ').trim() : stems;
}

export interface GenerationInput {
  requestId: string;
  entries: readonly DafEntryInput[];
  excludeQuestions: readonly string[];
  take: number;
  model: string;
  system: string;
}

export interface GenerationDeps {
  generate: GenerateRunner;
  signal: AbortSignal;
  log?: (message: string) => void;
}

function generateMaxTokens(take: number): number {
  return 600 + take * 160;
}

export async function runGeneration(
  input: GenerationInput,
  deps: GenerationDeps,
): Promise<GenerationOutcome> {
  const suppliedFields = new Set<DafField>(input.entries.map((entry) => entry.field));

  const result = await deps.generate({
    model: input.model,
    system: input.system,
    entries: input.entries,
    excludeQuestions: input.excludeQuestions,
    take: input.take,
    maxTokens: generateMaxTokens(input.take),
    requestId: input.requestId,
    signal: deps.signal,
  });

  const drafts = result.drafts ?? [];
  const drops: QuestionDrop[] = [];
  const kept: AcceptedQuestion[] = [];

  // Seeded from the device's bank, then grown as this batch accepts, so one
  // batch cannot bank the same question twice under two wordings.
  const seen = new Set(input.excludeQuestions.map(questionFingerprint));

  const drop = (question: string, reason: QuestionDropReason, detail: string): void => {
    drops.push({ question: question.slice(0, 120), reason, detail });
    deps.log?.(`[interview] dropped (${reason}): ${detail}`);
  };

  for (const draft of drafts) {
    const question = draft.question.trim();
    if (question === '') {
      drop('', 'empty_question', 'a question with no text');
      continue;
    }
    if (question.length > MAX_QUESTION_CHARS) {
      drop(question, 'question_too_long', `${question.length} chars over ${MAX_QUESTION_CHARS}`);
      continue;
    }

    // THE check. Before anything else, because a question that supplies a fact
    // is worse than no question and the other rules are about usefulness.
    if (looksLikeAnAnswer(question)) {
      drop(question, 'contains_answer', `supplies a fact rather than asking for it: ${question}`);
      continue;
    }

    if (!isAskable(question)) {
      drop(question, 'not_a_question', `does not ask anything: ${question}`);
      continue;
    }

    if (draft.field !== null && !isDafField(draft.field)) {
      drop(question, 'unknown_field', `unrecognised field "${String(draft.field)}"`);
      continue;
    }

    // A question about a field she left blank is one she cannot prepare for,
    // and it is also the shape a hallucinated biography takes: the model
    // inventing a university she never mentioned.
    if (draft.field !== null && !suppliedFields.has(draft.field)) {
      drop(question, 'field_not_supplied', `about "${draft.field}", which she has not filled in`);
      continue;
    }

    const fingerprint = questionFingerprint(question);
    if (seen.has(fingerprint)) {
      drop(question, 'duplicate', `restates a question already banked: ${question}`);
      continue;
    }

    if (kept.length >= input.take) {
      drop(question, 'duplicate', `over the ${input.take} asked for`);
      continue;
    }

    seen.add(fingerprint);
    kept.push({
      field: draft.field,
      area: draft.area.slice(0, MAX_AREA_CHARS),
      question,
      likelihood: draft.likelihood,
      fingerprint,
    });
  }

  const dropReasons: Partial<Record<QuestionDropReason, number>> = {};
  for (const entry of drops) {
    dropReasons[entry.reason] = (dropReasons[entry.reason] ?? 0) + 1;
  }

  return {
    questions: kept,
    drops,
    summary: {
      requested: input.take,
      returned: drafts.length,
      kept: kept.length,
      dropped: drops.length,
      dropReasons,
      underDelivered: kept.length < input.take,
    },
    usage: result.usage ?? ZERO_USAGE,
    provenance: result.provenance,
    stopReason: result.stopReason,
  };
}
