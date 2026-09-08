/**
 * `POST /ca/headlines` — the digest, with no model and no spend.
 *
 * Same request body as `/ca/digest`, so the app reuses its request builder
 * unchanged. Same ITEM shape on the way out, so `ca-map.ts` ingests the result
 * through the path it already has. What differs is everything in between:
 * the feeds are swept for real, selection is by rule, and no article body is
 * fetched because nothing here needs one.
 *
 * ## Plain JSON, not SSE
 *
 * `/ca/digest` streams because a two-call model pipeline takes a minute and
 * silence for a minute reads as a hang. A feed sweep is a few seconds, so a
 * response is the honest shape — progress frames for something that finishes
 * before the first frame would be read is ceremony.
 *
 * ## No reservation, no ledger entry
 *
 * Nothing here is billable. Taking a reservation "for symmetry" would let a
 * free endpoint exhaust the pool that answer evaluation depends on, which is
 * the exact starvation `EVAL_RESERVED_FLOOR_USD` exists to prevent.
 */

import express, { Router, type Request, type Response } from 'express';

import { loadSources } from '../ca/sources.js';
import { fetchFeedEntries } from '../ca/fetch.js';
import { prepareCandidates } from '../ca/select.js';
import { selectHeadlines, type HeadlineVocabularyEntry } from '../ca/headlines.js';
import { parseCaBody } from './ca.js';

/**
 * The app's own `CA_RULES.maxNoteWords`. A lede longer than this is truncated
 * HERE rather than rejected there: the app drops an over-long note as
 * `note_too_long`, which is right when a model overran its brief and wrong when
 * a publisher simply writes long standfirsts.
 */
const MAX_NOTE_WORDS = 90;

/**
 * Ten, and the app caps again at its own daily budget.
 *
 * Sending a few more than she will read is deliberate: the device applies
 * `dailyItemCap`, the read-rate adjustment and the section cap using state the
 * server does not have, and it can only choose from what it was sent.
 */
const MAX_HEADLINES = 10;

/** Words, not characters — the app counts words and the two must agree. */
function truncateWords(text: string, limit: number): string {
  const words = text.trim().split(/\s+/).filter((word) => word !== '');
  if (words.length <= limit) return words.join(' ');
  return `${words.slice(0, limit).join(' ')}…`;
}

/**
 * The note for a headline item: the publisher's own standfirst, verbatim.
 *
 * Never a summary, never a paraphrase, never a sentence this server composed.
 * With no model there is nothing to summarise WITH, and an invented note is the
 * one output this codebase refuses to produce — a scripted score is obviously
 * scripted, an invented gloss on a real news story is not.
 *
 * Falls back to the headline when a feed ships no description, which several
 * do. The headline is also the publisher's words, so the rule holds.
 */
function noteFor(headline: string, lede: string | null): string {
  const source = lede !== null && lede.trim() !== '' ? lede : headline;
  return truncateWords(source, MAX_NOTE_WORDS);
}

/**
 * Route-scoped, never `app.use(express.json())`.
 *
 * Same rule as `routes/ca.ts` and `routes/mcq.ts`: a global JSON parser sits in
 * front of `/evaluate`, whose body is multipart, and consuming that stream
 * before multer sees it leaves busboy parsing nothing.
 *
 * The vocabulary is ~438 entries with labels, so the limit matches the digest
 * route's. A smaller one here would fail exactly the requests carrying a full
 * syllabus — the ones this endpoint exists to serve.
 */
const parseJsonBody = express.json({ limit: '256kb' });

export const caHeadlinesRouter: Router = Router();

caHeadlinesRouter.post('/', parseJsonBody, async (req: Request, res: Response) => {
  const parsed = parseCaBody(req.body);
  if (typeof parsed === 'string') {
    res.status(400).json({ error: 'bad_request', detail: parsed });
    return;
  }

  const controller = new AbortController();
  /**
   * `res`, not `req`, and the difference is the whole endpoint.
   *
   * `req.on('close')` fires when the REQUEST stream ends — which the JSON body
   * parser causes the moment it finishes reading the body, before any work
   * starts. Hooked there, the controller aborted instantly and every feed fetch
   * returned nothing: HTTP 200, nine sources, zero entries, no error anywhere.
   * `res.on('close')` is the one that means the client actually went away.
   */
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  let feeds;
  try {
    const set = await loadSources();
    feeds = Array.isArray(set) ? set : set.feeds;
  } catch (err) {
    res.status(500).json({ error: 'sources_unavailable', detail: (err as Error).message });
    return;
  }

  const swept = await fetchFeedEntries(feeds, { signal: controller.signal });

  const vocabulary: HeadlineVocabularyEntry[] = parsed.syllabusSlugs.map((slug) => ({
    slug,
    label: parsed.slugLabels[slug] ?? '',
    paper: parsed.slugPapers[slug] ?? null,
    level: parsed.sections.includes(slug) ? 'section' : 'leaf',
  }));

  /**
   * Every swept entry is a candidate. NOT `MAX_CANDIDATES`.
   *
   * That cap is forty because forty headlines is as much as it is worth paying
   * a model to read. Nothing here is paid, and scoring three hundred strings is
   * microseconds — so the cap buys nothing and costs a great deal. Applied, it
   * takes the first forty in FEED ORDER, which is PIB and RBI, and the Hindu
   * editorials and Explained pieces never reach selection at all. Measured on
   * the live feeds that left two tagged items out of forty; without the cap the
   * whole sweep competes.
   *
   * Deduplicated against the device's history first, so the day's picks are
   * ones she has not seen rather than ones of which half are repeats.
   */
  const candidates = prepareCandidates(swept.entries, {
    seenCanonicalUrls: parsed.seenCanonicalUrls,
    seenFingerprints: parsed.seenFingerprints,
    limit: swept.entries.length,
  });

  const { picked, drops } = selectHeadlines({
    candidates,
    vocabulary,
    sources: feeds.map((feed) => ({
      id: feed.id,
      name: feed.name,
      papers: feed.papers,
      trust: feed.trust,
    })),
    date: parsed.date,
    limit: Math.min(parsed.maxItems > 0 ? parsed.maxItems : MAX_HEADLINES, MAX_HEADLINES),
  });

  const items = picked.map((pick) => {
    const note = noteFor(pick.candidate.headline, pick.candidate.lede);
    return {
      headline: pick.candidate.headline,
      sourceUrl: pick.candidate.url,
      canonicalUrl: pick.candidate.canonicalUrl,
      sourceName: pick.candidate.sourceName,
      publishedAt: pick.candidate.publishedAt,
      kind: pick.itemKind,
      noteMd: note,
      /**
       * The note again, as the evidence backing it.
       *
       * `ca-map.ts` rejects an item carrying no evidence, and rightly: a claim
       * with nothing behind it is what the grounding check exists to catch.
       * Here the note IS the verbatim source text, so quoting it is not a
       * formality to satisfy a validator — there is no claim beyond the quote,
       * and the item is exactly as grounded as it says it is.
       */
      evidence: [{ quote: note }],
      syllabusTags: pick.syllabusTags,
      /** Declared by the feed in `sources.json`, never inferred from the text. */
      papers: pick.papers,
      // No Anthropology link. Deciding that a story instantiates a P1 concept is
      // a judgement call, and a rules engine guessing at it would produce
      // precisely the topical gesture `sanitiseAnthro` strips.
      anthro: null,
    };
  });

  res.json({
    requestId: parsed.requestId,
    date: parsed.date,
    mode: 'headlines',
    items,
    considered: candidates.length,
    swept: swept.entries.length,
    feedCount: feeds.length,
    drops,
    // Reported, never hidden. Three sources in `sources.json` are HTML index
    // pages with no feed and always fail here; a silent empty result would read
    // as "nothing happened today" instead of "these sources are unreadable".
    sourceFailures: swept.failures,
  });
});
