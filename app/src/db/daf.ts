/**
 * The DAF form and the interview question bank.
 *
 * ## Nothing here writes an answer
 *
 * `notes` is the only column she writes and the only column anything writes for
 * her — which is to say, nothing does. The server returns questions and this
 * file stores questions. See `server/src/interview/types.ts` for why that is
 * the rule the whole phase rests on.
 *
 * Transactions follow the repository rule set out in `db/drills.ts`: the
 * expo-sqlite driver is `"sync"` kind, so a callback must be synchronous with
 * `.run()` on every statement. Only `bankQuestions` needs one.
 */

import { asc, eq } from 'drizzle-orm';

import { db } from './index';
import { dafProfile, interviewQuestions } from './schema';
import {
  isDafField,
  isLikelihood,
  isPrepState,
  type DafEntry,
  type DafField,
  type InterviewQuestion,
  type Likelihood,
  type PrepState,
} from '@/lib/daf-types';

const nowIso = (): string => new Date().toISOString();

/* -------------------------------------------------------------- the form */

export async function readDaf(): Promise<DafEntry[]> {
  const rows = await db
    .select({ field: dafProfile.field, value: dafProfile.value, updatedAt: dafProfile.updatedAt })
    .from(dafProfile);

  const out: DafEntry[] = [];
  for (const row of rows) {
    // A field this build does not know is skipped rather than coerced: it
    // cannot be rendered under any label and offering it to the server would
    // be sending a key the server's enum will reject.
    if (!isDafField(row.field)) continue;
    out.push({ field: row.field, value: row.value, updatedAt: row.updatedAt });
  }
  return out;
}

/**
 * Saves one field.
 *
 * Upsert on `field`, so this is safe to call on every blur — the form is filled
 * over two years and nothing she types should ever be more than a moment from
 * disk. An empty value DELETES the row rather than storing `""`, so "filled in"
 * and "cleared" are the same state, which is what `formState` assumes.
 */
export async function saveDafField(field: DafField, value: string): Promise<void> {
  const trimmed = value.trim();

  if (trimmed === '') {
    await db.delete(dafProfile).where(eq(dafProfile.field, field));
    return;
  }

  await db
    .insert(dafProfile)
    .values({ field, value: trimmed, updatedAt: nowIso() })
    .onConflictDoUpdate({
      target: dafProfile.field,
      set: { value: trimmed, updatedAt: nowIso() },
    });
}

/* ------------------------------------------------------------- questions */

function toFacts(row: {
  id: number;
  field: string | null;
  area: string;
  question: string;
  likelihood: string;
  prep: string;
  notes: string | null;
  flagged: boolean;
  createdAt: string;
}): InterviewQuestion {
  return {
    id: row.id,
    field: row.field !== null && isDafField(row.field) ? row.field : null,
    area: row.area,
    question: row.question,
    // An unrecognised likelihood must not become a fourth bucket no screen
    // orders by; `possible` is the conservative reading — it sorts last.
    likelihood: isLikelihood(row.likelihood) ? (row.likelihood as Likelihood) : 'possible',
    prep: isPrepState(row.prep) ? (row.prep as PrepState) : 'not_started',
    notes: row.notes,
    flagged: row.flagged,
    createdAt: row.createdAt,
  };
}

const COLUMNS = {
  id: interviewQuestions.id,
  field: interviewQuestions.field,
  area: interviewQuestions.area,
  question: interviewQuestions.question,
  likelihood: interviewQuestions.likelihood,
  prep: interviewQuestions.prep,
  notes: interviewQuestions.notes,
  flagged: interviewQuestions.flagged,
  createdAt: interviewQuestions.createdAt,
} as const;

export async function readQuestions(): Promise<InterviewQuestion[]> {
  const rows = await db
    .select(COLUMNS)
    .from(interviewQuestions)
    .orderBy(asc(interviewQuestions.id));
  return rows.map(toFacts);
}

/** Question texts already banked, sent so a batch does not restate one. */
export async function bankedQuestionTexts(limit = 300): Promise<string[]> {
  const rows = await db
    .select({ question: interviewQuestions.question })
    .from(interviewQuestions)
    .orderBy(asc(interviewQuestions.id))
    .limit(limit);
  return rows.map((row) => row.question);
}

export interface BankableQuestion {
  field: DafField | null;
  area: string;
  question: string;
  likelihood: Likelihood;
  batchId: string;
  promptVersion: string;
}

/**
 * Banks a batch. Returns how many rows were actually written.
 *
 * `onConflictDoNothing` on the question text, so re-running after a partial
 * failure banks the rest. The count returned is the count WRITTEN, which is
 * what the screen reports — "8 arrived, 2 were already banked" is true and
 * "8 banked" would not be.
 */
export async function bankQuestions(questions: readonly BankableQuestion[]): Promise<number> {
  if (questions.length === 0) return 0;

  const rows = await db
    .insert(interviewQuestions)
    .values(
      questions.map((entry) => ({
        field: entry.field,
        area: entry.area,
        question: entry.question,
        likelihood: entry.likelihood,
        prep: 'not_started' as const,
        flagged: false,
        batchId: entry.batchId,
        promptVersion: entry.promptVersion,
      })),
    )
    .onConflictDoNothing({ target: interviewQuestions.question })
    .returning({ id: interviewQuestions.id });

  return rows.length;
}

/** Her notes on one question. The only column she writes. */
export async function saveNotes(id: number, notes: string): Promise<void> {
  const trimmed = notes.trim();
  await db
    .update(interviewQuestions)
    .set({ notes: trimmed === '' ? null : trimmed })
    .where(eq(interviewQuestions.id, id));
}

/**
 * Moves a question's preparation state.
 *
 * Set explicitly rather than advanced by one, because the honest move is often
 * BACKWARDS: rehearsing something in June and finding in November that it is
 * gone is normal, and a state machine that only went forwards would make her
 * lie to it.
 */
export async function setPrep(id: number, prep: PrepState): Promise<void> {
  await db.update(interviewQuestions).set({ prep }).where(eq(interviewQuestions.id, id));
}

/** Marks a question as one she does not want to be asked. Never hides it. */
export async function setFlagged(id: number, flagged: boolean): Promise<void> {
  await db.update(interviewQuestions).set({ flagged }).where(eq(interviewQuestions.id, id));
}
