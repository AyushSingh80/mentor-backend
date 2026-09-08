/**
 * Usage ledger and spend caps.
 *
 * Storage is a JSON file rather than a database on purpose: this is a
 * single-user server writing a handful of records a day. A JSON ledger is
 * inspectable with `cat`, needs no native dependency, and cannot drift out of
 * sync with a migration. Revisit if this ever serves more than one person.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config, estimateCostUsd, type ModelTier } from './config.js';

export interface UsageRecord {
  ts: string;
  /** YYYY-MM-DD in config.timezone */
  date: string;
  /** YYYY-MM in config.timezone */
  month: string;
  endpoint: string;
  tier: ModelTier;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Raw prompt-cache write tokens, billed at 1.25x. Absent on old records. */
  cacheCreationInputTokens?: number;
  /** Raw prompt-cache read tokens, billed at 1.0x. Absent on old records. */
  cacheReadInputTokens?: number;
  estCostUsd: number;
}

/**
 * Input tokens that actually cost money, with prompt-cache tokens folded in.
 *
 * Cache writes are billed above the base input rate and cache reads below it.
 * Dropping either — which is what reading only `input_tokens` does — silently
 * under-counts a cached workload, and MCQ generation is exactly that: the same
 * long system prompt on every chunk. Weighting the write at 1.25x and the read
 * at 1.0x over-counts reads on purpose. Over-counting stops the batch early;
 * under-counting spends money that was supposed to be reserved for evaluation.
 */
export function billableInputTokens(usage: {
  inputTokens: number;
  cacheCreationInputTokens?: number | null;
  cacheReadInputTokens?: number | null;
}): number {
  return (
    usage.inputTokens +
    1.25 * (usage.cacheCreationInputTokens ?? 0) +
    1.0 * (usage.cacheReadInputTokens ?? 0)
  );
}

interface Ledger {
  records: UsageRecord[];
}

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: config.timezone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** YYYY-MM-DD in the configured timezone. */
export function localDate(at: Date = new Date()): string {
  return dateFormatter.format(at);
}

/** YYYY-MM in the configured timezone. */
export function localMonth(at: Date = new Date()): string {
  return localDate(at).slice(0, 7);
}

let cache: Ledger | null = null;
/** Serialises writes so two concurrent requests cannot clobber the ledger. */
let writeChain: Promise<void> = Promise.resolve();

/**
 * Model calls admitted but not yet billed.
 *
 * Without this the cap is check-then-act: a request's cost is only known after
 * the model finishes, so concurrent callers all read the same "not yet capped"
 * snapshot and all proceed. Double-tapping Evaluate, a client retry on timeout,
 * or two devices sharing the token is enough to blow past both caps.
 *
 * The unit is one MODEL CALL, which is what the daily cap has always counted:
 * `/evaluate` makes exactly one call per request, so a reservation there is one
 * unit and this stays the request count it used to be. An MCQ batch makes two
 * calls per chunk and reserves that many units, so eight model calls count as
 * eight against the daily ceiling rather than as a single "request" that
 * happens to be twenty times more expensive.
 */
let inFlight = 0;

/**
 * Dollars held against the monthly cap for admitted-but-unbilled work.
 *
 * Split from `inFlight` because the two quantities stopped being proportional
 * the moment a second endpoint existed: one MCQ unit is worth a fraction of an
 * evaluation unit. With every reservation taking the default estimate this is
 * exactly `inFlight * config.caps.estimatedEvalUsd`, which is why the
 * evaluation-only behaviour is unchanged.
 */
let reservedUsd = 0;

/** Reserved dollars attributed to the endpoint that reserved them. */
const reservedUsdByEndpoint = new Map<string, number>();

/** Endpoint that reservations and records are attributed to by default. */
const DEFAULT_ENDPOINT = '/evaluate';

/**
 * Per-endpoint sub-caps, as a registry rather than a hardcoded prefix.
 *
 * The pool is one wallet shared with answer evaluation, which is the
 * higher-value feature: one evaluated answer is worth more than twenty MCQs or
 * a week of digests. Each generator gets a ceiling so that a loop left running
 * cannot exhaust the month and block evaluation for the rest of it.
 *
 * A registry rather than one more `isXEndpoint` function because there are now
 * two, and the third would be the one somebody forgets to wire into
 * `computeCaps` — which fails silently, in the direction of spending money.
 */
const SUBCAPS: readonly { prefix: string; capUsd: () => number; label: string }[] = [
  { prefix: '/mcq', capUsd: () => config.caps.mcqMonthlyUsd, label: 'Question-bank' },
  { prefix: '/ca', capUsd: () => config.caps.caMonthlyUsd, label: 'Current-affairs' },
  { prefix: '/drills', capUsd: () => config.caps.drillsMonthlyUsd, label: 'Drill' },
  { prefix: '/interview', capUsd: () => config.caps.interviewMonthlyUsd, label: 'Interview' },
];

function subcapFor(endpoint: string): (typeof SUBCAPS)[number] | undefined {
  return SUBCAPS.find((subcap) => endpoint.startsWith(subcap.prefix));
}

function reservedUsdFor(prefix: string): number {
  let total = 0;
  for (const [endpoint, usd] of reservedUsdByEndpoint) {
    if (endpoint.startsWith(prefix)) total += usd;
  }
  return total;
}

async function load(): Promise<Ledger> {
  if (cache) return cache;
  try {
    const raw = await readFile(config.usageFile, 'utf8');
    const parsed = JSON.parse(raw) as Partial<Ledger>;
    cache = { records: Array.isArray(parsed.records) ? parsed.records : [] };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // A corrupt ledger must not silently reset the spend cap to zero spent.
      throw new Error(
        `Usage ledger at ${config.usageFile} could not be read: ${(err as Error).message}. ` +
          `Refusing to start with an unknown spend history.`,
      );
    }
    cache = { records: [] };
  }
  return cache;
}

async function persist(ledger: Ledger): Promise<void> {
  await mkdir(dirname(config.usageFile), { recursive: true });
  const tmp = `${config.usageFile}.tmp`;
  await writeFile(tmp, JSON.stringify(ledger, null, 2), 'utf8');
  // Atomic replace — a crash mid-write leaves the previous ledger intact.
  await rename(tmp, config.usageFile);
}

export interface CapStatus {
  allowed: boolean;
  reason?: string;
  monthUsd: number;
  monthlyCapUsd: number;
  todayRequests: number;
  dailyRequestCap: number;
  /** Model calls admitted but not yet billed. */
  inFlight: number;
  /** Dollars held for admitted-but-unbilled work. */
  reservedUsd: number;
  /** Month-to-date spend attributed to /mcq*, including its reservations. */
  mcqMonthUsd: number;
  mcqMonthlyCapUsd: number;
  /** Month-to-date spend attributed to /ca*, including its reservations. */
  caMonthUsd: number;
  caMonthlyCapUsd: number;
  /** Month-to-date spend attributed to /drills*, including its reservations. */
  drillsMonthUsd: number;
  drillsMonthlyCapUsd: number;
}

/** Options shared by `tryReserve` and `releaseReservation`. */
export interface ReservationOptions {
  /** Attributes the hold to an endpoint so per-endpoint sub-caps can see it. */
  endpoint?: string;
  /** Dollars to hold. Defaults to one evaluation's estimate. */
  estimateUsd?: number;
  /** Model calls to hold against the daily cap. Defaults to one. */
  units?: number;
}

function resolveReservation(opts?: ReservationOptions): {
  endpoint: string;
  estimateUsd: number;
  units: number;
} {
  return {
    endpoint: opts?.endpoint ?? DEFAULT_ENDPOINT,
    estimateUsd: opts?.estimateUsd ?? config.caps.estimatedEvalUsd,
    // Fractional or negative units would corrupt an integer counter that other
    // code reads as a count, so they are clamped rather than trusted.
    units: Math.max(1, Math.floor(opts?.units ?? 1)),
  };
}

/**
 * Pure, synchronous cap computation over an already-loaded ledger.
 *
 * Synchronous on purpose: `tryReserve` needs check-and-increment to run with no
 * await between them, which on a single-threaded runtime makes it atomic.
 *
 * `endpoint` selects which sub-cap also applies. Passing nothing computes the
 * shared caps only, which is what /health and /usage report.
 */
function computeCaps(ledger: Ledger, endpoint?: string): CapStatus {
  const month = localMonth();
  const today = localDate();

  let monthUsd = 0;
  let todayRequests = 0;
  const ledgerByPrefix = new Map<string, number>();
  for (const r of ledger.records) {
    if (r.month === month) {
      monthUsd += r.estCostUsd;
      const subcap = subcapFor(r.endpoint);
      if (subcap) {
        ledgerByPrefix.set(subcap.prefix, (ledgerByPrefix.get(subcap.prefix) ?? 0) + r.estCostUsd);
      }
    }
    if (r.date === today) todayRequests += 1;
  }

  const spentUnder = (prefix: string): number =>
    (ledgerByPrefix.get(prefix) ?? 0) + reservedUsdFor(prefix);

  // In-flight work counts against both caps at its estimated cost, since the
  // real cost is not known until it finishes.
  const projectedRequests = todayRequests + inFlight;
  const projectedUsd = monthUsd + reservedUsd;
  const mcqMonthUsd = spentUnder('/mcq');
  const caMonthUsd = spentUnder('/ca');
  const drillsMonthUsd = spentUnder('/drills');

  const overMonthly = projectedUsd >= config.caps.monthlyUsd;
  const overDaily = projectedRequests >= config.caps.dailyRequests;

  // Only bites the endpoint it belongs to: a full generator sub-cap must never
  // stop an answer evaluation, which is the whole reason the sub-caps exist.
  const subcap = endpoint === undefined ? undefined : subcapFor(endpoint);
  const subcapSpent = subcap ? spentUnder(subcap.prefix) : 0;
  const overEndpoint = subcap !== undefined && subcapSpent >= subcap.capUsd();

  return {
    allowed: !overMonthly && !overDaily && !overEndpoint,
    reason: overMonthly
      ? `Monthly spend cap reached ($${monthUsd.toFixed(2)} of $${config.caps.monthlyUsd}${inFlight ? `, ${inFlight} in flight` : ''}). Resets on the 1st.`
      : overDaily
        ? `Daily request cap reached (${projectedRequests} of ${config.caps.dailyRequests}). Resets at midnight ${config.timezone}.`
        : overEndpoint && subcap
          ? `${subcap.label} spend cap reached ($${subcapSpent.toFixed(2)} of $${subcap.capUsd()} this month). Answer evaluation is unaffected. Resets on the 1st.`
          : undefined,
    monthUsd,
    monthlyCapUsd: config.caps.monthlyUsd,
    todayRequests,
    dailyRequestCap: config.caps.dailyRequests,
    inFlight,
    reservedUsd,
    mcqMonthUsd,
    mcqMonthlyCapUsd: config.caps.mcqMonthlyUsd,
    caMonthUsd,
    caMonthlyCapUsd: config.caps.caMonthlyUsd,
    drillsMonthUsd,
    drillsMonthlyCapUsd: config.caps.drillsMonthlyUsd,
  };
}

export async function capStatus(opts?: { endpoint?: string }): Promise<CapStatus> {
  return computeCaps(await load(), opts?.endpoint);
}

/**
 * Atomically admits work and reserves its budget, or refuses.
 *
 * Every caller that reserves MUST call `releaseReservation()` with the SAME
 * options in a finally block, or the hold leaks until restart.
 *
 * Called with no arguments this is exactly what it always was: one model call
 * holding one evaluation's estimate against the shared pool.
 */
export async function tryReserve(
  opts?: ReservationOptions,
): Promise<{ ok: boolean; caps: CapStatus }> {
  const { endpoint, estimateUsd, units } = resolveReservation(opts);
  const ledger = await load();
  // No await past this point — check and increment are one atomic step.
  const caps = computeCaps(ledger, endpoint);
  if (!caps.allowed) return { ok: false, caps };
  inFlight += units;
  reservedUsd += estimateUsd;
  reservedUsdByEndpoint.set(endpoint, (reservedUsdByEndpoint.get(endpoint) ?? 0) + estimateUsd);
  return { ok: true, caps };
}

export function releaseReservation(opts?: ReservationOptions): void {
  const { endpoint, estimateUsd, units } = resolveReservation(opts);
  inFlight = Math.max(0, inFlight - units);
  // Floating point: releasing the last hold must land on exactly zero, not on
  // 2.7e-17, or the monthly projection drifts upward over a long-lived process.
  reservedUsd = Math.max(0, Number((reservedUsd - estimateUsd).toFixed(6)));

  const held = reservedUsdByEndpoint.get(endpoint);
  if (held === undefined) return;
  const next = Number((held - estimateUsd).toFixed(6));
  if (next <= 0) reservedUsdByEndpoint.delete(endpoint);
  else reservedUsdByEndpoint.set(endpoint, next);
}

export async function recordUsage(input: {
  endpoint: string;
  tier: ModelTier;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Prompt-cache write tokens, billed at 1.25x. */
  cacheCreationInputTokens?: number;
  /** Prompt-cache read tokens, billed at 1.0x. */
  cacheReadInputTokens?: number;
}): Promise<UsageRecord> {
  const now = new Date();
  const record: UsageRecord = {
    ts: now.toISOString(),
    date: localDate(now),
    month: localMonth(now),
    endpoint: input.endpoint,
    tier: input.tier,
    model: input.model,
    // The ledger stores the raw counts the API reported; only the cost applies
    // the cache weighting, so the record stays reconcilable against a bill.
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    ...(input.cacheCreationInputTokens
      ? { cacheCreationInputTokens: input.cacheCreationInputTokens }
      : {}),
    ...(input.cacheReadInputTokens ? { cacheReadInputTokens: input.cacheReadInputTokens } : {}),
    estCostUsd: estimateCostUsd(
      input.tier,
      billableInputTokens({
        inputTokens: input.inputTokens,
        cacheCreationInputTokens: input.cacheCreationInputTokens,
        cacheReadInputTokens: input.cacheReadInputTokens,
      }),
      input.outputTokens,
    ),
  };

  const thisWrite = writeChain.then(async () => {
    const ledger = await load();
    // Keep the ledger bounded; 13 months covers year-on-year comparison.
    const cutoff = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const next = [...ledger.records.filter((r) => r.ts >= cutoff), record];

    // Persist before mutating the in-memory ledger, so a failed write leaves
    // the cache matching what is actually on disk rather than claiming a
    // record that was never saved.
    await persist({ records: next });
    ledger.records = next;
  });

  // `.then()` with no rejection handler forwards the rejection to every future
  // link, so a single failed write would permanently skip all subsequent
  // writes — spend tracking would silently stop for the life of the process.
  // Swallow it on the chain, surface it to this caller.
  writeChain = thisWrite.catch(() => undefined);
  await thisWrite;

  return record;
}

export async function usageSummary() {
  const ledger = await load();
  const month = localMonth();
  const today = localDate();

  const byDay = new Map<string, { requests: number; usd: number }>();
  for (const r of ledger.records) {
    const bucket = byDay.get(r.date) ?? { requests: 0, usd: 0 };
    bucket.requests += 1;
    bucket.usd += r.estCostUsd;
    byDay.set(r.date, bucket);
  }

  return {
    timezone: config.timezone,
    today,
    month,
    caps: await capStatus(),
    last30Days: [...byDay.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .slice(0, 30)
      .map(([date, v]) => ({ date, requests: v.requests, usd: Number(v.usd.toFixed(4)) })),
  };
}
