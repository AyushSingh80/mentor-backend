/**
 * The syllabus vocabulary the server is constrained to, and the resolution of
 * whatever it sends back. Pure — no RN, no expo-sqlite.
 *
 * ## Who owns the taxonomy
 *
 * Phase 3 froze the rule this module exists to honour: the server treats a slug
 * as an OPAQUE key and never infers meaning from its structure. It does not
 * split on hyphens, it does not read a paper prefix, it does not invent a leaf
 * it has not been given. That is not fastidiousness — the syllabus is seed data
 * that ships INSIDE the app and is re-seeded by `lib/syllabus-seed.ts` under
 * rules (rename carry-over, tombstone-never-delete) that only the app knows. A
 * server that derived meaning from slug structure would be a second, silent
 * owner of the same taxonomy, and the two would drift the first time a leaf was
 * renamed.
 *
 * So the direction of travel is: the APP ships the vocabulary on every request,
 * and the server may only tag with keys it was handed.
 *
 * ## Why the vocabulary is sections plus STARTED leaves
 *
 * Sending all ~430 leaves would be a large body to push over mobile data every
 * morning, and most of it would name material she has never opened. Sending
 * only sections would lose the precision that makes a tag worth resolving —
 * "Indian Society" is not a link, it is a shelf.
 *
 * The split below sends both, and the leaf half is biased toward what she is
 * actually working on: ~85 sections, plus the leaves of sections she has
 * STARTED. That lands at roughly 130–210 entries, a few tens of kilobytes, well
 * inside a 64KB body — and it is correctly biased, because a current-affairs
 * item that links to a leaf she read last week is worth far more than one that
 * links to a leaf she reaches in 2027.
 *
 * ## An unknown slug NEVER rejects the item
 *
 * `resolveTags` reports what it could not resolve and resolves nothing else
 * away. `ca-types.ts` states the reason on `TagResolution.unknown` and it is
 * the same reason `mcq-generate-map.ts` accepts an unknown slug: if a key this
 * build has not learned about yet rejected the payload, one syllabus correction
 * on the server would turn into a total outage on the device — an offline
 * failure caused by being online. An untagged item is still a readable item.
 */

import type { TagResolution } from '@/lib/ca-types';
import { PAPERS, type PaperValue } from '@/lib/papers';
import type { TopicStatus } from '@/lib/syllabus-coverage';

/* ------------------------------------------------------------------ inputs */

/**
 * What this module needs to know about a syllabus row.
 *
 * A structural subset of `TopicFact` (plus the optional `subtopic` that
 * `syllabus-coverage.ts` has no use for), so `TopicFact[]` is assignable
 * without a map. Declared here rather than imported wholesale because the
 * fields this module reasons about are exactly these: an id to resolve to, a
 * slug and a section to name, a status to decide "started", and a tombstone.
 */
export interface TagFact {
  id: number;
  slug: string;
  paper: PaperValue;
  /** The printed section heading. The grouping key, exactly as coverage uses. */
  topic: string;
  /** The leaf's own bullet text, when the caller has it. */
  subtopic?: string | null;
  status: TopicStatus;
  retiredAt: string | null;
}

/** Statuses that mean she has actually opened this topic. */
export const STARTED_STATUSES: readonly TopicStatus[] = ['in_progress', 'first_pass', 'revised'];

export function isStarted(status: TopicStatus): boolean {
  return STARTED_STATUSES.includes(status);
}

/* ------------------------------------------------------------- section keys */

/**
 * The separator between a paper and a section heading.
 *
 * `:` and not `-`, and that is load-bearing: leaf slugs are kebab-case and
 * contain no colon, so a section key can never collide with a leaf slug and one
 * flat index can hold both. `coverageBySection` already namespaces its keys the
 * same way, so the two agree by construction rather than by comment.
 */
export const SECTION_KEY_SEPARATOR = ':';

export function sectionKeyOf(paper: string, topic: string): string {
  return `${paper}${SECTION_KEY_SEPARATOR}${topic}`;
}

/* ------------------------------------------------------------- vocabulary */

/**
 * One entry the server may tag with.
 *
 * `label` and `paper` are ADVISORY — they are there so the model can choose
 * sensibly, and the server must not parse either. `slug` is the whole contract.
 */
export interface TagVocabularyEntry {
  slug: string;
  label: string;
  paper: PaperValue;
  /** `'section'` is a shelf; `'leaf'` is a bullet. Advisory, like the label. */
  level: 'section' | 'leaf';
}

export interface TagVocabularyOptions {
  /**
   * Send every live leaf, not just the started ones.
   *
   * Off by default and deliberately not the normal path. It exists for a
   * diagnostic screen ("what could this item have linked to?"), not for the
   * daily digest, where the bias toward started material is the point.
   */
  includeAllLeaves?: boolean;
  /** Hard ceiling on entries. Sections are emitted first and survive trimming. */
  maxEntries?: number;
  /** Hard ceiling on the serialised size. See `VOCABULARY_BUDGET_BYTES`. */
  maxBytes?: number;
}

/**
 * A ceiling that cannot be reached by accident.
 *
 * ~85 sections plus 40–120 started leaves is the expected shape; 600 is roughly
 * every leaf in the syllabus with room to spare. The cap is not tuning, it is a
 * guarantee: a request body's size must not be a function of how much of the
 * syllabus she has opened, or the digest would get slower and more expensive
 * over eighteen months precisely as she made progress.
 */
export const MAX_VOCABULARY_ENTRIES = 600;

/**
 * Serialised budget, with headroom under a 64KB body for everything else the
 * request carries.
 *
 * Counted rather than assumed, because the entries are not fixed-width: a
 * section heading is printed syllabus prose and some of them are long.
 */
export const VOCABULARY_BUDGET_BYTES = 48_000;

/** Rough serialised cost of one entry, keys and punctuation included. */
function entryBytes(entry: TagVocabularyEntry): number {
  // `slug`/`label`/`paper`/`level` keys, quotes, colons, commas and braces come
  // to about 44 characters of JSON furniture. Non-ASCII in a heading costs more
  // bytes than characters, so the multiplier keeps this an over-estimate — the
  // failure direction that matters is under-counting.
  return 44 + Math.ceil((entry.slug.length + entry.label.length + entry.paper.length + 8) * 1.2);
}

/**
 * The keys the server is allowed to tag with.
 *
 * Order is deterministic — papers in the order `PAPERS` declares, sections in
 * first-appearance order within a paper, then leaves in the caller's order —
 * so two runs over the same syllabus produce a byte-identical body. That makes
 * the request diffable and cacheable, and it means a change in the payload is
 * always a change in the syllabus rather than in a Map's iteration order.
 *
 * Sections are emitted before leaves and therefore survive both ceilings: a
 * vocabulary missing a shelf can leave an item with nothing to link to at all,
 * whereas a vocabulary missing a bullet merely links it one level up.
 */
export function tagVocabulary(
  facts: readonly TagFact[],
  opts: TagVocabularyOptions = {},
): TagVocabularyEntry[] {
  const maxEntries = Math.max(0, Math.floor(opts.maxEntries ?? MAX_VOCABULARY_ENTRIES));
  const maxBytes = Math.max(0, Math.floor(opts.maxBytes ?? VOCABULARY_BUDGET_BYTES));

  // Retired topics are excluded here for the same reason `coverageBySection`
  // excludes them from every total: they are no longer examinable, so offering
  // one as a tag would spend a slot linking today's news to dead material.
  const live = facts.filter((fact) => fact.retiredAt === null);

  interface Section {
    key: string;
    paper: PaperValue;
    label: string;
    started: boolean;
    leaves: TagFact[];
  }

  const sections = new Map<string, Section>();

  for (const fact of live) {
    const key = sectionKeyOf(fact.paper, fact.topic);
    let section = sections.get(key);
    if (!section) {
      section = { key, paper: fact.paper, label: fact.topic, started: false, leaves: [] };
      sections.set(key, section);
    }
    section.leaves.push(fact);
    // One started leaf is enough to make the whole section's leaves worth
    // sending. The gate exists to bias the vocabulary toward material she is
    // working on, not to assert the section is finished.
    if (isStarted(fact.status)) section.started = true;
  }

  // Stable sort, so sections keep first-appearance order within a paper — which
  // is the printed syllabus order the repository read them in.
  const ordered = [...sections.values()].sort((a, b) => paperRank(a.paper) - paperRank(b.paper));

  const out: TagVocabularyEntry[] = [];
  let bytes = 2; // the enclosing `[]`

  const push = (entry: TagVocabularyEntry): boolean => {
    if (out.length >= maxEntries) return false;
    const cost = entryBytes(entry);
    if (out.length > 0 && bytes + cost > maxBytes) return false;
    out.push(entry);
    bytes += cost;
    return true;
  };

  // Every section, first. A shelf is always offered.
  for (const section of ordered) {
    push({ slug: section.key, label: section.label, paper: section.paper, level: 'section' });
  }

  // Then the leaves of sections she has started, in the caller's order — which
  // the repository sorts by `position`, the printed syllabus order.
  for (const section of ordered) {
    if (!opts.includeAllLeaves && !section.started) continue;
    for (const leaf of section.leaves) {
      const label = leaf.subtopic ?? section.label;
      if (!push({ slug: leaf.slug, label, paper: leaf.paper, level: 'leaf' })) return out;
    }
  }

  return out;
}

/** Position of a paper in the declared order; unknown papers sort last. */
function paperRank(paper: PaperValue): number {
  const index = PAPERS.findIndex((entry) => entry.value === paper);
  return index === -1 ? PAPERS.length : index;
}

/* ------------------------------------------------------------------ index */

/**
 * Slug — leaf or section — to `syllabus_topics.id`.
 *
 * A section resolves to its ANCHOR leaf: the first live leaf of the section in
 * the caller's order, which the repository guarantees is printed syllabus
 * order. `ca_item_topics.syllabus_topic_id` is a single id, so a section tag
 * has to land on one row; fanning it out across every leaf in the section would
 * write eight rows for one link, make `rank` meaningless, and turn the "which
 * sections have live material" query this table exists for into a count of
 * shelf sizes. The anchor is the same device `mcq-bank.ts` uses for a section's
 * quota line, for the same reason.
 */
export interface TagIndex {
  /** Exact match, tried first. */
  readonly bySlug: ReadonlyMap<string, number>;
  /** Case-folded fallback. See `resolveTags`. */
  readonly byFoldedSlug: ReadonlyMap<string, number>;
  readonly sectionCount: number;
  readonly leafCount: number;
}

function fold(slug: string): string {
  return slug.trim().toLowerCase();
}

export function buildTagIndex(facts: readonly TagFact[]): TagIndex {
  const bySlug = new Map<string, number>();
  const byFoldedSlug = new Map<string, number>();
  let leafCount = 0;
  let sectionCount = 0;

  const remember = (slug: string, id: number) => {
    if (bySlug.has(slug)) return false;
    bySlug.set(slug, id);
    // First writer wins here too, so a case collision cannot make the fallback
    // disagree with the exact map about which id a slug means.
    const folded = fold(slug);
    if (!byFoldedSlug.has(folded)) byFoldedSlug.set(folded, id);
    return true;
  };

  for (const fact of facts) {
    // Retired rows are excluded, matching `db/syllabus.ts#topicIdBySlug`. A
    // second definition of "live" is how two features start disagreeing.
    if (fact.retiredAt !== null) continue;
    if (remember(fact.slug, fact.id)) leafCount += 1;
    // The section anchor: first live leaf wins, so the map is stable across
    // re-seeds that only append leaves.
    if (remember(sectionKeyOf(fact.paper, fact.topic), fact.id)) sectionCount += 1;
  }

  return { bySlug, byFoldedSlug, sectionCount, leafCount };
}

/** An index over nothing. Degrades attribution; never blocks ingestion. */
export const EMPTY_TAG_INDEX: TagIndex = {
  bySlug: new Map<string, number>(),
  byFoldedSlug: new Map<string, number>(),
  sectionCount: 0,
  leafCount: 0,
};

/* --------------------------------------------------------------- resolution */

/**
 * Server-proposed tags to topic ids, in rank order.
 *
 * Rank is the order the server sent them in, deduplicated: the first tag is the
 * primary one and is what drives a kept item's flashcard topic. Duplicates
 * inside one item — two leaves of the same section, or a section and its own
 * anchor leaf — collapse to the first occurrence, because `ca_item_topics` has
 * a unique index on `(item, topic)` and a repeated id would otherwise be a
 * silent insert failure rather than a no-op.
 *
 * NOTHING here rejects. An unresolvable key is reported in `unknown`, the raw
 * string is kept by the caller in `ca_items.syllabus_tags`, and the item is
 * ingested untagged. `ca-types.ts` records why on `TagResolution.unknown`; the
 * short version is that a syllabus correction made while she was online must
 * not be able to empty her feed.
 */
export function resolveTags(rawTags: unknown, index: TagIndex): TagResolution {
  const topicIds: number[] = [];
  const resolved: string[] = [];
  const unknown: string[] = [];

  // Not an array is not an error: an item with no tags is a legitimate item,
  // and `null`, `undefined` and a stray object all mean the same thing here.
  if (!Array.isArray(rawTags)) return { topicIds, resolved, unknown };

  const seenIds = new Set<number>();
  const seenRaw = new Set<string>();

  for (const raw of rawTags) {
    if (typeof raw !== 'string') continue;
    const slug = raw.trim();
    if (slug === '') continue;
    if (seenRaw.has(slug)) continue;
    seenRaw.add(slug);

    // Exact first, then case-folded. The fallback exists because the server is
    // echoing keys this app sent it, and a casing difference introduced by a
    // JSON round trip through a model is a transcription artefact — treating it
    // as vocabulary drift would file a false alarm on the digest summary and
    // lose a link that is plainly correct.
    const id = index.bySlug.get(slug) ?? index.byFoldedSlug.get(fold(slug));

    if (id === undefined) {
      unknown.push(slug);
      continue;
    }

    resolved.push(slug);
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    topicIds.push(id);
  }

  return { topicIds, resolved, unknown };
}
