/**
 * Wire type -> DB type. Pure, and deliberately so.
 *
 * This module resolves the three places where `EvaluationScores` (what the
 * model emits, per `server/src/rubrics/_output.md`) and `EvaluationInput` (what
 * `db/answers.ts` stores) genuinely disagree:
 *
 *  1. The score block can be missing entirely. `extractTrailingJson` on the
 *     server returns null when the model's fenced JSON is unparseable, and the
 *     `scores` frame still arrives with `scores: null`. The prose is the only
 *     thing the model produced, and it is the part she actually reads, so it is
 *     preserved with `total: 0, max: 0`. `toPercent` in answers.ts returns null
 *     when `max <= 0`, so the row self-excludes from the score trend instead of
 *     dragging it to zero. Discarding the whole evaluation would throw away the
 *     feedback to protect a chart.
 *  2. `legibilityNote` has no column. It is one sentence explaining *why* the
 *     legibility rating is what it is — the actionable half of the pair — so it
 *     is folded into the feedback markdown under a `## Legibility` heading
 *     rather than dropped on the floor.
 *  3. `modelSkeletonMd` has no counterpart in the JSON. The skeleton lives in
 *     the prose as section 4 of the required output format, so it is lifted out
 *     of the markdown here and stored in its own column, which is what lets the
 *     answer screen show it as a collapsible block.
 *
 * Two rules that look like bugs and are not:
 *
 *  - `_output.md` requires dimension scores to sum to `total`. Models violate
 *    this. `total` is trusted and the dimensions are stored exactly as
 *    reported. Silently rescaling would fabricate per-dimension marks that the
 *    model never gave, and those feed `weakestDimensions` — the one query that
 *    is supposed to say what specifically keeps costing marks.
 *  - `model` and `rubricVersion` come from the `meta` frame, never a local
 *    constant. `rubricVersion` is a content hash of the rubric, so after a
 *    rubric edit an old score and a new score are visibly not comparable. A
 *    hardcoded constant would erase that and make the trend a lie.
 *
 * No React Native, no expo, no DB imports beyond types, so this loads under
 * plain Node and is covered by `tests/evaluation-map.test.ts`.
 */

import type { EvaluationMeta, EvaluationScores } from '@/lib/api';
import type { EvaluationInput, PaperValue } from '@/db/answers';

/* --------------------------------------------------------------- max marks */

/** A 150-word answer. */
const SHORT_ANSWER_MAX = 10;
/** A 250-word answer. */
const LONG_ANSWER_MAX = 15;
/** A GS4 case study. */
const CASE_STUDY_MAX = 20;
/** A full essay. */
const ESSAY_MAX = 125;

/** The word limit above which a GS4 question is a Section B case study. */
const CASE_STUDY_WORDS = 250;
/** The upper bound of the 10-mark band. */
const SHORT_ANSWER_WORDS = 150;

/**
 * The mark ceiling implied by the paper and length.
 *
 * Used ONLY when the model omitted `max` from its JSON block. When the model
 * reports a max, that is what is stored, even if it disagrees with this table —
 * the model saw the actual question paper instruction and this function did not.
 */
export function defaultMaxForWordLimit(wordLimit: number, paper: PaperValue): number {
  // An essay is marked out of 125 whatever nominal word limit was captured.
  if (paper === 'essay') return ESSAY_MAX;

  // GS4 Section B case studies run to 250 words and carry 20 marks. The
  // Section A theory questions in the same paper are ordinary 10-markers, so
  // the paper alone is not enough to tell them apart — the length is.
  if (paper === 'gs4' && wordLimit >= CASE_STUDY_WORDS) return CASE_STUDY_MAX;

  return wordLimit <= SHORT_ANSWER_WORDS ? SHORT_ANSWER_MAX : LONG_ANSWER_MAX;
}

/* -------------------------------------------------- model skeleton section */

/**
 * The five section titles `_output.md` asks for, in the shapes a model actually
 * writes them: `## Model skeleton`, `**Model skeleton**`, `4. Model skeleton`,
 * `Model skeleton:`. A line declaring any of these ends the skeleton section;
 * every other line is skeleton content.
 */
const SECTION_TITLES: RegExp[] = [
  /^directive\s+compliance/i,
  /^dimension/i,
  /^(?:the\s+)?(?:single\s+)?highest[-\s]?leverage/i,
  /^model\s+skeleton/i,
  /^compared\s+to\s+last\s+time/i,
];

const MODEL_SKELETON_TITLE = /^model\s+skeleton/i;

/** ATX heading: `## Title`. */
const ATX_HEADING = /^ {0,3}#{1,6}\s+(.+)$/;
/** A bold lead-in used as a heading: `**Title**`, `- **Title**`, `4. **Title** — rest`. */
const BOLD_HEADING = /^ {0,3}(?:\d+[.)]\s*)?(?:[-*+]\s+)?\*\*([^*]+)\*\*\s*(.*)$/;
/** A bare labelled line: `Title: rest`. Only ever trusted for known titles. */
const PLAIN_HEADING = /^ {0,3}(?:\d+[.)]\s*)?([^:\n]{1,60}):\s*(.*)$/;

interface HeadingLine {
  /** Title with numbering, emphasis and trailing punctuation removed. */
  title: string;
  /** Whatever followed the title on the same line. */
  rest: string;
  /**
   * True for a real `#` heading. Those end the previous section whatever they
   * say; the softer forms only do so when they name a known rubric section,
   * because `**Intro** — one line of context` is skeleton content, not a
   * heading, and mistaking it for one truncates the skeleton to nothing.
   */
  hard: boolean;
}

function cleanTitle(raw: string): string {
  return raw
    .replace(/[*_`#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[:–—.\s]+$/, '');
}

function stripSeparator(rest: string): string {
  return rest.replace(/^\s*(?:[:–—]|-(?=\s))\s*/, '').trim();
}

function splitTitle(text: string): { title: string; rest: string } {
  const trimmed = text.trim().replace(/^\d+[.)]\s*/, '');

  const bold = /^\*\*([^*]+)\*\*\s*(.*)$/.exec(trimmed);
  if (bold) return { title: cleanTitle(bold[1] ?? ''), rest: stripSeparator(bold[2] ?? '') };

  const separated = /^([^:–—]+?)\s*[:–—]\s*(.*)$/.exec(trimmed);
  if (separated) return { title: cleanTitle(separated[1] ?? ''), rest: (separated[2] ?? '').trim() };

  return { title: cleanTitle(trimmed), rest: '' };
}

function readHeading(line: string): HeadingLine | null {
  const atx = ATX_HEADING.exec(line);
  if (atx) {
    const { title, rest } = splitTitle(atx[1] ?? '');
    return { title, rest, hard: true };
  }

  const bold = BOLD_HEADING.exec(line);
  if (bold) {
    return { title: cleanTitle(bold[1] ?? ''), rest: stripSeparator(bold[2] ?? ''), hard: false };
  }

  const plain = PLAIN_HEADING.exec(line);
  if (plain) {
    return { title: cleanTitle(plain[1] ?? ''), rest: (plain[2] ?? '').trim(), hard: false };
  }

  return null;
}

function isSectionTitle(title: string): boolean {
  return SECTION_TITLES.some((pattern) => pattern.test(title));
}

/**
 * Lifts section 4 of the required output format out of the feedback prose.
 *
 * Returns null when the model did not write one — which happens, and is not an
 * error. The column is nullable precisely so a missing skeleton costs the rest
 * of the evaluation nothing.
 */
export function extractModelSkeleton(feedbackMarkdown: string): string | null {
  if (!feedbackMarkdown) return null;

  const lines = feedbackMarkdown.replace(/\r\n/g, '\n').split('\n');

  let start = -1;
  let inlineRest = '';
  for (let i = 0; i < lines.length; i += 1) {
    const heading = readHeading(lines[i] ?? '');
    if (heading && MODEL_SKELETON_TITLE.test(heading.title)) {
      start = i;
      inlineRest = heading.rest;
      break;
    }
  }
  if (start === -1) return null;

  const body: string[] = [];
  if (inlineRest) body.push(inlineRest);

  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const heading = readHeading(line);
    if (heading && (heading.hard || isSectionTitle(heading.title))) break;
    body.push(line);
  }

  const text = body.join('\n').trim();
  return text.length > 0 ? text : null;
}

/* ------------------------------------------------------------ the mapping */

/** Heading the legibility note is filed under when it is folded into feedback. */
export const LEGIBILITY_HEADING = '## Legibility';

function appendLegibilityNote(markdown: string, note: string | undefined): string {
  const text = typeof note === 'string' ? note.trim() : '';
  if (text === '') return markdown;
  return `${markdown.replace(/\s+$/, '')}\n\n${LEGIBILITY_HEADING}\n\n${text}\n`;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function optionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/**
 * Dimensions exactly as reported, minus entries that would break the table.
 *
 * A dimension whose `max` is missing or zero is kept, not dropped: its comment
 * is still worth reading on the answer screen, and `weakestDimensions` already
 * skips `max <= 0` rows so it cannot poison the averages.
 */
function toDimensions(raw: EvaluationScores['dimensions'] | undefined): EvaluationInput['dimensions'] {
  if (!Array.isArray(raw)) return [];

  const dimensions: EvaluationInput['dimensions'] = [];
  for (const entry of raw) {
    const name = optionalText(entry?.name);
    if (name === null) continue;

    const comment = optionalText(entry?.comment);
    dimensions.push({
      name,
      score: finiteNumber(entry?.score) ?? 0,
      max: finiteNumber(entry?.max) ?? 0,
      ...(comment === null ? {} : { comment }),
    });
  }
  return dimensions;
}

export function toEvaluationInput(args: {
  answerId: number;
  meta: EvaluationMeta;
  scores: EvaluationScores | null;
  feedbackMarkdown: string;
  wordLimit: number;
  paper: PaperValue;
}): EvaluationInput {
  const { answerId, meta, scores, feedbackMarkdown, wordLimit, paper } = args;

  // The note is folded in first so the skeleton extractor sees the appended
  // `## Legibility` heading as the section boundary it is, rather than reading
  // the note as the tail of a trailing skeleton section.
  const feedbackMd = appendLegibilityNote(feedbackMarkdown, scores?.legibilityNote);

  const base = {
    answerId,
    model: meta.model,
    rubricVersion: meta.rubricVersion,
    feedbackMd,
    modelSkeletonMd: extractModelSkeleton(feedbackMd),
  };

  if (!scores) {
    // Unparseable score block. Keep every word of the prose; store a max of 0
    // so answers.ts excludes the row from the trend rather than plotting a 0%.
    return { ...base, total: 0, max: 0, dimensions: [] };
  }

  const total = finiteNumber(scores.total);
  const reportedMax = finiteNumber(scores.max);

  return {
    ...base,
    // A total that is not a number is a score block as unusable as a missing
    // one, and `evaluations.total` is NOT NULL — writing NaN would fail the
    // whole transaction and lose the feedback with it.
    total: total ?? 0,
    max:
      total === null
        ? 0
        : reportedMax !== null && reportedMax > 0
          ? reportedMax
          : defaultMaxForWordLimit(wordLimit, paper),
    dimensions: toDimensions(scores.dimensions),
    directiveWord: optionalText(scores.directiveWord),
    directiveCompliance: optionalBoolean(scores.directiveCompliance),
    highestLeverageFix: optionalText(scores.highestLeverageFix),
    legibility: optionalText(scores.legibility),
    wordLimitRespected: optionalBoolean(scores.wordLimitRespected),
    confidence: optionalText(scores.confidence),
  };
}
