/**
 * One UPSC objective paper + its official key -> working JSON for a human to check.
 *
 * NODE ONLY. Never import this from the app: it spawns `pdftotext` and touches
 * the filesystem, neither of which exists on a phone. It sits outside `src/` so
 * Metro never sees it.
 *
 * ## What this tool is allowed to do
 *
 * Read what is printed, and refuse everything else. `data/pyq/types.ts` explains
 * what a wrong answer key costs: spaced repetition drills it to mastery, and the
 * better the scheduling works the more thoroughly the falsehood is learned. An
 * extractor is the one place in that pipeline where a plausible-looking
 * fabrication can enter, so every ambiguity here resolves the same way — DROP
 * the question, RECORD the reason, and never approximate.
 *
 * Concretely, this file contains no code that can:
 *
 * - complete a stem that came out short, garbled or missing;
 * - infer an answer from the paper, from option wording, or from anything at all
 *   other than the key PDF passed on the command line;
 * - mint an external id (that is `pyqExternalId`'s job and only its job).
 *
 * The output is deliberately not importable as-is. `verification` is null and
 * every `syllabusSlug` is null, because both are human acts — see the header of
 * `data/pyq/types.ts` for why the nullability IS the enforcement.
 *
 * ## The key defines the roster, the paper defines the content
 *
 * The two PDFs are reconciled rather than merged. Every question number in the
 * KEY is expected to exist; a number the key lists but the paper's text layer
 * does not yield is dropped as `unreadable_scan` (an image-only page produces a
 * hundred of those, loudly, which is the correct outcome — this tool does not
 * OCR). Every question the PAPER yields that the key does not list is dropped as
 * `no_verified_key`. Neither direction is silently absorbed, because a silent
 * omission is indistinguishable from a bug in the extractor.
 *
 * ## Usage
 *
 *   npx tsx tools/pyq-extract.ts \
 *     --pdf papers/2023-gs1-a.pdf --key papers/2023-gs1-a-key.pdf \
 *     --exam prelims-gs1 --year 2023 --booklet a --out working/2023-a.json
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  PYQ_MAX_NUMBER,
  isPyqBooklet,
  isPyqExam,
  pyqExamSpec,
  pyqExternalId,
  pyqSetKey,
  type PyqBooklet,
  type PyqDropReason,
  type PyqDropped,
  type PyqExam,
  type PyqMcq,
  type PyqSet,
} from '../src/data/pyq/types';

/** Mirrors `OPTION_COUNT` in `lib/mcq-types.ts`. The answer pad is built for four. */
const OPTION_COUNT = 4;

/** The labels a four-option question must print, in this order. */
const OPTION_LABELS = ['a', 'b', 'c', 'd'] as const;

/**
 * Every extracted question gets this, and no question gets anything else.
 *
 * `PyqMcq.difficulty` is required and has no null, so something must be written.
 * A per-question guess would be a model's opinion travelling inside a dataset
 * that otherwise contains only what UPSC printed, and she would have no way to
 * tell the two apart. A single constant across the whole paper asserts nothing.
 */
const DEFAULT_DIFFICULTY = 'medium';

/* ------------------------------------------------------------ drop reasons */

/**
 * The finer-grained cause, written as a prefix on `PyqDropped.note`.
 *
 * `PyqDropReason` is a closed union owned by the app and it has no member for
 * "the extractor could not read this structure" beyond `unreadable_scan`, nor
 * one named `key_absent`. Rather than widen the app's type from a tool — which
 * would put vocabulary into `dataset.ts` that the importer does not know — the
 * coarse reason stays exactly as the app defines it and the specific cause goes
 * in the note, greppable, e.g. `more_than_four_options: found 5 labels ...`.
 *
 * `withdrawn_by_upsc` is deliberately never emitted. A withdrawal is announced
 * by UPSC separately from the paper and the key; a tool that inferred one from
 * two PDFs would be guessing at the very thing the reason exists to record.
 */
type DropCause =
  | 'map_or_diagram'
  | 'match_the_following'
  | 'table_in_stem'
  | 'more_than_four_options'
  | 'missing_options'
  | 'malformed_options'
  | 'empty_stem'
  | 'garbled_text'
  | 'no_text_layer'
  | 'key_absent'
  | 'key_letter_not_printed';

const CAUSE_TO_REASON: Readonly<Record<DropCause, PyqDropReason>> = {
  map_or_diagram: 'map_or_diagram',
  match_the_following: 'match_the_following',
  table_in_stem: 'table_in_stem',
  /*
   * Everything below is the same statement — "the text this tool can see cannot
   * be trusted to be the question that was printed" — which is exactly what
   * `unreadable_scan` means in `types.ts`: guessing at the missing words would
   * invent a question. A five-label parse is not a five-option UPSC question, it
   * is a misread; treating it as anything softer would let it through.
   */
  more_than_four_options: 'unreadable_scan',
  missing_options: 'unreadable_scan',
  malformed_options: 'unreadable_scan',
  empty_stem: 'unreadable_scan',
  garbled_text: 'unreadable_scan',
  no_text_layer: 'unreadable_scan',
  /* `key_absent` is `types.ts`'s `no_verified_key`, spelled as this tool sees it. */
  key_absent: 'no_verified_key',
  key_letter_not_printed: 'no_verified_key',
};

function drop(number: number, cause: DropCause, detail: string): PyqDropped {
  return { number, reason: CAUSE_TO_REASON[cause], note: `${cause}: ${detail}` };
}

/* ------------------------------------------------------------- text layout */

/**
 * Lines from `pdftotext -layout`, with page furniture removed.
 *
 * Form feeds become newlines and bare page numbers are deleted outright rather
 * than blanked, because the blank-line runs they would leave behind are the only
 * signal separating one question from the next in the tail of the paper.
 */
export function normalizePdfLines(raw: string): string[] {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/\f/g, '\n')
    /* pdftotext emits NBSP for justified gaps; it is not matched by \s in every engine. */
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .filter((line) => !/^[ \t]*\d{1,3}[ \t]*$/.test(line))
    .filter((line) => !/^[ \t]*space for rough work[ \t.]*$/i.test(line));
}

/**
 * True when an `(x)` at `index` sits where a printed option LABEL sits.
 *
 * The reason this check exists: `Article 19(1)(a)` occurs in real Prelims stems
 * and would otherwise be read as the start of the option block, silently
 * truncating the stem and shifting every option by one. A label starts a line or
 * follows a column gap; `19(1)(a)` does neither.
 */
function isLabelPosition(text: string, index: number): boolean {
  const before = text.slice(0, index);
  return /(?:^|\n)[ \t]*$/.test(before) || /[ \t]{2,}$/.test(before);
}

interface LabelToken {
  letter: string;
  start: number;
  end: number;
}

/** Every `(a)`..`(h)` sitting at a label position. Beyond `(d)` so over-count is DETECTED, not absorbed. */
function findLabelTokens(text: string): LabelToken[] {
  const tokens: LabelToken[] = [];
  const pattern = /\([ \t]*([a-hA-H])[ \t]*\)/g;
  let match = pattern.exec(text);
  while (match !== null) {
    if (isLabelPosition(text, match.index)) {
      tokens.push({
        letter: match[1].toLowerCase(),
        start: match.index,
        end: match.index + match[0].length,
      });
    }
    match = pattern.exec(text);
  }
  return tokens;
}

/* ----------------------------------------------------------- segmentation */

export interface RawSegment {
  /** The number printed in this booklet. */
  number: number;
  /** Stem lines exactly as printed, numbering prefix included. Uncollapsed — table detection needs the columns. */
  stemLines: readonly string[];
  /** The option block, from the `(a)` label onward, exactly as printed. */
  optionText: string;
}

interface Candidate {
  lineIndex: number;
  indent: number;
  number: number;
}

interface OptionGroup {
  /** Line holding the `(a)` label. */
  startLine: number;
  /** Line holding the `(d)` label. */
  endLine: number;
}

/** How many lines an option block may span before it stops being one block. */
const OPTION_BLOCK_MAX_LINES = 14;

/**
 * Option blocks: `(a)`..`(d)` in printed order, each at a label position.
 *
 * This is the anchor the whole segmenter hangs off, because it is the only
 * structure in a Prelims paper that cannot be confused with anything else. A
 * question number cannot play that role: `1.` and `2.` also number the
 * statements INSIDE a stem, and a paper's cover page numbers its instructions
 * the same way, so a numbering-first parser reliably picks up the wrong `2.`.
 */
function findOptionGroups(lines: readonly string[]): OptionGroup[] {
  const groups: OptionGroup[] = [];
  let line = 0;
  while (line < lines.length) {
    const first = findLabelTokens(lines[line]);
    if (first.length === 0 || first[0].letter !== 'a') {
      line += 1;
      continue;
    }
    /* `(a)` must open the line, not appear mid-sentence, for a block to start here. */
    if (!/^[ \t]*\([ \t]*[aA][ \t]*\)/.test(lines[line])) {
      line += 1;
      continue;
    }
    let wanted = 1;
    let cursor = line;
    let endLine = -1;
    const seenOnStart = first.map((token) => token.letter);
    /* Labels sharing the opening line (the common two-per-line layout) count first. */
    for (let i = 1; i < seenOnStart.length && wanted < OPTION_LABELS.length; i += 1) {
      if (seenOnStart[i] === OPTION_LABELS[wanted]) wanted += 1;
    }
    if (wanted === OPTION_LABELS.length) endLine = line;
    while (endLine === -1 && cursor + 1 < lines.length && cursor + 1 - line < OPTION_BLOCK_MAX_LINES) {
      cursor += 1;
      for (const token of findLabelTokens(lines[cursor])) {
        if (wanted < OPTION_LABELS.length && token.letter === OPTION_LABELS[wanted]) {
          wanted += 1;
          if (wanted === OPTION_LABELS.length) endLine = cursor;
        }
      }
    }
    if (endLine === -1) {
      line += 1;
      continue;
    }
    groups.push({ startLine: line, endLine });
    line = endLine + 1;
  }
  return groups;
}

/**
 * Which numbering line opens the question that owns this option block.
 *
 * Two rules, in this order, and both are about the same hazard — the numbered
 * statements inside a stem look exactly like a question number:
 *
 * 1. Least indented wins. `-layout` keeps the question number at the margin and
 *    indents the statements under it.
 * 2. Among equally indented candidates, the one continuing the sequence wins,
 *    then the last one. Statement numbering restarts at 1 for every question, so
 *    "previous + 1" identifies the real number even on a flat layout.
 */
function chooseStart(candidates: readonly Candidate[], previousNumber: number | null): Candidate | null {
  if (candidates.length === 0) return null;
  let minIndent = candidates[0].indent;
  for (const candidate of candidates) {
    if (candidate.indent < minIndent) minIndent = candidate.indent;
  }
  const shallow = candidates.filter((candidate) => candidate.indent === minIndent);
  if (previousNumber !== null) {
    const continues = shallow.filter((candidate) => candidate.number === previousNumber + 1);
    if (continues.length > 0) return continues[continues.length - 1];
  }
  return shallow[shallow.length - 1];
}

export interface SegmentationResult {
  segments: RawSegment[];
  warnings: string[];
}

/**
 * Split the paper into one segment per printed question.
 *
 * Anything that cannot be split confidently is left OUT and warned about rather
 * than approximated; the key roster in `buildPyqSet` then turns the hole into a
 * counted `unreadable_scan` drop, so nothing goes missing quietly.
 */
export function segmentQuestions(text: string): SegmentationResult {
  const lines = normalizePdfLines(text);
  const warnings: string[] = [];

  const candidates: Candidate[] = [];
  lines.forEach((line, index) => {
    const match = /^([ \t]*)(\d{1,3})\.(?:[ \t]|$)/.exec(line);
    if (match !== null) {
      candidates.push({ lineIndex: index, indent: match[1].length, number: Number(match[2]) });
    }
  });

  const groups = findOptionGroups(lines);
  const starts: { candidate: Candidate; group: OptionGroup }[] = [];
  let searchFrom = -1;
  let previousNumber: number | null = null;
  for (const group of groups) {
    const window = candidates.filter(
      (candidate) => candidate.lineIndex > searchFrom && candidate.lineIndex <= group.startLine,
    );
    const start = chooseStart(window, previousNumber);
    if (start === null) {
      warnings.push(
        `option block at line ${group.startLine + 1} has no question number before it; not extracted`,
      );
      searchFrom = group.endLine;
      continue;
    }
    starts.push({ candidate: start, group });
    previousNumber = start.number;
    searchFrom = group.endLine;
  }

  const segments: RawSegment[] = [];
  starts.forEach((entry, index) => {
    const next = starts[index + 1];
    /*
     * A segment normally ends where the next one begins. The LAST one has no
     * such bound, so it stops at the first double blank line after its options —
     * without that it would swallow the trailing pages of the booklet into
     * option (d).
     */
    const hardEnd = next === undefined ? lastSegmentEnd(lines, entry.group.endLine) : next.candidate.lineIndex;
    const body = lines.slice(entry.candidate.lineIndex, hardEnd);
    const optionOffset = entry.group.startLine - entry.candidate.lineIndex;
    segments.push({
      number: entry.candidate.number,
      stemLines: body.slice(0, optionOffset),
      optionText: body.slice(optionOffset).join('\n'),
    });
  });

  const numbers = segments.map((segment) => segment.number);
  for (let i = 1; i < numbers.length; i += 1) {
    if (numbers[i] <= numbers[i - 1]) {
      warnings.push(
        `question numbers are not ascending around ${numbers[i - 1]} -> ${numbers[i]}; the paper's layout may not be understood`,
      );
      break;
    }
  }

  return { segments, warnings };
}

/** Where the final segment stops: the first blank pair after its options, else EOF. */
function lastSegmentEnd(lines: readonly string[], optionEndLine: number): number {
  for (let i = optionEndLine + 1; i + 1 < lines.length; i += 1) {
    if (lines[i].trim() === '' && lines[i + 1].trim() === '') return i;
  }
  return lines.length;
}

/* --------------------------------------------------------- option parsing */

export type OptionParse =
  | { ok: true; options: string[]; letters: string[] }
  | { ok: false; cause: DropCause; detail: string };

/**
 * The four printed options, IN THE ORDER THE BOOKLET PRINTS THEM.
 *
 * No reordering and no normalisation of the labels: `correctIndex` indexes this
 * array, and Set A's `(c)` and Set B's `(c)` are different sentences. Sorting or
 * canonicalising here would silently re-key the paper — the exact failure the
 * booklet letter exists in the id to prevent.
 */
export function parseOptions(optionText: string): OptionParse {
  const tokens = findLabelTokens(optionText);
  if (tokens.length === 0) {
    return { ok: false, cause: 'missing_options', detail: 'no option labels found' };
  }
  const letters = tokens.map((token) => token.letter);
  if (tokens.length > OPTION_COUNT) {
    return {
      ok: false,
      cause: 'more_than_four_options',
      detail: `found ${tokens.length} labels (${letters.join(', ')})`,
    };
  }
  if (tokens.length < OPTION_COUNT) {
    return {
      ok: false,
      cause: 'missing_options',
      detail: `found ${tokens.length} labels (${letters.join(', ')})`,
    };
  }
  const expected = OPTION_LABELS.join(',');
  if (letters.join(',') !== expected) {
    return {
      ok: false,
      cause: 'malformed_options',
      detail: `labels read as (${letters.join(', ')}), expected (${OPTION_LABELS.join(', ')})`,
    };
  }
  const options = tokens.map((token, index) => {
    const end = index + 1 < tokens.length ? tokens[index + 1].start : optionText.length;
    return collapse(optionText.slice(token.end, end));
  });
  const empty = options.findIndex((option) => option === '');
  if (empty >= 0) {
    return {
      ok: false,
      cause: 'malformed_options',
      detail: `option (${letters[empty]}) has no text`,
    };
  }
  return { ok: true, options, letters };
}

/** Wrapped lines rejoin with one space; nothing else is touched. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------- stems */

/** `1.` / `(i)` / `(2)` / `iv.` opening a statement, with the space that follows it. */
const ITEM_MARKER = /^[ \t]*(?:\d{1,3}[.)]|\([ivxIVX]{1,5}\)|\(\d{1,2}\)|[ivxIVX]{1,5}[.)])[ \t]+/;

/**
 * The stem, with wrapped lines rejoined and enumerated items kept on their own.
 *
 * The numbered statements ARE the question in most Prelims items, so collapsing
 * them into one paragraph would make the stem harder to read than the paper. No
 * words are added, removed or reordered — only line breaks are decided.
 *
 * The decision is made on the text COLUMN, which is the one thing `-layout`
 * preserves and prose does not carry. A statement's continuation hangs under the
 * text of the statement, past its `2. ` marker; the closing "Which of the
 * statements given above..." returns to the stem's own margin. Joining on
 * "does not start with a number" instead — the obvious rule — swallows that
 * closing line into the last statement, which is how a two-statement question
 * comes out reading as though statement 2 asked the question.
 */
export function parseStem(stemLines: readonly string[]): string {
  const parts: string[] = [];
  let textColumn = 0;
  for (const raw of stemLines) {
    const line = raw.replace(/[ \t]+$/, '');
    if (line.trim() === '') continue;
    const indent = line.length - line.replace(/^[ \t]+/, '').length;

    if (parts.length === 0) {
      /* The question's own number is its identity, carried on `number`, not stem text. */
      const opener = /^[ \t]*\d{1,3}\.[ \t]*/.exec(line);
      const consumed = opener === null ? indent : opener[0].length;
      parts.push(collapse(line.slice(consumed)));
      textColumn = consumed;
      continue;
    }

    const marker = ITEM_MARKER.exec(line);
    if (marker !== null) {
      parts.push(collapse(line));
      textColumn = marker[0].length;
      continue;
    }

    if (indent >= textColumn) {
      const previous = parts[parts.length - 1];
      parts[parts.length - 1] = previous === '' ? collapse(line) : `${previous} ${collapse(line)}`;
      continue;
    }

    parts.push(collapse(line));
    textColumn = indent;
  }
  return parts.filter((part) => part !== '').join('\n');
}

/* -------------------------------------------------------- content refusals */

/** A stem shorter than this is not a Prelims question, it is a bad read. */
const MIN_STEM_LENGTH = 20;

const MATCH_THE_FOLLOWING = /match\s+the\s+following/i;
const LIST_I = /\blist\s*[-–—]?\s*i\b/i;
const LIST_II = /\blist\s*[-–—]?\s*ii\b/i;

/*
 * `map` and `diagram` are refused on sight. Neither word appears in a Prelims
 * stem that is answerable without looking at something. The rest — figure,
 * graph, chart, image — occur in ordinary prose ("a key figure in the movement",
 * "satellite images are used for..."), so they are refused only when the stem
 * POINTS at one. Dropping a good question is recoverable; keeping a question
 * whose subject is not on screen is not, because it reads perfectly.
 */
const VISUAL_ALWAYS = /\b(?:map|maps|diagram|diagrams)\b/i;
const VISUAL_NOUNS = 'map|diagram|figure|sketch|graph|chart|picture|image|photograph|illustration';
const VISUAL_POINTED = new RegExp(
  `\\b(?:given|following|above|below|adjoining)\\s+(?:${VISUAL_NOUNS})s?\\b` +
    `|\\b(?:${VISUAL_NOUNS})s?\\s+(?:given|shown|printed)\\s+(?:below|above)\\b` +
    `|\\bin\\s+the\\s+(?:${VISUAL_NOUNS})\\b`,
  'i',
);

const TABLE_POINTED = /\b(?:the\s+)?(?:following|given|above|below)\s+table\b|\btable\s+(?:given|shown)\s+(?:below|above)\b/i;

/** How many columnar lines make a stem a table rather than justified prose. */
const COLUMNAR_LINE_THRESHOLD = 2;

/**
 * Lines that look like table rows.
 *
 * Leading item numbering is stripped first: `-layout` often pads `1.` out to the
 * text column, and that padding is not a column boundary. Justified prose can
 * still trip this, which is why it takes two such lines and why the drop is
 * recorded with the count — a false positive costs a human one glance at the
 * paper, a false negative ships a table rendered as unreadable prose.
 */
export function columnarLineCount(lines: readonly string[]): number {
  let count = 0;
  for (const raw of lines) {
    const line = raw
      .replace(/^[ \t]*(?:\(?\d{1,3}[.)]|\([ivxIVX]+\)|[A-D]\.)[ \t]*/, '')
      .replace(/[ \t]+$/, '');
    if (/\S[ \t]{3,}\S/.test(line)) count += 1;
  }
  return count;
}

/**
 * Why this question cannot be represented, or null if it can.
 *
 * Readability is decided FIRST. Every check below it reads words out of the
 * stem, and words read out of a stem this tool already knows it misread are not
 * evidence of anything.
 */
export function classifySegment(
  segment: RawSegment,
  stem: string,
  options: OptionParse,
): { cause: DropCause; detail: string } | null {
  if (/\ufffd/.test(stem) || /\ufffd/.test(segment.optionText)) {
    return { cause: 'garbled_text', detail: 'the text layer contains replacement characters' };
  }
  if (stem === '') {
    return { cause: 'empty_stem', detail: 'no stem text between the question number and the options' };
  }
  if (stem.length < MIN_STEM_LENGTH) {
    return { cause: 'empty_stem', detail: `stem is ${stem.length} characters: ${JSON.stringify(stem)}` };
  }
  if (!options.ok) {
    return { cause: options.cause, detail: options.detail };
  }
  if (MATCH_THE_FOLLOWING.test(stem) || (LIST_I.test(stem) && LIST_II.test(stem))) {
    return { cause: 'match_the_following', detail: 'stem pairs two lists' };
  }
  if (VISUAL_ALWAYS.test(stem) || VISUAL_POINTED.test(stem)) {
    return { cause: 'map_or_diagram', detail: 'stem refers to something the app cannot show' };
  }
  const columnar = columnarLineCount(segment.stemLines);
  if (TABLE_POINTED.test(stem)) {
    return { cause: 'table_in_stem', detail: 'stem refers to a table' };
  }
  if (columnar >= COLUMNAR_LINE_THRESHOLD) {
    return { cause: 'table_in_stem', detail: `${columnar} stem lines are laid out in columns` };
  }
  return null;
}

/* ----------------------------------------------------------- the key table */

export interface AnswerKey {
  /** Question number -> printed option letter. */
  entries: Map<number, string>;
  warnings: string[];
}

/**
 * Thrown when the key PDF cannot be read as one unambiguous table.
 *
 * A key that parses two ways is not a key. Everything downstream of this file
 * treats a key entry as UPSC's own word, so an ambiguity resolved by picking one
 * reading would launder a coin flip into an authoritative answer.
 */
export class AnswerKeyError extends Error {}

/**
 * One row of the key table, or null if the line is not a key row at all.
 *
 * The whole line must be consumed by number/letter pairs. That requirement is
 * what makes this safe: a preamble line like `1. A candidate may raise an
 * objection...` opens exactly like a key row, and a scanning parser would read
 * `1 -> a` out of it and write a wrong answer into the bank. A row like
 * `1  a  51  c` — the usual multi-column layout — consumes cleanly.
 */
export function parseKeyLine(line: string): { number: number; letter: string }[] | null {
  let rest = line.trim();
  if (rest === '') return null;
  const pairs: { number: number; letter: string }[] = [];
  const pattern = /^[Qq]?\.?[ \t]*(\d{1,3})[ \t]*[.):\-–—]?[ \t]*\(?[ \t]*([A-Da-d])[ \t]*\)?[ \t]*[.,;|]?/;
  while (rest.length > 0) {
    const match = pattern.exec(rest);
    if (match === null) return null;
    pairs.push({ number: Number(match[1]), letter: match[2].toLowerCase() });
    rest = rest.slice(match[0].length).replace(/^[\s|]+/, '');
  }
  return pairs.length > 0 ? pairs : null;
}

/** The key table. Throws rather than choose when one number is given two answers. */
export function parseAnswerKey(text: string): AnswerKey {
  const entries = new Map<number, string>();
  const warnings: string[] = [];
  for (const line of normalizePdfLines(text)) {
    const pairs = parseKeyLine(line);
    if (pairs === null) continue;
    for (const pair of pairs) {
      if (pair.number < 1 || pair.number > PYQ_MAX_NUMBER) {
        throw new AnswerKeyError(`key lists question ${pair.number}, which no external id can carry`);
      }
      const existing = entries.get(pair.number);
      if (existing !== undefined && existing !== pair.letter) {
        throw new AnswerKeyError(
          `key gives question ${pair.number} two different answers, (${existing}) and (${pair.letter}); refusing to choose`,
        );
      }
      entries.set(pair.number, pair.letter);
    }
  }
  const numbers = [...entries.keys()].sort((a, b) => a - b);
  for (let i = 1; i < numbers.length; i += 1) {
    if (numbers[i] !== numbers[i - 1] + 1) {
      warnings.push(`key skips question numbers between ${numbers[i - 1]} and ${numbers[i]}`);
    }
  }
  return { entries, warnings };
}

/**
 * Booklet letters the key PDF declares about ITSELF.
 *
 * UPSC publishes one key per booklet and they disagree. Extracting Set B's paper
 * against Set A's key produces a hundred questions that read correctly and are
 * wrong — `types.ts` calls this the worst outcome the subsystem can produce.
 * This is the one cheap check that catches it, so `main` refuses on a mismatch.
 */
export function declaredBookletLetters(text: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /\bset\b[ \t]*[:\-–—]?[ \t]*([A-D])\b/gi,
    /\bseries\b[ \t]*[:\-–—]?[ \t]*([A-D])\b/gi,
    /\bbooklet[ \t]+([A-D])\b/gi,
  ];
  for (const pattern of patterns) {
    let match = pattern.exec(text);
    while (match !== null) {
      found.add(match[1].toLowerCase());
      match = pattern.exec(text);
    }
  }
  return [...found].sort();
}

/* ------------------------------------------------------------ the assembly */

export interface BuildInput {
  exam: PyqExam;
  year: number;
  booklet: PyqBooklet;
  paperText: string;
  keyText: string;
}

export interface BuildResult {
  set: PyqSet;
  identity: { setKey: string; externalIds: Record<string, string> };
  counts: {
    keyEntries: number;
    extracted: number;
    dropped: number;
    droppedByReason: Record<string, number>;
  };
  warnings: string[];
}

/**
 * Reconcile paper against key. Pure — two strings in, the whole result out.
 *
 * The loop runs over the KEY's numbers, not the paper's, so a question the paper
 * failed to yield is a drop rather than an absence. The paper's own numbers are
 * swept afterwards for anything the key does not cover.
 */
export function buildPyqSet(input: BuildInput): BuildResult {
  const key = parseAnswerKey(input.keyText);
  if (key.entries.size === 0) {
    throw new AnswerKeyError(
      'the key PDF yielded no answers; without UPSC\'s own key nothing can be extracted',
    );
  }

  const segmentation = segmentQuestions(input.paperText);
  const warnings = [...key.warnings, ...segmentation.warnings];

  const byNumber = new Map<number, RawSegment>();
  for (const segment of segmentation.segments) {
    if (byNumber.has(segment.number)) {
      /*
       * Two segments numbered the same would mint one external id twice, and the
       * second import would silently rewrite the first one's answer key. There
       * is no safe way to continue past this.
       */
      throw new Error(
        `question ${segment.number} was segmented twice; the paper's layout is not understood and continuing would mint one id for two questions`,
      );
    }
    byNumber.set(segment.number, segment);
  }

  const mcqs: PyqMcq[] = [];
  const dropped: PyqDropped[] = [];

  const keyNumbers = [...key.entries.keys()].sort((a, b) => a - b);
  for (const number of keyNumbers) {
    const segment = byNumber.get(number);
    if (segment === undefined) {
      dropped.push(
        drop(number, 'no_text_layer', 'the key lists this question but the paper yielded no text for it'),
      );
      continue;
    }
    const stem = parseStem(segment.stemLines);
    const options = parseOptions(segment.optionText);
    const refusal = classifySegment(segment, stem, options);
    if (refusal !== null) {
      dropped.push(drop(number, refusal.cause, refusal.detail));
      continue;
    }
    /* Unreachable while `classifySegment` returns null only for `ok` parses; the compiler cannot see that. */
    if (!options.ok) {
      dropped.push(drop(number, options.cause, options.detail));
      continue;
    }
    const letter = key.entries.get(number) as string;
    const correctIndex = options.letters.indexOf(letter);
    if (correctIndex < 0) {
      dropped.push(
        drop(
          number,
          'key_letter_not_printed',
          `the key answers (${letter}) but the booklet prints (${options.letters.join(', ')})`,
        ),
      );
      continue;
    }
    mcqs.push({
      number,
      stem,
      options: options.options,
      correctIndex,
      /* A past paper ships no explanation and this tool must not write one. */
      eliminationLogic: null,
      difficulty: DEFAULT_DIFFICULTY,
      /* Tagging is a later, human step. Null is the honest value here. */
      syllabusSlug: null,
    });
  }

  for (const segment of segmentation.segments) {
    if (!key.entries.has(segment.number)) {
      dropped.push(
        drop(segment.number, 'key_absent', 'the key PDF has no entry for this question'),
      );
    }
  }

  dropped.sort((a, b) => a.number - b.number);

  const externalIds: Record<string, string> = {};
  for (const mcq of mcqs) {
    externalIds[String(mcq.number)] = pyqExternalId(input.exam, input.year, input.booklet, mcq.number);
  }

  const droppedByReason: Record<string, number> = {};
  for (const entry of dropped) {
    droppedByReason[entry.reason] = (droppedByReason[entry.reason] ?? 0) + 1;
  }

  return {
    set: {
      exam: input.exam,
      year: input.year,
      booklet: input.booklet,
      /* Null refuses the set at import. A human fills this in, or nothing does. */
      verification: null,
      mcqs,
      written: [],
      dropped,
    },
    identity: {
      setKey: pyqSetKey(input.exam, input.year, input.booklet),
      externalIds,
    },
    counts: {
      keyEntries: key.entries.size,
      extracted: mcqs.length,
      dropped: dropped.length,
      droppedByReason,
    },
    warnings,
  };
}

/* -------------------------------------------------------------- pdftotext */

/** poppler's `pdftotext`. Overridable because a machine may keep it anywhere. */
function pdftotextBinary(): string {
  const fromEnv = process.env.PDFTOTEXT;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  if (existsSync('/opt/homebrew/bin/pdftotext')) return '/opt/homebrew/bin/pdftotext';
  return 'pdftotext';
}

/**
 * `pdftotext -layout` into a temp file, read back, temp file removed.
 *
 * `-layout` is not cosmetic: it is what keeps the option labels at the margin
 * and the statements indented under the stem, which is the entire basis of the
 * segmenter. Column-collapsed output would parse into confidently wrong stems.
 * `execFileSync` rather than a shell, so a path with a space or a quote in it
 * cannot turn into a command.
 */
export function pdfToLayoutText(pdfPath: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyq-extract-'));
  const out = join(dir, 'page.txt');
  try {
    execFileSync(pdftotextBinary(), ['-layout', '-enc', 'UTF-8', '-eol', 'unix', pdfPath, out], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    return readFileSync(out, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/* --------------------------------------------------------------------- cli */

interface Args {
  pdf: string;
  key: string;
  exam: PyqExam;
  year: number;
  booklet: PyqBooklet;
  out: string;
}

const USAGE = [
  'usage: npx tsx tools/pyq-extract.ts \\',
  '         --pdf <paper.pdf> --key <key.pdf> \\',
  '         --exam prelims-gs1 --year 2023 --booklet a \\',
  '         --out working/2023-a.json',
].join('\n');

export function parseArgs(argv: readonly string[]): Args {
  const raw: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`unexpected argument ${JSON.stringify(token)}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} needs a value`);
    raw[token.slice(2)] = value;
    i += 1;
  }
  for (const required of ['pdf', 'key', 'exam', 'year', 'booklet', 'out']) {
    if (raw[required] === undefined) throw new Error(`missing --${required}`);
  }
  if (!isPyqExam(raw.exam)) throw new Error(`--exam ${JSON.stringify(raw.exam)} is not a known exam`);
  if (!isPyqBooklet(raw.booklet)) {
    throw new Error(`--booklet ${JSON.stringify(raw.booklet)} is not a-d or x`);
  }
  /*
   * The booklet letter is part of the id, and nothing between here and
   * `pyqExternalId` changes its case. A `--booklet A` accepted by lowercasing it
   * in one code path and not another is how two extractions of one booklet end
   * up with two ids for one question.
   */
  const spec = pyqExamSpec(raw.exam);
  if (spec.form !== 'mcq') {
    throw new Error(`--exam ${raw.exam} is a written paper; this tool extracts objective papers only`);
  }
  const year = Number(raw.year);
  if (!Number.isInteger(year) || year < 1950 || year > 2100) {
    throw new Error(`--year ${JSON.stringify(raw.year)} is not a plausible year`);
  }
  return { pdf: raw.pdf, key: raw.key, exam: raw.exam, year, booklet: raw.booklet, out: raw.out };
}

function summarise(result: BuildResult, args: Args): string {
  const lines = [
    `${result.identity.setKey}  (${pyqExamSpec(args.exam).label} ${args.year}, booklet ${args.booklet})`,
    `  key entries  ${String(result.counts.keyEntries).padStart(4)}`,
    `  extracted    ${String(result.counts.extracted).padStart(4)}`,
    `  dropped      ${String(result.counts.dropped).padStart(4)}`,
  ];
  const reasons = Object.keys(result.counts.droppedByReason).sort();
  for (const reason of reasons) {
    lines.push(`      ${reason.padEnd(20)} ${String(result.counts.droppedByReason[reason]).padStart(4)}`);
  }
  for (const warning of result.warnings) lines.push(`  warning: ${warning}`);
  lines.push('');
  lines.push('  verification is null and every syllabusSlug is null. Both are human work;');
  lines.push('  planPyqImport refuses the set until a person fills verification in.');
  return lines.join('\n');
}

function main(argv: readonly string[]): number {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}\n`);
    return 2;
  }

  const paperText = pdfToLayoutText(args.pdf);
  const keyText = pdfToLayoutText(args.key);

  /* Refuse before parsing anything: a paper read against the wrong booklet's key is unrecoverable. */
  const declared = declaredBookletLetters(keyText);
  if (declared.length === 1 && declared[0] !== args.booklet) {
    process.stderr.write(
      `the key PDF declares booklet (${declared[0]}) but --booklet is ${args.booklet}.\n` +
        'UPSC publishes one key per booklet and they disagree. Refusing.\n',
    );
    return 1;
  }

  let result: BuildResult;
  try {
    result = buildPyqSet({
      exam: args.exam,
      year: args.year,
      booklet: args.booklet,
      paperText,
      keyText,
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }

  if (declared.length !== 1) {
    result.warnings.push(
      declared.length === 0
        ? 'the key PDF does not name a booklet; --booklet was taken on trust'
        : `the key PDF names booklets (${declared.join(', ')}); --booklet was taken on trust`,
    );
  }

  const output = {
    tool: 'pyq-extract',
    generatedAt: new Date().toISOString(),
    source: {
      paperPdf: resolve(args.pdf),
      paperSha256: sha256(args.pdf),
      keyPdf: resolve(args.key),
      keySha256: sha256(args.key),
    },
    set: result.set,
    identity: result.identity,
    counts: result.counts,
    warnings: result.warnings,
  };

  mkdirSync(dirname(resolve(args.out)), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

  process.stdout.write(`${summarise(result, args)}\n\nwrote ${resolve(args.out)}\n`);
  return 0;
}

/*
 * `process.argv[1]` rather than `import.meta` or `require.main`: the tests
 * compile as CommonJS and the tool runs under tsx, and this is the one check
 * that means the same thing in both.
 */
if (process.argv[1] !== undefined && /pyq-extract\.[cm]?[tj]s$/.test(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
