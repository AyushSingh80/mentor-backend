/**
 * The question-bank repository.
 *
 * Thin on purpose: every decision — how deep the bank should be, where the next
 * batch is aimed, whether a top-up is worth a network call — lives in the pure
 * `lib/mcq-bank.ts` and is unit-tested there. This module reads rows, writes
 * rows, and holds the two rules that are properties of SQLite rather than of
 * the domain.
 *
 * ## Rule one: transactions here are SYNCHRONOUS
 *
 * `db.transaction` on the expo-sqlite driver is `"sync"` kind. An `async`
 * callback commits before any statement inside it has run, so the transaction
 * becomes decorative and each statement autocommits on its own. Every callback
 * below is therefore synchronous with `.run()` / `.get()` / `.all()` on every
 * statement — the same rule `db/syllabus.ts` and `db/answers.ts` follow.
 *
 * ## Rule two: batch inserts are chunked on PARAMETERS, not on rows
 *
 * SQLite compiles a statement's bound parameters into one list and caps it at
 * 999 on older builds. `db/syllabus.ts` chunks at 100 rows because its rows
 * bind five columns each — 500 bindings, comfortably clear. A banked question
 * binds thirteen, so copying that 100 would bind 1,300 and fail outright on any
 * build still carrying the old limit. The chunk size below is derived from the
 * column count instead, which is also what keeps it correct when the row grows
 * a column.
 *
 * ## Where `promptVersion` lives
 *
 * `mcq_questions` has no column for it and the schema is frozen. It is written
 * once per batch onto `mcq_bank_refills.plan_json`, and every question carries
 * the `batch_id` that ties back to that row. Purging a bad prompt cohort is
 * therefore: find the refills whose plan names the prompt, take their batch
 * ids, quarantine the questions. One join instead of one column.
 */

import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm';

import { db } from './index';
import { apiUsage, mcqAttempts, mcqBankRefills, mcqQuestions, mcqReviewQueue } from './schema';
import { topicFacts } from './syllabus';
import type { BankInventory, DailyDrillCount, RefillTrigger } from '@/lib/mcq-bank';
import type { BankableQuestion } from '@/lib/mcq-generate-map';
import { PRELIMS_PAPERS, type SectionDemand } from '@/lib/mcq-types';
import { coverageBySection, type TopicFact } from '@/lib/syllabus-coverage';
import type { PaperValue } from '@/lib/papers';

/**
 * Re-exported so Phase 3 callers are untouched. The implementation moved to
 * `db/syllabus.ts` because it is a syllabus query and a second feature now
 * needs it; a copy would drift the moment one of them changed what "live"
 * means.
 */
export { topicIdBySlug } from './syllabus';

/**
 * The old SQLite ceiling on bound parameters in one statement.
 *
 * Current builds allow 32,766, but which build is on the device is not knowable
 * from here and finding out costs a crash on first launch.
 */
const MAX_BOUND_PARAMETERS = 999;

/** Columns bound per banked question, `created_at` included. */
const QUESTION_COLUMNS = 13;

/**
 * At most 100 rows, and never more than the parameter cap allows — 76 today.
 *
 * 100 x 13 is 1,300 bindings, so a row limit alone would sit the wrong side of
 * the cliff this constant exists to stay clear of.
 */
const INSERT_CHUNK = Math.min(100, Math.floor(MAX_BOUND_PARAMETERS / QUESTION_COLUMNS));

/** `inArray` binds one parameter per id, so ids chunk against the cap directly. */
const ID_CHUNK = 200;

/**
 * How far back per-section error rates look.
 *
 * Long enough to accumulate a usable count on a section she drills twice a
 * week; short enough that a section she has since learned stops being flagged
 * as weak forever on the strength of a bad fortnight in month one.
 */
const ERROR_WINDOW_DAYS = 90;

/** Statuses that mean "she has actually opened this topic". */
const STARTED_STATUSES: readonly string[] = ['in_progress', 'first_pass', 'revised'];

const MS_PER_DAY = 86_400_000;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

function isoDaysAgo(now: string, days: number): string {
  const base = Date.parse(now);
  if (!Number.isFinite(base)) return new Date(Date.now() - days * MS_PER_DAY).toISOString();
  return new Date(base - days * MS_PER_DAY).toISOString();
}

/**
 * "Not quarantined", as a SQL fragment.
 *
 * `QUARANTINE_RULE` in `mcq-types.ts` states the predicate once so both
 * repositories implement the same one; this is its negation. A quarantined
 * question must appear in NO inventory count — she reported it as wrong, and a
 * bank that keeps counting it as supply keeps promising questions it will never
 * deal.
 */
const NOT_QUARANTINED = sql`(${mcqQuestions.disputedAt} is null or ${mcqQuestions.disputeResolvedAt} is not null)`;

/** No attempt has ever been recorded against this question. */
const UNSEEN = sql`not exists (select 1 from ${mcqAttempts} where ${mcqAttempts.questionId} = ${mcqQuestions.id})`;

/* ------------------------------------------------------------------ ledger */

export interface RefillRow {
  id: number;
  requestId: string;
  requestedAt: string;
  completedAt: string | null;
  status: string;
  trigger: string;
  requestedCount: number;
  receivedCount: number | null;
  acceptedCount: number | null;
  batchId: string | null;
  error: string | null;
}

const REFILL_COLUMNS = {
  id: mcqBankRefills.id,
  requestId: mcqBankRefills.requestId,
  requestedAt: mcqBankRefills.requestedAt,
  completedAt: mcqBankRefills.completedAt,
  status: mcqBankRefills.status,
  trigger: mcqBankRefills.trigger,
  requestedCount: mcqBankRefills.requestedCount,
  receivedCount: mcqBankRefills.receivedCount,
  acceptedCount: mcqBankRefills.acceptedCount,
  batchId: mcqBankRefills.batchId,
  error: mcqBankRefills.error,
} as const;

/**
 * The ledger row, written BEFORE the network call.
 *
 * This is Phase 1's save-first rule applied to spend rather than to data. A
 * refill that times out after the server has already generated and billed for
 * thirty questions must be re-fetchable under the same `requestId` — without a
 * row written first there is nothing to re-fetch with, and the only recovery is
 * to pay for the same thirty questions again.
 */
export async function startRefill(input: {
  requestId: string;
  trigger: RefillTrigger;
  requestedCount: number;
  planJson: string;
}): Promise<number> {
  const [row] = await db
    .insert(mcqBankRefills)
    .values({
      requestId: input.requestId,
      trigger: input.trigger,
      requestedCount: input.requestedCount,
      status: 'pending',
      planJson: input.planJson,
    })
    .returning({ id: mcqBankRefills.id });

  if (!row) throw new Error('Failed to open a refill ledger row');
  return row.id;
}

/**
 * Restates what an already-open ledger row is asking for.
 *
 * Used only on the resume path. The row was written before the first attempt
 * and its `requestId` is the idempotency key the server may still honour, but
 * the plan is recomputed at each attempt — the board moves. Without this the
 * ledger would describe the first plan while the device sent the second, and
 * "why is this bank aimed at Modern History?" would have the wrong answer
 * stored against it.
 */
export async function restateRefill(
  id: number,
  patch: { requestedCount: number; planJson: string },
): Promise<void> {
  await db
    .update(mcqBankRefills)
    .set({ requestedCount: patch.requestedCount, planJson: patch.planJson })
    .where(eq(mcqBankRefills.id, id));
}

export async function finishRefill(
  id: number,
  patch: {
    status: 'completed' | 'partial' | 'failed';
    receivedCount: number;
    acceptedCount: number;
    batchId: string | null;
    error: string | null;
  },
): Promise<void> {
  await db
    .update(mcqBankRefills)
    .set({
      status: patch.status,
      receivedCount: patch.receivedCount,
      acceptedCount: patch.acceptedCount,
      batchId: patch.batchId,
      error: patch.error,
      completedAt: new Date().toISOString(),
    })
    .where(eq(mcqBankRefills.id, id));
}

/**
 * A refill that was opened and never closed, recent enough that the server may
 * still hold its result.
 *
 * Re-issuing the same `requestId` is what turns a timeout into a re-fetch. Past
 * the window it is not worth trying: the server has moved on and a resume would
 * just be a slower way to start a new batch.
 */
export async function findResumableRefill(withinMinutes = 30): Promise<RefillRow | null> {
  const since = isoDaysAgo(new Date().toISOString(), withinMinutes / (24 * 60));
  const rows = await db
    .select(REFILL_COLUMNS)
    .from(mcqBankRefills)
    .where(and(eq(mcqBankRefills.status, 'pending'), gte(mcqBankRefills.requestedAt, since)))
    .orderBy(desc(mcqBankRefills.requestedAt))
    .limit(1);

  return rows[0] ?? null;
}

export async function recentRefills(limit = 5): Promise<RefillRow[]> {
  return db
    .select(REFILL_COLUMNS)
    .from(mcqBankRefills)
    .orderBy(desc(mcqBankRefills.requestedAt))
    .limit(limit);
}

/* ------------------------------------------------------------------ insert */

/**
 * Banks a batch, skipping anything the server has already given us.
 *
 * Returns the number of rows that were actually written. `onConflictDoNothing`
 * on `external_id` is what makes a resumed request safe: re-fetching a batch
 * the device partly received re-delivers questions it already holds, and those
 * must be silently skipped rather than duplicated or raised.
 *
 * Called once per streamed question on the live path — the batch form exists
 * for a resumed re-fetch, and for the chunking rule to have somewhere to live.
 */
export async function bankQuestions(rows: readonly BankableQuestion[]): Promise<number> {
  if (rows.length === 0) return 0;

  let inserted = 0;

  // Synchronous callback, `.all()` on every statement — see the note at the top
  // of the file. One transaction across the chunks so a mid-batch failure banks
  // nothing rather than a prefix nobody can tell apart from a short batch.
  db.transaction((tx) => {
    for (const batch of chunk(rows, INSERT_CHUNK)) {
      const written = tx
        .insert(mcqQuestions)
        .values(
          batch.map((row) => ({
            syllabusTopicId: row.syllabusTopicId,
            stem: row.stem,
            optionsJson: JSON.stringify(row.options),
            correctIndex: row.correctIndex,
            eliminationLogic: row.eliminationLogic,
            difficulty: row.difficulty,
            source: row.source,
            pyqYear: row.pyqYear,
            pyqPaper: row.pyqPaper,
            batchId: row.batchId,
            externalId: row.externalId,
            stemFingerprint: row.stemFingerprint,
          })),
        )
        .onConflictDoNothing({ target: mcqQuestions.externalId })
        .returning({ id: mcqQuestions.id })
        .all();

      inserted += written.length;
    }
  });

  return inserted;
}

/**
 * Mirrors the server's `usage` frame into the local ledger.
 *
 * Spend has to be visible offline. The server knows what it charged, but she
 * reads that number on a train, and a figure that needs a network call to
 * display is a figure she never sees when she wants it.
 */
export async function recordApiUsage(input: {
  day: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  estCostUsd: number;
}): Promise<void> {
  await db.insert(apiUsage).values({
    date: dayOf(input.day),
    endpoint: '/mcq/generate',
    model: input.model ?? 'unknown',
    inputTokens: Math.max(0, Math.round(input.inputTokens)),
    outputTokens: Math.max(0, Math.round(input.outputTokens)),
    estCostUsd: Number.isFinite(input.estCostUsd) ? input.estCostUsd : 0,
  });
}

/* ---------------------------------------------------------------- snapshot */

export interface BankSnapshot {
  inventory: BankInventory;
  sections: SectionDemand[];
  drillCounts: DailyDrillCount[];
  /** Every fingerprint held, for duplicate suppression and the exclude list. */
  knownFingerprints: string[];
  /** The last ATTEMPT, successful or not. The cooldown is on attempts. */
  lastRefillAttemptAt: string | null;
  recentRefills: RefillRow[];
}

function sectionKeyOf(fact: TopicFact): string {
  return `${fact.paper}:${fact.topic}`;
}

/**
 * Everything the planner, the trigger and the launcher card need, from one
 * read.
 *
 * Deliberately one function rather than five: the runway shown on screen and
 * the runway the trigger tests must be the same number. Two reads a second
 * apart can disagree across a finished drill, and "it said four days and then
 * refused to top up" is the kind of contradiction that makes the whole feature
 * untrustworthy.
 */
export async function readBankSnapshot(opts: {
  /** Local calendar day, `YYYY-MM-DD`. */
  asOfDay: string;
  /** ISO instant. Injectable so tests are not clock-dependent. */
  now?: string;
}): Promise<BankSnapshot> {
  const now = opts.now ?? new Date().toISOString();
  const errorWindowStart = isoDaysAgo(now, ERROR_WINDOW_DAYS);
  const demandWindowStart = isoDaysAgo(now, 14);

  const [
    facts,
    stockRows,
    attemptRows,
    totals,
    quarantinedRows,
    redrillRows,
    drillRows,
    fingerprintRows,
    lastAttemptRows,
    successfulRows,
    refills,
  ] = await Promise.all([
    topicFacts(),

    // Unseen, un-quarantined stock per topic.
    db
      .select({ topicId: mcqQuestions.syllabusTopicId, n: count() })
      .from(mcqQuestions)
      .where(and(NOT_QUARANTINED, UNSEEN))
      .groupBy(mcqQuestions.syllabusTopicId),

    // Attempt history per topic, inside the error window.
    db
      .select({
        topicId: mcqQuestions.syllabusTopicId,
        attempted: count(),
        wrong: sql<number>`sum(case when ${mcqAttempts.correct} = 0 then 1 else 0 end)`,
        lastAt: sql<string | null>`max(${mcqAttempts.attemptedAt})`,
      })
      .from(mcqAttempts)
      .innerJoin(mcqQuestions, eq(mcqAttempts.questionId, mcqQuestions.id))
      .where(gte(mcqAttempts.attemptedAt, errorWindowStart))
      .groupBy(mcqQuestions.syllabusTopicId),

    db.select({ n: count() }).from(mcqQuestions),

    db
      .select({ n: count() })
      .from(mcqQuestions)
      .where(and(isNotNull(mcqQuestions.disputedAt), isNull(mcqQuestions.disputeResolvedAt))),

    // Redrills due. Reported, never counted as runway: a question she has
    // already answered is revision, not new material.
    //
    // Compared by DATE PREFIX against the local calendar day, not against a
    // real instant. `dueAt` is a calendar-day label wearing UTC clothing —
    // `sm2.ts` anchors the local day at UTC midnight for arithmetic only — so
    // `dueAt <= now` is comparing a label to an instant. In Asia/Kolkata that
    // is wrong for the 5.5 hours between local midnight and UTC midnight,
    // EVERY day: at 02:00 IST the selection ladder deals a redrill (it uses
    // `isDue`, which compares prefixes) while this count says there are none.
    // She is then served questions the dashboard told her she did not have,
    // which is precisely the kind of contradiction that stops her trusting the
    // numbers. Same comparison as `sm2.isDue`, so the two cannot diverge again.
    db
      .select({ n: count() })
      .from(mcqReviewQueue)
      .innerJoin(mcqQuestions, eq(mcqReviewQueue.questionId, mcqQuestions.id))
      .where(
        and(sql`substr(${mcqReviewQueue.dueAt}, 1, 10) <= ${opts.asOfDay}`, NOT_QUARANTINED),
      ),

    // Questions per calendar day. Days with no drill are absent here and are
    // filled in as real zeros by `dailyDemand` — which is the whole reason it
    // uses p75 rather than a mean.
    db
      .select({
        day: sql<string>`substr(${mcqAttempts.attemptedAt}, 1, 10)`,
        n: count(),
      })
      .from(mcqAttempts)
      .where(gte(mcqAttempts.attemptedAt, demandWindowStart))
      .groupBy(sql`substr(${mcqAttempts.attemptedAt}, 1, 10)`),

    db
      .select({ fingerprint: mcqQuestions.stemFingerprint })
      .from(mcqQuestions)
      .where(sql`${mcqQuestions.stemFingerprint} <> ''`),

    db
      .select({ at: mcqBankRefills.requestedAt })
      .from(mcqBankRefills)
      .orderBy(desc(mcqBankRefills.requestedAt))
      .limit(1),

    // "Successful" means questions actually landed. A refill that completed its
    // stream and banked nothing is not a top-up, and reporting it as one is the
    // specific lie this card exists to avoid.
    db
      .select({ at: mcqBankRefills.completedAt })
      .from(mcqBankRefills)
      .where(sql`${mcqBankRefills.acceptedCount} > 0 and ${mcqBankRefills.completedAt} is not null`)
      .orderBy(desc(mcqBankRefills.completedAt))
      .limit(1),

    recentRefills(5),
  ]);

  /* ------------------------------------------------------ fold into sections */

  const live = facts.filter((fact) => fact.retiredAt === null);

  const coverageByKey = new Map<string, number>();
  for (const paper of PRELIMS_PAPERS) {
    for (const row of coverageBySection(facts, paper as PaperValue)) {
      coverageByKey.set(row.key, row.percentFirstPass);
    }
  }

  interface Bucket {
    sectionKey: string;
    paper: string;
    label: string;
    slugs: string[];
    eligible: boolean;
    attempted: number;
    wrong: number;
    unseenStock: number;
    lastDrilledAt: string | null;
  }

  const buckets = new Map<string, Bucket>();
  const bucketOfTopic = new Map<number, Bucket>();

  for (const fact of live) {
    if (!(PRELIMS_PAPERS as readonly string[]).includes(fact.paper)) continue;

    const key = sectionKeyOf(fact);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        sectionKey: key,
        paper: fact.paper,
        label: fact.topic,
        slugs: [],
        eligible: false,
        attempted: 0,
        wrong: 0,
        unseenStock: 0,
        lastDrilledAt: null,
      };
      buckets.set(key, bucket);
    }

    bucket.slugs.push(fact.slug);
    // One started topic is enough. The gate exists to keep her off material she
    // has never read; it is not a claim that the whole section is covered.
    if (STARTED_STATUSES.includes(fact.status)) bucket.eligible = true;
    bucketOfTopic.set(fact.id, bucket);
  }

  let unseenUnattributed = 0;
  let unseenEligible = 0;

  for (const row of stockRows) {
    const n = Number(row.n) || 0;
    if (row.topicId === null) {
      // A question whose slug this build's syllabus does not know yet. It is
      // still perfectly drillable, so it counts toward runway — refusing to
      // would let one server-side syllabus revision report an empty bank while
      // the bank is full, which is the outage `mcq-generate-map` exists to
      // prevent on the way in.
      unseenUnattributed += n;
      continue;
    }
    const bucket = bucketOfTopic.get(row.topicId);
    if (!bucket) continue;
    bucket.unseenStock += n;
  }

  for (const row of attemptRows) {
    if (row.topicId === null) continue;
    const bucket = bucketOfTopic.get(row.topicId);
    if (!bucket) continue;
    bucket.attempted += Number(row.attempted) || 0;
    bucket.wrong += Number(row.wrong) || 0;
    if (row.lastAt !== null && (bucket.lastDrilledAt === null || row.lastAt > bucket.lastDrilledAt)) {
      bucket.lastDrilledAt = row.lastAt;
    }
  }

  const sections: SectionDemand[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.eligible) unseenEligible += bucket.unseenStock;
    sections.push({
      sectionKey: bucket.sectionKey,
      syllabusSlugs: bucket.slugs,
      paper: bucket.paper,
      label: bucket.label,
      eligible: bucket.eligible,
      percentFirstPass: coverageByKey.get(bucket.sectionKey) ?? 0,
      attempted: bucket.attempted,
      wrong: bucket.wrong,
      unseenStock: bucket.unseenStock,
      lastDrilledDay: bucket.lastDrilledAt === null ? null : dayOf(bucket.lastDrilledAt),
    });
  }

  sections.sort((a, b) => a.sectionKey.localeCompare(b.sectionKey));

  return {
    inventory: {
      unseenEligible: unseenEligible + unseenUnattributed,
      totalBanked: Number(totals[0]?.n) || 0,
      quarantined: Number(quarantinedRows[0]?.n) || 0,
      redrillDueToday: Number(redrillRows[0]?.n) || 0,
      lastSuccessfulRefillAt: successfulRows[0]?.at ?? null,
    },
    sections,
    drillCounts: drillRows.map((row) => ({ day: row.day, count: Number(row.n) || 0 })),
    knownFingerprints: fingerprintRows.map((row) => row.fingerprint),
    lastRefillAttemptAt: lastAttemptRows[0]?.at ?? null,
    recentRefills: refills,
  };
}

/**
 * `syllabus_topics.slug` -> id, for attributing a generated question.
 *
 * Read separately from the snapshot because it is only needed while a stream is
 * open, and it is the one map that must be current at that moment rather than
 * at planning time.
 */

/**
 * Questions whose prompt cohort turned out bad, quarantined as a unit.
 *
 * The retroactive purge handle. A bad generation run is a systemic failure, not
 * N independent bad questions, so it is quarantined rather than deleted: the
 * attempts she has already made against those questions are history and must
 * survive, and `mcq_attempts` cascades on delete.
 */
export async function quarantineBatches(
  batchIds: readonly string[],
  note: string,
): Promise<number> {
  if (batchIds.length === 0) return 0;

  const now = new Date().toISOString();
  let touched = 0;

  db.transaction((tx) => {
    for (const batch of chunk(batchIds, ID_CHUNK)) {
      const rows = tx
        .update(mcqQuestions)
        .set({ disputedAt: now, disputeReason: 'outdated', disputeNote: note })
        .where(and(inArray(mcqQuestions.batchId, batch), isNull(mcqQuestions.disputedAt)))
        .returning({ id: mcqQuestions.id })
        .all();
      touched += rows.length;
    }
  });

  return touched;
}

/** Refill ledger rows, oldest first, for a diagnostics screen. */
export async function refillHistory(limit = 50): Promise<RefillRow[]> {
  return db
    .select(REFILL_COLUMNS)
    .from(mcqBankRefills)
    .orderBy(asc(mcqBankRefills.requestedAt))
    .limit(limit);
}
