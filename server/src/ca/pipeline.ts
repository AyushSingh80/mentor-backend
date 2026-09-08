/**
 * Digest orchestration: two model calls, one fetch phase, spend, cancellation.
 *
 *     feeds -> shortlist (call 1) -> fetch full text -> notes (call 2)
 *           -> GROUND -> select -> emit
 *
 * Deliberately knows nothing about HTTP. It takes runners, an ingest pair and
 * an emit callback, so the disconnect path, the grounding-drop path and the
 * quiet-day path are all testable without a socket. `routes/ca.ts` supplies the
 * sockets, the auth and the caps; this file supplies the judgement.
 *
 * Three properties worth stating up front:
 *
 *  1. UNDER-DELIVERY IS A SUCCESS. Four items on a quiet day is a good answer,
 *     reported in the summary, not an error. Nothing here lowers a bar to hit
 *     a count.
 *
 *  2. NOTHING UNGROUNDED REACHES THE WIRE. An item is emitted only after every
 *     one of its quotes has been found as a literal substring of the page the
 *     server itself fetched, and every number and date in its note has been
 *     found there too.
 *
 *  3. THE TWO CALLS SEE DIFFERENT THINGS. Call 1 sees forty headlines and no
 *     bodies, which is cheap. Call 2 sees ten full articles and no headlines it
 *     did not already choose. Merging them into one call would mean paying to
 *     put forty full articles in front of a model to use ten.
 */

import { MAX_SECTION_KEYS_PER_ITEM, MAX_SYLLABUS_SLUGS_PER_ITEM } from './schema.js';
import type { GroundingVerdict } from './ground.js';
import {
  MAX_SHORTLIST,
  headlineFingerprint,
  prepareCandidates,
  selectItems,
  type Candidate,
  type SelectionRequest,
} from './select.js';
import {
  ZERO_USAGE,
  addUsage,
  notesMaxTokens,
  shortlistMaxTokens,
  type NotesRunner,
  type ShortlistPick,
  type ShortlistRunner,
} from './runner.js';
import type {
  CaSummaryFrame,
  CaUsage,
  DigestItemDraft,
  DropReason,
  FeedEntry,
  FetchFailure,
  GroundedItem,
  SourceDocument,
} from './types.js';
import { MAX_DAILY_ITEMS, MAX_NOTE_WORDS } from './types.js';

export const DEFAULT_MAX_ITEMS = 6;
export const MIN_MAX_ITEMS = 1;
export { MAX_DAILY_ITEMS };

/**
 * The phases the client is told about.
 *
 * `fetch` is 20–60 seconds of network I/O against a dozen news sites. A blank
 * screen for that long reads as a hang, and the phone's own idle timer will cut
 * the stream at 45 seconds of silence — so these frames are not decoration,
 * they are what keeps a working digest from being killed by its own client.
 */
export type CaPhase = 'feeds' | 'shortlist' | 'fetch' | 'notes' | 'ground' | 'select';

export interface CaProgress {
  phase: CaPhase;
  done: number;
  total: number;
  detail: string;
}

export interface CallUsageEvent {
  phase: 'shortlist' | 'notes';
  model: string;
  usage: CaUsage;
}

export interface CaPipelineInput {
  requestId: string;
  /** Digest day, `YYYY-MM-DD`. Echoed, never parsed through `Date`. */
  date: string;
  maxItems: number;
  syllabusSlugs: readonly string[];
  sections: readonly string[];
  /**
   * Slug to printed heading, rendered into both prompts beside the key.
   *
   * Optional: a request that omits it still selects correctly, it just asks the
   * model to tag from bare slugs. See `ParsedBody.slugLabels` in routes/ca.ts.
   */
  slugLabels?: Readonly<Record<string, string>>;
  seenCanonicalUrls: readonly string[];
  seenFingerprints: readonly string[];
  sectionCountsThisWeek: Readonly<Record<string, number>>;
  model: string;
  shortlistSystem: string;
  notesSystem: string;
}

export interface CaPipelineDeps {
  /** Reads every allowlisted feed. Owned by sources.ts / fetch.ts. */
  collectEntries: (opts: {
    requestId: string;
    date: string;
    signal: AbortSignal;
    isCancelled: () => boolean;
  }) => Promise<{ entries: FeedEntry[]; failures: FetchFailure[]; feedCount: number }>;
  /** Fetches the full text of the shortlist ONLY. Owned by fetch.ts. */
  fetchDocuments: (
    entries: readonly FeedEntry[],
    opts: {
      requestId: string;
      date: string;
      signal: AbortSignal;
      isCancelled: () => boolean;
      onProgress: (done: number, total: number) => void;
    },
  ) => Promise<{ documents: SourceDocument[]; failures: FetchFailure[] }>;
  /** Free, mechanical, no model. Owned by ground.ts. NEVER swap this out. */
  verifyGrounding: (draft: DigestItemDraft, document: SourceDocument) => GroundingVerdict;
  shortlist: ShortlistRunner;
  notes: NotesRunner;
  /** Called once per item that has cleared the FULL pipeline. */
  emitItem: (item: GroundedItem) => void;
  onProgress: (progress: CaProgress) => void;
  /** Awaited, so a call is billed before the next phase is allowed to start. */
  onCallUsage: (event: CallUsageEvent) => Promise<void>;
  /** True once the client is gone. Checked before every phase and every call. */
  isCancelled: () => boolean;
  signal: AbortSignal;
  log?: (message: string, detail?: unknown) => void;
}

export interface CaPipelineResult {
  summary: CaSummaryFrame;
  totalUsage: CaUsage;
  cancelled: boolean;
  provenance: 'model' | 'fake';
}

/** Words of a markdown note, counted the way the 90-word cap means it. */
function countWords(noteMd: string): number {
  return noteMd.replace(/[#*_`>\[\]()-]/g, ' ').split(/\s+/).filter(Boolean).length;
}

export function clampMaxItems(value: number): number {
  return Math.min(MAX_DAILY_ITEMS, Math.max(MIN_MAX_ITEMS, Math.floor(value)));
}

export async function runCaPipeline(
  input: CaPipelineInput,
  deps: CaPipelineDeps,
): Promise<CaPipelineResult> {
  const dropReasons: Partial<Record<DropReason, number>> = {};
  const noteDrop = (reason: DropReason, detail: string): void => {
    dropReasons[reason] = (dropReasons[reason] ?? 0) + 1;
    deps.log?.(`[ca] dropped (${reason}): ${detail}`);
  };

  const sourceFailures: FetchFailure[] = [];
  let totalUsage = ZERO_USAGE;
  let provenance: 'model' | 'fake' = 'model';
  let cancelled = false;
  let considered = 0;
  let shortlisted = 0;
  let kept = 0;
  let anthroLinkRate = 0;

  const maxItems = clampMaxItems(input.maxItems);

  const finish = (): CaPipelineResult => ({
    totalUsage,
    cancelled,
    provenance,
    summary: {
      considered,
      shortlisted,
      kept,
      // Everything that was shortlisted — and therefore paid for — and did not
      // reach the wire. Note that `dropReasons` can total MORE than this: an
      // over-reaching Anthropology claim strips the link and keeps the item.
      dropped: Math.max(0, shortlisted - kept),
      dropReasons,
      anthroLinkRate,
      sourceFailures,
      // Fewer than asked for is a CORRECT outcome, and this is how it is said.
      underDelivered: kept < maxItems,
    },
  });

  const bill = async (
    phase: 'shortlist' | 'notes',
    usage: CaUsage,
  ): Promise<void> => {
    totalUsage = addUsage(totalUsage, usage);
    // Awaited on purpose. If the process dies between the model call and the
    // ledger write the money is spent and unrecorded; keeping the write on the
    // critical path is what makes "dies after the shortlist bills exactly the
    // shortlist" true.
    await deps.onCallUsage({ phase, model: input.model, usage });
  };

  /* ------------------------------------------------------------ phase: feeds */

  if (deps.isCancelled()) return { ...finish(), cancelled: true };

  deps.onProgress({ phase: 'feeds', done: 0, total: 1, detail: 'Reading the source feeds' });
  const feedSweep = await deps.collectEntries({
    requestId: input.requestId,
    date: input.date,
    signal: deps.signal,
    isCancelled: deps.isCancelled,
  });
  sourceFailures.push(...feedSweep.failures);
  deps.onProgress({
    phase: 'feeds',
    done: 1,
    total: 1,
    detail: `${feedSweep.entries.length} headlines from ${feedSweep.feedCount} feeds`,
  });

  const candidates = prepareCandidates(feedSweep.entries, {
    seenCanonicalUrls: input.seenCanonicalUrls,
    seenFingerprints: input.seenFingerprints,
  });
  considered = candidates.length;

  if (candidates.length === 0) {
    // Not an error. A quiet day, or every feed 404ing — and `sourceFailures`
    // is what tells those two apart, which is why it is on the wire.
    deps.log?.('[ca] no candidates after the feed sweep; nothing to shortlist');
    return finish();
  }

  /* -------------------------------------------------------- phase: shortlist */

  if (deps.isCancelled()) {
    cancelled = true;
    return finish();
  }

  const take = Math.min(MAX_SHORTLIST, Math.max(maxItems, Math.ceil(maxItems * 1.5)));
  deps.onProgress({
    phase: 'shortlist',
    done: 0,
    total: candidates.length,
    detail: `Choosing from ${candidates.length} headlines`,
  });

  const shortlistResult = await deps.shortlist({
    model: input.model,
    system: input.shortlistSystem,
    candidates,
    syllabusSlugs: input.syllabusSlugs,
    sections: input.sections,
    slugLabels: input.slugLabels,
    take,
    maxTokens: shortlistMaxTokens(take),
    requestId: input.requestId,
    signal: deps.signal,
  });
  await bill('shortlist', shortlistResult.usage);
  provenance = shortlistResult.provenance;

  if (shortlistResult.stopReason === 'max_tokens' || shortlistResult.picks === null) {
    // A truncated list is not a partial result, it is an unknown one: the last
    // pick is cut mid-field and its index may be anything. Discard the whole
    // reply rather than fetching an article the model never actually chose.
    deps.log?.('[ca] shortlist truncated or unparseable; nothing was fetched');
    return finish();
  }

  const byIndex = new Map<number, Candidate>(candidates.map((c) => [c.index, c]));
  const picks: ShortlistPick[] = [];
  const pickedEntries: FeedEntry[] = [];
  const pickByUrl = new Map<string, ShortlistPick>();
  const seenPickIndex = new Set<number>();

  for (const pick of shortlistResult.picks) {
    if (picks.length >= MAX_SHORTLIST) break;
    const candidate = byIndex.get(pick.candidateIndex);
    if (!candidate) {
      // The bounds check the index form exists to make possible.
      noteDrop('unknown_url', `shortlist named candidate ${pick.candidateIndex}, which does not exist`);
      continue;
    }
    if (seenPickIndex.has(pick.candidateIndex)) continue;
    seenPickIndex.add(pick.candidateIndex);

    picks.push(pick);
    pickByUrl.set(candidate.url, pick);
    pickedEntries.push({
      feedId: candidate.feedId,
      sourceName: candidate.sourceName,
      url: candidate.url,
      canonicalUrl: candidate.canonicalUrl,
      title: candidate.headline,
      publishedAt: candidate.publishedAt,
      lede: candidate.lede,
    });
  }

  shortlisted = picks.length;
  deps.onProgress({
    phase: 'shortlist',
    done: candidates.length,
    total: candidates.length,
    detail: `${shortlisted} shortlisted`,
  });

  if (shortlisted === 0) return finish();

  /* ------------------------------------------------------------ phase: fetch */

  if (deps.isCancelled()) {
    cancelled = true;
    return finish();
  }

  deps.onProgress({
    phase: 'fetch',
    done: 0,
    total: pickedEntries.length,
    detail: `Fetching ${pickedEntries.length} articles`,
  });

  const fetched = await deps.fetchDocuments(pickedEntries, {
    requestId: input.requestId,
    date: input.date,
    signal: deps.signal,
    isCancelled: deps.isCancelled,
    onProgress: (done, total) =>
      deps.onProgress({ phase: 'fetch', done, total, detail: `Fetched ${done} of ${total}` }),
  });
  sourceFailures.push(...fetched.failures);
  for (const failure of fetched.failures) {
    noteDrop('fetch_failed', `${failure.url}: ${failure.reason} (${failure.detail})`);
  }

  if (fetched.documents.length === 0) {
    deps.log?.('[ca] every shortlisted article failed to fetch');
    return finish();
  }

  /* ------------------------------------------------------------ phase: notes */

  if (deps.isCancelled()) {
    cancelled = true;
    return finish();
  }

  deps.onProgress({
    phase: 'notes',
    done: 0,
    total: fetched.documents.length,
    detail: `Writing notes on ${fetched.documents.length} articles`,
  });

  const notesResult = await deps.notes({
    model: input.model,
    system: input.notesSystem,
    documents: fetched.documents,
    picks,
    syllabusSlugs: input.syllabusSlugs,
    sections: input.sections,
    slugLabels: input.slugLabels,
    maxTokens: notesMaxTokens(fetched.documents.length),
    requestId: input.requestId,
    signal: deps.signal,
  });
  await bill('notes', notesResult.usage);
  if (notesResult.provenance === 'fake') provenance = 'fake';

  if (notesResult.stopReason === 'max_tokens' || notesResult.drafts === null) {
    deps.log?.('[ca] notes call truncated or unparseable; the whole batch is discarded');
    return finish();
  }

  /* ----------------------------------------------------------- phase: ground */

  deps.onProgress({
    phase: 'ground',
    done: 0,
    total: notesResult.drafts.length,
    detail: 'Checking every quote against the source text',
  });

  const documentsByUrl = new Map<string, SourceDocument>();
  for (const document of fetched.documents) {
    documentsByUrl.set(document.url, document);
    documentsByUrl.set(document.canonicalUrl, document);
  }

  const grounded: GroundedItem[] = [];
  let checked = 0;
  for (const draft of notesResult.drafts) {
    checked += 1;
    const document = documentsByUrl.get(draft.url);
    if (!document) {
      // A url that is not one of the supplied documents means the note was
      // written about something the server never fetched. There is nothing to
      // check it against, so there is nothing to trust.
      noteDrop('unknown_url', `note names ${draft.url}, which was not fetched`);
      continue;
    }

    // Length is checked HERE rather than in ground.ts, which owns only the
    // "is this in the source" question. It is free, so it runs before the
    // substring scan over a note that was never going to be kept.
    if (countWords(draft.noteMd) > MAX_NOTE_WORDS) {
      noteDrop('note_too_long', `${draft.url}: over ${MAX_NOTE_WORDS} words`);
      continue;
    }

    const verdict = deps.verifyGrounding(draft, document);
    if (!verdict.ok) {
      noteDrop(verdict.reason, `${draft.url}: ${verdict.detail}`);
      continue;
    }

    // The shortlist judged the syllabus hook from the headline and the notes
    // call from the full text. Taking the UNION loses nothing — `select.ts`
    // still requires membership in the slugs the REQUEST supplied — and it
    // stops an item being dropped for an untagged field the first call did tag.
    const pick = pickByUrl.get(document.url);
    grounded.push({
      ...draft,
      // Normalised quotes with resolved offsets, so
      // `normalisedText.slice(at, at + quote.length) === quote` holds for every
      // span that reaches the device.
      evidence: verdict.evidence,
      /**
       * Capped HERE, not only in the JSON schema.
       *
       * `ca/schema.ts` bounds each call's tag list with `maxItems`, and that is
       * the only thing that ever bounded them. This union takes the shortlist
       * call's tags AND the notes call's, so two lists of four legally produce
       * eight — today, on the current provider, with both schemas honoured. And
       * `maxItems` is one of the keywords an OpenAI-compatible strict dialect
       * strips, so a second provider removes even the per-call bound.
       *
       * An over-tagged item is over-eager rather than wrong, so the excess is
       * dropped and the item kept. Dropping the item would discard a good story
       * over a tagging error the reader would never have noticed.
       */
      syllabusSlugs: [...new Set([...draft.syllabusSlugs, ...(pick?.syllabusSlugs ?? [])])].slice(
        0,
        MAX_SYLLABUS_SLUGS_PER_ITEM,
      ),
      sectionKeys: [...new Set([...draft.sectionKeys, ...(pick?.sectionKeys ?? [])])].slice(
        0,
        MAX_SECTION_KEYS_PER_ITEM,
      ),
      sourceName: document.sourceName,
      sourceUrl: document.url,
      canonicalUrl: document.canonicalUrl,
      publishedAt: document.publishedAt,
      headlineFingerprint: headlineFingerprint(draft.headline),
    });
    deps.onProgress({
      phase: 'ground',
      done: checked,
      total: notesResult.drafts.length,
      detail: `${grounded.length} grounded`,
    });
  }

  /* ----------------------------------------------------------- phase: select */

  const selection: SelectionRequest = {
    syllabusSlugs: input.syllabusSlugs,
    maxItems,
    seenCanonicalUrls: input.seenCanonicalUrls,
    seenFingerprints: input.seenFingerprints,
    sectionCountsThisWeek: input.sectionCountsThisWeek,
  };

  const outcome = selectItems(grounded, selection);
  for (const dropped of outcome.drops) noteDrop(dropped.reason, `${dropped.url}: ${dropped.detail}`);

  anthroLinkRate = Number(outcome.anthroLinkRate.toFixed(3));
  deps.onProgress({
    phase: 'select',
    done: outcome.kept.length,
    total: maxItems,
    detail: `${outcome.kept.length} of at most ${maxItems}`,
  });

  for (const item of outcome.kept) {
    kept += 1;
    deps.emitItem(item);
  }

  if (anthroLinkRate > 0.4) {
    // Loud on purpose. A sustained rate this high is not a good day for
    // Anthropology, it is a prompt claiming a link on everything — which is a
    // fixable bug rather than a mystery about why the optional column is full
    // of gestures.
    deps.log?.(
      `[ca] HIGH ANTHRO LINK RATE: ${outcome.kept.filter((i) => i.anthro !== null).length}/${outcome.kept.length} items claim a P1-P2 link. The anthropology prompt is reaching.`,
    );
  }

  return finish();
}
