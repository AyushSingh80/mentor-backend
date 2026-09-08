/**
 * Refusing a request the server already knows it cannot serve.
 *
 * ## The gap this closes
 *
 * `config.ts` claimed, in a comment, that "every paid feature needs it and
 * refuses without it — see `requireModel` in `app.ts`". There was no
 * `requireModel`, in `app.ts` or anywhere else. What actually happened with no
 * model configured was worse than a missing guard: `/mcq/generate` parsed the
 * body, TOOK A SPEND RESERVATION, opened an SSE stream, and only then reached
 * `modelForTier()` and threw. The reservation was released in `finally` so
 * nothing leaked, but the user saw "Question generation failed. Check the
 * server logs" for a condition that was decided at boot.
 *
 * ## Why it runs before `capFastFail`
 *
 * Order matters and it is the same argument the spend caps already make. A
 * request that cannot be served must not reserve budget, must not open a
 * stream, and must not touch the ledger. "No model" is knowable without any
 * I/O at all, so it is the cheapest check available and belongs first.
 *
 * ## Why 503 and not 501 or 400
 *
 * 503 says "this server, right now, cannot do this" — which is exactly true and
 * exactly recoverable: configure a provider and it works, with no client change.
 * 501 would claim the feature is unimplemented, and 400 would blame the request,
 * which is correct in neither case and would send someone debugging the app.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { apiKeyForProvider, config, type ModelTier } from './config.js';
import { providerIdFor } from './providers/registry.js';

/** Whether a tier has everything it needs to make a model call. */
export function tierConfigured(tier: ModelTier): boolean {
  // The TIER'S OWN provider's key, not the Anthropic one. Before a second
  // adapter existed those were the same question; now a bulk tier running on
  // Groq with no Anthropic key configured is a perfectly working setup, and
  // asking the old question would refuse every bulk request on it.
  const key = apiKeyForProvider(providerIdFor(tier));
  return key !== null && config.models[tier] !== null;
}

/**
 * The body a refused request receives.
 *
 * `tier` travels so the app can say WHICH capability is missing — answer
 * evaluation and question banking are configured separately and a user who has
 * one but not the other should not be told a flat "no model".
 */
export interface CapabilityRefusal {
  error: 'model_not_configured';
  tier: ModelTier;
  detail: string;
}

const DETAIL: Readonly<Record<ModelTier, string>> = {
  evaluation:
    'Answer and drill marking needs an evaluation-tier model. Set the provider key and MODEL_EVALUATION on the server.',
  bulk: 'This needs a bulk-tier model. Set the provider key and MODEL_BULK on the server.',
};

/**
 * Refuses with 503 when the tier has no model.
 *
 * Deliberately NOT a boot-time refusal to start. A server with no model still
 * serves the syllabus, the rubric versions, the usage ledger and the whole
 * current-affairs headlines path, and refusing to boot would take all of that
 * down over a capability most requests never use. Fail loudly, but fail at the
 * edge of the feature that needs it.
 */
export function requireCapability(
  tier: ModelTier,
  /**
   * Injected so the refusal path is testable at all.
   *
   * `config.ts` reads `process.env` once at module load, which is deliberate —
   * it is what makes misconfiguration a boot failure. The consequence is that a
   * test cannot re-evaluate it: deleting the env vars and re-importing this
   * module still resolves the CACHED `config`, so the guard reports configured
   * and the refusal branch is never reached. A predicate parameter is the same
   * seam the nine runner injection points already use, for the same reason.
   */
  isConfigured: (tier: ModelTier) => boolean = tierConfigured,
): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction) => {
    if (isConfigured(tier)) {
      next();
      return;
    }
    const body: CapabilityRefusal = {
      error: 'model_not_configured',
      tier,
      detail: DETAIL[tier],
    };
    res.status(503).json(body);
  };
}
