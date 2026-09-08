/**
 * Scripted question generation and blind verification. No model, no spend.
 *
 * A fake that only emits GOOD questions is close to useless here, because the
 * thing worth testing is not "can questions reach the phone" — it is "does the
 * validation pipeline actually drop the bad ones". So this runner injects a
 * defect of each kind on a fixed cadence and the pipeline is expected to catch
 * every one. Running `npm run dev:fake` and seeing twenty questions arrive
 * would mean the safety net is not connected.
 *
 * Deterministic and seeded by (topicSlug, difficulty, requestId, ordinal).
 * A fixed script would emit the same twenty questions on every call, and the
 * second call would be entirely eaten by the dedup index — which looks exactly
 * like a banking bug and would send someone hunting for one.
 *
 * SAFETY: fake questions are marked THREE ways — `provenance: 'fake'`,
 * `meta.fake: true`, and a visible `[SAMPLE]` prefix in the stem. The first
 * two are invisible on a phone screen. A fake question that is banked and then
 * drilled by a spaced-repetition schedule is durable contamination of the one
 * artefact this whole endpoint exists to keep clean, so the marker she can
 * actually see is the one that matters. `index.ts` additionally refuses to
 * start with this enabled in production.
 */

import type {
  GenerationRequest,
  GenerationResult,
  McqRunner,
  McqUsage,
  RawVerdict,
  VerificationRequest,
  VerificationResult,
  VerificationRunner,
} from './mcq/runner.js';
import type { QuestionDraft, QuestionForm, Statement } from './mcq/types.js';
import { deriveExpectedSet, parseOptionSubset, setsEqual } from './mcq/validate.js';

/* --------------------------------------------------------------- seeding */

/** FNV-1a over the seed tuple. Same input, same question, every time. */
function seedOf(topicSlug: string, difficulty: string, requestId: string, ordinal: number): number {
  const material = `${topicSlug}|${difficulty}|${requestId}|${ordinal}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < material.length; i += 1) {
    h ^= material.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function pick<T>(items: readonly T[], seed: number, salt: number): T {
  const index = (seed >>> salt) % items.length;
  return items[index] as T;
}

const ADJECTIVES = [
  'devolutionary',
  'concurrent',
  'statutory',
  'quasi-judicial',
  'federal',
  'consultative',
  'regulatory',
  'advisory',
  'appellate',
  'residuary',
] as const;

const NOUNS = [
  'allocation mechanism',
  'oversight arrangement',
  'transfer framework',
  'appointment procedure',
  'review process',
  'classification scheme',
  'accountability channel',
  'delegation rule',
] as const;

const REGIONS = [
  'the Deccan plateau',
  'the eastern littoral',
  'the trans-Gangetic belt',
  'the western ghats corridor',
  'the north-eastern hill states',
  'the peninsular interior',
] as const;

/* ------------------------------------------------------- option layouts */

interface Layout {
  statementCount: number;
  options: string[];
  /** Parallel to `options`; the statement numbers each one names. */
  subsets: number[][];
}

/**
 * Both layouts are chosen so that some statement, resolved either way, rules
 * out two options — the elimination requirement the validator enforces. A
 * fake that failed that check on every question would exercise nothing but
 * one rejection branch.
 */
const LAYOUT_TWO: Layout = {
  statementCount: 2,
  options: ['1 only', '2 only', 'Both 1 and 2', 'Neither 1 nor 2'],
  subsets: [[1], [2], [1, 2], []],
};

const LAYOUT_THREE: Layout = {
  statementCount: 3,
  options: ['1 and 2 only', '2 and 3 only', '3 only', '1, 2 and 3'],
  subsets: [
    [1, 2],
    [2, 3],
    [3],
    [1, 2, 3],
  ],
};

const HOLDS = 'this proposition HOLDS';
const FAILS = 'this proposition DOES NOT HOLD';

/* ---------------------------------------------------- question synthesis */

function buildDraft(
  topicSlug: string,
  difficulty: string,
  requestId: string,
  ordinal: number,
  firstFactKey: string,
): QuestionDraft {
  const seed = seedOf(topicSlug, difficulty, requestId, ordinal);
  const layout = ordinal % 2 === 0 ? LAYOUT_THREE : LAYOUT_TWO;
  const answerIndex = seed % 4;
  const form: QuestionForm = seed % 4 === 3 ? 'statements_incorrect' : 'statements_correct';

  const adjective = pick(ADJECTIVES, seed, 3);
  const noun = pick(NOUNS, seed, 7);
  const region = pick(REGIONS, seed, 11);
  // Spread through the stem and every statement so that twenty questions are
  // far apart under SimHash despite sharing the boilerplate every UPSC
  // statement question shares.
  const ref = seed.toString(36).slice(0, 6);

  const named = new Set(layout.subsets[answerIndex] as number[]);
  // For `statements_correct` the named set is the TRUE statements; for
  // `statements_incorrect` it is the false ones. Set the verdicts from the
  // option, never the option from the verdicts, so the two cannot drift.
  const wantsTrue = form === 'statements_correct';

  const statements: Statement[] = [];
  for (let i = 1; i <= layout.statementCount; i += 1) {
    const isTrue = wantsTrue ? named.has(i) : !named.has(i);
    statements.push({
      index: i,
      text: `Under the ${adjective} ${noun} of ${region}, sub-clause ${ref}-${i} provides that ${
        isTrue ? HOLDS : FAILS
      }.`,
      isTrue,
    });
  }

  const closing =
    form === 'statements_correct'
      ? 'Which of the statements given above is/are correct?'
      : 'Which of the statements given above is/are NOT correct?';

  const stem = [
    `[SAMPLE] Consider the following statements about the ${adjective} ${noun} of ${region}`,
    `(sample question ${ordinal}, ref ${ref}):`,
    ...statements.map((s) => `${s.index}. ${s.text}`),
    closing,
  ].join('\n');

  return {
    form,
    stem,
    statements,
    options: [...layout.options],
    answerIndex,
    eliminationRationale: layout.options.map((option, i) =>
      i === answerIndex
        ? `[SAMPLE] Correct: sub-clauses ${ref} resolve to exactly this set.`
        : `[SAMPLE] Wrong: an aspirant picks "${option}" by misreading sub-clause ${ref}-1.`,
    ),
    factKey: ordinal % 17 === 0 ? firstFactKey : `sample:${topicSlug}:${ref}-${ordinal}`,
    verifiabilityAnchor: `[SAMPLE] Sub-clause ${ref}, notional handbook chapter ${ordinal}.`,
  };
}

/**
 * The defect schedule.
 *
 * Each cadence targets one stage of the pipeline, so a batch of twenty
 * exercises every rejection branch end to end rather than only the happy path.
 * The duplicate-factKey case is applied during synthesis above, because it has
 * to reference question 1's key.
 */
function injectDefect(draft: QuestionDraft, ordinal: number): QuestionDraft {
  // Every 7th: the verdicts no longer imply the key. Caught by the
  // self-consistency recomputation, which is the check that exists because
  // this is the single most common real failure.
  if (ordinal % 7 === 0) {
    const first = draft.statements[0];
    if (first) first.isTrue = !first.isTrue;
    return draft;
  }

  // Every 11th: two options naming the same set of statements. Caught by the
  // distinct-subset check; without it the question silently has three options.
  if (ordinal % 11 === 0) {
    const target = draft.options[0] ?? '1 only';
    const numbers = [...target.matchAll(/\d+/g)].map((m) => m[0]);
    draft.options[2] =
      numbers.length > 0
        ? `Statement${numbers.length > 1 ? 's' : ''} ${numbers.join(' and ')} alone`
        : 'No statement at all';
    return draft;
  }

  // Every 13th: a time-varying qualifier. Caught by the prohibition regex.
  if (ordinal % 13 === 0) {
    const first = draft.statements[0];
    if (first) first.text = first.text.replace('provides that', 'currently provides that');
    return draft;
  }

  return draft;
}

/* --------------------------------------------------------------- runners */

function fakeUsage(count: number): McqUsage {
  // Plausible rather than zero, so usage accounting and the cache-token
  // weighting are exercised with real arithmetic.
  return {
    inputTokens: 400,
    outputTokens: 260 * count,
    cacheCreationInputTokens: 1800,
    cacheReadInputTokens: 0,
  };
}

export const fakeMcqRunner: McqRunner = async (
  request: GenerationRequest,
): Promise<GenerationResult> => {
  await new Promise((resolve) => setImmediate(resolve));
  if (request.signal.aborted) throw new Error('Request was aborted');

  const firstFactKey = buildDraft(
    request.topicSlug,
    request.difficulty,
    request.requestId,
    1,
    'sample:seed',
  ).factKey;

  const drafts: QuestionDraft[] = [];
  for (let i = 0; i < request.count; i += 1) {
    const ordinal = request.ordinalOffset + i + 1;
    drafts.push(
      injectDefect(
        buildDraft(
          request.topicSlug,
          request.difficulty,
          request.requestId,
          ordinal,
          firstFactKey,
        ),
        ordinal,
      ),
    );
  }

  return {
    drafts,
    stopReason: 'end_turn',
    usage: fakeUsage(request.count),
    provenance: 'fake',
  };
};

/** Reads the ordinal the fake generator printed into the stem. */
function ordinalFromStem(stem: string): number {
  const match = /sample question (\d+)/.exec(stem);
  return match?.[1] ? Number(match[1]) : 0;
}

/**
 * A verifier that genuinely solves the question from the blind payload.
 *
 * It reads the statement text — which the fake generator writes to say
 * outright whether the proposition holds — works out the implied set, and
 * finds the option naming it. It never receives and never consults the key,
 * so the blindness of the payload is exercised for real rather than assumed.
 *
 * Every 19th question it deliberately answers differently, which is the only
 * way the drop-on-disagreement branch gets exercised outside production.
 */
export const fakeVerificationRunner: VerificationRunner = async (
  request: VerificationRequest,
): Promise<VerificationResult> => {
  await new Promise((resolve) => setImmediate(resolve));
  if (request.signal.aborted) throw new Error('Request was aborted');

  const parsed = JSON.parse(request.payload) as {
    questions: {
      form: QuestionForm;
      stem: string;
      options: string[];
      statements: { index: number; text: string }[];
    }[];
  };

  const verdicts: RawVerdict[] = [];
  parsed.questions.forEach((question, questionIndex) => {
    const statements = question.statements.map((s) => ({
      index: s.index,
      isTrue: !s.text.includes(FAILS),
    }));
    const expected = deriveExpectedSet(question.form, statements);

    let chosenIndex = question.options.findIndex((option) => {
      const subset = parseOptionSubset(option, statements.length);
      return subset !== null && setsEqual(subset, expected);
    });
    if (chosenIndex === -1) chosenIndex = 0;

    const ordinal = ordinalFromStem(question.stem);
    if (ordinal % 19 === 0) chosenIndex = (chosenIndex + 1) % question.options.length;

    verdicts.push({
      questionIndex,
      chosenIndex,
      confidence: 'high',
      ambiguous: false,
      timeDependent: false,
      factuallyDisputed: false,
    });
  });

  return {
    verdicts,
    stopReason: 'end_turn',
    usage: {
      inputTokens: 200 + 90 * parsed.questions.length,
      outputTokens: 40 * parsed.questions.length,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 900,
    },
  };
};
