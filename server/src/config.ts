import { fileURLToPath } from 'node:url';

/**
 * Environment loading and validation.
 *
 * Fails loudly at boot rather than at first request. A server that starts
 * without a spend cap configured is worse than one that refuses to start.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required env var ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value.trim();
}

/**
 * An env var that may legitimately be absent.
 *
 * Returns null rather than '' so a missing value cannot be mistaken for a
 * configured empty one, and so `=== null` is the only way to test for it.
 */
function optional(name: string): string | null {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') return null;
  return value.trim();
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Env var ${name} must be a non-negative number, got: ${raw}`);
  }
  return parsed;
}

export type ModelTier = 'evaluation' | 'bulk';

export const config = {
  /**
   * Optional since headlines mode.
   *
   * Every paid feature needs it and refuses without it — see `requireCapability`
   * in `capability.ts`. But the current-affairs sweep is plain HTTP, and demanding a key
   * to fetch an RSS feed made "run without a key" and "run with invented data"
   * the same mode. That is how the real fetcher, written and tested, went a
   * whole project without running once on a device.
   *
   * The boot-time assertion has moved rather than gone: the half-configured
   * check below still refuses a key without models or models without a key, and
   * a route that needs a model still fails loudly. What it no longer does is
   * refuse to start over a capability this request was never going to use.
   */
  anthropicApiKey: optional('ANTHROPIC_API_KEY'),
  /**
   * Groq, for the bulk tier. Optional on the same terms as the Anthropic key:
   * absent means the provider exists but cannot be selected, and the tier
   * assertion below is what refuses a half-configured setup.
   */
  groqApiKey: optional('GROQ_API_KEY'),
  /**
   * Gemini, for the evaluation tier — the only configured provider whose vision
   * is strong enough to read her handwriting, and the only one that takes a PDF
   * natively, which is what the phone scanner path actually produces.
   */
  geminiApiKey: optional('GEMINI_API_KEY'),
  bearerToken: required('APP_BEARER_TOKEN'),
  port: num('PORT', 8787),

  /**
   * Day and month boundaries for spend caps are computed in this zone, not UTC.
   * A UTC day rolls over at 05:30 IST — mid morning study block — which would
   * reset the daily cap at exactly the wrong moment.
   */
  timezone: process.env.APP_TIMEZONE?.trim() || 'Asia/Kolkata',

  caps: {
    monthlyUsd: num('MONTHLY_USD_CAP', 25),
    dailyRequests: num('DAILY_REQUEST_CAP', 120),
    /**
     * Budget held for a request that has been admitted but has not yet
     * reported its real token usage. Only needs to be the right order of
     * magnitude — it exists so concurrent requests cannot collectively
     * overshoot the monthly cap while all of them are still in flight.
     */
    estimatedEvalUsd: num('ESTIMATED_EVAL_USD', 0.2),

    /**
     * Per-endpoint sub-cap for MCQ banking, inside the shared monthly pool.
     *
     * The pool is one wallet shared with answer evaluation, which is the
     * higher-value feature. A banking loop left running would otherwise
     * exhaust the month by the 12th and block evaluation for eighteen days.
     * This ceiling is what makes that impossible rather than merely unlikely.
     */
    mcqMonthlyUsd: num('MCQ_MONTHLY_USD_CAP', Math.min(8, 0.32 * num('MONTHLY_USD_CAP', 25))),

    /**
     * Held per requested question while a batch is in flight. Same role as
     * `estimatedEvalUsd`: order-of-magnitude, not billing truth.
     */
    estimatedMcqUsdPerQuestion: num('ESTIMATED_MCQ_USD_PER_QUESTION', 0.015),

    /**
     * Per-endpoint sub-cap for the daily current-affairs digest.
     *
     * Two model calls a day at roughly $0.12 is about $3.60 a month; five
     * leaves headroom for busy days and a retry. Unlike evaluation (per answer)
     * and banking (batched, occasional), this one runs every day she opens the
     * app — but it is PULLED, never pushed, so a week unopened costs nothing.
     */
    caMonthlyUsd: num('CA_MONTHLY_USD_CAP', Math.min(5, 0.2 * num('MONTHLY_USD_CAP', 25))),

    /** Held per digest while it is in flight. */
    estimatedCaUsdPerDigest: num('ESTIMATED_CA_USD_PER_DIGEST', 0.18),

    /**
     * Per-endpoint sub-cap for the essay and ethics drills.
     *
     * Two very different calls share it. Setting six prompts is cheap and
     * happens twice a week; MARKING is an evaluation-tier call on a piece of
     * her writing and happens most mornings, which is what this cap is really
     * sized for — roughly the same shape of spend as answer evaluation itself,
     * and deliberately smaller, because a drill is a fifth of an answer.
     */
    drillsMonthlyUsd: num('DRILLS_MONTHLY_USD_CAP', Math.min(4, 0.16 * num('MONTHLY_USD_CAP', 25))),

    /** Held per prompt while a batch is in flight. */
    estimatedDrillUsdPerPrompt: num('ESTIMATED_DRILL_USD_PER_PROMPT', 0.02),

    /** Held per marking call while it is in flight. Evaluation tier, so larger. */
    estimatedDrillEvalUsd: num('ESTIMATED_DRILL_EVAL_USD', 0.08),

    /**
     * Per-endpoint sub-cap for interview question generation.
     *
     * The smallest of the four, and it should be: the DAF is filled over two
     * years and generation is a handful of batches a month at most, rising only
     * in the months before the Personality Test. Sized so a runaway loop is
     * bounded, not so the feature is rationed.
     */
    interviewMonthlyUsd: num('INTERVIEW_MONTHLY_USD_CAP', Math.min(2, 0.08 * num('MONTHLY_USD_CAP', 30))),

    /** Held per batch while it is in flight. */
    estimatedInterviewUsd: num('ESTIMATED_INTERVIEW_USD', 0.04),

    /**
     * Dollars the sub-caps may never collectively claim.
     *
     * Asserted at boot below. Today nothing stops someone setting
     * `MCQ_MONTHLY_USD_CAP=25` and silently starving answer evaluation — the
     * one feature the sub-caps exist to protect. At roughly $0.26 a real
     * evaluation, $10 is about 38 a month against a target of ~30.
     */
    evalReservedFloorUsd: num('EVAL_RESERVED_FLOOR_USD', Math.min(10, 0.4 * num('MONTHLY_USD_CAP', 25))),
  },

  /**
   * Model identifiers, supplied entirely by the environment.
   *
   * No defaults on purpose, and there are two reasons. A hardcoded id goes
   * stale silently — the provider retires it and the server keeps sending a
   * name that no longer resolves, failing at first request instead of at boot,
   * which is the exact failure mode `required` exists to prevent. And a model
   * id is deployment configuration, not source: it changes when the account
   * changes, without a code change or a redeploy of the image.
   */
  models: {
    evaluation: optional('MODEL_EVALUATION'),
    bulk: optional('MODEL_BULK'),
  } satisfies Record<ModelTier, string | null>,

  /**
   * Which provider serves each tier.
   *
   * Defaulted, unlike the model ids, and for the opposite reason: a model id
   * goes stale when the account changes, but the set of providers this server
   * has an adapter for is SOURCE, not deployment configuration. Defaulting to
   * `anthropic` is what makes this phase a pure refactor — a deployment that
   * sets neither variable behaves exactly as it did before.
   *
   * Per tier rather than one setting because the two tiers are heading to two
   * different providers, and a single knob would make that unrepresentable.
   *
   * The VALUE is not validated here. Whether an id names a real adapter, and
   * whether that adapter can do what its tier asks, are questions only
   * `providers/registry.ts` can answer; it asserts both at boot. This file's
   * job is to read the environment once and hand over what it found.
   */
  providers: {
    evaluation: optional('PROVIDER_EVALUATION') ?? 'anthropic',
    bulk: optional('PROVIDER_BULK') ?? 'anthropic',
  } satisfies Record<ModelTier, string>,

  /**
   * USD per million tokens, used only to enforce the local spend cap.
   * Not billing truth — verify against the provider's current pricing.
   */
  pricing: {
    evaluation: {
      inputPerMTok: num('PRICE_EVAL_INPUT_PER_MTOK', 15),
      outputPerMTok: num('PRICE_EVAL_OUTPUT_PER_MTOK', 75),
    },
    bulk: {
      inputPerMTok: num('PRICE_BULK_INPUT_PER_MTOK', 3),
      outputPerMTok: num('PRICE_BULK_OUTPUT_PER_MTOK', 15),
    },
  } satisfies Record<ModelTier, { inputPerMTok: number; outputPerMTok: number }>,

  usageFile: process.env.USAGE_FILE?.trim() || './data/usage.json',

  /**
   * The current-affairs source allowlist. Server config, never device data —
   * adding a feed must not require an app rebuild.
   *
   * Resolved relative to THIS MODULE rather than to the working directory, the
   * same way the prompt files are. A cwd-relative default works in development
   * and breaks on a dist-only deploy, where `./src` does not exist — and it
   * breaks at the first request rather than at boot, which is the failure mode
   * this file exists to prevent.
   */
  caSourcesFile:
    process.env.CA_SOURCES_FILE?.trim() ||
    fileURLToPath(new URL('./ca/sources.json', import.meta.url)),
} as const;

/**
 * An EXPLICIT set of sub-caps may not collectively claim the pool.
 *
 * Thrown at boot rather than discovered in March, following this file's own
 * rule: a server that starts without a working spend cap is worse than one that
 * refuses to start. Without this, `MCQ_MONTHLY_USD_CAP=25` is accepted happily
 * and answer evaluation — the highest-value thing the server does — is starved
 * from the first busy week, with no error anywhere to explain it.
 *
 * Only EXPLICIT settings are checked, because the defaults already scale with
 * the pool (see `caps` above). Asserting against scaled defaults would refuse
 * to start on a deliberately small pool — a test fixture, a trial deployment —
 * which turns a guard against misconfiguration into an obstacle to configuring
 * anything at all.
 */
const explicitSubcaps =
  (process.env.MCQ_MONTHLY_USD_CAP === undefined ? 0 : config.caps.mcqMonthlyUsd) +
  (process.env.CA_MONTHLY_USD_CAP === undefined ? 0 : config.caps.caMonthlyUsd) +
  (process.env.DRILLS_MONTHLY_USD_CAP === undefined ? 0 : config.caps.drillsMonthlyUsd) +
  (process.env.INTERVIEW_MONTHLY_USD_CAP === undefined ? 0 : config.caps.interviewMonthlyUsd);

if (explicitSubcaps > 0 && explicitSubcaps + config.caps.evalReservedFloorUsd > config.caps.monthlyUsd) {
  throw new Error(
    `Spend sub-caps over-claim the pool: MCQ $${config.caps.mcqMonthlyUsd} + ` +
      `current affairs $${config.caps.caMonthlyUsd} + drills $${config.caps.drillsMonthlyUsd} + ` +
      `interview $${config.caps.interviewMonthlyUsd} + ` +
      `a $${config.caps.evalReservedFloorUsd} floor for answer evaluation exceeds ` +
      `MONTHLY_USD_CAP of $${config.caps.monthlyUsd}. Evaluation would be starved.`,
  );
}

/**
 * Whether paid model features are available at all.
 *
 * Read by the routes that need one, and printed at boot so the operating mode
 * is never a guess. Headlines mode, the syllabus, rubric versions and the usage
 * ledger all work with this false.
 */
/** Whether a tier has both halves: its provider's key and its model id. */
function tierIsConfigured(tier: ModelTier): boolean {
  return apiKeyForProvider(config.providers[tier]) !== null && config.models[tier] !== null;
}

export const modelConfigured =
  tierIsConfigured('evaluation') || tierIsConfigured('bulk');

/**
 * A HALF-configured TIER is a misconfiguration and still refuses to start.
 *
 * Per tier, and it did not used to be. The first version required
 * ANTHROPIC_API_KEY, MODEL_EVALUATION and MODEL_BULK to be set together — which
 * was right while one provider existed and became wrong the moment a second
 * one did. It refused the entirely valid setup this server now runs: bulk on
 * Groq, evaluation deliberately unconfigured, and no Anthropic key anywhere.
 *
 * What stays true is the reason. A key with no model id fails at the first
 * request with a provider error about a missing model; a model id with no key
 * fails with an auth error. Both look like outages and neither names the cause.
 * Absent-together is the supported no-model mode; absent-separately is a typo
 * in a deployment environment, and the difference is worth a boot failure.
 */
for (const tier of ['evaluation', 'bulk'] as const) {
  const providerId = config.providers[tier];
  const keyVar =
    providerId === 'groq'
      ? 'GROQ_API_KEY'
      : providerId === 'gemini'
        ? 'GEMINI_API_KEY'
        : 'ANTHROPIC_API_KEY';
  const modelVar = tier === 'evaluation' ? 'MODEL_EVALUATION' : 'MODEL_BULK';
  const hasKey = apiKeyForProvider(providerId) !== null;
  const hasModel = config.models[tier] !== null;

  if (hasKey !== hasModel) {
    throw new Error(
      `The ${tier} tier is half configured: ${hasKey ? keyVar : modelVar} is set but ` +
        `${hasKey ? modelVar : keyVar} is not. Set both, or neither — leaving a tier ` +
        'entirely unset is supported and makes its routes answer 503 rather than fail ' +
        'on the first request.',
    );
  }
}

/**
 * The model id for a tier, or a thrown error naming what is missing.
 *
 * Never returns a placeholder. A default id here would send a request that the
 * provider rejects for a reason unrelated to the real problem.
 */
/**
 * The API key a provider needs, or null when it is not configured.
 *
 * Keyed by provider rather than assumed, because "is this tier usable" stopped
 * meaning "is the Anthropic key set" the moment a second adapter existed. A
 * bulk tier on Groq with no Anthropic key at all is a fully working
 * configuration, and the guard that used to refuse it was asking the wrong
 * question.
 */
export function apiKeyForProvider(id: string): string | null {
  switch (id) {
    case 'anthropic':
      return config.anthropicApiKey;
    case 'groq':
      return config.groqApiKey;
    case 'gemini':
      return config.geminiApiKey;
    default:
      return null;
  }
}

export function modelForTier(tier: ModelTier): string {
  const model = config.models[tier];
  if (model === null) {
    throw new Error(
      `No ${tier} model is configured. Set ANTHROPIC_API_KEY, MODEL_EVALUATION and ` +
        'MODEL_BULK, or use a route that does not need a model.',
    );
  }
  return model;
}

export function estimateCostUsd(
  tier: ModelTier,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = config.pricing[tier];
  return (
    (inputTokens / 1_000_000) * price.inputPerMTok +
    (outputTokens / 1_000_000) * price.outputPerMTok
  );
}
