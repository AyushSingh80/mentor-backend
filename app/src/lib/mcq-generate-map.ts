/**
 * Wire `question` frame -> bankable row. Pure, and the only place that decides
 * what is allowed into the bank.
 *
 * This is the contract guard. Everything upstream of it — the model, the
 * server's own validation, the SSE framing — can be wrong in ways that are
 * silent on the device, and every one of those ways ends up as a question
 * rendered on a train with no signal and no way to report it. So the rule here
 * is: reject anything that would render broken, accept everything else, and
 * COUNT what was rejected so a systematically bad prompt cohort is visible in
 * the refill ledger rather than only in her confidence.
 *
 * ## Reject, and why each one
 *
 * - Not four options. `OPTION_COUNT` is 4 and the answer pad is built for four;
 *   three renders a hole and five renders an option she cannot reach.
 * - `correctIndex` outside 0..3. An out-of-range key means every attempt is
 *   marked wrong, under negative marking, forever.
 * - Empty `eliminationLogic`. The elimination logic is the part that teaches —
 *   without it the question is a scoring event, not a drill, and it is exactly
 *   the material a paid generation call is for.
 * - A stem already in the bank. Not an error on the server's part: the exclude
 *   list is best-effort and a paraphrase can slip through. Counted, not raised.
 *
 * ## Accept, and why
 *
 * - An unknown syllabus slug resolves to `syllabusTopicId: null`. The app ships
 *   its syllabus as seed data and the server's copy can be a revision ahead. If
 *   a slug the app has not learned about yet rejected the question, one syllabus
 *   correction on the server would turn into a total bank outage on the device
 *   — an offline failure caused by being online. The question is still a good
 *   question; it is simply unattributed until the next seed.
 *
 * ## Never throws
 *
 * A wholly malformed payload returns an empty `accepted`, never an exception.
 * This runs inside a streaming read loop on a fire-and-forget code path: a
 * throw here would abandon the rest of the stream and discard every question
 * already banked in this batch.
 */

import {
  OPTION_COUNT,
  OPTION_LETTERS,
  type Difficulty,
  type QuestionSource,
} from '@/lib/mcq-types';
import { stemFingerprint } from '@/lib/mcq-bank';

/* ------------------------------------------------------------------ output */

/**
 * A row ready for `mcq_questions`.
 *
 * `promptVersion` has no column of its own — the schema is frozen — so it
 * travels with the batch instead: it is written once onto the refill ledger row
 * (`mcq_bank_refills.plan_json`), and every question here carries the
 * `batchId` that ties back to it. The retroactive purge handle is therefore
 * "find the refills generated under prompt X, take their batch ids, quarantine
 * those questions", which is one join rather than one column.
 */
export interface BankableQuestion {
  stem: string;
  /** Always length `OPTION_COUNT`. */
  options: string[];
  correctIndex: number;
  eliminationLogic: string;
  difficulty: Difficulty;
  source: QuestionSource;
  pyqYear: number | null;
  pyqPaper: string | null;
  /** `null` when the server named a slug this build's syllabus does not have. */
  syllabusTopicId: number | null;
  /** Kept for the record even when it did not resolve. */
  syllabusSlug: string | null;
  sectionKey: string | null;
  stemFingerprint: string;
  /**
   * The server's stable id for this question, so a client-side timeout can
   * re-fetch the batch rather than pay to regenerate it. The server calls it
   * `externalId` or `factKey` depending on which side of its own refactor it
   * is on; both land here.
   */
  externalId: string | null;
  batchId: string | null;
  promptVersion: string | null;
}

export type RejectionReason =
  | 'not_an_object'
  | 'empty_stem'
  | 'option_count'
  | 'empty_option'
  | 'duplicate_option'
  | 'correct_index'
  | 'empty_elimination_logic'
  | 'pyq_without_year'
  | 'duplicate_stem';

export interface Rejection {
  index: number;
  reason: RejectionReason;
  /** One line, safe to log. Never the whole payload. */
  detail: string;
}

export interface MappedBatch {
  accepted: BankableQuestion[];
  rejected: Rejection[];
  /** Rejections whose reason was `duplicate_stem`, counted out separately. */
  duplicates: number;
  /** Slugs the server used that this build's syllabus does not know. */
  unknownSlugs: string[];
}

export interface MapContext {
  /** `syllabus_topics.slug` -> id. */
  topicIdBySlug: ReadonlyMap<string, number>;
  /** Fingerprints already banked. The exclude list is best-effort, not a lock. */
  knownFingerprints: ReadonlySet<string>;
  batchId: string | null;
  promptVersion: string | null;
}

export type MapOutcome =
  | { ok: true; question: BankableQuestion }
  | { ok: false; reason: RejectionReason; detail: string };

/* --------------------------------------------------------------- primitives */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function integer(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  // A JSON number arriving as a string is a serialiser quirk, not a bad
  // question. `Number('')` is 0, hence the explicit emptiness check.
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
}

const DIFFICULTIES: readonly string[] = ['easy', 'medium', 'hard'];

/**
 * The server's generation register, mapped onto this app's drill difficulty.
 *
 * Two vocabularies on purpose. `foundation|standard|challenging` describes the
 * REGISTER a prompt is asked to write in; `easy|medium|hard` describes how hard
 * a banked question is to answer, which is what `mcq-select.ts` mixes a session
 * by. Neither name set is wrong for its own job, and collapsing them would put
 * prompt-authoring words in front of the user.
 *
 * Translating rather than accepting both is what makes this visible. Without
 * it every question the server sent fell through to the default and the whole
 * bank was labelled `medium` — a silent flattening that `mcq-select.ts`'s
 * difficulty mix would then have been drawing from a single bucket.
 */
const DIFFICULTY_FROM_SERVER: Readonly<Record<string, Difficulty>> = {
  foundation: 'easy',
  standard: 'medium',
  challenging: 'hard',
};

/**
 * An unrecognised difficulty is cosmetic — it changes a label, not the key —
 * so it defaults rather than rejecting a question that is otherwise fine.
 */
function difficultyOf(value: unknown): Difficulty {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (DIFFICULTIES.includes(raw)) return raw as Difficulty;
  return DIFFICULTY_FROM_SERVER[raw] ?? 'medium';
}

/**
 * The server's per-option rationales, folded into the one block the drill shows.
 *
 * `server/src/mcq/types.ts` carries `eliminationRationale: string[]` — one entry
 * per option INCLUDING the key, "why an aspirant would pick it". This app has a
 * single `elimination_logic` column and one "Why the others are wrong" panel, so
 * the array is joined with its option letters rather than concatenated: the
 * association between a rationale and the option it explains is the whole value
 * of having four of them.
 *
 * Returns null rather than an empty string when there is nothing usable, so the
 * caller's existing rejection still fires. A question with no elimination logic
 * teaches nothing beyond its key, which is why that rejection exists.
 */
function joinRationale(value: unknown, options: readonly string[]): string | null {
  if (!Array.isArray(value)) return null;

  const lines: string[] = [];
  for (const [index, entry] of value.entries()) {
    const rationale = text(entry);
    if (rationale === null) continue;
    const letter = OPTION_LETTERS[index];
    const option = options[index];
    // Falls back to the bare rationale when the arrays disagree in length: a
    // mislabelled rationale is worse than an unlabelled one.
    lines.push(
      letter === undefined || option === undefined
        ? rationale
        : `${letter}. ${option} — ${rationale}`,
    );
  }

  return lines.length === 0 ? null : lines.join('\n');
}

function sourceOf(value: unknown): QuestionSource {
  return typeof value === 'string' && value.trim().toLowerCase() === 'pyq' ? 'pyq' : 'generated';
}

/** A short, log-safe excerpt of a stem. */
function excerpt(value: unknown, limit = 70): string {
  const raw = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (raw === '') return '(no stem)';
  return raw.length <= limit ? raw : `${raw.slice(0, limit - 1)}…`;
}

/**
 * The first of several aliases the payload actually uses.
 *
 * The server contract is young and its field names have moved
 * (`eliminationLogic` / `elimination`, `externalId` / `factKey`). Accepting the
 * aliases costs three lines here; not accepting them costs a whole batch and is
 * only discovered when the bank runs dry on a commute.
 */
function pick(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/* ---------------------------------------------------------------- mapping */

/**
 * One `question` frame. Returns a verdict, never throws.
 *
 * `seen` is the fingerprints accepted so far in THIS batch, checked alongside
 * `ctx.knownFingerprints`: the server can emit the same stem twice within a
 * single stream, and the bank must not hold it twice — a repeat in a drill
 * reads as an app bug, and under the redrill tier it would be dealt twice.
 */
export function mapGeneratedQuestion(
  payload: unknown,
  ctx: MapContext,
  seen: ReadonlySet<string> = new Set<string>(),
): MapOutcome {
  const record = asRecord(payload);
  if (!record) {
    return { ok: false, reason: 'not_an_object', detail: 'Frame payload was not an object.' };
  }

  const stem = text(pick(record, 'stem', 'question', 'questionText'));
  if (stem === null) {
    return { ok: false, reason: 'empty_stem', detail: 'Question had no stem.' };
  }

  const rawOptions = pick(record, 'options', 'choices');
  if (!Array.isArray(rawOptions) || rawOptions.length !== OPTION_COUNT) {
    return {
      ok: false,
      reason: 'option_count',
      detail: `Expected ${OPTION_COUNT} options, got ${
        Array.isArray(rawOptions) ? rawOptions.length : 'none'
      }: ${excerpt(stem)}`,
    };
  }

  const options: string[] = [];
  for (const entry of rawOptions) {
    const option = text(entry);
    if (option === null) {
      return {
        ok: false,
        reason: 'empty_option',
        detail: `An option was blank: ${excerpt(stem)}`,
      };
    }
    options.push(option);
  }

  // Two identical options make the question unanswerable — whichever she taps,
  // one of two identical strings is wrong — and it is not detectable on screen.
  const distinct = new Set(options.map((option) => option.toLowerCase()));
  if (distinct.size !== options.length) {
    return {
      ok: false,
      reason: 'duplicate_option',
      detail: `Two options were identical: ${excerpt(stem)}`,
    };
  }

  const correctIndex = integer(pick(record, 'correctIndex', 'answerIndex', 'correct_index'));
  if (correctIndex === null || correctIndex < 0 || correctIndex >= OPTION_COUNT) {
    return {
      ok: false,
      reason: 'correct_index',
      detail: `correctIndex ${String(
        pick(record, 'correctIndex', 'answerIndex', 'correct_index'),
      )} is outside 0..${OPTION_COUNT - 1}: ${excerpt(stem)}`,
    };
  }

  const eliminationLogic =
    text(pick(record, 'eliminationLogic', 'elimination', 'elimination_logic', 'explanation')) ??
    joinRationale(pick(record, 'eliminationRationale', 'rationale'), options);
  if (eliminationLogic === null) {
    return {
      ok: false,
      reason: 'empty_elimination_logic',
      detail: `No elimination logic — the part that teaches: ${excerpt(stem)}`,
    };
  }

  const source = sourceOf(pick(record, 'source'));
  const pyqYear = integer(pick(record, 'pyqYear', 'year'));
  // The repository invariant is `source = 'pyq'` implies `pyqYear` is set, and
  // provenance is on screen: a past question's key is UPSC's and a generated
  // one is a model's, which is what makes "this looks wrong" a reasonable thing
  // to tap. A pyq claim with no year cannot be shown honestly either way.
  if (source === 'pyq' && pyqYear === null) {
    return {
      ok: false,
      reason: 'pyq_without_year',
      detail: `Claimed to be a past question but carried no year: ${excerpt(stem)}`,
    };
  }

  const fingerprint = stemFingerprint(stem);
  if (ctx.knownFingerprints.has(fingerprint) || seen.has(fingerprint)) {
    return {
      ok: false,
      reason: 'duplicate_stem',
      detail: `Already in the bank: ${excerpt(stem)}`,
    };
  }

  const syllabusSlug = text(pick(record, 'syllabusSlug', 'slug', 'topicSlug'));
  const resolved = syllabusSlug === null ? undefined : ctx.topicIdBySlug.get(syllabusSlug);

  return {
    ok: true,
    question: {
      stem,
      options,
      correctIndex,
      eliminationLogic,
      difficulty: difficultyOf(pick(record, 'difficulty')),
      source,
      pyqYear: source === 'pyq' ? pyqYear : null,
      pyqPaper: source === 'pyq' ? text(pick(record, 'pyqPaper', 'paper')) : null,
      // An unknown slug lands here as null rather than as a rejection.
      syllabusTopicId: resolved ?? null,
      syllabusSlug,
      sectionKey: text(pick(record, 'sectionKey', 'section')),
      stemFingerprint: fingerprint,
      externalId: text(pick(record, 'externalId', 'factKey', 'id')),
      batchId: text(pick(record, 'batchId')) ?? ctx.batchId,
      promptVersion: text(pick(record, 'promptVersion')) ?? ctx.promptVersion,
    },
  };
}

/**
 * A stateful mapper for the streaming path.
 *
 * Questions are banked as they arrive, one frame at a time, so there is no
 * array to fold over — but duplicate suppression and the rejection tally are
 * inherently batch-scoped. This holds exactly that state and nothing else.
 */
export interface BatchMapper {
  accept(payload: unknown): MapOutcome;
  result(): MappedBatch;
}

export function createBatchMapper(ctx: MapContext): BatchMapper {
  const accepted: BankableQuestion[] = [];
  const rejected: Rejection[] = [];
  const seen = new Set<string>();
  const unknownSlugs = new Set<string>();
  let index = 0;

  return {
    accept(payload: unknown): MapOutcome {
      const at = index;
      index += 1;

      const outcome = mapGeneratedQuestion(payload, ctx, seen);
      if (!outcome.ok) {
        rejected.push({ index: at, reason: outcome.reason, detail: outcome.detail });
        return outcome;
      }

      seen.add(outcome.question.stemFingerprint);
      accepted.push(outcome.question);
      if (outcome.question.syllabusSlug !== null && outcome.question.syllabusTopicId === null) {
        unknownSlugs.add(outcome.question.syllabusSlug);
      }
      return outcome;
    },

    result(): MappedBatch {
      return {
        accepted: [...accepted],
        rejected: [...rejected],
        duplicates: rejected.filter((entry) => entry.reason === 'duplicate_stem').length,
        unknownSlugs: [...unknownSlugs],
      };
    },
  };
}

/**
 * The whole-array form, for a non-streaming caller and for tests.
 *
 * A payload that is not an array is a malformed response, not an empty one, and
 * it returns an empty `accepted` with one rejection explaining why rather than
 * throwing.
 */
export function mapGeneratedBatch(payloads: unknown, ctx: MapContext): MappedBatch {
  if (!Array.isArray(payloads)) {
    return {
      accepted: [],
      rejected: [{ index: 0, reason: 'not_an_object', detail: 'Expected an array of questions.' }],
      duplicates: 0,
      unknownSlugs: [],
    };
  }

  const mapper = createBatchMapper(ctx);
  for (const payload of payloads) mapper.accept(payload);
  return mapper.result();
}
