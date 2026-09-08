/**
 * POST /ca/digest — the day's feeds in, a handful of grounded notes out.
 *
 * Events emitted, in order:
 *
 *   meta     { requestId, date, model, promptVersion, sourceSetVersion, ... }
 *   progress { phase, done, total, detail }         (1..N, the slow phases)
 *   item     { ...one grounded digest item }        (0..N, never more than asked)
 *   summary  { considered, shortlisted, kept, dropped, dropReasons, ... }
 *   usage    { inputTokens, outputTokens, monthUsd, caMonthUsd, ... }
 *   done     { ok: true, provenance }
 *   error    { message }                            (terminal, replaces done)
 *
 * WHY SSE AND NOT JSON: the fetch phase alone is twenty to sixty seconds of
 * network I/O against a dozen news sites, and the run is minutes end to end. A
 * JSON response that drops at ninety seconds returns nothing while having
 * billed for everything — on a phone, on mobile data, which is where this runs.
 *
 * WHY `progress` FRAMES ARE NOT DECORATION: the client's idle timer cuts a
 * stream that goes silent, and a blank screen for a minute reads as a hang
 * regardless. These frames both keep the connection legitimately alive and tell
 * her which of the slow phases is running.
 *
 * An `item` frame is a PROMISE: every quote in it was found as a literal
 * substring of a page this server fetched, every number and date in its note
 * was found there too, and it survived a selection pass that is mostly reasons
 * to say no. Nothing partially checked is ever emitted.
 */

import express, {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { config } from '../config.js';
import { SseStream, clientHasDisconnected } from '../sse.js';
import { capStatus, recordUsage, releaseReservation, tryReserve } from '../usage.js';
import { compileNotesPrompt, compileShortlistPrompt } from '../ca/index.js';
import { fetchDocuments as networkFetchDocuments, fetchFeedEntries } from '../ca/fetch.js';
import { verifyGrounding } from '../ca/ground.js';
import {
  DEFAULT_MAX_ITEMS,
  MAX_DAILY_ITEMS,
  MIN_MAX_ITEMS,
  clampMaxItems,
  runCaPipeline,
  type CaPipelineDeps,
} from '../ca/pipeline.js';
import { CA_TIER, caModel, currentNotesRunner, currentShortlistRunner } from '../ca/runner.js';
import { loadSources } from '../ca/sources.js';

/** Endpoint string the ledger and the per-endpoint sub-cap key off. */
export const CA_ENDPOINT = '/ca/digest';

const MAX_ID_CHARS = 128;
const MAX_SLUG_CHARS = 200;
/** Enough for a full syllabus and a fortnight of history, without a weapon. */
const MAX_LIST_ENTRIES = 1000;

/**
 * JSON body parsing, mounted ON THIS ROUTE ONLY.
 *
 * Deliberately not `app.use(express.json())`: a global parser would sit in
 * front of /evaluate's multipart intake, whose staged size enforcement depends
 * on nothing having touched the request stream first. See routes/mcq.ts.
 */
const parseJsonBody = express.json({ limit: '256kb' });

function badRequest(detail: string): { error: string; detail: string } {
  return { error: 'bad_request', detail };
}

/** Advisory fast-fail, matching /evaluate and /mcq. The reservation is truth. */
const capFastFail: RequestHandler = async (_req, res, next) => {
  const preCheck = await capStatus({ endpoint: CA_ENDPOINT });
  if (!preCheck.allowed) {
    res.status(429).json({ error: 'spend_cap_reached', detail: preCheck.reason, caps: preCheck });
    return;
  }
  next();
};

/* ------------------------------------------------------------- the ingest seam */

/**
 * Feeds and article bodies. NOT a model seam — see `ca/runner.ts` for those.
 *
 * It exists so the HTTP tests never open a socket and so `EVAL_RUNNER=fake` can
 * serve its own fixture documents. That second reason is a safety property, not
 * a convenience: a fake note written over a REAL fetched article would carry a
 * real outlet's name and URL on text no journalist wrote.
 *
 * `verifyGrounding` is deliberately NOT seamed. It is the one check the whole
 * phase rests on, and a swappable grounding check is a grounding check that can
 * be swapped out.
 */
export interface CaIngest {
  collectEntries: CaPipelineDeps['collectEntries'];
  fetchDocuments: CaPipelineDeps['fetchDocuments'];
}

const networkIngest: CaIngest = {
  collectEntries: async ({ signal, isCancelled }) => {
    const { feeds } = await loadSources();
    if (isCancelled()) return { entries: [], failures: [], feedCount: feeds.length };
    const swept = await fetchFeedEntries(feeds, { signal, isCancelled });
    return {
      entries: swept.entries,
      failures: [
        ...swept.failures,
        // `kind: 'index'` sources have no feed and were never polled. Folding
        // them into `sourceFailures` rather than dropping them keeps
        // fetch.ts's own rule intact end to end: a source that produced
        // nothing must never be indistinguishable from a quiet news day, and
        // three of the allowlisted sources publish no feed at all.
        ...swept.unsupported.map((feed) => ({
          url: feed.url,
          feedId: feed.id,
          reason: 'not_html' as const,
          detail: `${feed.name} publishes no RSS or Atom feed; it was not polled`,
        })),
      ],
      feedCount: feeds.length,
    };
  },
  fetchDocuments: (entries, opts) =>
    networkFetchDocuments(entries, {
      signal: opts.signal,
      isCancelled: opts.isCancelled,
      onProgress: opts.onProgress,
    }),
};

let activeIngest: CaIngest = networkIngest;

/** Test/dev seam. Passing null restores the real network ingest. */
export function setCaIngest(ingest: CaIngest | null): void {
  activeIngest = ingest ?? networkIngest;
}

/* -------------------------------------------------------------- body parsing */

interface ParsedBody {
  requestId: string;
  date: string;
  maxItems: number;
  /**
   * Every key the app will resolve — section keys AND leaf slugs, one flat
   * list. This is the allowlist `select.ts` rule 1 tests against.
   *
   * Flat and not leaves-only, because `tagVocabulary` emits leaves only for
   * sections she has started: on a fresh install that list is EMPTY and every
   * item would drop as `no_syllabus_tag` while the tag it carried was perfect.
   * The app resolves both levels through one map — see the `SECTION_KEY_SEPARATOR`
   * comment in `app/src/lib/ca-tags.ts` — so one flat allowlist here agrees
   * with the device by construction.
   */
  syllabusSlugs: string[];
  /** The section-level subset, for the diversity cap and the prompt's own list. */
  sections: string[];
  /**
   * Slug to printed heading, for the prompt only. Never parsed, never a key.
   *
   * `anthro-p1-kinship-descent` tells a model very little; "Kinship, Descent
   * and Alliance" tells it everything. The app pays for these bytes inside
   * `VOCABULARY_BUDGET_BYTES` precisely so they can be rendered.
   */
  slugLabels: Record<string, string>;
  /** Slug to paper. Used by headlines mode; ignored by the model path. */
  slugPapers: Record<string, string>;
  linkAnthropology: boolean;
  seenCanonicalUrls: string[];
  seenFingerprints: string[];
  sectionCountsThisWeek: Record<string, number>;
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max;
}

function readList(value: unknown, field: string, max: number): string[] | string {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return `${field} must be an array of strings`;
  if (value.length > MAX_LIST_ENTRIES) return `${field} exceeds ${MAX_LIST_ENTRIES} entries`;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return `${field} must contain only strings`;
    if (entry.length > max) return `${field} contains an over-long entry`;
    if (entry.trim() !== '') out.push(entry);
  }
  return out;
}

interface Vocabulary {
  slugs: string[];
  sections: string[];
  labels: Record<string, string>;
  /**
   * Slug to paper (`gs2`, `anthro_p1`, …).
   *
   * The app has always sent this on every vocabulary entry; the server simply
   * dropped it. Headlines mode needs it to refuse a tag whose paper the source
   * feed does not cover, which is what stops an RBI release being filed under
   * Indian art. Retaining a field the wire already carries — no contract change.
   */
  papers: Record<string, string>;
}

/**
 * The app's `TagVocabularyEntry[]`, split into what this server reasons about.
 *
 * The app owns the taxonomy and ships it on every request — see the header of
 * `app/src/lib/ca-tags.ts`. `slug` is the whole contract; `label`, `paper` and
 * `level` are advisory, so a missing or unrecognised `level` degrades to "leaf"
 * rather than rejecting: an entry that cannot be classified is still a key the
 * device can resolve, and refusing the request would cost a paid digest over a
 * field the contract itself calls advisory.
 */
function readVocabulary(value: unknown): Vocabulary | string {
  if (value === undefined || value === null) return { slugs: [], sections: [], labels: {}, papers: {} };
  if (!Array.isArray(value)) return 'vocabulary must be an array of {slug, label, paper, level}';
  if (value.length > MAX_LIST_ENTRIES) return `vocabulary exceeds ${MAX_LIST_ENTRIES} entries`;

  const slugs: string[] = [];
  const sections: string[] = [];
  const labels: Record<string, string> = {};
  const papers: Record<string, string> = {};
  const seen = new Set<string>();

  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return 'vocabulary entries must be objects with a slug';
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.slug !== 'string') return 'vocabulary entries must each have a string slug';
    const slug = entry.slug.trim();
    if (slug === '') continue;
    if (slug.length > MAX_SLUG_CHARS) return 'vocabulary contains an over-long slug';
    // First occurrence wins, matching `buildTagIndex`'s `remember()`. A repeat
    // would otherwise inflate the allowlist and the prompt with no new keys.
    if (seen.has(slug)) continue;
    seen.add(slug);

    slugs.push(slug);
    if (entry.level === 'section') sections.push(slug);
    if (typeof entry.label === 'string' && entry.label.trim() !== '') {
      labels[slug] = entry.label.trim().slice(0, MAX_SLUG_CHARS);
    }
    if (typeof entry.paper === 'string' && entry.paper.trim() !== '') {
      papers[slug] = entry.paper.trim().slice(0, MAX_SLUG_CHARS);
    }
  }

  return { slugs, sections, labels, papers };
}

/** Returns the parsed body, or a message describing the first problem. */
export function parseCaBody(raw: unknown): ParsedBody | string {
  const body = (raw ?? {}) as Record<string, unknown>;

  if (!isBoundedString(body.requestId, MAX_ID_CHARS)) return 'requestId is required';
  // Byte-compared and echoed, never parsed through `Date`. The digest day is
  // the app's local calendar day, and re-deriving it here in another timezone
  // is how a digest lands on the wrong date at month boundaries.
  if (typeof body.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
    return 'date is required as YYYY-MM-DD';
  }

  const vocabulary = readVocabulary(body.vocabulary);
  if (typeof vocabulary === 'string') return vocabulary;
  if (vocabulary.slugs.length === 0) {
    // Not a formality. An item resolving to no syllabus key earns no slot, so
    // an empty vocabulary means every item would be dropped — and running two
    // paid model calls to deliver a guaranteed empty digest is money for
    // nothing. `tagVocabulary` always offers every live section, so an empty
    // list here means the device's syllabus is unseeded, not that she is new.
    return 'vocabulary must contain at least one entry; without one nothing can be selected';
  }

  const seenCanonicalUrls = readList(body.seenCanonicalUrls, 'seenCanonicalUrls', 2048);
  if (typeof seenCanonicalUrls === 'string') return seenCanonicalUrls;
  const seenFingerprints = readList(body.seenFingerprints, 'seenFingerprints', MAX_SLUG_CHARS);
  if (typeof seenFingerprints === 'string') return seenFingerprints;

  const maxItems = body.maxItems === undefined ? DEFAULT_MAX_ITEMS : Number(body.maxItems);
  if (!Number.isInteger(maxItems) || maxItems < MIN_MAX_ITEMS || maxItems > MAX_DAILY_ITEMS) {
    return `maxItems must be an integer between ${MIN_MAX_ITEMS} and ${MAX_DAILY_ITEMS}`;
  }

  if (body.linkAnthropology !== undefined && typeof body.linkAnthropology !== 'boolean') {
    return 'linkAnthropology must be a boolean';
  }

  const counts: Record<string, number> = {};
  if (body.sectionCountsThisWeek !== undefined && body.sectionCountsThisWeek !== null) {
    if (typeof body.sectionCountsThisWeek !== 'object' || Array.isArray(body.sectionCountsThisWeek)) {
      return 'sectionCountsThisWeek must be an object of section -> count';
    }
    for (const [key, value] of Object.entries(body.sectionCountsThisWeek)) {
      if (key.length > MAX_SLUG_CHARS) return 'sectionCountsThisWeek has an over-long key';
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        return 'sectionCountsThisWeek values must be non-negative numbers';
      }
      counts[key] = Math.floor(value);
    }
  }

  return {
    requestId: body.requestId,
    date: body.date,
    maxItems: clampMaxItems(maxItems),
    syllabusSlugs: vocabulary.slugs,
    sections: vocabulary.sections,
    slugLabels: vocabulary.labels,
    slugPapers: vocabulary.papers,
    linkAnthropology: body.linkAnthropology !== false,
    seenCanonicalUrls,
    seenFingerprints,
    sectionCountsThisWeek: counts,
  };
}

/* ------------------------------------------------------------------ handler */

const handleDigest: RequestHandler = async (req, res) => {
  const parsed = parseCaBody(req.body);
  if (typeof parsed === 'string') {
    res.status(400).json(badRequest(parsed));
    return;
  }

  const [shortlistPrompt, notesPrompt, sources] = await Promise.all([
    compileShortlistPrompt(),
    compileNotesPrompt({ linkAnthropology: parsed.linkAnthropology }),
    loadSources(),
  ]);

  const model = caModel();

  /**
   * The reservation.
   *
   * `units` counts MODEL CALLS and a digest makes exactly two — the shortlist
   * and the notes — however many articles it fetches in between. Counting the
   * whole run as one unit would let a retry loop make twice the calls the daily
   * ceiling was set for; counting each fetched article would make the digest
   * look like a batch it is not.
   */
  const reservation = {
    endpoint: CA_ENDPOINT,
    estimateUsd: config.caps.estimatedCaUsdPerDigest,
    units: 2,
  };

  const admitted = await tryReserve(reservation);
  if (!admitted.ok) {
    res.status(429).json({
      error: 'spend_cap_reached',
      detail: admitted.caps.reason,
      caps: admitted.caps,
    });
    return;
  }

  // Idempotent: a race between the disconnect path and normal completion must
  // not double-release, which would hand back budget that was never held.
  let released = false;
  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    releaseReservation(reservation);
  };

  /**
   * Cancellation.
   *
   * A digest is two model calls with twenty to sixty seconds of network between
   * them. The client leaving during the fetch must both abort what is in flight
   * AND stop the notes call from starting — doing only the first still pays for
   * the expensive second call and delivers none of it, which is the worst of
   * both outcomes: full spend, zero value.
   */
  const controller = new AbortController();
  let peerGone = false;
  const onPeerGone = (): void => {
    if (peerGone) return;
    // `req` emits 'close' as soon as the JSON body has been consumed, well
    // before the client actually leaves, so the socket has to be checked too.
    if (!clientHasDisconnected(res)) return;
    peerGone = true;
    console.error('[ca] client disconnected mid-digest; aborting and stopping further phases');
    controller.abort();
  };
  req.on('close', onPeerGone);
  res.on('close', onPeerGone);

  let sse: SseStream | null = null;

  try {
    sse = new SseStream(res);
    const stream = sse;

    stream.send('meta', {
      requestId: parsed.requestId,
      date: parsed.date,
      model,
      promptVersion: shortlistPrompt.version,
      sourceSetVersion: sources.sourceSetVersion,
      maxItems: parsed.maxItems,
      linkAnthropology: parsed.linkAnthropology,
      syllabusSlugCount: parsed.syllabusSlugs.length,
    });

    const result = await runCaPipeline(
      {
        requestId: parsed.requestId,
        date: parsed.date,
        maxItems: parsed.maxItems,
        syllabusSlugs: parsed.syllabusSlugs,
        sections: parsed.sections,
        slugLabels: parsed.slugLabels,
        seenCanonicalUrls: parsed.seenCanonicalUrls,
        seenFingerprints: parsed.seenFingerprints,
        sectionCountsThisWeek: parsed.sectionCountsThisWeek,
        model,
        shortlistSystem: shortlistPrompt.systemPrompt,
        notesSystem: notesPrompt.systemPrompt,
      },
      {
        collectEntries: activeIngest.collectEntries,
        fetchDocuments: activeIngest.fetchDocuments,
        // Never seamed. See the note on CaIngest.
        verifyGrounding,
        shortlist: currentShortlistRunner(),
        notes: currentNotesRunner(),
        emitItem: (item) => stream.send('item', item),
        onProgress: (progress) => stream.send('progress', progress),
        // Billed per CALL, awaited. A run that dies after the shortlist has
        // consumed one call's tokens and the ledger says one call.
        onCallUsage: async (event) => {
          await recordUsage({
            endpoint: CA_ENDPOINT,
            tier: CA_TIER,
            model: event.model,
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
            cacheCreationInputTokens: event.usage.cacheCreationInputTokens,
            cacheReadInputTokens: event.usage.cacheReadInputTokens,
          }).catch((err) => {
            // Never let a ledger write failure kill a digest that is otherwise
            // delivering; the error is logged and the run continues.
            console.error('[ca] usage write failed', err);
          });
        },
        isCancelled: () => peerGone,
        signal: controller.signal,
        log: (message, detail) =>
          detail === undefined ? console.log(message) : console.log(message, detail),
      },
    );

    stream.send('summary', result.summary);

    const after = await capStatus({ endpoint: CA_ENDPOINT });
    stream.send('usage', {
      inputTokens: result.totalUsage.inputTokens,
      outputTokens: result.totalUsage.outputTokens,
      cacheCreationInputTokens: result.totalUsage.cacheCreationInputTokens,
      cacheReadInputTokens: result.totalUsage.cacheReadInputTokens,
      monthUsd: Number(after.monthUsd.toFixed(2)),
      monthlyCapUsd: after.monthlyCapUsd,
      caMonthUsd: Number(after.caMonthUsd.toFixed(2)),
      caMonthlyCapUsd: after.caMonthlyCapUsd,
    });

    // `provenance` rides on the terminal frame rather than on `summary`, which
    // is the frozen `CaSummaryFrame` and stays exactly that.
    stream.send('done', { ok: true, provenance: result.provenance });
  } catch (err) {
    console.error('[ca]', err);
    // Never echoes err.message; the detail is in the server log above.
    sse?.send('error', { message: 'Digest generation failed. Check the server logs.' });
  } finally {
    // Outermost level of the handler. Moving this inside a callback would leak
    // the reservation on any throw before that callback ran, and a leaked CA
    // reservation ratchets the sub-cap down until restart.
    releaseOnce();
    req.off('close', onPeerGone);
    res.off('close', onPeerGone);
    if (sse) await sse.end();
    else if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
  }
};

/* -------------------------------------------------------------------- router */

/**
 * Four-arity error middleware for the JSON intake, scoped to this router.
 *
 * `express.json` throws on a malformed or over-large body; without this those
 * become a generic 500 and the client cannot tell a typo from an outage.
 */
export function caJsonErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  const candidate = err as { type?: string; status?: number };
  if (candidate?.type === 'entity.too.large') {
    res.status(413).json({ error: 'payload_too_large', detail: 'Request body exceeds 256kb.' });
    return;
  }
  if (candidate?.type === 'entity.parse.failed' || candidate?.status === 400) {
    res.status(400).json(badRequest('malformed JSON body'));
    return;
  }
  next(err);
}

export const caRouter: Router = Router();

caRouter.post('/digest', parseJsonBody, capFastFail, handleDigest);

caRouter.use(caJsonErrorHandler);
