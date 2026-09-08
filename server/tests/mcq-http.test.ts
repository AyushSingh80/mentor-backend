/**
 * HTTP-layer tests for POST /mcq/generate.
 *
 * The Anthropic client is never reached: both model seams are replaced with
 * stubs, so no API key — real or otherwise — is ever used to make a call.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import supertest from 'supertest';

const dir = mkdtempSync(join(tmpdir(), 'upsc-mcq-'));
process.env.NODE_ENV = 'test';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-real';
process.env.MODEL_EVALUATION ??= 'eval-model-1';
process.env.MODEL_BULK ??= 'bulk-model-1';
process.env.APP_BEARER_TOKEN = 'test-token';
process.env.DAILY_REQUEST_CAP = '200';
process.env.MONTHLY_USD_CAP = '10';
process.env.ESTIMATED_EVAL_USD = '0.2';
process.env.MCQ_MONTHLY_USD_CAP = '8';
// This suite deliberately squeezes the sub-cap against a small pool to exercise
// the 429 path, which leaves almost nothing for evaluation. Saying so
// explicitly keeps `config.ts`'s boot assertion — the guard against a
// production misconfiguration that would starve evaluation — at full strength
// rather than weakening it to accommodate a fixture.
process.env.EVAL_RESERVED_FLOOR_USD = '0';
process.env.USAGE_FILE = join(dir, 'usage.json');

const { app } = await import('../src/app.js');
const { setMcqRunner, setVerificationRunner, ZERO_USAGE } = await import('../src/mcq/runner.js');
const { capStatus, releaseReservation, tryReserve } = await import('../src/usage.js');

type McqRunner = NonNullable<Parameters<typeof setMcqRunner>[0]>;
type VerificationRunner = NonNullable<Parameters<typeof setVerificationRunner>[0]>;
type Draft = Awaited<ReturnType<McqRunner>>['drafts'] extends (infer D)[] | null ? D : never;

const AUTH = 'Bearer test-token';
const agent = () => supertest(app);

after(() => rmSync(dir, { recursive: true, force: true }));

/** A leaked reservation ratchets the cap down until restart, so check always. */
afterEach(async () => {
  const caps = await capStatus();
  assert.equal(caps.inFlight, 0, 'a spend reservation leaked');
  assert.equal(caps.reservedUsd, 0, 'a dollar reservation leaked');
  setMcqRunner(null);
  setVerificationRunner(null);
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

/* ------------------------------------------------------------- stub runners */

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

function draft(n: number): Draft {
  const subject = SUBJECTS[(n - 1) % SUBJECTS.length] as string;
  return {
    form: 'statements_correct',
    stem: `Consider the following statements regarding ${subject}.\nWhich of the statements given above is/are correct?`,
    statements: [
      { index: 1, text: `Regarding ${subject}, a statutory basis exists.`, isTrue: true },
      { index: 2, text: `Regarding ${subject}, the executive is bound absolutely.`, isTrue: false },
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
  } as Draft;
}

interface StubOptions {
  delayMs?: number;
  failWith?: string;
  stopReason?: string;
  onGenerate?: () => void;
}

function stubRunners(options: StubOptions = {}): { generated: () => number } {
  let generateCalls = 0;

  const generate: McqRunner = async (request) => {
    generateCalls += 1;
    options.onGenerate?.();
    if (options.failWith) throw new Error(options.failWith);
    if (options.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
    if (request.signal.aborted) throw new Error('aborted');
    return {
      drafts: Array.from({ length: request.count }, (_, i) => draft(request.ordinalOffset + i + 1)),
      stopReason: options.stopReason ?? 'end_turn',
      usage: { ...ZERO_USAGE, inputTokens: 120, outputTokens: 340, cacheReadInputTokens: 80 },
      provenance: 'model',
    };
  };

  const verify: VerificationRunner = async (request) => {
    const parsed = JSON.parse(request.payload) as { questions: unknown[] };
    return {
      verdicts: parsed.questions.map((_q, i) => ({
        questionIndex: i,
        chosenIndex: 0,
        confidence: 'high' as const,
        ambiguous: false,
        timeDependent: false,
        factuallyDisputed: false,
      })),
      stopReason: 'end_turn',
      usage: { ...ZERO_USAGE, inputTokens: 60, outputTokens: 25 },
    };
  };

  setMcqRunner(generate);
  setVerificationRunner(verify);
  return { generated: () => generateCalls };
}

/**
 * The body the APP actually sends.
 *
 * Shape-for-shape `McqGenerateRequest` in `app/src/lib/mcq-api.ts`, which is
 * `JSON.stringify`d verbatim onto the wire. That is the point of this fixture:
 * it once described a `{paper, topic, difficulty, count}` body no client ever
 * sent, so every test here passed against a server that 400'd every real
 * request. `app/tests/mcq-request-contract.test.ts` holds the other half.
 *
 * One section of five, so a validation case stays readable. A real batch is
 * thirty questions across four to six sections — `BANK_RULES.maxSectionShare`
 * caps any one at a quarter — which `batchSpanningSections` below exercises.
 */
function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 'req-test-1',
    resume: false,
    batchSize: 5,
    sections: [
      {
        sectionKey: 'gs2:Indian Constitution',
        syllabusSlug: 'polity/federalism',
        syllabusSlugs: ['polity/federalism', 'polity/centre-state'],
        paper: 'gs2',
        label: 'Indian federalism and its working',
        count: 5,
        reason: 'first pass done, never drilled',
      },
    ],
    excludeStemHashes: [],
    promptVersion: 'mcq-v1',
    rationale: 'weakest three sections',
    ...overrides,
  };
}

/** One section of the fixture shape, for building multi-section batches. */
function section(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sectionKey: 'gs3:Economy',
    syllabusSlug: 'economy/budgeting',
    syllabusSlugs: ['economy/budgeting'],
    paper: 'gs3',
    label: 'Government budgeting',
    count: 5,
    reason: 'lowest accuracy',
    ...overrides,
  };
}

function post(body: Record<string, unknown>) {
  return agent().post('/mcq/generate').set('Authorization', AUTH).send(body);
}

/* --------------------------------------------------------------------- tests */

describe('POST /mcq/generate auth', () => {
  it('rejects with no token', async () => {
    const res = await agent().post('/mcq/generate').send(validBody()).expect(401);
    assert.deepEqual(res.body, { error: 'unauthorized' });
  });

  it('rejects a wrong token', async () => {
    await agent()
      .post('/mcq/generate')
      .set('Authorization', 'Bearer wrong-token-entirely')
      .send(validBody())
      .expect(401);
  });

  it('rejects a token of the same length as the real one', async () => {
    await agent()
      .post('/mcq/generate')
      .set('Authorization', `Bearer ${'x'.repeat('test-token'.length)}`)
      .send(validBody())
      .expect(401);
  });

  it('rejects a non-bearer scheme', async () => {
    await agent()
      .post('/mcq/generate')
      .set('Authorization', 'Basic test-token')
      .send(validBody())
      .expect(401);
  });

  it('protects the prompt reload route', async () => {
    await agent().post('/mcq-prompts/reload').expect(401);
    const res = await agent().post('/mcq-prompts/reload').set('Authorization', AUTH).expect(200);
    assert.match(res.body.mcq.promptVersion, /^[0-9a-f]{12}$/);
  });
});

describe('POST /mcq/generate body validation', () => {
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ['a missing requestId', { requestId: undefined }, /requestId is required/],
    ['no sections at all', { sections: [] }, /at least one section/],
    ['a non-array sections', { sections: 'gs2' }, /sections must be an array/],
    [
      'an invalid paper on a section',
      { sections: [section({ paper: 'gs9' })], batchSize: 5 },
      /sections\[0\]\.paper must be one of/,
    ],
    [
      'a missing syllabusSlug',
      { sections: [{ sectionKey: 'k', label: 'L', paper: 'gs2', count: 5 }], batchSize: 5 },
      /sections\[0\]\.syllabusSlug is required/,
    ],
    [
      'a missing label',
      {
        sections: [{ sectionKey: 'k', syllabusSlug: 's', paper: 'gs2', count: 5 }],
        batchSize: 5,
      },
      /sections\[0\]\.label is required/,
    ],
    [
      'a repeated sectionKey, which would dedup against two separate fact sets',
      { sections: [section({ count: 3 }), section({ count: 2 })], batchSize: 5 },
      /repeats sectionKey/,
    ],
    ['an invalid difficulty', { difficulty: 'brutal' }, /difficulty must be one of/],
    ['a batchSize below the floor', { batchSize: 4, sections: [section({ count: 4 })] }, /batchSize must be an integer between 5 and 30/],
    [
      'a batchSize above the ceiling',
      {
        batchSize: 31,
        sections: [section({ count: 30 }), section({ sectionKey: 'gs1:Society', count: 1 })],
      },
      /batchSize must be an integer between 5 and 30/,
    ],
    [
      'a section count above the ceiling',
      { batchSize: 31, sections: [section({ count: 31 })] },
      /sections\[0\]\.count must be an integer between 1 and 30/,
    ],
    ['a fractional batchSize', { batchSize: 7.5 }, /batchSize must be an integer/],
    [
      'a batchSize that disagrees with its own section counts',
      { batchSize: 20, sections: [section({ count: 5 })] },
      /does not equal the sum of section counts/,
    ],
    ['a non-array excludeFactKeys', { excludeFactKeys: 'nope' }, /must be an array of strings/],
    ['a non-string exclusion entry', { excludeStemHashes: [1, 2] }, /must contain only strings/],
  ];

  for (const [label, override, pattern] of cases) {
    it(`rejects ${label}`, async () => {
      const body = validBody(override);
      if (override.requestId === undefined && 'requestId' in override) delete body.requestId;
      const res = await post(body).expect(400);
      assert.equal(res.body.error, 'bad_request');
      assert.match(res.body.detail, pattern);
    });
  }

  it('rejects too many exclusions rather than accepting an unbounded list', async () => {
    const res = await post(
      validBody({ excludeFactKeys: Array.from({ length: 1001 }, (_, i) => `k${i}`) }),
    ).expect(400);
    assert.match(res.body.detail, /exceeds 1000 entries/);
  });

  it('rejects a malformed JSON body with 400, not 500', async () => {
    const res = await agent()
      .post('/mcq/generate')
      .set('Authorization', AUTH)
      .set('Content-Type', 'application/json')
      .send('{"requestId": ')
      .expect(400);
    assert.equal(res.body.error, 'bad_request');
  });

  it('rejects a body over 64kb with 413', async () => {
    const res = await agent()
      .post('/mcq/generate')
      .set('Authorization', AUTH)
      .send(validBody({ excludeFactKeys: [ 'k'.repeat(120) ].concat(
        Array.from({ length: 900 }, () => 'k'.repeat(120)),
      ) }))
      .expect(413);
    assert.equal(res.body.error, 'payload_too_large');
  });

  it('derives batchSize from the section counts when it is omitted', async () => {
    // The app always sends it and the two are cross-checked, so this is the
    // tolerant path rather than the normal one: a client that omits the total
    // gets the sum rather than a 400, because the sum is not ambiguous.
    stubRunners();
    const body = validBody({
      sections: [section({ count: 7 }), section({ sectionKey: 'gs1:Society', count: 6 })],
    });
    delete body.batchSize;
    const res = await post(body).expect(200);
    const meta = JSON.parse(parseSse(res.text)[0]!.data);
    assert.equal(meta.requested, 13);
    // Two sections, chunked at five: ceil(7/5) + ceil(6/5) = 2 + 2.
    assert.equal(meta.plannedChunks, 4);
    assert.equal(meta.sections, 2);
  });

  it('accepts a per-section count below the whole-batch floor', async () => {
    // `MIN_COUNT` asks whether a REQUEST is worth two model calls. A quota of
    // three inside a batch of twelve is a legitimate plan, and holding each
    // section to five would force the planner to lie about its own quotas.
    stubRunners();
    const body = validBody({
      batchSize: 12,
      sections: [
        section({ count: 3 }),
        section({ sectionKey: 'gs1:Society', count: 4 }),
        section({ sectionKey: 'gs4:Ethics', count: 5 }),
      ],
    });
    const res = await post(body).expect(200);
    const meta = JSON.parse(parseSse(res.text)[0]!.data);
    assert.equal(meta.requested, 12);
    assert.equal(meta.sections, 3);
  });
});

describe('POST /mcq/generate spend cap', () => {
  it('returns 429 once the shared pool is exhausted', async () => {
    const held: { endpoint: string; estimateUsd: number; units: number }[] = [];
    try {
      for (let i = 0; i < 100; i += 1) {
        const reservation = { endpoint: '/evaluate', estimateUsd: 0.2, units: 1 };
        const admitted = await tryReserve(reservation);
        if (!admitted.ok) break;
        held.push(reservation);
      }
      const caps = await capStatus();
      assert.equal(caps.allowed, false);
      // The invariant that keeps the old behaviour intact: with every hold
      // taking the default estimate, the dollar reservation is exactly the
      // unit count times the per-evaluation estimate, so `inFlight` still
      // means what it always meant.
      assert.ok(Math.abs(caps.reservedUsd - caps.inFlight * 0.2) < 1e-9);

      const res = await post(validBody()).expect(429);
      assert.equal(res.body.error, 'spend_cap_reached');
      assert.equal(typeof res.body.detail, 'string');
      assert.equal(res.body.caps.allowed, false);
    } finally {
      for (const reservation of held) releaseReservation(reservation);
    }
  });

  it('refuses MCQ on its own sub-cap while leaving evaluation admissible', async () => {
    // The reason the sub-cap exists: a runaway banking loop must not block
    // answer evaluation, which is the higher-value feature.
    const hold = { endpoint: '/mcq/generate', estimateUsd: 8, units: 1 };
    const admitted = await tryReserve(hold);
    assert.equal(admitted.ok, true);
    try {
      const res = await post(validBody()).expect(429);
      assert.match(res.body.detail, /Question-bank spend cap reached/);
      assert.match(res.body.detail, /Answer evaluation is unaffected/);

      const evaluation = await capStatus({ endpoint: '/evaluate' });
      assert.equal(evaluation.allowed, true, 'evaluation must still be admissible');
    } finally {
      releaseReservation(hold);
    }
  });
});

describe('POST /mcq/generate SSE stream', () => {
  it('frames events in the required order, byte-compatibly with the client', async () => {
    stubRunners();
    const res = await post(validBody()).expect(200);

    assert.equal(res.headers['content-type'], 'text/event-stream');
    assert.equal(res.headers['cache-control'], 'no-cache, no-transform');
    assert.equal(res.headers['x-accel-buffering'], 'no');
    assert.match(res.text, /^event: meta\ndata: \{"requestId":/);
    assert.ok(res.text.endsWith('event: done\ndata: {"ok":true}\n\n'));
    assert.equal(res.text.includes('\r'), false, 'frames must use bare LF');

    const frames = parseSse(res.text);
    const order = frames.map((f) => f.event);

    assert.deepEqual(
      [...new Set(order)],
      ['meta', 'progress', 'question', 'summary', 'usage', 'done'],
      'events must arrive as meta, (progress question*)*, summary, usage, done',
    );
    assert.equal(order[0], 'meta');
    // One `progress` per section, emitted BEFORE its two model calls: a section
    // that rejects everything it generates emits nothing else for a minute or
    // more, and the client's idle timer cuts a stream that goes silent.
    assert.equal(order[1], 'progress');
    assert.equal(order.at(-1), 'done');
    assert.equal(order.at(-2), 'usage');
    assert.equal(order.at(-3), 'summary');
    assert.ok(order.slice(1, -3).every((e) => e === 'question' || e === 'progress'));

    const meta = JSON.parse(frames[0]!.data);
    assert.equal(meta.requested, 5);
    assert.equal(meta.sections, 1);
    // Both names, because the app reads `batchId` and falls back to the request
    // id. Sending both makes the fallback a safety net, not the normal path.
    assert.equal(meta.batchId, 'req-test-1');
    assert.equal(meta.requestId, 'req-test-1');
    assert.match(meta.promptVersion, /^[0-9a-f]{12}$/);
    assert.match(meta.verifierVersion, /^[0-9a-f]{12}$/);

    const question = JSON.parse(frames.find((f) => f.event === 'question')!.data);
    assert.equal(question.answerIndex, 0);
    assert.equal(question.options.length, 4);
    assert.equal(question.eliminationRationale.length, 4);
    assert.equal(question.provenance, 'model');
    assert.equal(question.topicSlug, 'polity/federalism');
    assert.match(question.stemHash, /^[0-9a-f]{16}$/);
    assert.match(question.simHash, /^[0-9a-f]{16}$/);
    assert.match(question.promptVersion, /^[0-9a-f]{12}$/);
    assert.equal(question.verification.chosenIndex, 0);

    const summary = JSON.parse(frames.find((f) => f.event === 'summary')!.data);
    assert.equal(summary.requested, 5);
    assert.equal(summary.delivered, 5);
    assert.equal(summary.underDelivered, false);
    assert.equal(summary.keyDisagreements, 0);

    const usage = JSON.parse(frames.find((f) => f.event === 'usage')!.data);
    assert.ok(usage.inputTokens > 0);
    assert.ok(usage.outputTokens > 0);
    assert.equal(typeof usage.mcqMonthUsd, 'number');
  });

  it('emits no question frames at all when every chunk truncates', async () => {
    // A truncated chunk is unusable in whole. Three questions from a
    // half-parsed document is the outcome this endpoint must never produce.
    stubRunners({ stopReason: 'max_tokens' });
    const res = await post(validBody({ count: 5 })).expect(200);

    const frames = parseSse(res.text);
    assert.equal(frames.filter((f) => f.event === 'question').length, 0);

    const summary = JSON.parse(frames.find((f) => f.event === 'summary')!.data);
    assert.equal(summary.delivered, 0);
    assert.equal(summary.underDelivered, true);
    assert.ok(summary.chunksTruncated > 0);
    // Still terminates cleanly: under-delivery is not an error.
    assert.equal(frames.at(-1)?.event, 'done');
  });

  it('ends with a generic terminal error frame that never leaks err.message', async () => {
    stubRunners({ failWith: 'connect ECONNREFUSED 10.0.0.1:443' });
    const res = await post(validBody()).expect(200);

    const frames = parseSse(res.text);
    // The `progress` frame for section one is emitted before its model call, so
    // it precedes the failure. That ordering is the point of emitting it there.
    assert.deepEqual(
      frames.map((f) => f.event),
      ['meta', 'progress', 'error'],
    );
    assert.deepEqual(JSON.parse(frames.at(-1)!.data), {
      message: 'Question generation failed. Check the server logs.',
    });
    assert.equal(res.text.includes('ECONNREFUSED'), false, 'internal detail must not be echoed');
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

describe('POST /mcq/generate disconnect', () => {
  it('stops starting chunks and releases the reservation when the client leaves', async () => {
    // A batch is eight model calls, not one. Aborting the in-flight call is
    // only half the job: without refusing to start the next chunk, killing the
    // app at question five still pays for six through twenty and delivers none.
    let started = 0;
    stubRunners({ delayMs: 60, onGenerate: () => { started += 1; } });

    const body = JSON.stringify(validBody({ count: 30, requestId: 'req-disconnect' }));

    await withServer(
      (port) =>
        new Promise<void>((resolve) => {
          const req = httpRequest(
            {
              port,
              path: '/mcq/generate',
              method: 'POST',
              headers: {
                authorization: AUTH,
                'content-type': 'application/json',
                'content-length': String(Buffer.byteLength(body)),
              },
            },
            (res) => {
              res.once('data', () => {
                // Walk away in the middle of the batch.
                setTimeout(() => req.destroy(), 90);
              });
              res.on('error', () => undefined);
            },
          );
          req.on('error', () => undefined);
          req.end(body);
          // Long enough that all six planned chunks would have run.
          setTimeout(resolve, 700);
        }),
    );

    const startedAtDisconnect = started;
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(
      started,
      startedAtDisconnect,
      'a chunk was started after the client had already gone',
    );
    assert.ok(started < 6, `ran ${started} of 6 planned chunks after a disconnect`);
    assert.equal((await capStatus()).inFlight, 0, 'the reservation must be released');
    assert.equal((await capStatus()).reservedUsd, 0, 'the dollar hold must be released');
  });
});
