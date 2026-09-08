/**
 * The stateful side of deduplication: what has already been seen.
 *
 * Seeded from what the phone already holds (`excludeFactKeys`,
 * `excludeStemHashes`) and then grown as the batch runs, so chunk 4 cannot
 * hand back a reworded version of a question chunk 1 already delivered — which
 * is exactly what happens without it, because each chunk is an independent
 * model call with no memory of its siblings.
 */

import {
  SIMHASH_MAX_DISTANCE,
  hammingDistance,
  normaliseFactKey,
  simHash64,
  simHashFromHex,
  stemHash,
} from './dedupe.js';

export type DuplicateKind = 'duplicate_fact' | 'duplicate_stem' | 'near_duplicate';

export interface DuplicateHit {
  kind: DuplicateKind;
  detail: string;
}

export interface BankIndexSeed {
  factKeys?: readonly string[];
  stemHashes?: readonly string[];
  /**
   * Optional 16-hex SimHashes of questions already banked.
   *
   * The request contract does not carry these today, so cross-session
   * near-duplicate detection is limited to what the factKey catches, and
   * SimHash works within a batch. The parameter exists so that becomes a
   * one-line change on the app side rather than a redesign here.
   */
  simHashes?: readonly string[];
}

export class BankIndex {
  readonly #factKeys = new Set<string>();
  readonly #stemHashes = new Set<string>();
  readonly #simHashes: bigint[] = [];

  constructor(seed: BankIndexSeed = {}) {
    for (const key of seed.factKeys ?? []) {
      if (typeof key === 'string' && key.trim() !== '') this.#factKeys.add(normaliseFactKey(key));
    }
    for (const hash of seed.stemHashes ?? []) {
      if (typeof hash === 'string' && hash.trim() !== '') this.#stemHashes.add(hash.trim());
    }
    for (const hex of seed.simHashes ?? []) {
      // A malformed value from the client must not take the request down; a
      // dropped seed only weakens dedup, and the factKey path still holds.
      try {
        this.#simHashes.push(simHashFromHex(hex));
      } catch {
        continue;
      }
    }
  }

  get size(): number {
    return this.#stemHashes.size;
  }

  /** First duplicate signal, or null. Checked cheapest-first. */
  find(input: { stem: string; factKey: string }): DuplicateHit | null {
    const key = normaliseFactKey(input.factKey);
    if (this.#factKeys.has(key)) {
      return { kind: 'duplicate_fact', detail: `factKey already banked: ${key}` };
    }

    const hash = stemHash(input.stem);
    if (this.#stemHashes.has(hash)) {
      return { kind: 'duplicate_stem', detail: `stem already banked: ${hash}` };
    }

    const sim = simHash64(input.stem);
    for (const existing of this.#simHashes) {
      const distance = hammingDistance(sim, existing);
      if (distance <= SIMHASH_MAX_DISTANCE) {
        return { kind: 'near_duplicate', detail: `SimHash distance ${distance}` };
      }
    }

    return null;
  }

  /** Commits a question so later chunks in the same batch can see it. */
  add(input: { stem: string; factKey: string }): void {
    this.#factKeys.add(normaliseFactKey(input.factKey));
    this.#stemHashes.add(stemHash(input.stem));
    this.#simHashes.push(simHash64(input.stem));
  }
}
