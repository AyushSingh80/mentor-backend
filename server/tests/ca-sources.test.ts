/**
 * The source allowlist, its version, the feed parser — and the fetch gate that
 * enforces the allowlist.
 *
 * The gate is tested here rather than in a file of its own because it is not a
 * separate concern: `fetch.ts` exists to make `sources.json` mean something.
 * Without it the allowlist is documentation, and the URLs this server requests
 * are chosen by whoever writes the feeds it reads.
 *
 * A note on the loopback exception: every SSRF test below sets and clears
 * `CA_SOURCES_FILE` explicitly, because that env var — not `NODE_ENV` — is the
 * gate. `NODE_ENV` is ambient and defaults to nothing, so a production deploy
 * that forgets to set it would silently turn the guard off. There is a test
 * that asserts `NODE_ENV` alone does nothing.
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.ANTHROPIC_API_KEY ??= 'sk-ant-test-not-real';
process.env.MODEL_EVALUATION ??= 'eval-model-1';
process.env.MODEL_BULK ??= 'bulk-model-1';
process.env.APP_BEARER_TOKEN ??= 'test-token';

const {
  allowedDomains,
  canonicalSourceForm,
  canonicalUrl,
  clearSourceCache,
  loadSources,
  parseFeed,
  parseSourceSet,
  registrableDomain,
  sourceSetVersion,
} = await import('../src/ca/sources.js');
const {
  MAX_CONCURRENCY,
  MAX_RESPONSE_BYTES,
  FETCH_TIMEOUT_MS,
  checkUrl,
  fetchDocuments,
  fetchFeedEntries,
  isPrivateAddress,
  loopbackExceptionEnabled,
} = await import('../src/ca/fetch.js');

type Feed = Parameters<typeof parseFeed>[1];
type Entry = ReturnType<typeof parseFeed>[number];

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, 'fixtures', 'ca');
const fixture = (name: string): Promise<string> => readFile(join(fixtureDir, name), 'utf8');
const TEST_SOURCES = join(fixtureDir, 'sources.test.json');

/** Public address, so the DNS rule passes without touching a real resolver. */
const publicLookup = async (): Promise<string[]> => ['93.184.216.34'];

async function withLoopbackException<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env['CA_SOURCES_FILE'];
  process.env['CA_SOURCES_FILE'] = TEST_SOURCES;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env['CA_SOURCES_FILE'];
    else process.env['CA_SOURCES_FILE'] = previous;
  }
}

/* ------------------------------------------------------------- the allowlist */

describe('parseSourceSet', () => {
  const good = {
    id: 'x',
    name: 'X',
    url: 'https://example.test/feed',
    kind: 'rss',
    papers: ['gs2'],
    trust: 'primary',
  };

  it('accepts a well-formed feed', () => {
    assert.equal(parseSourceSet([good]).length, 1);
  });

  it('throws rather than skipping a malformed entry', () => {
    // config.ts's rule: refuse to start rather than discover it at request time.
    // A typo'd feed that is silently dropped is a source that stops appearing
    // with no error anywhere to explain it.
    assert.throws(() => parseSourceSet([{ ...good, url: 'not a url' }]), /not a URL/);
    assert.throws(() => parseSourceSet([{ ...good, kind: 'json' }]), /kind must be/);
    assert.throws(() => parseSourceSet([{ ...good, trust: 'high' }]), /trust must be/);
    assert.throws(() => parseSourceSet([{ ...good, papers: 'gs2' }]), /papers must be/);
    assert.throws(() => parseSourceSet([{ ...good, name: '' }]), /name must be/);
    assert.throws(() => parseSourceSet([good, good]), /duplicates an earlier feed/);
    assert.throws(() => parseSourceSet([]), /lists no feeds/);
    assert.throws(() => parseSourceSet({}), /must contain a JSON array/);
  });
});

describe('sourceSetVersion', () => {
  const feeds = parseSourceSet([
    { id: 'a', name: 'A', url: 'https://a.test/feed', kind: 'rss', papers: ['gs2', 'gs1'], trust: 'primary' },
    { id: 'b', name: 'B', url: 'https://b.test/feed', kind: 'atom', papers: ['gs3'], trust: 'secondary' },
  ]);

  it('is a 12-character content hash, like every other version in this server', () => {
    assert.match(sourceSetVersion(feeds), /^[0-9a-f]{12}$/);
  });

  it('does NOT move when the file is reformatted or reordered', () => {
    // A version that moved on `prettier` would be noise, and a version that is
    // noise is a version nobody reads.
    const reordered = parseSourceSet([
      { id: 'b', name: 'B', url: 'https://b.test/feed', kind: 'atom', papers: ['gs3'], trust: 'secondary' },
      { id: 'a', name: 'A', url: 'https://a.test/feed', kind: 'rss', papers: ['gs1', 'gs2'], trust: 'primary' },
    ]);
    assert.equal(sourceSetVersion(reordered), sourceSetVersion(feeds));
    assert.equal(canonicalSourceForm(reordered), canonicalSourceForm(feeds));
  });

  it('DOES move when a feed URL changes', () => {
    const edited = parseSourceSet([
      { id: 'a', name: 'A', url: 'https://a.test/rss.xml', kind: 'rss', papers: ['gs2', 'gs1'], trust: 'primary' },
      { id: 'b', name: 'B', url: 'https://b.test/feed', kind: 'atom', papers: ['gs3'], trust: 'secondary' },
    ]);
    assert.notEqual(sourceSetVersion(edited), sourceSetVersion(feeds));
  });

  it('moves on any other semantic edit too', () => {
    const base = sourceSetVersion(feeds);
    const variants = [
      { id: 'a2', name: 'A', url: 'https://a.test/feed', kind: 'rss', papers: ['gs2', 'gs1'], trust: 'primary' },
      { id: 'a', name: 'A renamed', url: 'https://a.test/feed', kind: 'rss', papers: ['gs2', 'gs1'], trust: 'primary' },
      { id: 'a', name: 'A', url: 'https://a.test/feed', kind: 'atom', papers: ['gs2', 'gs1'], trust: 'primary' },
      { id: 'a', name: 'A', url: 'https://a.test/feed', kind: 'rss', papers: ['gs2'], trust: 'primary' },
      { id: 'a', name: 'A', url: 'https://a.test/feed', kind: 'rss', papers: ['gs2', 'gs1'], trust: 'secondary' },
    ];
    for (const variant of variants) {
      const edited = parseSourceSet([variant, feeds[1] as unknown]);
      assert.notEqual(sourceSetVersion(edited), base, `unversioned edit: ${JSON.stringify(variant)}`);
    }
  });
});

describe('the shipped allowlist', () => {
  it('loads, validates and versions', async () => {
    clearSourceCache();
    const set = await loadSources(join(here, '..', 'src', 'ca', 'sources.json'));
    assert.ok(set.feeds.length >= 8, 'the allowlist should not have quietly shrunk');
    assert.match(set.sourceSetVersion, /^[0-9a-f]{12}$/);
  });

  it('marks the government and the court primary', async () => {
    clearSourceCache();
    const { feeds } = await loadSources(join(here, '..', 'src', 'ca', 'sources.json'));
    for (const feed of feeds) {
      const host = new URL(feed.url).hostname;
      const isState = host.endsWith('.gov.in') || host.endsWith('.nic.in') || host.endsWith('rbi.org.in');
      if (isState) assert.equal(feed.trust, 'primary', `${feed.id} is the state in its own words`);
    }
  });

  it('reports a missing file loudly rather than serving an empty allowlist', async () => {
    clearSourceCache();
    await assert.rejects(() => loadSources(join(fixtureDir, 'does-not-exist.json')), /Cannot read/);
    clearSourceCache();
  });
});

/* -------------------------------------------------------- registrable domain */

describe('registrableDomain', () => {
  it('does not treat a public suffix as a registrable domain', () => {
    // The security-relevant case. "Last two labels" maps pib.gov.in to gov.in,
    // and an allowlist keyed on gov.in admits every server in the Government of
    // India — thousands of hosts, several reachable only from inside.
    assert.equal(registrableDomain('www.pib.gov.in'), 'pib.gov.in');
    assert.equal(registrableDomain('pib.gov.in'), 'pib.gov.in');
    assert.equal(registrableDomain('tribal.nic.in'), 'tribal.nic.in');
    assert.equal(registrableDomain('www.rbi.org.in'), 'rbi.org.in');
    assert.notEqual(registrableDomain('www.pib.gov.in'), 'gov.in');
  });

  it('handles ordinary two-label suffixes', () => {
    assert.equal(registrableDomain('www.thehindu.com'), 'thehindu.com');
    assert.equal(registrableDomain('indianexpress.com'), 'indianexpress.com');
    assert.equal(registrableDomain('images.indianexpress.com'), 'indianexpress.com');
  });

  it('refuses to split an IP address into labels', () => {
    // Without this, 127.0.0.1 and 10.0.0.7 would both key on their last two
    // octets and two unrelated internal addresses would share an allowlist key.
    assert.equal(registrableDomain('127.0.0.1'), '127.0.0.1');
    assert.equal(registrableDomain('169.254.169.254'), '169.254.169.254');
    assert.equal(registrableDomain('[::1]'), '::1');
  });

  it('is what the allowlist is built from', () => {
    const feeds = parseSourceSet([
      { id: 'p', name: 'PIB', url: 'https://www.pib.gov.in/RssMain.aspx', kind: 'rss', papers: [], trust: 'primary' },
    ]);
    assert.deepEqual([...allowedDomains(feeds)], ['pib.gov.in']);
  });
});

/* --------------------------------------------------------------- canonicalUrl */

describe('canonicalUrl', () => {
  it('strips the tracking furniture that makes one story look like five', () => {
    const a = canonicalUrl('https://pib.gov.in/Page.aspx?PRID=2012345&utm_source=rss&utm_medium=feed&fbclid=x');
    const b = canonicalUrl('https://WWW.pib.gov.in/Page.aspx?PRID=2012345&ref=twitter&spm=abc');
    const c = canonicalUrl('http://pib.gov.in/Page.aspx?PRID=2012345#story');
    assert.equal(a, b);
    assert.equal(a, c);
    assert.equal(a, 'https://pib.gov.in/Page.aspx?PRID=2012345');
  });

  it('keeps the parameters that identify the story', () => {
    assert.match(canonicalUrl('https://pib.gov.in/Page.aspx?PRID=2012345&utm_source=x'), /PRID=2012345/);
  });

  it('normalises AMP suffixes, trailing slashes and index files', () => {
    const base = canonicalUrl('https://thehindu.com/news/story');
    assert.equal(canonicalUrl('https://www.thehindu.com/news/story/'), base);
    assert.equal(canonicalUrl('https://thehindu.com/news/story/amp/'), base);
    assert.equal(canonicalUrl('https://thehindu.com/news/story.amp'), base);
  });

  it('orders the surviving parameters so key order cannot fork the key', () => {
    assert.equal(
      canonicalUrl('https://x.test/a?b=2&a=1'),
      canonicalUrl('https://x.test/a?a=1&b=2'),
    );
  });

  it('does not conflate two genuinely different stories', () => {
    assert.notEqual(
      canonicalUrl('https://pib.gov.in/Page.aspx?PRID=2012345'),
      canonicalUrl('https://pib.gov.in/Page.aspx?PRID=2012346'),
    );
  });

  it('returns the input rather than throwing on a URL it cannot parse', () => {
    assert.equal(canonicalUrl('  not a url  '), 'not a url');
  });
});

/* ------------------------------------------------------------- feed  parsing */

const rssFeed: Feed = {
  id: 'pib_releases',
  name: 'PIB Press Releases',
  url: 'https://www.pib.gov.in/RssMain.aspx',
  kind: 'rss',
  papers: ['gs2'],
  trust: 'primary',
};

const atomFeed: Feed = { ...rssFeed, id: 'dte_stories', name: 'Down To Earth', url: 'https://www.downtoearth.org.in/stories.rss', kind: 'atom', trust: 'secondary' };

describe('parseFeed — RSS 2.0', () => {
  let entries: Entry[] = [];
  before(async () => {
    entries = parseFeed(await fixture('rss-basic.xml'), rssFeed);
  });

  it('reads titles through CDATA and entity references', () => {
    assert.equal(entries[0]?.title, 'Cabinet approves the National Tribal Health Mission');
    assert.equal(entries[1]?.title, 'RBI & the Monetary Policy Committee — February review');
  });

  it('normalises pubDate in both RFC 822 forms to ISO 8601', () => {
    assert.equal(entries[0]?.publishedAt, '2026-03-12T04:00:00.000Z');
    assert.equal(entries[1]?.publishedAt, '2026-02-11T17:00:00.000Z');
  });

  it('falls back to a permalink guid when <link> is absent', () => {
    assert.equal(entries[1]?.url, 'https://pib.gov.in/PressReleasePage.aspx?PRID=2011900');
  });

  it('dedupes a syndicated copy of the same story by canonical URL', () => {
    // Item 3 is the same release arriving with different tracking and a
    // different host case. Three copies of one press release would be half her
    // day's reading spent on one fact.
    assert.equal(entries.length, 2, 'the syndicated copy and the linkless item are both dropped');
    assert.equal(entries[0]?.canonicalUrl, 'https://pib.gov.in/PressReleasePage.aspx?PRID=2012345');
  });

  it('keeps the ORIGINAL url for fetching and the canonical one for dedup', () => {
    assert.match(entries[0]?.url ?? '', /utm_source=rss/);
    assert.doesNotMatch(entries[0]?.canonicalUrl ?? '', /utm_source/);
  });

  it('carries the feed identity onto every entry', () => {
    for (const entry of entries) {
      assert.equal(entry.feedId, 'pib_releases');
      assert.equal(entry.sourceName, 'PIB Press Releases');
    }
  });

  it('strips markup out of the lede', () => {
    assert.equal(entries[0]?.lede, 'The Union Cabinet has approved an outlay of ₹1,200 crore.');
  });
});

describe('parseFeed — Atom', () => {
  let entries: Entry[] = [];
  before(async () => {
    entries = parseFeed(await fixture('atom-basic.xml'), atomFeed);
  });

  it('parses entries, titles and links', () => {
    assert.equal(entries.length, 4);
    assert.equal(entries[0]?.title, 'Groundwater extraction crosses 60 per cent in three states');
  });

  it('follows rel="alternate", never rel="self"', () => {
    // A self link points at the FEED. Following it would fetch the feed as if
    // it were an article and hand the model a list of headlines to write from.
    assert.equal(
      entries[0]?.url,
      'https://www.downtoearth.org.in/water/groundwater-extraction-9001?utm_campaign=daily',
    );
    assert.doesNotMatch(entries[0]?.url ?? '', /api\/entries/);
  });

  it('accepts a bare href when there is no rel at all', () => {
    assert.equal(entries[1]?.url, 'https://www.downtoearth.org.in/forests/fra-claims-9002');
  });

  it('prefers rel="alternate" over an earlier link with no rel at all', () => {
    // WordPress-shaped feeds put a comments link before the story link, both
    // without rel="self". Only the alternate preference tells them apart, and
    // the fallback exclusion cannot — so this is the entry that keeps that
    // preference load bearing rather than decorative.
    assert.equal(entries[3]?.url, 'https://www.downtoearth.org.in/wetlands/atlas-9004');
  });

  it('skips rel="self" on the fallback path, where there is no alternate to prefer', () => {
    // Two mechanisms enforce the same rule — the rel="alternate" preference and
    // the negative lookahead on the fallback — and entry 3 is the only one that
    // exercises the second. Without it, deleting the lookahead changes nothing
    // any test can see, and the next edit deletes the preference too.
    assert.equal(entries[2]?.url, 'https://www.downtoearth.org.in/coasts/crz-notification-9003');
    assert.doesNotMatch(entries[2]?.url ?? '', /api\/entries/);
  });

  it('prefers <published> over <updated>', () => {
    assert.equal(entries[0]?.publishedAt, '2026-03-12T00:45:00.000Z');
    assert.equal(entries[1]?.publishedAt, '2026-03-11T12:00:00.000Z');
  });

  it('decodes an escaped-HTML summary into a plain lede', () => {
    assert.equal(entries[0]?.lede, "The Central Ground Water Board's latest assessment covers 6,553 units.");
  });
});

describe('parseFeed hardening', () => {
  it('cannot be made to expand an entity, because it never expands one', () => {
    // A billion-laughs payload is inert here: the scanner has no concept of an
    // entity declaration, so the DOCTYPE is text it deletes.
    const bomb = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]>
      <rss version="2.0"><channel><item><title>&lol2;</title>
      <link>https://pib.gov.in/a</link></item></channel></rss>`;
    const entries = parseFeed(bomb, rssFeed);
    assert.equal(entries.length, 1);
    assert.ok((entries[0]?.title.length ?? 0) < 40, 'nothing expanded');
  });

  it('refuses a non-http scheme in a feed link', () => {
    const xml = `<rss><channel><item><title>t</title><link>file:///etc/passwd</link></item></channel></rss>`;
    assert.deepEqual(parseFeed(xml, rssFeed), []);
  });

  it('returns an empty list rather than throwing on junk', () => {
    assert.deepEqual(parseFeed('', rssFeed), []);
    assert.deepEqual(parseFeed('<html><body>not a feed</body></html>', rssFeed), []);
  });
});

/* ---------------------------------------------------------- address policy */

describe('isPrivateAddress', () => {
  it('refuses every IPv4 range that is not the public internet', () => {
    for (const ip of [
      '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254',
      '172.16.0.1', '172.31.255.255', '192.168.1.1', '192.0.2.1', '198.18.0.1',
      '198.51.100.4', '203.0.113.9', '224.0.0.1', '255.255.255.255',
    ]) {
      assert.equal(isPrivateAddress(ip), true, `${ip} must be refused`);
    }
  });

  it('allows an ordinary public address', () => {
    for (const ip of ['93.184.216.34', '1.1.1.1', '164.100.1.1', '2606:4700::1111']) {
      assert.equal(isPrivateAddress(ip), false, `${ip} should be allowed`);
    }
  });

  it('refuses the IPv6 forms that smuggle a v4 address inside a v6 one', () => {
    // The classic bypass: check only the v6 rules and ::ffff:169.254.169.254
    // walks straight through.
    assert.equal(isPrivateAddress('::ffff:169.254.169.254'), true);
    assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true);
    assert.equal(isPrivateAddress('64:ff9b::a00:1'), true);
    assert.equal(isPrivateAddress('2002:a9fe:a9fe::1'), true);
    assert.equal(isPrivateAddress('::1'), true);
    assert.equal(isPrivateAddress('fe80::1'), true);
    assert.equal(isPrivateAddress('fd00::1'), true);
    assert.equal(isPrivateAddress('ff02::1'), true);
  });

  it('fails closed on anything it cannot parse', () => {
    assert.equal(isPrivateAddress('not-an-address'), true);
    assert.equal(isPrivateAddress(''), true);
    assert.equal(isPrivateAddress('999.999.999.999'), true);
  });
});

/* ------------------------------------------------------------- the URL gate */

describe('checkUrl', () => {
  const allowed = new Set(['pib.gov.in', 'thehindu.com']);

  it('admits an allowlisted host that resolves publicly', async () => {
    const verdict = await checkUrl('https://www.pib.gov.in/Page.aspx', allowed, publicLookup);
    assert.equal(verdict.ok, true);
    if (verdict.ok) assert.equal(verdict.domain, 'pib.gov.in');
  });

  it('refuses a lookalike host that merely CONTAINS an allowlisted domain', async () => {
    for (const url of [
      'https://pib.gov.in.evil.test/x',
      'https://notpib.gov.in/x',
      'https://evil.test/?q=pib.gov.in',
      'https://thehindu.com.attacker.test/x',
    ]) {
      const verdict = await checkUrl(url, allowed, publicLookup);
      assert.equal(verdict.ok, false, `${url} must be refused`);
    }
  });

  it('refuses an allowlisted host that resolves to a private address', async () => {
    // The rebind/misconfiguration case. The domain rule passed; the address
    // rule is what stops it.
    const verdict = await checkUrl('https://www.pib.gov.in/x', allowed, async () => ['169.254.169.254']);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.match(verdict.detail, /non-public address/);
  });

  it('refuses a host where only ONE of several addresses is private', async () => {
    const verdict = await checkUrl('https://www.pib.gov.in/x', allowed, async () => [
      '93.184.216.34',
      '10.0.0.5',
    ]);
    assert.equal(verdict.ok, false);
  });

  it('refuses plain http, credentials and non-default ports', async () => {
    for (const url of [
      'http://www.pib.gov.in/x',
      'https://user:pass@www.pib.gov.in/x',
      'https://www.pib.gov.in:8080/x',
    ]) {
      assert.equal((await checkUrl(url, allowed, publicLookup)).ok, false, url);
    }
  });

  it('refuses non-HTTP schemes outright', async () => {
    for (const url of ['file:///etc/passwd', 'gopher://pib.gov.in/', 'ftp://pib.gov.in/x']) {
      assert.equal((await checkUrl(url, allowed, publicLookup)).ok, false, url);
    }
  });

  it('refuses a bare IP even when the operator put one in the allowlist', async () => {
    const withIp = new Set(['169.254.169.254']);
    const verdict = await checkUrl('https://169.254.169.254/latest/meta-data/', withIp, publicLookup);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.match(verdict.detail, /bare IP/);
  });

  it('refuses a host that resolves to nothing', async () => {
    assert.equal((await checkUrl('https://www.pib.gov.in/x', allowed, async () => [])).ok, false);
  });
});

describe('the loopback exception', () => {
  it('is off by default, so 127.0.0.1 is refused', async () => {
    const previous = process.env['CA_SOURCES_FILE'];
    delete process.env['CA_SOURCES_FILE'];
    try {
      assert.equal(loopbackExceptionEnabled(), false);
      const verdict = await checkUrl('http://127.0.0.1:9/x', new Set(['127.0.0.1']), publicLookup);
      assert.equal(verdict.ok, false);
    } finally {
      if (previous !== undefined) process.env['CA_SOURCES_FILE'] = previous;
    }
  });

  it('is NOT enabled by NODE_ENV', async () => {
    // The whole point of the gate. NODE_ENV is ambient, defaults to nothing and
    // is set by tooling that has no idea what it means; a deploy that forgot to
    // set it to `production` would switch this guard off with no other symptom.
    const previousEnv = process.env['NODE_ENV'];
    const previousFile = process.env['CA_SOURCES_FILE'];
    delete process.env['CA_SOURCES_FILE'];
    process.env['NODE_ENV'] = 'test';
    try {
      assert.equal(loopbackExceptionEnabled(), false);
      assert.equal((await checkUrl('http://127.0.0.1:9/x', new Set(['127.0.0.1']), publicLookup)).ok, false);
    } finally {
      if (previousEnv === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previousEnv;
      if (previousFile !== undefined) process.env['CA_SOURCES_FILE'] = previousFile;
    }
  });

  it('admits a literal loopback host once CA_SOURCES_FILE is set', async () => {
    const verdict = await withLoopbackException(() =>
      checkUrl('http://127.0.0.1:39217/feed.xml', new Set(['127.0.0.1']), publicLookup),
    );
    assert.equal(verdict.ok, true);
  });

  it('still refuses a NAME that resolves to loopback, exception or not', async () => {
    // The exception is narrowed to literal loopback hosts on purpose, so it can
    // never be used to rebind an allowlisted publisher inward.
    const verdict = await withLoopbackException(() =>
      checkUrl('https://www.pib.gov.in/x', new Set(['pib.gov.in']), async () => ['127.0.0.1']),
    );
    assert.equal(verdict.ok, false);
  });

  it('still refuses a non-loopback private address under the exception', async () => {
    const verdict = await withLoopbackException(() =>
      checkUrl('http://169.254.169.254/latest/', new Set(['169.254.169.254']), publicLookup),
    );
    assert.equal(verdict.ok, false);
  });
});

/* ---------------------------------------------------------- the fixture server */

interface Recorder {
  concurrent: number;
  peak: number;
  hits: string[];
}

describe('fetchDocuments against a fixture server', () => {
  let server: Server;
  let origin = '';
  let feeds: Feed[] = [];
  const recorder: Recorder = { concurrent: 0, peak: 0, hits: [] };
  const previousSourcesFile = process.env['CA_SOURCES_FILE'];

  before(async () => {
    // The loopback exception, held for this whole suite. Set explicitly, and
    // restored in `after` so no other suite inherits it.
    process.env['CA_SOURCES_FILE'] = TEST_SOURCES;

    const article = await fixture('article.html');
    const paywall = await fixture('paywall.html');
    const rss = await fixture('rss-basic.xml');

    server = createServer((req, res) => {
      const path = req.url ?? '/';
      recorder.hits.push(path);
      recorder.concurrent += 1;
      recorder.peak = Math.max(recorder.peak, recorder.concurrent);

      // Released BEFORE the write, so the gauge measures handlers holding a
      // slot rather than sockets waiting to flush — the write callback fires
      // after the client has already moved on, which reads as a phantom fifth.
      let released = false;
      const done = (): void => {
        if (released) return;
        released = true;
        recorder.concurrent -= 1;
      };
      const send = (status: number, type: string, body: string, headers: Record<string, string> = {}): void => {
        done();
        res.writeHead(status, { 'content-type': type, ...headers });
        res.end(body);
      };

      if (path.startsWith('/article')) {
        setTimeout(() => send(200, 'text/html; charset=utf-8', article), 25);
        return;
      }
      if (path === '/paywall') return send(200, 'text/html; charset=utf-8', paywall);
      if (path === '/feed.xml') return send(200, 'application/rss+xml', rss);
      if (path === '/not-html') return send(200, 'application/pdf', '%PDF-1.4');
      if (path === '/huge-declared') {
        return send(200, 'text/html', 'x'.repeat(64 * 1024), {
          'content-length': String(10 * 1024 * 1024),
        });
      }
      if (path === '/huge-chunked') {
        done();
        res.writeHead(200, { 'content-type': 'text/html' });
        for (let i = 0; i < 40; i += 1) res.write('y'.repeat(16 * 1024));
        res.end();
        return;
      }
      if (path === '/never') {
        // Headers and a first chunk, then silence forever. This is the shape
        // that proves the 8s ceiling covers the BODY and not just the headers.
        done();
        res.writeHead(200, { 'content-type': 'text/html' });
        res.write('<html><body><p>');
        return;
      }
      if (path === '/redirect-local') return send(302, 'text/html', '', { location: '/article-after-redirect' });
      if (path === '/redirect-away') {
        return send(302, 'text/html', '', { location: 'https://www.thehindu.com/news/story' });
      }
      if (path === '/redirect-metadata') {
        return send(302, 'text/html', '', { location: 'http://169.254.169.254/latest/meta-data/' });
      }
      if (path === '/loop') return send(302, 'text/html', '', { location: '/loop' });
      return send(404, 'text/html', 'missing');
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    origin = `http://127.0.0.1:${port}`;
    feeds = parseSourceSet([
      { id: 'fixture', name: 'Fixture Server', url: `${origin}/feed.xml`, kind: 'rss', papers: ['gs2'], trust: 'primary' },
    ]);
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousSourcesFile === undefined) delete process.env['CA_SOURCES_FILE'];
    else process.env['CA_SOURCES_FILE'] = previousSourcesFile;
  });

  const entry = (path: string): Entry => ({
    feedId: 'fixture',
    sourceName: 'Fixture Server',
    url: `${origin}${path}`,
    canonicalUrl: canonicalUrl(`${origin}${path}`),
    title: 'A fixture story',
    publishedAt: null,
    lede: null,
  });

  it('turns a fetched page into a SourceDocument', async () => {
    const { documents, failures } = await fetchDocuments([entry('/article')], { feeds, lookup: publicLookup });
    assert.deepEqual(failures, []);
    const doc = documents[0];
    assert.ok(doc);
    assert.match(doc.text, /A three-judge bench of the Supreme Court/);
    assert.equal(doc.feedId, 'fixture');
    assert.equal(doc.title, 'A fixture story', 'the feed title wins over the page title');
    assert.equal(doc.publishedAt, '2026-03-12T04:00:00.000Z', 'the page JSON-LD supplies the date');
    assert.equal(doc.charCount, doc.text.length);
    assert.match(doc.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('reports a paywall stub as extract_empty rather than fetching a teaser', async () => {
    const { documents, failures } = await fetchDocuments([entry('/paywall')], { feeds, lookup: publicLookup });
    assert.deepEqual(documents, []);
    assert.equal(failures[0]?.reason, 'extract_empty');
  });

  it('refuses a response that is not HTML', async () => {
    const { failures } = await fetchDocuments([entry('/not-html')], { feeds, lookup: publicLookup });
    assert.equal(failures[0]?.reason, 'not_html');
  });

  it('refuses an over-large body on the declared length', async () => {
    const { failures } = await fetchDocuments([entry('/huge-declared')], { feeds, lookup: publicLookup });
    assert.equal(failures[0]?.reason, 'too_large');
  });

  it('refuses an over-large body that declares no length at all', async () => {
    // Content-Length is a claim, not a fact, and a chunked response carries
    // none. The running total in the read loop is the load-bearing check.
    const { failures } = await fetchDocuments([entry('/huge-chunked')], {
      feeds,
      lookup: publicLookup,
      maxBytes: 128 * 1024,
    });
    assert.equal(failures[0]?.reason, 'too_large');
  });

  it('gives up on a response that never arrives', async () => {
    const { failures } = await fetchDocuments([entry('/never')], {
      feeds,
      lookup: publicLookup,
      timeoutMs: 80,
    });
    assert.equal(failures[0]?.reason, 'timeout');
  });

  it('reports an HTTP error as an http_error', async () => {
    const { failures } = await fetchDocuments([entry('/missing')], { feeds, lookup: publicLookup });
    assert.equal(failures[0]?.reason, 'http_error');
  });

  it('follows a redirect that stays on the same domain', async () => {
    const { documents } = await fetchDocuments([entry('/redirect-local')], { feeds, lookup: publicLookup });
    assert.equal(documents.length, 1);
    assert.match(documents[0]?.url ?? '', /article-after-redirect$/);
  });

  it('refuses a redirect that leaves the domain, even to another allowlisted one', async () => {
    const twoFeeds = parseSourceSet([
      { id: 'fixture', name: 'Fixture', url: `${origin}/feed.xml`, kind: 'rss', papers: [], trust: 'primary' },
      { id: 'hindu', name: 'The Hindu', url: 'https://www.thehindu.com/news/national/feeder/default.rss', kind: 'rss', papers: [], trust: 'secondary' },
    ]);
    const { documents, failures } = await fetchDocuments([entry('/redirect-away')], {
      feeds: twoFeeds,
      lookup: publicLookup,
    });
    assert.deepEqual(documents, []);
    assert.equal(failures[0]?.reason, 'blocked');
    assert.match(failures[0]?.detail ?? '', /redirect leaves/);
  });

  it('refuses a redirect to the cloud metadata service', async () => {
    // The reason redirects are followed by hand. With `redirect: "follow"` this
    // request is made by undici before any code here runs.
    const { documents, failures } = await fetchDocuments([entry('/redirect-metadata')], {
      feeds,
      lookup: publicLookup,
    });
    assert.deepEqual(documents, []);
    assert.equal(failures[0]?.reason, 'blocked');
    assert.equal(recorder.hits.includes('/latest/meta-data/'), false);
  });

  it('gives up on a redirect loop instead of following it forever', async () => {
    const { failures } = await fetchDocuments([entry('/loop')], { feeds, lookup: publicLookup });
    assert.equal(failures[0]?.reason, 'http_error');
    assert.match(failures[0]?.detail ?? '', /redirects/);
  });

  it('refuses an entry whose host is not on an allowlisted feed domain', async () => {
    const stray: Entry = { ...entry('/article'), url: 'https://evil.test/article' };
    const { documents, failures } = await fetchDocuments([stray], { feeds, lookup: publicLookup });
    assert.deepEqual(documents, []);
    assert.equal(failures[0]?.reason, 'blocked');
  });

  it('holds concurrency at the bound', async () => {
    recorder.peak = 0;
    const entries = new Array(12).fill(null).map((_, i) => entry(`/article?n=${i}`));
    const { documents } = await fetchDocuments(entries, { feeds, lookup: publicLookup });
    assert.equal(documents.length, 12);
    assert.ok(recorder.peak <= MAX_CONCURRENCY, `peak concurrency was ${recorder.peak}`);
    assert.ok(recorder.peak > 1, 'the pool should actually be concurrent');
  });

  it('reports progress once per entry', async () => {
    const seen: number[] = [];
    const entries = new Array(3).fill(null).map((_, i) => entry(`/article?p=${i}`));
    await fetchDocuments(entries, {
      feeds,
      lookup: publicLookup,
      onProgress: (done) => seen.push(done),
    });
    assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3]);
  });

  it('honours an AbortSignal that is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const before = recorder.hits.length;
    const { documents } = await fetchDocuments([entry('/article')], {
      feeds,
      lookup: publicLookup,
      signal: controller.signal,
    });
    assert.deepEqual(documents, []);
    assert.equal(recorder.hits.length, before, 'no request should have been made');
  });

  it('honours isCancelled without turning every entry into a timeout', async () => {
    const { documents, failures } = await fetchDocuments([entry('/article')], {
      feeds,
      lookup: publicLookup,
      isCancelled: () => true,
    });
    assert.deepEqual(documents, []);
    assert.deepEqual(failures, []);
  });

  it('reads a feed end to end and names the sources it cannot poll', async () => {
    const withIndex = parseSourceSet([
      { id: 'fixture', name: 'Fixture Server', url: `${origin}/feed.xml`, kind: 'rss', papers: [], trust: 'primary' },
      { id: 'sci', name: 'Supreme Court of India', url: 'https://www.sci.gov.in/', kind: 'index', papers: [], trust: 'primary' },
    ]);
    const { entries, failures, unsupported } = await fetchFeedEntries(withIndex, { lookup: publicLookup });
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.sourceName, 'Fixture Server');
    assert.equal(unsupported.length, 1);
    // A source with no parser must not look like a quiet news day.
    assert.equal(failures.some((failure) => failure.feedId === 'sci'), true);
  });

  it('exposes the bounds it enforces', () => {
    assert.equal(FETCH_TIMEOUT_MS, 8_000);
    assert.equal(MAX_RESPONSE_BYTES, 2 * 1024 * 1024);
    assert.equal(MAX_CONCURRENCY, 4);
  });
});
