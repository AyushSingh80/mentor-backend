/**
 * Headlines mode: a digest with no model anywhere in it.
 *
 * ## Why this exists
 *
 * The digest pipeline has four stages and only two of them ever needed a model:
 * fetching the feeds and fetching the articles are plain HTTP. But
 * `EVAL_RUNNER=fake` replaces all four, so "run without a key" and "run with
 * invented data" became the same mode — and the real fetcher, which is written
 * and tested, had never once run on a device.
 *
 * This module is the third option. Real feeds, real headlines, real links, and
 * selection by rules rather than by judgement.
 *
 * ## What it deliberately does NOT do
 *
 * It does not write a note. The publisher's own lede is carried across verbatim
 * and labelled as theirs. That is not a downgrade dressed up as a feature: an
 * invented summary is the one output this whole codebase refuses to produce,
 * and a rules engine has nothing to summarise WITH. Reading the actual editorial
 * is what she was going to do anyway.
 *
 * It also never fetches article bodies. The notes call is what needed them, and
 * with no notes call there is nothing to ground, nothing to quote, and no
 * copyright surface beyond a headline and a link.
 *
 * ## The tagging rule, and its bias
 *
 * Tags come from matching headline terms against the syllabus labels the APP
 * sent, restricted to the papers the FEED declares in `sources.json`. Both
 * halves are load-bearing: the labels are the only vocabulary that agrees with
 * her device, and the paper restriction is what stops an RBI press release
 * being tagged to Indian art because both mention "development".
 *
 * The bias is deliberately toward under-tagging. An untagged item is shown as
 * untagged and she can still read it; a mis-tagged item corrupts the coverage
 * arithmetic that `coverageBySection` reports, and she plans against that.
 */

import { significantTerms, headlineFingerprint, type Candidate } from './select.js';
import type { ItemKind } from './types.js';

/** One syllabus entry as the app sends it in `vocabulary`. */
export interface HeadlineVocabularyEntry {
  slug: string;
  label: string;
  /** `gs1` … `anthro_p2`. Absent means "matches any paper". */
  paper?: string | null;
  level?: string | null;
}

/** The `sources.json` fields headlines mode reads. */
export interface HeadlineSource {
  id: string;
  name: string;
  papers: readonly string[];
  trust: string;
}

export interface HeadlinePick {
  candidate: Candidate;
  /** Slugs from the request's vocabulary. Usually empty — see `tagCandidate`. */
  syllabusTags: string[];
  /**
   * The papers this item's FEED declares in `sources.json`.
   *
   * Not inferred from the text and therefore never wrong: an RBI release is a
   * GS3 item because the source set says RBI covers GS3. This is what makes an
   * untagged item still filable, and it is the honest fallback for a rules
   * engine that mostly cannot place a headline on a leaf.
   */
  papers: readonly string[];
  itemKind: ItemKind;
  headlineFingerprint: string;
  /** Higher is better. Exposed so a caller can log why the order came out. */
  score: number;
  /** Human-readable scoring components, for the digest's own audit trail. */
  reasons: string[];
}

export type HeadlineDropReason =
  | 'stale'
  | 'untagged'
  | 'over_source_cap'
  | 'unknown_feed'
  | 'no_title';

export interface HeadlineDrop {
  canonicalUrl: string;
  headline: string;
  reason: HeadlineDropReason;
}

export interface SelectHeadlinesInput {
  /** Already deduplicated against history by `prepareCandidates`. */
  candidates: readonly Candidate[];
  vocabulary: readonly HeadlineVocabularyEntry[];
  sources: readonly HeadlineSource[];
  /** Local day, `YYYY-MM-DD`. Byte-compared, never re-parsed. */
  date: string;
  /** Hard ceiling on picks. */
  limit: number;
  /** Entries published before this many days ago are dropped. */
  maxAgeDays?: number;
  /** No single outlet may take more than this share of the picks. */
  maxPerSource?: number;
}

export interface SelectHeadlinesResult {
  picked: HeadlinePick[];
  drops: HeadlineDrop[];
}

/**
 * A week. Long enough that a Sunday sweep after a busy week still finds the
 * Tuesday judgment, short enough that the digest is not an archive.
 */
export const DEFAULT_MAX_AGE_DAYS = 7;

/**
 * Three per outlet per day.
 *
 * Without this, The Hindu's national feed — which publishes far more than the
 * primary sources do — takes every slot on volume alone, and the digest becomes
 * one newspaper's front page. Diversity across sources is most of what makes a
 * sweep more useful than a subscription.
 */
export const DEFAULT_MAX_PER_SOURCE = 3;

/**
 * How much of a label its matched terms must cover before the slug is claimed.
 *
 * ## Why coverage and not rarity
 *
 * The first two attempts qualified a slug on a RARE term — one carried by few
 * labels. Measured against the real 438-leaf syllabus that rule is worthless:
 * of 1,163 distinct label terms, 1,152 are carried by nine labels or fewer and
 * 824 by exactly one. "government" is carried by exactly one label. So an RBI
 * notice reading "Auction of Government of India Dated Securities" claimed that
 * label on one incidental word, and every headline tagged to something.
 *
 * Rarity describes the SYLLABUS. It says nothing about whether the headline is
 * about that topic, because a headline's words are mostly not syllabus words at
 * all and one accidental overlap is the norm rather than the signal.
 *
 * Coverage asks the useful question instead: how much of this heading did the
 * headline actually restate? A label of one word needs that word. A label of
 * four needs at least two, and at least half.
 */
const MIN_LABEL_COVERAGE = 0.5;

/**
 * Below this, a label must match in FULL.
 *
 * A one- or two-word heading is broad — "Federalism", "Indian Society" — and
 * half of two words is one word, which is the accidental-overlap case again.
 */
const SHORT_LABEL_TERMS = 2;

/**
 * Feed to item kind.
 *
 * Derived from WHO published it, never inferred from the text — a rules engine
 * reading "the Court held" out of a newspaper report and calling it a judgment
 * is exactly the invention this mode exists to avoid. The Supreme Court's own
 * feed publishes judgments; a newspaper publishes reports about them.
 *
 * Anything not listed falls to `report`, which is the honest default for a news
 * item: something was reported. It is a DURABLE kind, so headlines mode does not
 * silently collide with `MAX_EVENT_ITEMS_PER_DAY`.
 */
const KIND_BY_FEED: Readonly<Record<string, ItemKind>> = {
  sci_judgments: 'judgment',
  prs_billtrack: 'structural',
  rbi_press: 'data',
  pib_releases: 'scheme',
  tribal_affairs: 'scheme',
};

/**
 * Large enough that no combination of trust, tag count and recency can bridge
 * it. Relevance is a band the other terms order WITHIN, not a factor they trade
 * against.
 */
const RELEVANCE_BAND = 1000;

/** Primary sources outrank commentary, because a primary source IS the fact. */
const TRUST_SCORE: Readonly<Record<string, number>> = {
  primary: 3,
  secondary: 1,
};

interface LabelIndex {
  /** Stem to the slugs whose label contains it. */
  readonly byTerm: ReadonlyMap<string, readonly string[]>;
  /** Slug to its full stem set, so a full-phrase match can be checked. */
  readonly termsBySlug: ReadonlyMap<string, readonly string[]>;
  readonly paperBySlug: ReadonlyMap<string, string | null>;
}

/**
 * Index the request's vocabulary by stem.
 *
 * Built per request rather than cached, because the vocabulary IS per request:
 * `tagVocabulary` emits leaves only for sections she has started, so it grows
 * as she does. A cached index would tag against last month's syllabus.
 */
export function buildLabelIndex(vocabulary: readonly HeadlineVocabularyEntry[]): LabelIndex {
  const byTerm = new Map<string, string[]>();
  const termsBySlug = new Map<string, readonly string[]>();
  const paperBySlug = new Map<string, string | null>();

  for (const entry of vocabulary) {
    const slug = typeof entry.slug === 'string' ? entry.slug.trim() : '';
    if (slug === '') continue;
    if (termsBySlug.has(slug)) continue;

    const terms = [...new Set(significantTerms(entry.label ?? ''))];
    termsBySlug.set(slug, terms);
    paperBySlug.set(slug, entry.paper ?? null);

    for (const term of terms) {
      const bucket = byTerm.get(term);
      if (bucket === undefined) byTerm.set(term, [slug]);
      else bucket.push(slug);
    }
  }

  return { byTerm, termsBySlug, paperBySlug };
}

/**
 * Slugs a candidate plausibly belongs to, best first. Usually none.
 *
 * A slug qualifies when the text restates enough of its label: a full match for
 * a heading of one or two words, otherwise at least two terms AND at least half
 * of them. See `MIN_LABEL_COVERAGE` for why coverage rather than rarity.
 *
 * `papers` restricts the result to what the feed actually covers. An empty
 * `papers` list means the feed declared none and everything is allowed.
 *
 * Returning nothing is the COMMON case and is a correct answer. Most news is
 * not a restatement of a syllabus heading, and an item with no leaf tag still
 * carries its feed's declared papers — see `HeadlinePick.papers`.
 */
export function tagCandidate(
  text: string,
  index: LabelIndex,
  papers: readonly string[],
): string[] {
  const terms = new Set(significantTerms(text));
  if (terms.size === 0) return [];

  const allowedPapers = new Set(papers);
  const scored: { slug: string; score: number }[] = [];

  for (const [slug, labelTerms] of index.termsBySlug) {
    if (labelTerms.length === 0) continue;

    const paper = index.paperBySlug.get(slug) ?? null;
    if (allowedPapers.size > 0 && paper !== null && !allowedPapers.has(paper)) continue;

    let matched = 0;
    for (const term of labelTerms) if (terms.has(term)) matched += 1;
    if (matched === 0) continue;

    const full = matched === labelTerms.length;
    if (labelTerms.length <= SHORT_LABEL_TERMS) {
      if (!full) continue;
    } else if (matched < 2 || matched / labelTerms.length < MIN_LABEL_COVERAGE) {
      continue;
    }

    // Coverage first, then absolute term count, so "Governor discretionary
    // powers" fully matched outranks a half-matched six-word heading.
    scored.push({ slug, score: (matched / labelTerms.length) * 100 + matched });
  }

  scored.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
  return scored.map((entry) => entry.slug);
}

/** `YYYY-MM-DD` distance in whole days, or null if either side is unparseable. */
function ageInDays(publishedAt: string | null, date: string): number | null {
  if (publishedAt === null || publishedAt === '') return null;
  const published = new Date(publishedAt);
  if (Number.isNaN(published.getTime())) return null;
  // `date` is a local day label and is compared as one: appending midnight UTC
  // to both sides keeps this a whole-day subtraction rather than a timezone
  // conversion, which is a different operation and belongs in `localDate`.
  const day = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(day.getTime())) return null;
  const publishedDay = new Date(
    `${published.toISOString().slice(0, 10)}T00:00:00Z`,
  );
  return Math.round((day.getTime() - publishedDay.getTime()) / 86_400_000);
}

/**
 * The day's headlines, by rules alone.
 *
 * Ordering is by score, but the source cap is applied over that ordering rather
 * than after it: taking the top N and then trimming per source would leave slots
 * empty when one outlet dominated the head of the list.
 */
export function selectHeadlines(input: SelectHeadlinesInput): SelectHeadlinesResult {
  const maxAgeDays = input.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const maxPerSource = input.maxPerSource ?? DEFAULT_MAX_PER_SOURCE;
  const index = buildLabelIndex(input.vocabulary);
  const sourceById = new Map(input.sources.map((source) => [source.id, source] as const));

  const drops: HeadlineDrop[] = [];
  const ranked: HeadlinePick[] = [];

  for (const candidate of input.candidates) {
    const headline = candidate.headline.trim();
    if (headline === '') {
      drops.push({ canonicalUrl: candidate.canonicalUrl, headline, reason: 'no_title' });
      continue;
    }

    const source = sourceById.get(candidate.feedId);
    if (source === undefined) {
      // An entry from a feed that is not in the allowlist. `collectEntries`
      // should make this impossible; dropping rather than defaulting means a
      // future bug there surfaces as a missing item rather than as an item with
      // invented provenance.
      drops.push({ canonicalUrl: candidate.canonicalUrl, headline, reason: 'unknown_feed' });
      continue;
    }

    const age = ageInDays(candidate.publishedAt, input.date);
    if (age !== null && age > maxAgeDays) {
      drops.push({ canonicalUrl: candidate.canonicalUrl, headline, reason: 'stale' });
      continue;
    }

    // The lede is matched alongside the headline: a headline like "Ground
    // control" carries no terms at all, and The Hindu's editorials are titled
    // that way as a house style.
    const haystack = `${headline} ${candidate.lede ?? ''}`;
    const syllabusTags = tagCandidate(haystack, index, source.papers);

    const reasons: string[] = [];
    let score = 0;

    const trust = TRUST_SCORE[source.trust] ?? 0;
    if (trust > 0) {
      score += trust;
      reasons.push(`${source.trust} source`);
    }

    if (syllabusTags.length > 0) {
      /**
       * A band, not a bonus. Anything that reaches her syllabus outranks
       * everything that does not, whoever published it.
       *
       * Measured against the live feeds, trust alone put three RBI notices —
       * "Money Market Operations as on September 07", "Auction of Government of
       * India Dated Securities" — above every Hindu editorial, because a
       * primary source outscored a tagged secondary one. Those notices are
       * daily operational boilerplate. A twenty-minute reading budget spent on
       * them is the digest actively wasting her morning, and being a primary
       * source does not make a bond auction examinable.
       */
      score += RELEVANCE_BAND;
      // Capped at three: the fourth tag on one headline is the rule reaching,
      // and each tag counted separately would let a vague item outrank a sharp
      // one on breadth alone.
      score += Math.min(3, syllabusTags.length) * 2;
      reasons.push(`${syllabusTags.length} syllabus tag(s)`);
    }

    // Recency, but gently. A three-day-old PRS bill summary is worth more than
    // this morning's routine press release, so age adjusts the ranking without
    // being allowed to dominate it.
    if (age !== null) {
      score += Math.max(0, maxAgeDays - age) / maxAgeDays;
      reasons.push(`${age}d old`);
    }

    ranked.push({
      candidate,
      syllabusTags,
      papers: source.papers,
      itemKind: KIND_BY_FEED[candidate.feedId] ?? 'report',
      headlineFingerprint: headlineFingerprint(headline),
      score,
      reasons,
    });
  }

  // `index` breaks ties so the order is total and the same input always yields
  // the same digest. `prepareCandidates` assigns it in feed-sweep order.
  ranked.sort((a, b) => b.score - a.score || a.candidate.index - b.candidate.index);

  const picked: HeadlinePick[] = [];
  const perSource = new Map<string, number>();

  for (const entry of ranked) {
    if (picked.length >= input.limit) break;
    const used = perSource.get(entry.candidate.feedId) ?? 0;
    if (used >= maxPerSource) {
      drops.push({
        canonicalUrl: entry.candidate.canonicalUrl,
        headline: entry.candidate.headline,
        reason: 'over_source_cap',
      });
      continue;
    }
    perSource.set(entry.candidate.feedId, used + 1);
    picked.push(entry);
  }

  return { picked, drops };
}
