/**
 * End-to-end: real server process, real HTTP, real client parser, real mapper.
 *
 * Everything except the model is genuine. The server is spawned as a child
 * process with `EVAL_RUNNER=fake`, so the multipart intake, SSE framing, spend
 * accounting and cap release are all the production code paths — only the
 * Anthropic call is scripted. No API key, no tokens, no spend.
 *
 * What this proves that the per-package tests cannot: that the server's
 * hand-rolled SSE frames are parseable by the app's own `SSEParser`, and that
 * what comes out the other side maps cleanly into the exact row shape the
 * database expects. Those two packages have separate tsconfigs and separate
 * node_modules; nothing else checks that they actually agree.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { SSEParser } from '../src/lib/sse';
import { toEvaluationInput } from '../src/lib/evaluation-map';
import type { EvaluationMeta, EvaluationScores } from '../src/lib/api';

const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'e2e-token-not-a-real-secret';
/**
 * Resolved from the working directory rather than `import.meta.dirname`: the
 * tests tsconfig emits CommonJS, where `import.meta` is a type error. `npm test`
 * always runs from the app package root.
 */
const SERVER_DIR = resolve(process.cwd(), '..', 'server');

let server: ChildProcess;
let dataDir: string;

/** A 1x1 PNG. Real bytes with a real signature, so the mime check is genuine. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Everything the child wrote to stderr, kept so a boot failure can be reported
 * as itself rather than as a health timeout.
 *
 * The child used to run with `stdio: 'ignore'`, and a server that refused to
 * start — a missing required env var, a spend cap that fails its boot
 * assertion — surfaced only as "did not become healthy in time" thirty seconds
 * later. The one line that said why was thrown away. Swallowing a subprocess's
 * stderr turns every startup error into the same uninformative timeout.
 */
let serverStderr = '';

async function waitForHealth(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // A child that has already exited will never become healthy. Failing now
    // with its own message beats waiting out the full deadline for a verdict
    // that is already decided.
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(
        `server exited before becoming healthy (code ${server.exitCode}):\n${serverStderr.trim()}`,
      );
    }
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server did not become healthy in time:\n${serverStderr.trim()}`);
}

before(async () => {
  assert.ok(
    existsSync(join(SERVER_DIR, 'src', 'index.ts')),
    `server package not found at ${SERVER_DIR} — run this from the app package root`,
  );
  dataDir = mkdtempSync(join(tmpdir(), 'upsc-e2e-'));

  server = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      EVAL_RUNNER: 'fake',
      // Small but non-zero, so "did tokens actually stream?" is answerable.
      FAKE_RUNNER_DELAY_MS: '2',
      PORT: String(PORT),
      ANTHROPIC_API_KEY: 'sk-ant-e2e-not-real',
      // Required, and with no default in `config.ts` on purpose. Arbitrary
      // here: `EVAL_RUNNER=fake` never sends them anywhere, but the server
      // refuses to boot without them and the meta frame echoes them back.
      MODEL_EVALUATION: 'eval-model-1',
      MODEL_BULK: 'bulk-model-1',
      APP_BEARER_TOKEN: TOKEN,
      USAGE_FILE: join(dataDir, 'usage.json'),
      MONTHLY_USD_CAP: '5',
      DAILY_REQUEST_CAP: '20',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr?.on('data', (chunk: Buffer) => {
    serverStderr += chunk.toString();
  });

  await waitForHealth();
});

after(() => {
  server?.kill('SIGTERM');
  rmSync(dataDir, { recursive: true, force: true });
});

interface StreamOutcome {
  meta: EvaluationMeta | null;
  tokens: string[];
  scores: EvaluationScores | null;
  feedbackMarkdown: string;
  usage: { inputTokens: number; outputTokens: number; estCostUsd: number } | null;
  done: boolean;
  error: string | null;
  firstTokenAt: number | null;
  lastTokenAt: number | null;
  status: number;
  contentType: string | null;
}

async function evaluate(form: FormData, token = TOKEN): Promise<StreamOutcome> {
  const res = await fetch(`${BASE}/evaluate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  const outcome: StreamOutcome = {
    meta: null,
    tokens: [],
    scores: null,
    feedbackMarkdown: '',
    usage: null,
    done: false,
    error: null,
    firstTokenAt: null,
    lastTokenAt: null,
    status: res.status,
    contentType: res.headers.get('content-type'),
  };

  if (!res.ok || !res.body) return outcome;

  // The app's real parser, byte-for-byte the one the phone runs.
  const parser = new SSEParser();
  const decoder = new TextDecoder();
  const reader = res.body.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
      const payload = JSON.parse(frame.data);
      switch (frame.event) {
        case 'meta':
          outcome.meta = payload;
          break;
        case 'token':
          outcome.tokens.push(payload.text);
          outcome.firstTokenAt ??= Date.now();
          outcome.lastTokenAt = Date.now();
          break;
        case 'scores':
          outcome.scores = payload.scores;
          outcome.feedbackMarkdown = payload.feedbackMarkdown;
          break;
        case 'usage':
          outcome.usage = payload;
          break;
        case 'done':
          outcome.done = true;
          break;
        case 'error':
          outcome.error = payload.message;
          break;
      }
    }
  }

  return outcome;
}

function answerForm(overrides: Record<string, string> = {}, files = 1): FormData {
  const form = new FormData();
  form.set('paper', overrides.paper ?? 'gs2');
  form.set(
    'question',
    overrides.question ??
      'Critically examine the role of the Finance Commission in Indian fiscal federalism.',
  );
  form.set('directiveWord', overrides.directiveWord ?? 'critically examine');
  form.set('wordLimit', overrides.wordLimit ?? '250');
  for (let i = 0; i < files; i += 1) {
    form.append('files', new Blob([PNG], { type: 'image/png' }), `page-${i + 1}.png`);
  }
  return form;
}

describe('end to end: capture -> server -> stream -> parse -> map', () => {
  it('streams an evaluation the app can parse and store', async () => {
    const outcome = await evaluate(answerForm({}, 2));

    assert.equal(outcome.status, 200);
    assert.match(outcome.contentType ?? '', /text\/event-stream/);

    // Frame order and completeness.
    assert.ok(outcome.meta, 'a meta frame must arrive first');
    assert.ok(outcome.tokens.length > 5, `expected many token frames, got ${outcome.tokens.length}`);
    assert.ok(outcome.scores, 'the score block must parse');
    assert.ok(outcome.usage, 'usage must be reported');
    assert.equal(outcome.done, true, 'the terminal done frame must arrive');
    assert.equal(outcome.error, null);

    // `pages` is a FILE count. Two uploaded files, so two.
    assert.equal(outcome.meta!.pages, 2);
    assert.match(outcome.meta!.rubricVersion, /^[0-9a-f]{12}$/);

    // Genuinely progressive, not one buffered lump at the end.
    assert.ok(
      outcome.lastTokenAt! > outcome.firstTokenAt!,
      'tokens arrived in a single burst — streaming is not working',
    );

    // Accumulated tokens must reconstruct the feedback the server also sent
    // whole. If these diverge, the streamed view and the saved record differ.
    const streamed = outcome.tokens.join('');
    assert.ok(streamed.includes('Directive compliance'));
    assert.ok(
      streamed.startsWith(outcome.feedbackMarkdown.slice(0, 60)),
      'the streamed prose must match the saved feedback',
    );

    // The trailing score fence must be stripped from the prose but preserved
    // as structured scores.
    assert.ok(!outcome.feedbackMarkdown.includes('"highestLeverageFix"'));
    assert.equal(outcome.scores!.total, 4.5);
    assert.equal(outcome.scores!.max, 10);
    assert.equal(outcome.scores!.directiveCompliance, false);

    // Usage was measured, not left at zero.
    assert.ok(outcome.usage!.inputTokens > 0);
    assert.ok(outcome.usage!.outputTokens > 0);
    assert.ok(outcome.usage!.estCostUsd > 0);

    // Finally: does what came off the wire fit the row the database expects?
    const row = toEvaluationInput({
      answerId: 1,
      meta: outcome.meta!,
      scores: outcome.scores,
      feedbackMarkdown: outcome.feedbackMarkdown,
      wordLimit: 250,
      paper: 'gs2',
    });

    assert.equal(row.answerId, 1);
    assert.equal(row.total, 4.5);
    assert.equal(row.max, 10);
    assert.equal(row.rubricVersion, outcome.meta!.rubricVersion);
    assert.equal(row.model, outcome.meta!.model);
    assert.equal(row.dimensions.length, 5);
    assert.equal(row.directiveCompliance, false);
    assert.ok(row.feedbackMd.length > 200);
    assert.ok(row.modelSkeletonMd, 'the model skeleton must be extracted');
    // legibilityNote has no column of its own and must not be silently dropped.
    assert.match(row.feedbackMd, /Cramped margins/);

    // 4.5/10 is 45% — a realistically calibrated early score, not an inflated one.
    assert.equal((row.total / row.max) * 100, 45);
  });

  it('records the spend and releases the reservation', async () => {
    const res = await fetch(`${BASE}/usage`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const usage = await res.json();

    assert.equal(res.status, 200);
    assert.ok(usage.caps.todayRequests > 0, 'the evaluation must be billed');
    assert.equal(usage.caps.inFlight, 0, 'a spend reservation leaked');
    assert.equal(usage.caps.allowed, true);
  });

  it('rejects a bad token without touching the pipeline', async () => {
    const outcome = await evaluate(answerForm(), 'wrong-token');
    assert.equal(outcome.status, 401);
    assert.equal(outcome.tokens.length, 0);
  });

  it('rejects an unsupported file type before any evaluation', async () => {
    const form = new FormData();
    form.set('paper', 'gs1');
    form.set('question', 'Discuss the salient features of Indian society.');
    form.set('wordLimit', '250');
    form.append('files', new Blob([Buffer.from('not an image')], { type: 'text/plain' }), 'a.txt');

    const outcome = await evaluate(form);
    assert.equal(outcome.status, 400);
  });

  it('rejects an over-long question with the exact documented message', async () => {
    const form = answerForm({ question: 'x'.repeat(2001) });
    const res = await fetch(`${BASE}/evaluate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: form,
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.detail, /question exceeds 2000 characters/);
  });

  it('leaves no reservation behind after the rejected requests', async () => {
    const res = await fetch(`${BASE}/usage`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const usage = await res.json();
    assert.equal(usage.caps.inFlight, 0, 'a rejected request leaked a reservation');
  });
});
