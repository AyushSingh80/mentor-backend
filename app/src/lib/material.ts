/**
 * Choosing which of her stored material to put in front of a drill.
 *
 * Pure. `db/material.ts` reads the rows.
 *
 * ## What this is for
 *
 * The essay rubric gives quotes, examples and anecdotes 10%, which understates
 * them badly: their absence is what makes an essay read as a competent GS answer
 * with a longer introduction, and that is the single most common diagnosis the
 * rubric asks the evaluator to give. But the failure is never "she had no
 * material" — it is that the specific example she read in October did not come
 * to mind in June.
 *
 * ## Why the ranking is biased toward the FORGOTTEN
 *
 * A quote used in four essays is one she reaches for automatically. Surfacing it
 * a fifth time costs a slot and teaches nothing; surfacing the one she has never
 * used is the whole point of keeping a bank. So use count sorts ASCENDING, which
 * is the opposite of what a "most relevant" list would do and is deliberate.
 *
 * ## Why suggestions are never a requirement
 *
 * Five items, offered. An essay written to fit the quotes it was handed is the
 * tail wagging the dog, and the rubric is explicit that a decorative or
 * misattributed quote costs more than it gains. Nothing in the submit gate ever
 * checks whether she used one.
 */

import { DRILL_RULES, type MaterialFacts, type MaterialKind } from '@/lib/drill-types';

export interface SuggestContext {
  /** The drill's syllabus section, when it resolved. Null widens the net. */
  syllabusTopicId: number | null;
  /**
   * Every topic id in the same section as the drill's.
   *
   * A section, not a leaf: material filed under "Environment and Sustainability"
   * is relevant to any essay in that cluster, and matching on the exact leaf
   * would surface almost nothing.
   */
  siblingTopicIds: readonly number[];
  /** How many to offer. Defaults to `DRILL_RULES.materialSuggestions`. */
  limit?: number;
}

export interface MaterialSuggestion {
  material: MaterialFacts;
  /** Why it was surfaced. Shown, so a suggestion is never mysterious. */
  reason: string;
}

/** Rank buckets, best first. Lower sorts earlier. */
const ON_TOPIC = 0;
const SAME_SECTION = 1;
const UNUSED_ANYWHERE = 2;
const GENERAL = 3;

function relevance(material: MaterialFacts, ctx: SuggestContext): number {
  const topicId = material.syllabusTopicId;

  if (topicId !== null && ctx.syllabusTopicId !== null && topicId === ctx.syllabusTopicId) {
    return ON_TOPIC;
  }
  if (topicId !== null && ctx.siblingTopicIds.includes(topicId)) return SAME_SECTION;
  // Untagged material that has never been used outranks tagged material that
  // has: an unused item is the one she has forgotten, and a bank whose untagged
  // half is never surfaced quietly becomes a bank half the size.
  if (topicId === null && material.timesUsed === 0) return UNUSED_ANYWHERE;
  return GENERAL;
}

function reasonFor(rank: number, material: MaterialFacts): string {
  if (rank === ON_TOPIC) return 'Filed under this exact topic.';
  if (rank === SAME_SECTION) return 'Filed elsewhere in this section.';
  if (material.timesUsed === 0) return 'You have never used this one.';
  return `Used ${material.timesUsed} time${material.timesUsed === 1 ? '' : 's'} before.`;
}

/**
 * The material worth putting in front of this drill.
 *
 * Deterministic: relevance, then fewest uses, then least recently used, then id.
 * Two calls with the same bank return the same list in the same order, so a
 * screen re-render never reshuffles the suggestions under her.
 */
export function suggestMaterial(
  bank: readonly MaterialFacts[],
  ctx: SuggestContext,
): MaterialSuggestion[] {
  const limit = Math.max(0, Math.floor(ctx.limit ?? DRILL_RULES.materialSuggestions));
  if (limit === 0) return [];

  const ranked = bank
    .map((material) => ({ material, rank: relevance(material, ctx) }))
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      // Ascending: the forgotten one is the one worth surfacing.
      if (a.material.timesUsed !== b.material.timesUsed) {
        return a.material.timesUsed - b.material.timesUsed;
      }
      // Never used sorts before used-long-ago; both before used-recently.
      const aUsed = a.material.lastUsedAt ?? '';
      const bUsed = b.material.lastUsedAt ?? '';
      if (aUsed !== bUsed) return aUsed < bUsed ? -1 : 1;
      return a.material.id - b.material.id;
    });

  return ranked
    .slice(0, limit)
    .map(({ material, rank }) => ({ material, reason: reasonFor(rank, material) }));
}

/* ------------------------------------------------------------------ counts */

export type MaterialTally = Readonly<Record<MaterialKind, number>>;

/**
 * How much of each kind she holds.
 *
 * Shown on the bank screen because the shape of the bank is itself a diagnosis:
 * forty quotes and two examples is a bank that will produce decorative essays,
 * which is precisely what the rubric penalises.
 */
export function tallyByKind(bank: readonly MaterialFacts[]): MaterialTally {
  const tally: Record<string, number> = {
    quote: 0,
    example: 0,
    anecdote: 0,
    thinker: 0,
    data: 0,
  };
  for (const material of bank) {
    if (material.kind in tally) tally[material.kind] = (tally[material.kind] ?? 0) + 1;
  }
  return tally as MaterialTally;
}

/**
 * The one sentence worth saying about the bank's shape, or null.
 *
 * Null when there is nothing actionable — an app that always has an opinion is
 * one whose opinions stop being read. The thresholds are deliberately loose:
 * this is a nudge, not a rule, and the bank is hers.
 */
export function bankDiagnosis(tally: MaterialTally): string | null {
  const total = Object.values(tally).reduce((sum, n) => sum + n, 0);
  if (total < 10) return null;

  const concrete = tally.example + tally.anecdote + tally.data;
  if (concrete * 3 < total) {
    return (
      'Mostly quotes and thinkers. An essay built from those reads as decorative — ' +
      'the rubric wants specific examples doing real work in the argument.'
    );
  }

  if (tally.quote === 0) {
    return 'No quotes yet. One well-placed line in an opening is worth the shelf space.';
  }

  return null;
}
