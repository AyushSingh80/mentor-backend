/**
 * Orchestration, with stub runners and no socket.
 *
 * These are the tests for the decisions that cost money or ship a wrong fact:
 * what happens on a truncated chunk, what happens when the blind verifier
 * disagrees, what happens when the client walks away at question five.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.ANTHROPIC_API_KEY ??= 'sk-ant-test-not-real';
process.env.MODEL_EVALUATION ??= 'eval-model-1';
process.env.MODEL_BULK ??= 'bulk-model-1';
process.env.APP_BEARER_TOKEN ??= 'test-token';

const { CHUNK_SIZE, MAX_TOPUP_CHUNKS, plannedChunksFor, runMcqPipeline } = await import(
  '../src/mcq/pipeline.js'
);
const { ZERO_USAGE } = await import('../src/mcq/runner.js');
const { fakeMcqRunner, fakeVerificationRunner } = await import('../src/fake-mcq-runner.js');
const { compileGenerationPrompt, compileVerifierPrompt } = await import('../src/mcq/index.js');

type PipelineInput = Parameters<typeof runMcqPipeline>[0];
type PipelineDeps = Parameters<typeof runMcqPipeline>[1];
type Draft = Awaited<ReturnType<PipelineDeps['generate']>> extends { drafts: (infer D)[] | null }
  ? D
  : never;

/**
 * A valid two-statement question. The vocabulary is varied per `n` on purpose:
 * stems that differ only by a digit are genuine near-duplicates and the SimHash
 * check rejects them, which is correct behaviour and a useless fixture.
 */
const SUBJECTS = [
  'the appellate jurisdiction of tribunals constituted under central legislation',
  'the manner in which inter-state water disputes are referred for adjudication',
  'the classification of scheduled areas and the powers exercised over them',
  'the procedure by which money bills are certified and transmitted',
  'the composition of zonal councils and the role assigned to their chairmen',
  'the conditions under which a proclamation of financial emergency operates',
  'the delegation of rule-making authority to subordinate regulatory bodies',
  'the constitutional protection afforded to inter-governmental tax immunity',
  'the mechanism through which grants-in-aid are recommended and released',
  'the residuary powers of legislation and the field they are read to occupy',
  'the process for altering the boundaries of an existing constituent unit',
  'the requirement of prior sanction before prosecuting a public servant',
  'the distinction between an ordinance and an act of the legislature',
  'the appointment and removal of members of statutory regulatory commissions',
  'the treatment of concurrent list entries where a repugnancy arises',
  'the audit of autonomous bodies substantially financed from public funds',
  'the scope of judicial review over subordinate legislation',
  'the manner in which a joint sitting of the two Houses is convened',
  'the classification of tribes for the purpose of constitutional safeguards',
  'the powers of a legislative council in relation to financial legislation',
  'the framework governing the transfer of administrative functions to local bodies',
  'the recognition of a party as a national party and the consequences of it',
  'the limits placed on the borrowing powers of constituent units',
  'the constitution of a public service commission for two or more units',
  'the effect of a proclamation on the legislative competence of the units',
] as const;

function subject(n: number): string {
  return SUBJECTS[(n - 1) % SUBJECTS.length] as string;
}

function draft(n: number, overrides: Partial<Draft> = {}): Draft {
  return {
    form: 'statements_correct',
    stem: `Consider the following statements regarding ${subject(n)}.\nWhich of the statements given above is/are correct?`,
    statements: [
      { index: 1, text: `Regarding ${subject(n)}, a statutory basis exists.`, isTrue: true },
      { index: 2, text: `Regarding ${subject(n)}, the executive is bound absolutely.`, isTrue: false },
    ],
    options: ['1 only', '2 only', 'Both 1 and 2', 'Neither 1 nor 2'],
    answerIndex: 0,
    eliminationRationale: [
      'Correct: the statutory provision is the operative one.',
      'Confuses statutory basis with binding force.',
      'Assumes both hold.',
      'Assumes neither holds.',
    ],
    factKey: `polity:instrument-${n}`,
    verifiabilityAnchor: `Statutory provision ${n}.`,
    ...overrides,
  } as Draft;
}

function input(overrides: Partial<PipelineInput> = {}): PipelineInput {
  return {
    requestId: 'req-1',
    paper: 'gs2',
    topic: { slug: 'polity/federalism', label: 'Federalism' },
    difficulty: 'standard',
    count: 10,
    excludeFactKeys: [],
    excludeStemHashes: [],
    model: 'bulk-model-1',
    verifierModel: 'bulk-model-1',
    generationSystem: 'system',
    verifierSystem: 'verifier system',
    promptVersion: 'abc123abc123',
    verifierVersion: 'def456def456',
    ...overrides,
  };
}

interface Harness {
  deps: PipelineDeps;
  emitted: { stem: string; answerIndex: number; provenance: string }[];
  billed: { phase: string }[];
  generateCalls: number;
  verifyCalls: number;
  verifyPayloads: string[];
  requestedCounts: number[];
}

interface StubOptions {
  /** Drafts to return per generation call, in order. */
  chunks?: Draft[][];
  /** Drafts to return from EVERY generation call, including the top-ups. */
  allChunks?: Draft[];
  /** Stop reason per generation call, in order. Defaults to end_turn. */
  stopReasons?: (string | null)[];
  /** Overrides the verifier's chosen index for the nth verified question. */
  disagreeOn?: (globalIndex: number) => boolean;
  flag?: 'ambiguous' | 'timeDependent' | 'factuallyDisputed';
  /** Omit a verdict for the nth verified question. */
  silentOn?: (globalIndex: number) => boolean;
  verifyStopReason?: string | null;
  cancelAfterQuestions?: number;
}

function harness(options: StubOptions = {}): Harness {
  const emitted: Harness['emitted'] = [];
  const billed: { phase: string }[] = [];
  const verifyPayloads: string[] = [];
  const requestedCounts: number[] = [];
  const state = { generateCalls: 0, verifyCalls: 0, verified: 0, cancelled: false };

  const h: Harness = {
    emitted,
    billed,
    verifyPayloads,
    requestedCounts,
    get generateCalls() {
      return state.generateCalls;
    },
    get verifyCalls() {
      return state.verifyCalls;
    },
    deps: {
      generate: async (request) => {
        const call = state.generateCalls;
        state.generateCalls += 1;
        const stop = options.stopReasons?.[call] ?? 'end_turn';
        requestedCounts.push(request.count);
        const supplied = options.allChunks ?? options.chunks?.[call];
        const drafts =
          supplied ??
          Array.from({ length: request.count }, (_, i) => draft(request.ordinalOffset + i + 1));
        return {
          drafts: stop === 'max_tokens' ? drafts : drafts,
          stopReason: stop,
          usage: { ...ZERO_USAGE, inputTokens: 100, outputTokens: 200 },
          provenance: 'model',
        };
      },
      verify: async (request) => {
        state.verifyCalls += 1;
        verifyPayloads.push(request.payload);
        const parsed = JSON.parse(request.payload) as { questions: { options: string[] }[] };
        const verdicts = parsed.questions.flatMap((_q, i) => {
          const globalIndex = state.verified;
          state.verified += 1;
          if (options.silentOn?.(globalIndex)) return [];
          return [
            {
              questionIndex: i,
              // The stub questions are all keyed 0; disagreement means 1.
              chosenIndex: options.disagreeOn?.(globalIndex) ? 1 : 0,
              confidence: 'high' as const,
              ambiguous: options.flag === 'ambiguous',
              timeDependent: options.flag === 'timeDependent',
              factuallyDisputed: options.flag === 'factuallyDisputed',
            },
          ];
        });
        return {
          verdicts,
          stopReason: options.verifyStopReason ?? 'end_turn',
          usage: { ...ZERO_USAGE, inputTokens: 50, outputTokens: 20 },
        };
      },
      emitQuestion: (q) => {
        emitted.push({ stem: q.stem, answerIndex: q.answerIndex, provenance: q.provenance });
        if (
          options.cancelAfterQuestions !== undefined &&
          emitted.length >= options.cancelAfterQuestions
        ) {
          state.cancelled = true;
        }
      },
      onChunkUsage: async (event) => {
        billed.push({ phase: event.phase });
      },
      isCancelled: () => state.cancelled,
      signal: new AbortController().signal,
    },
  };
  return h;
}

describe('chunking', () => {
  it('plans ceil(count / 5) chunks', () => {
    assert.equal(CHUNK_SIZE, 5);
    assert.equal(plannedChunksFor(20), 4);
    assert.equal(plannedChunksFor(5), 1);
    assert.equal(plannedChunksFor(30), 6);
    assert.equal(plannedChunksFor(7), 2);
  });

  it('delivers the requested count and stops', async () => {
    const h = harness();
    const result = await runMcqPipeline(input({ count: 10 }), h.deps);

    assert.equal(result.summary.delivered, 10);
    assert.equal(result.summary.underDelivered, false);
    assert.equal(h.emitted.length, 10);
    assert.equal(h.generateCalls, 2, 'two chunks of five');
  });

  it('never emits more than asked even when a chunk over-delivers', async () => {
    const h = harness({ chunks: [Array.from({ length: 9 }, (_, i) => draft(i + 1))] });
    const result = await runMcqPipeline(input({ count: 5 }), h.deps);
    assert.equal(result.summary.delivered, 5);
    assert.equal(h.emitted.length, 5);
  });

  it('bills every chunk, generation and verification alike', async () => {
    const h = harness();
    await runMcqPipeline(input({ count: 10 }), h.deps);
    assert.deepEqual(
      h.billed.map((b) => b.phase),
      ['generate', 'verify', 'generate', 'verify'],
    );
  });
});

describe('truncation', () => {
  it('yields ZERO questions from a truncated chunk rather than a partial parse', async () => {
    // The whole point: the last object in a truncated JSON document is cut
    // mid-field, so a question could arrive with two options and a key
    // pointing past the end. Salvaging "the ones that look complete" is how a
    // malformed question reaches the bank.
    const h = harness({
      chunks: [Array.from({ length: 5 }, (_, i) => draft(i + 1))],
      stopReasons: ['max_tokens', 'max_tokens', 'max_tokens', 'max_tokens', 'max_tokens', 'max_tokens'],
    });
    const result = await runMcqPipeline(input({ count: 5 }), h.deps);

    assert.equal(result.summary.delivered, 0, 'a truncated chunk must deliver nothing');
    assert.equal(h.emitted.length, 0);
    assert.equal(h.verifyCalls, 0, 'a discarded chunk must not be paid to verify');
    assert.ok(result.summary.chunksTruncated >= 1);
  });

  it('still bills a truncated chunk — the tokens were spent', async () => {
    const h = harness({ stopReasons: ['max_tokens'] });
    await runMcqPipeline(input({ count: 5 }), h.deps);
    assert.ok(h.billed.some((b) => b.phase === 'generate'));
  });

  it('retries once at half size and recovers', async () => {
    const h = harness({ stopReasons: ['max_tokens', 'end_turn'] });
    const result = await runMcqPipeline(input({ count: 5 }), h.deps);

    assert.equal(result.summary.chunksTruncated, 1);
    // Five truncated, so the retry asks for two — halving is what makes a
    // retry more likely to fit than the request that just failed to.
    assert.equal(h.requestedCounts[0], 5);
    assert.equal(h.requestedCounts[1], 2, 'the retry must ask for half');
    assert.ok(result.summary.delivered > 0, 'the retry recovered something');
  });

  it('does not retry a truncated chunk more than once', async () => {
    // Twice truncated means the topic genuinely produces long output; a third
    // attempt at a quarter size is money spent to learn the same thing.
    const h = harness({ stopReasons: ['max_tokens', 'max_tokens', 'max_tokens', 'max_tokens'] });
    const result = await runMcqPipeline(input({ count: 5 }), h.deps);
    assert.equal(result.summary.delivered, 0);
    assert.equal(h.verifyCalls, 0);
  });

  it('discards the chunk when verification itself truncates', async () => {
    const h = harness({ verifyStopReason: 'max_tokens' });
    const result = await runMcqPipeline(input({ count: 5 }), h.deps);
    assert.equal(result.summary.delivered, 0);
    assert.equal(h.emitted.length, 0);
  });
});

describe('blind verification', () => {
  it('sends stem and options only — never the key or a rationale', async () => {
    const h = harness();
    await runMcqPipeline(input({ count: 5 }), h.deps);

    assert.ok(h.verifyPayloads.length > 0);
    for (const payload of h.verifyPayloads) {
      assert.equal(payload.includes('answerIndex'), false, 'the key leaked to the verifier');
      assert.equal(payload.includes('eliminationRationale'), false, 'a rationale leaked');
      assert.equal(payload.includes('isTrue'), false, 'the statement verdicts leaked');
      assert.equal(payload.includes('difficulty'), false, 'the difficulty leaked');
      assert.equal(payload.includes('Confuses statutory basis'), false, 'rationale text leaked');
    }
  });

  it('drops on disagreement and never re-keys', async () => {
    // Re-keying would leave four rationales arguing for a different option
    // than the one now marked correct — a worse artefact than either candidate.
    const h = harness({ disagreeOn: (i) => i < 3 });
    const result = await runMcqPipeline(input({ count: 5 }), h.deps);

    assert.equal(result.summary.keyDisagreements, 3);
    assert.equal(result.summary.rejections.verifier_disagreed, 3);
    for (const q of h.emitted) {
      assert.equal(q.answerIndex, 0, 'an emitted question was re-keyed');
    }
  });

  it('tops up with a fresh chunk after disagreements', async () => {
    const h = harness({ disagreeOn: (i) => i < 2 });
    const result = await runMcqPipeline(input({ count: 5 }), h.deps);
    assert.ok(h.generateCalls > 1, 'expected a top-up chunk');
    assert.equal(result.summary.delivered, 5);
  });

  it('bounds the top-up so a bad topic cannot loop', async () => {
    const h = harness({ disagreeOn: () => true });
    const result = await runMcqPipeline(input({ count: 10 }), h.deps);

    assert.equal(result.summary.delivered, 0);
    assert.equal(result.summary.underDelivered, true, 'under-delivery is the correct outcome');
    assert.equal(h.generateCalls, plannedChunksFor(10) + MAX_TOPUP_CHUNKS);
  });

  for (const flag of ['ambiguous', 'timeDependent', 'factuallyDisputed'] as const) {
    it(`rejects on ${flag} even when the answer matched`, async () => {
      // An ambiguous question both models answer identically is still
      // ambiguous, and it trains an instinct she can never trace.
      const h = harness({ flag });
      const result = await runMcqPipeline(input({ count: 5 }), h.deps);

      assert.equal(result.summary.delivered, 0);
      assert.equal(result.summary.keyDisagreements, 0, 'the answers agreed');
      assert.ok(
        (result.summary.rejections.verifier_ambiguous ??
          result.summary.rejections.verifier_time_dependent ??
          result.summary.rejections.verifier_disputed ??
          0) > 0,
      );
    });
  }

  it('rejects a question the verifier declined to answer', async () => {
    const h = harness({ silentOn: (i) => i === 0 });
    const result = await runMcqPipeline(input({ count: 5 }), h.deps);
    assert.equal(result.summary.rejections.verifier_silent, 1);
  });
});

describe('free checks run before the paid one', () => {
  it('never pays to verify a question a regex could reject', async () => {
    const bad = Array.from({ length: 5 }, (_, i) =>
      draft(i + 1, { statements: [
        { index: 1, text: 'The currently applicable rate is fixed.', isTrue: true },
        { index: 2, text: 'It binds the executive absolutely.', isTrue: false },
      ] }),
    );
    const h = harness({ allChunks: bad });
    const result = await runMcqPipeline(input({ count: 5 }), h.deps);

    // Every chunk, planned and top-up, is rejected before any paid call.
    assert.equal(result.summary.delivered, 0);
    assert.ok((result.summary.rejections.time_varying ?? 0) >= 5);
    assert.equal(h.verifyCalls, 0, 'a chunk with no survivors must not be verified');
  });

  it('never pays to verify a question the bank already holds', async () => {
    const h = harness({ allChunks: Array.from({ length: 5 }, (_, i) => draft(i + 1)) });
    const result = await runMcqPipeline(
      input({
        count: 5,
        excludeFactKeys: ['polity:instrument-1', 'polity:instrument-2', 'polity:instrument-3',
          'polity:instrument-4', 'polity:instrument-5'],
      }),
      h.deps,
    );
    assert.equal(result.summary.delivered, 0);
    assert.ok((result.summary.rejections.duplicate_fact ?? 0) >= 5);
    assert.equal(h.verifyCalls, 0);
  });

  it('deduplicates within a batch, so chunk 2 cannot repeat chunk 1', async () => {
    const repeated = Array.from({ length: 5 }, () => draft(1));
    const h = harness({ allChunks: repeated });
    const result = await runMcqPipeline(input({ count: 10 }), h.deps);

    assert.equal(result.summary.delivered, 1, 'only the first copy survives');
    assert.ok((result.summary.rejections.duplicate_fact ?? 0) > 0);
  });
});

describe('cancellation', () => {
  it('stops starting chunks once the client is gone', async () => {
    // The failure this prevents: killing the app at question five otherwise
    // pays for six through twenty and delivers none of them.
    const h = harness({ cancelAfterQuestions: 5 });
    const result = await runMcqPipeline(input({ count: 20 }), h.deps);

    assert.equal(result.summary.cancelled, true);
    assert.equal(result.summary.delivered, 5);
    assert.equal(h.generateCalls, 1, 'chunk 2 must never start');
    assert.equal(h.verifyCalls, 1);
  });

  it('bills only what it actually ran', async () => {
    const h = harness({ cancelAfterQuestions: 5 });
    await runMcqPipeline(input({ count: 20 }), h.deps);
    assert.equal(h.billed.length, 2, 'one generation and one verification, not eight calls');
  });
});

describe('summary', () => {
  it('reports under-delivery as a normal outcome, not an error', async () => {
    const h = harness({ disagreeOn: (i) => i % 2 === 0 });
    const result = await runMcqPipeline(input({ count: 10 }), h.deps);

    assert.equal(typeof result.summary.delivered, 'number');
    assert.equal(result.summary.requested, 10);
    assert.equal(result.summary.underDelivered, result.summary.delivered < 10);
    assert.ok(result.summary.rejected > 0);
    assert.ok(result.summary.chunksRun > 0);
  });

  it('accumulates usage across every call', async () => {
    const h = harness();
    const result = await runMcqPipeline(input({ count: 10 }), h.deps);
    // Two chunks: 2 generations at 100/200 and 2 verifications at 50/20.
    assert.equal(result.totalUsage.inputTokens, 300);
    assert.equal(result.totalUsage.outputTokens, 440);
  });
});

describe('the fake runner', () => {
  async function runFake(requestId: string, overrides: Partial<PipelineInput> = {}) {
    const [generation, verifier] = await Promise.all([
      compileGenerationPrompt('gs2'),
      compileVerifierPrompt(),
    ]);
    const emitted: { stem: string; provenance: string; factKey: string; stemHash: string;
      meta?: { fake?: boolean } }[] = [];
    const result = await runMcqPipeline(
      input({
        requestId,
        count: 20,
        generationSystem: generation.systemPrompt,
        verifierSystem: verifier.systemPrompt,
        promptVersion: generation.version,
        verifierVersion: verifier.version,
        ...overrides,
      }),
      {
        generate: fakeMcqRunner,
        verify: fakeVerificationRunner,
        emitQuestion: (q) => emitted.push(q),
        onChunkUsage: async () => {},
        isCancelled: () => false,
        signal: new AbortController().signal,
      },
    );
    return { result, emitted };
  }

  it('marks every fake question three ways, including one she can see', async () => {
    // The first two are invisible on a phone. A fake question banked and then
    // drilled by a spaced-repetition schedule is durable contamination of the
    // one artefact this endpoint exists to keep clean.
    const { emitted } = await runFake('req-fake-marks');
    assert.ok(emitted.length > 0);
    for (const q of emitted) {
      assert.ok(q.stem.startsWith('[SAMPLE]'), 'the visible marker is missing');
      assert.equal(q.provenance, 'fake');
      assert.equal(q.meta?.fake, true);
    }
  });

  it('exercises every rejection branch on a batch of twenty', async () => {
    // A fake that only emits good questions tests nothing that matters: the
    // property under test is that the validation pipeline drops the bad ones.
    const { result } = await runFake('req-fake-defects');
    const r = result.summary.rejections;

    assert.ok((r.self_consistency ?? 0) > 0, 'every 7th must contradict its own verdicts');
    assert.ok((r.option_subsets ?? 0) > 0, 'every 11th must repeat an option subset');
    assert.ok((r.time_varying ?? 0) > 0, 'every 13th must carry a time-varying word');
    assert.ok((r.duplicate_fact ?? 0) > 0, 'every 17th must repeat a factKey');
    assert.ok((r.verifier_disagreed ?? 0) > 0, 'every 19th must be keyed against by the verifier');
    assert.equal(result.summary.keyDisagreements, r.verifier_disagreed);
    assert.equal(result.summary.underDelivered, true, 'defects must cost delivery');
  });

  it('produces twenty DISTINCT questions', async () => {
    // A fixed script would collide with dedup on the second call and look
    // exactly like a banking bug.
    const { emitted } = await runFake('req-fake-distinct');
    assert.equal(new Set(emitted.map((q) => q.stemHash)).size, emitted.length);
    assert.equal(new Set(emitted.map((q) => q.factKey)).size, emitted.length);
  });

  it('still delivers on a second call that excludes everything from the first', async () => {
    const first = await runFake('req-fake-a');
    const second = await runFake('req-fake-b', {
      excludeFactKeys: first.emitted.map((q) => q.factKey),
      excludeStemHashes: first.emitted.map((q) => q.stemHash),
    });
    assert.ok(second.emitted.length > 0, 'a fixed script would deliver zero here');
  });

  it('is deterministic for the same seed tuple', async () => {
    const a = await runFake('req-fake-seed');
    const b = await runFake('req-fake-seed');
    assert.deepEqual(
      a.emitted.map((q) => q.stemHash),
      b.emitted.map((q) => q.stemHash),
    );
  });
});
