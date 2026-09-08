/**
 * HTTP-layer tests for POST /ca/digest.
 *
 * The Anthropic client is never reached: both model seams are replaced with
 * stubs, and the ingest seam is replaced with fixture documents, so no API key
 * — real or otherwise — is ever used and no socket is ever opened to a news
 * site.
 *
 * WHY THIS FILE BUILDS ITS OWN EXPRESS APP: `src/app.ts` is frozen for this
 * slice and does not yet mount `/ca`. `makeApp()` below mirrors exactly the two
 * lines that will mount it — `app.use('/ca', requireAuth, caRouter)` behind the
 * same bearer auth, with no global JSON parser — so the router, its auth, its
 * caps and its error handler are all exercised. Once app.ts mounts the route,
 * this can become `const { app } = await import('../src/app.js')`.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import supertest from 'supertest';

const dir = mkdtempSync(join(tmpdir(), 'upsc-ca-'));
process.env.NODE_ENV = 'test';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-real';
process.env.MODEL_EVALUATION ??= 'eval-model-1';
process.env.MODEL_BULK ??= 'bulk-model-1';
process.env.APP_BEARER_TOKEN = 'test-token';
process.env.DAILY_REQUEST_CAP = '200';
process.env.MONTHLY_USD_CAP = '10';
process.env.ESTIMATED_EVAL_USD = '0.2';
process.env.CA_MONTHLY_USD_CAP = '5';
process.env.ESTIMATED_CA_USD_PER_DIGEST = '0.18';
// This suite deliberately squeezes the sub-cap against a small pool to exercise
// the 429 path, which leaves little for evaluation. Saying so explicitly keeps
// config.ts's boot assertion — the guard against a production misconfiguration
// that would starve evaluation — at full strength rather than weakening it to
// accommodate a fixture.
process.env.EVAL_RESERVED_FLOOR_USD = '0';
process.env.USAGE_FILE = join(dir, 'usage.json');

const express = (await import('express')).default;
const { requireAuth } = await import('../src/auth.js');
const { caRouter, setCaIngest, CA_ENDPOINT } = await import('../src/routes/ca.js');
const { evaluateRouter } = await import('../src/routes/evaluate.js');
const { setNotesRunner, setShortlistRunner, ZERO_USAGE } = await import('../src/ca/runner.js');
const { capStatus, releaseReservation, tryReserve } = await import('../src/usage.js');

type ShortlistRunner = NonNullable<Parameters<typeof setShortlistRunner>[0]>;
type NotesRunner = NonNullable<Parameters<typeof setNotesRunner>[0]>;
type Ingest = NonNullable<Parameters<typeof setCaIngest>[0]>;

/** Mirrors src/app.ts's mounting, minus the routes this slice does not own. */
function makeApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use('/ca', requireAuth, caRouter);
  app.use('/evaluate', requireAuth, evaluateRouter);
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  return app;
}

const app = makeApp();
const AUTH = 'Bearer test-token';
const agent = () => supertest(app);

after(() => rmSync(dir, { recursive: true, force: true }));

/** A leaked reservation ratchets the cap down until restart, so check always. */
afterEach(async () => {
  const caps = await capStatus();
  assert.equal(caps.inFlight, 0, 'a spend reservation leaked');
  assert.equal(caps.reservedUsd, 0, 'a dollar reservation leaked');
  setShortlistRunner(null);
  setNotesRunner(null);
  setCaIngest(null);
});

/* ---------------------------------------------------------------- SSE parser */

interface Frame {
  event: string;
  data: string;
}

/** Mirrors app/src/lib/sse.ts, kept as a copy so drift is caught here. */
function parseSse(raw: string): Frame[] {
  const frames: Frame[] = [];
  for (const block of raw.split('\n\n')) {
    if (block === '') continue;
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') dataLines.push(value);
    }
    if (dataLines.length > 0) frames.push({ event, data: dataLines.join('\n') });
  }
  return frames;
}

/* --------------------------------------------------------------- the fixture */

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
] as const;

function subject(n: number): string {
  return SUBJECTS[(n - 1) % SUBJECTS.length] as string;
}

function quoteFor(n: number): string {
  return `The Union Cabinet approved a revision of ${subject(n)}, raising the threshold from ${10 + n} to ${40 + n} units.`;
}

function docText(n: number): string {
  return [
    `A background paragraph about ${subject(n)} carrying no figures.`,
    quoteFor(n),
    'Officials said consultations with the states had been completed beforehand.',
  ].join('\n');
}

interface StubOptions {
  entryCount?: number;
  delayMs?: number;
  failWith?: string;
  /** Fabricate a quote for the first item, to prove the drop path over HTTP. */
  fabricateFirst?: boolean;
  onFetch?: () => void;
  onNotes?: () => void | Promise<void>;
}

function stubEverything(options: StubOptions = {}): { notesCalls: () => number } {
  const entryCount = options.entryCount ?? 10;
  let notesCalls = 0;

  const entry = (n: number) => ({
    feedId: 'feed-a',
    sourceName: 'Example Daily',
    url: `https://example.test/story-${n}`,
    canonicalUrl: `https://example.test/story-${n}`,
    title: `Cabinet revises ${subject(n)}`,
    publishedAt: '2026-09-06T04:00:00.000Z',
    lede: `A lede about ${subject(n)}.`,
  });

  const ingest: Ingest = {
    collectEntries: async () => ({
      entries: Array.from({ length: entryCount }, (_, i) => entry(i + 1)),
      failures: [
        { url: 'https://dead.test/rss', feedId: 'dead', reason: 'http_error', detail: 'HTTP 404' },
      ],
      feedCount: 3,
    }),
    fetchDocuments: async (entries, opts) => {
      options.onFetch?.();
      const documents = [];
      let done = 0;
      for (const e of entries) {
        if (opts.isCancelled()) break;
        if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
        const n = Number(/story-(\d+)$/.exec(e.url)?.[1] ?? 1);
        documents.push({
          url: e.url,
          canonicalUrl: e.canonicalUrl,
          sourceName: 'Example Daily',
          feedId: 'feed-a',
          title: e.title,
          publishedAt: e.publishedAt,
          text: docText(n),
          charCount: docText(n).length,
          fetchedAt: '2026-09-06T05:00:00.000Z',
        });
        done += 1;
        opts.onProgress(done, entries.length);
      }
      return { documents, failures: [] };
    },
  };

  const shortlist: ShortlistRunner = async (request) => {
    if (options.failWith) throw new Error(options.failWith);
    if (request.signal.aborted) throw new Error('aborted');
    return {
      picks: request.candidates.slice(0, request.take).map((c, i) => ({
        candidateIndex: c.index,
        kind: 'structural' as const,
        syllabusSlugs: ['gs2/polity'],
        sectionKeys: [`section-${i + 1}`],
        why: 'a rule changed',
      })),
      stopReason: 'end_turn',
      usage: { ...ZERO_USAGE, inputTokens: 800, outputTokens: 240, cacheCreationInputTokens: 900 },
      provenance: 'model',
    };
  };

  const notes: NotesRunner = async (request) => {
    notesCalls += 1;
    await options.onNotes?.();
    if (request.signal.aborted) throw new Error('aborted');
    return {
      drafts: request.documents.map((d, i) => {
        const n = Number(/story-(\d+)$/.exec(d.url)?.[1] ?? 1);
        return {
          url: d.url,
          headline: `Cabinet revises ${subject(n)}`,
          kind: 'structural' as const,
          noteMd: quoteFor(n),
          sentenceEvidence: [0],
          evidence: [
            {
              quote:
                options.fabricateFirst && i === 0
                  ? 'The Ministry sanctioned a further 900 crore for the same purpose.'
                  : quoteFor(n),
              at: -1,
            },
          ],
          sectionKeys: [`section-${i + 1}`],
          syllabusSlugs: ['gs2/polity'],
          anthro: null,
        };
      }),
      stopReason: 'end_turn',
      usage: { ...ZERO_USAGE, inputTokens: 3600, outputTokens: 1200, cacheReadInputTokens: 900 },
      provenance: 'model',
    };
  };

  setCaIngest(ingest);
  setShortlistRunner(shortlist);
  setNotesRunner(notes);
  return { notesCalls: () => notesCalls };
}

/**
 * The body the APP actually sends.
 *
 * Shape-for-shape `CaDigestRequest` in `app/src/lib/ca-api.ts`, which is
 * `JSON.stringify`d verbatim onto the wire. That is the point of this fixture:
 * it once described a `{syllabusSlugs, sections}` body no client ever sent, so
 * every test here passed against a server that 400'd every real request.
 * `app/tests/ca-request-contract.test.ts` holds the other half.
 */
function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 'req-ca-http-1',
    resume: false,
    date: '2026-09-07',
    timezone: 'Asia/Kolkata',
    maxItems: 6,
    vocabulary: [
      { slug: 'polity', label: 'Indian Constitution and Polity', paper: 'gs2', level: 'section' },
      { slug: 'economy', label: 'Indian Economy', paper: 'gs3', level: 'section' },
      { slug: 'environment', label: 'Environment and Ecology', paper: 'gs3', level: 'section' },
      { slug: 'society', label: 'Indian Society', paper: 'gs1', level: 'section' },
      { slug: 'gs2/polity', label: 'Separation of powers', paper: 'gs2', level: 'leaf' },
      { slug: 'gs3/economy', label: 'Government budgeting', paper: 'gs3', level: 'leaf' },
    ],
    seenCanonicalUrls: [],
    seenFingerprints: [],
    sectionCountsThisWeek: {},
    promptVersion: 'ca-digest-v1',
    ...overrides,
  };
}

function post(body: Record<string, unknown>) {
  return agent().post('/ca/digest').set('Authorization', AUTH).send(body);
}

/* --------------------------------------------------------------------- tests */

describe('POST /ca/digest auth', () => {
  it('rejects with no token', async () => {
    const res = await agent().post('/ca/digest').send(validBody()).expect(401);
    assert.deepEqual(res.body, { error: 'unauthorized' });
  });

  it('rejects a wrong token', async () => {
    await agent()
      .post('/ca/digest')
      .set('Authorization', 'Bearer wrong-token-entirely')
      .send(validBody())
      .expect(401);
  });

  it('rejects a token of the same length as the real one', async () => {
    await agent()
      .post('/ca/digest')
      .set('Authorization', `Bearer ${'x'.repeat('test-token'.length)}`)
      .send(validBody())
      .expect(401);
  });

  it('rejects a non-bearer scheme', async () => {
    await agent()
      .post('/ca/digest')
      .set('Authorization', 'Basic test-token')
      .send(validBody())
      .expect(401);
  });
});

describe('POST /ca/digest body validation', () => {
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ['a missing requestId', { requestId: undefined }, /requestId is required/],
    ['a missing date', { date: undefined }, /date is required as YYYY-MM-DD/],
    ['a malformed date', { date: '07-09-2026' }, /YYYY-MM-DD/],
    ['an empty vocabulary', { vocabulary: [] }, /at least one entry/],
    ['a non-array vocabulary', { vocabulary: 'gs2' }, /must be an array/],
    ['a bare-string vocabulary entry', { vocabulary: ['gs2'] }, /must be objects with a slug/],
    ['a slugless vocabulary entry', { vocabulary: [{ label: 'Polity' }] }, /string slug/],
    ['maxItems below the floor', { maxItems: 0 }, /between 1 and 8/],
    ['maxItems above the day ceiling', { maxItems: 9 }, /between 1 and 8/],
    ['a fractional maxItems', { maxItems: 4.5 }, /must be an integer/],
    ['a non-boolean linkAnthropology', { linkAnthropology: 'yes' }, /must be a boolean/],
    [
      'a section-count array where an object was meant',
      { sectionCountsThisWeek: ['polity'] },
      /object of section -> count/,
    ],
    [
      'a negative section count',
      { sectionCountsThisWeek: { polity: -1 } },
      /non-negative numbers/,
    ],
  ];

  for (const [label, override, pattern] of cases) {
    it(`rejects ${label}`, async () => {
      const body = validBody(override);
      for (const [key, value] of Object.entries(override)) {
        if (value === undefined) delete body[key];
      }
      const res = await post(body).expect(400);
      assert.equal(res.body.error, 'bad_request');
      assert.match(res.body.detail, pattern);
    });
  }

  it('refuses an empty vocabulary rather than paying for a guaranteed empty digest', async () => {
    // Two model calls to deliver nothing is money for nothing: every item is
    // dropped by the syllabus filter before it can earn a slot.
    let called = false;
    stubEverything({ onNotes: () => { called = true; } });
    await post(validBody({ vocabulary: [] })).expect(400);
    assert.equal(called, false, 'no model call may be made on an invalid body');
  });

  it('rejects a malformed JSON body with 400, not 500', async () => {
    const res = await agent()
      .post('/ca/digest')
      .set('Authorization', AUTH)
      .set('Content-Type', 'application/json')
      .send('{"requestId": ')
      .expect(400);
    assert.equal(res.body.error, 'bad_request');
  });

  it('rejects a body over 256kb with 413', async () => {
    const res = await agent()
      .post('/ca/digest')
      .set('Authorization', AUTH)
      .send(
        validBody({
          seenCanonicalUrls: Array.from({ length: 300 }, () => `https://x.test/${'p'.repeat(1000)}`),
        }),
      )
      .expect(413);
    assert.equal(res.body.error, 'payload_too_large');
  });

  it('defaults maxItems to six and anthropology linking to on', async () => {
    stubEverything();
    const body = validBody();
    delete body.maxItems;
    const res = await post(body).expect(200);
    const meta = JSON.parse(parseSse(res.text)[0]!.data);
    assert.equal(meta.maxItems, 6);
    assert.equal(meta.linkAnthropology, true);
  });
});

describe('POST /ca/digest spend cap', () => {
  it('returns 429 once the shared pool is exhausted', async () => {
    const held: { endpoint: string; estimateUsd: number; units: number }[] = [];
    try {
      for (let i = 0; i < 100; i += 1) {
        const reservation = { endpoint: '/evaluate', estimateUsd: 0.2, units: 1 };
        const admitted = await tryReserve(reservation);
        if (!admitted.ok) break;
        held.push(reservation);
      }
      assert.equal((await capStatus()).allowed, false);

      const res = await post(validBody()).expect(429);
      assert.equal(res.body.error, 'spend_cap_reached');
      assert.equal(res.body.caps.allowed, false);
    } finally {
      for (const reservation of held) releaseReservation(reservation);
    }
  });

  it('refuses the digest on its own sub-cap while leaving evaluation admissible', async () => {
    // The entire reason the sub-cap exists: a digest loop must never block
    // answer evaluation, which is the higher-value feature.
    const hold = { endpoint: CA_ENDPOINT, estimateUsd: 5, units: 1 };
    const admitted = await tryReserve(hold);
    assert.equal(admitted.ok, true);
    try {
      const res = await post(validBody()).expect(429);
      assert.match(res.body.detail, /Current-affairs spend cap reached/);
      assert.match(res.body.detail, /Answer evaluation is unaffected/);

      const evaluation = await capStatus({ endpoint: '/evaluate' });
      assert.equal(evaluation.allowed, true, 'evaluation must still be admissible');

      // And end to end: /evaluate must not answer 429 while /ca does.
      const probe = await agent().post('/evaluate').set('Authorization', AUTH).send({});
      assert.notEqual(probe.status, 429, '/evaluate was blocked by the CA sub-cap');
    } finally {
      releaseReservation(hold);
    }
  });

  it('holds two units and one digest estimate while the run is in flight', async () => {
    // A digest is two model calls however many articles it fetches, so it
    // counts as two against the daily ceiling. Counting the whole run as one
    // would let a retry loop make twice the calls the cap was set for.
    let during: Awaited<ReturnType<typeof capStatus>> | null = null;
    stubEverything({
      onNotes: async () => {
        during = await capStatus();
      },
    });
    await post(validBody()).expect(200);

    const seen = during as Awaited<ReturnType<typeof capStatus>> | null;
    assert.equal(seen?.inFlight, 2, 'two model calls means two units');
    assert.ok(Math.abs((seen?.reservedUsd ?? 0) - 0.18) < 1e-9, 'one digest estimate is held');

    const after = await capStatus();
    assert.equal(after.inFlight, 0, 'the units must be released');
    assert.equal(after.reservedUsd, 0, 'the dollar hold must be released');
    assert.ok(after.caMonthUsd > 0, 'both calls should have reached the ledger');
  });
});

describe('POST /ca/digest SSE stream', () => {
  it('frames events in the required order, byte-compatibly with the client', async () => {
    stubEverything();
    const res = await post(validBody()).expect(200);

    assert.equal(res.headers['content-type'], 'text/event-stream');
    assert.equal(res.headers['cache-control'], 'no-cache, no-transform');
    assert.equal(res.headers['x-accel-buffering'], 'no');
    assert.match(res.text, /^event: meta\ndata: \{"requestId":/);
    assert.equal(res.text.includes('\r'), false, 'frames must use bare LF');

    const frames = parseSse(res.text);
    const order = frames.map((f) => f.event);

    assert.equal(order[0], 'meta');
    assert.equal(order.at(-1), 'done');
    assert.equal(order.at(-2), 'usage');
    assert.equal(order.at(-3), 'summary');

    // meta, then every progress frame, then every item frame, then the tail.
    const firstItem = order.indexOf('item');
    assert.ok(firstItem > 1, 'progress frames must precede the first item');
    assert.equal(
      order.slice(1, firstItem).every((e) => e === 'progress'),
      true,
      'only progress frames may sit between meta and the first item',
    );
    assert.equal(
      order.slice(firstItem, -3).every((e) => e === 'item'),
      true,
      'no progress frame may follow an item',
    );

    const meta = JSON.parse(frames[0]!.data);
    assert.equal(meta.date, '2026-09-07');
    assert.equal(meta.maxItems, 6);
    assert.match(meta.promptVersion, /^[0-9a-f]{12}$/);
    assert.match(meta.sourceSetVersion, /^[0-9a-f]{12}$/);

    const progress = frames.filter((f) => f.event === 'progress').map((f) => JSON.parse(f.data));
    assert.ok(progress.length >= 5, `only ${progress.length} progress frames`);
    assert.ok(progress.some((p) => p.phase === 'fetch'), 'the slow phase must report');
    for (const frame of progress) {
      assert.equal(typeof frame.detail, 'string');
      assert.ok(frame.total >= frame.done);
    }

    const item = JSON.parse(frames.find((f) => f.event === 'item')!.data);
    assert.equal(item.sourceName, 'Example Daily');
    assert.ok(item.evidence.length > 0);
    assert.ok(item.evidence[0].at >= 0, 'every offset must be resolved before the wire');
    assert.deepEqual(item.syllabusSlugs, ['gs2/polity']);
    assert.equal(typeof item.headlineFingerprint, 'string');
    assert.notEqual(item.headlineFingerprint, '');

    const summary = JSON.parse(frames.find((f) => f.event === 'summary')!.data);
    assert.equal(summary.considered, 10);
    assert.ok(summary.kept > 0);
    assert.equal(summary.kept, frames.filter((f) => f.event === 'item').length);
    assert.equal(summary.sourceFailures.length, 1, 'a 404 feed must stay visible');
    assert.equal(typeof summary.anthroLinkRate, 'number');

    const usage = JSON.parse(frames.find((f) => f.event === 'usage')!.data);
    assert.equal(usage.inputTokens, 4400);
    assert.equal(usage.outputTokens, 1440);
    assert.equal(usage.cacheCreationInputTokens, 900, 'cache writes must not be dropped');
    assert.equal(usage.cacheReadInputTokens, 900, 'cache reads must not be dropped');
    assert.equal(typeof usage.caMonthUsd, 'number');

    assert.deepEqual(JSON.parse(frames.at(-1)!.data), { ok: true, provenance: 'model' });
  });

  it('never emits more items than asked for', async () => {
    stubEverything({ entryCount: 12 });
    const res = await post(validBody({ maxItems: 3 })).expect(200);
    const frames = parseSse(res.text);
    assert.equal(frames.filter((f) => f.event === 'item').length, 3);
  });

  it('drops an ungrounded item over the wire and says so in the summary', async () => {
    // The property the whole phase rests on, exercised end to end: a quote the
    // page does not contain never reaches the device.
    stubEverything({ fabricateFirst: true });
    const res = await post(validBody()).expect(200);
    const frames = parseSse(res.text);

    const summary = JSON.parse(frames.find((f) => f.event === 'summary')!.data);
    assert.equal(summary.dropReasons.ungrounded_quote, 1);
    assert.equal(res.text.includes('900 crore'), false, 'a fabricated quote reached the wire');
    assert.equal(frames.at(-1)?.event, 'done', 'a drop is not an error');
  });

  it('terminates cleanly with zero items when the day is quiet', async () => {
    // Under-delivery is a correct outcome, not an error path.
    stubEverything({ entryCount: 0 });
    const res = await post(validBody()).expect(200);
    const frames = parseSse(res.text);

    assert.equal(frames.filter((f) => f.event === 'item').length, 0);
    const summary = JSON.parse(frames.find((f) => f.event === 'summary')!.data);
    assert.equal(summary.kept, 0);
    assert.equal(summary.underDelivered, true);
    assert.equal(frames.at(-1)?.event, 'done');
  });

  it('ends with a generic terminal error frame that never leaks err.message', async () => {
    stubEverything({ failWith: 'connect ECONNREFUSED 10.0.0.1:443' });
    const res = await post(validBody()).expect(200);

    const frames = parseSse(res.text);
    assert.equal(frames.at(-1)?.event, 'error');
    assert.deepEqual(JSON.parse(frames.at(-1)!.data), {
      message: 'Digest generation failed. Check the server logs.',
    });
    assert.equal(res.text.includes('ECONNREFUSED'), false, 'internal detail must not be echoed');
    assert.equal(
      frames.some((f) => f.event === 'done'),
      false,
      'error is terminal and replaces done',
    );
  });
});

/* ------------------------------------------ raw-socket cases supertest cannot do */

async function withServer<T>(fn: (port: number) => Promise<T>): Promise<T> {
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  try {
    return await fn(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('POST /ca/digest disconnect', () => {
  it('stops before the notes call and releases the reservation when the client leaves', async () => {
    // Aborting the in-flight call is only half the job. The fetch phase is
    // twenty to sixty seconds long, and a client leaving during it must not
    // still pay for the expensive second call it will never receive.
    const stubs = stubEverything({ delayMs: 40 });

    const body = JSON.stringify(validBody({ requestId: 'req-ca-disconnect', maxItems: 8 }));

    await withServer(
      (port) =>
        new Promise<void>((resolve) => {
          const req = httpRequest(
            {
              port,
              path: '/ca/digest',
              method: 'POST',
              headers: {
                authorization: AUTH,
                'content-type': 'application/json',
                'content-length': String(Buffer.byteLength(body)),
              },
            },
            (res) => {
              res.once('data', () => {
                // Walk away during the fetch phase.
                setTimeout(() => req.destroy(), 60);
              });
              res.on('error', () => undefined);
            },
          );
          req.on('error', () => undefined);
          req.end(body);
          // Long enough that the whole run would otherwise have finished.
          setTimeout(resolve, 900);
        }),
    );

    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(stubs.notesCalls(), 0, 'the expensive second call ran after a disconnect');
    assert.equal((await capStatus()).inFlight, 0, 'the reservation must be released');
    assert.equal((await capStatus()).reservedUsd, 0, 'the dollar hold must be released');
  });
});
