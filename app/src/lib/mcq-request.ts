/**
 * The POST /mcq/generate request body, assembled.
 *
 * ## Why this is its own module
 *
 * Identical reasoning to `ca-request.ts`, and it was written after the same bug
 * was found in both. The assembly lived inside `runBankRefill`, and that file
 * imports `@/db/*` and `@/lib/mcq-api`, so anything importing it pulls in
 * expo-sqlite and React Native and will not load under Node. The wire body was
 * therefore the one part of Phase 3 with no test at all — and it was wrong.
 * `/mcq/generate` answered 400 to every request ever made while both packages'
 * suites were green.
 *
 * Splitting it out is what lets `tests/mcq-request-contract.test.ts` assert
 * against the REAL builder rather than a restatement of it that could drift the
 * same way the wire did.
 *
 * ## The unit of work
 *
 * The app plans in SECTIONS and the server generates per TOPIC. That is not a
 * disagreement to be resolved by making one side match the other: both are
 * right for their own job. `BANK_RULES.maxSectionShare` caps any one section at
 * a quarter of a batch, so a 30-question refill always spans four sections or
 * more, and the server's prompt, chunking, fact-key dedup and blind
 * verification are all inherently per-topic. So the body carries the sections
 * and the ROUTE loops them — one reservation, one stream, one ledger row.
 */

import type { McqGenerateRequest, McqGenerateSection } from '@/lib/mcq-api';
import type { RefillPlan, SectionDemand } from '@/lib/mcq-types';

/**
 * The prompt cohort this build asks for.
 *
 * Recorded on the refill ledger row for every batch, which is what makes a bad
 * cohort retroactively purgeable: find the refills generated under this string,
 * take their batch ids, quarantine those questions. `mcq_questions` has no
 * `prompt_version` column and the schema is frozen, so the join is the handle.
 *
 * Here rather than in `mcq-api.ts` for the same reason `CA_PROMPT_VERSION` sits
 * in `ca-request.ts`: that module imports `expo/fetch`, so a VALUE imported
 * from it drags React Native into anything that touches it and the contract
 * test cannot load. The type imports above are erased and stay put.
 */
export const MCQ_PROMPT_VERSION = 'mcq-prelims-v1';

/**
 * Quota lines to wire sections, resolved against the sections they name.
 *
 * A quota carries only a key, a count and a sentence; the paper, label and leaf
 * list live on the demand row. Joining them here rather than in the planner
 * keeps the plan a pure statement of intent that a test can read.
 */
export function toRequestSections(
  plan: RefillPlan,
  sections: readonly SectionDemand[],
): McqGenerateSection[] {
  const byKey = new Map(sections.map((section) => [section.sectionKey, section] as const));

  return plan.quotas.map((quota) => {
    const section = byKey.get(quota.sectionKey);
    return {
      sectionKey: quota.sectionKey,
      syllabusSlug: quota.syllabusSlug,
      // The whole section travels, not just its anchor leaf: a quota of twelve
      // aimed at one leaf produces twelve questions about one bullet point.
      syllabusSlugs: section?.syllabusSlugs ?? [quota.syllabusSlug],
      paper: section?.paper ?? '',
      label: section?.label ?? quota.sectionKey,
      count: quota.count,
      reason: quota.reason,
    };
  });
}

export interface GenerateRequestInput {
  requestId: string;
  /** True when re-attaching to a request the server may already have run. */
  resume: boolean;
  plan: RefillPlan;
  /** The demand rows the plan's quotas name. */
  sections: readonly SectionDemand[];
}

/**
 * Assemble the body. Pure: same input, same bytes.
 *
 * `excludeStemHashes` is copied rather than passed through, for the reason
 * `buildDigestRequest` gives: `generateMcqs` stringifies this object at an
 * `await` boundary, so a caller mutating its own plan afterwards would change
 * what went on the wire.
 */
export function buildGenerateRequest(input: GenerateRequestInput): McqGenerateRequest {
  return {
    requestId: input.requestId,
    resume: input.resume,
    batchSize: input.plan.batchSize,
    sections: toRequestSections(input.plan, input.sections),
    excludeStemHashes: [...input.plan.excludeStemHashes],
    promptVersion: MCQ_PROMPT_VERSION,
    rationale: input.plan.rationale,
  };
}
