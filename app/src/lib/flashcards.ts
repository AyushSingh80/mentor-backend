/**
 * Drafting a flashcard from a current-affairs item. Pure — no RN, no expo-sqlite.
 *
 * Phase 2 built the `flashcards` table with a full set of SM-2 columns and then
 * deliberately left it unwired. This module is the half of that machinery that
 * decides WHAT a card says; `db/flashcards.ts` is the half that writes it and
 * grades it.
 *
 * ## The front is the topic cue, never the headline
 *
 * This is the single decision that makes the deck worth carrying.
 *
 *   front: "GS2 · Welfare Schemes — a recent change in scheme design, and its rationale"
 *   NOT:   "Cabinet approves the Pradhan Mantri XYZ Yojana"
 *
 * A headline on the front tests RECOGNITION: she reads it, thinks "yes, I saw
 * that", flips, and grades herself Good. Nothing was retrieved. A Mains answer
 * needs the opposite operation — the examiner supplies a syllabus theme and she
 * has to produce the current example unprompted. So the cue is the syllabus
 * leaf plus what kind of thing to reach for, and the headline lives on the
 * BACK, where it is the answer rather than the question.
 *
 * It also survives time. "Cabinet approves X" is unanswerable six months later
 * because the card has already told her the answer; "a recent change in scheme
 * design, and its rationale" keeps working for the whole preparation and
 * quietly accumulates more than one example under one cue.
 *
 * ## A card needs a syllabus leaf
 *
 * `draftCardFromItem` REQUIRES a resolved topic. Without one there is no cue —
 * "a recent judgment on this" has no referent — and a card that cannot be
 * recalled from is review time spent on nothing. This restricts KEEPING, never
 * delivery: `TagResolution` is explicit that an unknown tag must not reject an
 * item, and an untagged item stays readable, stays in the archive, and stays in
 * the monthly compilation. It simply does not become a card. `canKeep` says so
 * in words, because the button has to explain itself.
 *
 * Import rules for pure code: `@/lib/ca-types`, `@/lib/papers` and `@/lib/sm2`
 * are safe value imports; `@/db/*` is type-only.
 */

import { CA_RULES, type ItemKind } from '@/lib/ca-types';
import { paperLabel } from '@/lib/papers';
import { applyReview, type Sm2State } from '@/lib/sm2';

/* ------------------------------------------------------------------ input */

/** What drafting needs from a `ca_items` row. Structural — `CaItemFacts` fits. */
export interface CardSource {
  id: number;
  headline: string;
  noteMd: string;
  kind: ItemKind;
  /** The digest day, `YYYY-MM-DD`. Attribution on the back. */
  date: string;
  sourceName: string | null;
  anthroLink: string | null;
}

/** The item's primary resolved syllabus tag — `ca_item_topics` rank 0. */
export interface CardTopic {
  id: number;
  paper: string;
  topic: string;
  subtopic: string | null;
}

/* ------------------------------------------------------------------- cues */

/**
 * What to reach for, by item kind.
 *
 * Each one names an OPERATION rather than a fact: what changed, what was held,
 * which way it moved. That is what a Mains paragraph is made of, and it is what
 * "I remember reading about that" is not. The `itemKind` column exists in the
 * first place because the answer to "what changed?" is either a rule or a
 * happening, and this is where that distinction is finally spent.
 */
const CUES: Record<ItemKind, string> = {
  structural: 'a recent change in how this is governed, and what it changes',
  report: 'a recent report on this — its headline finding, and who published it',
  judgment: 'a recent judgment on this — what it held, and on what reasoning',
  scheme: 'a recent change in scheme design, and its rationale',
  data: 'a recent figure on this — what it measures, and which way it moved',
  event: 'a recent development on this, and why it matters for the syllabus',
};

/** Falls back to the `event` cue, which is the schema's own column default. */
export function cardCue(kind: ItemKind): string {
  return CUES[kind] ?? CUES.event;
}

/**
 * `GS2 · Welfare Schemes · Subtopic — <cue>`.
 *
 * One separator for the address and a different one before the cue, so the
 * syllabus location reads as one unit however deep it goes.
 */
export function cardFront(topic: CardTopic, kind: ItemKind): string {
  const where = [paperLabel(topic.paper), topic.topic, topic.subtopic]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join(' · ');
  return `${where} — ${cardCue(kind)}`;
}

/**
 * Headline first, then the note, then the Anthropology link, then attribution.
 *
 * The headline leads because it is the answer to the cue on the front. The
 * attribution line is not decoration: an item she half-remembers is worth far
 * less than one she can date and name a source for, and both are what makes it
 * quotable in an answer.
 */
export function cardBack(item: CardSource): string {
  const parts: string[] = [item.headline.trim() || '(untitled item)'];

  const note = item.noteMd.trim();
  if (note !== '') parts.push(note);

  const anthro = item.anthroLink?.trim();
  if (anthro) parts.push(`Anthropology link: ${anthro}`);

  const source = item.sourceName?.trim();
  parts.push(source ? `${source} · ${item.date.slice(0, 10)}` : item.date.slice(0, 10));

  return parts.join('\n\n');
}

/* ---------------------------------------------------------------- drafting */

/**
 * A complete `flashcards` insert payload.
 *
 * Every NOT NULL column is present, including the ones the schema gives a
 * default. Relying on the drizzle defaults would mean the card's starting SM-2
 * state was described in two places — the schema and nobody — and the first
 * time one of those defaults changed, cards drafted here would silently start
 * life somewhere else on the interval ladder.
 */
export interface CardDraft {
  front: string;
  back: string;
  /** The syllabus leaf the cue was built from. Nullable in the schema; never null here. */
  syllabusTopicId: number;
  caItemId: number;
  /** Start of the due day, ISO. Tomorrow — see below. */
  dueAt: string;
  intervalDays: number;
  easeFactor: number;
  repetitions: number;
  lapses: number;
}

/**
 * The seed state handed to `applyReview` purely to get a date.
 *
 * `intervalDays: 0` deliberately differs from the column default of 1, exactly
 * as `revision.ts`'s `UNSEEN` does: at `repetitions === 0` the algorithm takes
 * the constant branch and never reads it, so zero says "no interval yet" rather
 * than implying a one-day schedule that does not exist.
 */
const UNSEEN: Sm2State = { repetitions: 0, intervalDays: 0, easeFactor: 2.5, lapses: 0 };

/** The `flashcards` column defaults, restated so a draft is a total payload. */
const NEW_CARD = { intervalDays: 1, easeFactor: 2.5, repetitions: 0, lapses: 0 } as const;

/**
 * Draft a card from an item she has just decided to keep.
 *
 * ## Due tomorrow, and the date comes from `applyReview`
 *
 * She has this second finished reading the note. Recalling it an hour later
 * proves nothing, so the first real recall is tomorrow — and the "+1 day" is
 * computed by `applyReview` rather than by local date arithmetic here, for
 * `enrolmentDueAt`'s reason verbatim: `lib/sm2.ts` owns the date boundary
 * (collapse the instant to its calendar day, THEN add whole days) and its
 * header is explicit that both halves live there so no caller can get it wrong.
 * A card scheduled naively at 22:00 for "+1 day" is invisible for the whole of
 * the next morning's study block and only appears at 22:00.
 *
 * Only `dueAt` is taken from the result. The card keeps the column defaults —
 * `repetitions: 0` — because READING a note is not a graded recall and must not
 * consume an SM-2 repetition. Grading the card is what moves it up the ladder,
 * and that happens in `db/flashcards.ts`.
 *
 * `todayIso` is the LOCAL calendar day, from `localDate(profile.timezone)`. It
 * throws on an unparseable date rather than guessing: this runs behind an
 * explicit tap, and a card scheduled from a bad clock is a wrong interval that
 * compounds for months.
 */
export function draftCardFromItem(
  item: CardSource,
  topic: CardTopic,
  todayIso: string,
): CardDraft {
  return {
    front: cardFront(topic, item.kind),
    back: cardBack(item),
    syllabusTopicId: topic.id,
    caItemId: item.id,
    dueAt: applyReview(UNSEEN, 4, todayIso).dueAt,
    ...NEW_CARD,
  };
}

/* ------------------------------------------------------------- the keep cap */

export interface KeepGate {
  /** Cards already kept from THIS digest day. See `keepsUsedOn`. */
  keptToday: number;
  /** Whether the item has a resolved syllabus tag to build a cue from. */
  hasTopic: boolean;
  /** Whether this item already spawned a card. */
  alreadyKept: boolean;
}

export interface KeepDecision {
  allowed: boolean;
  /** Keeps left on this digest day, after the cap. */
  remaining: number;
  /** Always populated. A disabled button that says nothing is a bug report. */
  reason: string;
}

/**
 * Whether this item may become a card.
 *
 * The cap is two a day, and it is a cap on JUDGEMENT rather than on storage.
 * Two a day is ~700 cards over the preparation — a real deck, and one she can
 * still get through daily. Keeping six a day builds a deck of two thousand that
 * takes an hour a morning, which is the same volume failure as an eight-item
 * digest wearing different clothes. Forcing the choice is the feature: deciding
 * which two of six items are worth carrying for eighteen months is itself the
 * act that makes them stick.
 */
export function canKeep(gate: KeepGate): KeepDecision {
  const remaining = Math.max(0, CA_RULES.maxKeepsPerDay - Math.max(0, gate.keptToday));

  if (gate.alreadyKept) {
    return { allowed: false, remaining, reason: 'You have already kept this one as a card.' };
  }

  if (!gate.hasTopic) {
    return {
      allowed: false,
      remaining,
      reason:
        'This item has no syllabus tag this build recognises, so there is no cue to recall it ' +
        'by. It stays readable and stays in the archive — it just cannot become a card.',
    };
  }

  if (remaining === 0) {
    return {
      allowed: false,
      remaining,
      reason:
        `${CA_RULES.maxKeepsPerDay} cards a day is the cap. Choosing which two of today’s items ` +
        'are worth carrying for eighteen months is the part that makes them stick.',
    };
  }

  return {
    allowed: true,
    remaining,
    reason:
      remaining === 1
        ? 'One keep left today.'
        : `${remaining} keeps left today, out of ${CA_RULES.maxKeepsPerDay}.`,
  };
}
