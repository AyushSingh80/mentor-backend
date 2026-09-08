/**
 * Flashcard repository — the SM-2 queue over cards kept from current affairs.
 *
 * Thin on purpose, like every repository here. All of the algorithm and all of
 * the date handling live in `lib/sm2.ts`; all of the wording lives in
 * `lib/flashcards.ts`. Both are pure and therefore actually unit-testable,
 * whereas anything importing `db/index` transitively imports `expo-sqlite` and
 * cannot run under Node. What is left in this file is three queries, one insert
 * and one transaction.
 *
 * This is the module `schema.ts` named when it added the CHECK on
 * `revision_reviews`: *"there is no flashcard repository yet, and its grading
 * path is precisely the copy-paste-and-forget that would write both or
 * neither."* Read `gradeCard` with that in mind.
 *
 * ## The CHECK, and how `gradeCard` satisfies it
 *
 *     (syllabus_topic_id is not null) <> (flashcard_id is not null)
 *
 * Exactly one target, XOR, enforced by SQLite. `gradeTopic` writes
 * `syllabusTopicId` and an EXPLICIT `flashcardId: null`. `gradeCard` writes
 * `flashcardId` and an EXPLICIT `syllabusTopicId: null` — both spelled out,
 * neither left to a column default, because the entire failure mode the CHECK
 * guards against is a writer that forgets one side.
 *
 * The trap is specific and it is close by: a flashcard HAS a
 * `syllabus_topic_id` of its own, and the card row is sitting right there in
 * this function. Copying it into the review row looks like enrichment and
 * would take the whole write down — two targets is not one. The card is ABOUT
 * a topic; the review is OF a card. `revision_reviews.syllabus_topic_id` means
 * "this row is a topic review", not "the thing reviewed relates to this topic".
 *
 * ## Two clocks, deliberately
 *
 * Scheduling uses the LOCAL CALENDAR DAY — `localDate(profile.timezone)`, a
 * bare `YYYY-MM-DD`. The audit log uses the real INSTANT. Separate parameters
 * throughout, exactly as in `db/revision.ts`, and not collapsible: at 02:00 in
 * Asia/Kolkata `new Date().toISOString()` still carries yesterday's UTC date,
 * so scheduling from it would make a just-reviewed card fall due again the same
 * local day.
 *
 * ## No lazy enrolment
 *
 * `revision_queue` enrols topics on every deck build because topic status
 * changes elsewhere. Cards have no equivalent: a card exists because she
 * explicitly kept an item, so there is nothing to reconcile and `buildCardDeck`
 * writes nothing at all.
 */

import { and, asc, eq, isNull } from 'drizzle-orm';

import { db } from './index';
import { caItems, caItemTopics, flashcards, revisionReviews, syllabusTopics } from './schema';
import {
  canKeep,
  draftCardFromItem,
  type CardSource,
  type CardTopic,
  type KeepDecision,
} from '@/lib/flashcards';
import { type ItemKind } from '@/lib/ca-types';
import {
  applyReview,
  isDue,
  isLeech,
  selectDueList,
  startOfDayIso,
  type ReviewGrade,
  type Sm2Result,
  type Sm2State,
} from '@/lib/sm2';

export type FlashcardRow = typeof flashcards.$inferSelect;

/**
 * How many cards a single day's list may contain.
 *
 * Deliberately NOT `DAILY_REVIEW_CAP`, and deliberately a second number.
 * A topic review is a ~90-second recall over a whole syllabus leaf; a fact card
 * is a ~10-second one. One cap covering both would make 20 mean two different
 * things at once and corrupt the one number that sizes her morning block.
 *
 * Forty cards is roughly seven minutes, which sits alongside the ~25 minutes of
 * topic revision rather than competing with it. At two keeps a day the deck
 * reaches ~700 cards and SM-2 surfaces perhaps five to ten of them daily, so
 * this cap should almost never bind — it exists as the pile-up defence, for the
 * same reason `DAILY_REVIEW_CAP` does, and the overflow simply stays overdue
 * and leads tomorrow's list.
 */
export const DAILY_CARD_CAP = 40;

export interface DueCard {
  cardId: number;
  /** The topic cue. See the header of `lib/flashcards.ts`. */
  front: string;
  back: string;
  dueAt: string;
  lastReviewedAt: string | null;
  /** 0 means due today. Positive means it was missed on that many earlier days. */
  daysOverdue: number;
  /** Ground down to the ease floor and failed repeatedly. */
  isLeech: boolean;
  state: Sm2State;
  /** The item it was kept from, if that item still exists. */
  caItemId: number | null;
  syllabusTopicId: number | null;
}

export interface CardDeck {
  /** Capped, most-overdue-first. The list the screen walks through. */
  due: DueCard[];
  /** Due today but past the cap. They stay overdue and lead tomorrow's list. */
  heldBack: number;
  /** Due today and flagged as leeches. Surfaced apart from `due`. */
  leeches: DueCard[];
  leechesHeldBack: number;
  /** Everything due today, leeches included, before the cap. */
  totalDue: number;
  /**
   * Every card in the deck, due or not. Distinguishes the two empty states that
   * look identical on screen: "nothing is due today" and "you have not kept
   * anything yet".
   */
  queued: number;
}

/* ------------------------------------------------------------------ dates */

const MS_PER_DAY = 86_400_000;

/**
 * Whole days between two calendar days. Never throws: this is on the read path
 * behind the daily list, and one malformed row must not blank the screen.
 */
function daysBetween(fromIso: string, toIso: string): number {
  try {
    return Math.round(
      (Date.parse(startOfDayIso(toIso)) - Date.parse(startOfDayIso(fromIso))) / MS_PER_DAY,
    );
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------------ reads */

/**
 * Today's card list.
 *
 * Leeches are split out of `due` for `buildDeck`'s reason: left in, a handful
 * of cards she reliably fails would consume the cap every day and crowd out
 * material that is moving; filtered out, they would vanish silently, which is
 * worse, because counting lapses exists precisely to make them visible.
 */
export async function buildCardDeck(
  todayIso: string,
  cap: number = DAILY_CARD_CAP,
): Promise<CardDeck> {
  const rows = await db
    .select({
      cardId: flashcards.id,
      front: flashcards.front,
      back: flashcards.back,
      dueAt: flashcards.dueAt,
      lastReviewedAt: flashcards.lastReviewedAt,
      intervalDays: flashcards.intervalDays,
      easeFactor: flashcards.easeFactor,
      repetitions: flashcards.repetitions,
      lapses: flashcards.lapses,
      caItemId: flashcards.caItemId,
      syllabusTopicId: flashcards.syllabusTopicId,
    })
    .from(flashcards)
    // Creation order breaks ties. `selectDueList` sorts by due date with a
    // stable sort, so this is what makes the list the same list on every
    // rebuild rather than reshuffling under her as she works through it.
    .orderBy(asc(flashcards.id));

  const all = rows.map<DueCard>((row) => {
    const state: Sm2State = {
      repetitions: row.repetitions,
      intervalDays: row.intervalDays,
      easeFactor: row.easeFactor,
      lapses: row.lapses,
    };
    return {
      cardId: row.cardId,
      front: row.front,
      back: row.back,
      dueAt: row.dueAt,
      lastReviewedAt: row.lastReviewedAt,
      daysOverdue: Math.max(0, daysBetween(row.dueAt, todayIso)),
      isLeech: isLeech(state),
      state,
      caItemId: row.caItemId,
      syllabusTopicId: row.syllabusTopicId,
    };
  });

  const dueNow = all.filter((card) => isDue(card.dueAt, todayIso));
  const ordinary = dueNow.filter((card) => !card.isLeech);
  const leeches = dueNow.filter((card) => card.isLeech);

  return {
    due: selectDueList(ordinary, todayIso, cap),
    heldBack: Math.max(0, ordinary.length - cap),
    leeches: selectDueList(leeches, todayIso, cap),
    leechesHeldBack: Math.max(0, leeches.length - cap),
    totalDue: dueNow.length,
    queued: all.length,
  };
}

/**
 * Cards kept from one digest day's items.
 *
 * Counted through `ca_items.date` — the DIGEST day — rather than through
 * `flashcards.created_at`, and that is not an implementation detail. Two
 * reasons, both load-bearing:
 *
 * 1. `created_at` is a real UTC instant and the cap is a local-calendar rule.
 *    At 02:00 in Asia/Kolkata the instant still carries yesterday's UTC date,
 *    so a prefix comparison against a local day would silently mis-bucket every
 *    late-night keep. The two clocks again.
 * 2. It is what the cap MEANS. `DigestDay.keptToday` is per digest, so catching
 *    up on Saturday over three days of digests correctly allows six cards —
 *    still two a day — while keeping a fourth card from any single day's items
 *    is still refused.
 */
export async function keepsUsedOn(digestDay: string): Promise<number> {
  const rows = await db
    .select({ id: flashcards.id })
    .from(flashcards)
    .innerJoin(caItems, eq(caItems.id, flashcards.caItemId))
    .where(eq(caItems.date, digestDay));

  return rows.length;
}

/* ----------------------------------------------------------------- writes */

export interface KeepOutcome {
  kept: boolean;
  /** The new card, or `null` when the keep was refused. */
  cardId: number | null;
  /** Keeps left on that digest day, and why the answer is what it is. */
  decision: KeepDecision;
}

/**
 * Keep a current-affairs item as a flashcard.
 *
 * Refusals are RETURNED, not thrown: "you have used both keeps today" is a
 * normal outcome with words attached, and a screen should not need a try/catch
 * to render a disabled button. A missing item is different — the screen just
 * showed it — and throws.
 *
 * The cap check and the insert are not one transaction, and that is a
 * considered choice rather than an oversight. A double-tap racing past the cap
 * writes a third card: undesirable, and entirely recoverable by deleting it.
 * Compare `gradeCard`, where the two statements MUST be atomic because a
 * partial write there is an interval nobody can explain months later. Spending
 * a synchronous transaction on a three-table read here would buy far less than
 * it costs in a path that is already gated by a disabled button.
 */
export async function keepItemAsCard(caItemId: number, todayIso: string): Promise<KeepOutcome> {
  const [item] = await db
    .select({
      id: caItems.id,
      headline: caItems.headline,
      noteMd: caItems.noteMd,
      kind: caItems.itemKind,
      date: caItems.date,
      sourceName: caItems.sourceName,
      anthroLink: caItems.anthroLink,
    })
    .from(caItems)
    .where(eq(caItems.id, caItemId))
    .limit(1);

  if (!item) throw new Error(`No current-affairs item ${caItemId} to keep`);

  // The PRIMARY tag drives the cue — `ca_item_topics.rank` exists for exactly
  // this, and the schema comment says so. Retired topics are excluded for the
  // reason coverage excludes them: they are tombstones, and cueing recall on a
  // topic that is no longer examinable spends review time on nothing.
  const [topic] = await db
    .select({
      id: syllabusTopics.id,
      paper: syllabusTopics.paper,
      topic: syllabusTopics.topic,
      subtopic: syllabusTopics.subtopic,
    })
    .from(caItemTopics)
    .innerJoin(syllabusTopics, eq(syllabusTopics.id, caItemTopics.syllabusTopicId))
    .where(and(eq(caItemTopics.caItemId, caItemId), isNull(syllabusTopics.retiredAt)))
    .orderBy(asc(caItemTopics.rank), asc(syllabusTopics.id))
    .limit(1);

  const [existing] = await db
    .select({ id: flashcards.id })
    .from(flashcards)
    .where(eq(flashcards.caItemId, caItemId))
    .limit(1);

  const keptToday = await keepsUsedOn(item.date);

  const decision = canKeep({
    keptToday,
    hasTopic: Boolean(topic),
    alreadyKept: Boolean(existing),
  });

  if (!decision.allowed || !topic) return { kept: false, cardId: null, decision };

  const source: CardSource = {
    id: item.id,
    headline: item.headline,
    noteMd: item.noteMd,
    // `item_kind` is a free text column with an `'event'` default; `cardCue`
    // falls back to the event cue for anything it does not recognise, so a
    // vocabulary drift on the server produces a duller card, never a crash.
    kind: item.kind as ItemKind,
    date: item.date,
    sourceName: item.sourceName,
    anthroLink: item.anthroLink,
  };

  const cardTopic: CardTopic = topic;
  const draft = draftCardFromItem(source, cardTopic, todayIso);

  const [row] = await db.insert(flashcards).values(draft).returning({ id: flashcards.id });

  if (!row) throw new Error('Failed to keep the item as a card');

  return {
    kept: true,
    cardId: row.id,
    decision: { ...decision, remaining: Math.max(0, decision.remaining - 1) },
  };
}

export interface GradeCardInput {
  cardId: number;
  grade: ReviewGrade;
  /**
   * The LOCAL calendar day, from `localDate(profile.timezone)`. This drives the
   * schedule, and it is not interchangeable with the instant below — see the
   * "two clocks" note at the top of this file.
   */
  todayIso: string;
  /** The real instant, for the audit log and `lastReviewedAt`. Defaults to now. */
  reviewedAtIso?: string;
}

export interface GradedCard {
  cardId: number;
  previous: Sm2State;
  result: Sm2Result;
}

/**
 * Records one graded card review.
 *
 * The SM-2 arithmetic is `applyReview`'s and nothing here re-derives any of it.
 * A second implementation would drift from the first — the interval is computed
 * from the INCOMING ease before the ease is updated, the first two intervals are
 * constants, the ease penalty applies on failures too — and a card schedule
 * that disagrees with a topic schedule would be unexplainable.
 *
 * The queue update and the audit row are ONE transaction. A schedule that moved
 * with no audit row is an interval nobody can explain months later, and an
 * audit row for a review that never moved the schedule is a lie in the only
 * table that can debug the other one.
 */
export async function gradeCard(input: GradeCardInput): Promise<GradedCard> {
  const reviewedAt = input.reviewedAtIso ?? new Date().toISOString();

  const [row] = await db
    .select()
    .from(flashcards)
    .where(eq(flashcards.id, input.cardId))
    .limit(1);

  if (!row) throw new Error(`No flashcard ${input.cardId} to grade`);

  const previous: Sm2State = {
    repetitions: row.repetitions,
    intervalDays: row.intervalDays,
    easeFactor: row.easeFactor,
    lapses: row.lapses,
  };

  // Scheduled from the local DAY, logged at the real INSTANT.
  const result = applyReview(previous, input.grade, input.todayIso);

  // SYNCHRONOUS callback with `.run()` on every statement.
  //
  // `drizzle-orm/expo-sqlite` is a "sync" driver: its `session.transaction`
  // calls `transaction(tx)` WITHOUT awaiting and runs COMMIT on the next line.
  // An `async` callback returns a pending promise immediately, so COMMIT fires
  // before either statement below has executed and both run as independent
  // autocommits — no atomicity, and no rollback either, since an async function
  // cannot throw synchronously for the driver's `catch` to see. All five
  // pre-existing call sites in this codebase are synchronous for this reason.
  db.transaction((tx) => {
    tx.update(flashcards)
      .set({
        dueAt: result.dueAt,
        intervalDays: result.intervalDays,
        easeFactor: result.easeFactor,
        repetitions: result.repetitions,
        lapses: result.lapses,
        lastReviewedAt: reviewedAt,
      })
      .where(eq(flashcards.id, input.cardId))
      .run();

    tx.insert(revisionReviews)
      .values({
        // THE CHECK: `(syllabus_topic_id is not null) <> (flashcard_id is not
        // null)` — exactly one, XOR, enforced by SQLite.
        //
        // `null` is written explicitly rather than omitted, mirroring
        // `gradeTopic`'s explicit `flashcardId: null`. And it stays null even
        // though `row.syllabusTopicId` is sitting right here and looks like
        // useful enrichment: filling both sides fails the CHECK and takes the
        // whole review down. The card is ABOUT a topic; this row is a review OF
        // a card.
        syllabusTopicId: null,
        flashcardId: input.cardId,
        grade: input.grade,
        prevIntervalDays: previous.intervalDays,
        newIntervalDays: result.intervalDays,
        prevEase: previous.easeFactor,
        newEase: result.easeFactor,
        reviewedAt,
      })
      .run();
  });

  return { cardId: input.cardId, previous, result };
}
