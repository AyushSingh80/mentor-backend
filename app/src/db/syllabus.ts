/**
 * Syllabus repository.
 *
 * Thin by design: `planSeed` in `lib/syllabus-seed.ts` decides everything and
 * is pure; this module only reads rows, executes the plan in one transaction,
 * and maps rows to `TopicFact`.
 */

import { asc, eq, inArray } from 'drizzle-orm';

import { db } from './index';
import { syllabusTopics } from './schema';
import { SYLLABUS_V1 } from '@/data/syllabus-v1';
import { planSeed, type ExistingTopic, type SeedPlan } from '@/lib/syllabus-seed';
import type { TopicFact, TopicStatus } from '@/lib/syllabus-coverage';
import { isPaperValue, type PaperValue } from '@/lib/papers';

/**
 * SQLite compiles a statement's bound parameters into one list, and older
 * builds cap that list at 999. A 438-row insert with five columns each would
 * bind 2,190 and fail at exactly the moment the app first launches. Chunking is
 * cheaper than finding out which build is on the device.
 */
const INSERT_CHUNK = 100;
const ID_CHUNK = 200;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const STATUSES: readonly string[] = ['not_started', 'in_progress', 'first_pass', 'revised'];

/**
 * `status` is a free-text column, so a value the app does not know is possible
 * in principle. Falling back to `not_started` keeps coverage arithmetic total —
 * an unrecognised status must never silently become a fifth bucket that no
 * screen counts.
 */
function toStatus(value: string): TopicStatus {
  return STATUSES.includes(value) ? (value as TopicStatus) : 'not_started';
}

/** 1–5, or null. A standing self-report, never an SM-2 grade. */
function cleanConfidence(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) return null;
  return Math.min(5, Math.max(1, Math.round(value)));
}

function planIsEmpty(plan: SeedPlan): boolean {
  return (
    plan.insert.length === 0 &&
    plan.update.length === 0 &&
    plan.tombstone.length === 0 &&
    plan.revive.length === 0 &&
    plan.carryOver.length === 0
  );
}

/**
 * Called once from the root layout after migrations succeed and before the
 * onboarding gate. Must be idempotent: on a steady-state launch it performs
 * zero writes and returns an empty plan, so it does not churn every live query
 * in the app on every cold start.
 */
export async function ensureSyllabusSeeded(): Promise<SeedPlan> {
  const existing: ExistingTopic[] = await db
    .select({
      id: syllabusTopics.id,
      slug: syllabusTopics.slug,
      paper: syllabusTopics.paper,
      topic: syllabusTopics.topic,
      subtopic: syllabusTopics.subtopic,
      position: syllabusTopics.position,
      status: syllabusTopics.status,
      confidence: syllabusTopics.confidence,
      firstPassAt: syllabusTopics.firstPassAt,
      revisedAt: syllabusTopics.revisedAt,
      retiredAt: syllabusTopics.retiredAt,
    })
    .from(syllabusTopics);

  const plan = planSeed(existing, SYLLABUS_V1);

  // The steady-state path, which is almost every launch. Opening a transaction
  // that writes nothing would still fire `enableChangeListener` and re-run every
  // `useLiveQuery` in the app on every cold start.
  if (planIsEmpty(plan)) return plan;

  // The pre-transaction snapshot is what a carry-over reads from. Taking the
  // values from here rather than re-reading mid-transaction means a chained
  // rename can never read a row this same transaction has already rewritten.
  const byId = new Map(existing.map((row) => [row.id, row] as const));
  const now = new Date().toISOString();

  // One transaction: a half-applied plan would leave rows retired whose status
  // was never carried across, which is the data loss this module exists to
  // prevent. If anything throws, nothing happened and the next launch re-plans.
  // SYNCHRONOUS callback, `.run()` on every statement — see the note in
  // `profile.ts`. On this "sync" driver an `async` callback commits before any
  // statement executes, so the five phases below would each autocommit
  // independently: a throw at carry-over would leave rows already tombstoned
  // whose status was never carried across. That is precisely the data loss this
  // module exists to prevent.
  db.transaction((tx) => {
    // 1. Insert first, so a rename target exists before anything is carried onto it.
    for (const batch of chunk(plan.insert, INSERT_CHUNK)) {
      tx.insert(syllabusTopics)
        .values(
          batch.map((entry) => ({
            slug: entry.slug,
            paper: entry.paper,
            topic: entry.topic,
            subtopic: entry.subtopic,
            position: entry.position,
            // Everything else takes its schema default. A new row is untouched.
          })),
        )
        .run();
    }

    // 2. Display fields only. Naming `status`, `confidence`, `firstPassAt` or
    //    `revisedAt` in this `set` is the bug this whole design exists to make
    //    impossible — `plan.update` carries a `SyllabusSeedEntry`, which has no
    //    such fields to name.
    for (const { id, entry } of plan.update) {
      tx.update(syllabusTopics)
        .set({
          paper: entry.paper,
          topic: entry.topic,
          subtopic: entry.subtopic,
          position: entry.position,
        })
        .where(eq(syllabusTopics.id, id))
        .run();
    }

    // 3. Carry self-assessment across a rename, keyed on the new slug.
    for (const { fromId, toSlug } of plan.carryOver) {
      const source = byId.get(fromId);
      if (!source) continue;
      tx.update(syllabusTopics)
        .set({
          status: source.status,
          confidence: source.confidence,
          firstPassAt: source.firstPassAt,
          revisedAt: source.revisedAt,
        })
        .where(eq(syllabusTopics.slug, toSlug))
        .run();
    }

    // 4. A topic dropped by one revision and restored by the next comes back
    //    whole, because the row was retired rather than deleted.
    for (const batch of chunk(plan.revive, ID_CHUNK)) {
      tx.update(syllabusTopics)
        .set({ retiredAt: null })
        .where(inArray(syllabusTopics.id, batch))
        .run();
    }

    // 5. Retire, never DELETE. A delete cascades the topic's `revision_queue`
    //    row away — destroying its review history — and NULLs
    //    `syllabus_topic_id` on every lecture and evaluated answer.
    for (const batch of chunk(plan.tombstone, ID_CHUNK)) {
      tx.update(syllabusTopics)
        .set({ retiredAt: now })
        .where(inArray(syllabusTopics.id, batch))
        .run();
    }
  });

  return plan;
}

/**
 * Every topic, retired ones included. The coverage functions own the decision
 * to exclude them, and they need `retiredAt` in hand to make it — filtering
 * here would hide the rows from the one module written to reason about them.
 */
export async function topicFacts(): Promise<TopicFact[]> {
  const rows = await db
    .select({
      id: syllabusTopics.id,
      slug: syllabusTopics.slug,
      paper: syllabusTopics.paper,
      topic: syllabusTopics.topic,
      subtopic: syllabusTopics.subtopic,
      status: syllabusTopics.status,
      confidence: syllabusTopics.confidence,
      firstPassAt: syllabusTopics.firstPassAt,
      retiredAt: syllabusTopics.retiredAt,
    })
    .from(syllabusTopics)
    .orderBy(asc(syllabusTopics.position), asc(syllabusTopics.id));

  return rows.filter(isRenderable).map((row) => ({ ...row, status: toStatus(row.status) }));
}

/**
 * A row whose paper is not one this build knows about cannot be shown on any
 * screen or counted under any heading, so it is dropped rather than coerced.
 * `SYLLABUS_V1` is the only writer and its papers are typed, so this is a guard
 * against a downgraded build, not an expected case.
 */
function isRenderable<T extends { paper: string }>(row: T): row is T & { paper: PaperValue } {
  return isPaperValue(row.paper);
}

/**
 * One paper's live topics, in printed syllabus order.
 *
 * Retired topics are excluded: they are no longer examinable and there is no
 * affordance for working on one. Their status stays on the row, so restoring
 * the topic in a later revision restores her assessment with it.
 */
export async function listTopics(paper: PaperValue): Promise<TopicFact[]> {
  const rows = await db
    .select({
      id: syllabusTopics.id,
      slug: syllabusTopics.slug,
      paper: syllabusTopics.paper,
      topic: syllabusTopics.topic,
      subtopic: syllabusTopics.subtopic,
      status: syllabusTopics.status,
      confidence: syllabusTopics.confidence,
      firstPassAt: syllabusTopics.firstPassAt,
      retiredAt: syllabusTopics.retiredAt,
    })
    .from(syllabusTopics)
    .where(eq(syllabusTopics.paper, paper))
    .orderBy(asc(syllabusTopics.position), asc(syllabusTopics.id));

  return rows
    .filter((row) => row.retiredAt === null)
    .filter(isRenderable)
    .map((row) => ({ ...row, status: toStatus(row.status) }));
}

/**
 * `confidence` is a standing self-report on a 1–5 scale, and is NOT the SM-2
 * recall grade. Never derive one from the other.
 *
 * Omitting the argument leaves confidence untouched; passing `null` clears it.
 * The two are different intentions and the optional parameter keeps them apart:
 * changing a status must not silently discard a rating she set last month.
 */
export async function setTopicStatus(
  id: number,
  status: TopicStatus,
  confidence?: number | null,
): Promise<void> {
  // Synchronous callback with `.get()`/`.run()` — see the note in
  // `ensureSyllabusSeeded`. The read-then-write here has to see a consistent
  // row, and an `async` callback gives no transaction at all on this driver.
  db.transaction((tx) => {
    const row = tx
      .select({
        firstPassAt: syllabusTopics.firstPassAt,
        revisedAt: syllabusTopics.revisedAt,
      })
      .from(syllabusTopics)
      .where(eq(syllabusTopics.id, id))
      .limit(1)
      .get();

    if (!row) return;

    const now = new Date().toISOString();
    const passed = status === 'first_pass' || status === 'revised';

    tx.update(syllabusTopics)
      .set({
        status,
        // Stamped once, on the first crossing, and never rewritten. It is the
        // sole evidence `projectFirstPass` measures the rate from, so moving it
        // forward on a later edit would silently redate months of progress.
        // Demotion keeps the stamp too — she did pass it once, and that is
        // history rather than a claim about the present.
        firstPassAt: passed && row.firstPassAt === null ? now : row.firstPassAt,
        revisedAt: status === 'revised' ? now : row.revisedAt,
        // Absent means "leave it alone", not "clear it".
        ...(confidence === undefined ? {} : { confidence: cleanConfidence(confidence) }),
      })
      .where(eq(syllabusTopics.id, id))
      // `.run()` is not optional. Drizzle builders are LAZY: without it the
      // statement is constructed and discarded, the synchronous transaction
      // commits nothing, the promise resolves, and the optimistic UI shows a
      // change that was never written. Found on a device — every syllabus
      // status tap rendered correctly and was gone on the next launch.
      .run();
  });
}

/**
 * Live topic ids by slug.
 *
 * Lives here rather than in a feature repository because it is a syllabus
 * query, not a bank or digest one — and two features now need it. A second
 * copy would drift the moment one of them started including retired topics.
 */
export async function topicIdBySlug(): Promise<Map<string, number>> {
  const facts = await topicFacts();
  const map = new Map<string, number>();
  for (const fact of facts) {
    if (fact.retiredAt !== null) continue;
    map.set(fact.slug, fact.id);
  }
  return map;
}
