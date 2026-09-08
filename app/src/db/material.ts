/**
 * The material bank: quotes, examples, thinkers and figures.
 *
 * Same transaction rule as every other repository here — see the header of
 * `db/drills.ts`. Nothing in this file needs one: every write is a single
 * statement, and pretending otherwise with a decorative transaction would be
 * worse than not having one.
 */

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { db } from './index';
import { caItems, materialBank, syllabusTopics } from './schema';
import { isMaterialKind, type MaterialFacts, type MaterialKind } from '@/lib/drill-types';

const nowIso = (): string => new Date().toISOString();

function kindOf(value: string): MaterialKind {
  // An unknown kind cannot drive the tally, and `example` is the conservative
  // reading: it is the kind the bank most needs and least over-rewards.
  return isMaterialKind(value) ? value : 'example';
}

const COLUMNS = {
  id: materialBank.id,
  kind: materialBank.kind,
  content: materialBank.content,
  attribution: materialBank.attribution,
  sourceNote: materialBank.sourceNote,
  syllabusTopicId: materialBank.syllabusTopicId,
  caItemId: materialBank.caItemId,
  timesUsed: materialBank.timesUsed,
  lastUsedAt: materialBank.lastUsedAt,
  createdAt: materialBank.createdAt,
} as const;

function toFacts(row: {
  id: number;
  kind: string;
  content: string;
  attribution: string | null;
  sourceNote: string | null;
  syllabusTopicId: number | null;
  caItemId: number | null;
  timesUsed: number;
  lastUsedAt: string | null;
  createdAt: string;
}): MaterialFacts {
  return { ...row, kind: kindOf(row.kind) };
}

/** Everything live, newest first. The bank is small enough to read whole. */
export async function readMaterial(): Promise<MaterialFacts[]> {
  const rows = await db
    .select(COLUMNS)
    .from(materialBank)
    .where(isNull(materialBank.retiredAt))
    .orderBy(desc(materialBank.id));
  return rows.map(toFacts);
}

export interface NewMaterial {
  kind: MaterialKind;
  content: string;
  attribution?: string | null;
  sourceNote?: string | null;
  syllabusSlug?: string | null;
  caItemId?: number | null;
}

/**
 * Adds one item. Returns its id, or null when it was already held.
 *
 * `onConflictDoNothing` on content, so re-adding the same quote is a no-op
 * rather than an error — she will read the same line twice over eighteen months
 * and should not have to remember which ones she already saved.
 */
export async function addMaterial(input: NewMaterial): Promise<number | null> {
  const content = input.content.trim();
  if (content === '') return null;

  let syllabusTopicId: number | null = null;
  if (input.syllabusSlug) {
    const [row] = await db
      .select({ id: syllabusTopics.id })
      .from(syllabusTopics)
      .where(and(eq(syllabusTopics.slug, input.syllabusSlug), isNull(syllabusTopics.retiredAt)))
      .limit(1);
    syllabusTopicId = row?.id ?? null;
  }

  const rows = await db
    .insert(materialBank)
    .values({
      kind: input.kind,
      content,
      attribution: input.attribution?.trim() || null,
      sourceNote: input.sourceNote?.trim() || null,
      syllabusTopicId,
      caItemId: input.caItemId ?? null,
      createdAt: nowIso(),
    })
    .onConflictDoNothing({ target: materialBank.content })
    .returning({ id: materialBank.id });

  return rows[0]?.id ?? null;
}

/**
 * Files a kept current-affairs item into the bank.
 *
 * The cheapest use the digest has: an item she kept as a flashcard is already a
 * fact she judged worth carrying, and an essay eight months later is exactly
 * where a specific, dated Indian example earns its marks.
 *
 * Filed as `example` rather than `data` even when it carries a figure, because
 * the thing that makes it usable in an essay is the situation, not the number.
 */
export async function fileCaItemAsMaterial(caItemId: number): Promise<number | null> {
  const [item] = await db
    .select({
      headline: caItems.headline,
      noteMd: caItems.noteMd,
      sourceName: caItems.sourceName,
      date: caItems.date,
    })
    .from(caItems)
    .where(eq(caItems.id, caItemId))
    .limit(1);
  if (item === undefined) return null;

  const [topic] = await db
    .select({ id: materialBank.syllabusTopicId })
    .from(materialBank)
    .where(eq(materialBank.caItemId, caItemId))
    .limit(1);
  if (topic !== undefined) return null; // already filed

  const rows = await db
    .insert(materialBank)
    .values({
      kind: 'example',
      content: `${item.headline} — ${item.noteMd}`,
      attribution: item.sourceName,
      sourceNote: `Current affairs, ${item.date}`,
      caItemId,
      createdAt: nowIso(),
    })
    .onConflictDoNothing({ target: materialBank.content })
    .returning({ id: materialBank.id });

  return rows[0]?.id ?? null;
}

/**
 * Records that these items were used in a drill.
 *
 * Drives the surfacing bias — see `lib/material.ts`, where use count sorts
 * ASCENDING because the bank exists to surface what she has forgotten. Marking
 * use is what makes that ordering mean anything over time.
 */
export async function markMaterialUsed(ids: readonly number[]): Promise<void> {
  if (ids.length === 0) return;
  const at = nowIso();
  await db
    .update(materialBank)
    .set({ timesUsed: sql`${materialBank.timesUsed} + 1`, lastUsedAt: at })
    .where(inArray(materialBank.id, [...ids]));
}

/** Retires an item without deleting it, so a drill that used it still makes sense. */
export async function retireMaterial(id: number): Promise<void> {
  await db.update(materialBank).set({ retiredAt: nowIso() }).where(eq(materialBank.id, id));
}
