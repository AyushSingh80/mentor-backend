/**
 * The POST /ca/digest request body, assembled.
 *
 * ## Why this is its own module
 *
 * It was five lines inside `runDailyDigest`, and being inside `ca-digest.ts`
 * meant no test could reach it: that file imports `@/db/ca` and `@/lib/ca-api`,
 * so anything importing it pulls in expo-sqlite and React Native and will not
 * load under Node. The wire body was therefore the one part of Phase 4 with no
 * test at all — and it was wrong. Every field name differed from what the
 * server read, and `/ca/digest` answered 400 to every request ever made while
 * both packages' suites were green.
 *
 * Splitting it out is what makes `tests/ca-request-contract.test.ts` able to
 * assert against the REAL builder rather than a restatement of it that could
 * drift the same way the wire did.
 *
 * ## What the server does with this
 *
 * `parseCaBody` in `server/src/routes/ca.ts` reads `vocabulary` and derives its
 * allowlist from it. Everything else is either a scalar it range-checks or a
 * list it seeds a cap from. There is no field here the server invents a default
 * for that matters, and none it silently ignores except the three named in the
 * contract test.
 */

import { digestBudget } from '@/lib/ca-budget';
import { tagVocabulary, type TagFact } from '@/lib/ca-tags';
import type { CaDigestRequest } from '@/lib/ca-api';

/**
 * The prompt cohort this build asks for.
 *
 * Recorded on `ca_digests.prompt_version` for every run, which is what makes a
 * bad cohort retroactively findable: an item written under a prompt that turned
 * out to over-claim its Anthropology links is not one bad item, it is a month
 * of them, and the digest row is the only handle on the set.
 *
 * The SERVER computes its own version from its prompt files' hashes and reports
 * that on the `meta` frame. Two values, deliberately: this one is what the
 * client believes it asked for.
 */
export const CA_PROMPT_VERSION = 'ca-digest-v1';

/**
 * Day of the week for a calendar-day label, JS `Date.getDay()` convention.
 *
 * The day string is already local — anchoring it at UTC midnight is arithmetic
 * on a label, never a claim about an instant. Same device `syllabus-coverage.ts`
 * uses, and for the same reason: a comparison that went through local `Date`
 * parsing could be inverted by a format mismatch.
 *
 * `-1` for an unparseable day, which `digestBudget` reads as "not Saturday" and
 * therefore as the smaller cap.
 */
function dayOfWeek(day: string): number {
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) return -1;
  return new Date(ms).getUTCDay();
}

/**
 * How many items to ask the server for.
 *
 * Delegates to `digestBudget` rather than re-deciding. It had its own weekend
 * rule until an integration test put the two side by side: this one called
 * Sunday a weekend and asked for eight, while the budget module deliberately
 * gives Sunday the WEEKDAY cap — Sunday already carries a timed answer set and
 * the lecture-backlog catch-up, and `ca-budget.ts` argues at length that it is
 * the worst day of the week to hand a bigger pile of reading. Two modules, two
 * answers, and the one that sized the actual request was the wrong one.
 *
 * `recentReadRate` comes from `readRate` over the trailing fortnight. Passing
 * it is what connects the feedback loop: below `CA_RULES.readRateFloor` the cap
 * drops by one, so a digest she has stopped finishing gets smaller instead of
 * accumulating unread. `null` means no evidence yet and never shrinks it.
 */
export function itemCapFor(day: string, recentReadRate: number | null = null): number {
  return digestBudget({ dayOfWeek: dayOfWeek(day), recentReadRate }).items;
}

export interface DigestRequestInput {
  requestId: string;
  /** True when re-attaching to a request the server may already have run. */
  resume: boolean;
  /** The local calendar day this digest belongs to, `YYYY-MM-DD`. */
  date: string;
  timezone: string;
  maxItems: number;
  /** Syllabus rows. The vocabulary and the tag index are built from these. */
  tagFacts: readonly TagFact[];
  knownCanonicalUrls: readonly string[];
  /**
   * `storyFingerprint` values, NOT `headlineFingerprint` ones.
   *
   * The server puts these in a Set and tests its own sorted-stem fingerprint
   * for membership. The device's 64-bit hash can never match that, and sending
   * it meant the server's cross-request duplicate rule silently never fired.
   */
  knownStoryFingerprints: readonly string[];
  sectionCountsThisWeek: Readonly<Record<string, number>>;
}

/**
 * Assemble the body. Pure: same input, same bytes.
 *
 * The arrays are copied rather than passed through. `streamCaDigest` calls
 * `JSON.stringify` on this object at an `await` boundary, so a caller that
 * mutated its own context afterwards would change what went on the wire.
 */
export function buildDigestRequest(input: DigestRequestInput): CaDigestRequest {
  return {
    requestId: input.requestId,
    resume: input.resume,
    date: input.date,
    timezone: input.timezone,
    maxItems: input.maxItems,
    // The app ships the vocabulary and the server is constrained to it. See
    // the header of `ca-tags.ts` for why the taxonomy cannot have two owners.
    vocabulary: tagVocabulary(input.tagFacts),
    seenCanonicalUrls: [...input.knownCanonicalUrls],
    seenFingerprints: [...input.knownStoryFingerprints],
    sectionCountsThisWeek: { ...input.sectionCountsThisWeek },
    linkAnthropology: true,
    promptVersion: CA_PROMPT_VERSION,
  };
}
