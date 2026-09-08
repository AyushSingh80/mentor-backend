/**
 * The two drill request bodies, assembled.
 *
 * Its own module for the reason `ca-request.ts` and `mcq-request.ts` both give,
 * and this time before the bug rather than after it: the assembly's natural
 * home is the refill runner, that file imports `@/db/*` and `@/lib/drill-api`,
 * and anything importing it pulls in expo-sqlite and React Native and will not
 * load under Node. A wire body that no test can reach is a wire body that ships
 * wrong — twice now.
 *
 * So the builders live here, pure, and `tests/drill-contract.test.ts` asserts
 * against these functions rather than against a restatement of them.
 */

import type {
  DrillVocabularyEntry,
  EvaluateDrillRequest,
  GeneratePromptsRequest,
} from '@/lib/drill-api';
import type { DrillKind, DrillPartFacts } from '@/lib/drill-types';
import { PARTS_OF_KIND } from '@/lib/drill-types';

/**
 * The prompt cohort this build asks for.
 *
 * Echoed onto `drills.prompt_version` so a bad cohort is retroactively
 * findable: find the drills banked under this string, take their batch ids,
 * discard those prompts. The SERVER computes its own from its prompt files'
 * hashes and returns that on the response; two values on purpose, and this one
 * says what the client believed it was asking for.
 *
 * Here rather than in `drill-api.ts` because that module imports `expo/fetch`,
 * so a VALUE imported from it drags React Native into anything that touches it.
 * The type imports above are erased and stay put.
 */
export const DRILL_PROMPT_VERSION = 'drills-v1';

export interface GenerateRequestInput {
  requestId: string;
  /** From `refillTargets`. Kinds with a count of zero are dropped, not sent. */
  want: readonly { kind: DrillKind; count: number }[];
  /** Syllabus rows offered as tags. See `drill-vocabulary`. */
  vocabulary: readonly DrillVocabularyEntry[];
  /** Prompt texts already banked on the device. */
  bankedPrompts: readonly string[];
}

/**
 * Assemble the generation body. Pure: same input, same bytes.
 *
 * Arrays are copied rather than passed through, for the reason
 * `buildDigestRequest` gives: the caller stringifies this at an `await`
 * boundary, so a context mutated in between would change what went on the wire.
 */
export function buildGeneratePromptsRequest(
  input: GenerateRequestInput,
): GeneratePromptsRequest {
  return {
    requestId: input.requestId,
    // A zero count is refused by the server as a bad request, and rightly:
    // asking for none of something is not a request, it is a bug upstream.
    want: input.want.filter((entry) => entry.count > 0).map((entry) => ({ ...entry })),
    vocabulary: input.vocabulary.map((entry) => ({ ...entry })),
    excludePrompts: [...input.bankedPrompts],
    promptVersion: DRILL_PROMPT_VERSION,
  };
}

export interface EvaluateRequestInput {
  requestId: string;
  kind: DrillKind;
  promptText: string;
  caseDetail: string | null;
  parts: readonly DrillPartFacts[];
}

/**
 * Assemble the marking body.
 *
 * Parts are emitted in DECLARED order and trimmed. The server refuses a
 * submission whose part count does not match the kind, so ordering them here
 * rather than trusting the caller's array means a screen that renders parts in
 * a different order — or writes them to the database out of order — cannot
 * produce a mark sheet whose rows do not line up with what she wrote.
 */
export function buildEvaluateDrillRequest(input: EvaluateRequestInput): EvaluateDrillRequest {
  const byPart = new Map(input.parts.map((entry) => [entry.part, entry] as const));

  return {
    requestId: input.requestId,
    kind: input.kind,
    promptText: input.promptText.trim(),
    // Normalised to null, because the server treats an empty string as a
    // missing case detail and would refuse an ethics case carrying one.
    caseDetail:
      input.caseDetail !== null && input.caseDetail.trim() !== '' ? input.caseDetail.trim() : null,
    parts: PARTS_OF_KIND[input.kind]
      .map((part) => ({ part, content: byPart.get(part)?.content.trim() ?? '' }))
      .filter((entry) => entry.content !== ''),
  };
}
