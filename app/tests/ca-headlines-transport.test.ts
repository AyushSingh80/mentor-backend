/**
 * The headlines transport's replay logic.
 *
 * `ca-digest.ts` must not be able to tell the two transports apart — it owns
 * the mapper, the duplicate window and the per-item write, and every one of
 * those is transport-independent. What is tested here is the part that could
 * silently break that: what the replay claims in its summary, and what it
 * refuses to claim.
 *
 * The fetch itself is not tested and cannot be: `ca-api.ts` imports
 * `expo/fetch`, so it does not load under Node. That is why the interesting
 * half lives in `ca-headlines-map.ts` instead.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  headlineItems,
  headlineSourceFailures,
  headlineSummary,
} from '../src/lib/ca-headlines-map';

function item(headline: string) {
  return {
    headline,
    sourceUrl: `https://example.test/${encodeURIComponent(headline)}`,
    sourceName: 'The Hindu',
    kind: 'report',
    noteMd: 'A standfirst written by the publisher.',
    evidence: [{ quote: 'A standfirst written by the publisher.' }],
    syllabusTags: [],
  };
}

describe('headlineItems', () => {
  it('preserves the server ranking exactly', () => {
    // Order is not cosmetic: the duplicate check for item 3 must have seen
    // items 1 and 2, and the day's cap takes from the front.
    const body = { items: [item('A'), item('B'), item('C')] };
    assert.deepEqual(
      headlineItems(body).map((entry) => (entry as { headline: string }).headline),
      ['A', 'B', 'C'],
    );
  });

  it('treats a malformed body as an empty sweep rather than throwing', () => {
    // A throw here would reach `ca-digest.ts`, which holds a never-rejects
    // contract, as a transport failure — reporting "the network did not
    // happen" for a response that did.
    assert.deepEqual(headlineItems(null), []);
    assert.deepEqual(headlineItems({ items: 'not an array' }), []);
    assert.deepEqual(headlineItems([]), []);
  });
});

describe('headlineSummary', () => {
  it('reports kept and dropped against what was considered', () => {
    const summary = headlineSummary({ items: [item('A'), item('B')], considered: 40 }, 6);

    assert.equal(summary.considered, 40);
    assert.equal(summary.kept, 2);
    assert.equal(summary.dropped, 38);
  });

  it('claims no shortlist stage that did not run', () => {
    // Every swept entry was scored; there is no separate narrowing call. A
    // smaller `shortlisted` would draw a funnel on screen describing a pipeline
    // that does not exist in this mode.
    const summary = headlineSummary({ items: [item('A')], considered: 30 }, 6);
    assert.equal(summary.shortlisted, summary.considered);
  });

  it('reports no drop reasons', () => {
    // The server's drops here are about ranking — stale, over source cap — not
    // quality. Rendered beside the digest's quality reasons they would read as
    // "fifty items failed a check", which is false and discouraging.
    const summary = headlineSummary(
      { items: [item('A')], considered: 50, drops: [{ reason: 'over_source_cap' }] },
      6,
    );
    assert.deepEqual(summary.dropReasons, {});
  });

  it('reports a zero Anthropology link rate', () => {
    // Zero because no model claimed a link, not because claims were rejected.
    // Truthful either way, and it keeps `anthroLinkRateIsSuspicious` from
    // flagging a prompt that is not running.
    assert.equal(headlineSummary({ items: [item('A')] }, 6).anthroLinkRate, 0);
  });

  it('marks under-delivery, and does not mark a full digest', () => {
    assert.equal(headlineSummary({ items: [item('A')] }, 6).underDelivered, true);
    assert.equal(
      headlineSummary({ items: [item('A'), item('B')] }, 2).underDelivered,
      false,
    );
  });

  it('never reports negative drops when the server undercounts', () => {
    // `considered` is the server's number and the items are the server's too,
    // but a future change to either could disagree. A negative "dropped" would
    // render as nonsense on the summary card.
    const summary = headlineSummary({ items: [item('A'), item('B')], considered: 1 }, 6);
    assert.equal(summary.dropped, 0);
  });

  it('falls back to the item count when the server sends no considered total', () => {
    const summary = headlineSummary({ items: [item('A'), item('B')] }, 6);
    assert.equal(summary.considered, 2);
    assert.equal(summary.dropped, 0);
  });
});

describe('headlineSourceFailures', () => {
  it('carries a failed source through so it cannot read as a quiet news day', () => {
    // Three sources in `sources.json` are HTML index pages with no feed and
    // always fail. Swallowing them would present a half-broken sweep as a
    // complete one.
    const failures = headlineSourceFailures({
      sourceFailures: [
        {
          url: 'https://www.sci.gov.in/',
          feedId: 'sci_judgments',
          reason: 'extract_empty',
          detail: 'no feed at this path',
        },
      ],
    });

    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.feedId, 'sci_judgments');
    assert.equal(failures[0]?.reason, 'extract_empty');
  });

  it('fills a missing reason rather than rendering an empty label', () => {
    const failures = headlineSourceFailures({ sourceFailures: [{ url: 'https://x.test' }] });
    assert.equal(failures[0]?.reason, 'unknown');
    assert.equal(failures[0]?.feedId, null);
  });

  it('returns nothing for a body carrying no failures', () => {
    assert.deepEqual(headlineSourceFailures({ items: [] }), []);
    assert.deepEqual(headlineSourceFailures(null), []);
  });
});

describe('the age window', () => {
  // These pin the rule the user's bug report exposed: the sweep looks back a
  // week, so an item can legitimately be older than the digest that carries it,
  // and the DISPLAY has to say so. The mapping half is asserted here; the card
  // renders `publishedAt`, never `date`.
  it('keeps the publication date distinct from the digest day', () => {
    // Reported against a 2 September editorial that the 8 September digest
    // showed as "The Hindu — Editorial · 2026-09-08". The data was right the
    // whole time — `published_at` held 2026-09-02 — and the card printed the
    // wrong one of the two fields.
    const body = {
      items: [
        {
          ...item('Endurance test: On the Indian economy’s resilience'),
          publishedAt: '2026-09-02T03:57:31.000Z',
        },
      ],
    };
    const delivered = headlineItems(body)[0] as { publishedAt: string };
    assert.equal(
      delivered.publishedAt.slice(0, 10),
      '2026-09-02',
      'the transport must carry the publisher’s date through untouched',
    );
  });

  it('carries a null publication date rather than substituting the digest day', () => {
    // Several feeds ship no date. Substituting the digest day here would make
    // an undated item indistinguishable from one published today — the same
    // conflation, moved one layer earlier where nothing could catch it.
    const body = { items: [{ ...item('Undated release'), publishedAt: null }] };
    const delivered = headlineItems(body)[0] as { publishedAt: string | null };
    assert.equal(delivered.publishedAt, null);
  });
});
