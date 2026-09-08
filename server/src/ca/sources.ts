/**
 * The source allowlist, its content hash, and the feed parser.
 *
 * ## Why this is a JSON file on the server
 *
 * Same reason the rubrics are markdown files: adding a feed must not need an
 * app rebuild and a Play Store round trip. A source list that lives in the
 * device bundle is a source list that is six weeks stale during the one part of
 * the year when current affairs move fastest.
 *
 * ## Why it is content-hashed
 *
 * `sourceSetVersion` follows `mcq/index.ts`: first 12 chars of a sha256, so an
 * edit is impossible to forget to version. Every digest records the version
 * that produced it, which is what makes "the digest got worse in April"
 * answerable rather than mysterious — and what makes a bad cohort deletable
 * with one query.
 *
 * The hash is taken over a CANONICAL form of the parsed feeds rather than over
 * the file bytes. Reformatting the JSON, reordering the entries or reindenting
 * it must NOT change the version — a version that moved on `prettier` would be
 * noise, and a version that is noise is a version nobody reads. Changing a feed
 * URL, id, kind or trust level must, and does.
 *
 * ## Why the feed parser is regexes and not an XML library
 *
 * Feeds are third-party content. A real XML parser is precisely the wrong tool
 * for third-party content on a server that holds an API key: XXE and entity
 * expansion ("billion laughs") are parser features, not parser bugs, and every
 * Node XML library ships them on by default at least somewhere in its history.
 * The scanner below cannot resolve an external entity because it has no concept
 * of one, and it cannot be made to expand anything because it never expands.
 * The cost is that a pathological feed yields fewer entries. That is the right
 * direction to fail in.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { decodeEntities, htmlToText } from './extract.js';
import type { FeedEntry, SourceFeed } from './types.js';

/* --------------------------------------------------------------- the loader */

export interface SourceSet {
  feeds: readonly SourceFeed[];
  /** First 12 chars of a sha256 over the canonical feed list. */
  sourceSetVersion: string;
}

const FEED_KINDS = new Set<SourceFeed['kind']>(['rss', 'atom', 'index']);
const TRUST_LEVELS = new Set<SourceFeed['trust']>(['primary', 'secondary']);

/**
 * Validation throws rather than skipping the bad entry.
 *
 * `config.ts`'s rule: a server that cannot serve its own endpoint should refuse
 * to start rather than discover it on the first request. A typo'd feed URL that
 * is silently dropped is a source that stops appearing in the digest with no
 * error anywhere to explain it, and "the digest is a bit thinner lately" is not
 * a bug report anyone can act on.
 */
export function parseSourceSet(raw: unknown): SourceFeed[] {
  if (!Array.isArray(raw)) {
    throw new Error('ca sources file must contain a JSON array of feeds');
  }
  const feeds: SourceFeed[] = [];
  const ids = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const at = `feeds[${index}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${at} must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const id = requireString(record['id'], `${at}.id`);
    if (ids.has(id)) throw new Error(`${at}.id duplicates an earlier feed: ${id}`);
    ids.add(id);

    const url = requireString(record['url'], `${at}.url`);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`${at}.url is not a URL: ${url}`);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`${at}.url must be http(s): ${url}`);
    }

    const kind = requireString(record['kind'], `${at}.kind`) as SourceFeed['kind'];
    if (!FEED_KINDS.has(kind)) throw new Error(`${at}.kind must be rss, atom or index`);
    const trust = requireString(record['trust'], `${at}.trust`) as SourceFeed['trust'];
    if (!TRUST_LEVELS.has(trust)) throw new Error(`${at}.trust must be primary or secondary`);

    const papers = record['papers'];
    if (!Array.isArray(papers) || papers.some((p) => typeof p !== 'string')) {
      throw new Error(`${at}.papers must be an array of strings`);
    }

    feeds.push({
      id,
      name: requireString(record['name'], `${at}.name`),
      url,
      kind,
      papers: papers as string[],
      trust,
    });
  }
  if (feeds.length === 0) throw new Error('ca sources file lists no feeds');
  return feeds;
}

function requireString(value: unknown, at: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${at} must be a non-empty string`);
  }
  return value.trim();
}

/**
 * The bytes that get hashed: every semantic field, sorted, with no formatting.
 *
 * `papers` is sorted because it is advisory steering — reordering it does not
 * change what gets fetched or how anything is judged, so it must not move the
 * version. Everything else is compared exactly.
 */
export function canonicalSourceForm(feeds: readonly SourceFeed[]): string {
  const rows = feeds
    .map((feed) => [feed.id, feed.kind, feed.name, feed.trust, feed.url, [...feed.papers].sort()])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return JSON.stringify(rows);
}

export function sourceSetVersion(feeds: readonly SourceFeed[]): string {
  return createHash('sha256').update(canonicalSourceForm(feeds)).digest('hex').slice(0, 12);
}

let cache: { file: string; set: SourceSet } | null = null;

/**
 * Reads, validates and versions the allowlist.
 *
 * The path defaults to `config.caSourcesFile`, read lazily so that importing
 * this module does not require the whole environment to be configured — the
 * grounding tests have no business needing an Anthropic key.
 */
export async function loadSources(file?: string): Promise<SourceSet> {
  const path = file ?? (await defaultSourcesFile());
  if (cache !== null && cache.file === path) return cache.set;

  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(
      `Cannot read the current-affairs source allowlist at ${path}: ${String(error)}. ` +
        'Set CA_SOURCES_FILE or restore src/ca/sources.json.',
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`ca sources file ${path} is not valid JSON: ${String(error)}`);
  }
  const feeds = parseSourceSet(json);
  const set: SourceSet = { feeds, sourceSetVersion: sourceSetVersion(feeds) };
  cache = { file: path, set };
  return set;
}

async function defaultSourcesFile(): Promise<string> {
  const { config } = await import('../config.js');
  return config.caSourcesFile;
}

/** Drops the cache so an edited allowlist takes effect without a restart. */
export function clearSourceCache(): void {
  cache = null;
}

/* ------------------------------------------------------------ domain policy */

/**
 * Two-label public suffixes that must not be treated as registrable domains.
 *
 * Getting this wrong is a security hole, not a cosmetic one. The naive
 * "last two labels" rule maps `pib.gov.in` to `gov.in`, and an allowlist keyed
 * on `gov.in` admits every host in the Government of India — thousands of
 * servers this pipeline has no business fetching, several of which are
 * reachable only from inside a government network. The list is short because
 * the allowlist is short; an unlisted suffix falls back to two labels, which is
 * correct for `.com`, `.org` and `.net`.
 */
const MULTI_LABEL_SUFFIXES: ReadonlySet<string> = new Set([
  'gov.in', 'nic.in', 'ac.in', 'res.in', 'edu.in', 'mil.in',
  'co.in', 'net.in', 'org.in', 'firm.in', 'gen.in', 'ind.in',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'net.uk',
  'com.au', 'com.br', 'com.sg', 'co.jp', 'co.za', 'com.pk', 'com.bd', 'com.np',
]);

/** `www.pib.gov.in` -> `pib.gov.in`; `thehindu.com` -> `thehindu.com`. */
export function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  // An IP literal has no registrable domain. Falling through to the label rule
  // would map `127.0.0.1` to `0.1` and `10.0.0.7` to `0.7`, so two unrelated
  // internal addresses would share an allowlist key. It has to be the whole
  // address or nothing.
  if (isIP(host) !== 0) return host;
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join('.');
  const take = MULTI_LABEL_SUFFIXES.has(lastTwo) ? 3 : 2;
  return labels.slice(-take).join('.');
}

/** Every registrable domain the allowlist authorises a fetch against. */
export function allowedDomains(feeds: readonly SourceFeed[]): Set<string> {
  const domains = new Set<string>();
  for (const feed of feeds) {
    try {
      domains.add(registrableDomain(new URL(feed.url).hostname));
    } catch {
      // parseSourceSet already rejected unparseable URLs; a caller that built
      // a SourceFeed by hand gets that feed ignored rather than a throw.
    }
  }
  return domains;
}

/* ----------------------------------------------------------- canonical URLs */

/**
 * Query parameters that identify the READER, not the story.
 *
 * Prefix-matched families first (`utm_*`, `at_*`) then exact names. Stripping
 * aggressively is safe because `FeedEntry` keeps the original `url` for
 * fetching — `canonicalUrl` is only ever the dedup key.
 */
const TRACKING_PREFIXES = ['utm_', 'at_', 'mc_', 'pk_', 'piwik_', 'ga_', 'hsa_', '_hs'] as const;

const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  'fbclid', 'gclid', 'dclid', 'msclkid', 'yclid', 'zanpid', 'twclid', 'igshid',
  'ref', 'ref_src', 'refsrc', 'referrer', 'source', 'src', 'cmpid', 'cmp',
  'ncid', 'spm', 'scid', 'icid', 'ito', 'sr_share', 's_kwcid', 'wt.mc_id',
  '__twitter_impression', '_ga', '_gl', 'amp', 'outputtype', 'output_type',
  'from', 'share', 'sh', 'ss', 'feature', 'campaign_id', 'wpisrc',
]);

function isTracking(name: string): boolean {
  const key = name.toLowerCase();
  if (TRACKING_PARAMS.has(key)) return true;
  return TRACKING_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * The dedup key: scheme, host case, `www.`, port, tracking params, AMP
 * suffixes, trailing slashes and fragments all removed.
 *
 * One story arriving from the feed, from a syndication partner and from a
 * shared link differs only in this furniture, and three copies of the same
 * press release is three of her six items for the day spent on one fact.
 *
 * NOTE the boundary: this dedupes ONE story reached by several URLs. The same
 * story written up independently by five outlets has five different URLs and is
 * `headlineFingerprint`'s problem, not this function's.
 */
export function canonicalUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return raw.trim();
  }

  // http and https serve the same article; the scheme is furniture here.
  const scheme = url.protocol === 'http:' ? 'https:' : url.protocol;
  const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  const port = url.port === '80' || url.port === '443' ? '' : url.port;

  let path = url.pathname
    .replace(/\/index\.(?:html?|php|aspx)$/i, '/')
    .replace(/\.amp$/i, '')
    .replace(/\/amp\/?$/i, '/');
  path = path.replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  if (path === '') path = '/';

  const params: [string, string][] = [];
  for (const [name, value] of url.searchParams) {
    if (isTracking(name) || value === '') continue;
    params.push([name, value]);
  }
  params.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  const query = params.map(([n, v]) => `${encodeURIComponent(n)}=${encodeURIComponent(v)}`).join('&');

  return `${scheme}//${host}${port === '' ? '' : `:${port}`}${path}${query === '' ? '' : `?${query}`}`;
}

/* ------------------------------------------------------------ feed  parsing */

/** Entries past this are ignored. A feed is a window, not an archive. */
export const MAX_FEED_ENTRIES = 120;

/** Refuses to scan a feed larger than this. Feeds are third-party content. */
export const MAX_FEED_CHARS = 4 * 1024 * 1024;

const CDATA = /<!\[CDATA\[([\s\S]*?)\]\]>/g;

function tagPattern(name: string): RegExp {
  // `(?:[A-Za-z0-9_-]+:)?` so `<dc:date>` and `<content:encoded>` are found.
  return new RegExp(`<(?:[A-Za-z0-9_-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_-]+:)?${name}\\s*>`, 'i');
}

/**
 * The text of one element, with a feed's TWO layers of encoding undone.
 *
 * Feeds carry markup escaped inside the element (`&lt;p&gt;`) or wrapped in
 * CDATA, and Atom says so explicitly with `type="html"`. So the entity decode
 * has to happen BEFORE tag stripping or the lede arrives with visible `<p>`
 * tags in it. `htmlToText` then decodes a second time, which is right here and
 * only here: two encode layers, two decode layers. The output is plain text
 * that is never rendered as markup.
 */
function tagText(block: string, name: string): string | null {
  const inner = tagPattern(name).exec(block)?.[1];
  if (inner === undefined) return null;
  const unwrapped = decodeEntities(inner.replace(CDATA, '$1'));
  const text = htmlToText(unwrapped).replace(/\n+/g, ' ').trim();
  return text === '' ? null : text;
}

/** A `<link>`/`<id>` value, or the `href` of an Atom `<link .../>`. */
function entryLink(block: string): string | null {
  // Atom prefers rel="alternate"; a self/hub link points at the feed, not the
  // story, and following it would fetch the feed as if it were an article.
  const alternate =
    /<(?:[A-Za-z0-9_-]+:)?link\b[^>]*\brel\s*=\s*["']alternate["'][^>]*\bhref\s*=\s*["']([^"']+)["']/i.exec(
      block,
    )?.[1] ??
    /<(?:[A-Za-z0-9_-]+:)?link\b(?![^>]*\brel\s*=\s*["'](?:self|hub|replies|edit|enclosure)["'])[^>]*\bhref\s*=\s*["']([^"']+)["']/i.exec(
      block,
    )?.[1];
  if (alternate !== undefined) return decodeEntities(alternate).trim();

  const plain = tagPattern('link').exec(block)?.[1]?.replace(CDATA, '$1').trim();
  if (plain !== undefined && plain !== '') return decodeEntities(plain);

  const guid = tagPattern('guid').exec(block)?.[1]?.replace(CDATA, '$1').trim();
  if (guid !== undefined && /^https?:\/\//i.test(guid)) return decodeEntities(guid);

  const id = tagPattern('id').exec(block)?.[1]?.replace(CDATA, '$1').trim();
  if (id !== undefined && /^https?:\/\//i.test(id)) return decodeEntities(id);

  return null;
}

const DATE_TAGS = ['pubDate', 'published', 'updated', 'date', 'modified'] as const;

function entryDate(block: string): string | null {
  for (const tag of DATE_TAGS) {
    const raw = tagPattern(tag).exec(block)?.[1]?.replace(CDATA, '$1').trim();
    if (raw === undefined || raw === '') continue;
    const ms = Date.parse(decodeEntities(raw));
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return null;
}

const LEDE_TAGS = ['description', 'summary', 'encoded', 'content', 'subtitle'] as const;
const MAX_LEDE_CHARS = 500;

function entryLede(block: string): string | null {
  for (const tag of LEDE_TAGS) {
    const text = tagText(block, tag);
    if (text === null) continue;
    return text.length > MAX_LEDE_CHARS ? `${text.slice(0, MAX_LEDE_CHARS).trimEnd()}...` : text;
  }
  return null;
}

/**
 * RSS 2.0 and Atom, from one scanner.
 *
 * The two formats differ in the entry element (`<item>` vs `<entry>`), where
 * the link lives (element text vs an `href` attribute) and what the date tag is
 * called. Everything else is the same shape, so the split is three lookups
 * deep rather than two parsers wide — and a feed that declares itself Atom in
 * `sources.json` but serves RSS still parses, which matters because outlets
 * change theirs without telling anyone.
 */
export function parseFeed(xml: string, feed: SourceFeed): FeedEntry[] {
  if (typeof xml !== 'string' || xml.length === 0) return [];
  const text = (xml.length > MAX_FEED_CHARS ? xml.slice(0, MAX_FEED_CHARS) : xml)
    // A DOCTYPE is where entity declarations would live. Nothing here expands
    // entities, but removing the declaration removes the question.
    .replace(/<!DOCTYPE[\s\S]*?>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  const atomEntries = blocksOf(text, 'entry');
  const blocks = atomEntries.length > 0 ? atomEntries : blocksOf(text, 'item');

  const entries: FeedEntry[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    if (entries.length >= MAX_FEED_ENTRIES) break;
    const link = entryLink(block);
    if (link === null) continue;
    let absolute: URL;
    try {
      absolute = new URL(link, feed.url);
    } catch {
      continue;
    }
    if (absolute.protocol !== 'https:' && absolute.protocol !== 'http:') continue;

    const canonical = canonicalUrl(absolute.toString());
    if (seen.has(canonical)) continue;
    seen.add(canonical);

    entries.push({
      feedId: feed.id,
      sourceName: feed.name,
      url: absolute.toString(),
      canonicalUrl: canonical,
      title: tagText(block, 'title') ?? '',
      publishedAt: entryDate(block),
      lede: entryLede(block),
    });
  }
  return entries;
}

/** `<item>`/`<entry>` blocks, non-nesting, namespace prefixes tolerated. */
function blocksOf(xml: string, name: string): string[] {
  const pattern = new RegExp(
    `<(?:[A-Za-z0-9_-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_-]+:)?${name}\\s*>`,
    'gi',
  );
  const out: string[] = [];
  for (let m = pattern.exec(xml); m !== null; m = pattern.exec(xml)) {
    const inner = m[1];
    if (inner !== undefined) out.push(inner);
  }
  return out;
}
