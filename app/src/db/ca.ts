/**
 * The current-affairs repository.
 *
 * Thin on purpose, exactly as `db/mcq-bank.ts` is: every decision — what may be
 * ingested, which tags resolve, how long a note may be — lives in the pure
 * `lib/ca-map.ts` and `lib/ca-tags.ts` and is unit-tested there. This module
 * reads rows, writes rows, and holds the rules that are properties of SQLite
 * rather than of the domain.
 *
 * ## Rule one: transactions here are SYNCHRONOUS
 *
 * `db.transaction` on the expo-sqlite driver is `"sync"` kind. An `async`
 * callback commits BEFORE any statement inside it has run, so the transaction
 * becomes decorative and each statement autocommits on its own. That defect was
 * found at all five pre-existing call sites and is why every callback below is
 * synchronous with `.run()` / `.get()` / `.all()` on every statement.
 *
 * It matters most in `insertCaItem`. An item and its `ca_item_topics` rows are
 * one fact: an item written without its topic rows is an item that no syllabus
 * screen can find and that no flashcard can inherit a topic from, and it is
 * indistinguishable from an item that genuinely resolved to nothing. Under an
 * `async` callback that is not a hypothetical — the item insert would autocommit
 * and a failure on the topic rows would leave exactly that state.
 *
 * ## Rule two: batch inserts are chunked on PARAMETERS, not on rows
 *
 * SQLite compiles a statement's bound parameters into one list and caps it at
 * 999 on older builds. Which build is on the device is not knowable from here
 * and finding out costs a crash on first launch, so the chunk sizes below are
 * derived from the column count rather than written by hand.
 *
 * ## Where the unknown tags live
 *
 * Nowhere — deliberately. `ca_digests` has no column for them and the schema is
 * frozen, but `ca_items.syllabus_tags` keeps the RAW strings and the schema
 * comment says why: "so a syllabus re-seed can re-resolve tags this build could
 * not". So `readDigestDay` re-resolves the raw tags against the CURRENT index
 * rather than reading a stored list. A stored list would still name yesterday's
 * unknowns the morning after the re-seed that fixed them.
 */

import { and, asc, count, desc, eq, gte, isNull, sql } from 'drizzle-orm';

import { db } from './index';
import { apiUsage, caDigests, caItems, caItemTopics, flashcards, syllabusTopics } from './schema';
import {
  CA_RULES,
  type CaEvidence,
  type DigestDay,
  type DigestSummaryFacts,
  type ItemKind,
  type CaItemFacts,
} from '@/lib/ca-types';
import { readRate } from '@/lib/ca-budget';
import {
  buildTagIndex,
  resolveTags,
  sectionKeyOf,
  type TagFact,
  type TagIndex,
} from '@/lib/ca-tags';
import { storyFingerprint, type IngestableCaItem } from '@/lib/ca-map';
import { isPaperValue } from '@/lib/papers';
import type { TopicStatus } from '@/lib/syllabus-coverage';

/**
 * Re-exported so every current-affairs caller reaches the ONE implementation.
 *
 * It lives in `db/syllabus.ts` because it is a syllabus query rather than a
 * digest one, and a second copy would drift the moment one feature changed what
 * "live" means. `db/mcq-bank.ts` re-exports it for the same reason.
 */
export { topicIdBySlug } from './syllabus';

/** The old SQLite ceiling on bound parameters in one statement. */
const MAX_BOUND_PARAMETERS = 999;

/** Columns bound per `ca_item_topics` row. */
const TOPIC_COLUMNS = 3;

/** At most 100 rows, and never more than the parameter cap allows. */
const TOPIC_CHUNK = Math.min(100, Math.floor(MAX_BOUND_PARAMETERS / TOPIC_COLUMNS));

/**
 * The duplicate window, matching the schema comment on
 * `ca_items.headline_fingerprint`: "14-day duplicate window across outlets and
 * across days of one story."
 *
 * Long enough that a story running all fortnight is caught on day fourteen;
 * short enough that an anniversary piece a year later is allowed to be a new
 * item, which it is.
 */
export const CA_DUPLICATE_WINDOW_DAYS = 14;

const MS_PER_DAY = 86_400_000;

/**
 * The reading budget is not the whole cost.
 *
 * `CA_RULES` is explicit that the reading is not the work — the linking is — and
 * allocates 20 minutes to six 90-word notes of which only ~5 are reading. This
 * multiplier is that ratio, derived from the frozen constants rather than typed
 * in, so a full six-item day estimates at exactly the budget and a short day
 * shrinks honestly instead of pretending three minutes was the cost.
 */
const LINKING_MULTIPLIER =
  CA_RULES.dailyBudgetMinutes /
  ((CA_RULES.dailyItemCap * CA_RULES.maxNoteWords) / CA_RULES.readWordsPerMinute);

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

function daysBefore(day: string, days: number): string {
  const base = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(base)) return day;
  return new Date(base - days * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Parses a JSON column, returning the fallback rather than throwing. */
function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw === null || raw.trim() === '') return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    return (parsed ?? fallback) as T;
  } catch {
    // A column this build cannot parse is a column written by a build that is
    // not this one. Losing a histogram must not lose the digest it describes.
    return fallback;
  }
}

/* ------------------------------------------------------------------ ledger */

export type CaDigestStatus = 'pending' | 'completed' | 'partial' | 'failed';

export type CaDigestTrigger = 'auto' | 'manual' | 'catch_up';

export interface CaDigestRow {
  id: number;
  requestId: string;
  date: string;
  requestedAt: string;
  completedAt: string | null;
  status: string;
  trigger: string;
  model: string | null;
  promptVersion: string | null;
  sourceSetVersion: string | null;
  consideredCount: number | null;
  shortlistedCount: number | null;
  keptCount: number | null;
  droppedCount: number | null;
  dropReasonsJson: string | null;
  sourceFailuresJson: string | null;
  error: string | null;
}

const DIGEST_COLUMNS = {
  id: caDigests.id,
  requestId: caDigests.requestId,
  date: caDigests.date,
  requestedAt: caDigests.requestedAt,
  completedAt: caDigests.completedAt,
  status: caDigests.status,
  trigger: caDigests.trigger,
  model: caDigests.model,
  promptVersion: caDigests.promptVersion,
  sourceSetVersion: caDigests.sourceSetVersion,
  consideredCount: caDigests.consideredCount,
  shortlistedCount: caDigests.shortlistedCount,
  keptCount: caDigests.keptCount,
  droppedCount: caDigests.droppedCount,
  dropReasonsJson: caDigests.dropReasonsJson,
  sourceFailuresJson: caDigests.sourceFailuresJson,
  error: caDigests.error,
} as const;

export async function findDigestForDay(date: string): Promise<CaDigestRow | null> {
  const rows = await db
    .select(DIGEST_COLUMNS)
    .from(caDigests)
    .where(eq(caDigests.date, date))
    .limit(1);
  return rows[0] ?? null;
}

export async function recentDigests(limit = 5): Promise<CaDigestRow[]> {
  return db.select(DIGEST_COLUMNS).from(caDigests).orderBy(desc(caDigests.date)).limit(limit);
}

/**
 * The ledger row, written BEFORE the network call.
 *
 * Phase 1's save-first rule applied to spend rather than to data: a digest that
 * times out after the server has already fetched thirty pages and written six
 * notes must be re-fetchable under the same `requestId`. Without a row written
 * first there is nothing to re-fetch with, and the only recovery is to pay for
 * the same morning twice.
 *
 * `ca_digests.date` is UNIQUE — one digest per day, by design — so a second
 * request for the same day RESUMES rather than throwing. The whole read and
 * write is one synchronous transaction, because a check-then-insert split
 * across two awaits is exactly the race the unique index would then punish
 * with an exception on a code path whose contract is that it does not throw.
 */
export async function openDigest(input: {
  date: string;
  requestId: string;
  trigger: CaDigestTrigger;
}): Promise<{ row: CaDigestRow; created: boolean }> {
  // A mutable holder rather than two `let`s: TypeScript narrows a `let`
  // assigned only inside a callback to its initialiser, so `row` would be typed
  // `null` at the check below and the guard would compile to nothing. Same
  // trick, same reason, as `evaluation.ts` and `mcq-refill.ts`.
  const held: { row: CaDigestRow | null; created: boolean } = {
    row: null,
    created: false,
  };

  db.transaction((tx) => {
    const existing = tx
      .select(DIGEST_COLUMNS)
      .from(caDigests)
      .where(eq(caDigests.date, input.date))
      .limit(1)
      .get();

    if (existing) {
      held.row = existing;
      return;
    }

    const inserted = tx
      .insert(caDigests)
      .values({
        requestId: input.requestId,
        date: input.date,
        trigger: input.trigger,
        status: 'pending',
      })
      .returning(DIGEST_COLUMNS)
      .all();

    held.row = inserted[0] ?? null;
    held.created = held.row !== null;
  });

  if (held.row === null) throw new Error('Failed to open a digest ledger row');
  return { row: held.row, created: held.created };
}

/**
 * Re-opens a row that a previous attempt closed as failed.
 *
 * Only the failed case: a `completed` day is finished and a `pending` one is
 * already open. Without this, one bad morning would permanently consume the
 * day's single ledger slot and she could never retry it — the unique index
 * would see to that.
 */
export async function reopenDigest(
  id: number,
  patch: { requestId: string; trigger: CaDigestTrigger },
): Promise<void> {
  await db
    .update(caDigests)
    .set({
      requestId: patch.requestId,
      trigger: patch.trigger,
      status: 'pending',
      requestedAt: new Date().toISOString(),
      completedAt: null,
      error: null,
    })
    .where(eq(caDigests.id, id));
}

/** What the `meta` frame told us. Written as it arrives, not held to the end. */
export async function recordDigestMeta(
  id: number,
  patch: {
    model: string | null;
    promptVersion: string | null;
    sourceSetVersion: string | null;
  },
): Promise<void> {
  await db
    .update(caDigests)
    .set({
      model: patch.model,
      promptVersion: patch.promptVersion,
      sourceSetVersion: patch.sourceSetVersion,
    })
    .where(eq(caDigests.id, id));
}

export async function finishDigest(
  id: number,
  patch: {
    status: CaDigestStatus;
    consideredCount: number | null;
    shortlistedCount: number | null;
    keptCount: number;
    droppedCount: number | null;
    dropReasonsJson: string | null;
    sourceFailuresJson: string | null;
    error: string | null;
  },
): Promise<void> {
  await db
    .update(caDigests)
    .set({
      status: patch.status,
      consideredCount: patch.consideredCount,
      shortlistedCount: patch.shortlistedCount,
      keptCount: patch.keptCount,
      droppedCount: patch.droppedCount,
      dropReasonsJson: patch.dropReasonsJson,
      sourceFailuresJson: patch.sourceFailuresJson,
      error: patch.error,
      completedAt: new Date().toISOString(),
    })
    .where(eq(caDigests.id, id));
}

/* ------------------------------------------------------------------ insert */

/**
 * Writes one mapped item and its topic links, as ONE transaction.
 *
 * Returns the new `ca_items.id`, or `null` if nothing was written. Called once
 * per streamed `item` frame: a drop at item 4 must leave four items durably on
 * the device, so there is nothing to accumulate and nothing to flush.
 *
 * SYNCHRONOUS callback with `.all()` on every statement. The item and its
 * `ca_item_topics` rows are one fact — see the note at the top of this file —
 * and an `async` callback here would commit the item and then write the topic
 * rows outside any transaction at all.
 */
export async function insertCaItem(
  item: IngestableCaItem,
  digestId: number | null,
): Promise<number | null> {
  // A mutable holder, for the narrowing reason spelled out in `openDigest`.
  const written: { id: number | null } = { id: null };

  db.transaction((tx) => {
    const inserted = tx
      .insert(caItems)
      .values({
        date: item.date,
        publishedAt: item.publishedAt,
        headline: item.headline,
        sourceUrl: item.sourceUrl,
        sourceName: item.sourceName,
        sourceUrlCanonical: item.sourceUrlCanonical,
        itemKind: item.kind,
        // The RAW strings, unresolvable ones included. This is what lets a
        // later syllabus re-seed re-resolve a tag this build could not.
        syllabusTags: JSON.stringify(item.syllabusTags),
        noteMd: item.noteMd,
        evidenceJson: JSON.stringify(item.evidence),
        anthroLink: item.anthroLink,
        anthroP1Slug: item.anthroP1Slug,
        anthroP2Slug: item.anthroP2Slug,
        headlineFingerprint: item.headlineFingerprint,
        digestId,
      })
      .returning({ id: caItems.id })
      .all();

    const id = inserted[0]?.id;
    if (id === undefined) return;

    // Rank is the server's order, which `resolveTags` preserved. The primary
    // tag is what a kept flashcard inherits its topic from, so the order is
    // data rather than presentation.
    const links = item.topicIds.map((syllabusTopicId, rank) => ({
      caItemId: id,
      syllabusTopicId,
      rank,
    }));

    for (const batch of chunk(links, TOPIC_CHUNK)) {
      tx.insert(caItemTopics)
        .values(batch)
        // The unique index on `(item, topic)` makes a repeated id a no-op
        // rather than an exception. `resolveTags` already dedupes, so this is
        // the belt to that braces — and the cost of being wrong is losing the
        // whole item, which is not a trade worth taking.
        .onConflictDoNothing()
        .run();
    }

    written.id = id;
  });

  return written.id;
}

/** Stamps an item as read. The ONLY input to the volume-discipline measure. */
export async function markCaItemRead(
  id: number,
  at: string = new Date().toISOString(),
): Promise<void> {
  await db.update(caItems).set({ readAt: at }).where(eq(caItems.id, id));
}

/**
 * Mirrors the server's `usage` frame into the local ledger.
 *
 * Spend has to be visible offline. The server knows what it charged, but she
 * reads that number on a train, and a figure that needs a network call to
 * display is a figure she never sees when she wants it.
 */
export async function recordCaUsage(input: {
  day: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  estCostUsd: number;
}): Promise<void> {
  await db.insert(apiUsage).values({
    date: dayOf(input.day),
    endpoint: '/ca/digest',
    model: input.model ?? 'unknown',
    inputTokens: Math.max(0, Math.round(input.inputTokens)),
    outputTokens: Math.max(0, Math.round(input.outputTokens)),
    estCostUsd: Number.isFinite(input.estCostUsd) ? input.estCostUsd : 0,
  });
}

/* ---------------------------------------------------------------- syllabus */

const STARTED: readonly string[] = ['in_progress', 'first_pass', 'revised'];

/**
 * Syllabus rows as the tag vocabulary needs them.
 *
 * A direct read rather than `topicFacts()` for one reason: `TopicFact` carries
 * no `subtopic`, and `db/syllabus.ts` is frozen. Without the leaf's own bullet
 * text every leaf in a section would be offered to the server under the same
 * label, which is the difference between "Indian Society — Urbanisation" and
 * eight entries all called "Indian Society". This is NOT a second
 * `topicIdBySlug`; that one is imported and re-exported above.
 */
export async function readTagFacts(): Promise<TagFact[]> {
  const rows = await db
    .select({
      id: syllabusTopics.id,
      slug: syllabusTopics.slug,
      paper: syllabusTopics.paper,
      topic: syllabusTopics.topic,
      subtopic: syllabusTopics.subtopic,
      status: syllabusTopics.status,
      retiredAt: syllabusTopics.retiredAt,
    })
    .from(syllabusTopics)
    .orderBy(asc(syllabusTopics.position), asc(syllabusTopics.id));

  const out: TagFact[] = [];
  for (const row of rows) {
    // A row whose paper this build does not know cannot be rendered under any
    // heading, so it is dropped rather than coerced — the same guard
    // `db/syllabus.ts#isRenderable` applies for the same reason.
    if (!isPaperValue(row.paper)) continue;
    out.push({
      id: row.id,
      slug: row.slug,
      paper: row.paper,
      topic: row.topic,
      subtopic: row.subtopic,
      // An unrecognised status must never become a fifth bucket that no screen
      // counts; here it simply means "not started", so the leaf is not sent.
      status: (STARTED.includes(row.status) ? row.status : 'not_started') as TopicStatus,
      retiredAt: row.retiredAt,
    });
  }
  return out;
}

/* ----------------------------------------------------------------- context */

export interface CaIngestContext {
  /** Every canonical URL held inside the duplicate window. */
  knownCanonicalUrls: string[];
  /**
   * Every headline fingerprint held inside the duplicate window.
   *
   * `ca-map.ts#headlineFingerprint` format — the device's own "do I hold this
   * row?" key, and the only thing `mapDigestItem` compares against.
   */
  knownFingerprints: string[];
  /**
   * The same items in the SERVER's vocabulary: `ca-map.ts#storyFingerprint`.
   *
   * Sent as `seenFingerprints` and used for nothing else. `selectItems`
   * computes its own fingerprint and tests it for membership in this set, so a
   * set built with the device's hash instead can never match — which is what
   * shipped, at the cost of a re-written note and a digest slot per running
   * story per day.
   */
  knownStoryFingerprints: string[];
  /** Syllabus rows, for the vocabulary and the tag index. */
  tagFacts: TagFact[];
  /** The most recent digest attempt of any status. The cooldown is on attempts. */
  lastDigestAt: string | null;
  recentDigests: CaDigestRow[];
  /**
   * Share of recently DELIVERED items she actually opened, or `null`.
   *
   * Sizes the next digest: below `CA_RULES.readRateFloor` the cap drops by one,
   * so a feed she has stopped finishing gets smaller rather than piling up
   * unread. `null` is "no evidence yet" and never shrinks it — see `readRate`,
   * which is careful that the first digest ever delivered cannot score zero.
   */
  recentReadRate: number | null;
  /**
   * Section key to items delivered under it over the trailing week.
   *
   * Counted from RESOLVED topics rather than from the raw `syllabus_tags`
   * text, so an item the server tagged only with leaf slugs still counts
   * against its section. Keyed by `sectionKeyOf`, which is what the vocabulary
   * ships and therefore what the server's cap is keyed on.
   */
  sectionCountsThisWeek: Record<string, number>;
}

/** The server's section-diversity cap is a WEEKLY one. */
export const CA_SECTION_WINDOW_DAYS = 7;

/**
 * Everything the digest run needs, from one read.
 *
 * One function rather than four, for the reason `readBankSnapshot` gives: the
 * duplicate window the mapper tests against and the window the summary reports
 * must be the same window. Two reads a second apart can disagree across an
 * ingest, and "it said it was new and then said it was a duplicate" is the kind
 * of contradiction that makes a feature untrustworthy.
 */
export async function readIngestContext(opts: {
  asOfDay: string;
  windowDays?: number;
}): Promise<CaIngestContext> {
  const windowDays = opts.windowDays ?? CA_DUPLICATE_WINDOW_DAYS;
  const since = daysBefore(opts.asOfDay, windowDays);

  const [urlRows, fingerprintRows, tagFacts, lastRows, recent, readRows, sectionRows] =
    await Promise.all([
      db
        .select({ url: caItems.sourceUrlCanonical })
        .from(caItems)
        .where(and(gte(caItems.date, since), sql`${caItems.sourceUrlCanonical} is not null`)),

      // `headline` as well as the stored key: the server's fingerprint is
      // derived from the headline on demand rather than stored, so a change to
      // its algorithm needs no migration and cannot leave a column
      // half-converted.
      db
        .select({ fingerprint: caItems.headlineFingerprint, headline: caItems.headline })
        .from(caItems)
        .where(and(gte(caItems.date, since), sql`${caItems.headlineFingerprint} <> ''`)),

      readTagFacts(),

      db
        .select({ at: caDigests.requestedAt })
        .from(caDigests)
        .orderBy(desc(caDigests.requestedAt))
        .limit(1),

      recentDigests(5),

      // The read rate's window is `CA_RULES.readRateWindowDays`, which is also 14
      // — the same span as the duplicate window above, so this is one more read
      // over rows already being touched rather than a second pass.
      db
        .select({ date: caItems.date, readAt: caItems.readAt })
        .from(caItems)
        .where(gte(caItems.date, daysBefore(opts.asOfDay, CA_RULES.readRateWindowDays))),

      // Joined rather than counted from `syllabus_tags`: a section key only
      // appears in that column when the server chose to tag at section level,
      // and an item tagged with two leaves of one section must count once
      // against that section, not zero.
      db
        .select({
          paper: syllabusTopics.paper,
          topic: syllabusTopics.topic,
          itemId: caItems.id,
        })
        .from(caItemTopics)
        .innerJoin(caItems, eq(caItemTopics.caItemId, caItems.id))
        .innerJoin(syllabusTopics, eq(caItemTopics.syllabusTopicId, syllabusTopics.id))
        .where(gte(caItems.date, daysBefore(opts.asOfDay, CA_SECTION_WINDOW_DAYS))),
    ]);

  const knownCanonicalUrls: string[] = [];
  for (const row of urlRows)
    if (row.url !== null && row.url !== '') knownCanonicalUrls.push(row.url);

  // An item with two leaves of one section counts ONCE against that section:
  // the cap is "how many items has this shelf already had", and fanning one
  // item out across its own tags would exhaust a section in three days.
  const sectionCountsThisWeek: Record<string, number> = {};
  const countedPerSection = new Set<string>();
  for (const row of sectionRows) {
    if (!isPaperValue(row.paper)) continue;
    const key = sectionKeyOf(row.paper, row.topic);
    const pairKey = `${row.itemId}\u0000${key}`;
    if (countedPerSection.has(pairKey)) continue;
    countedPerSection.add(pairKey);
    sectionCountsThisWeek[key] = (sectionCountsThisWeek[key] ?? 0) + 1;
  }

  return {
    knownCanonicalUrls,
    knownFingerprints: fingerprintRows.map((row) => row.fingerprint),
    // Deduplicated: two cosmetically different headlines for one story share a
    // story fingerprint, and a repeated entry would only pad the request body.
    knownStoryFingerprints: [
      ...new Set(
        fingerprintRows.map((row) => storyFingerprint(row.headline)).filter((fp) => fp !== ''),
      ),
    ],
    tagFacts,
    lastDigestAt: lastRows[0]?.at ?? null,
    recentDigests: recent,
    recentReadRate: readRate(readRows, opts.asOfDay),
    sectionCountsThisWeek,
  };
}

/* -------------------------------------------------------------------- read */

const ITEM_KINDS: readonly string[] = [
  'structural',
  'report',
  'judgment',
  'scheme',
  'data',
  'event',
];

function kindOf(value: string): ItemKind {
  // A kind this build does not know cannot drive the selection rule, and
  // `event` is the conservative reading — it is the kind that earns no slot.
  return (ITEM_KINDS.includes(value) ? value : 'event') as ItemKind;
}

function statusOf(value: string): 'pending' | 'completed' | 'partial' | 'failed' {
  return value === 'completed' || value === 'partial' || value === 'failed' ? value : 'pending';
}

/** Words, counted the way `ca-map.ts` counts them for the budget. */
function wordsIn(note: string): number {
  const trimmed = note.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

/**
 * One day's digest, assembled for a screen.
 *
 * `unknownTags` is RE-RESOLVED here rather than read from a column. That is not
 * a workaround for a missing column — it is better: after a syllabus re-seed
 * teaches this build the slug it did not have, an item that was untagged
 * yesterday resolves today and stops being reported as unknown. A stored list
 * would keep naming it forever.
 */
export async function readDigestDay(date: string, index?: TagIndex): Promise<DigestDay> {
  const [digest, itemRows, topicRows, keptRows, facts] = await Promise.all([
    findDigestForDay(date),

    db
      .select({
        id: caItems.id,
        date: caItems.date,
        publishedAt: caItems.publishedAt,
        headline: caItems.headline,
        sourceName: caItems.sourceName,
        sourceUrl: caItems.sourceUrl,
        itemKind: caItems.itemKind,
        noteMd: caItems.noteMd,
        evidenceJson: caItems.evidenceJson,
        syllabusTags: caItems.syllabusTags,
        anthroLink: caItems.anthroLink,
        anthroP1Slug: caItems.anthroP1Slug,
        anthroP2Slug: caItems.anthroP2Slug,
        readAt: caItems.readAt,
        digestId: caItems.digestId,
      })
      .from(caItems)
      .where(eq(caItems.date, date))
      .orderBy(asc(caItems.id)),

    db
      .select({
        caItemId: caItemTopics.caItemId,
        topicId: caItemTopics.syllabusTopicId,
        rank: caItemTopics.rank,
      })
      .from(caItemTopics)
      .innerJoin(caItems, eq(caItemTopics.caItemId, caItems.id))
      .where(eq(caItems.date, date))
      .orderBy(asc(caItemTopics.rank), asc(caItemTopics.id)),

    db
      .select({ n: count() })
      .from(flashcards)
      .innerJoin(caItems, eq(flashcards.caItemId, caItems.id))
      .where(eq(caItems.date, date)),

    index === undefined ? readTagFacts() : Promise.resolve<TagFact[]>([]),
  ]);

  const tagIndex = index ?? buildTagIndex(facts);

  const topicsByItem = new Map<number, number[]>();
  for (const row of topicRows) {
    const bucket = topicsByItem.get(row.caItemId);
    if (bucket) bucket.push(row.topicId);
    else topicsByItem.set(row.caItemId, [row.topicId]);
  }

  const items: CaItemFacts[] = [];
  const unknownTags = new Set<string>();
  let unread = 0;
  let words = 0;

  for (const row of itemRows) {
    const syllabusTags = parseJson<string[]>(row.syllabusTags, []);
    for (const slug of resolveTags(syllabusTags, tagIndex).unknown) unknownTags.add(slug);

    if (row.readAt === null) {
      unread += 1;
      words += wordsIn(row.noteMd);
    }

    items.push({
      id: row.id,
      date: row.date,
      publishedAt: row.publishedAt,
      headline: row.headline,
      sourceName: row.sourceName,
      sourceUrl: row.sourceUrl,
      kind: kindOf(row.itemKind),
      noteMd: row.noteMd,
      evidence: parseJson<CaEvidence[]>(row.evidenceJson, []),
      syllabusTags,
      topicIds: topicsByItem.get(row.id) ?? [],
      anthroLink: row.anthroLink,
      anthroP1Slug: row.anthroP1Slug,
      anthroP2Slug: row.anthroP2Slug,
      readAt: row.readAt,
      digestId: row.digestId,
    });
  }

  const summary: DigestSummaryFacts | null =
    digest === null
      ? null
      : {
          considered: digest.consideredCount ?? 0,
          kept: digest.keptCount ?? items.length,
          dropped: digest.droppedCount ?? 0,
          dropReasons: parseJson<Record<string, number>>(digest.dropReasonsJson, {}),
          sourceFailures: parseJson<unknown[]>(digest.sourceFailuresJson, []).length,
          unknownTags: [...unknownTags],
        };

  return {
    date,
    items,
    // Reading time, scaled by the budget's own reading-to-linking ratio. Only
    // the UNREAD items: an estimate that never falls as she reads is a number
    // she learns to ignore.
    //
    // Deliberately NOT `ca-budget.ts#estimateReadMinutes`, which answers a
    // different question — see its header. That one is pure reading time over
    // headlines and notes, for checking a digest fits the block; this one is
    // what the block actually costs, which is what a screen should say.
    estimatedMinutes: Math.round((words / CA_RULES.readWordsPerMinute) * LINKING_MULTIPLIER),
    unread,
    keptToday: Number(keptRows[0]?.n) || 0,
    // `'none'` means no digest was ever requested for this day — which is a
    // different and more actionable statement than "it failed".
    status: digest === null ? 'none' : statusOf(digest.status),
    summary,
  };
}

/** Items she has not read, oldest first, inside the catch-up window. */
export async function unreadCaItems(asOfDay: string, days = CA_RULES.catchUpDays): Promise<number> {
  const since = daysBefore(asOfDay, days);
  const rows = await db
    .select({ n: count() })
    .from(caItems)
    .where(and(gte(caItems.date, since), isNull(caItems.readAt)));
  return Number(rows[0]?.n) || 0;
}
