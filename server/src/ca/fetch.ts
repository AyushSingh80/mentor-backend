/**
 * Bounded, allowlisted article fetching.
 *
 * ## SSRF is a real surface here, not a checklist item
 *
 * Every URL this module fetches was chosen by a third party. A feed is a list
 * of links written by someone else's CMS, and a compromised or hostile feed
 * entry is a request this server will make on the attacker's behalf, from
 * inside whatever network it runs in, with whatever credentials that network
 * grants by IP. `http://169.254.169.254/latest/meta-data/iam/security-credentials/`
 * is one `<link>` element away, and the response would be handed to a model and
 * summarised into a digest.
 *
 * So the gate is not "is this URL suspicious". It is:
 *
 *  1. HTTPS only, no credentials in the URL, default ports only.
 *  2. The host's REGISTRABLE DOMAIN must be one an allowlisted feed lives on.
 *     Not a substring match, not a suffix match — `pib.gov.in.evil.com` and
 *     `notpib.gov.in` both fail, and `gov.in` is never itself a key (see
 *     `registrableDomain`).
 *  3. Every address the host RESOLVES to must be public. Private, loopback,
 *     link-local, CGNAT, multicast and reserved ranges are refused, IPv4 and
 *     IPv6, including IPv4-mapped and 6to4 forms that smuggle a v4 address
 *     inside a v6 one.
 *  4. Redirects are followed manually, at most three, and only within the same
 *     registrable domain. Every hop is re-checked from step 1. An allowlisted
 *     host that 302s to metadata does not get to.
 *  5. Response size is capped while the body streams, not after.
 *
 * ## The residual risk, stated rather than hidden
 *
 * Steps 3 and 4 resolve DNS and then let `fetch` resolve it again, so a
 * TOCTOU rebind is theoretically possible. Closing it properly needs a custom
 * dispatcher that connects to the pinned address with a `Host` header, which is
 * a lot of undici surface to own for this. It is acceptable HERE because of
 * step 2: rebinding requires control of the DNS for `pib.gov.in`, `rbi.org.in`
 * or `thehindu.com`, and an attacker with that has better options than this
 * server. If the allowlist ever accepts a domain the operator does not trust,
 * this needs revisiting first.
 *
 * ## The loopback exception
 *
 * Tests need a fixture server on `127.0.0.1`. That exception is gated on
 * `CA_SOURCES_FILE` being explicitly set — NOT on `NODE_ENV`. `NODE_ENV` is
 * ambient, defaults to nothing, is set by tooling that has no idea what it
 * means, and a production deploy that forgets to set it to `production` would
 * silently switch this guard off. Requiring an explicit path to an explicit
 * allowlist file makes the exception something an operator has to do on
 * purpose. It is narrowed further: only a LITERAL loopback host is exempt. A
 * DNS name that resolves to loopback is refused with or without the flag, so
 * the exception can never be used to rebind an allowlisted domain inward.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { extractArticle } from './extract.js';
import { allowedDomains, canonicalUrl, loadSources, parseFeed, registrableDomain } from './sources.js';
import type { FeedEntry, FetchFailure, FetchFailureReason, SourceDocument, SourceFeed } from './types.js';

export const FETCH_TIMEOUT_MS = 8_000;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_CONCURRENCY = 4;
export const MAX_REDIRECTS = 3;

const USER_AGENT = 'upsc-mentor/0.1 (current-affairs digest; contact via deployment operator)';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export type HostLookup = (hostname: string) => Promise<readonly string[]>;

export interface FetchDeps {
  /** Injectable so tests drive a fixture server rather than the internet. */
  fetchImpl?: FetchLike;
  /** Injectable so an SSRF test can assert on resolution without real DNS. */
  lookup?: HostLookup;
  timeoutMs?: number;
  maxBytes?: number;
  concurrency?: number;
  maxRedirects?: number;
  /** Caller cancellation. Honoured before, during and between requests. */
  signal?: AbortSignal;
  /**
   * Checked between requests as well as at the start.
   *
   * `signal` alone is not enough for the route's purposes: the digest route
   * learns the client is gone from an Express `close` event, and it wants the
   * remaining shortlist skipped rather than each of its requests aborted and
   * counted as a timeout failure.
   */
  isCancelled?: () => boolean;
  onProgress?: (done: number, total: number) => void;
  /**
   * The allowlist the domain rule is enforced against.
   *
   * Optional so `routes/ca.ts` can call `fetchDocuments(entries, opts)` without
   * threading feeds through the pipeline. Absent, it is loaded from
   * `sources.json` — the SAME list, never a wider one. There is no code path
   * that fetches without an allowlist.
   */
  feeds?: readonly SourceFeed[];
  now?: () => Date;
  /** Ignored here; accepted so the route can pass its whole options object. */
  requestId?: string;
  date?: string;
}

/* ------------------------------------------------------------ address policy */

function ipv4Blocks(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    out.push(value);
  }
  return out;
}

/** IPv4 ranges that must never be fetched. */
function isPrivateIpv4(ip: string): boolean {
  const b = ipv4Blocks(ip);
  if (b === null) return true;
  const [a = 0, second = 0, third = 0] = b;
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 100 && second >= 64 && second <= 127) return true; // CGNAT
  if (a === 169 && second === 254) return true; // link-local, incl. 169.254.169.254
  if (a === 172 && second >= 16 && second <= 31) return true; // RFC1918
  if (a === 192 && second === 0 && third === 0) return true; // IETF protocol
  if (a === 192 && second === 0 && third === 2) return true; // TEST-NET-1
  if (a === 192 && second === 88 && third === 99) return true; // 6to4 relay anycast
  if (a === 192 && second === 168) return true; // RFC1918
  if (a === 198 && (second === 18 || second === 19)) return true; // benchmarking
  if (a === 198 && second === 51 && third === 100) return true; // TEST-NET-2
  if (a === 203 && second === 0 && third === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/** Eight 16-bit groups, `::` expanded. `null` when the literal is malformed. */
function ipv6Groups(ip: string): number[] | null {
  const zoneless = ip.split('%')[0] ?? ip;
  const halves = zoneless.split('::');
  if (halves.length > 2) return null;

  const parseSide = (side: string): number[] | null => {
    if (side === '') return [];
    const out: number[] = [];
    for (const piece of side.split(':')) {
      if (piece.includes('.')) {
        const b = ipv4Blocks(piece);
        if (b === null) return null;
        out.push(((b[0] ?? 0) << 8) | (b[1] ?? 0), ((b[2] ?? 0) << 8) | (b[3] ?? 0));
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
      out.push(Number.parseInt(piece, 16));
    }
    return out;
  };

  const head = parseSide(halves[0] ?? '');
  const tail = halves.length === 2 ? parseSide(halves[1] ?? '') : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

function isPrivateIpv6(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (g === null) return true;
  const [g0 = 0, g1 = 0] = g;

  if (g.every((group) => group === 0)) return true; // ::
  if (g.slice(0, 7).every((group) => group === 0) && g[7] === 1) return true; // ::1
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g0 === 0x0100 && g1 === 0x0000) return true; // 100::/64 discard-only
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
  if (g0 === 0x2001 && g1 === 0x0000) return true; // Teredo, tunnels a v4 peer
  if (g0 === 0x2002) return true; // 6to4, embeds an arbitrary v4 address

  // ::ffff:a.b.c.d and the NAT64 well-known prefix both carry a v4 address that
  // the v4 rules have to see. Checking only the v6 form is the classic bypass.
  const isMapped = g.slice(0, 5).every((group) => group === 0) && g[5] === 0xffff;
  const isNat64 = g0 === 0x0064 && g1 === 0xff9b;
  if (isMapped || isNat64) {
    const hi = g[6] ?? 0;
    const lo = g[7] ?? 0;
    return isPrivateIpv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  return false;
}

/** True for anything not routable on the public internet. Fails closed. */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateIpv4(ip);
  if (family === 6) return isPrivateIpv6(ip);
  return true;
}

function isLoopbackLiteral(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  const family = isIP(host);
  if (family === 4) return (ipv4Blocks(host)?.[0] ?? -1) === 127;
  if (family === 6) {
    const g = ipv6Groups(host);
    return g !== null && g.slice(0, 7).every((group) => group === 0) && g[7] === 1;
  }
  return false;
}

/**
 * Read at CALL time, never captured at import.
 *
 * `config.caSourcesFile` cannot answer this question: it has a default, so by
 * the time it is a string the fact that nobody set it has been erased. The raw
 * env var is the only place the operator's intent survives.
 */
export function loopbackExceptionEnabled(): boolean {
  const raw = process.env['CA_SOURCES_FILE'];
  return typeof raw === 'string' && raw.trim() !== '';
}

/* -------------------------------------------------------------- the URL gate */

export type UrlVerdict =
  | { readonly ok: true; readonly url: URL; readonly domain: string }
  | { readonly ok: false; readonly detail: string };

/**
 * Every check between "a feed said so" and "this server makes a request".
 *
 * Returns a verdict rather than throwing so a single blocked link never takes
 * down the whole digest run, and so the reason lands in `sourceFailures` where
 * it is visible instead of in a log nobody reads.
 */
export async function checkUrl(
  rawUrl: string,
  allowed: ReadonlySet<string>,
  lookup: HostLookup = defaultLookup,
): Promise<UrlVerdict> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, detail: `not a URL: ${rawUrl}` };
  }

  const loopbackOk = loopbackExceptionEnabled() && isLoopbackLiteral(url.hostname);

  if (url.protocol !== 'https:' && !(loopbackOk && url.protocol === 'http:')) {
    return { ok: false, detail: `scheme ${url.protocol} is not allowed` };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, detail: 'URL carries credentials' };
  }
  if (url.port !== '' && !loopbackOk) {
    return { ok: false, detail: `non-default port ${url.port} is not allowed` };
  }

  const domain = registrableDomain(url.hostname);
  if (!allowed.has(domain)) {
    return { ok: false, detail: `${url.hostname} is not on an allowlisted feed's domain` };
  }

  if (loopbackOk) return { ok: true, url, domain };

  // A bare IP can never be an allowlisted publisher, and letting one through
  // would mean the domain rule was satisfied by an address rather than a name.
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0) {
    return { ok: false, detail: `${url.hostname} is a bare IP address` };
  }

  let addresses: readonly string[];
  try {
    addresses = await lookup(url.hostname);
  } catch (error) {
    return { ok: false, detail: `DNS lookup failed for ${url.hostname}: ${String(error)}` };
  }
  if (addresses.length === 0) {
    return { ok: false, detail: `${url.hostname} resolves to nothing` };
  }
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      return { ok: false, detail: `${url.hostname} resolves to non-public address ${address}` };
    }
  }
  return { ok: true, url, domain };
}

async function defaultLookup(hostname: string): Promise<string[]> {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

/* --------------------------------------------------------------- HTTP layer */

const HTML_TYPES = ['text/html', 'application/xhtml+xml'];
const FEED_TYPE = /(?:\/|\+)(?:xml|rss|atom)\b|^text\/xml|^application\/xml/i;

interface RawResponse {
  finalUrl: string;
  body: string;
}

type HttpResult =
  | { readonly ok: true; readonly value: RawResponse }
  | { readonly ok: false; readonly reason: FetchFailureReason; readonly detail: string };

function charsetOf(contentType: string): string {
  const match = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType);
  return (match?.[1] ?? 'utf-8').toLowerCase();
}

/**
 * The byte ceiling is enforced WHILE the body streams.
 *
 * `Content-Length` is a claim by the server, not a fact, and a chunked response
 * carries none at all. Checking the header is worth doing because it refuses
 * cheaply, but the running total in the read loop is the one that is actually
 * load bearing — without it a hostile allowlisted host streams gigabytes into
 * this process and the ceiling means nothing.
 */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array | 'too_large'> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) return 'too_large';

  const body = response.body;
  if (body === null) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    return buffer.byteLength > maxBytes ? 'too_large' : buffer;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return 'too_large';
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function decodeBody(bytes: Uint8Array, contentType: string): string {
  const charset = charsetOf(contentType);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/**
 * One resource, with redirects followed by hand.
 *
 * `redirect: 'follow'` would hand the redirect chain to undici, which has no
 * idea what this server's allowlist is: an allowlisted host answering `302
 * Location: http://169.254.169.254/` would be followed before any code here
 * ran. Following manually is the only way every hop gets re-checked, and the
 * same-domain rule means an allowlisted publisher cannot be used as an open
 * redirector into somewhere else on the allowlist either.
 */
async function httpGet(
  startUrl: string,
  accept: (contentType: string) => boolean,
  expectation: string,
  allowed: ReadonlySet<string>,
  deps: FetchDeps,
): Promise<HttpResult> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as FetchLike);
  const lookup = deps.lookup ?? defaultLookup;
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = deps.maxBytes ?? MAX_RESPONSE_BYTES;
  const maxRedirects = deps.maxRedirects ?? MAX_REDIRECTS;

  let current = startUrl;
  let originDomain: string | null = null;

  // A function call, not `deps.signal?.aborted`, because `aborted` is readonly
  // and TypeScript's control-flow analysis caches the first read — the check
  // after `await fetchImpl(...)` would be narrowed to a constant `false` and
  // silently deleted, which is the exact check that distinguishes a caller
  // cancellation from a real timeout.
  const cancelled = (): boolean => deps.signal?.aborted === true || deps.isCancelled?.() === true;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (cancelled()) {
      return { ok: false, reason: 'timeout', detail: 'cancelled by caller' };
    }

    const verdict = await checkUrl(current, allowed, lookup);
    if (!verdict.ok) return { ok: false, reason: 'blocked', detail: verdict.detail };
    if (originDomain === null) originDomain = verdict.domain;
    else if (verdict.domain !== originDomain) {
      return {
        ok: false,
        reason: 'blocked',
        detail: `redirect leaves ${originDomain} for ${verdict.domain}`,
      };
    }

    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error('timeout')), timeoutMs);
    const signal =
      deps.signal === undefined
        ? timeout.signal
        : AbortSignal.any([deps.signal, timeout.signal]);

    // ONE try/finally around the response AND the body read.
    //
    // Clearing the timer as soon as the headers arrive — the obvious shape —
    // leaves the body unbounded in time: a server that answers `200` and then
    // stalls forever holds this request open for as long as it likes, and the
    // 8s ceiling protects nothing. The digest would hang instead of coming back
    // short, which is the one failure mode this whole layer is built to avoid.
    try {
      const response = await fetchImpl(verdict.url.toString(), {
        redirect: 'manual',
        signal,
        headers: {
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5',
          'user-agent': USER_AGENT,
        },
      });

      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get('location');
        if (location === null || location.trim() === '') {
          return { ok: false, reason: 'http_error', detail: `${response.status} with no Location` };
        }
        try {
          current = new URL(location, verdict.url).toString();
        } catch {
          return { ok: false, reason: 'http_error', detail: `unparseable Location: ${location}` };
        }
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, reason: 'http_error', detail: `HTTP ${response.status}` };
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!accept(contentType)) {
        // Cancelled rather than left dangling: an undrained body keeps the
        // socket and the connection-pool slot for the request timeout.
        await response.body?.cancel().catch(() => undefined);
        return {
          ok: false,
          reason: 'not_html',
          detail: `content-type ${contentType || '(absent)'} is not ${expectation}`,
        };
      }

      const bytes = await readCapped(response, maxBytes);
      if (bytes === 'too_large') {
        return { ok: false, reason: 'too_large', detail: `body exceeds ${maxBytes} bytes` };
      }
      return {
        ok: true,
        value: { finalUrl: verdict.url.toString(), body: decodeBody(bytes, contentType) },
      };
    } catch (error) {
      if (cancelled()) return { ok: false, reason: 'timeout', detail: 'cancelled by caller' };
      if (timeout.signal.aborted) {
        return { ok: false, reason: 'timeout', detail: `no response in ${timeoutMs}ms` };
      }
      return { ok: false, reason: 'http_error', detail: String(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: false, reason: 'http_error', detail: `more than ${maxRedirects} redirects` };
}

/* ---------------------------------------------------------------- the  pool */

/** Bounded concurrency, input order preserved, one rejection never sinks the run. */
async function pool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: width }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  });
  await Promise.all(runners);
  return results;
}

/* ------------------------------------------------------------------- feeds  */

export interface FeedFetchResult {
  entries: FeedEntry[];
  failures: FetchFailure[];
  /**
   * `kind: 'index'` feeds, which were NOT polled.
   *
   * Named rather than skipped silently, because "a 404 feed must never look
   * like a quiet news day" applies just as much to a source this module has no
   * parser for. Three of the allowlisted sources — the Supreme Court, PRS and
   * the Ministry of Tribal Affairs — publish no feed at all, and a caller that
   * did not know that would report a thin digest as normal.
   */
  unsupported: SourceFeed[];
}

export async function fetchFeedEntries(
  feeds: readonly SourceFeed[],
  deps: FetchDeps = {},
): Promise<FeedFetchResult> {
  const allowed = allowedDomains(feeds);
  const pollable = feeds.filter((feed) => feed.kind === 'rss' || feed.kind === 'atom');
  const unsupported = feeds.filter((feed) => feed.kind === 'index');

  const results = await pool(pollable, deps.concurrency ?? MAX_CONCURRENCY, async (feed) => {
    if (deps.isCancelled?.() === true || deps.signal?.aborted === true) {
      return { entries: [] as FeedEntry[], failure: null };
    }
    // Strictly XML. Down To Earth's retired `/rss/news` path answers 200 with a
    // 1MB HTML app shell, so a status-only check reports it as healthy for as
    // long as nobody looks; requiring the content type is what turns that into
    // a visible failure.
    const result = await httpGet(
      feed.url,
      (type) => FEED_TYPE.test(type),
      'an RSS or Atom document',
      allowed,
      deps,
    );
    if (!result.ok) {
      return {
        entries: [] as FeedEntry[],
        failure: { url: feed.url, feedId: feed.id, reason: result.reason, detail: result.detail },
      };
    }
    const entries = parseFeed(result.value.body, feed);
    if (entries.length === 0) {
      // A feed that parses to nothing is indistinguishable from a quiet day
      // unless it is reported. Down To Earth and PIB both have URL variants
      // that answer 200 with a well-formed but empty document.
      return {
        entries,
        failure: {
          url: feed.url,
          feedId: feed.id,
          reason: 'extract_empty' as FetchFailureReason,
          detail: 'feed parsed to zero entries',
        },
      };
    }
    return { entries, failure: null };
  });

  const entries: FeedEntry[] = [];
  const failures: FetchFailure[] = [];
  for (const result of results) {
    entries.push(...result.entries);
    if (result.failure !== null) failures.push(result.failure);
  }
  // An unparsed source is reported as a failure, not omitted. The Supreme
  // Court, PRS and the Ministry of Tribal Affairs publish no feed at all, and a
  // caller that saw only a short entry list would report their absence as a
  // quiet news day — the one thing `CaSummaryFrame.sourceFailures` exists to
  // make impossible.
  for (const feed of unsupported) {
    failures.push({
      url: feed.url,
      feedId: feed.id,
      reason: 'extract_empty',
      detail: `kind "index" is not polled: ${feed.name} publishes no RSS or Atom feed and needs an HTML index reader`,
    });
  }
  return { entries, failures, unsupported };
}

/* --------------------------------------------------------------- documents  */

export interface DocumentFetchResult {
  documents: SourceDocument[];
  failures: FetchFailure[];
}

/**
 * Feed entries in, `SourceDocument`s out.
 *
 * The text on these documents is the ONLY thing the model is permitted to write
 * from and it is never persisted — see `SourceDocument` in types.ts. Nothing
 * here writes to disk.
 */
export async function fetchDocuments(
  entries: readonly FeedEntry[],
  deps: FetchDeps = {},
): Promise<DocumentFetchResult> {
  const feeds = deps.feeds ?? (await loadSources()).feeds;
  const allowed = allowedDomains(feeds);
  const now = deps.now ?? (() => new Date());
  let done = 0;

  const results = await pool(entries, deps.concurrency ?? MAX_CONCURRENCY, async (entry) => {
    if (deps.isCancelled?.() === true || deps.signal?.aborted === true) {
      deps.onProgress?.((done += 1), entries.length);
      return { document: null, failure: null };
    }
    const result = await httpGet(
      entry.url,
      (type) => HTML_TYPES.some((html) => type.toLowerCase().includes(html)),
      'HTML',
      allowed,
      deps,
    );
    if (!result.ok) {
      deps.onProgress?.((done += 1), entries.length);
      return {
        document: null,
        failure: { url: entry.url, feedId: entry.feedId, reason: result.reason, detail: result.detail },
      };
    }

    const article = extractArticle(result.value.body);
    if (article === null) {
      deps.onProgress?.((done += 1), entries.length);
      return {
        document: null,
        failure: {
          url: entry.url,
          feedId: entry.feedId,
          reason: 'extract_empty' as FetchFailureReason,
          detail: 'no article body: paywall stub, index page or an empty shell',
        },
      };
    }

    const document: SourceDocument = {
      url: result.value.finalUrl,
      canonicalUrl: canonicalUrl(result.value.finalUrl),
      sourceName: entry.sourceName,
      feedId: entry.feedId,
      title: entry.title !== '' ? entry.title : (article.title ?? ''),
      // The page's own JSON-LD beats the feed's pubDate: a feed re-publishes
      // updated stories with a fresh date, and a three-year-old explainer that
      // resurfaces would otherwise be dated today.
      publishedAt: article.publishedAt ?? entry.publishedAt,
      text: article.text,
      charCount: article.charCount,
      fetchedAt: now().toISOString(),
    };
    deps.onProgress?.((done += 1), entries.length);
    return { document, failure: null };
  });

  const documents: SourceDocument[] = [];
  const failures: FetchFailure[] = [];
  for (const result of results) {
    if (result.document !== null) documents.push(result.document);
    if (result.failure !== null) failures.push(result.failure);
  }
  return { documents, failures };
}
