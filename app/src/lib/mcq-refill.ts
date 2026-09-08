/**
 * Refill orchestration — the seam between the bank and the server.
 *
 * Behavioural contract, deliberately the same shape as `lib/evaluation.ts`
 * because the two are the same problem with different nouns:
 *
 * 1. `runBankRefill` NEVER rejects. Every failure path returns a
 *    `RefillOutcome` describing what happened, so a fire-and-forget caller
 *    needs no try/catch and a screen needs no error boundary.
 * 2. The `mcq_bank_refills` row is written FIRST, before any network call,
 *    carrying the `requestId`. This is Phase 1's save-first rule applied to
 *    spend: a refill that times out after the server has billed for thirty
 *    questions must be re-fetchable under the same id, not re-generated.
 * 3. Every `question` frame is banked AS IT ARRIVES. A drop at question 15
 *    leaves fifteen questions on the device, not zero.
 * 4. A SHORT BATCH IS A SUCCESS. The server may deliver 14 of 20 because six
 *    failed its quality control. There is no retry loop on a shortfall — the
 *    next scheduled run tops up, passing the stems already held so it generates
 *    new material rather than the same material again.
 * 5. Completion is proved by `summary` AND `done`. Without both, the stream was
 *    truncated and the refill is recorded as `partial` — the questions banked
 *    are real and are kept, but the ledger does not claim the batch finished.
 * 6. `usage` is mirrored into `api_usage` so spend stays visible with no
 *    network. 429 is the spend cap, and it is reported as such rather than as
 *    a generic failure.
 *
 * ## The three triggers, and why there is no fourth
 *
 * - Post-session, after every drill. Fire-and-forget; never blocks the summary.
 * - On foreground, when the runway is under three days and the server is
 *   reachable and the cooldown has expired and the spend cap allows and she is
 *   not inside a commute drill window.
 * - Manual, from the launcher. The honest answer to "I have wifi and I am
 *   about to travel".
 *
 * Explicitly NOT background fetch. Android background execution is throttled or
 * silently disabled by most OEM battery managers, and an offline guarantee that
 * depends on it is an offline guarantee that fails on the devices it was
 * written for.
 */

import { checkHealth } from '@/lib/api';
import { getProfile, derivePlan } from '@/db/profile';
import {
  bankQuestions,
  findResumableRefill,
  finishRefill,
  readBankSnapshot,
  recordApiUsage,
  restateRefill,
  startRefill,
  topicIdBySlug,
  type RefillRow,
} from '@/db/mcq-bank';
import {
  BANK_RULES,
  computeRunway,
  dailyDemand,
  planBankRefill,
  shouldRefill,
  type RefillTrigger,
} from '@/lib/mcq-bank';
import { buildGenerateRequest, MCQ_PROMPT_VERSION } from '@/lib/mcq-request';
import { generateMcqs, type McqGenerateRequest } from '@/lib/mcq-api';
import {
  createBatchMapper,
  type BankableQuestion,
  type BatchMapper,
} from '@/lib/mcq-generate-map';
import type { BankRunway } from '@/lib/mcq-types';
import { localDate, parseClock } from '@/lib/time';

export type { RefillTrigger };

export type RefillPhase =
  | 'idle'
  | 'checking'
  | 'planning'
  | 'streaming'
  | 'banking'
  | 'done'
  | 'skipped'
  | 'failed';

export type RefillStatus = 'skipped' | 'completed' | 'partial' | 'failed';

export interface RefillOutcome {
  status: RefillStatus;
  /** Always populated. "Nothing happened" must be explicable on screen. */
  reason: string;
  /** What the plan asked for. Zero when nothing was requested. */
  requested: number;
  /** `question` frames seen. */
  received: number;
  /** Rows actually written. Legitimately below `received`. */
  accepted: number;
  refillId: number | null;
  runway: BankRunway | null;
}

export interface RefillCallbacks {
  onPhase?: (phase: RefillPhase) => void;
  /** Fires after each question lands, so a screen can count up live. */
  onBanked?: (accepted: number) => void;
  /**
   * Which section the server has started on, as a sentence.
   *
   * A batch spans four to six sections and each is two model calls, so a
   * top-up runs for minutes. `onBanked` only fires when a question survives
   * quality control, and a section that rejects everything it generates is
   * silent throughout — which reads as a hang.
   */
  onSection?: (detail: string, done: number, total: number) => void;
}

export interface RunRefillInput {
  trigger: RefillTrigger;
  /** Local calendar day, `YYYY-MM-DD`. Defaults to the profile's timezone. */
  asOfDay?: string;
  /** ISO instant. Injectable so a test is not clock-dependent. */
  now?: string;
  /** Overrides the profile-derived check. Mostly for tests. */
  insideMicroBlock?: boolean;
  batchSize?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEZONE = 'Asia/Kolkata';

/**
 * One refill at a time, process-wide.
 *
 * Three triggers can fire within a second of each other — she finishes a drill,
 * the app foregrounds, she taps Top up — and without this they would each open
 * a ledger row and each pay for a batch. A module-level flag rather than a
 * database check because the race is between two calls microseconds apart, and
 * a round trip to SQLite is not atomic enough to arbitrate it.
 */
let refillInFlight = false;

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
 * JSC builds this app ships on, and the requirement is only that two refills
 * from THIS device never collide. Time plus two random suffixes clears that by
 * a wide margin and is debuggable — the prefix sorts chronologically.
 */
function newRequestId(): string {
  const time = Date.now().toString(36);
  const a = Math.random().toString(36).slice(2, 10);
  const b = Math.random().toString(36).slice(2, 10);
  return `rf_${time}_${a}${b}`;
}

const MINUTES_PER_DAY = 1440;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

/** `HH:MM` in a timezone, as minutes from local midnight. */
function localMinutes(timezone: string, at: Date): number | null {
  let text: string;
  try {
    text = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(at);
  } catch {
    return null;
  }
  // en-GB renders midnight as "24:00", which `parseClock` correctly rejects.
  const normalised = text.startsWith('24:') ? `00:${text.slice(3)}` : text;
  return parseClock(normalised);
}

/** 0–6, from the local calendar day rather than the device's own offset. */
function localDayOfWeek(timezone: string, at: Date): number | null {
  const day = localDate(timezone, at);
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(ms) ? new Date(ms).getUTCDay() : null;
}

interface BlockWindow {
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
  kind: string;
}

/**
 * Is the clock inside one of her commute drill windows?
 *
 * Tested on a minute-of-week axis with the two neighbouring weeks included,
 * because a commute block is derived arithmetically and legitimately falls
 * outside `0..1439`: a shift starting at 00:30 with a 40-minute commute
 * produces a block beginning at −10, and one ending at 23:50 produces one
 * ending at 1470. Clamping either would silently stop protecting the drill
 * window for exactly the night-shift schedule this app was written for.
 */
export function isInsideMicroBlock(
  blocks: readonly BlockWindow[],
  dayOfWeek: number,
  minutes: number,
): boolean {
  const nowAbs = dayOfWeek * MINUTES_PER_DAY + minutes;

  for (const block of blocks) {
    if (block.kind !== 'micro') continue;
    const start = block.dayOfWeek * MINUTES_PER_DAY + block.startMinutes;
    const end = block.dayOfWeek * MINUTES_PER_DAY + block.endMinutes;
    for (const shift of [-MINUTES_PER_WEEK, 0, MINUTES_PER_WEEK]) {
      if (nowAbs >= start + shift && nowAbs < end + shift) return true;
    }
  }
  return false;
}

interface ProfileContext {
  timezone: string;
  asOfDay: string;
  insideMicroBlock: boolean;
}

/**
 * The schedule half of the gate.
 *
 * Failing to read the profile must not block a refill: the fallback says "not
 * inside a commute block", which risks one badly-timed network call rather than
 * permanently disabling automatic top-ups on a device whose profile row is
 * missing.
 */
async function readProfileContext(now: Date): Promise<ProfileContext> {
  try {
    const row = await getProfile();
    if (!row) {
      return {
        timezone: DEFAULT_TIMEZONE,
        asOfDay: localDate(DEFAULT_TIMEZONE, now),
        insideMicroBlock: false,
      };
    }

    const plan = derivePlan(row);
    const dayOfWeek = localDayOfWeek(row.timezone, now);
    const minutes = localMinutes(row.timezone, now);

    return {
      timezone: row.timezone,
      asOfDay: localDate(row.timezone, now),
      insideMicroBlock:
        dayOfWeek === null || minutes === null
          ? false
          : isInsideMicroBlock(plan.blocks, dayOfWeek, minutes),
    };
  } catch {
    return {
      timezone: DEFAULT_TIMEZONE,
      asOfDay: localDate(DEFAULT_TIMEZONE, now),
      insideMicroBlock: false,
    };
  }
}

interface HealthProbe {
  healthOk: boolean;
  spendCapAllows: boolean;
  detail: string | null;
}

/**
 * The liveness probe, and the only cheap way to learn the spend cap.
 *
 * Skipped for `post_session`: that trigger is fire-and-forget behind a summary
 * screen, and spending a round trip to learn what the generate call is about to
 * tell us anyway is a second-long delay for no information. A 429 there is
 * reported as the spend cap by the generate call itself.
 */
async function probeHealth(trigger: RefillTrigger): Promise<HealthProbe> {
  if (trigger === 'post_session') {
    return { healthOk: true, spendCapAllows: true, detail: null };
  }

  try {
    const health = await checkHealth();
    return {
      healthOk: health.ok !== false,
      spendCapAllows: health.caps?.allowed !== false,
      detail: null,
    };
  } catch (error) {
    return { healthOk: false, spendCapAllows: true, detail: messageOf(error) };
  }
}

function skipped(reason: string, runway: BankRunway | null): RefillOutcome {
  return { status: 'skipped', reason, requested: 0, received: 0, accepted: 0, refillId: null, runway };
}

/* --------------------------------------------------------------- the runner */

/**
 * Runs one refill end to end. Never rejects.
 *
 * The return value is the whole report: status, a sentence explaining it, and
 * the counts. Callers that want live progress pass callbacks; callers that do
 * not — the post-session trigger — ignore the promise entirely.
 */
export async function runBankRefill(
  input: RunRefillInput,
  callbacks: RefillCallbacks = {},
): Promise<RefillOutcome> {
  const nowIso = input.now ?? new Date().toISOString();
  const nowDate = new Date(nowIso);

  if (refillInFlight) {
    callbacks.onPhase?.('skipped');
    return skipped('A top-up is already running.', null);
  }

  refillInFlight = true;

  try {
    callbacks.onPhase?.('checking');

    const profile = await readProfileContext(nowDate);
    const asOfDay = input.asOfDay ?? profile.asOfDay;

    /* ------------------------------------------------------------- read */

    let snapshot: Awaited<ReturnType<typeof readBankSnapshot>>;
    try {
      snapshot = await readBankSnapshot({ asOfDay, now: nowIso });
    } catch (error) {
      callbacks.onPhase?.('failed');
      return {
        status: 'failed',
        reason: `Could not read the question bank on this device: ${messageOf(error)}`,
        requested: 0,
        received: 0,
        accepted: 0,
        refillId: null,
        runway: null,
      };
    }

    const demandPerDay = dailyDemand(snapshot.drillCounts, { asOfDay });
    const runway = computeRunway(snapshot.inventory, demandPerDay);

    /* ------------------------------------------------------------- gate */

    // The local gates first, with the network answers assumed friendly. If the
    // bank is comfortable or the cooldown has not expired, the decision is
    // already made and probing the server would be a round trip spent to learn
    // nothing — on a screen that opens every time she taps Drill.
    const localOnly = shouldRefill({
      trigger: input.trigger,
      runway,
      now: nowIso,
      lastRefillAttemptAt: snapshot.lastRefillAttemptAt,
      healthOk: true,
      spendCapAllows: true,
      insideMicroBlock: input.insideMicroBlock ?? profile.insideMicroBlock,
      refillInFlight: false,
    });

    if (!localOnly.refill) {
      callbacks.onPhase?.('skipped');
      return skipped(localOnly.reason, runway);
    }

    const probe = await probeHealth(input.trigger);

    const decision = shouldRefill({
      trigger: input.trigger,
      runway,
      now: nowIso,
      lastRefillAttemptAt: snapshot.lastRefillAttemptAt,
      healthOk: probe.healthOk,
      spendCapAllows: probe.spendCapAllows,
      insideMicroBlock: input.insideMicroBlock ?? profile.insideMicroBlock,
      // Held by this function, not by the gate: the flag above already
      // arbitrated it, and telling the gate otherwise would make the reason
      // string wrong.
      refillInFlight: false,
    });

    if (!decision.refill) {
      callbacks.onPhase?.('skipped');
      return skipped(
        probe.detail !== null && !probe.healthOk ? `${decision.reason} (${probe.detail})` : decision.reason,
        runway,
      );
    }

    /* ------------------------------------------------------------- plan */

    callbacks.onPhase?.('planning');

    const plan = planBankRefill({
      sections: snapshot.sections,
      asOfDay,
      batchSize: input.batchSize ?? BANK_RULES.batchSize,
      excludeStemHashes: snapshot.knownFingerprints,
    });

    if (plan.batchSize === 0) {
      callbacks.onPhase?.('skipped');
      return skipped(plan.rationale, runway);
    }

    /* ------------------------------------------------- ledger, then network */

    // Re-attach to a request the server may already have run and billed for,
    // rather than opening a second one beside it.
    let resuming: RefillRow | null = null;
    try {
      resuming = await findResumableRefill();
    } catch {
      resuming = null;
    }

    const requestId = resuming?.requestId ?? newRequestId();
    // The only home `promptVersion` has, the schema being frozen — and the
    // plan that produced this request, so a badly-aimed bank stays explicable
    // months later.
    const planJson = JSON.stringify({ promptVersion: MCQ_PROMPT_VERSION, plan });
    let refillId: number;

    if (resuming) {
      refillId = resuming.id;
      // The row is older than this plan and the board has moved since. Keep it
      // describing what is actually being sent.
      try {
        await restateRefill(refillId, { requestedCount: plan.batchSize, planJson });
      } catch {
        // Cosmetic. The row exists, which is the part that makes the spend
        // recoverable; a stale plan on it is not worth failing a refill over.
      }
    } else {
      try {
        refillId = await startRefill({
          requestId,
          trigger: input.trigger,
          requestedCount: plan.batchSize,
          planJson,
        });
      } catch (error) {
        callbacks.onPhase?.('failed');
        return {
          status: 'failed',
          reason: `Could not open a top-up record on this device: ${messageOf(error)}`,
          requested: plan.batchSize,
          received: 0,
          accepted: 0,
          refillId: null,
          runway,
        };
      }
    }

    let slugs: Map<string, number>;
    try {
      slugs = await topicIdBySlug();
    } catch {
      // An unresolvable slug becomes `syllabusTopicId: null`, which the mapper
      // already treats as acceptable. An empty map degrades attribution, not
      // the bank.
      slugs = new Map();
    }

    const request: McqGenerateRequest = buildGenerateRequest({
      requestId,
      resume: resuming !== null,
      plan,
      sections: snapshot.sections,
    });

    const observed: {
      batchId: string | null;
      promptVersion: string | null;
      received: number;
      accepted: number;
      sawSummary: boolean;
      sawDone: boolean;
      streamError: string | null;
      writeError: string | null;
    } = {
      batchId: null,
      promptVersion: null,
      received: 0,
      accepted: 0,
      sawSummary: false,
      sawDone: false,
      streamError: null,
      writeError: null,
    };

    // Built lazily so it can carry the batch id from the `meta` frame, which
    // arrives before the first question. Frames are ordered, so by the time a
    // question needs the mapper, `meta` has been seen.
    //
    // Held on a mutable record rather than in a `let` for the reason
    // `evaluation.ts` spells out: TypeScript narrows a `let` assigned only
    // inside a callback to its initialiser, so `mapper` would be `never` at the
    // verdict below and the result would silently be read as null.
    const mapping: { mapper: BatchMapper | null } = { mapper: null };
    const ensureMapper = (): BatchMapper => {
      const existing = mapping.mapper;
      if (existing !== null) return existing;
      const created = createBatchMapper({
        topicIdBySlug: slugs,
        knownFingerprints: new Set(snapshot.knownFingerprints),
        batchId: observed.batchId ?? requestId,
        promptVersion: observed.promptVersion ?? MCQ_PROMPT_VERSION,
      });
      mapping.mapper = created;
      return created;
    };

    callbacks.onPhase?.('streaming');

    let transportError: unknown = null;

    try {
      await generateMcqs(
        request,
        {
          onMeta: (meta) => {
            observed.batchId = meta.batchId;
            observed.promptVersion = meta.promptVersion;
          },

          onProgress: (progress) => {
            if (progress.detail === null) return;
            callbacks.onSection?.(progress.detail, progress.done ?? 0, progress.total ?? 0);
          },

          onQuestion: async (payload) => {
            observed.received += 1;

            const outcome = ensureMapper().accept(payload);
            if (!outcome.ok) return;

            // Banked one at a time, as it arrives. Accumulating and writing at
            // the end would mean a drop at question 15 lost fifteen questions
            // the user had already paid for.
            const row: BankableQuestion = outcome.question;
            try {
              const written = await bankQuestions([row]);
              if (written > 0) {
                observed.accepted += written;
                callbacks.onPhase?.('banking');
                callbacks.onBanked?.(observed.accepted);
              }
            } catch (error) {
              // A failed write must not abandon the rest of the stream: the
              // next twenty questions are still worth having, and the error is
              // reported on the ledger row at the end.
              observed.writeError = messageOf(error);
            }
          },

          onSummary: (summary) => {
            observed.sawSummary = true;
            if (summary.batchId !== null) observed.batchId = summary.batchId;
          },

          onUsage: (usage) => {
            // Fire-and-forget: failing to mirror the spend must never fail a
            // refill that otherwise worked.
            void recordApiUsage({
              day: asOfDay,
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

    const result = mapping.mapper?.result() ?? null;
    const rejected = result?.rejected.length ?? 0;
    const duplicates = result?.duplicates ?? 0;

    let status: RefillStatus;
    let reason: string;

    if (transportError !== null) {
      status = 'failed';
      reason = describeTransportFailure(transportError, observed.accepted);
    } else if (observed.streamError !== null) {
      status = 'failed';
      reason = observed.streamError;
    } else if (!observed.sawSummary || !observed.sawDone) {
      // Truncated. The questions banked are real and are kept — the ledger
      // simply does not claim the batch finished.
      status = 'partial';
      reason =
        `The top-up ended early after ${observed.accepted} of ${plan.batchSize} questions. ` +
        'What arrived is saved; the rest is topped up on the next run.';
    } else {
      status = 'completed';
      // A short batch is a success, said out loud so it does not read as a bug.
      reason =
        observed.accepted < plan.batchSize
          ? `Added ${observed.accepted} questions. The server dropped ${
              plan.batchSize - observed.accepted
            } that failed its quality checks${
              duplicates > 0 ? `, and ${duplicates} were already in your bank` : ''
            } — that is normal, and the shortfall is topped up next time.`
          : `Added ${observed.accepted} questions.`;
    }

    if (observed.writeError !== null) {
      reason = `${reason} Some questions could not be saved: ${observed.writeError}`;
    }

    try {
      await finishRefill(refillId, {
        status,
        receivedCount: observed.received,
        acceptedCount: observed.accepted,
        batchId: observed.batchId,
        error:
          status === 'completed'
            ? null
            : [reason, rejected > 0 ? `${rejected} rejected on arrival.` : null]
                .filter((part) => part !== null)
                .join(' '),
      });
    } catch {
      // The ledger row already exists and is already the durable record of the
      // attempt; failing to close it must not turn a working refill into a
      // rejected promise out of a function whose contract says it does not.
    }

    callbacks.onPhase?.(status === 'completed' ? 'done' : status === 'partial' ? 'done' : 'failed');

    return {
      status,
      reason,
      requested: plan.batchSize,
      received: observed.received,
      accepted: observed.accepted,
      refillId,
      runway,
    };
  } catch (error) {
    // The backstop. Nothing above should reach here; if it does, the contract
    // still holds.
    callbacks.onPhase?.('failed');
    return {
      status: 'failed',
      reason: `The top-up could not run: ${messageOf(error)}`,
      requested: 0,
      received: 0,
      accepted: 0,
      refillId: null,
      runway: null,
    };
  } finally {
    refillInFlight = false;
  }
}

/**
 * Turns a thrown transport failure into something worth showing.
 *
 * Leads with what was salvaged: after a timeout the useful fact is not that the
 * connection died, it is that eleven questions are already on the device.
 */
function describeTransportFailure(error: unknown, accepted: number): string {
  const salvaged =
    accepted > 0 ? ` ${accepted} question${accepted === 1 ? '' : 's'} arrived before it stopped and are saved.` : '';

  const status = (error as { status?: unknown } | null)?.status;
  if (status === 429) {
    return `Spend cap reached — no more questions until it resets.${salvaged}`;
  }
  if (status === 401 || status === 403) {
    return `The server rejected this device’s token. Re-enter it in onboarding.${salvaged}`;
  }
  return `${messageOf(error)}${salvaged}`;
}

/* ------------------------------------------------------------- the triggers */

/**
 * Trigger 1 — after every drill.
 *
 * Deliberately returns void. The summary screen must render the moment the last
 * question is answered; awaiting a network call there would put a spinner
 * between her and her score, which is the one screen she has earned.
 */
export function refillAfterSession(input: Omit<RunRefillInput, 'trigger'> = {}): void {
  void runBankRefill({ ...input, trigger: 'post_session' }).catch(() => undefined);
}

/** Trigger 2 — on foreground. Gated on runway, health, cooldown, cap and commute. */
export function refillOnForeground(input: Omit<RunRefillInput, 'trigger'> = {}): Promise<RefillOutcome> {
  return runBankRefill({ ...input, trigger: 'auto' });
}

/** Trigger 3 — "Top up now". */
export function refillNow(
  input: Omit<RunRefillInput, 'trigger'> = {},
  callbacks: RefillCallbacks = {},
): Promise<RefillOutcome> {
  return runBankRefill({ ...input, trigger: 'manual' }, callbacks);
}

/* ------------------------------------------------------------ launcher view */

export interface RefillFailure {
  at: string;
  error: string;
}

export interface BankStatus {
  /** The local calendar day every figure here was computed against. */
  asOfDay: string;
  runway: BankRunway;
  /** The p75 the runway was divided by, so the number can be explained. */
  demandPerDay: number;
  eligibleSections: number;
  /** Sections she has started that hold no unseen questions at all. */
  emptyEligibleSections: number;
  recentRefills: RefillRow[];
  /** Consecutive failures at the head of the ledger. Zero once one succeeds. */
  consecutiveFailures: number;
  lastFailure: RefillFailure | null;
}

/**
 * Everything the launcher renders, from one read.
 *
 * The failure history is here and not merely in a log because "the last three
 * top-ups failed" is precisely what she needs to know BEFORE a commute — a
 * silent supply failure is indistinguishable from a healthy bank right up until
 * the moment there is no signal to fix it.
 */
export async function readBankStatus(opts: { asOfDay?: string; now?: string } = {}): Promise<BankStatus> {
  const nowIso = opts.now ?? new Date().toISOString();
  const profile = await readProfileContext(new Date(nowIso));
  const asOfDay = opts.asOfDay ?? profile.asOfDay;

  const snapshot = await readBankSnapshot({ asOfDay, now: nowIso });
  const demandPerDay = dailyDemand(snapshot.drillCounts, { asOfDay });

  const eligible = snapshot.sections.filter((section) => section.eligible);

  let consecutiveFailures = 0;
  for (const row of snapshot.recentRefills) {
    if (row.status === 'failed') consecutiveFailures += 1;
    else if (row.status === 'pending') continue;
    else break;
  }

  const failed = snapshot.recentRefills.find((row) => row.status === 'failed');

  return {
    asOfDay,
    runway: computeRunway(snapshot.inventory, demandPerDay),
    demandPerDay,
    eligibleSections: eligible.length,
    emptyEligibleSections: eligible.filter((section) => section.unseenStock === 0).length,
    recentRefills: snapshot.recentRefills,
    consecutiveFailures,
    lastFailure:
      failed === undefined
        ? null
        : { at: failed.completedAt ?? failed.requestedAt, error: failed.error ?? 'Unknown error.' },
  };
}
