/**
 * The shared current-affairs vocabulary. Pure — no RN, no expo-sqlite.
 *
 * Every type crossing an agent boundary lives here and ONLY the owner edits it,
 * exactly as `mcq-types.ts` works for Phase 3. Five agents building in parallel
 * against one frozen file cannot disagree about what an item is or how many she
 * gets in a day.
 *
 * Safe value imports from here: `@/lib/papers` only.
 */

import type { PaperValue } from '@/lib/papers';

/**
 * What the day actually costs her, expressed in minutes rather than in items.
 *
 * She has ~5.66 hrs on a weekday and the reading block is 10:15–12:15. Current
 * affairs must not eat that block — standard-book reading is what produces the
 * March 2027 first pass, and the README already records that the first pass has
 * very little slack. Twenty minutes is 17% of the block, deliberately below the
 * "45–60 minutes of newspaper" folk advice, which is written for full-time
 * aspirants who are not also clearing a lecture backlog on a night shift.
 *
 * Reading dense prose runs ~180 wpm, and the reading is not the work — the
 * linking is. So 20 minutes buys ~5 minutes of reading (~900 words, six 90-word
 * notes) and leaves 15 for writing the link into her own notes.
 *
 * Cross-check: 6/day × ~22 digest days ≈ 130 items a month, which is the size
 * of a commercial monthly compilation. The number is right partly because it
 * independently lands where the market landed.
 */
export const CA_RULES = {
  dailyItemCap: 6,
  weekendItemCap: 8,
  dailyBudgetMinutes: 20,
  weekendBudgetMinutes: 40,
  maxNoteWords: 90,
  /** Kept as a flashcard. Two a day is ~700 over the preparation — a real deck. */
  maxKeepsPerDay: 2,
  /** Stops one running story eating a month. */
  maxItemsPerSectionPerWeek: 3,
  readWordsPerMinute: 180,
  /**
   * Older than this is archive, never "due to read".
   *
   * A current-affairs backlog is not recoverable, unlike a lecture backlog —
   * which is exactly why Phase 2 built a tracker for one and this phase refuses
   * to build one for the other. Presenting three weeks of unread digests as a
   * debt to clear is how she stops opening the app.
   */
  catchUpDays: 3,
  /** Above this share of items claiming an Anthropology link, the prompt is reaching. */
  maxAnthroLinkRate: 0.4,
  /** A 14-day read rate below this shrinks the cap by one, and says why. */
  readRateFloor: 0.6,
  readRateWindowDays: 14,
  /** Matches `BANK_RULES.refillCooldownHours`: one attempt a day, plus a retry. */
  digestCooldownHours: 6,
} as const;

export type ItemKind = 'structural' | 'report' | 'judgment' | 'scheme' | 'data' | 'event';

/** A verbatim quote from the fetched page. The proof, not a paraphrase. */
export interface CaEvidence {
  quote: string;
}

export interface CaItemFacts {
  id: number;
  /** Digest day, `YYYY-MM-DD`. Byte-compared, never parsed through `Date`. */
  date: string;
  /** When the SOURCE published. Not the digest day — see the schema comment. */
  publishedAt: string | null;
  headline: string;
  sourceName: string | null;
  sourceUrl: string | null;
  kind: ItemKind;
  noteMd: string;
  evidence: readonly CaEvidence[];
  /** Raw server-proposed tags, including any this build cannot resolve. */
  syllabusTags: readonly string[];
  /** Resolved ids from `ca_item_topics`, in rank order. */
  topicIds: readonly number[];
  anthroLink: string | null;
  anthroP1Slug: string | null;
  anthroP2Slug: string | null;
  readAt: string | null;
  digestId: number | null;
}

export interface DigestSummaryFacts {
  considered: number;
  kept: number;
  dropped: number;
  /** Rendered in words, not logged. A filter she cannot see teaches nothing. */
  dropReasons: Readonly<Record<string, number>>;
  sourceFailures: number;
  /** Tags naming slugs this build lacks. A drifting vocabulary is actionable. */
  unknownTags: readonly string[];
}

export interface DigestDay {
  date: string;
  items: readonly CaItemFacts[];
  estimatedMinutes: number;
  unread: number;
  keptToday: number;
  /** `'none'` means no digest was ever requested for this day. */
  status: 'none' | 'pending' | 'completed' | 'partial' | 'failed';
  summary: DigestSummaryFacts | null;
}

export interface TagResolution {
  topicIds: number[];
  resolved: string[];
  /**
   * Slugs this build does not have.
   *
   * An unknown tag NEVER rejects the item. Phase 3 learned this the expensive
   * way: if a slug the app has not learned about yet rejected the payload, one
   * syllabus correction on the server would turn into a total outage on the
   * device — an offline failure caused by being online. An untagged item is
   * still a readable item.
   */
  unknown: string[];
}

/** Papers a current-affairs item can be tagged against. */
export type CaPaper = PaperValue;
