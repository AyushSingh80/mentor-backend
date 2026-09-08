/**
 * Syllabus seeding as a pure diff. No RN, no expo-sqlite.
 *
 * SKELETON: types are FROZEN. Bodies are owned by the syllabus agent.
 *
 * ## Why this is a pure diff and not a repository method
 *
 * This is the subtlest correctness problem in Phase 2. The syllabus ships as
 * seed data and WILL be corrected over eighteen months — a typo fixed, a
 * bullet split in two, an obsolete topic dropped. Every one of those edits is
 * a chance to silently destroy months of self-assessment. Making the diff pure
 * means the dangerous decisions are unit-testable without a database.
 *
 * ## The rules, in order
 *
 * 1. **Renames first.** An explicit `{fromSlug, toSlugs[]}` carries `status`,
 *    `confidence`, `firstPassAt` and `revisedAt` across, then tombstones the old.
 * 2. **Insert** entries whose slug is absent.
 * 3. **Update** matched entries — setting ONLY `paper`, `topic`, `subtopic`,
 *    `position`. Never status, never confidence, never the timestamps. **This
 *    single rule is the entire wipe-prevention story.**
 * 4. **Revive** a matched row whose `retiredAt` is set.
 * 5. **Tombstone** rows whose slug is absent from the dataset. Never DELETE:
 *    deleting cascades the topic's `revision_queue` row away, destroying its
 *    review history, and NULLs `syllabus_topic_id` on every lecture and
 *    evaluated answer that referenced it.
 * 6. **Emit nothing when nothing differs**, so a steady-state launch performs
 *    zero writes and does not churn every `useLiveQuery` in the app.
 *
 * There is deliberately no `seed_version` column. A version gate would have to
 * live on `profile`, which does not exist before onboarding — a chicken-and-egg
 * with the first-run gate in `_layout.tsx`. A field-by-field diff over ~450
 * rows is one SELECT and a few milliseconds, and it self-heals if a previous
 * write was ever interrupted.
 */

import type { PaperValue } from '@/lib/papers';

export interface SyllabusSeedEntry {
  /** Stable identity, independent of wording. See `syllabusTopics.slug`. */
  slug: string;
  paper: PaperValue;
  /** The section, e.g. "Indian Society". Grouping key for section coverage. */
  topic: string;
  /** The leaf bullet. Null when the topic itself is the leaf. */
  subtopic: string | null;
  position: number;
}

export interface SyllabusRename {
  fromSlug: string;
  /** More than one when a bullet was split. Status carries to all of them. */
  toSlugs: string[];
}

export interface SyllabusDataset {
  version: number;
  entries: readonly SyllabusSeedEntry[];
  renames: readonly SyllabusRename[];
}

export interface ExistingTopic {
  id: number;
  slug: string;
  paper: string;
  topic: string;
  subtopic: string | null;
  position: number;
  status: string;
  confidence: number | null;
  firstPassAt: string | null;
  revisedAt: string | null;
  retiredAt: string | null;
}

export interface SeedPlan {
  insert: SyllabusSeedEntry[];
  /** Display fields only — never status, confidence or timestamps. */
  update: { id: number; entry: SyllabusSeedEntry }[];
  tombstone: number[];
  revive: number[];
  carryOver: { fromId: number; toSlug: string }[];
  unchanged: number;
}

/**
 * True when a row still holds no self-assessment whatsoever.
 *
 * Guards the one direction rule 1 could destroy data in. A rename carries
 * status onto its target, so if the target already exists and already carries
 * progress, carrying over would OVERWRITE it — the exact wipe this module
 * exists to prevent, just arriving from the other side. A pristine target has
 * nothing to lose, so the carry is free; anything else is left alone.
 */
function isPristine(row: ExistingTopic): boolean {
  return (
    row.status === 'not_started' &&
    row.confidence === null &&
    row.firstPassAt === null &&
    row.revisedAt === null
  );
}

/**
 * The four display fields — the only ones an update may ever touch.
 *
 * Rule 3 in one function. Every field NOT compared here is a field the seed
 * has no opinion about, and the update statement must not name it.
 */
function displayDiffers(row: ExistingTopic, entry: SyllabusSeedEntry): boolean {
  return (
    row.paper !== entry.paper ||
    row.topic !== entry.topic ||
    row.subtopic !== entry.subtopic ||
    row.position !== entry.position
  );
}

export function planSeed(existing: ExistingTopic[], dataset: SyllabusDataset): SeedPlan {
  const plan: SeedPlan = {
    insert: [],
    update: [],
    tombstone: [],
    revive: [],
    carryOver: [],
    unchanged: 0,
  };

  // Both sides indexed by slug — the only identity that survives a reword.
  // First-wins on a repeat: `syllabus_topics.slug` is uniquely indexed so the
  // left side cannot actually collide, and a collision on the right is a
  // dataset bug the unit tests catch. Silently dropping the duplicate beats
  // failing the transaction on a cold start and leaving the app unusable.
  const bySlug = new Map<string, ExistingTopic>();
  for (const row of existing) if (!bySlug.has(row.slug)) bySlug.set(row.slug, row);

  const wanted = new Map<string, SyllabusSeedEntry>();
  for (const entry of dataset.entries) if (!wanted.has(entry.slug)) wanted.set(entry.slug, entry);

  /* -- 1. Renames first, so a reworded bullet keeps its months of history. -- */

  const renameTargets = new Map<string, readonly string[]>();
  for (const rename of dataset.renames) {
    if (!renameTargets.has(rename.fromSlug)) renameTargets.set(rename.fromSlug, rename.toSlugs);
  }

  /**
   * Follows a rename chain to the slugs the CURRENT dataset actually contains.
   *
   * Renames accumulate across dataset revisions, and a device does not
   * necessarily see every one. If v2 renames A→B and v3 renames B→C, a phone
   * updating straight from v1 to v3 holds row A and has never held B. Matching
   * hop by hop, neither hop applies — A→B is skipped because B is no longer a
   * live entry, B→C because row B does not exist — so A is tombstoned, C is
   * inserted pristine, and the topic's status, confidence and first-pass date
   * are silently lost. There is deliberately no seed-version column, so this
   * skipped-version case is normal rather than exotic.
   *
   * Resolving transitively means a chain and a flattened equivalent behave
   * identically, which is what makes it safe to author a correction either way.
   */
  function resolveLiveTargets(slug: string, seen: Set<string>): string[] {
    if (wanted.has(slug)) return [slug];
    if (seen.has(slug)) return []; // A cycle in the dataset; carry nothing.
    seen.add(slug);

    const next = renameTargets.get(slug);
    if (!next) return []; // Dead end: renamed to something no longer shipped.

    return next.flatMap((target) => resolveLiveTargets(target, seen));
  }

  const carriedTo = new Set<string>();
  for (const rename of dataset.renames) {
    const from = bySlug.get(rename.fromSlug);

    // Never seeded on this device, so there is nothing to carry.
    if (!from) continue;

    // Already applied on an earlier launch. Without this the carry would be
    // re-emitted on every cold start — and when the carried status happens to
    // be the default one, the plan would never reach steady state and rule 6
    // would be violated forever.
    if (from.retiredAt !== null) continue;

    // A contradictory dataset: the slug is both a rename source and a live
    // entry. Applying the rename would tombstone a topic the dataset still
    // claims. Refusing keeps `tombstone` and `update` disjoint by construction.
    if (wanted.has(rename.fromSlug)) continue;

    // Resolved rather than read literally, so a multi-hop chain whose middle
    // slug this device never held still lands on the right row.
    for (const toSlug of resolveLiveTargets(rename.fromSlug, new Set())) {
      if (carriedTo.has(toSlug)) continue; // two sources, one target: first wins
      const target = bySlug.get(toSlug);
      if (target && !isPristine(target)) continue;

      carriedTo.add(toSlug);
      plan.carryOver.push({ fromId: from.id, toSlug });
    }
  }

  /* -- 2/3/4. Insert, update display fields only, revive. -- */

  for (const entry of wanted.values()) {
    const row = bySlug.get(entry.slug);

    if (!row) {
      plan.insert.push(entry);
      continue;
    }

    const needsUpdate = displayDiffers(row, entry);
    const needsRevive = row.retiredAt !== null;

    // Note what is absent: no status, no confidence, no timestamps. A corrected
    // syllabus may move a bullet, reword it or renumber it; it may never have
    // an opinion about how well she knows it.
    if (needsUpdate) plan.update.push({ id: row.id, entry });

    // A topic dropped by one revision and restored by the next comes back with
    // its original self-assessment, because the row was retired and not deleted.
    if (needsRevive) plan.revive.push(row.id);

    // Rule 6: only rows needing zero writes count as unchanged.
    if (!needsUpdate && !needsRevive) plan.unchanged += 1;
  }

  /* -- 5. Tombstone what the dataset no longer claims. Never DELETE. -- */

  for (const row of existing) {
    // Still in the syllabus. This is also what keeps `tombstone` disjoint from
    // `update` and `revive`: those only ever hold rows whose slug IS wanted.
    if (wanted.has(row.slug)) continue;

    // Already a tombstone. Re-stamping it would be a write on every launch and
    // would move the retirement date to today, losing when it actually left.
    if (row.retiredAt !== null) continue;

    // Rename sources land here too — they are, by definition, absent from the
    // dataset — so rule 1's "then tombstones the old" needs no separate pass.
    plan.tombstone.push(row.id);
  }

  return plan;
}
