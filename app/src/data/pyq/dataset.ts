/**
 * The shipped past-question dataset.
 *
 * **Empty, and that is the correct state for this phase.** The format, the
 * planner, the migration and the executor are what Phase 1 delivers; extraction
 * is human work that happens against real papers with a real answer key in
 * hand. Nothing in this repository may write question content into this file —
 * a fabricated stem with a plausible key is precisely the artefact the whole
 * verification apparatus in `types.ts` exists to keep out of the bank, and it
 * would be indistinguishable from a real one by inspection.
 *
 * An empty dataset is also a live test of the importer's most important
 * property: `ensurePyqImported` runs on every launch, finds nothing wanted and
 * nothing held, and performs zero writes.
 *
 * ## Adding a set
 *
 * 1. Extract one booklet, with its printed question numbers.
 * 2. Check every key against a published key and fill in `verification`.
 *    Leaving it null is not a draft state — the planner refuses the set.
 * 3. Record every question you could not represent in `dropped`, with a reason.
 * 4. Bump `version`.
 */

import type { PyqDataset, PyqExternalIdRename, PyqSet } from './types';

/** No paper has been extracted and verified yet. See the header. */
const SETS: readonly PyqSet[] = [];

/**
 * Empty at v1, and must stay in step with any id-scheme change made afterwards.
 *
 * A corrected stem or a corrected key needs no entry here — matching on the
 * external id already handles both. An entry is needed only when an id ITSELF
 * changes. Annotated rather than left to inference so the first rename anyone
 * adds is type-checked against `PyqExternalIdRename` instead of widening a
 * `never[]`.
 */
const RENAMES: readonly PyqExternalIdRename[] = [];

export const PYQ_DATASET_V1 = {
  version: 1,
  sets: SETS,
  renames: RENAMES,
} satisfies PyqDataset;
