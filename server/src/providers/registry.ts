/**
 * Which provider serves which tier, decided once at boot.
 *
 * `PROVIDER_EVALUATION` and `PROVIDER_BULK` name a provider per tier and both
 * default to `anthropic`, so a deployment that sets neither behaves exactly as
 * it did before this file existed. Per tier rather than one global setting
 * because the destination is two different providers — Gemini for marking her
 * handwriting, Groq for the seven structured calls — and a single knob would
 * make that unrepresentable.
 *
 * ## Everything here throws at BOOT
 *
 * Same rule as `config.ts` and `index.ts`: a misconfiguration must stop the
 * process, not the first request of the day. `PROVIDER_BULK=grok` is a typo
 * that would otherwise surface as a 500 in the middle of a question batch,
 * after the spend reservation has been taken, with a message about an unknown
 * property rather than about the typo.
 *
 * The checks are pure functions called at module scope rather than inline code,
 * because a boot assertion nobody can execute in a test is an assertion that is
 * only ever tried in production. `config.ts` reads `process.env` once at module
 * load — deliberately — so re-importing this module with different variables
 * resolves the same cached values, exactly as `requireCapability` documents.
 */

import { config, type ModelTier } from '../config.js';
import { anthropicProvider } from './anthropic.js';
import { createGeminiProvider } from './gemini.js';
import { createGroqProvider } from './groq.js';
import { PROVIDER_IDS, type EvaluationRunner, type Provider, type ProviderId } from './types.js';

/**
 * Every adapter, keyed by id.
 *
 * `Record<ProviderId, Provider>` and not a looser map: adding 'groq' to
 * `PROVIDER_IDS` without adding the adapter here is a compile error, so the two
 * halves of a Phase 3 change cannot land apart.
 */
const PROVIDERS: Readonly<Record<ProviderId, Provider>> = {
  anthropic: anthropicProvider,
  /**
   * Constructed once, with whatever key is configured.
   *
   * An empty key is allowed here and fails at the provider with a 401 rather
   * than at module load. The boot assertions in `config.ts` are what refuse a
   * half-configured tier; this table's job is only to name every adapter.
   */
  groq: createGroqProvider({ apiKey: config.groqApiKey ?? '' }),
  /** The only provider here that can serve `/evaluate`. See its header. */
  gemini: createGeminiProvider({ apiKey: config.geminiApiKey ?? '' }),
};

const VALID_IDS = PROVIDER_IDS.join(', ');

/**
 * Resolves one env var to one adapter, or throws naming what is wrong.
 *
 * The `fake` case is called out separately and on purpose. Scripted runners
 * exist behind exactly one switch, `EVAL_RUNNER=fake`, which refuses to run in
 * production and prints a banner saying nothing is real. A provider id that
 * also reached them would be a SECOND route to invented scores and invented
 * facts — one with no production guard and no banner — and the whole reason
 * that switch is a single variable is that "set one and forget the other" is
 * how a server ends up looking fake, being billed as real, and banking made-up
 * questions permanently.
 */
export function selectProvider(
  rawId: string,
  envVar: string,
  table: Readonly<Record<string, Provider | undefined>> = PROVIDERS,
): Provider {
  if (rawId === 'fake') {
    throw new Error(
      `${envVar}=fake is refused. Fake runners are not a provider — they are scripted ` +
        'output behind EVAL_RUNNER=fake, which refuses to start in production and says so ' +
        `at boot. Set ${envVar} to one of: ${VALID_IDS}.`,
    );
  }

  const provider = table[rawId];
  if (provider === undefined) {
    throw new Error(`${envVar}=${rawId} is not a known provider. Valid ids: ${VALID_IDS}.`);
  }
  return provider;
}

/**
 * Refuses a provider that cannot do what its tier asks of it.
 *
 * BOTH tiers need `structured`. That is not obvious and is worth stating: the
 * evaluation tier is not only the streaming path — `drills/runner.ts` marks a
 * submitted drill with a STRUCTURED call on `DRILL_EVALUATE_TIER`, which is
 * `'evaluation'`. A provider bound to `PROVIDER_EVALUATION` that could stream
 * but not return JSON would serve marked answers and fail every drill mark.
 */
export function assertTierCapable(tier: ModelTier, provider: Provider, envVar: string): void {
  if (!provider.capabilities.structured) {
    throw new Error(
      `${envVar}=${provider.id} cannot serve the ${tier} tier: it does not support structured ` +
        'output, and every tier has at least one structured call site.',
    );
  }

  // The flag and the implementation must agree, or the check below is theatre:
  // a provider could declare `evaluation: true` and hand `/evaluate` a null.
  if (provider.capabilities.evaluation !== (provider.evaluation !== null)) {
    throw new Error(
      `Provider ${provider.id} is inconsistent: capabilities.evaluation is ` +
        `${provider.capabilities.evaluation} but its evaluation runner is ` +
        `${provider.evaluation === null ? 'null' : 'present'}.`,
    );
  }

  if (tier === 'evaluation' && !provider.capabilities.evaluation) {
    throw new Error(
      `${envVar}=${provider.id} cannot serve the evaluation tier: it has no streaming ` +
        'evaluation runner, and /evaluate streams a marked answer token by token. ' +
        `Bind it to PROVIDER_BULK instead, or set ${envVar} to a provider that can.`,
    );
  }
}

/* --------------------------------------------------------------- resolution */

function resolveTier(tier: ModelTier, envVar: string, rawId: string): Provider {
  const provider = selectProvider(rawId, envVar);
  assertTierCapable(tier, provider, envVar);
  return provider;
}

const selected: Readonly<Record<ModelTier, Provider>> = {
  evaluation: resolveTier('evaluation', 'PROVIDER_EVALUATION', config.providers.evaluation),
  bulk: resolveTier('bulk', 'PROVIDER_BULK', config.providers.bulk),
};

/**
 * Test seam, and the same one the nine runner injection points already use.
 *
 * Not a second route to the fakes: it is a function, not configuration. Nothing
 * in the environment can reach it, so no deployment can be talked into it — the
 * distinction `selectProvider` refuses `fake` to protect.
 */
const overrides: Record<ModelTier, Provider | null> = { evaluation: null, bulk: null };

export function setProviderForTier(tier: ModelTier, provider: Provider | null): void {
  // Validated on the way in, so the seam cannot install something boot would
  // have refused. A test double that quietly lacks what its tier needs would
  // make the pipeline above it pass against a provider that could never ship.
  if (provider !== null) assertTierCapable(tier, provider, `setProviderForTier(${tier})`);
  overrides[tier] = provider;
}

export function providerFor(tier: ModelTier): Provider {
  return overrides[tier] ?? selected[tier];
}

/** Printed in the boot banner, so a mis-set PROVIDER_BULK is never invisible. */
export function providerIdFor(tier: ModelTier): ProviderId {
  return providerFor(tier).id;
}

/**
 * The streaming runner for the evaluation tier.
 *
 * Non-null by construction: `assertTierCapable` refused at boot if it were not.
 * The throw is the assertion of that, not a runtime branch anyone expects to
 * take — an override installed by a test is the only way to reach it.
 */
export function evaluationRunner(): EvaluationRunner {
  const provider = providerFor('evaluation');
  if (provider.evaluation === null) {
    throw new Error(`Provider ${provider.id} has no evaluation runner.`);
  }
  return provider.evaluation;
}
