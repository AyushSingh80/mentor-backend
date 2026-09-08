/**
 * The mechanical grounding gate.
 *
 * `types.ts` states the claim this file has to make true: a generated digest is
 * worthless unless every fact in it traces to a page that was actually fetched.
 * She reads a note saying "the Supreme Court held X in *Y v. Union of India*
 * (March 2026)" and writes it into a Mains answer. If the model half-remembered
 * that case she has put a fabricated citation into a paper worth 250 marks.
 *
 * A prompt instruction saying "do not invent things" does not prevent that. A
 * mechanical check does, and this is the mechanical check. There is no model in
 * the loop, nothing here is scored or thresholded, and nothing here can be
 * talked out of its answer.
 *
 * ## The five checks
 *
 *  1. QUOTE     — each `evidence[].quote` is a literal SUBSTRING of the fetched
 *                 text after normalisation. Substring. Not similarity, not
 *                 edit distance, not embeddings. `at` is set to the offset.
 *  2. NUMBER    — every number token in `noteMd` occurs in the fetched text.
 *                 Catches invented outlays, percentages, majorities, strengths.
 *  3. DATE      — every year, month name and weekday in `noteMd` occurs in the
 *                 fetched text. Catches the invented judgment year.
 *  4. CITATION  — every `Article N` / `Section N` / `Schedule` / all-caps
 *                 acronym in `noteMd` occurs in the fetched text. `Article 21A`
 *                 against a source that says `Article 21` FAILS; those are
 *                 different provisions and the difference is the whole point.
 *  5. COVERAGE  — every sentence of `noteMd` carries an index into `evidence`.
 *                 This closes the gap grounding alone leaves: a 90-word note
 *                 can be 80 words grounded and 10 words invented, and checks
 *                 1-4 would pass it.
 *
 * ## Any failure drops the ITEM
 *
 * Never rewrite, never repair, never emit with a caveat. A note edited to fit
 * its evidence is a note whose remaining sentences were written from a
 * different premise — the same reasoning as Phase 3's "on disagreement the
 * question is dropped, never re-keyed". Fewer items is a CORRECT outcome; a
 * quietly-mended item is not.
 *
 * ## Why every check is a SET MEMBERSHIP over symmetrically extracted tokens
 *
 * The naive implementation of "does this number appear in the source" is
 * `doc.includes('21')`, and it is broken: `'21'` is a substring of `'2021'`,
 * `'IAS'` is a substring of `'BIAS'`, and `'Article 21'` is a prefix of
 * `'Article 21A'`. Every check below therefore extracts TOKENS from the note
 * and TOKENS from the document with the SAME extractor and asks whether the
 * note's tokens are a subset of the document's.
 *
 * Symmetry is what makes this both sound and usable. It is what lets
 * `Articles 14, 19 and 21` in the source ground `Article 21` in the note (the
 * extractor expands the list on both sides), and what stops `Article 21` in the
 * source grounding `Article 21A` in the note (the suffix is part of the token
 * on both sides).
 */

import type {
  DigestItemDraft,
  DropReason,
  EvidenceSpan,
  SourceDocument,
} from './types.js';

/* ------------------------------------------------------------- normalisation */

/**
 * Invisible characters, deleted rather than collapsed.
 *
 * JS `\s` includes U+FEFF, so collapsing before deleting would turn
 * `A﻿B` into `A B` and break a quote that is visually identical to the
 * source. Soft hyphens (U+00AD) arrive from CMS copy the same way. Deleting a
 * character that renders as nothing cannot make two visibly different strings
 * equal, so this is not a loosening of the check.
 */
const INVISIBLE = /[­​‌‍‎‏⁠﻿]/g;

/** ' ' ‚ ‛ ′ ‵ ‹ › ´ — every typographic single quote a CMS emits. */
const SINGLE_QUOTES = /[‘’‚‛′‵‹›´]/g;

/** " " „ ‟ ″ ‶ « » */
const DOUBLE_QUOTES = /[“”„‟″‶«»]/g;

/** Hyphen, non-breaking hyphen, figure/en/em dash, horizontal bar, minus. */
const DASHES = /[‐-―−⁃﹘﹣－]/g;

/**
 * The one normalisation both sides of every comparison go through.
 *
 * Deliberately narrow. It unifies whitespace, quote marks and dashes and it
 * does NOT lowercase, does NOT strip punctuation, does NOT fold accents beyond
 * Unicode canonical composition and does NOT touch digits. Anything more
 * permissive stops being "the model quoted the page" and starts being "the
 * model wrote something that resembles the page", and the resemblance is
 * exactly what this file exists to refuse.
 *
 * NFC is canonical composition only: `e` + U+0301 and `é` are the same
 * character by Unicode's own definition, and HTML entity decoding can produce
 * either. NFKC is NOT used — it maps `²` to `2` and `①` to `1`, which would
 * silently rewrite numbers.
 */
export function normaliseForGrounding(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(INVISIBLE, '')
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(DASHES, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Markdown syntax removed before TOKEN SCANNING only.
 *
 * This never touches the note that is emitted — see the file header. It exists
 * because `noteMd` is markdown and markdown carries digits that are not claims:
 * an ordered-list marker (`1. `) and a link destination
 * (`[PIB](https://pib.gov.in/PressRelease.aspx?PRID=2012345)`) would both
 * otherwise be scanned as numbers the source has to contain, and the item would
 * drop for its punctuation rather than for its content.
 *
 * Link TEXT is kept, because link text is prose she reads. Only the destination
 * is dropped.
 */
export function stripMarkdown(md: string): string {
  return (
    md
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<https?:\/\/[^>\s]+>/g, ' ')
      .replace(/\bhttps?:\/\/\S+/g, ' ')
      // Line-anchored markers. `m` keeps the newlines, which splitSentences
      // relies on for one-bullet-per-line notes.
      .replace(/^[ \t]{0,3}>+[ \t]?/gm, '')
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
      .replace(/^[ \t]{0,3}(?:[-*+]|\d{1,3}[.)])[ \t]+/gm, '')
      .replace(/^[ \t]{0,3}(?:[-*_][ \t]*){3,}$/gm, ' ')
      .replace(/\*\*|__|~~|\*|_/g, '')
  );
}

/** The note as the token scanners see it: markdown removed, then normalised. */
function scannableNote(noteMd: string): string {
  return normaliseForGrounding(stripMarkdown(noteMd));
}

/* -------------------------------------------------------------------- numbers */

/**
 * A number is a digit run that may carry grouping commas and one decimal tail.
 *
 * Indian grouping (`1,00,000`) works because the comma class is unbounded.
 * A trailing sentence period is not consumed because the decimal tail requires
 * a digit after the point.
 */
const NUMBER_TOKEN = /\d[\d,]*(?:\.\d+)?/g;

/**
 * Commas dropped, trailing decimal zeros dropped, leading zeros dropped.
 *
 * String surgery rather than `Number()` on purpose: parsing to a float makes
 * two different twenty-digit identifiers compare equal, and a grounding check
 * that can be defeated by float precision is not a grounding check. All this
 * needs to do is make `1,000`/`1000`, `6.50`/`6.5` and `1.0`/`1` the same
 * number, which they are.
 */
export function canonicalNumber(token: string): string {
  let s = token.replace(/,/g, '');
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  s = s.replace(/^0+(?=\d)/, '');
  return s;
}

export function numberTokens(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(NUMBER_TOKEN)) {
    const canonical = canonicalNumber(match[0]);
    if (canonical !== '') out.push(canonical);
  }
  return out;
}

/**
 * Numbers the note asserts that the source never states.
 *
 * A non-empty result drops the item. This is the check that catches an invented
 * outlay, an invented percentage and an invented bench strength — the three
 * things a half-remembered fact gets wrong first.
 */
export function ungroundedNumbers(noteMd: string, sourceText: string): string[] {
  const grounded = new Set(numberTokens(normaliseForGrounding(sourceText)));
  return distinctMissing(numberTokens(scannableNote(noteMd)), grounded);
}

/* ---------------------------------------------------------------------- dates */

const MONTHS: Readonly<Record<string, string>> = {
  jan: 'January',
  january: 'January',
  feb: 'February',
  february: 'February',
  mar: 'March',
  march: 'March',
  apr: 'April',
  april: 'April',
  may: 'May',
  jun: 'June',
  june: 'June',
  jul: 'July',
  july: 'July',
  aug: 'August',
  august: 'August',
  sep: 'September',
  sept: 'September',
  september: 'September',
  oct: 'October',
  october: 'October',
  nov: 'November',
  november: 'November',
  dec: 'December',
  december: 'December',
};

const WEEKDAYS: Readonly<Record<string, string>> = {
  mon: 'Monday',
  monday: 'Monday',
  tue: 'Tuesday',
  tues: 'Tuesday',
  tuesday: 'Tuesday',
  wed: 'Wednesday',
  weds: 'Wednesday',
  wednesday: 'Wednesday',
  thu: 'Thursday',
  thur: 'Thursday',
  thurs: 'Thursday',
  thursday: 'Thursday',
  fri: 'Friday',
  friday: 'Friday',
  sat: 'Saturday',
  saturday: 'Saturday',
  sun: 'Sunday',
  sunday: 'Sunday',
};

/**
 * Four-digit years, 1500-2099.
 *
 * Wide enough for a colonial-era statute (`the 1894 Land Acquisition Act`) and
 * narrow enough that a rupee figure like `2400 crore` is not read as a year —
 * and where it is, both sides read it the same way, so it grounds anyway.
 */
const YEAR_TOKEN = /\b(?:1[5-9]\d{2}|20\d{2})\b/g;

/** A month or weekday word, with its original capitalisation preserved. */
const DAY_OR_MONTH_TOKEN = /\b([A-Za-z]{3,9})\b/g;

/**
 * Date-like tokens: years, month names, weekday names.
 *
 * Month and weekday words count ONLY when capitalised, and that rule is load
 * bearing in one direction. Without it, a source containing the modal "the
 * Court may direct" would ground a note claiming "in May 2026" — a false PASS,
 * which is the failure mode this whole file exists to prevent. Requiring the
 * capital costs a lowercase sentence-initial modal in a 90-word note, which
 * does not happen, and buys immunity from `may`, `march` and `august`.
 */
export function dateTokens(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(YEAR_TOKEN)) out.push(match[0]);
  for (const match of text.matchAll(DAY_OR_MONTH_TOKEN)) {
    const word = match[1];
    if (word === undefined) continue;
    const first = word[0];
    if (first === undefined || first !== first.toUpperCase() || !/[A-Z]/.test(first)) continue;
    const key = word.toLowerCase();
    const canonical = MONTHS[key] ?? WEEKDAYS[key];
    if (canonical !== undefined) out.push(canonical);
  }
  return out;
}

/**
 * Dates the note asserts that the source never states.
 *
 * The invented judgment year is the single most dangerous fabrication in this
 * product, because a citation with the wrong year looks exactly as authoritative
 * as one with the right year and is worth negative marks.
 */
export function ungroundedDates(noteMd: string, sourceText: string): string[] {
  const grounded = new Set(dateTokens(normaliseForGrounding(sourceText)));
  return distinctMissing(dateTokens(scannableNote(noteMd)), grounded);
}

/* ------------------------------------------------------------------ citations */

const PROVISION_KEYWORDS = ['Article', 'Section', 'Schedule', 'Rule', 'Clause', 'Regulation'] as const;

const PROVISION_HEAD = new RegExp(`\\b(${PROVISION_KEYWORDS.join('|')})s?\\.?[ ]+`, 'g');

/** `21`, `21A`, `21AA`, `VI`. A parenthetical sub-clause is consumed, not kept. */
const PROVISION_ITEM = /^(\d+[A-Za-z]{0,2}|[IVXL]{1,6})\b(?:\s*\([^)]{1,10}\))*/;

/** `, ` `; ` ` and ` ` & ` ` to ` ` - ` between members of a cited list. */
const PROVISION_SEPARATOR = /^(?:\s*[,;]\s*|\s*(?:and|&|to|or)\s+|\s*-\s*)/i;

/** The bare word, so `the Schedule` is a citation even with no number. */
const SCHEDULE_WORD = /\bSchedules?\b/g;

/** `Fifth Schedule`, `Sixth Schedule` — the ones Tribal Affairs copy actually uses. */
const ORDINAL_SCHEDULE =
  /\b(First|Second|Third|Fourth|Fifth|Sixth|Seventh|Eighth|Ninth|Tenth|Eleventh|Twelfth)\s+Schedules?\b/g;

/**
 * All-caps acronyms of three letters or more.
 *
 * Trailing digits are split off and left to the number check, so `COP29` in the
 * note grounds against `COP 29` in the source and vice versa. Two-letter forms
 * (`SC`, `ST`, `UT`) are excluded: they are too short to be distinctive and
 * appear inside ordinary words often enough to be noise.
 */
const ACRONYM_TOKEN = /\b([A-Z]{3,})[0-9]*\b/g;

/**
 * Every provision reference and acronym in the text, canonicalised.
 *
 * The list expansion is the part worth reading twice. `Articles 14, 19 and 21`
 * emits `article 14`, `article 19` and `article 21`, on BOTH sides of the
 * comparison. Without it, a source that cites three articles in one breath
 * would fail to ground a note that names the third of them — a false drop on
 * the single most common way Indian legal copy is written.
 */
export function citationTokens(text: string): string[] {
  const out: string[] = [];

  PROVISION_HEAD.lastIndex = 0;
  for (let head = PROVISION_HEAD.exec(text); head !== null; head = PROVISION_HEAD.exec(text)) {
    const keyword = (head[1] ?? '').toLowerCase();
    let cursor = head.index + head[0].length;
    for (;;) {
      const item = PROVISION_ITEM.exec(text.slice(cursor));
      if (item === null) break;
      const number = (item[1] ?? '').toLowerCase();
      if (number === '') break;
      out.push(`${keyword} ${number}`);
      cursor += item[0].length;
      const separator = PROVISION_SEPARATOR.exec(text.slice(cursor));
      if (separator === null) break;
      cursor += separator[0].length;
    }
    // Do not rescan the members we just consumed.
    PROVISION_HEAD.lastIndex = Math.max(PROVISION_HEAD.lastIndex, cursor);
  }

  for (const match of text.matchAll(SCHEDULE_WORD)) {
    void match;
    out.push('schedule');
  }
  for (const match of text.matchAll(ORDINAL_SCHEDULE)) {
    out.push(`${(match[1] ?? '').toLowerCase()} schedule`);
  }
  for (const match of text.matchAll(ACRONYM_TOKEN)) {
    const acronym = match[1];
    if (acronym !== undefined) out.push(acronym);
  }

  return out;
}

/**
 * Citations the note makes that the source never makes.
 *
 * `Article 21A` against a source that says `Article 21` lands here, which is
 * the case this check was written for: the right to life and the right to
 * education are different provisions, and a note that swaps one for the other
 * is wrong in a way that reads as authoritative.
 */
export function ungroundedCitations(noteMd: string, sourceText: string): string[] {
  const grounded = new Set(citationTokens(normaliseForGrounding(sourceText)));
  return distinctMissing(citationTokens(scannableNote(noteMd)), grounded);
}

/** Tokens of `claimed` absent from `grounded`, de-duplicated, in first-seen order. */
function distinctMissing(claimed: readonly string[], grounded: ReadonlySet<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of claimed) {
    if (grounded.has(token) || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/* ------------------------------------------------------------------ sentences */

/**
 * Words whose trailing period does not end a sentence.
 *
 * Single letters are handled separately (initials, and the second half of
 * `i.e.` / `e.g.` / `U.S.`), so this list only needs the multi-letter forms
 * that appear in Indian current-affairs prose.
 */
const ABBREVIATIONS: ReadonlySet<string> = new Set([
  'rs', 'no', 'nos', 'art', 'arts', 'sec', 'secs', 'cl', 'sch',
  'govt', 'dept', 'min', 'ltd', 'pvt', 'co', 'corp',
  'dr', 'mr', 'mrs', 'ms', 'smt', 'shri', 'sri', 'prof', 'hon', 'st',
  'vs', 'ors', 'anr', 'etc', 'approx', 'est', 'fig', 'vol', 'ch', 'para', 'pp',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sept', 'sep', 'oct', 'nov', 'dec',
]);

const TERMINATORS = '.!?';

function endsAbbreviation(block: string, dotIndex: number): boolean {
  if (block[dotIndex] !== '.') return false;
  let start = dotIndex;
  while (start > 0 && /[A-Za-z]/.test(block[start - 1] ?? '')) start -= 1;
  const word = block.slice(start, dotIndex);
  if (word.length === 0) return false;
  // A single letter is an initial (`A. K. Sen`) or the tail of `i.e.`/`U.S.`.
  if (word.length === 1) return true;
  return ABBREVIATIONS.has(word.toLowerCase());
}

function splitBlock(block: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < block.length; i += 1) {
    if (!TERMINATORS.includes(block[i] ?? '')) continue;

    let last = i;
    while (last + 1 < block.length && TERMINATORS.includes(block[last + 1] ?? '')) last += 1;
    let after = last + 1;
    while (after < block.length && `")']`.includes(block[after] ?? '')) after += 1;

    const nextChar = block[after];
    // A period with no space after it is a decimal point or a URL dot.
    if (nextChar !== undefined && !/\s/.test(nextChar)) {
      i = last;
      continue;
    }
    if (endsAbbreviation(block, i)) {
      i = last;
      continue;
    }
    // `Rs. 5,000 crore.` splits; `the Act. it says` does not — a lowercase
    // continuation means the period was not a sentence end.
    const nextWord = block.slice(after).match(/\S/);
    if (nextWord !== null && /[a-z]/.test(nextWord[0])) {
      i = last;
      continue;
    }

    const sentence = block.slice(start, after).trim();
    if (sentence !== '') out.push(sentence);
    start = after;
    i = after - 1;
  }
  const tail = block.slice(start).trim();
  if (tail !== '') out.push(tail);
  return out;
}

/**
 * The sentence decomposition `sentenceEvidence` must line up with, exactly.
 *
 * EXPORTED because it is a contract, not an implementation detail: the prompt
 * that asks the model for one evidence index per sentence and this splitter
 * have to agree, or perfectly good items drop on a punctuation disagreement.
 * The rule is small enough to state in a prompt:
 *
 *   - A newline ends a block. One bullet per line, and do not soft-wrap.
 *   - Inside a block, `.` `!` `?` end a sentence when followed by whitespace or
 *     end-of-string and the next word does not begin lowercase.
 *   - A period after `Rs`, `No`, `Art`, a month abbreviation or a single letter
 *     does not end a sentence.
 *   - A trailing fragment with no terminator is still a sentence.
 */
export function splitSentences(noteMd: string): string[] {
  const out: string[] = [];
  for (const rawBlock of stripMarkdown(noteMd).split(/\n+/)) {
    const block = normaliseForGrounding(rawBlock);
    if (block === '') continue;
    out.push(...splitBlock(block));
  }
  return out;
}

/* -------------------------------------------------------------------- verdict */

/** The subset of `DropReason` this file can produce. */
export type GroundingDropReason = Extract<
  DropReason,
  | 'ungrounded_quote'
  | 'ungrounded_number'
  | 'ungrounded_date'
  | 'ungrounded_citation'
  | 'uncovered_sentence'
>;

export interface GroundingFailure {
  reason: GroundingDropReason;
  /** Human-readable, for the summary frame she reads. Never a score. */
  detail: string;
}

export type GroundingVerdict =
  | {
      readonly ok: true;
      /**
       * `evidence` with every `at` resolved to an offset into `normalisedText`,
       * and every `quote` replaced by its normalised form.
       *
       * The substitution is what makes the offset MEAN something:
       * `normalisedText.slice(at, at + quote.length) === quote` holds for every
       * span an item leaves this function with, and a test asserts it. Keeping
       * the model's raw string instead would leave `at` pointing at text that
       * does not equal the quote whenever the page used a smart quote.
       */
      readonly evidence: readonly EvidenceSpan[];
      readonly normalisedText: string;
      readonly failures: readonly [];
    }
  | {
      readonly ok: false;
      /** What the summary frame counts. The FIRST failure, in check order. */
      readonly reason: GroundingDropReason;
      readonly detail: string;
      /** Every failure found, so one drop does not hide three problems. */
      readonly failures: readonly GroundingFailure[];
      readonly normalisedText: string;
    };

function preview(text: string, limit = 80): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

/**
 * The gate. Free, deterministic, no model, no network, no I/O.
 *
 * NOT checked here, deliberately:
 *
 *  - That `draft.url` names `doc`. Pairing a draft with its document is the
 *    pipeline's job and it owns `unknown_url`; a URL comparison in here would
 *    have to guess how the pipeline canonicalises and could drop every item in
 *    a digest on a trailing-slash disagreement.
 *  - `headline` and `anthro.usageLine`. The spec grounds `noteMd`, and the
 *    usage line is a synthesis of Paper 1 theory that the source will never
 *    contain verbatim. The headline is an unclosed surface — `ungroundedNumbers`
 *    and friends are exported so the pipeline can widen the scan if it wants.
 *  - Note length and evidence count. `note_too_long` is a separate drop reason
 *    with a separate owner.
 */
export function verifyGrounding(draft: DigestItemDraft, doc: SourceDocument): GroundingVerdict {
  const normalisedText = normaliseForGrounding(doc.text);
  const failures: GroundingFailure[] = [];

  /* 1. Quote grounding. Substring, not similarity. */
  const resolved: EvidenceSpan[] = [];
  if (draft.evidence.length === 0) {
    // Zero evidence is a drop, never an "unverified" badge. An item that
    // brought no proof has not failed a sentence mapping — it failed to bring
    // any proof at all, which is why this is bucketed as a quote failure and
    // `uncovered_sentence` keeps meaning "the note outran its evidence".
    failures.push({
      reason: 'ungrounded_quote',
      detail: 'no evidence spans: nothing in the note is backed by a verbatim quote',
    });
  }
  for (let i = 0; i < draft.evidence.length; i += 1) {
    const span = draft.evidence[i];
    if (span === undefined) continue;
    const quote = normaliseForGrounding(span.quote);
    if (quote === '') {
      failures.push({ reason: 'ungrounded_quote', detail: `evidence[${i}] is empty` });
      continue;
    }
    const at = normalisedText.indexOf(quote);
    if (at < 0) {
      failures.push({
        reason: 'ungrounded_quote',
        detail: `evidence[${i}] is not a substring of the source: "${preview(quote)}"`,
      });
      continue;
    }
    resolved.push({ quote, at });
  }

  /* 2. Numbers. 3. Dates. 4. Citations.
   *
   * Order decides which reason is REPORTED, never whether the item drops.
   * One consequence worth knowing when reading a summary frame: a 4-digit
   * year is a number token too, so an invented judgment year is counted as
   * `ungrounded_number` rather than `ungrounded_date`. The date check still
   * earns its place — it is the only thing that catches an invented MONTH or
   * weekday, which carry no digits at all. */
  const numbers = ungroundedNumbers(draft.noteMd, doc.text);
  if (numbers.length > 0) {
    failures.push({
      reason: 'ungrounded_number',
      detail: `numbers absent from the source: ${numbers.join(', ')}`,
    });
  }
  const dates = ungroundedDates(draft.noteMd, doc.text);
  if (dates.length > 0) {
    failures.push({
      reason: 'ungrounded_date',
      detail: `dates absent from the source: ${dates.join(', ')}`,
    });
  }
  const citations = ungroundedCitations(draft.noteMd, doc.text);
  if (citations.length > 0) {
    failures.push({
      reason: 'ungrounded_citation',
      detail: `citations absent from the source: ${citations.join(', ')}`,
    });
  }

  /* 5. Sentence coverage. */
  const sentences = splitSentences(draft.noteMd);
  if (sentences.length === 0) {
    failures.push({
      reason: 'uncovered_sentence',
      detail: 'the note has no sentences',
    });
  } else if (draft.sentenceEvidence.length !== sentences.length) {
    failures.push({
      reason: 'uncovered_sentence',
      detail:
        `${sentences.length} sentence(s) but ${draft.sentenceEvidence.length} evidence ` +
        `index/indices: every sentence must name the evidence it rests on`,
    });
  } else {
    for (let i = 0; i < draft.sentenceEvidence.length; i += 1) {
      const index = draft.sentenceEvidence[i];
      if (
        index === undefined ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= draft.evidence.length
      ) {
        failures.push({
          reason: 'uncovered_sentence',
          detail: `sentence ${i + 1} points at evidence[${String(index)}], which does not exist`,
        });
      }
    }
  }

  const first = failures[0];
  if (first !== undefined) {
    return {
      ok: false,
      reason: first.reason,
      detail: first.detail,
      failures,
      normalisedText,
    };
  }
  return { ok: true, evidence: resolved, normalisedText, failures: [] };
}
