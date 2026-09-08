/**
 * Which items earn a slot. Pure, synchronous, no model, no network.
 *
 * ## This module is primarily NEGATIVE and that is the point
 *
 * The failure mode of every current-affairs system is producing more than
 * anyone reads. A digest of twenty items is not twice as useful as one of six;
 * it is worse, because the twenty are skimmed and the six were read. So this
 * file is mostly a sequence of reasons to say no, and the ranking at the end is
 * a tie-break among the survivors rather than the main event.
 *
 * An item earns a slot only if ALL of these hold:
 *
 *  1. It resolves to at least one syllabus tag the REQUEST supplied. No
 *     syllabus hook, no slot. This is the single highest-value filter in the
 *     system and it is free: an item she cannot file under anything she is
 *     studying is an item she will read and then not use.
 *  2. Its `kind` is durable. `event` earns at most one slot a day. A cabinet
 *     decision is structural; a bilateral visit is an event — the difference is
 *     whether what changed is a rule or a happening, and only one of those is
 *     still answerable in 2028.
 *  3. It is not a duplicate, by canonical URL or by rolling headline
 *     fingerprint. The fingerprint is what catches the same story reported by
 *     three outlets and again the next day.
 *  4. Its section is under `MAX_ITEMS_PER_SECTION_PER_WEEK`. One running story
 *     must not eat a month.
 *
 * UNDER-DELIVERY IS CORRECT. Four items on a quiet day is a good answer, and
 * `underDelivered` in the summary is how that is reported rather than an error.
 * There is no path in this file that lowers a bar to reach a count.
 */

import type { DropReason, GroundedItem, ItemKind } from './types.js';

/** Runtime companion to `ItemKind`, which types.ts declares as a type only. */
export const ITEM_KINDS = [
  'structural',
  'report',
  'judgment',
  'scheme',
  'data',
  'event',
] as const;

export function isItemKind(value: unknown): value is ItemKind {
  return typeof value === 'string' && (ITEM_KINDS as readonly string[]).includes(value);
}

/**
 * Durable kinds. What changed was a RULE, and a rule is still examinable in
 * 2028; a happening is stale by the time she sits the paper.
 */
export const DURABLE_KINDS: ReadonlySet<ItemKind> = new Set<ItemKind>([
  'structural',
  'report',
  'judgment',
  'scheme',
  'data',
]);

/**
 * Events are not banned outright, because occasionally the happening IS the
 * story. One a day is the entire allowance.
 */
export const MAX_EVENT_ITEMS_PER_DAY = 1;

/** Mirrors `CA_RULES.maxItemsPerSectionPerWeek` in the app. */
export const MAX_ITEMS_PER_SECTION_PER_WEEK = 3;

/** Mirrors `CA_RULES.maxAnthroLinkRate`. Above this the prompt is reaching. */
export const MAX_ANTHRO_LINK_RATE = 0.4;

/** Candidates shown to the shortlist call. Forty headlines is a full sweep. */
export const MAX_CANDIDATES = 40;

/** Documents the notes call is allowed to read. Each one is a paid fetch. */
export const MAX_SHORTLIST = 10;

export interface SelectionRequest {
  /** Slugs the REQUEST supplied. An item must resolve to at least one. */
  syllabusSlugs: readonly string[];
  /** How many items to deliver at most. Delivering fewer is correct. */
  maxItems: number;
  /** Canonical URLs already on the device, over the duplicate window. */
  seenCanonicalUrls: readonly string[];
  /** Headline fingerprints already on the device, over the same window. */
  seenFingerprints: readonly string[];
  /** Items already delivered per section this week. */
  sectionCountsThisWeek: Readonly<Record<string, number>>;
}

export interface SelectionDrop {
  url: string;
  headline: string;
  reason: DropReason;
  detail: string;
}

export interface SelectionOutcome {
  kept: GroundedItem[];
  drops: SelectionDrop[];
  /** Share of KEPT items claiming an Anthropology link. */
  anthroLinkRate: number;
}

/* --------------------------------------------------------- fingerprinting */

const STOPWORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it', 'its', 'of', 'on',
  'or', 'over', 'that', 'the', 'to', 'up', 'with', 'after', 'amid', 'new', 'says', 'said',
]);

/**
 * A rolling fingerprint of a headline: sorted significant word stems.
 *
 * Sorted rather than sequential so "SC quashes the bonds scheme" and "Bonds
 * scheme quashed by SC" collapse to one fingerprint — which is the actual
 * duplicate pattern across outlets, and the one a URL check cannot see.
 * "strikes"/"struck" does NOT collapse: the stemmer handles plural and tense,
 * not irregular verbs, and the example was chosen accordingly. Crude on purpose: it is a cheap pre-filter whose false positives cost
 * one item and whose false negatives cost her reading the same story twice.
 */
/**
 * Significant word stems of a piece of text, in the order they appear.
 *
 * Extracted from `headlineFingerprint` so that `headlines.ts` can match a
 * headline against a syllabus label using the SAME normalisation the duplicate
 * check uses. Two different notions of "the significant words" would mean a
 * headline could be judged a duplicate of one story and tagged as another,
 * which is the class of drift this codebase keeps paying for across a seam.
 *
 * The stemmer is crude, and crude is the specification. It only has to make
 * "bonds"/"bond" and "quashes"/"quashed" agree, because plural and tense are
 * what differ when two outlets report the same thing. It over-trims short words
 * like "read" into nothing, which shortens the list rather than corrupting it.
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

export function headlineFingerprint(headline: string): string {
  const raw = typeof headline === 'string' ? headline : '';
  const words = significantTerms(raw);

  const stems = [...new Set(words)].sort().slice(0, 8).join('-');
  if (stems !== '') return stems;

  // A headline in a script the `[^a-z0-9\s]` strip does not cover collapses to
  // the empty string, and every such headline would then be "a duplicate" of
  // every other. PIB serves Hindi outright when its `reg` parameter is wrong —
  // see `sources.json` — so this is a live path, not a hypothetical.
  //
  // The DEVICE carries the identical fallback. It has to: the app sends its
  // stored fingerprints as `seenFingerprints` and this function's output is
  // tested against that set, so a rule present on one side only is a duplicate
  // check that silently never matches. See `ca-map.ts#headlineFingerprint`.
  return raw.toLowerCase().replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------- the anthro rule */

/**
 * A link is a THEORY-INSTANCE PAIR or it is nothing.
 *
 * The rubric weights P1 theory linked to a P2 Indian example as the single
 * biggest differentiator between a 240 and a 280+ optional score. A topical
 * gesture — "this is about tribes" — scores zero and costs her the line she
 * would otherwise have written. So a claim survives only with both slugs and a
 * usage line; anything else has the link stripped and the item kept.
 *
 * Stripping rather than dropping, because a weak Anthropology claim says
 * nothing about whether the item is worth reading.
 */
export function sanitiseAnthro(
  anthro: GroundedItem['anthro'],
): { anthro: GroundedItem['anthro']; reason: DropReason | null } {
  if (anthro === null) return { anthro: null, reason: null };

  const p1 = anthro.p1Slug?.trim() ?? '';
  const p2 = anthro.p2Slug?.trim() ?? '';
  const line = anthro.usageLine?.trim() ?? '';

  // All three empty is the schema's way of saying "no claim". Not a failure.
  if (p1 === '' && p2 === '' && line === '') return { anthro: null, reason: null };

  // The P2 instance is the half that earns the marks. Without it there is a
  // concept and no example, which is exactly the answer that scores 240.
  if (p2 === '') return { anthro: null, reason: 'anthro_no_p2' };
  if (p1 === '' || line === '') return { anthro: null, reason: 'anthro_overreach' };

  return { anthro: { p1Slug: p1, p2Slug: p2, usageLine: line }, reason: null };
}

/* -------------------------------------------------------------------- scoring */

const KIND_WEIGHT: Record<ItemKind, number> = {
  // A judgment and a structural change are the two that stay true and stay
  // quotable. A report is durable but rarely load-bearing on its own.
  judgment: 5,
  structural: 5,
  scheme: 4,
  report: 3,
  data: 3,
  event: 1,
};

/**
 * Rank among survivors. Deliberately small and boring.
 *
 * Every term is something the pipeline already knows for free. Nothing here
 * asks a model what it thinks of an item, because a second opinion on ordering
 * costs as much as the note itself and improves a list of six by nothing.
 */
export function scoreItem(item: GroundedItem, request: SelectionRequest): number {
  const wanted = new Set(request.syllabusSlugs);
  const hits = item.syllabusSlugs.filter((slug) => wanted.has(slug)).length;
  return (
    (KIND_WEIGHT[item.kind] ?? 0) * 10 +
    // More than one syllabus hook means it is usable in more than one answer.
    Math.min(hits, 3) * 4 +
    // A theory-instance pair is the highest-value thing a digest can carry.
    (item.anthro === null ? 0 : 6) +
    // Evidence density: an item with three quotes was easier to ground than one
    // scraping by on a single sentence.
    Math.min(item.evidence.length, 3)
  );
}

/* ------------------------------------------------------------------ selection */

/**
 * Applies every rule, in order, and returns what reaches the wire.
 *
 * Order matters and is chosen so the drop histogram teaches something: the
 * syllabus filter runs first because "no syllabus hook" is the actionable
 * answer, and if it ran after the section cap the same item would be reported
 * as a section problem instead.
 */
export function selectItems(
  items: readonly GroundedItem[],
  request: SelectionRequest,
): SelectionOutcome {
  const drops: SelectionDrop[] = [];
  const drop = (item: GroundedItem, reason: DropReason, detail: string): void => {
    drops.push({ url: item.canonicalUrl || item.url, headline: item.headline, reason, detail });
  };

  const wanted = new Set(request.syllabusSlugs);

  /* -- rule 1: no syllabus hook, no slot. Free, and the highest-value filter. */

  const hooked: GroundedItem[] = [];
  for (const item of items) {
    const hits = item.syllabusSlugs.filter((slug) => wanted.has(slug));
    if (hits.length === 0) {
      drop(item, 'no_syllabus_tag', 'resolves to no syllabus slug the request asked for');
      continue;
    }
    // Tags outside the request are dropped rather than carried: the app resolves
    // these against its own syllabus, and a slug from nowhere is noise there.
    hooked.push({ ...item, syllabusSlugs: hits });
  }

  /* ------------------------------------ rank, then apply the caps greedily */

  // Ranking BEFORE the caps is what makes the single daily event slot go to the
  // best event rather than to whichever one happened to be fetched first.
  const ranked = [...hooked].sort((a, b) => {
    const delta = scoreItem(b, request) - scoreItem(a, request);
    if (delta !== 0) return delta;
    // Stable and deterministic: two runs over the same input must agree.
    return a.canonicalUrl < b.canonicalUrl ? -1 : a.canonicalUrl > b.canonicalUrl ? 1 : 0;
  });

  const seenUrls = new Set(request.seenCanonicalUrls);
  const seenPrints = new Set(request.seenFingerprints);
  const sectionCounts = new Map<string, number>(Object.entries(request.sectionCountsThisWeek));

  const kept: GroundedItem[] = [];
  let events = 0;

  for (const item of ranked) {
    if (kept.length >= request.maxItems) {
      drop(item, 'over_daily_cap', `already at the day's cap of ${request.maxItems}`);
      continue;
    }

    /* ------------------------------------------- rule 2: durable, or the one event */

    if (!DURABLE_KINDS.has(item.kind)) {
      if (events >= MAX_EVENT_ITEMS_PER_DAY) {
        drop(item, 'event_only', 'an event, and the single daily event slot is taken');
        continue;
      }
    }

    /* ----------------------------------------------------- rule 3: not a duplicate */

    const fingerprint = item.headlineFingerprint || headlineFingerprint(item.headline);
    if (seenUrls.has(item.canonicalUrl)) {
      drop(item, 'duplicate', `canonical url already delivered: ${item.canonicalUrl}`);
      continue;
    }
    if (seenPrints.has(fingerprint)) {
      drop(item, 'duplicate', `headline fingerprint already delivered: ${fingerprint}`);
      continue;
    }

    /* ------------------------------------------------ rule 4: section under its cap */

    const sections = item.sectionKeys.length > 0 ? item.sectionKeys : [''];
    const over = sections.find(
      (section) => (sectionCounts.get(section) ?? 0) >= MAX_ITEMS_PER_SECTION_PER_WEEK,
    );
    if (over !== undefined) {
      drop(
        item,
        'over_section_cap',
        `section ${over} already has ${MAX_ITEMS_PER_SECTION_PER_WEEK} items this week`,
      );
      continue;
    }

    /* --------------------------------------------------------------- it earns a slot */

    const { anthro, reason } = sanitiseAnthro(item.anthro);
    if (reason !== null) {
      // The LINK is dropped, not the item. Recorded so the histogram shows a
      // prompt that is over-claiming, which is a fixable bug rather than a
      // mystery about why the Anthropology column is full of nothing.
      drops.push({
        url: item.canonicalUrl || item.url,
        headline: item.headline,
        reason,
        detail: 'anthropology link removed; the item was kept',
      });
    }

    if (!DURABLE_KINDS.has(item.kind)) events += 1;
    seenUrls.add(item.canonicalUrl);
    seenPrints.add(fingerprint);
    for (const section of sections) {
      sectionCounts.set(section, (sectionCounts.get(section) ?? 0) + 1);
    }

    kept.push({ ...item, anthro, headlineFingerprint: fingerprint });
  }

  const linked = kept.filter((item) => item.anthro !== null).length;
  return {
    kept,
    drops,
    anthroLinkRate: kept.length === 0 ? 0 : linked / kept.length,
  };
}

/**
 * True when the Anthropology prompt is claiming a link on too much.
 *
 * Reported rather than corrected. Silently trimming links to hit a ratio would
 * hide the thing worth knowing, which is that the prompt needs work.
 */
export function anthroLinkRateIsSuspicious(rate: number): boolean {
  return rate > MAX_ANTHRO_LINK_RATE;
}

/* ------------------------------------------------------- candidate preparation */

export interface Candidate {
  index: number;
  url: string;
  canonicalUrl: string;
  sourceName: string;
  headline: string;
  lede: string | null;
  publishedAt: string | null;
  feedId: string;
}

/**
 * Trims the raw feed sweep down to what call 1 is allowed to see.
 *
 * Duplicates are removed HERE rather than after the shortlist, because a
 * candidate list carrying the same story three times spends a third of the
 * model's attention deciding between identical options — and then the winner is
 * dropped downstream anyway.
 */
export function prepareCandidates(
  entries: readonly {
    url: string;
    canonicalUrl: string;
    sourceName: string;
    title: string;
    lede: string | null;
    publishedAt: string | null;
    feedId: string;
  }[],
  opts: { seenCanonicalUrls?: readonly string[]; seenFingerprints?: readonly string[]; limit?: number } = {},
): Candidate[] {
  const seenUrls = new Set(opts.seenCanonicalUrls ?? []);
  const seenPrints = new Set(opts.seenFingerprints ?? []);
  const limit = opts.limit ?? MAX_CANDIDATES;

  const out: Candidate[] = [];
  for (const entry of entries) {
    if (out.length >= limit) break;
    if (entry.title.trim() === '') continue;
    if (seenUrls.has(entry.canonicalUrl)) continue;
    const print = headlineFingerprint(entry.title);
    if (print !== '' && seenPrints.has(print)) continue;
    seenUrls.add(entry.canonicalUrl);
    if (print !== '') seenPrints.add(print);
    out.push({
      index: out.length,
      url: entry.url,
      canonicalUrl: entry.canonicalUrl,
      sourceName: entry.sourceName,
      headline: entry.title,
      lede: entry.lede,
      publishedAt: entry.publishedAt,
      feedId: entry.feedId,
    });
  }
  return out;
}
