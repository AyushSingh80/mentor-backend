/**
 * The current-affairs wire and pipeline vocabulary. FROZEN.
 *
 * The counterpart to `app/src/lib/ca-types.ts`. Two agents build the server
 * side in parallel against this file and neither edits it.
 *
 * ## The one claim this whole phase rests on
 *
 * A generated digest is worthless unless every fact in it traces to a page that
 * was actually fetched. She reads a note saying "the Supreme Court held X in
 * March 2026" and writes it into a Mains answer — if the model half-remembered
 * that case, she has put a fabricated citation into a paper worth 250 marks.
 * The evaluation rubric already forbids inventing current affairs; this is the
 * generation-side equivalent, and a prompt instruction is not it.
 *
 * So `DigestItemDraft` carries verbatim `evidence` and a per-sentence index
 * into it, and `ground.ts` checks — with no model in the loop — that each quote
 * is a literal substring of the fetched text and that every number, date and
 * citation in the note appears there too. Substring, not similarity. Free,
 * deterministic, and it cannot be talked out of its answer.
 */

/* ------------------------------------------------------------------ sources */

export interface SourceFeed {
  id: string;
  name: string;
  url: string;
  kind: 'rss' | 'atom' | 'index';
  /** Which papers this feed tends to serve. Advisory, for shortlist steering. */
  papers: readonly string[];
  /** `primary` is the government or the court in its own words. */
  trust: 'primary' | 'secondary';
}

export interface FeedEntry {
  feedId: string;
  sourceName: string;
  url: string;
  /** Tracking params stripped. The dedup key. */
  canonicalUrl: string;
  title: string;
  publishedAt: string | null;
  lede: string | null;
}

/**
 * The ONLY text the model is permitted to write from, and it is never
 * persisted and never leaves the server.
 *
 * That keeps the copyright surface to a paraphrase plus at most three short
 * quotes, and it keeps the device database small. `ca_items` deliberately has
 * nowhere to put an article body.
 */
export interface SourceDocument {
  url: string;
  canonicalUrl: string;
  sourceName: string;
  feedId: string;
  title: string;
  publishedAt: string | null;
  text: string;
  charCount: number;
  fetchedAt: string;
}

export type FetchFailureReason =
  | 'timeout'
  | 'http_error'
  | 'too_large'
  | 'not_html'
  | 'extract_empty'
  | 'blocked';

export interface FetchFailure {
  url: string;
  feedId: string;
  reason: FetchFailureReason;
  detail: string;
}

/* -------------------------------------------------------------------- items */

export type ItemKind = 'structural' | 'report' | 'judgment' | 'scheme' | 'data' | 'event';

export interface EvidenceSpan {
  quote: string;
  /** Offset into the normalised source text. `-1` until grounding resolves it. */
  at: number;
}

export interface DigestItemDraft {
  url: string;
  headline: string;
  kind: ItemKind;
  noteMd: string;
  /**
   * One index into `evidence` per sentence of `noteMd`. Schema-enforced.
   *
   * This is what closes the gap grounding alone leaves: a 90-word note can be
   * 80 words grounded and 10 words invented. Requiring every sentence to name
   * its evidence makes an unattributed sentence a structural failure rather
   * than a judgement call.
   */
  sentenceEvidence: readonly number[];
  evidence: readonly EvidenceSpan[];
  sectionKeys: readonly string[];
  syllabusSlugs: readonly string[];
  /**
   * The Paper 1 concept and its Indian instance.
   *
   * Emitted only when `p2Slug` is a real `anthro_p2` leaf AND the source names
   * something concrete — a community, a Schedule, an Act, a district. "This is
   * about tribes" is worth nothing; the rubric wants theory anchored to a named
   * Indian example, and that is what separates a 240 from a 280.
   */
  anthro: { p1Slug: string | null; p2Slug: string | null; usageLine: string } | null;
}

export interface GroundedItem extends DigestItemDraft {
  sourceName: string;
  sourceUrl: string;
  canonicalUrl: string;
  publishedAt: string | null;
  headlineFingerprint: string;
  /** Every `at` is >= 0 by the time an item reaches the wire. */
  evidence: readonly EvidenceSpan[];
}

export type DropReason =
  | 'ungrounded_quote'
  | 'ungrounded_number'
  | 'ungrounded_date'
  | 'ungrounded_citation'
  | 'uncovered_sentence'
  | 'event_only'
  | 'no_syllabus_tag'
  | 'duplicate'
  | 'over_section_cap'
  | 'over_daily_cap'
  | 'anthro_overreach'
  | 'anthro_no_p2'
  | 'note_too_long'
  | 'fetch_failed'
  | 'unknown_url';

export interface CaSummaryFrame {
  considered: number;
  shortlisted: number;
  kept: number;
  dropped: number;
  dropReasons: Partial<Record<DropReason, number>>;
  /** Above `0.4` the Anthropology prompt is reaching. Logged loudly. */
  anthroLinkRate: number;
  /** A 404 feed must never look like a quiet news day. */
  sourceFailures: readonly FetchFailure[];
  /** Fewer than asked for is a CORRECT outcome, not an error. */
  underDelivered: boolean;
}

export interface CaUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export const MAX_NOTE_WORDS = 90;
export const MAX_EVIDENCE_PER_ITEM = 3;
export const MAX_DAILY_ITEMS = 8;
