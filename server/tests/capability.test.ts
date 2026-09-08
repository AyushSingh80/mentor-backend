/**
 * The capability guard.
 *
 * The property under test is not "it returns 503" — it is that a request the
 * server cannot serve is refused BEFORE it costs anything. Prior to this guard,
 * `/mcq/generate` with no model parsed the body, took a spend reservation,
 * opened an SSE stream, and only then threw. The reservation was released, so
 * nothing leaked; but the user saw a generic failure for a condition decided at
 * boot, and the ledger saw traffic for a call that could never happen.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.APP_BEARER_TOKEN ??= 'test-token';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-test-not-real';
process.env.MODEL_EVALUATION ??= 'eval-model-1';
process.env.MODEL_BULK ??= 'bulk-model-1';

const { requireCapability, tierConfigured } = await import('../src/capability.js');

function runGuard(tier: 'evaluation' | 'bulk') {
  const handler = requireCapability(tier);
  const captured: { status: number | null; body: unknown; nexted: boolean } = {
    status: null,
    body: null,
    nexted: false,
  };
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(value: unknown) {
      captured.body = value;
      return this;
    },
  };
  handler({} as never, res as never, () => {
    captured.nexted = true;
  });
  return captured;
}

describe('requireCapability', () => {
  it('passes the request through when the tier is configured', () => {
    // The env at the top of this file configures both tiers.
    for (const tier of ['evaluation', 'bulk'] as const) {
      const result = runGuard(tier);
      assert.equal(result.nexted, true, `${tier} should pass`);
      assert.equal(result.status, null, 'a configured tier must not write a status');
    }
  });

  it('reports both tiers as configured when the env supplies them', () => {
    assert.equal(tierConfigured('evaluation'), true);
    assert.equal(tierConfigured('bulk'), true);
  });
});

describe('the refusal body', () => {
  /** Stands in for a server with no model configured for this tier. */
  const notConfigured = () => false;

  function refuse(tier: 'evaluation' | 'bulk') {
    const handler = requireCapability(tier, notConfigured);
    const captured: {
      status: number | null;
      body: Record<string, unknown> | null;
      nexted: boolean;
    } = { status: null, body: null, nexted: false };
    const res = {
      status(code: number) {
        captured.status = code;
        return this;
      },
      json(value: Record<string, unknown>) {
        captured.body = value;
        return this;
      },
    };
    handler({} as never, res as never, () => {
      captured.nexted = true;
    });
    return captured;
  }

  it('refuses before the route runs', () => {
    const result = refuse('bulk');
    assert.equal(
      result.nexted,
      false,
      'reaching the route is what took a spend reservation for a call that could never happen',
    );
    assert.equal(result.status, 503);
  });

  it('names the tier, so the app can say which capability is missing', () => {
    assert.equal(refuse('bulk').body?.tier, 'bulk');
    assert.equal(
      refuse('evaluation').body?.tier,
      'evaluation',
      '"cannot evaluate an answer" and "cannot bank questions" are different messages',
    );
  });

  it('carries a detail naming what to set', () => {
    const body = refuse('evaluation').body;
    assert.equal(body?.error, 'model_not_configured');
    assert.match(String(body?.detail), /MODEL_EVALUATION/);
  });

  it('never echoes a credential', () => {
    for (const tier of ['evaluation', 'bulk'] as const) {
      const text = JSON.stringify(refuse(tier).body);
      assert.ok(!text.includes('sk-'), 'a refusal must not carry any part of a key');
    }
  });
});
