/**
 * A scripted digest. No model, no network, no spend.
 *
 * ## Fake safety is stricter here than anywhere else in this app
 *
 * A fake SCORE is obviously a score — she reads "62/125" and knows what kind of
 * claim that is. A fake FACT looks exactly like a real fact, and this endpoint's
 * whole output is facts she is meant to copy into an answer. So every fake item
 * is marked in three places she cannot miss:
 *
 *   - the headline is prefixed `[SAMPLE]`
 *   - `sourceName` is the literal string `SAMPLE`
 *   - `sourceUrl` is `about:blank`, which resolves nowhere on purpose
 *
 * The URL carries a `#sample-N` fragment so the pipeline's own duplicate and
 * document-lookup keys stay distinct; the scheme is still `about:blank`, so
 * tapping it in the app goes nowhere, and no real outlet's name or domain is
 * ever attached to a sentence a model invented.
 *
 * That is also why this file supplies the DOCUMENTS as well as the two model
 * calls. A fake note over a real fetched article would carry The Hindu's name
 * and The Hindu's URL on text no journalist wrote — which is worse than any
 * failure this switch was built to avoid.
 *
 * ## It must FAIL sometimes
 *
 * A fake that always agrees with its own fixture leaves the most expensive
 * branch of the pipeline — the grounding check that decides whether an item is
 * discarded — never exercised outside production. So exactly one item per run
 * fabricates a quote that is not in the fixture text, and several others carry
 * one defect each from a fixed schedule. Running `dev:fake` and seeing every
 * item arrive would mean the safety net is not connected.
 *
 * Deterministic and seeded by (requestId, date, ordinal): a fixed script would
 * emit the same items every day and the second day would be entirely eaten by
 * the duplicate window, which looks exactly like a digest bug.
 */

import type {
  NotesRequest,
  NotesResult,
  NotesRunner,
  ShortlistPick,
  ShortlistRequest,
  ShortlistResult,
  ShortlistRunner,
} from './ca/runner.js';
import type {
  DigestItemDraft,
  FeedEntry,
  FetchFailure,
  ItemKind,
  SourceDocument,
} from './ca/types.js';
import type { CaIngest } from './routes/ca.js';

/** How many fixture articles the fake feed sweep offers. */
export const FAKE_ARTICLE_COUNT = 14;

const SAMPLE_SOURCE = 'SAMPLE';
const SAMPLE_FEED = 'sample-feed';

/** Resolves nowhere. See the header — this is a safety property, not a stub. */
function sampleUrl(ordinal: number): string {
  return `about:blank#sample-${ordinal}`;
}

/* --------------------------------------------------------------- seeding */

/** FNV-1a over the seed tuple. Same input, same digest, every time. */
function seedOf(material: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < material.length; i += 1) {
    h ^= material.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function pick<T>(items: readonly T[], seed: number, salt: number): T {
  return items[(seed >>> salt) % items.length] as T;
}

const SUBJECTS = [
  'inter-state water allocation',
  'the coastal regulation zone notification',
  'the tribal sub-plan outlay',
  'municipal solid waste rules',
  'the minimum support price mechanism',
  'appointments to the appellate tribunal',
  'the forest rights recognition process',
  'the fiscal transfer formula',
  'the cooperative sugar mill framework',
  'the district mineral foundation',
  'grid-scale storage procurement',
  'the ration portability scheme',
  'urban local body devolution',
  'the wetland conservation register',
] as const;

const BODIES = [
  'the Union Cabinet',
  'the Supreme Court',
  'the Ministry of Rural Development',
  'the Finance Commission',
  'the National Green Tribunal',
] as const;

const COMMUNITIES = ['Toda', 'Jarawa', 'Bhil', 'Santhal', 'Gond'] as const;
const DISTRICTS = ['Nilgiris', 'Bastar', 'Sundargarh', 'Wayanad', 'Kutch'] as const;

/* ------------------------------------------------------- fixture articles */

interface Fixture {
  ordinal: number;
  headline: string;
  lede: string;
  text: string;
  kind: ItemKind;
  /** The quotable sentences, so the notes runner can copy rather than invent. */
  quotes: [string, string];
}

/**
 * The kind of the nth sample article.
 *
 * A function of the ordinal ALONE, never of the seed, so the shortlist runner
 * can label a candidate without re-deriving the fixture it has not been given.
 * Every third is a happening rather than a rule, so the single daily event slot
 * is genuinely contested and `event_only` gets exercised.
 */
export function sampleKind(ordinal: number): ItemKind {
  return ordinal % 3 === 0 ? 'event' : ordinal % 4 === 0 ? 'judgment' : 'structural';
}

/** The ordinal encoded in a sample url, or 0 if this is not one. */
export function sampleOrdinal(url: string): number {
  return Number(/#sample-(\d+)$/.exec(url)?.[1] ?? 0);
}

/**
 * The two quotable sentences, read back OUT OF THE SUPPLIED TEXT.
 *
 * The runners below deliberately do not rebuild the fixture to find their
 * quotes. They are handed a document and they copy out of it, which is exactly
 * the discipline `notes.md` demands of a real model — and it means a fake quote
 * can only ever fail grounding on purpose, never because two seeds drifted.
 */
export function quotesFromText(text: string): [string, string] {
  const lines = text.split('\n').map((line) => line.trim());
  const a = lines.find((line) => line.includes('raising the threshold from'));
  const b = lines.find((line) => line.startsWith('The notification records'));
  return [a ?? (lines[0] as string), b ?? (lines[1] as string)];
}

/**
 * One fixture article.
 *
 * Every figure that appears in the note below appears here first, because the
 * grounding check tests each number in the note as a substring of this text.
 * Writing the fixture and the note from the same numbers is the fake's version
 * of the discipline the real prompt asks a model for.
 */
export function buildFixture(requestId: string, date: string, ordinal: number): Fixture {
  const seed = seedOf(`${requestId}|${date}|${ordinal}`);
  const subject = SUBJECTS[(ordinal - 1) % SUBJECTS.length] as string;
  const body = pick(BODIES, seed, 3);
  const community = pick(COMMUNITIES, seed, 7);
  const district = pick(DISTRICTS, seed, 11);
  const ref = seed.toString(36).slice(0, 5);

  const low = 12 + (seed % 7);
  const high = low + 18;
  const districts = 3 + (seed % 5);

  const quoteA = `${body} approved a revision of ${subject} on Tuesday, raising the threshold from ${low} to ${high} units.`;
  const quoteB = `The notification records that the change takes effect across ${districts} districts, beginning with ${district}.`;

  const text = [
    `[SAMPLE] Revision of ${subject} (reference ${ref})`,
    '',
    'This is a SAMPLE article generated by the fake current-affairs runner. It',
    'describes no real event and no real decision. It exists so the digest',
    'pipeline can be exercised end to end without calling a model.',
    '',
    quoteA,
    quoteB,
    `Officials said the ${community} community would be covered by the revised`,
    `schedule, and that the earlier framework had been in force since 2019.`,
    'The paper adds that consultations with state governments were completed',
    'before the notification was issued, and that no separate appropriation was',
    'sought for the current year.',
  ].join('\n');

  return {
    ordinal,
    headline: `[SAMPLE] ${body.replace(/^the /, 'The ')} revises ${subject} (${ref})`,
    lede: `A sample lede describing a revision of ${subject}. Not a real story.`,
    text,
    kind: sampleKind(ordinal),
    quotes: [quoteA, quoteB],
  };
}

/* -------------------------------------------------------------- the ingest */

export interface FakeIngestOptions {
  requestId: string;
  date: string;
}

/**
 * A feed sweep with no network.
 *
 * One deliberate failure is reported every run, because a digest whose
 * `sourceFailures` array is always empty never proves that a 404 feed is
 * distinguishable from a quiet news day — which is the one thing that array
 * exists to make visible.
 */
export function fakeCollectEntries(opts: FakeIngestOptions): {
  entries: FeedEntry[];
  failures: FetchFailure[];
  feedCount: number;
} {
  const entries: FeedEntry[] = [];
  for (let ordinal = 1; ordinal <= FAKE_ARTICLE_COUNT; ordinal += 1) {
    const fixture = buildFixture(opts.requestId, opts.date, ordinal);
    entries.push({
      feedId: SAMPLE_FEED,
      sourceName: SAMPLE_SOURCE,
      url: sampleUrl(ordinal),
      canonicalUrl: sampleUrl(ordinal),
      title: fixture.headline,
      publishedAt: `${opts.date}T06:00:00.000Z`,
      lede: fixture.lede,
    });
  }
  return {
    entries,
    failures: [
      {
        url: 'about:blank#sample-dead-feed',
        feedId: 'sample-dead-feed',
        reason: 'http_error',
        detail: 'HTTP 404 (sample failure, always reported)',
      },
    ],
    feedCount: 2,
  };
}

export function fakeFetchDocuments(
  entries: readonly FeedEntry[],
  opts: FakeIngestOptions & { onProgress?: (done: number, total: number) => void; isCancelled?: () => boolean },
): { documents: SourceDocument[]; failures: FetchFailure[] } {
  const documents: SourceDocument[] = [];
  const failures: FetchFailure[] = [];
  let done = 0;

  for (const entry of entries) {
    if (opts.isCancelled?.()) break;
    const ordinal = Number(/#sample-(\d+)$/.exec(entry.url)?.[1] ?? 0);
    const fixture = ordinal > 0 ? buildFixture(opts.requestId, opts.date, ordinal) : null;

    // Every 6th fetch fails, so `fetch_failed` and the partial-fetch path are
    // both walked without waiting for a real site to be down.
    if (fixture === null || ordinal % 6 === 0) {
      failures.push({
        url: entry.url,
        feedId: entry.feedId,
        reason: 'extract_empty',
        detail: 'sample fetch failure',
      });
    } else {
      documents.push({
        url: entry.url,
        canonicalUrl: entry.canonicalUrl,
        sourceName: SAMPLE_SOURCE,
        feedId: entry.feedId,
        title: fixture.headline,
        publishedAt: entry.publishedAt,
        text: fixture.text,
        charCount: fixture.text.length,
        fetchedAt: new Date(0).toISOString(),
      });
    }
    done += 1;
    opts.onProgress?.(done, entries.length);
  }
  return { documents, failures };
}

/* ------------------------------------------------------------ the runners */

/**
 * The scripted Anthropology claim.
 *
 * Deliberately rare — roughly one item in eight — because the rate is what the
 * real prompt is judged on and a fake that claimed a link on everything would
 * bake in exactly the habit `anthropology.md` spends a page forbidding. One
 * ordinal in the schedule emits a HALF claim (concept, no Indian instance), so
 * `anthro_no_p2` and the strip-the-link-keep-the-item path are walked too.
 */
export function sampleAnthro(
  ordinal: number,
  title: string,
): DigestItemDraft['anthro'] {
  if (ordinal % 8 === 4) {
    return {
      p1Slug: 'anthro_p1/social-change',
      p2Slug: 'anthro_p2/tribal-communities',
      usageLine: `[SAMPLE] Not a real link: scripted text for ${title}.`,
    };
  }
  if (ordinal % 8 === 2) {
    // Concept with no instance: precisely the claim that scores 240.
    return { p1Slug: 'anthro_p1/social-change', p2Slug: null, usageLine: '[SAMPLE] Half a claim.' };
  }
  return null;
}

export const fakeShortlistRunner: ShortlistRunner = async (
  request: ShortlistRequest,
): Promise<ShortlistResult> => {
  await new Promise((resolve) => setImmediate(resolve));
  if (request.signal.aborted) throw new Error('Request was aborted');

  const picks: ShortlistPick[] = [];
  for (const candidate of request.candidates) {
    if (picks.length >= request.take) break;
    const ordinal = sampleOrdinal(candidate.url) || 1;
    picks.push({
      candidateIndex: candidate.index,
      kind: sampleKind(ordinal),
      // Every 5th claims no syllabus hook, so `no_syllabus_tag` — the highest
      // value filter in the system — is proven to actually reject something.
      syllabusSlugs: ordinal % 5 === 0 ? [] : request.syllabusSlugs.slice(0, 2).map(String),
      // Spread across the request's sections rather than piled into one, so
      // the section cap is exercised by the digest that is genuinely lopsided
      // rather than by every fake run.
      sectionKeys:
        request.sections.length === 0
          ? []
          : [String(request.sections[ordinal % request.sections.length])],
      why: '[SAMPLE] scripted pick, no model was called',
    });
  }

  return {
    picks,
    stopReason: 'end_turn',
    // Plausible rather than zero, so the cache-token weighting in the ledger is
    // exercised with real arithmetic.
    usage: {
      inputTokens: 900 + 30 * request.candidates.length,
      outputTokens: 60 * picks.length,
      cacheCreationInputTokens: 2400,
      cacheReadInputTokens: 0,
    },
    provenance: 'fake',
  };
};

export const fakeNotesRunner: NotesRunner = async (
  request: NotesRequest,
): Promise<NotesResult> => {
  await new Promise((resolve) => setImmediate(resolve));
  if (request.signal.aborted) throw new Error('Request was aborted');

  const slugsByUrl = new Map<string, string[]>();
  const sectionsByUrl = new Map<string, string[]>();
  request.documents.forEach((document, i) => {
    const pick = request.picks[i];
    slugsByUrl.set(document.url, pick?.syllabusSlugs ?? []);
    sectionsByUrl.set(document.url, pick?.sectionKeys ?? []);
  });

  /**
   * EXACTLY ONE item per run fabricates a quote that is not in its fixture.
   *
   * The target is the LAST otherwise-clean document rather than a seeded
   * position, because a seeded position eventually lands on an article that was
   * already going to be dropped for some other defect — and then the single
   * most expensive branch of the pipeline quietly stops being exercised, which
   * is the exact failure this fake exists to prevent.
   */
  const clean = request.documents.filter((document) => {
    const n = sampleOrdinal(document.url);
    return n % 3 !== 0 && n % 5 !== 0 && n % 7 !== 0;
  });
  const fabricateUrl =
    (clean.at(-1) ?? request.documents.at(-1))?.url ?? '';

  const drafts: DigestItemDraft[] = [];
  request.documents.forEach((document, index) => {
    const ordinal = sampleOrdinal(document.url) || 1;
    const [quoteA, quoteB] = quotesFromText(document.text);

    const fabricating = document.url === fabricateUrl;

    // Sentence 1 is a paraphrase of quote A; sentence 2 of quote B. Every
    // figure in the note came out of the fixture text, which is exactly the
    // discipline the real prompt asks a model for.
    const noteMd = fabricating
      ? // Not merely a wrong quote: a wrong FACT, of the kind that would reach a
        // Mains answer. The grounding check catches it on the quote first.
        `${quoteA} A further outlay of 4700 crore was sanctioned for the same purpose.`
      : `${quoteA} ${quoteB}`;

    drafts.push({
      url: document.url,
      // The marker she can actually see. `provenance` is invisible on a phone.
      headline: document.title,
      kind: sampleKind(ordinal),
      noteMd:
        // Every 7th blows the word limit, so `note_too_long` is exercised. The
        // fabricating item is never also over-long: the length check runs first
        // and would mask the grounding drop this fake exists to trigger.
        ordinal % 7 === 0 && !fabricating
          ? `${noteMd} ${'The sample text continues at length. '.repeat(14)}`
          : noteMd,
      sentenceEvidence: [0, 1],
      evidence: fabricating
        ? [
            { quote: quoteA, at: -1 },
            // Nowhere in the fixture. This is the drop path.
            { quote: 'The Ministry confirmed a supplementary outlay of 4700 crore rupees.', at: -1 },
          ]
        : [
            { quote: quoteA, at: -1 },
            { quote: quoteB, at: -1 },
          ],
      sectionKeys: sectionsByUrl.get(document.url) ?? [],
      syllabusSlugs: slugsByUrl.get(document.url) ?? [],
      anthro: sampleAnthro(ordinal, document.title),
    });
  });

  return {
    drafts,
    stopReason: 'end_turn',
    usage: {
      inputTokens: 1200 + 400 * request.documents.length,
      outputTokens: 220 * drafts.length,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 2400,
    },
    provenance: 'fake',
  };
};

/**
 * The ingest pair, ready to install alongside the two fake runners.
 *
 * Bundled here rather than assembled in index.ts so that ONE switch installs
 * the whole fake surface. A server running fake model calls over real fetched
 * articles is the exact footgun this avoids: it would attach a real outlet's
 * name and URL to scripted text.
 */
export const fakeCaIngest: CaIngest = {
  collectEntries: async ({ requestId, date }) => fakeCollectEntries({ requestId, date }),
  fetchDocuments: async (entries, { requestId, date, isCancelled, onProgress }) =>
    fakeFetchDocuments(entries, { requestId, date, isCancelled, onProgress }),
};
