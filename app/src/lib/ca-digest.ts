/**
 * Digest orchestration — the seam between the feed and the server.
 *
 * Behavioural contract, deliberately the same shape as `lib/evaluation.ts` and
 * `lib/mcq-refill.ts`, because all three are the same problem with different
 * nouns:
 *
 * 1. `runDailyDigest` NEVER rejects. Every failure path returns a
 *    `DigestOutcome` describing what happened, so a fire-and-forget caller
 *    needs no try/catch and a screen needs no error boundary.
 * 2. The `ca_digests` row is written FIRST, before any network call, carrying
 *    the `requestId`. Phase 1's save-first rule applied to spend: a digest that
 *    times out after the server has fetched thirty pages and written six notes
 *    must be re-fetchable under the same id, not re-generated.
 * 3. Every `item` frame is ingested AS IT ARRIVES. A drop at item 4 leaves four
 *    items on the device, not zero — and unlike a question, an item is a fact
 *    about a particular day that tomorrow's run will not reproduce.
 * 4. A SHORT DIGEST IS A SUCCESS. Four items on a quiet Tuesday is a correct
 *    outcome. There is no retry loop on a shortfall and there must not be one:
 *    `CA_RULES.dailyItemCap` is a ceiling on her reading time, never a quota
 *    the server owes her, and a client that retried a shortfall would be
 *    spending money to manufacture news.
 * 5. Completion is proved by `summary` AND `done`. Without both, the stream was
 *    truncated and the digest is recorded as `partial` — the items ingested are
 *    real and are kept, but the ledger does not claim the day finished.
 * 6. `usage` is mirrored into `api_usage` so spend stays visible with no
 *    network. 429 is the spend cap, and it is reported as such rather than as a
 *    generic failure.
 *
 * ## One digest per day, and what a second request does
 *
 * `ca_digests.date` is UNIQUE. A second request for the same day RESUMES the
 * existing row rather than opening a second one or throwing: a completed day is
 * already in and is reported as such, and a pending or failed one is re-issued
 * under its ORIGINAL `requestId`, which is the only thing that can turn a
 * timeout into a re-fetch rather than into a second bill.
 *
 * ## Why there is no catch-up backlog
 *
 * `CA_RULES.catchUpDays` is three, and past that a digest is archive rather
 * than debt. A current-affairs backlog is not recoverable the way a lecture
 * backlog is — which is exactly why Phase 2 built a tracker for one and this
 * phase refuses to build one for the other. Presenting three weeks of unread
 * digests as a debt to clear is how she stops opening the app.
 */

import { checkHealth } from '@/lib/api';
import {
  fetchCaHeadlines,
  streamCaDigest,
  type CaDigestRequest,
  type CaDigestProgress,
  type CaDigestSummary,
} from '@/lib/ca-api';
import { buildDigestRequest, itemCapFor } from '@/lib/ca-request';
import { createDigestMapper, type DigestMapper } from '@/lib/ca-map';
import { buildTagIndex } from '@/lib/ca-tags';
import { CA_RULES } from '@/lib/ca-types';
import {
  finishDigest,
  insertCaItem,
  openDigest,
  readIngestContext,
  recordCaUsage,
  recordDigestMeta,
  reopenDigest,
  type CaDigestRow,
  type CaDigestTrigger,
} from '@/db/ca';
import { getProfile } from '@/db/profile';
import { localDate } from '@/lib/time';

export type { CaDigestTrigger };

export type DigestPhase =
  'idle' | 'checking' | 'requesting' | 'streaming' | 'ingesting' | 'done' | 'skipped' | 'failed';

export type DigestRunStatus = 'skipped' | 'completed' | 'partial' | 'failed';

export interface DigestOutcome {
  status: DigestRunStatus;
  /** Always populated. "Nothing happened" must be explicable on screen. */
  reason: string;
  /** The local calendar day this run was for. */
  date: string;
  /** The ceiling asked for. Fewer arriving is not a shortfall to chase. */
  requested: number;
  /** `item` frames seen. */
  received: number;
  /** Rows actually written. Legitimately below `received`. */
  ingested: number;
  /** Items rejected by the contract guard, by reason. Rendered, not just logged. */
  rejected: Readonly<Record<string, number>>;
  /** Slugs the server used that this build's syllabus does not know. */
  unknownTags: string[];
  digestId: number | null;
}

export interface DigestCallbacks {
  onPhase?: (phase: DigestPhase) => void;
  /** The server's own progress line, so the fetch phase is not a blank spinner. */
  onProgress?: (progress: CaDigestProgress) => void;
  /** Fires after each item lands, so a screen can count up live. */
  onIngested?: (ingested: number) => void;
}

export interface RunDigestInput {
  trigger: CaDigestTrigger;
  /** Local calendar day, `YYYY-MM-DD`. Defaults to the profile's timezone. */
  date?: string;
  /** ISO instant. Injectable so a test is not clock-dependent. */
  now?: string;
  /** Overrides the weekday/weekend cap. Mostly for tests. */
  maxItems?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEZONE = 'Asia/Kolkata';

const MS_PER_HOUR = 3_600_000;

/**
 * One digest at a time, process-wide.
 *
 * Two triggers can fire within a second of each other — the app foregrounds and
 * she taps Refresh — and without this they would each open a ledger row and
 * each pay for a morning. A module-level flag rather than a database check
 * because the race is between two calls microseconds apart, and a round trip to
 * SQLite is not atomic enough to arbitrate it. The unique index on `date` is
 * the durable backstop; this is the cheap one.
 */
let digestInFlight = false;

/* ------------------------------------------------------------------ helpers */

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const text = String(error);
  return text === '' || text === '[object Object]' ? 'Unknown error.' : text;
}

/**
 * A per-device unique idempotency key.
 *
 * Not a UUID: `crypto.randomUUID` is not reliably present across the Hermes and
 * JSC builds this app ships on, and the requirement is only that two digests
 * from THIS device never collide. Time plus two random suffixes clears that by
 * a wide margin and is debuggable — the prefix sorts chronologically.
 */
function newRequestId(): string {
  const time = Date.now().toString(36);
  const a = Math.random().toString(36).slice(2, 10);
  const b = Math.random().toString(36).slice(2, 10);
  return `ca_${time}_${a}${b}`;
}

/**
 * The profile's timezone, or the default.
 *
 * Failing to read the profile must not block a digest: the fallback risks the
 * day boundary being wrong by a few hours on a device whose profile row is
 * missing, which is a far smaller failure than permanently disabling the feed.
 */
async function readTimezone(): Promise<string> {
  try {
    const row = await getProfile();
    return row?.timezone ?? DEFAULT_TIMEZONE;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

function hoursSince(from: string | null, now: string): number {
  if (from === null) return Number.POSITIVE_INFINITY;
  const a = Date.parse(from);
  const b = Date.parse(now);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  return (b - a) / MS_PER_HOUR;
}

function skipped(reason: string, date: string, digestId: number | null): DigestOutcome {
  return {
    status: 'skipped',
    reason,
    date,
    requested: 0,
    received: 0,
    ingested: 0,
    rejected: {},
    unknownTags: [],
    digestId,
  };
}

function failed(reason: string, date: string, digestId: number | null): DigestOutcome {
  return {
    status: 'failed',
    reason,
    date,
    requested: 0,
    received: 0,
    ingested: 0,
    rejected: {},
    unknownTags: [],
    digestId,
  };
}

/**
 * Turns a thrown transport failure into something worth showing.
 *
 * Leads with what was salvaged: after a timeout the useful fact is not that the
 * connection died, it is that four items are already on the device and readable
 * with no signal.
 */
function describeTransportFailure(error: unknown, ingested: number): string {
  const salvaged =
    ingested > 0
      ? ` ${ingested} item${ingested === 1 ? '' : 's'} arrived before it stopped and ${
          ingested === 1 ? 'is' : 'are'
        } saved.`
      : '';

  const status = (error as { status?: unknown } | null)?.status;
  if (status === 429) {
    return `Spend cap reached — no digest until it resets.${salvaged}`;
  }
  if (status === 401 || status === 403) {
    return `The server rejected this device’s token. Re-enter it in onboarding.${salvaged}`;
  }
  return `${messageOf(error)}${salvaged}`;
}

/* --------------------------------------------------------------- the runner */

/**
 * Runs one day's digest end to end. Never rejects.
 *
 * The return value is the whole report: status, a sentence explaining it, and
 * the counts. Callers that want live progress pass callbacks; callers that do
 * not — the foreground trigger — can ignore the promise entirely.
 */
export async function runDailyDigest(
  input: RunDigestInput,
  callbacks: DigestCallbacks = {},
): Promise<DigestOutcome> {
  const nowIso = input.now ?? new Date().toISOString();

  if (digestInFlight) {
    callbacks.onPhase?.('skipped');
    return skipped('A digest is already running.', input.date ?? nowIso.slice(0, 10), null);
  }

  digestInFlight = true;

  let date = input.date ?? nowIso.slice(0, 10);

  try {
    callbacks.onPhase?.('checking');

    // Read once and carried: the day this run is for and the zone the server is
    // told about must be the same zone, or a digest generated for "today" could
    // be filed under yesterday.
    const timezone = await readTimezone();
    if (input.date === undefined) {
      date = localDate(timezone, new Date(nowIso));
    }

    /* --------------------------------------------------------------- read */

    let context: Awaited<ReturnType<typeof readIngestContext>>;
    try {
      context = await readIngestContext({ asOfDay: date });
    } catch (error) {
      callbacks.onPhase?.('failed');
      return failed(`Could not read the feed on this device: ${messageOf(error)}`, date, null);
    }

    /* ------------------------------------------- ledger FIRST, then network */

    // Written before anything is sent. Find-or-create in one synchronous
    // transaction, so the unique index on `date` cannot turn a race between two
    // triggers into an exception on a path whose contract is that it does not
    // throw.
    let ledger: { row: CaDigestRow; created: boolean };
    try {
      ledger = await openDigest({
        date,
        requestId: newRequestId(),
        trigger: input.trigger,
      });
    } catch (error) {
      callbacks.onPhase?.('failed');
      return failed(
        `Could not open a digest record on this device: ${messageOf(error)}`,
        date,
        null,
      );
    }

    const digestId = ledger.row.id;
    const resuming = !ledger.created;

    if (resuming && ledger.row.status === 'completed') {
      callbacks.onPhase?.('skipped');
      return skipped('Today’s digest is already in.', date, digestId);
    }

    // A partial day is a real day with real items in it. Topping it up is a
    // deliberate act, not something a foreground event should decide to pay for.
    if (resuming && ledger.row.status === 'partial' && input.trigger === 'auto') {
      callbacks.onPhase?.('skipped');
      return skipped(
        'Today’s digest came through partly. Pull to refresh to try for the rest.',
        date,
        digestId,
      );
    }

    // Attempts, not successes: the cooldown exists to stop a failing server
    // being retried every time the app foregrounds. Manual and catch-up
    // triggers are the user asking, and they bypass it.
    if (input.trigger === 'auto') {
      const elapsed = hoursSince(context.lastDigestAt, nowIso);
      if (elapsed < CA_RULES.digestCooldownHours) {
        callbacks.onPhase?.('skipped');
        return skipped(
          `Last tried ${Math.max(0, Math.round(elapsed))}h ago — waiting ${
            CA_RULES.digestCooldownHours
          }h between automatic attempts.`,
          date,
          digestId,
        );
      }
    }

    // The ORIGINAL request id on a resume. Re-issuing it is the only thing that
    // can turn a timeout into a re-fetch of work the server already did and
    // already billed for; a fresh id would simply buy the same morning twice.
    const requestId = ledger.row.requestId;

    if (resuming && ledger.row.status !== 'pending') {
      try {
        await reopenDigest(digestId, { requestId, trigger: input.trigger });
      } catch {
        // Cosmetic. The row exists, which is the part that makes the spend
        // recoverable; a stale status on it is not worth failing a digest over.
      }
    }

    /* ------------------------------------------------------------ request */

    callbacks.onPhase?.('requesting');

    // The read rate is what makes the cap responsive: a feed she has stopped
    // finishing asks for one item fewer rather than accumulating unread.
    const maxItems = input.maxItems ?? itemCapFor(date, context.recentReadRate);
    const tagIndex = buildTagIndex(context.tagFacts);

    const request: CaDigestRequest = buildDigestRequest({
      requestId,
      resume: resuming,
      date,
      timezone,
      maxItems,
      tagFacts: context.tagFacts,
      knownCanonicalUrls: context.knownCanonicalUrls,
      knownStoryFingerprints: context.knownStoryFingerprints,
      sectionCountsThisWeek: context.sectionCountsThisWeek,
    });

    const observed: {
      received: number;
      ingested: number;
      sawSummary: boolean;
      sawDone: boolean;
      summary: CaDigestSummary | null;
      streamError: string | null;
      writeError: string | null;
    } = {
      received: 0,
      ingested: 0,
      sawSummary: false,
      sawDone: false,
      summary: null,
      streamError: null,
      writeError: null,
    };

    // Held on a mutable record rather than in a `let` for the reason
    // `evaluation.ts` spells out: TypeScript narrows a `let` assigned only
    // inside a callback to its initialiser, so `mapper` would be `never` at the
    // verdict below and the result would silently be read as null.
    const mapping: { mapper: DigestMapper } = {
      mapper: createDigestMapper({
        date,
        tagIndex,
        knownCanonicalUrls: new Set(context.knownCanonicalUrls),
        knownFingerprints: new Set(context.knownFingerprints),
      }),
    };

    callbacks.onPhase?.('streaming');

    let transportError: unknown = null;

    /**
     * Which transport, decided from the server's own report.
     *
     * Asked here rather than assumed, and only an EXPLICIT `false` downgrades:
     * a server too old to carry the field, or a health check that failed for a
     * network reason, must not silently turn a paid setup into headlines mode
     * and leave her wondering where the notes went. When in doubt, ask for the
     * full digest — the server refuses it cheaply if it cannot serve it.
     */
    const headlinesOnly = await checkHealth()
      .then((health) => health.modelConfigured === false)
      .catch(() => false);

    const transport = headlinesOnly ? fetchCaHeadlines : streamCaDigest;

    try {
      await transport(
        request,
        {
          onMeta: (meta) => {
            // Fire-and-forget: failing to stamp the model on the ledger must
            // never fail a digest that otherwise worked.
            void recordDigestMeta(digestId, {
              model: meta.model,
              promptVersion: meta.promptVersion,
              sourceSetVersion: meta.sourceSetVersion,
            }).catch(() => undefined);
          },

          onProgress: (progress) => {
            callbacks.onProgress?.(progress);
          },

          onItem: async (payload) => {
            observed.received += 1;

            const outcome = mapping.mapper.accept(payload);
            if (!outcome.ok) return;

            // Written one at a time, as it arrives. Accumulating and writing at
            // the end would mean a drop at item 4 lost four items she had
            // already paid for and that tomorrow's run will not reproduce.
            try {
              const id = await insertCaItem(outcome.item, digestId);
              if (id !== null) {
                observed.ingested += 1;
                callbacks.onPhase?.('ingesting');
                callbacks.onIngested?.(observed.ingested);
              }
            } catch (error) {
              // A failed write must not abandon the rest of the stream: the
              // next five items are still worth having, and the error is
              // reported on the ledger row at the end.
              observed.writeError = messageOf(error);
            }
          },

          onSummary: (summary) => {
            observed.sawSummary = true;
            observed.summary = summary;
          },

          onUsage: (usage) => {
            // Fire-and-forget: failing to mirror the spend must never fail a
            // digest that otherwise worked.
            void recordCaUsage({
              day: date,
              model: usage.model,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              estCostUsd: usage.estCostUsd,
            }).catch(() => undefined);
          },

          onDone: () => {
            observed.sawDone = true;
          },

          // Terminal, and it outranks a summary that arrived before the server
          // gave up.
          onError: (message) => {
            observed.streamError = message;
          },
        },
        input.signal === undefined ? {} : { signal: input.signal },
      );
    } catch (error) {
      transportError = error;
    }

    /* ----------------------------------------------------------- verdict */

    const result = mapping.mapper.result();

    const rejected: Record<string, number> = {};
    for (const entry of result.rejected) {
      rejected[entry.reason] = (rejected[entry.reason] ?? 0) + 1;
    }

    let status: DigestRunStatus;
    let reason: string;

    if (transportError !== null) {
      status = 'failed';
      reason = describeTransportFailure(transportError, observed.ingested);
    } else if (observed.streamError !== null) {
      status = 'failed';
      reason = observed.streamError;
    } else if (!observed.sawSummary || !observed.sawDone) {
      // Truncated. The items ingested are real and are kept — the ledger simply
      // does not claim the day finished.
      status = 'partial';
      reason = `The digest ended early after ${observed.ingested} item${
        observed.ingested === 1 ? '' : 's'
      }. What arrived is saved; pull to refresh for the rest.`;
    } else {
      status = 'completed';
      // A short digest is a success, said out loud so it does not read as a bug.
      reason =
        observed.ingested < maxItems
          ? `${observed.ingested} item${observed.ingested === 1 ? '' : 's'} today${
              result.duplicates > 0 ? `, and ${result.duplicates} you already have` : ''
            }. A quiet day is a real answer — the cap is a ceiling on your reading time, not a quota.`
          : `${observed.ingested} items today.`;
    }

    if (observed.writeError !== null) {
      reason = `${reason} Some items could not be saved: ${observed.writeError}`;
    }
    if (result.unknownTags.length > 0) {
      // Surfaced, never fatal. A drifting vocabulary is actionable; an item
      // that could not be tagged is still a readable item.
      reason = `${reason} ${result.unknownTags.length} tag${
        result.unknownTags.length === 1 ? '' : 's'
      } named syllabus entries this build does not have.`;
    }

    try {
      await finishDigest(digestId, {
        status,
        consideredCount: observed.summary?.considered ?? null,
        shortlistedCount: observed.summary?.shortlisted ?? null,
        keptCount: observed.ingested,
        droppedCount: (observed.summary?.dropped ?? 0) + result.rejected.length,
        // Both halves of the filter in one histogram: what the server dropped
        // and what this build's contract guard refused on arrival. A filter she
        // cannot see teaches nothing, and only one of the two is visible from
        // either side alone.
        dropReasonsJson: JSON.stringify({
          ...(observed.summary?.dropReasons ?? {}),
          ...rejected,
        }),
        sourceFailuresJson: JSON.stringify(observed.summary?.sourceFailures ?? []),
        error: status === 'completed' ? null : reason,
      });
    } catch {
      // The ledger row already exists and is already the durable record of the
      // attempt; failing to close it must not turn a working digest into a
      // rejected promise out of a function whose contract says it does not.
    }

    callbacks.onPhase?.(status === 'failed' ? 'failed' : 'done');

    return {
      status,
      reason,
      date,
      requested: maxItems,
      received: observed.received,
      ingested: observed.ingested,
      rejected,
      unknownTags: result.unknownTags,
      digestId,
    };
  } catch (error) {
    // The backstop. Nothing above should reach here; if it does, the contract
    // still holds.
    callbacks.onPhase?.('failed');
    return failed(`The digest could not run: ${messageOf(error)}`, date, null);
  } finally {
    digestInFlight = false;
  }
}

/* ------------------------------------------------------------- the triggers */

/**
 * Trigger 1 — on foreground.
 *
 * Gated on the cooldown and on the day's row already existing. Deliberately
 * returns the promise rather than void, so a screen that wants to show the
 * outcome can, and one that does not can ignore it.
 */
export function digestOnForeground(
  input: Omit<RunDigestInput, 'trigger'> = {},
): Promise<DigestOutcome> {
  return runDailyDigest({ ...input, trigger: 'auto' });
}

/** Trigger 2 — "Refresh". The honest answer to "I have wifi and five minutes". */
export function digestNow(
  input: Omit<RunDigestInput, 'trigger'> = {},
  callbacks: DigestCallbacks = {},
): Promise<DigestOutcome> {
  return runDailyDigest({ ...input, trigger: 'manual' }, callbacks);
}

/**
 * Trigger 3 — a day inside the catch-up window that was never fetched.
 *
 * Bounded by `CA_RULES.catchUpDays`, and there is no fourth trigger: past three
 * days a digest is archive, not debt.
 */
export function digestForDay(
  date: string,
  callbacks: DigestCallbacks = {},
): Promise<DigestOutcome> {
  return runDailyDigest({ trigger: 'catch_up', date }, callbacks);
}
