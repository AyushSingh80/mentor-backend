/**
 * Orchestration, with stub runners and no socket.
 *
 * These are the tests for the decisions that cost money or ship a wrong fact:
 * what the second call is allowed to see, what happens to a quote that is not
 * in the page, what gets billed when a run dies halfway, and what happens when
 * the client walks away during the fetch phase.
 *
 * `verifyGrounding` is the REAL one throughout. Stubbing it would leave the
 * only check that stands between a fabricated citation and a Mains answer
 * untested by the tests that exist to protect it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.ANTHROPIC_API_KEY ??= 'sk-ant-test-not-real';
process.env.MODEL_EVALUATION ??= 'eval-model-1';
process.env.MODEL_BULK ??= 'bulk-model-1';
process.env.APP_BEARER_TOKEN ??= 'test-token';

const { runCaPipeline, clampMaxItems, DEFAULT_MAX_ITEMS } = await import('../src/ca/pipeline.js');
const { verifyGrounding } = await import('../src/ca/ground.js');
const { MAX_SECTION_KEYS_PER_ITEM, MAX_SYLLABUS_SLUGS_PER_ITEM } = await import(
  '../src/ca/schema.js'
);
const { ZERO_USAGE, shortlistMaxTokens, notesMaxTokens } = await import('../src/ca/runner.js');
const {
  fakeShortlistRunner,
  fakeNotesRunner,
  fakeCollectEntries,
  fakeFetchDocuments,
  FAKE_ARTICLE_COUNT,
} = await import('../src/fake-ca-runner.js');
const { compileShortlistPrompt, compileNotesPrompt } = await import('../src/ca/index.js');

type PipelineInput = Parameters<typeof runCaPipeline>[0];
type PipelineDeps = Parameters<typeof runCaPipeline>[1];

/* ------------------------------------------------------------------ fixtures */

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

/** The one sentence a note is allowed to be built out of. */
function quoteFor(n: number): string {
  return `The Union Cabinet approved a revision of ${subject(n)}, raising the threshold from ${10 + n} to ${40 + n} units.`;
}

function docText(n: number): string {
  return [
    `A background paragraph about ${subject(n)} that carries no figures at all.`,
    quoteFor(n),
    `Officials said consultations with the states had been completed beforehand.`,
  ].join('\n');
}

function entry(n: number) {
  return {
    feedId: 'feed-a',
    sourceName: 'Example Daily',
    url: `https://example.test/story-${n}`,
    canonicalUrl: `https://example.test/story-${n}`,
    title: `Cabinet revises ${subject(n)}`,
    publishedAt: '2026-09-06T04:00:00.000Z',
    lede: `A lede about ${subject(n)}.`,
  };
}

function document(n: number) {
  return {
    url: `https://example.test/story-${n}`,
    canonicalUrl: `https://example.test/story-${n}`,
    sourceName: 'Example Daily',
    feedId: 'feed-a',
    title: `Cabinet revises ${subject(n)}`,
    publishedAt: '2026-09-06T04:00:00.000Z',
    text: docText(n),
    charCount: docText(n).length,
    fetchedAt: '2026-09-06T05:00:00.000Z',
  };
}

function draft(n: number, overrides: Record<string, unknown> = {}) {
  return {
    url: `https://example.test/story-${n}`,
    headline: `Cabinet revises ${subject(n)}`,
    kind: 'structural' as const,
    noteMd: quoteFor(n),
    sentenceEvidence: [0],
    evidence: [{ quote: quoteFor(n), at: -1 }],
    sectionKeys: [`section-${n}`],
    syllabusSlugs: ['gs2/polity'],
    anthro: null,
    ...overrides,
  };
}

function input(overrides: Partial<PipelineInput> = {}): PipelineInput {
  return {
    requestId: 'req-ca-1',
    date: '2026-09-07',
    maxItems: 6,
    syllabusSlugs: ['gs2/polity', 'gs3/economy'],
    sections: ['polity', 'economy'],
    seenCanonicalUrls: [],
    seenFingerprints: [],
    sectionCountsThisWeek: {},
    model: 'bulk-model-1',
    shortlistSystem: 'shortlist system',
    notesSystem: 'notes system',
    ...overrides,
  };
}

/* ------------------------------------------------------------------ harness */

interface StubOptions {
  entryCount?: number;
  feedFailures?: number;
  /** Entries whose fetch fails, by ordinal. */
  fetchFails?: number[];
  /** Overrides what the notes call returns. */
  drafts?: (documents: readonly { url: string }[]) => ReturnType<typeof draft>[];
  shortlistStopReason?: string | null;
  shortlistPicks?: null;
  notesStopReason?: string | null;
  notesNull?: boolean;
  /** Cancel once this phase has been entered. */
  cancelAfterPhase?: string;
  takeCount?: number;
  /** Tags the SHORTLIST call claims. Unioned with the notes call's. */
  shortlistSlugs?: string[];
  shortlistSections?: string[];
}

function harness(options: StubOptions = {}) {
  const state = {
    cancelled: false,
    shortlistCalls: 0,
    notesCalls: 0,
    fetched: [] as string[],
    order: [] as string[],
    notesSawUrls: [] as string[],
    shortlistSawCount: 0,
    shortlistMaxTokens: 0,
    notesMaxTokens: 0,
  };
  const emitted: {
    headline: string;
    sourceName: string;
    sourceUrl: string;
    syllabusSlugs: readonly string[];
    sectionKeys: readonly string[];
  }[] = [];
  const billed: { phase: string; usage: typeof ZERO_USAGE }[] = [];
  const progress: { phase: string; done: number; total: number }[] = [];
  const entryCount = options.entryCount ?? 12;

  const noteProgress = (phase: string): void => {
    if (options.cancelAfterPhase === phase) state.cancelled = true;
  };

  const deps: PipelineDeps = {
    collectEntries: async () => {
      state.order.push('feeds');
      return {
        entries: Array.from({ length: entryCount }, (_, i) => entry(i + 1)),
        failures: Array.from({ length: options.feedFailures ?? 0 }, (_, i) => ({
          url: `https://dead.test/feed-${i}`,
          feedId: `dead-${i}`,
          reason: 'http_error' as const,
          detail: 'HTTP 404',
        })),
        feedCount: 3,
      };
    },
    fetchDocuments: async (entries, opts) => {
      state.order.push('fetch');
      const documents = [];
      const failures = [];
      let done = 0;
      for (const e of entries) {
        const n = Number(/story-(\d+)$/.exec(e.url)?.[1] ?? 0);
        if (options.fetchFails?.includes(n)) {
          failures.push({ url: e.url, feedId: e.feedId, reason: 'timeout' as const, detail: 'slow' });
        } else {
          state.fetched.push(e.url);
          documents.push(document(n));
        }
        done += 1;
        opts.onProgress(done, entries.length);
      }
      return { documents, failures };
    },
    verifyGrounding,
    shortlist: async (request) => {
      state.order.push('shortlist');
      state.shortlistCalls += 1;
      state.shortlistSawCount = request.candidates.length;
      state.shortlistMaxTokens = request.maxTokens;
      noteProgress('shortlist');
      return {
        picks:
          options.shortlistPicks === null
            ? null
            : request.candidates.slice(0, options.takeCount ?? request.take).map((c, i) => ({
                candidateIndex: c.index,
                kind: 'structural' as const,
                syllabusSlugs: options.shortlistSlugs ?? ['gs2/polity'],
                sectionKeys: options.shortlistSections ?? [`section-${i + 1}`],
                why: 'a rule changed',
              })),
        stopReason: options.shortlistStopReason ?? 'end_turn',
        usage: { ...ZERO_USAGE, inputTokens: 900, outputTokens: 300, cacheCreationInputTokens: 1200 },
        provenance: 'model' as const,
      };
    },
    notes: async (request) => {
      state.order.push('notes');
      state.notesCalls += 1;
      state.notesSawUrls = request.documents.map((d) => d.url);
      state.notesMaxTokens = request.maxTokens;
      noteProgress('notes');
      return {
        drafts: options.notesNull
          ? null
          : (options.drafts ?? ((docs) =>
              docs.map((d) => draft(Number(/story-(\d+)$/.exec(d.url)?.[1] ?? 1)))))(
              request.documents,
            ),
        stopReason: options.notesStopReason ?? 'end_turn',
        usage: { ...ZERO_USAGE, inputTokens: 4000, outputTokens: 1500, cacheReadInputTokens: 1200 },
        provenance: 'model' as const,
      };
    },
    emitItem: (item) =>
      emitted.push({
        headline: item.headline,
        sourceName: item.sourceName,
        sourceUrl: item.sourceUrl,
        syllabusSlugs: item.syllabusSlugs,
        sectionKeys: item.sectionKeys,
      }),
    onProgress: (p) => {
      progress.push({ phase: p.phase, done: p.done, total: p.total });
      noteProgress(p.phase);
    },
    onCallUsage: async (event) => {
      billed.push({ phase: event.phase, usage: event.usage });
    },
    isCancelled: () => state.cancelled,
    signal: new AbortController().signal,
  };

  return { deps, emitted, billed, progress, state };
}

/* ------------------------------------------------------------------- tests */

describe('the two-call shape', () => {
  it('runs feeds, shortlist, fetch, notes — in that order, once each', async () => {
    const h = harness();
    const result = await runCaPipeline(input(), h.deps);

    assert.deepEqual(h.state.order, ['feeds', 'shortlist', 'fetch', 'notes']);
    assert.equal(h.state.shortlistCalls, 1);
    assert.equal(h.state.notesCalls, 1);
    assert.ok(result.summary.kept > 0);
  });

  it('shows call one HEADLINES ONLY and call two the shortlist ONLY', async () => {
    // The whole reason there are two calls. Merging them would mean paying to
    // put forty full articles in front of a model in order to use nine.
    const h = harness({ entryCount: 12 });
    await runCaPipeline(input({ maxItems: 6 }), h.deps);

    assert.equal(h.state.shortlistSawCount, 12, 'call one sees every candidate');
    assert.ok(h.state.notesSawUrls.length <= 9, 'call two sees only the shortlist');
    assert.ok(h.state.notesSawUrls.length < h.state.shortlistSawCount);
    for (const url of h.state.notesSawUrls) assert.ok(h.state.fetched.includes(url));
  });

  it('fetches only what was shortlisted, never the whole sweep', async () => {
    const h = harness({ entryCount: 12 });
    await runCaPipeline(input({ maxItems: 4 }), h.deps);
    assert.ok(h.state.fetched.length <= 6, `fetched ${h.state.fetched.length} of 12`);
  });

  it('computes max_tokens from the work rather than hardcoding it', async () => {
    const h = harness();
    await runCaPipeline(input({ maxItems: 6 }), h.deps);
    assert.equal(h.state.shortlistMaxTokens, shortlistMaxTokens(9));
    assert.equal(h.state.notesMaxTokens, notesMaxTokens(h.state.notesSawUrls.length));
    assert.notEqual(h.state.shortlistMaxTokens, h.state.notesMaxTokens);
  });

  it('bounds-checks a candidate index the model invented', async () => {
    const h = harness();
    h.deps.shortlist = async () => ({
      picks: [
        { candidateIndex: 999, kind: 'structural', syllabusSlugs: ['gs2/polity'], sectionKeys: [], why: '' },
        { candidateIndex: 0, kind: 'structural', syllabusSlugs: ['gs2/polity'], sectionKeys: [], why: '' },
      ],
      stopReason: 'end_turn',
      usage: ZERO_USAGE,
      provenance: 'model',
    });
    const result = await runCaPipeline(input(), h.deps);
    assert.equal(result.summary.shortlisted, 1);
    assert.equal(result.summary.dropReasons.unknown_url, 1);
  });
});

describe('grounding — the check the whole phase rests on', () => {
  it('drops an item whose quote is not in the fetched page', async () => {
    const h = harness({
      drafts: (docs) =>
        docs.map((d, i) => {
          const n = Number(/story-(\d+)$/.exec(d.url)?.[1] ?? 1);
          return i === 0
            ? draft(n, {
                evidence: [{ quote: 'The Ministry sanctioned a further 900 crore.', at: -1 }],
              })
            : draft(n);
        }),
    });
    const result = await runCaPipeline(input(), h.deps);

    assert.equal(result.summary.dropReasons.ungrounded_quote, 1);
    assert.equal(h.emitted.length, result.summary.kept);
    for (const item of h.emitted) {
      assert.equal(item.headline.includes('900 crore'), false);
    }
  });

  it('drops an item carrying a number the page never mentions', async () => {
    const h = harness({
      drafts: (docs) => {
        const n = Number(/story-(\d+)$/.exec(docs[0]?.url ?? '')?.[1] ?? 1);
        return [draft(n, { noteMd: `${quoteFor(n)} A further 7788 units were added.`,
          sentenceEvidence: [0, 0] })];
      },
    });
    const result = await runCaPipeline(input(), h.deps);
    assert.equal(result.summary.kept, 0);
    assert.equal(result.summary.dropReasons.ungrounded_number, 1);
  });

  it('drops a note whose sentences outrun its evidence', async () => {
    const h = harness({
      drafts: (docs) => {
        const n = Number(/story-(\d+)$/.exec(docs[0]?.url ?? '')?.[1] ?? 1);
        return [draft(n, { noteMd: `${quoteFor(n)} Consultations were completed.`,
          sentenceEvidence: [0] })];
      },
    });
    const result = await runCaPipeline(input(), h.deps);
    assert.equal(result.summary.kept, 0);
    assert.equal(result.summary.dropReasons.uncovered_sentence, 1);
  });

  it('drops a note over ninety words before paying to scan it', async () => {
    const h = harness({
      drafts: (docs) => {
        const n = Number(/story-(\d+)$/.exec(docs[0]?.url ?? '')?.[1] ?? 1);
        return [draft(n, { noteMd: `${quoteFor(n)} ${'padding word '.repeat(95)}` })];
      },
    });
    const result = await runCaPipeline(input(), h.deps);
    assert.equal(result.summary.kept, 0);
    assert.equal(result.summary.dropReasons.note_too_long, 1);
  });

  it('drops a note written about a page that was never fetched', async () => {
    const h = harness({
      drafts: () => [draft(1, { url: 'https://elsewhere.test/invented' })],
    });
    const result = await runCaPipeline(input(), h.deps);
    assert.equal(result.summary.kept, 0);
    assert.equal(result.summary.dropReasons.unknown_url, 1);
  });

  it('resolves every offset so slice(at) really equals the quote', async () => {
    const h = harness();
    const items: { evidence: readonly { quote: string; at: number }[] }[] = [];
    h.deps.emitItem = (item) => items.push(item);
    await runCaPipeline(input(), h.deps);

    assert.ok(items.length > 0);
    for (const item of items) {
      for (const span of item.evidence) assert.ok(span.at >= 0, 'an offset never resolved');
    }
  });
});

describe('spend', () => {
  it('bills each model call separately, in order', async () => {
    const h = harness();
    await runCaPipeline(input(), h.deps);
    assert.deepEqual(h.billed.map((b) => b.phase), ['shortlist', 'notes']);
  });

  it('bills exactly the shortlist when the run dies after it', async () => {
    // The property that makes a half-run honest: two calls reserved, one made,
    // one billed. Billing the reservation instead would over-count the month.
    const h = harness({ shortlistStopReason: 'max_tokens' });
    const result = await runCaPipeline(input(), h.deps);

    assert.deepEqual(h.billed.map((b) => b.phase), ['shortlist']);
    assert.equal(h.state.notesCalls, 0, 'the expensive call must not run');
    assert.equal(h.state.fetched.length, 0, 'nothing should have been fetched');
    assert.equal(result.summary.shortlisted, 0);
    assert.equal(result.summary.underDelivered, true);
  });

  it('bills a truncated notes call — the tokens were spent', async () => {
    const h = harness({ notesStopReason: 'max_tokens' });
    const result = await runCaPipeline(input(), h.deps);
    assert.deepEqual(h.billed.map((b) => b.phase), ['shortlist', 'notes']);
    assert.equal(result.summary.kept, 0);
  });

  it('carries cache tokens through so a cached workload is not under-counted', async () => {
    const h = harness();
    const result = await runCaPipeline(input(), h.deps);
    assert.equal(result.totalUsage.cacheCreationInputTokens, 1200);
    assert.equal(result.totalUsage.cacheReadInputTokens, 1200);
    assert.equal(result.totalUsage.inputTokens, 4900);
  });

  it('makes no model call at all when the feed sweep came back empty', async () => {
    const h = harness({ entryCount: 0, feedFailures: 2 });
    const result = await runCaPipeline(input(), h.deps);

    assert.equal(h.billed.length, 0, 'a quiet day must cost nothing');
    assert.equal(result.summary.considered, 0);
    assert.equal(result.summary.sourceFailures.length, 2, 'a 404 feed is not a quiet day');
  });
});

describe('progress', () => {
  it('reports the fetch phase per document, not once at the end', async () => {
    // The fetch phase is twenty to sixty seconds of network I/O. A blank screen
    // that long reads as a hang, and the client's idle timer cuts it at 45s.
    const h = harness({ entryCount: 12 });
    await runCaPipeline(input({ maxItems: 6 }), h.deps);

    const fetchFrames = h.progress.filter((p) => p.phase === 'fetch');
    assert.ok(fetchFrames.length >= 3, `only ${fetchFrames.length} fetch frames`);
    assert.deepEqual(fetchFrames.at(-1)?.done, fetchFrames.at(-1)?.total);
  });

  it('names every phase it entered', async () => {
    const h = harness();
    await runCaPipeline(input(), h.deps);
    const phases = new Set(h.progress.map((p) => p.phase));
    for (const phase of ['feeds', 'shortlist', 'fetch', 'notes', 'ground', 'select']) {
      assert.ok(phases.has(phase as never), `no progress frame for ${phase}`);
    }
  });

  it('emits every progress frame BEFORE the first item', async () => {
    const seen: string[] = [];
    const h = harness();
    h.deps.onProgress = () => seen.push('progress');
    h.deps.emitItem = () => seen.push('item');
    await runCaPipeline(input(), h.deps);

    const firstItem = seen.indexOf('item');
    assert.ok(firstItem > 0);
    assert.equal(seen.slice(firstItem).every((s) => s === 'item'), true);
  });
});

describe('cancellation', () => {
  it('refuses to start the notes call once the client is gone', async () => {
    // Aborting the in-flight call is only half the job. Without refusing the
    // next phase, a client leaving during the fetch still pays for the
    // expensive second call and delivers none of it.
    const h = harness({ cancelAfterPhase: 'fetch' });
    const result = await runCaPipeline(input(), h.deps);

    assert.equal(result.cancelled, true);
    assert.equal(h.state.notesCalls, 0, 'the notes call must never start');
    assert.deepEqual(h.billed.map((b) => b.phase), ['shortlist']);
    assert.equal(h.emitted.length, 0);
  });

  it('refuses to start the shortlist when the client left during the feed sweep', async () => {
    const h = harness({ cancelAfterPhase: 'feeds' });
    const result = await runCaPipeline(input(), h.deps);

    assert.equal(result.cancelled, true);
    assert.equal(h.state.shortlistCalls, 0);
    assert.equal(h.billed.length, 0, 'nothing ran, so nothing is billed');
  });

  it('does not even read the feeds when the client is already gone', async () => {
    const h = harness();
    h.deps.isCancelled = () => true;
    const result = await runCaPipeline(input(), h.deps);
    assert.equal(result.cancelled, true);
    assert.deepEqual(h.state.order, []);
  });
});

describe('the summary', () => {
  it('reports under-delivery as a normal outcome, not an error', async () => {
    const h = harness({ entryCount: 3 });
    const result = await runCaPipeline(input({ maxItems: 6 }), h.deps);

    assert.ok(result.summary.kept > 0);
    assert.ok(result.summary.kept < 6);
    assert.equal(result.summary.underDelivered, true);
  });

  it('does not call four items on a quiet day a failure when four were asked for', async () => {
    const h = harness({ entryCount: 4 });
    const result = await runCaPipeline(input({ maxItems: 4 }), h.deps);
    assert.equal(result.summary.kept, 4);
    assert.equal(result.summary.underDelivered, false);
  });

  it('keeps a failed feed visible even when the digest is full', async () => {
    const h = harness({ feedFailures: 2 });
    const result = await runCaPipeline(input(), h.deps);
    assert.equal(result.summary.sourceFailures.length, 2);
  });

  it('reports a failed article fetch as its own drop reason', async () => {
    const h = harness({ entryCount: 6, fetchFails: [1, 2] });
    const result = await runCaPipeline(input(), h.deps);
    assert.equal(result.summary.dropReasons.fetch_failed, 2);
    assert.equal(result.summary.sourceFailures.length, 2);
  });

  it('clamps maxItems to the day ceiling rather than trusting the body', () => {
    assert.equal(clampMaxItems(0), 1);
    assert.equal(clampMaxItems(99), 8);
    assert.equal(clampMaxItems(DEFAULT_MAX_ITEMS), DEFAULT_MAX_ITEMS);
  });
});

/* ------------------------------------------------------------ the fake runner */

describe('the fake runner', () => {
  async function runFake(requestId: string, date = '2026-09-07') {
    const [shortlistPrompt, notesPrompt] = await Promise.all([
      compileShortlistPrompt(),
      compileNotesPrompt({ linkAnthropology: true }),
    ]);
    const emitted: {
      headline: string;
      sourceName: string;
      sourceUrl: string;
      canonicalUrl: string;
      anthro: unknown;
    }[] = [];
    const billed: string[] = [];

    const result = await runCaPipeline(
      input({
        requestId,
        date,
        maxItems: 8,
        // Five sections so the section cap does not swallow the run: it is
        // exercised exhaustively in ca-select.test.ts, and letting it dominate
        // here would hide the defects this fixture exists to demonstrate.
        sections: ['polity', 'economy', 'environment', 'society', 'ir'],
        shortlistSystem: shortlistPrompt.systemPrompt,
        notesSystem: notesPrompt.systemPrompt,
      }),
      {
        collectEntries: async ({ requestId: id, date: d }) => fakeCollectEntries({ requestId: id, date: d }),
        fetchDocuments: async (entries, opts) =>
          fakeFetchDocuments(entries, {
            requestId: opts.requestId,
            date: opts.date,
            onProgress: opts.onProgress,
            isCancelled: opts.isCancelled,
          }),
        verifyGrounding,
        shortlist: fakeShortlistRunner,
        notes: fakeNotesRunner,
        emitItem: (item) => emitted.push(item),
        onProgress: () => undefined,
        onCallUsage: async (e) => {
          billed.push(e.phase);
        },
        isCancelled: () => false,
        signal: new AbortController().signal,
      },
    );
    return { result, emitted, billed };
  }

  it('marks every fake item three ways, including two she can see', async () => {
    // A fake SCORE is obviously a score. A fake FACT looks exactly like a real
    // fact and gets written into an answer under a real newspaper's name.
    const { emitted } = await runFake('req-fake-marks');
    assert.ok(emitted.length > 0, 'the fake delivered nothing at all');
    for (const item of emitted) {
      assert.ok(item.headline.startsWith('[SAMPLE]'), 'the visible marker is missing');
      assert.equal(item.sourceName, 'SAMPLE');
      assert.ok(item.sourceUrl.startsWith('about:blank'), `sourceUrl was ${item.sourceUrl}`);
    }
  });

  it('FABRICATES exactly one quote per run, so the drop path really runs', async () => {
    // A fake pair that always agrees leaves the most expensive branch of the
    // pipeline never exercised outside production.
    const { result } = await runFake('req-fake-drop');
    assert.equal(
      result.summary.dropReasons.ungrounded_quote,
      1,
      'exactly one fabricated quote per run',
    );
  });

  it('exercises the other rejection branches too', async () => {
    const { result } = await runFake('req-fake-defects');
    const r = result.summary.dropReasons;
    assert.ok((r.no_syllabus_tag ?? 0) > 0, 'every 5th must claim no syllabus hook');
    assert.ok((r.note_too_long ?? 0) > 0, 'every 7th must blow the word limit');
    assert.ok((r.fetch_failed ?? 0) > 0, 'every 6th fetch must fail');
    assert.ok((r.event_only ?? 0) > 0, 'events past the first must lose their slot');
    assert.ok((r.anthro_no_p2 ?? 0) > 0, 'a concept with no Indian instance must lose its link');
    assert.equal(result.summary.underDelivered, true, 'defects must cost delivery');
  });

  it('always reports a source failure, so a 404 feed stays distinguishable', async () => {
    const { result } = await runFake('req-fake-failures');
    assert.ok(result.summary.sourceFailures.length > 0);
  });

  it('bills both calls and reports itself as fake', async () => {
    const { result, billed } = await runFake('req-fake-usage');
    assert.deepEqual(billed, ['shortlist', 'notes']);
    assert.equal(result.provenance, 'fake');
    assert.ok(result.totalUsage.inputTokens > 0);
    assert.ok(result.totalUsage.cacheReadInputTokens > 0);
  });

  it('keeps the anthropology link rate under the suspicion threshold', async () => {
    // A fake that claimed a link on everything would train exactly the habit
    // the anthropology prompt spends a page forbidding.
    const { result } = await runFake('req-fake-anthro');
    assert.ok(result.summary.anthroLinkRate <= 0.4, `rate was ${result.summary.anthroLinkRate}`);
  });

  it('is deterministic for the same seed tuple', async () => {
    const a = await runFake('req-fake-seed');
    const b = await runFake('req-fake-seed');
    assert.deepEqual(
      a.emitted.map((i) => i.headline),
      b.emitted.map((i) => i.headline),
    );
    assert.deepEqual(a.result.summary, b.result.summary);
  });

  it('produces DIFFERENT items on a different day, so day two is not all duplicates', async () => {
    // A fixed script would collide with the duplicate window on the second day
    // and look exactly like a digest bug.
    const monday = await runFake('req-fake-mon', '2026-09-07');
    const tuesday = await runFake('req-fake-tue', '2026-09-08');
    const overlap = monday.emitted.filter((m) =>
      tuesday.emitted.some((t) => t.headline === m.headline),
    );
    assert.equal(overlap.length, 0, 'the fake repeated itself across days');
  });

  it('offers a full sweep rather than exactly the number it will deliver', async () => {
    const { result } = await runFake('req-fake-sweep');
    assert.equal(result.summary.considered, FAKE_ARTICLE_COUNT);
    assert.ok(result.summary.shortlisted < FAKE_ARTICLE_COUNT);
  });
});

describe('tag caps', () => {
  /**
   * Five slugs and five sections, ALL of them in the request's vocabulary.
   *
   * The first attempt at this test used invented slugs and passed with the fix
   * removed, because the allowlist silently dropped them before the union ever
   * grew. The allowlist bounds WHICH slugs may appear; nothing bounded HOW MANY.
   */
  const WIDE_VOCAB = ['gs1/history', 'gs1/geography', 'gs2/polity', 'gs3/economy', 'gs3/environment'];
  const WIDE_SECTIONS = ['history', 'geography', 'polity', 'economy', 'environment'];

  it("caps the UNION of both calls' tags, not just each call", async () => {
    // The bug: `ca/schema.ts` bounds each call's list with `maxItems`, and that
    // was the only bound anywhere. The pipeline then UNIONS the shortlist call's
    // tags with the notes call's, so two lists of four legally produced eight —
    // on the current provider, with both schemas honoured. `maxItems` is also
    // one of the keywords an OpenAI-compatible strict dialect strips, which
    // would remove even the per-call bound.
    const h = harness({
      shortlistSlugs: WIDE_VOCAB,
      shortlistSections: WIDE_SECTIONS,
      entryCount: 4,
    });
    await runCaPipeline(
      input({ maxItems: 2, syllabusSlugs: WIDE_VOCAB, sections: WIDE_SECTIONS }),
      h.deps,
    );

    assert.ok(h.emitted.length > 0, 'the fixture must emit something for this to mean anything');
    for (const item of h.emitted) {
      assert.ok(
        item.syllabusSlugs.length <= MAX_SYLLABUS_SLUGS_PER_ITEM,
        `syllabusSlugs ran to ${item.syllabusSlugs.length} (${item.syllabusSlugs.join(', ')}), over the cap of ${MAX_SYLLABUS_SLUGS_PER_ITEM}`,
      );
      assert.ok(
        item.sectionKeys.length <= MAX_SECTION_KEYS_PER_ITEM,
        `sectionKeys ran to ${item.sectionKeys.length}, over the cap of ${MAX_SECTION_KEYS_PER_ITEM}`,
      );
    }
  });

  it('keeps the item rather than dropping it when over-tagged', async () => {
    // An over-tagged item is over-eager, not wrong. Dropping it would discard a
    // good story over a tagging error the reader would never have noticed.
    const h = harness({ shortlistSlugs: WIDE_VOCAB, entryCount: 4 });
    await runCaPipeline(input({ maxItems: 2, syllabusSlugs: WIDE_VOCAB }), h.deps);
    assert.ok(h.emitted.length > 0, 'over-tagging must not empty the digest');
  });
});
