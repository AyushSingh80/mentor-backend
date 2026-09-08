/**
 * Which of the 86 syllabus SECTIONS a past question belongs to, by rules alone.
 *
 * Pure. No `@/db/*`, no `node:fs`, no `expo/*` — `tools/pyq-map.ts` is the only
 * caller that needs a filesystem, and it is a separate file precisely so that
 * this one loads under `node --import tsx` and is testable against the real
 * 438-leaf syllabus rather than a fixture that agrees with the code.
 *
 * ## Why sections and not leaves
 *
 * Every consumer of `syllabusSlug` groups at `(paper, topic)`:
 * `coverageBySection`, the refill aim, MCQ eligibility, and every prescription
 * the mentor card builds on top of those. Exactly one screen reads the leaf. So
 * a section-accurate map delivers almost all of the value, and the search space
 * for the part a machine can do drops from 438 to 86.
 *
 * That is also what makes the human step cheap. Confirming "Modern Indian
 * History" takes under a second; choosing among 438 bullets does not. The
 * proposer is a SHORTLIST. It never decides — see `tools/pyq-map.ts`, where
 * every mapping is a keystroke by a person.
 *
 * ## Coverage, not rarity
 *
 * `server/src/ca/headlines.ts` records the measured failure this file is built
 * to avoid. Its first two attempts qualified a slug on a RARE term — one
 * carried by few labels. Against this same syllabus that rule is worthless: of
 * 1,163 distinct label terms, 1,152 are carried by nine labels or fewer and 824
 * by exactly one, so a single incidental word claimed a label and everything
 * got tagged to something.
 *
 * Rarity describes the SYLLABUS. It says nothing about whether the question is
 * about that topic. Coverage asks the useful question instead: how much of this
 * label did the stem actually restate? That rule is reused here verbatim,
 * including its thresholds, so the two matchers do not drift into disagreeing
 * about what "matches" means.
 *
 * What differs is the unit. A section is scored by the best coverage any ONE of
 * its labels achieves — its printed heading, or any leaf bullet beneath it —
 * because a stem restates a bullet ("Non-Cooperation and Khilafat movements"),
 * almost never a heading ("The Freedom Struggle").
 *
 * ## Returning nothing is a correct answer
 *
 * A wrong tag is worse than no tag and the asymmetry is not close. An unmapped
 * question still drills; it simply does not aim. A MIS-mapped one silently
 * feeds `mcqWeakTopics`, the refill aim and every mentor prescription built on
 * them, and nothing downstream can tell it from a good row. So the gates below
 * are tuned to refuse rather than reach, and an empty result is the expected
 * output for a CSAT reasoning question, a map-based question, or anything whose
 * subject the syllabus does not name.
 *
 * ## What was deliberately NOT built
 *
 * No IDF or term weighting — that is the rarity mistake wearing a different
 * hat. No exam-boilerplate stopword list either: coverage is computed over
 * LABEL terms and the stem is only a membership set, so stripping "consider the
 * following statements" from the stem changes no score unless those words also
 * appear in a syllabus label. Measured against the real dataset, of the exam
 * boilerplate only 'context' and 'answer' appear in any label at all. A list
 * that does nothing is a list that will later be trusted to do something.
 */

import { sectionKeyOf } from '@/lib/ca-tags';

/**
 * One syllabus row, structurally. Widened from `SyllabusSeedEntry` — `paper` is
 * a plain string so a working file read off disk can be scored without first
 * being narrowed to `PaperValue`, which is a validation this module has no
 * business performing.
 */
export interface SectionGuessEntry {
  slug: string;
  paper: string;
  /** The printed section heading. The grouping key, with `paper`. */
  topic: string;
  /** The leaf bullet. Null where the syllabus prints a heading with no bullets. */
  subtopic: string | null;
}

export interface SectionProposal {
  /** `${paper}:${topic}` — the same key `coverageBySection` groups on. */
  key: string;
  paper: string;
  topic: string;
  /** Higher is better. Comparable only within one call. */
  score: number;
  /**
   * The label that scored best — a heading or a leaf bullet, verbatim.
   *
   * Exposed because the proposer's job is to be LEGIBLY wrong. A human reading
   * "matched: Non-Cooperation and Khilafat movements" can accept or reject in a
   * second; a bare section name with a number beside it has to be re-derived in
   * their head every time.
   */
  evidence: string;
  /** The terms of `evidence` the stem restated. */
  matched: readonly string[];
  /** How many of the section's labels passed the gate. Corroboration. */
  support: number;
}

/** One section, for a caller that needs to list or search them. */
export interface SectionSummary {
  key: string;
  paper: string;
  topic: string;
  leaves: readonly SectionGuessEntry[];
}

/* ------------------------------------------------------------- vocabulary */

/**
 * Ported from `server/src/ca/select.ts#significantTerms`, character for
 * character.
 *
 * Copied rather than shared because the server is a separate package and the
 * device cannot import from it — the same reason `ca-map.ts` carries its own
 * copy of `headlineFingerprint`. Copied VERBATIM rather than improved, so that
 * a headline and a question stem are normalised identically and "matches" means
 * one thing across the two matchers.
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it', 'its', 'of', 'on',
  'or', 'over', 'that', 'the', 'to', 'up', 'with', 'after', 'amid', 'new', 'says', 'said',
]);

/**
 * Significant word stems of a piece of text, in the order they appear.
 *
 * The stemmer is crude, and crude is the specification: it only has to make
 * plural and tense agree — 'movements'/'movement', 'policies'/'policy'. It does
 * NOT merge derivations, so 'nationalist' and 'nationalism' stay apart, and so
 * do 'India' and 'Indian'. That costs real matches and is accepted: every miss
 * costs one shortlist entry the human replaces with a search, while every
 * loosening buys matches at the price of the false tags this file exists to
 * refuse. See the accuracy note in `tests/pyq-section-guess.test.ts`.
 */
export function significantTerms(text: string): string[] {
  const raw = typeof text === 'string' ? text : '';
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word))
    .map((word) =>
      /(ies|ied)$/.test(word)
        ? word.replace(/(ies|ied)$/, 'y')
        : word.replace(/(ing|ed|es|s)$/, ''),
    )
    .filter((word) => word.length > 2);
}

/* -------------------------------------------------------------- thresholds */

/**
 * How much of a label its matched terms must cover before it counts.
 *
 * 0.5, the value `headlines.ts` settled on against this syllabus. A label of
 * four terms needs at least two, and at least half.
 */
export const MIN_LABEL_COVERAGE = 0.5;

/**
 * At or below this many terms, a label must match in FULL.
 *
 * A one- or two-word label is broad — 'Federalism', 'Indian Society',
 * 'Attitude' — and half of two terms is one term, which is the
 * accidental-overlap case rather than a signal.
 */
export const SHORT_LABEL_TERMS = 2;

/**
 * A longer label needs at least this many matched terms whatever its coverage.
 *
 * Belt and braces with `MIN_LABEL_COVERAGE`: it only binds on a three-term
 * label, where one matched term is already 0.33 and two is 0.67, so the pair of
 * rules agree everywhere except at three-and-a-bit, and there the stricter one
 * should win.
 */
export const MIN_MATCHED_TERMS = 2;

/** Five fits on a screen and is about as many as a person will read before choosing. */
export const DEFAULT_PROPOSAL_LIMIT = 5;

/* ----------------------------------------------------------------- scoring */

/**
 * Coverage occupies 0..100 so nothing below can cross it — the corroboration
 * and breadth terms ORDER sections within a coverage band, they do not trade
 * against it. Same shape as `RELEVANCE_BAND` in `headlines.ts`, and for the
 * same reason: a scoring term that can outvote the primary signal is a scoring
 * term that eventually does.
 */
const COVERAGE_BAND = 100;

/** Per extra label in the same section that also passed, capped at three. */
const SUPPORT_WEIGHT = 5;
const MAX_SUPPORT_BONUS = 3;

/** Breadth of overlap, capped, purely to break ties between equal coverages. */
const MAX_BREADTH_BONUS = 8;

/**
 * A fragment's coverage is worth 90% of a whole label's.
 *
 * Matching a whole bullet proves the stem is about that bullet. Matching one
 * item of an enumeration proves it is about one thing the bullet lists, which
 * is nearly as good and not quite. The discount is small enough that a fully
 * matched fragment (90) still beats a barely qualifying whole label (50) —
 * which is the right order, since 'plate tectonics' restated in full is better
 * evidence than half of a six-word bullet — and large enough that a whole label
 * always wins a tie against its own fragment.
 */
const FRAGMENT_WEIGHT = 0.9;

/**
 * Where an enumerated bullet comes apart.
 *
 * UPSC bullets are lists: 'Earth's interior, plate tectonics and rock systems',
 * 'Global groupings — G20, BRICS, SCO and the Quad'. Comma, semicolon, colon,
 * em-dash, en-dash and the word 'and' are the separators the printed syllabus
 * actually uses.
 *
 * The plain hyphen is deliberately NOT a separator. 'anti-defection' and
 * 'Non-Cooperation' are single terms in this domain, and splitting them is how
 * the most specific phrases in the syllabus would become the least specific.
 */
const ENUMERATION = /\s*(?:[,;:—–]|\band\b)\s*/;

interface Label {
  /** The heading or bullet, verbatim, for `SectionProposal.evidence`. */
  readonly text: string;
  readonly terms: readonly string[];
  /** `FRAGMENT_WEIGHT` for one item of an enumeration, 1 for a whole label. */
  readonly weight: number;
  /**
   * The whole label this came from.
   *
   * A bullet and its own fragments are ONE piece of evidence. Without this,
   * every list bullet would corroborate itself three times over and `support`
   * would measure punctuation rather than agreement.
   */
  readonly group: string;
}

interface SectionIndex {
  readonly key: string;
  readonly paper: string;
  readonly topic: string;
  readonly labels: readonly Label[];
  readonly leaves: readonly SectionGuessEntry[];
}

/**
 * Group entries into sections, each carrying its heading and its bullets as
 * separately scorable labels.
 *
 * Heading and bullet are kept apart rather than concatenated: gluing them would
 * add the heading's terms to every bullet's denominator, so a stem that
 * restates a bullet perfectly would score 4/7 instead of 4/4 and fall under the
 * gate. The section is the unit of the ANSWER, not of the evidence.
 *
 * Built per call rather than cached. It is 438 rows and a few string splits,
 * and the alternative is a module-level cache keyed on an array identity that
 * would silently serve a stale syllabus to the one caller — a re-seed — that
 * most needs a fresh one.
 */
function indexSections(entries: readonly SectionGuessEntry[]): SectionIndex[] {
  const sections = new Map<string, {
    key: string;
    paper: string;
    topic: string;
    labels: Label[];
    leaves: SectionGuessEntry[];
    seenLabels: Set<string>;
  }>();

  for (const entry of entries) {
    const paper = typeof entry.paper === 'string' ? entry.paper : '';
    const topic = typeof entry.topic === 'string' ? entry.topic.trim() : '';
    if (paper === '' || topic === '') continue;

    const key = sectionKeyOf(paper, topic);
    let section = sections.get(key);
    if (section === undefined) {
      section = { key, paper, topic, labels: [], leaves: [], seenLabels: new Set() };
      sections.set(key, section);
      // The heading is a label in its own right. 'Internal Security' and
      // 'Science and Technology' are restated by stems verbatim and often.
      pushLabel(section, topic);
    }

    section.leaves.push(entry);
    const subtopic = entry.subtopic?.trim() ?? '';
    if (subtopic !== '') pushLabel(section, subtopic);
  }

  return [...sections.values()].map((section) => ({
    key: section.key,
    paper: section.paper,
    topic: section.topic,
    labels: section.labels,
    leaves: section.leaves,
  }));
}

function fingerprintOf(terms: readonly string[]): string {
  return [...terms].sort().join(' ');
}

/**
 * Add a heading or bullet, plus each item of the enumeration it may be.
 *
 * A fragment is only worth scoring at two terms or more. A one-term fragment —
 * 'Roads', 'structure', 'Poverty' — is a single common word that would match in
 * full on one accidental overlap, which is the rarity failure the header
 * describes arriving by a different route. The gate in `proposeSections` then
 * requires a fragment to match in FULL, since half of two terms is one term.
 */
function pushLabel(
  section: { labels: Label[]; seenLabels: Set<string> },
  text: string,
): void {
  // Two bullets that normalise to the same term set would otherwise count as
  // two corroborating labels for what is one piece of evidence.
  const terms = [...new Set(significantTerms(text))];
  if (terms.length === 0) return;
  const group = fingerprintOf(terms);
  if (section.seenLabels.has(group)) return;
  section.seenLabels.add(group);
  section.labels.push({ text, terms, weight: 1, group });

  for (const piece of text.split(ENUMERATION)) {
    const fragmentTerms = [...new Set(significantTerms(piece))];
    if (fragmentTerms.length < 2) continue;
    const fingerprint = fingerprintOf(fragmentTerms);
    if (section.seenLabels.has(fingerprint)) continue;
    section.seenLabels.add(fingerprint);
    section.labels.push({ text: piece.trim(), terms: fragmentTerms, weight: FRAGMENT_WEIGHT, group });
  }
}

/**
 * Sections the text plausibly belongs to, best first. Often none.
 *
 * A label qualifies when the text restates enough of it: in full for a label of
 * one or two terms, otherwise at least two terms AND at least half of them. A
 * section is then scored on the best label it has, nudged by how many of its
 * other labels also qualified.
 *
 * `entries` is the candidate set and the ONLY source of truth for what may be
 * returned. Restricting it — to the papers a Prelims booklet actually covers,
 * say — is the caller's job and is the single most effective thing a caller can
 * do for precision: it is what stops an ethics case being proposed a section of
 * Physical Anthropology because both said 'human'.
 *
 * Returning `[]` is the correct answer for a question the syllabus does not
 * name, and the caller must offer a way to proceed without a tag. See the
 * header.
 */
export function proposeSections(
  text: string,
  entries: readonly SectionGuessEntry[],
  limit: number = DEFAULT_PROPOSAL_LIMIT,
): SectionProposal[] {
  if (limit <= 0) return [];

  const terms = new Set(significantTerms(text));
  if (terms.size === 0) return [];

  const proposals: SectionProposal[] = [];

  for (const section of indexSections(entries)) {
    let best: { label: Label; matched: string[]; strength: number } | null = null;
    const supporting = new Set<string>();
    const breadth = new Set<string>();

    for (const label of section.labels) {
      const matched = label.terms.filter((term) => terms.has(term));
      if (matched.length === 0) continue;

      const full = matched.length === label.terms.length;
      if (label.weight !== 1) {
        // A fragment is a claim about one item of a list, so it is only
        // evidence when the stem restates that item entirely. A partial
        // fragment match is a fraction of a fraction of a bullet.
        if (!full) continue;
      } else if (label.terms.length <= SHORT_LABEL_TERMS) {
        if (!full) continue;
      } else if (
        matched.length < MIN_MATCHED_TERMS ||
        matched.length / label.terms.length < MIN_LABEL_COVERAGE
      ) {
        continue;
      }

      supporting.add(label.group);
      for (const term of matched) breadth.add(term);

      const strength = (matched.length / label.terms.length) * label.weight;
      // Ties on strength go to the label that matched more terms outright, so a
      // fully matched four-term bullet outranks a fully matched two-word
      // heading — the bullet is the more specific claim.
      if (
        best === null ||
        strength > best.strength ||
        (strength === best.strength && matched.length > best.matched.length)
      ) {
        best = { label, matched, strength };
      }
    }

    if (best === null) continue;

    proposals.push({
      key: section.key,
      paper: section.paper,
      topic: section.topic,
      score:
        best.strength * COVERAGE_BAND +
        Math.min(supporting.size - 1, MAX_SUPPORT_BONUS) * SUPPORT_WEIGHT +
        Math.min(breadth.size, MAX_BREADTH_BONUS),
      evidence: best.label.text,
      matched: best.matched,
      support: supporting.size,
    });
  }

  // `key` breaks ties so the same stem always produces the same shortlist in
  // the same order. A mapping session that re-ordered its own options between
  // runs would make a resumed session's muscle memory wrong.
  proposals.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  return proposals.slice(0, limit);
}

/* ------------------------------------------------------------ section lists */

/** Every section in `entries`, in the order the syllabus prints them. */
export function sectionsOf(entries: readonly SectionGuessEntry[]): SectionSummary[] {
  return indexSections(entries).map((section) => ({
    key: section.key,
    paper: section.paper,
    topic: section.topic,
    leaves: section.leaves,
  }));
}

/**
 * The leaves of one section, or `[]` for a key no entry produces.
 *
 * `[]` rather than a throw: the caller is an interactive tool holding a key a
 * human just chose from a list this module produced, and the only way to reach
 * the empty case is a syllabus that changed underneath a resumed session. That
 * should cost one question, not the session.
 */
export function leavesOfSection(
  entries: readonly SectionGuessEntry[],
  key: string,
): SectionGuessEntry[] {
  return entries.filter((entry) => sectionKeyOf(entry.paper, entry.topic) === key);
}

/**
 * Sections whose heading contains `query`, case-insensitively.
 *
 * The escape hatch for when the shortlist is wrong. Without it, a proposer miss
 * forces a skip, and skips that were caused by the tool rather than by the
 * question are how a null stops meaning "a person looked and declined".
 */
export function searchSections(
  entries: readonly SectionGuessEntry[],
  query: string,
): SectionSummary[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [];
  return sectionsOf(entries).filter(
    (section) =>
      section.topic.toLowerCase().includes(needle) ||
      section.paper.toLowerCase().includes(needle),
  );
}
