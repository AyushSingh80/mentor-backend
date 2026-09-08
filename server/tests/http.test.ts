/**
 * HTTP-layer tests for the Express app.
 *
 * The Anthropic client is never reached: `setEvaluationRunner` replaces the
 * model boundary with a scripted stub, so no API key — real or otherwise — is
 * ever used to make a call. The key in the environment below is a placeholder
 * that only exists because config.ts validates it at import time.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import supertest from 'supertest';

// Config validates at import time, so the environment must be set first.
const dir = mkdtempSync(join(tmpdir(), 'upsc-http-'));
process.env.NODE_ENV = 'test';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-real';
process.env.MODEL_EVALUATION ??= 'eval-model-1';
process.env.MODEL_BULK ??= 'bulk-model-1';
process.env.APP_BEARER_TOKEN = 'test-token';
process.env.DAILY_REQUEST_CAP = '6';
process.env.MONTHLY_USD_CAP = '10';
process.env.ESTIMATED_EVAL_USD = '0.2';
process.env.USAGE_FILE = join(dir, 'usage.json');

const { app } = await import('../src/app.js');
const { setEvaluationRunner } = await import('../src/routes/evaluate.js');
const { capStatus, releaseReservation, tryReserve } = await import('../src/usage.js');
const { MAX_TOTAL_BYTES, peakUploadBytes, resetPeakUploadBytes } = await import(
  '../src/upload.js'
);

type EvaluationRunner = Parameters<typeof setEvaluationRunner>[0];

const TOKEN = 'test-token';
const AUTH = `Bearer ${TOKEN}`;

after(() => rmSync(dir, { recursive: true, force: true }));

/** A leaked reservation ratchets the cap down until restart, so check always. */
afterEach(async () => {
  const caps = await capStatus();
  assert.equal(caps.inFlight, 0, 'a spend reservation leaked');
});

const agent = () => supertest(app);

function png(bytes = 32): Buffer {
  return Buffer.alloc(bytes, 7);
}

/** A minimal valid evaluate request, before per-test tweaks. */
function validEvaluate() {
  return agent()
    .post('/evaluate')
    .set('Authorization', AUTH)
    .field('paper', 'gs1')
    .field('question', 'Discuss the causes of the 1857 revolt.')
    .field('wordLimit', '250');
}

/* ---------------------------------------------------------------- SSE parser */

interface Frame {
  event: string;
  data: string;
}

/**
 * Mirrors app/src/lib/sse.ts. Kept as a copy rather than an import because the
 * point is to prove the SERVER's bytes are what that parser expects; if the two
 * ever drift, this test is what catches it.
 */
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

interface StubScript {
  tokens?: string[];
  inputTokens?: number;
  outputTokens?: number;
  /** Milliseconds between tokens; lets a test disconnect mid-stream. */
  delayMs?: number;
  failWith?: string;
}

function stubRunner(script: StubScript): NonNullable<EvaluationRunner> {
  return () => {
    const textListeners: ((delta: string) => void)[] = [];
    const usageListeners: ((counts: { inputTokens?: number; outputTokens?: number }) => void)[] =
      [];
    let abort: (() => void) | null = null;

    return {
      onText(listener) {
        textListeners.push(listener);
      },
      onUsage(listener) {
        usageListeners.push(listener);
      },
      abort() {
        abort?.();
      },
      finalUsage() {
        return new Promise((resolve, reject) => {
          let cancelled = false;
          abort = () => {
            cancelled = true;
            reject(new Error('aborted by client'));
          };

          void (async () => {
            if (script.failWith) {
              reject(new Error(script.failWith));
              return;
            }
            for (const listener of usageListeners) {
              listener({ inputTokens: script.inputTokens ?? 1000 });
            }
            for (const token of script.tokens ?? []) {
              if (cancelled) return;
              if (script.delayMs) await new Promise((r) => setTimeout(r, script.delayMs));
              if (cancelled) return;
              for (const listener of textListeners) listener(token);
            }
            if (cancelled) return;
            resolve({
              inputTokens: script.inputTokens ?? 1000,
              outputTokens: script.outputTokens ?? 500,
            });
          })();
        });
      },
    };
  };
}

/* --------------------------------------------------------------------- tests */

describe('GET /health', () => {
  it('is reachable without a token and reports the shape the app expects', async () => {
    const res = await agent().get('/health').expect(200);

    assert.equal(res.body.ok, true);
    assert.equal(typeof res.body.timezone, 'string');
    // Exact keys on purpose: `HealthResponse` in app/src/lib/api.ts is the
    // contract, and a silently-added field is a contract change nobody reviewed.
    assert.deepEqual(Object.keys(res.body).sort(), [
      'ca',
      'caps',
      'drills',
      'interview',
      'mcq',
      'modelConfigured',
      'ok',
      'rubrics',
      'timezone',
    ]);

    // HealthResponse in app/src/lib/api.ts reads exactly these five cap fields.
    assert.deepEqual(Object.keys(res.body.caps).sort(), [
      'allowed',
      'dailyRequestCap',
      'monthUsd',
      'monthlyCapUsd',
      'todayRequests',
    ]);
    assert.equal(typeof res.body.caps.allowed, 'boolean');
    assert.equal(typeof res.body.caps.monthUsd, 'number');

    // Rubric versions are content hashes, one per paper.
    assert.deepEqual(Object.keys(res.body.rubrics).sort(), [
      'anthro_p1',
      'anthro_p2',
      'essay',
      'gs1',
      'gs2',
      'gs3',
      'gs4',
    ]);
    for (const version of Object.values(res.body.rubrics)) {
      assert.match(version as string, /^[0-9a-f]{12}$/);
    }

    // MCQ prompt versions are compiled from disk on every health check, so a
    // build that failed to copy src/mcq/prompts/*.md surfaces here rather than
    // on the first paid request of the month.
    assert.deepEqual(Object.keys(res.body.mcq).sort(), ['promptVersion', 'verifierVersion']);
    assert.match(res.body.mcq.promptVersion, /^[0-9a-f]{12}$/);
    assert.match(res.body.mcq.verifierVersion, /^[0-9a-f]{12}$/);
  });

  it('stays unauthenticated even when a bad token is offered', async () => {
    await agent().get('/health').set('Authorization', 'Bearer nope').expect(200);
  });
});

describe('bearer auth', () => {
  it('rejects GET /usage with no token', async () => {
    const res = await agent().get('/usage').expect(401);
    assert.deepEqual(res.body, { error: 'unauthorized' });
  });

  it('rejects GET /usage with a wrong token', async () => {
    const res = await agent()
      .get('/usage')
      .set('Authorization', 'Bearer wrong-token-entirely')
      .expect(401);
    assert.deepEqual(res.body, { error: 'unauthorized' });
  });

  it('rejects a token of the same length as the real one', async () => {
    // Guards the constant-time comparison: same length means timingSafeEqual
    // actually runs rather than short-circuiting on the length pre-check.
    const sameLength = 'x'.repeat(TOKEN.length);
    assert.equal(sameLength.length, TOKEN.length);
    await agent().get('/usage').set('Authorization', `Bearer ${sameLength}`).expect(401);
  });

  it('rejects a non-bearer scheme', async () => {
    await agent().get('/usage').set('Authorization', `Basic ${TOKEN}`).expect(401);
  });

  it('accepts GET /usage with the correct token', async () => {
    const res = await agent().get('/usage').set('Authorization', AUTH).expect(200);
    assert.equal(typeof res.body.timezone, 'string');
    assert.ok(Array.isArray(res.body.last30Days));
    assert.equal(typeof res.body.caps.allowed, 'boolean');
  });

  it('protects POST /evaluate', async () => {
    await agent().post('/evaluate').expect(401);
  });

  it('protects the /rubrics prefix and reloads with a token', async () => {
    await agent().post('/rubrics/reload').expect(401);
    const res = await agent().post('/rubrics/reload').set('Authorization', AUTH).expect(200);
    assert.equal(res.body.ok, true);
    assert.match(res.body.rubrics.gs1, /^[0-9a-f]{12}$/);
  });

  it('answers unknown routes with a generic 404', async () => {
    const res = await agent().get('/nope').expect(404);
    assert.deepEqual(res.body, { error: 'not_found' });
  });
});

describe('POST /evaluate validation', () => {
  it('rejects a non-multipart body', async () => {
    const res = await agent()
      .post('/evaluate')
      .set('Authorization', AUTH)
      .send({ paper: 'gs1' })
      .expect(400);
    assert.equal(res.body.error, 'bad_request');
  });

  it('rejects an invalid paper', async () => {
    const res = await agent()
      .post('/evaluate')
      .set('Authorization', AUTH)
      .field('paper', 'gs9')
      .field('question', 'Discuss the causes of the 1857 revolt.')
      .attach('files', png(), { filename: 'page.png', contentType: 'image/png' })
      .expect(400);
    assert.equal(res.body.error, 'bad_request');
    assert.match(res.body.detail, /paper must be one of/);
  });

  it('rejects a missing question', async () => {
    const res = await agent()
      .post('/evaluate')
      .set('Authorization', AUTH)
      .field('paper', 'gs1')
      .attach('files', png(), { filename: 'page.png', contentType: 'image/png' })
      .expect(400);
    assert.match(res.body.detail, /question is required/);
  });

  it('rejects a question shorter than 5 characters', async () => {
    const res = await agent()
      .post('/evaluate')
      .set('Authorization', AUTH)
      .field('paper', 'gs1')
      .field('question', ' hi ')
      .attach('files', png(), { filename: 'page.png', contentType: 'image/png' })
      .expect(400);
    assert.match(res.body.detail, /question is required/);
  });

  it('rejects a question longer than 2000 characters', async () => {
    const res = await agent()
      .post('/evaluate')
      .set('Authorization', AUTH)
      .field('paper', 'gs1')
      .field('question', 'q'.repeat(2001))
      .field('wordLimit', '250')
      .attach('files', png(), { filename: 'page.png', contentType: 'image/png' })
      .expect(400);
    assert.match(res.body.detail, /question exceeds 2000 characters/);
  });

  it('rejects a directiveWord longer than 64 characters', async () => {
    const res = await validEvaluate()
      .field('directiveWord', 'd'.repeat(65))
      .attach('files', png(), { filename: 'page.png', contentType: 'image/png' })
      .expect(400);
    assert.match(res.body.detail, /directiveWord exceeds 64 characters/);
  });

  it('rejects a previousAttempt longer than 20000 characters', async () => {
    const res = await validEvaluate()
      .field('previousAttempt', 'p'.repeat(20_001))
      .attach('files', png(), { filename: 'page.png', contentType: 'image/png' })
      .expect(400);
    assert.match(res.body.detail, /previousAttempt exceeds 20000 characters/);
  });

  it('rejects a non-positive wordLimit', async () => {
    const res = await agent()
      .post('/evaluate')
      .set('Authorization', AUTH)
      .field('paper', 'gs1')
      .field('question', 'Discuss the causes of the 1857 revolt.')
      .field('wordLimit', '0')
      .attach('files', png(), { filename: 'page.png', contentType: 'image/png' })
      .expect(400);
    assert.match(res.body.detail, /wordLimit must be a positive number/);
  });

  it('rejects zero files', async () => {
    const res = await validEvaluate().expect(400);
    assert.match(res.body.detail, /at least one page image or PDF is required/);
  });

  it('rejects a disallowed mime type', async () => {
    const res = await validEvaluate()
      .attach('files', Buffer.from('not an image'), {
        filename: 'notes.txt',
        contentType: 'text/plain',
      })
      .expect(400);
    assert.equal(res.body.error, 'bad_request');
    assert.match(res.body.detail, /unsupported file type text\/plain/);
  });

  it('rejects an svg, which is an image but not on the allow-list', async () => {
    const res = await validEvaluate()
      .attach('files', Buffer.from('<svg/>'), {
        filename: 'page.svg',
        contentType: 'image/svg+xml',
      })
      .expect(400);
    assert.match(res.body.detail, /unsupported file type/);
  });

  it('rejects more than 12 files', async () => {
    let req = validEvaluate();
    for (let i = 0; i < 13; i += 1) {
      req = req.attach('files', png(), { filename: `page-${i}.png`, contentType: 'image/png' });
    }
    const res = await req.expect(400);
    assert.equal(res.body.error, 'bad_request');
  });

  it('rejects a file field that is not called "files"', async () => {
    const res = await validEvaluate()
      .attach('sneaky', png(), { filename: 'page.png', contentType: 'image/png' })
      .expect(400);
    assert.equal(res.body.error, 'bad_request');
  });
});

describe('POST /evaluate size limits', () => {
  it('rejects a single file over 8MB with 413', async () => {
    const res = await validEvaluate()
      .attach('files', Buffer.alloc(9 * 1024 * 1024, 1), {
        filename: 'huge.png',
        contentType: 'image/png',
      })
      .expect(413);
    assert.equal(res.body.error, 'payload_too_large');
  });

  it('rejects 26MB split across twelve individually-legal files with 413', async () => {
    // Every file is 2.2MB — well under the 8MB per-file cap — and there are
    // exactly 12 of them, so neither of multer's own limits fires. Only the
    // running per-request total catches this.
    resetPeakUploadBytes();

    let req = validEvaluate();
    for (let i = 0; i < 12; i += 1) {
      req = req.attach('files', Buffer.alloc(2_200_000, 1), {
        filename: `page-${i}.png`,
        contentType: 'image/png',
      });
    }
    const res = await req.expect(413);
    assert.equal(res.body.error, 'payload_too_large');
    assert.match(res.body.detail, /total upload exceeds 25MB/);

    assertRefusedMidStream();
  });
});

/**
 * The status code alone does not prove the body was refused while streaming:
 * the post-parse re-sum returns the same 413 having already buffered every
 * byte. Only the high-water mark distinguishes the two.
 */
function assertRefusedMidStream(): void {
  const peak = peakUploadBytes();
  assert.ok(peak > 0, 'the streaming total guard never ran — the body was buffered first');
  assert.ok(
    peak <= MAX_TOTAL_BYTES + 1024 * 1024,
    `buffered ${peak} bytes before refusing; the streaming guard must stop at ${MAX_TOTAL_BYTES}`,
  );
}

/* ------------------------------------------ raw-socket cases supertest cannot do */

function boundaryBody(fileCount: number, fileBytes: number, boundary: string): Buffer {
  const parts: Buffer[] = [];
  const field = (name: string, value: string): Buffer =>
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    );

  parts.push(field('paper', 'gs1'));
  parts.push(field('question', 'Discuss the causes of the 1857 revolt.'));
  parts.push(field('wordLimit', '250'));

  for (let i = 0; i < fileCount; i += 1) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="p${i}.png"\r\n` +
          `Content-Type: image/png\r\n\r\n`,
      ),
    );
    parts.push(Buffer.alloc(fileBytes, 1));
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(parts);
}

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

describe('POST /evaluate size limits over a raw socket', () => {
  it('rejects a 26MB chunked body that carries no Content-Length', async () => {
    const boundary = '----upscTestChunked';
    const body = boundaryBody(12, 2_200_000, boundary);
    resetPeakUploadBytes();

    const result = await withServer(
      (port) =>
        new Promise<{ status: number; text: string }>((resolve, reject) => {
          const req = httpRequest(
            {
              port,
              path: '/evaluate',
              method: 'POST',
              headers: {
                authorization: AUTH,
                'content-type': `multipart/form-data; boundary=${boundary}`,
                // No content-length: the only defence left is the per-chunk
                // running total inside the storage engine.
                'transfer-encoding': 'chunked',
              },
            },
            (res) => {
              let text = '';
              res.setEncoding('utf8');
              res.on('data', (c: string) => {
                text += c;
              });
              res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
            },
          );
          req.on('error', reject);
          // Write in slices so the body really does stream.
          for (let offset = 0; offset < body.length; offset += 512 * 1024) {
            req.write(body.subarray(offset, offset + 512 * 1024));
          }
          req.end();
        }),
    );

    assert.equal(result.status, 413);
    assert.equal(JSON.parse(result.text).error, 'payload_too_large');
    // No Content-Length was sent, so layer 1 could not have fired: this is the
    // per-chunk running total or nothing.
    assertRefusedMidStream();
  });

  it('refuses a declared Content-Length over 28MB before reading the body', async () => {
    const boundary = '----upscTestDeclared';

    const result = await withServer(
      (port) =>
        new Promise<{ status: number; text: string }>((resolve, reject) => {
          const req = httpRequest(
            {
              port,
              path: '/evaluate',
              method: 'POST',
              headers: {
                authorization: AUTH,
                'content-type': `multipart/form-data; boundary=${boundary}`,
                'content-length': String(64 * 1024 * 1024),
              },
            },
            (res) => {
              let text = '';
              res.setEncoding('utf8');
              res.on('data', (c: string) => {
                text += c;
              });
              const finish = () => resolve({ status: res.statusCode ?? 0, text });
              res.on('end', finish);
              res.on('close', finish);
            },
          );
          req.on('error', () => undefined);
          // Deliberately never sends the 64MB it promised: the refusal must
          // come from the header alone, with nothing buffered.
          req.write(Buffer.alloc(1024, 1));
        }),
    );

    assert.equal(result.status, 413);
    assert.equal(JSON.parse(result.text).detail, 'Request body exceeds 28MB.');
  });
});

describe('POST /evaluate spend cap', () => {
  it('returns 429 once the cap is exhausted', async () => {
    const held: number[] = [];
    try {
      for (let i = 0; i < 100; i += 1) {
        const reservation = await tryReserve();
        if (!reservation.ok) break;
        held.push(i);
      }
      assert.ok(held.length > 0, 'expected to be able to reserve at least once');
      assert.equal((await capStatus()).allowed, false);

      const res = await validEvaluate()
        .attach('files', png(), { filename: 'page.png', contentType: 'image/png' })
        .expect(429);

      assert.equal(res.body.error, 'spend_cap_reached');
      assert.equal(typeof res.body.detail, 'string');
      assert.equal(res.body.caps.allowed, false);
    } finally {
      for (const _ of held) releaseReservation();
    }
  });
});

describe('POST /evaluate SSE stream', () => {
  afterEach(() => setEvaluationRunner(null));

  it('frames events in order and byte-compatibly with the client parser', async () => {
    setEvaluationRunner(
      stubRunner({
        tokens: ['Your intro ', 'is weak.\n\n```json\n{"total":6,"max":10}\n```'],
        inputTokens: 1234,
        outputTokens: 567,
      }),
    );

    const res = await validEvaluate()
      .attach('files', png(), { filename: 'page.png', contentType: 'image/png' })
      .attach('files', Buffer.from('%PDF-1.4'), {
        filename: 'page2.pdf',
        contentType: 'application/pdf',
      })
      .expect(200);

    assert.equal(res.headers['content-type'], 'text/event-stream');
    assert.equal(res.headers['cache-control'], 'no-cache, no-transform');
    assert.equal(res.headers['connection'], 'keep-alive');
    assert.equal(res.headers['x-accel-buffering'], 'no');

    // Raw framing: `event: <name>\ndata: <json>\n\n`, nothing else.
    assert.match(res.text, /^event: meta\ndata: \{"model":/);
    assert.ok(res.text.endsWith('event: done\ndata: {"ok":true}\n\n'));
    assert.equal(res.text.includes('\r'), false, 'frames must use bare LF');

    const frames = parseSse(res.text);
    const order = frames.map((f) => f.event);

    assert.deepEqual(
      [...new Set(order)],
      ['meta', 'token', 'scores', 'usage', 'done'],
      'events must arrive as meta, token*, scores, usage, done',
    );
    // Every token frame sits between meta and scores.
    assert.equal(order[0], 'meta');
    assert.equal(order.at(-1), 'done');
    assert.equal(order.at(-2), 'usage');
    assert.equal(order.at(-3), 'scores');
    assert.ok(order.slice(1, -3).every((e) => e === 'token'));

    const meta = JSON.parse(frames[0]!.data);
    assert.equal(meta.paper, 'gs1');
    assert.equal(meta.pages, 2);
    assert.match(meta.rubricVersion, /^[0-9a-f]{12}$/);
    assert.equal(meta.rubricName, 'gs');

    const scores = JSON.parse(frames.find((f) => f.event === 'scores')!.data);
    assert.deepEqual(scores.scores, { total: 6, max: 10 });
    assert.equal(scores.parsed, true);
    assert.equal(scores.feedbackMarkdown, 'Your intro is weak.');

    const usage = JSON.parse(frames.find((f) => f.event === 'usage')!.data);
    assert.equal(usage.inputTokens, 1234);
    assert.equal(usage.outputTokens, 567);
    assert.ok(usage.estCostUsd > 0);
    assert.equal(usage.monthlyCapUsd, 10);
  });

  it('ends with a generic terminal error frame that never leaks err.message', async () => {
    setEvaluationRunner(stubRunner({ failWith: 'connect ECONNREFUSED 10.0.0.1:443' }));

    const res = await validEvaluate()
      .attach('files', png(), { filename: 'page.png', contentType: 'image/png' })
      .expect(200);

    const frames = parseSse(res.text);
    assert.deepEqual(
      frames.map((f) => f.event),
      ['meta', 'error'],
    );
    assert.deepEqual(JSON.parse(frames[1]!.data), {
      message: 'Evaluation failed. Check the server logs.',
    });
    assert.equal(res.text.includes('ECONNREFUSED'), false, 'internal detail must not be echoed');
  });

  it('survives a client disconnect mid-stream without leaking the reservation', async () => {
    setEvaluationRunner(
      stubRunner({ tokens: Array.from({ length: 40 }, (_, i) => `t${i} `), delayMs: 25 }),
    );

    const boundary = '----upscTestAbort';
    const body = boundaryBody(1, 64, boundary);

    await withServer(
      (port) =>
        new Promise<void>((resolve) => {
          const req = httpRequest(
            {
              port,
              path: '/evaluate',
              method: 'POST',
              headers: {
                authorization: AUTH,
                'content-type': `multipart/form-data; boundary=${boundary}`,
                'content-length': String(body.length),
              },
            },
            (res) => {
              res.once('data', () => {
                // Walk away in the middle of the stream.
                setTimeout(() => req.destroy(), 40);
              });
              res.on('error', () => undefined);
            },
          );
          req.on('error', () => undefined);
          req.end(body);
          // Give the handler time to notice, abort, and run its finally.
          setTimeout(resolve, 600);
        }),
    );

    assert.equal((await capStatus()).inFlight, 0, 'the reservation must be released');
  });
});
