/**
 * Turning one `POST /ca/headlines` response into the frames the digest
 * orchestrator expects.
 *
 * Pure, and separate from `ca-api.ts` for the reason the whole codebase splits
 * this way: `ca-api.ts` imports `expo/fetch` and `expo-secure-store` and
 * therefore cannot load under Node, so nothing in it can be tested. The fetch
 * is three lines and uninteresting. The interesting part is everything here —
 * delivery order, the terminal frame, what the summary claims, and what must
 * NOT be emitted — and all of it is a function of a JSON document.
 *
 * ## The property this file exists to hold
 *
 * `ca-digest.ts` must not be able to tell the two transports apart. It owns the
 * mapper, the duplicate window and the per-item write, and a replay that
 * delivered items out of order, skipped `onDone`, or emitted a usage frame for
 * a call that never happened would corrupt state it is responsible for —
 * silently, because none of that surfaces as an error.
 */

/**
 * `import type`, which esbuild erases entirely — so this module keeps NO
 * runtime dependency on `ca-api.ts` and stays loadable under Node. A value
 * import of the same names would pull in `expo/fetch` and make this file
 * untestable, which is the whole reason it was split out.
 */
import type { CaDigestSummary, CaSourceFailure } from './ca-api';

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Raw items, in the order the server ranked them. Never reordered here. */
export function headlineItems(body: unknown): unknown[] {
  const record = asRecord(body);
  return Array.isArray(record.items) ? record.items : [];
}

export function headlineSourceFailures(body: unknown): CaSourceFailure[] {
  const record = asRecord(body);
  const raw = Array.isArray(record.sourceFailures) ? record.sourceFailures : [];
  return raw.map((entry) => {
    const failure = asRecord(entry);
    return {
      url: optionalText(failure.url) ?? '',
      feedId: optionalText(failure.feedId),
      reason: optionalText(failure.reason) ?? 'unknown',
      detail: optionalText(failure.detail) ?? '',
    };
  });
}

/**
 * The summary frame for a headline sweep.
 *
 * Three of these fields are deliberately not what the streaming path reports,
 * and each one is a claim this mode is not entitled to make:
 *
 *  - `shortlisted` equals `considered`. Every swept entry was scored; there is
 *    no separate shortlist call to narrow to, and inventing a stage would make
 *    the funnel on screen describe a pipeline that did not run.
 *  - `dropReasons` is empty. The server's own drops — stale, over source cap —
 *    are about RANKING, not quality. Rendered beside the digest's quality
 *    reasons they would read as "fifty items failed a check", which is both
 *    false and discouraging.
 *  - `anthroLinkRate` is zero because no model claimed a link, not because
 *    every claim was rejected. Zero is the truthful number either way, and
 *    `anthroLinkRateIsSuspicious` is testing a prompt that is not running.
 */
export function headlineSummary(body: unknown, maxItems: number): CaDigestSummary {
  const record = asRecord(body);
  const items = headlineItems(body);
  const considered = typeof record.considered === 'number' ? record.considered : items.length;

  return {
    considered,
    shortlisted: considered,
    kept: items.length,
    dropped: Math.max(0, considered - items.length),
    dropReasons: {},
    anthroLinkRate: 0,
    sourceFailures: headlineSourceFailures(body),
    // Fewer than asked for is a normal outcome, not a failure — but it must be
    // SAID, because a short digest with no explanation reads as a broken one.
    underDelivered: items.length < maxItems,
  };
}
