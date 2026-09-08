import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

// Config validates at import time, so the environment must be set first.
const dir = mkdtempSync(join(tmpdir(), 'upsc-usage-'));
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-real';
process.env.MODEL_EVALUATION ??= 'eval-model-1';
process.env.MODEL_BULK ??= 'bulk-model-1';
process.env.APP_BEARER_TOKEN = 'test-token';
process.env.DAILY_REQUEST_CAP = '5';
process.env.MONTHLY_USD_CAP = '10';
process.env.ESTIMATED_EVAL_USD = '0.2';
process.env.USAGE_FILE = join(dir, 'usage.json');

const { capStatus, recordUsage, releaseReservation, tryReserve } = await import('../src/usage.js');

after(() => rmSync(dir, { recursive: true, force: true }));

describe('spend cap admission', () => {
  it('admits at most the daily cap under concurrency', async () => {
    // The bug this guards: capStatus() alone is check-then-act. A request's
    // real cost is unknown until it finishes, so without a reservation every
    // concurrent caller reads the same pre-billing snapshot and proceeds.
    const results = await Promise.all(Array.from({ length: 8 }, () => tryReserve()));
    const admitted = results.filter((r) => r.ok);

    assert.equal(admitted.length, 5, `admitted ${admitted.length}, cap is 5`);
    assert.equal(results.filter((r) => !r.ok).length, 3);

    const caps = await capStatus();
    assert.equal(caps.inFlight, 5);
    assert.equal(caps.allowed, false);

    for (const _ of admitted) releaseReservation();
    assert.equal((await capStatus()).inFlight, 0);
  });

  it('reserves budget against the monthly cap while requests are in flight', async () => {
    process.env.DAILY_REQUEST_CAP = '1000';
    const { capStatus: freshCaps, tryReserve: freshReserve, releaseReservation: freshRelease } =
      await import('../src/usage.js');

    // $10 cap, $0.20 held per in-flight request => 50 concurrent admissions max.
    const results = await Promise.all(Array.from({ length: 60 }, () => freshReserve()));
    const admitted = results.filter((r) => r.ok).length;

    assert.ok(admitted <= 50, `admitted ${admitted}, monthly reservation should cap at 50`);
    const caps = await freshCaps();
    assert.equal(caps.allowed, false);
    for (let i = 0; i < admitted; i += 1) freshRelease();
  });

  it('releases never drive the counter negative', async () => {
    releaseReservation();
    releaseReservation();
    assert.equal((await capStatus()).inFlight, 0);
  });

  it('records usage with IST day and month buckets', async () => {
    const record = await recordUsage({
      endpoint: '/evaluate',
      tier: 'evaluation',
      model: 'eval-model-1',
      inputTokens: 1000,
      outputTokens: 500,
    });

    assert.match(record.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(record.month, record.date.slice(0, 7));
    assert.ok(record.estCostUsd > 0, 'cost should be estimated from token counts');
  });
});
