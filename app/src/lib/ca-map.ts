/**
 * Wire `item` frame -> ingestable row. Pure, and the only place that decides
 * what is allowed into `ca_items`.
 *
 * This is the contract guard, the exact counterpart of `mcq-generate-map.ts`,
 * and the stakes are higher on this side. A bad MCQ is a wrong answer on a
 * drill she can dispute with one tap. A bad current-affairs item is a FACT —
 * she reads "the Supreme Court held X in March 2026", writes it into a Mains
 * answer worth 250 marks, and there is nothing about a fabricated fact that
 * looks different from a real one on a phone screen.
 *
 * So: reject anything that would render broken or read as a fact it cannot
 * support, accept everything else, and COUNT what was rejected so a
 * systematically bad prompt cohort is visible in the digest ledger rather than
 * only in what she later writes down.
 *
 * ## Reject, and why each one
 *
 * - A `sourceUrl` that is blank or not http(s). See the section below; this one
 *   is a safety mechanism, not validation hygiene.
 * - An empty headline. It is the only handle on a list screen — an item with no
 *   headline is an item she cannot choose to read or to skip.
 * - An empty note. The note IS the item; a headline and a link is an RSS reader,
 *   and the whole reason a model is in this loop is the 90 words after it.
 * - A note over `CA_RULES.maxNoteWords`. The daily budget is 20 minutes at
 *   ~180 wpm and the arithmetic in `ca-types.ts` allocates six 90-word notes to
 *   five of those minutes. A 300-word note does not overrun a screen, it
 *   overruns the reading block — silently, and at the expense of the standard
 *   books that produce the March 2027 first pass.
 * - Zero evidence. The verbatim quote is the proof. `server/src/ca/types.ts`
 *   builds its whole grounding pass around producing it, and an item that
 *   arrives without one has either bypassed that pass or failed it; either way
 *   the claim "this came from a page that was actually fetched" is unbacked.
 * - An unknown `kind`. Unlike `difficulty` in the MCQ mapper — which defaults,
 *   because it only changes a label — `kind` is the selection rule: a cabinet
 *   decision is `structural` and earns a slot, a bilateral visit is an `event`
 *   and mostly does not. Defaulting an unrecognised kind would let it walk in
 *   wearing whichever label the default happened to be.
 * - A duplicate canonical URL or headline fingerprint. Not the server's fault:
 *   the exclude list is best-effort and one story runs for days across outlets.
 *   Counted, not raised.
 *
 * ## Why non-http is a SAFETY mechanism
 *
 * The server's fake runner emits `sourceUrl: 'about:blank'`. That rule means a
 * fake item cannot be ingested by a build that is not itself pointed at the
 * fake server — the marker travels with the data rather than depending on a
 * flag someone remembered to unset. `fake-mcq-runner.ts` reasons identically
 * about its `[SAMPLE]` stem prefix, and states the asymmetry that makes this
 * side stricter: a fake SCORE is obviously a score, but a fake FACT looks
 * exactly like a real fact and gets written into a Mains answer.
 *
 * ## `headlineFingerprint` is defined HERE
 *
 * Not imported from `mcq-bank.ts`, deliberately. An MCQ stem is a full
 * interrogative sentence produced by one generator with stable conventions; a
 * headline is written by a sub-editor, arrives from several feeds, and is the
 * single field that varies most between syndications of the same story. The two
 * already need different rules today (see `normaliseHeadline`) and will need
 * more. A shared function would let one caller's tightening silently change the
 * other's duplicate detection — and a false duplicate is INVISIBLE: the item is
 * dropped on the way in and nothing ever reports it missing.
 *
 * ## Never throws
 *
 * A wholly malformed payload returns a rejection, never an exception. This runs
 * inside a streaming read loop on a path whose contract is that it does not
 * reject; a throw here would abandon the rest of the stream and discard every
 * item already ingested in this digest.
 */

import { CA_RULES, type CaEvidence, type ItemKind } from '@/lib/ca-types';
import { resolveTags, type TagIndex } from '@/lib/ca-tags';

/* ------------------------------------------------------------------ output */

/** A row ready for `ca_items`, plus the `ca_item_topics` rows it implies. */
export interface IngestableCaItem {
  /** The DIGEST day, `YYYY-MM-DD`. Supplied by the context, never by the wire. */
  date: string;
  /** When the SOURCE published. Not the digest day — see the schema comment. */
  publishedAt: string | null;
  headline: string;
  sourceName: string | null;
  /** Always present and always http(s) by the time a row exists. */
  sourceUrl: string;
  /** Tracking params stripped. The duplicate key across outlets. */
  sourceUrlCanonical: string;
  kind: ItemKind;
  noteMd: string;
  evidence: CaEvidence[];
  /** RAW server-proposed tags, unresolvable ones included. */
  syllabusTags: string[];
  /** Resolved `syllabus_topics.id`, in rank order. May be empty. */
  topicIds: number[];
  /** The subset of `syllabusTags` this build could not resolve. */
  unknownTags: string[];
  anthroLink: string | null;
  anthroP1Slug: string | null;
  anthroP2Slug: string | null;
  headlineFingerprint: string;
}

export type CaRejectionReason =
  | 'not_an_object'
  | 'bad_source_url'
  | 'empty_headline'
  | 'empty_note'
  | 'note_too_long'
  | 'no_evidence'
  | 'unknown_kind'
  | 'duplicate_url'
  | 'duplicate_headline';

export interface CaRejection {
  index: number;
  reason: CaRejectionReason;
  /** One line, safe to log and to render. Never the whole payload. */
  detail: string;
}

export type CaMapOutcome =
  | { ok: true; item: IngestableCaItem }
  | { ok: false; reason: CaRejectionReason; detail: string };

export interface CaMapContext {
  /** The digest day every item in this batch belongs to, `YYYY-MM-DD`. */
  date: string;
  /** Built by `ca-tags.buildTagIndex`. An empty one degrades attribution only. */
  tagIndex: TagIndex;
  /** Canonical URLs already held, over the duplicate window. */
  knownCanonicalUrls: ReadonlySet<string>;
  /** Headline fingerprints already held, over the duplicate window. */
  knownFingerprints: ReadonlySet<string>;
}

/**
 * What this batch has accepted so far.
 *
 * Batch-scoped and separate from `ctx` because the server can emit the same
 * story twice within a single stream — two outlets, one event — and the two
 * axes have to be tracked apart: a syndication shares the canonical URL, a
 * re-write of the same story shares only the fingerprint.
 */
export interface CaSeen {
  canonicalUrls: ReadonlySet<string>;
  fingerprints: ReadonlySet<string>;
}

const NOTHING_SEEN: CaSeen = {
  canonicalUrls: new Set<string>(),
  fingerprints: new Set<string>(),
};

/* --------------------------------------------------------------- primitives */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The first of several aliases the payload actually uses.
 *
 * Same reasoning as `mcq-generate-map.ts#pick`: the server contract is young
 * and its field names move (`sourceUrl` / `url`, `noteMd` / `note`). Accepting
 * the aliases costs three lines; not accepting them costs a whole digest and is
 * discovered on a morning when there is no time to fix it.
 */
function pick(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/** A short, log-safe excerpt of a headline. */
function excerpt(value: unknown, limit = 70): string {
  const raw = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (raw === '') return '(no headline)';
  return raw.length <= limit ? raw : `${raw.slice(0, limit - 1)}…`;
}

/**
 * A short, log-safe rendering of a value that was supposed to be a string and
 * may be anything at all. Never the whole payload.
 */
function label(value: unknown, limit = 24): string {
  if (value === undefined || value === null) return '(missing)';
  const raw = typeof value === 'string' ? value : typeof value === 'object' ? '(object)' : String(value);
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return '(blank)';
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}

const ITEM_KINDS: readonly string[] = [
  'structural',
  'report',
  'judgment',
  'scheme',
  'data',
  'event',
];

/**
 * Words, as the reading budget counts them.
 *
 * Whitespace-delimited runs of the raw markdown. Markdown syntax inflates the
 * count slightly — a link is two tokens — and that is the safe direction: the
 * cap protects a 20-minute block, so over-counting trims a long note and
 * under-counting silently overruns the block.
 */
export function noteWordCount(note: string): number {
  const trimmed = note.trim();
  if (trimmed === '') return 0;
  return trimmed.split(/\s+/).length;
}

/* -------------------------------------------------------------------- URLs */

/** Query parameters that identify a campaign rather than a document. */
const TRACKING_PARAMS = /^(utm_|ga_|mc_|pk_|hsa_|_hs|fbclid$|gclid$|dclid$|msclkid$|igshid$|mibextid$|yclid$|ref$|referrer$|source$|src$|cmpid$|campaign$|spm$|share$|at_)/i;

/**
 * Scheme, host, path, query and fragment, without `URL`.
 *
 * Hand-parsed on purpose. React Native's `URL` is a polyfill whose coverage has
 * moved between releases — `searchParams` in particular has been absent, and a
 * canonicaliser that throws or silently no-ops on one engine would make
 * duplicate suppression a property of the build rather than of the data. Same
 * defensive instinct as `mcq-bank.ts` guarding `String.prototype.normalize`.
 */
function splitUrl(raw: string): { scheme: string; rest: string } | null {
  const match = /^([a-z][a-z0-9+.-]*):(.*)$/is.exec(raw.trim());
  if (!match) return null;
  return { scheme: (match[1] ?? '').toLowerCase(), rest: match[2] ?? '' };
}

/**
 * Is this a URL that can be opened and re-read?
 *
 * http and https only. `about:blank` is what the fake runner emits;
 * `file:`, `data:` and `javascript:` are worse. All four fail here.
 */
export function isFetchableUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const parts = splitUrl(raw);
  if (parts === null) return false;
  if (parts.scheme !== 'http' && parts.scheme !== 'https') return false;
  // A scheme with no authority — `http:` on its own, or `http:/x` — is not
  // openable either, and `about:blank`-shaped values must not slip through on
  // the strength of the scheme alone.
  return /^\/\/[^/?#\s]+/.test(parts.rest);
}

/**
 * The duplicate key for a URL.
 *
 * Lowercases the scheme and host, drops `www.`, drops the default port, drops
 * the fragment, drops tracking parameters, sorts what survives, and drops a
 * trailing slash. Everything removed is something two links to the SAME
 * document routinely differ by; the path and the meaningful query are left
 * exactly as they are, because those are what distinguishes two documents.
 *
 * Returns the trimmed input unchanged when it cannot be parsed. A URL this
 * cannot canonicalise is still a URL, and refusing to produce a key would make
 * it invisible to duplicate suppression rather than merely imprecise.
 */
export function canonicalUrl(raw: string): string {
  const parts = splitUrl(raw);
  if (parts === null) return raw.trim();

  const authorityMatch = /^\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/.exec(parts.rest);
  if (!authorityMatch) return raw.trim();

  const [, authorityRaw = '', pathRaw = '', queryRaw = ''] = authorityMatch;

  // Credentials are not part of a document's identity, and they must never be
  // written into a row that a screen renders.
  const hostPort = authorityRaw.includes('@')
    ? authorityRaw.slice(authorityRaw.lastIndexOf('@') + 1)
    : authorityRaw;

  let host = hostPort.toLowerCase();
  if (parts.scheme === 'http' && host.endsWith(':80')) host = host.slice(0, -3);
  if (parts.scheme === 'https' && host.endsWith(':443')) host = host.slice(0, -4);
  if (host.startsWith('www.')) host = host.slice(4);

  const kept: string[] = [];
  for (const pair of queryRaw.replace(/^\?/, '').split('&')) {
    if (pair === '') continue;
    const name = pair.split('=')[0] ?? '';
    if (name === '' || TRACKING_PARAMS.test(name)) continue;
    kept.push(pair);
  }
  // Sorted, because two links to the same article routinely order their
  // parameters differently and parameter order carries no meaning.
  kept.sort();

  // A trailing slash on a non-empty path is the single most common cosmetic
  // difference between two links to one article.
  let path = pathRaw;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

  const query = kept.length === 0 ? '' : `?${kept.join('&')}`;
  return `${parts.scheme}://${host}${path}${query}`;
}

/* ------------------------------------------------------------ fingerprints */

/**
 * Everything that is not a word character, keeping the scripts a headline can
 * legitimately be written in — Latin-Extended, Greek, Cyrillic, Devanagari and
 * the rest of the BMP letter blocks. Dropping those would collapse every Hindi
 * headline to the empty string, and each one would then be "a duplicate" of
 * every other. Same character class as `mcq-bank.ts` uses, for the same reason.
 */
const NON_WORD = /[^a-z0-9\u00C0-\u024F\u0370-\u1FFF\u2C00-\uD7FF]+/g;

const APOSTROPHES = /['\u2018\u2019\u201B\u2032\u00B4\u0060]/g;

const COMBINING = /[\u0300-\u036F]/g;

/**
 * A comma or a narrow space sitting BETWEEN two digits.
 *
 * Capture groups rather than a lookbehind: Hermes has shipped without lookbehind
 * support, and a normaliser that throws on one engine would make duplicate
 * suppression a property of the build rather than of the data.
 */
const DIGIT_GROUPING = /(\d)[,\u00A0\u202F\u2009 ](\d)/g;

/**
 * Runs `DIGIT_GROUPING` to a fixed point.
 *
 * Adjacent groups share a digit \u2014 matching "1,0" in "1,00,000" consumes the "0"
 * the next match would have started from \u2014 so a single pass can leave a
 * separator behind. Three passes clear every grouping a real figure has, and the
 * loop exits as soon as nothing changed, which is the usual case.
 */
function collapseDigitGroups(value: string): string {
  let out = value;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = out.replace(DIGIT_GROUPING, '$1$2');
    if (next === out) return out;
    out = next;
  }
  return out;
}

/**
 * Headline normalisation. Deliberately conservative, and NOT `normaliseStem`.
 *
 * It collapses the things that are not differences — case, accents,
 * apostrophes, punctuation, spacing — and one thing that is specific to
 * headlines: digit grouping. "SC upholds Rs 1,00,000 cap" and "SC upholds
 * Rs 100000 cap" are the same story from two desks with different style guides,
 * and without this rule the first collapses to `1 00 000` and the second to
 * `100000`, so the duplicate goes undetected and she reads it twice. An MCQ
 * stem comes from one generator and has no such cross-outlet variance, which is
 * exactly why the two normalisers are separate functions rather than one.
 *
 * It does NOT sort words, drop stopwords, stem morphology, or strip outlet
 * furniture and kickers. Those all turn two genuinely different headlines into
 * the same string, and a false duplicate is invisible: the item is dropped on
 * insert and nothing ever reports it missing.
 */
export function normaliseHeadline(headline: string): string {
  const raw = typeof headline === 'string' ? headline : '';

  // `normalize` is ES2015 but has been absent from stripped-down engines.
  const decomposed =
    typeof raw.normalize === 'function' ? raw.normalize('NFKD').replace(COMBINING, '') : raw;

  const collapsed = collapseDigitGroups(
    decomposed.toLowerCase().replace(APOSTROPHES, ''),
  )
    .replace(NON_WORD, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // A headline written wholly in a script `NON_WORD` does not cover would
  // collapse to the empty string, and every such headline would then be "a
  // duplicate" of every other. Falling back to the whitespace-collapsed
  // original keeps them distinguishable at the cost of being case-sensitive,
  // which is the safe direction to fail in.
  if (collapsed !== '') return collapsed;
  return raw.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** FNV-1a, 32-bit. The multiply is the standard shift-and-add decomposition. */
function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/** djb2-xor, 32-bit. Structurally unlike FNV-1a, which is the point. */
function djb232(value: string): number {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = (((hash << 5) + hash) ^ value.charCodeAt(i)) >>> 0;
  }
  return hash >>> 0;
}

function hex8(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0');
}

/**
 * A stable 64-bit fingerprint of a headline, as 16 hex characters.
 *
 * Two independent 32-bit hashes concatenated rather than one 64-bit hash: no
 * BigInt (Hermes has it, older JSC does not), no crypto dependency, and two
 * algorithms with different mixing functions do not share collisions.
 *
 * Stored rather than recomputed — `ca_items.headline_fingerprint` is indexed,
 * and the 14-day duplicate window is a lookup against exactly these strings.
 *
 * ## Not the same question as `storyFingerprint`
 *
 * This one answers "do I already hold this row?" and collapses COSMETIC
 * differences only: a genuine rewording is a different fingerprint, which is
 * deliberate — a false positive here silently discards an item she never sees.
 * `storyFingerprint` answers the different and more aggressive question "has
 * she already been shown this story?" and is the one the server is told about.
 */
export function headlineFingerprint(headline: string): string {
  const normalised = normaliseHeadline(headline);
  // The second hash sees a different string, so a pathological input cannot
  // land on the same weak spot in both.
  return hex8(fnv1a32(normalised)) + hex8(djb232(`${normalised.length} ${normalised}`));
}

/* ------------------------------------------------------- story fingerprints */

/**
 * Words that carry no identity. Byte-identical to `STOPWORDS` in
 * `server/src/ca/select.ts` — see `storyFingerprint` for why that matters.
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it', 'its', 'of', 'on',
  'or', 'over', 'that', 'the', 'to', 'up', 'with', 'after', 'amid', 'new', 'says', 'said',
]);

/**
 * Sorted significant word stems — the SERVER's notion of "the same story".
 *
 * ## Why this exists on the device at all
 *
 * It is never stored and never compared here. It exists so `readIngestContext`
 * can tell the server, in the server's own vocabulary, which stories the device
 * already holds. `selectItems` puts `seenFingerprints` into a Set and tests its
 * OWN freshly-computed fingerprint for membership — so a value in that set
 * computed by any other algorithm can never match.
 *
 * And it never did. The app was sending `headlineFingerprint` hashes into a
 * comparison against sorted stems, and nothing failed: the server simply
 * re-shortlisted and re-wrote a note for the same running story every day,
 * billed for it, and spent one of the six daily slots on it. The device then
 * dropped the item on ingest, so she never saw a duplicate — she saw a
 * five-item digest and a larger bill. `tests/ca-fingerprint-contract.test.ts`
 * pins the exact strings both sides must produce.
 *
 * ## Why stems and not a hash
 *
 * Sorted rather than sequential, so "SC quashes the bonds scheme" and "Bonds
 * scheme quashed by SC" collapse to one fingerprint — the real duplicate
 * pattern across outlets, and the one a URL check cannot see. Crude on purpose:
 * the stemmer makes plural and tense agree, which is what differs when two
 * desks report the same thing, and does not touch irregular verbs.
 */
export function storyFingerprint(headline: string): string {
  const raw = typeof headline === 'string' ? headline : '';
  const words = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word))
    .map((word) =>
      /(ies|ied)$/.test(word)
        ? word.replace(/(ies|ied)$/, 'y')
        : word.replace(/(ing|ed|es|s)$/, ''),
    )
    .filter((word) => word.length > 2);

  const stems = [...new Set(words)].sort().slice(0, 8).join('-');
  if (stems !== '') return stems;

  // A headline in a script the `[^a-z0-9\s]` strip does not cover collapses to
  // the empty string, and every such headline would then be "the same story" as
  // every other. PIB serves Hindi outright when its `reg` parameter is wrong —
  // see the source notes in `server/src/ca/sources.ts` — so this is a live
  // path. The server carries the identical fallback, and has to.
  return raw.toLowerCase().replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ pieces */

/**
 * The verbatim quotes, from either shape the wire uses.
 *
 * `server/src/ca/types.ts` carries `EvidenceSpan { quote, at }`; the offset is
 * an artefact of the server's own grounding pass and has no meaning on the
 * device, so only the quote is kept. A bare string is accepted too, because
 * that is what the shape degrades to when the offset is dropped upstream.
 */
function readEvidence(value: unknown): CaEvidence[] {
  if (!Array.isArray(value)) return [];

  const out: CaEvidence[] = [];
  for (const entry of value) {
    const direct = text(entry);
    if (direct !== null) {
      out.push({ quote: direct });
      continue;
    }
    const record = asRecord(entry);
    if (record === null) continue;
    const quote = text(pick(record, 'quote', 'text', 'snippet'));
    if (quote !== null) out.push({ quote });
  }
  return out;
}

/** Raw tag strings, from either the flat or the nested shape. */
function readRawTags(record: Record<string, unknown>): string[] {
  const candidates = [
    pick(record, 'syllabusTags', 'syllabusSlugs', 'tags'),
    // Section keys travel in their own field on the server draft, and they are
    // valid vocabulary entries here — `tagVocabulary` ships both levels.
    pick(record, 'sectionKeys', 'sections'),
  ];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    for (const entry of candidate) {
      const slug = text(entry);
      if (slug === null || seen.has(slug)) continue;
      seen.add(slug);
      out.push(slug);
    }
  }
  return out;
}

interface AnthroLink {
  line: string | null;
  p1Slug: string | null;
  p2Slug: string | null;
}

/**
 * The Anthropology link, if the server claimed one.
 *
 * Never a rejection reason. `CA_RULES.maxAnthroLinkRate` says an over-claiming
 * prompt is a batch-level signal — "above this share of items, the prompt is
 * reaching" — so it is measured across the digest, not adjudicated per item.
 * One reaching link is a weak item; forty are a bad prompt, and only the
 * summary can tell those apart.
 */
function readAnthro(record: Record<string, unknown>): AnthroLink {
  const nested = asRecord(pick(record, 'anthro', 'anthropology'));
  const source = nested ?? record;

  return {
    line: text(pick(source, 'usageLine', 'anthroLink', 'line', 'usage')),
    p1Slug: text(pick(source, 'p1Slug', 'anthroP1Slug', 'paper1Slug')),
    p2Slug: text(pick(source, 'p2Slug', 'anthroP2Slug', 'paper2Slug')),
  };
}

/* ---------------------------------------------------------------- mapping */

/**
 * One `item` frame. Returns a verdict, never throws.
 *
 * `seen` is what this batch has already accepted, checked alongside the
 * context's windows: the server can emit one story twice inside a single
 * stream, and two copies of the same item in one morning's digest spends two of
 * six slots on one fact.
 */
export function mapDigestItem(
  payload: unknown,
  ctx: CaMapContext,
  seen: CaSeen = NOTHING_SEEN,
): CaMapOutcome {
  const record = asRecord(payload);
  if (!record) {
    return { ok: false, reason: 'not_an_object', detail: 'Frame payload was not an object.' };
  }

  const headline = text(pick(record, 'headline', 'title'));
  if (headline === null) {
    return { ok: false, reason: 'empty_headline', detail: 'Item had no headline.' };
  }

  // First, because it is the safety rule rather than a quality one: nothing
  // below should run on a payload that has already failed it.
  const rawUrl = pick(record, 'sourceUrl', 'url', 'link');
  if (!isFetchableUrl(rawUrl)) {
    return {
      ok: false,
      reason: 'bad_source_url',
      detail: `Source URL is not a fetchable http(s) link (${label(rawUrl, 40)}): ${excerpt(headline)}`,
    };
  }
  const sourceUrl = rawUrl.trim();

  const noteMd = text(pick(record, 'noteMd', 'note', 'noteMarkdown'));
  if (noteMd === null) {
    return {
      ok: false,
      reason: 'empty_note',
      detail: `Item had no note — the note is the item: ${excerpt(headline)}`,
    };
  }

  const words = noteWordCount(noteMd);
  if (words > CA_RULES.maxNoteWords) {
    return {
      ok: false,
      reason: 'note_too_long',
      detail: `Note ran to ${words} words against a ${CA_RULES.maxNoteWords}-word budget: ${excerpt(
        headline,
      )}`,
    };
  }

  const evidence = readEvidence(pick(record, 'evidence', 'quotes', 'spans'));
  if (evidence.length === 0) {
    return {
      ok: false,
      reason: 'no_evidence',
      detail: `No verbatim evidence — the claim is unbacked: ${excerpt(headline)}`,
    };
  }

  const rawKind = pick(record, 'kind', 'itemKind');
  const kind = typeof rawKind === 'string' ? rawKind.trim().toLowerCase() : '';
  if (!ITEM_KINDS.includes(kind)) {
    return {
      ok: false,
      reason: 'unknown_kind',
      detail: `Unrecognised item kind "${label(rawKind)}" — the selection rule turns on it: ${excerpt(
        headline,
      )}`,
    };
  }

  // The wire may have canonicalised already; this build canonicalises again
  // rather than trusting it, because the duplicate window on the device is
  // keyed on THIS function's output and two canonicalisers would drift.
  const sourceUrlCanonical = canonicalUrl(
    text(pick(record, 'canonicalUrl', 'sourceUrlCanonical')) ?? sourceUrl,
  );
  if (ctx.knownCanonicalUrls.has(sourceUrlCanonical) || seen.canonicalUrls.has(sourceUrlCanonical)) {
    return {
      ok: false,
      reason: 'duplicate_url',
      detail: `Already have this link: ${excerpt(headline)}`,
    };
  }

  const fingerprint = headlineFingerprint(headline);
  if (ctx.knownFingerprints.has(fingerprint) || seen.fingerprints.has(fingerprint)) {
    return {
      ok: false,
      reason: 'duplicate_headline',
      detail: `Already have this story: ${excerpt(headline)}`,
    };
  }

  const syllabusTags = readRawTags(record);
  // An unknown slug lands in `unknown` and the item is ingested untagged. It is
  // never a rejection — see `ca-types.ts#TagResolution.unknown`.
  const tags = resolveTags(syllabusTags, ctx.tagIndex);
  const anthro = readAnthro(record);

  return {
    ok: true,
    item: {
      date: ctx.date,
      // The SOURCE's publication date, which is not the digest day: a Sunday
      // judgment lands in Monday's digest, and conflating the two makes the
      // monthly compilation wrong at every month boundary.
      publishedAt: text(pick(record, 'publishedAt', 'published', 'date')),
      headline,
      sourceName: text(pick(record, 'sourceName', 'source', 'outlet')),
      sourceUrl,
      sourceUrlCanonical,
      kind: kind as ItemKind,
      noteMd,
      evidence,
      syllabusTags,
      topicIds: tags.topicIds,
      unknownTags: tags.unknown,
      anthroLink: anthro.line,
      // The P1 concept and the P2 Indian instance travel as a PAIR, because the
      // optional's rubric weights theory-anchored-to-an-example above
      // everything else and the compilation has to be able to table them.
      anthroP1Slug: anthro.p1Slug,
      anthroP2Slug: anthro.p2Slug,
      headlineFingerprint: fingerprint,
    },
  };
}

/* ------------------------------------------------------------ batch mapper */

export interface MappedDigest {
  accepted: IngestableCaItem[];
  rejected: CaRejection[];
  /** Rejections whose reason was either duplicate kind, counted out. */
  duplicates: number;
  /** Slugs the server used that this build's syllabus does not know. */
  unknownTags: string[];
  /** Accepted items claiming an Anthropology link. Compared to `maxAnthroLinkRate`. */
  anthroLinked: number;
}

/**
 * A stateful mapper for the streaming path.
 *
 * Items are ingested as they arrive, one frame at a time, so there is no array
 * to fold over — but duplicate suppression, the rejection tally and the
 * unknown-tag census are inherently batch-scoped. This holds exactly that state
 * and nothing else.
 */
export interface DigestMapper {
  accept(payload: unknown): CaMapOutcome;
  result(): MappedDigest;
}

export function createDigestMapper(ctx: CaMapContext): DigestMapper {
  const accepted: IngestableCaItem[] = [];
  const rejected: CaRejection[] = [];
  const canonicalUrls = new Set<string>();
  const fingerprints = new Set<string>();
  const unknownTags = new Set<string>();
  let anthroLinked = 0;
  let index = 0;

  const seen: CaSeen = { canonicalUrls, fingerprints };

  return {
    accept(payload: unknown): CaMapOutcome {
      const at = index;
      index += 1;

      const outcome = mapDigestItem(payload, ctx, seen);
      if (!outcome.ok) {
        rejected.push({ index: at, reason: outcome.reason, detail: outcome.detail });
        return outcome;
      }

      canonicalUrls.add(outcome.item.sourceUrlCanonical);
      fingerprints.add(outcome.item.headlineFingerprint);
      for (const slug of outcome.item.unknownTags) unknownTags.add(slug);
      if (outcome.item.anthroLink !== null) anthroLinked += 1;
      accepted.push(outcome.item);
      return outcome;
    },

    result(): MappedDigest {
      return {
        accepted: [...accepted],
        rejected: [...rejected],
        duplicates: rejected.filter(
          (entry) => entry.reason === 'duplicate_url' || entry.reason === 'duplicate_headline',
        ).length,
        unknownTags: [...unknownTags],
        anthroLinked,
      };
    },
  };
}

/**
 * The whole-array form, for a non-streaming caller and for tests.
 *
 * A payload that is not an array is a malformed response, not an empty one, and
 * it returns an empty `accepted` with one rejection explaining why rather than
 * throwing.
 */
export function mapDigestBatch(payloads: unknown, ctx: CaMapContext): MappedDigest {
  if (!Array.isArray(payloads)) {
    return {
      accepted: [],
      rejected: [{ index: 0, reason: 'not_an_object', detail: 'Expected an array of items.' }],
      duplicates: 0,
      unknownTags: [],
      anthroLinked: 0,
    };
  }

  const mapper = createDigestMapper(ctx);
  for (const payload of payloads) mapper.accept(payload);
  return mapper.result();
}
