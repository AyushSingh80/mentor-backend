/**
 * The Groq adapter.
 *
 * No network: `fetch` is injected. What is tested is the translation layer,
 * because that is where the silent failures live — a wrong `finish_reason`
 * mapping does not error, it banks truncated output; a synthesised cache-token
 * count does not error, it makes the spend ledger describe a discount that did
 * not happen.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.APP_BEARER_TOKEN ??= 'test-token';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-test-not-real';
process.env.GROQ_API_KEY ??= 'gsk-test-not-real';
process.env.MODEL_EVALUATION ??= 'eval-model-1';
process.env.MODEL_BULK ??= 'bulk-model-1';

const { createGroqProvider, mapFinishReason, mapUsage, parseDuration, GroqRefusal } = await import(
  '../src/providers/groq.js'
);
const { toStrictSubset, assertStrictInvariants } = await import('../src/providers/json-schema.js');

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'score'],
        properties: {
          text: { type: 'string', maxLength: 200 },
          score: { type: 'integer', minimum: 0, maximum: 10 },
        },
      },
    },
  },
};

function request(overrides: Record<string, unknown> = {}) {
  return {
    model: 'bulk-model-1',
    system: 'system',
    user: 'user',
    schema: SCHEMA,
    schemaName: 'items',
    maxTokens: 1024,
    dataClass: 'public' as const,
    requestId: 'req-1',
    signal: new AbortController().signal,
    ...overrides,
  } as never;
}

/** A `fetch` that returns a scripted queue of responses. */
function scripted(queue: { status: number; body?: unknown; headers?: Record<string, string> }[]) {
  const seen: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const next = queue.shift() ?? { status: 200, body: {} };
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      headers: new Headers(next.headers ?? {}),
      json: async () => next.body ?? {},
    };
  }) as unknown as typeof fetch;
  return { impl, seen };
}

function reply(content: string, finish = 'stop', usage: Record<string, number> = {}) {
  return {
    choices: [{ message: { content }, finish_reason: finish }],
    usage: { prompt_tokens: 100, completion_tokens: 50, ...usage },
  };
}

describe('finish_reason', () => {
  it('maps `length` to max_tokens — the mapping everything else depends on', () => {
    // Three pipelines discard a whole chunk on this exact value. Mapped wrong,
    // "throw away a truncated reply" silently becomes "bank a question whose
    // options array stopped early" — the failure structured outputs exist to
    // prevent. Asserted first, alone, and before anything else in this file.
    assert.equal(mapFinishReason('length'), 'max_tokens');
  });

  it('maps the rest of the closed set', () => {
    assert.equal(mapFinishReason('stop'), 'end_turn');
    assert.equal(mapFinishReason('content_filter'), 'refusal');
  });

  it('turns anything unrecognised into `error`, never a raw provider string', () => {
    // A value passed through untranslated would be compared downstream against
    // a literal this codebase has never seen, and would silently never match.
    for (const raw of ['something_new', '', null, undefined, 42, {}]) {
      assert.equal(mapFinishReason(raw), 'error', `for ${JSON.stringify(raw)}`);
    }
  });
});

describe('usage', () => {
  it('never synthesises cache tokens', () => {
    // `billableInputTokens` weights a cache write at 1.25x and a read at 1.0x.
    // Inventing either would make the ledger describe a discount that did not
    // happen. `reportsCacheTokens: false` is how the capability says so.
    const usage = mapUsage({ prompt_tokens: 900, completion_tokens: 300, cached_tokens: 400 });
    assert.equal(usage.inputTokens, 900);
    assert.equal(usage.outputTokens, 300);
    assert.equal(usage.cacheCreationInputTokens, 0);
    assert.equal(usage.cacheReadInputTokens, 0);
  });

  it('reads a missing or malformed usage block as zero, not NaN', () => {
    // A NaN would reach `estimateCostUsd` and make the whole monthly total NaN,
    // which reads on screen as a broken app rather than a cheap request.
    for (const raw of [undefined, null, {}, { prompt_tokens: 'lots' }, { prompt_tokens: -5 }]) {
      const usage = mapUsage(raw);
      assert.ok(Number.isFinite(usage.inputTokens), `for ${JSON.stringify(raw)}`);
      assert.ok(usage.inputTokens >= 0);
    }
  });
});

describe('rate-limit windows', () => {
  it('parses the duration formats the provider actually sends', () => {
    assert.equal(parseDuration('7.66s'), 7660);
    assert.equal(parseDuration('2m59.56s'), 179_560);
    assert.equal(parseDuration('1h'), 3_600_000);
    assert.equal(parseDuration('30'), 30_000);
    assert.equal(parseDuration('250ms'), 250);
  });

  it('returns null for something it cannot read', () => {
    // Null means "the headers said nothing", which the caller answers with
    // jittered backoff. Guessing a number here would be a guess wearing the
    // authority of a provider header.
    assert.equal(parseDuration(''), null);
    assert.equal(parseDuration('soon'), null);
  });
});

describe('structured()', () => {
  it('sends strict json_schema with the bounds stripped', () => {
    const { schema, stripped } = toStrictSubset(SCHEMA);
    const body = JSON.stringify(schema);
    assert.ok(!body.includes('maxItems'), 'strict mode rejects a schema carrying bounds');
    assert.ok(!body.includes('minimum'));
    assert.ok(body.includes('additionalProperties'), 'and requires the ones that make it strict');
    assert.ok(stripped.length > 0);
  });

  it('returns the content, stop reason and usage', async () => {
    const { impl, seen } = scripted([{ status: 200, body: reply('{"items":[]}') }]);
    const provider = createGroqProvider({ apiKey: 'gsk-x', fetchImpl: impl });
    const result = await provider.structured(request());

    assert.equal(result.json, '{"items":[]}');
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.usage.inputTokens, 100);

    const sent = JSON.parse(seen[0]!.init.body as string);
    assert.equal(sent.response_format.json_schema.strict, true);
    assert.equal(sent.response_format.json_schema.name, 'items');
    assert.equal(sent.messages.length, 2, 'exactly one system turn and one user turn');
  });

  it('reports empty content as null rather than an empty string', async () => {
    // The call sites test `json === null`. An empty string would reach a JSON
    // parser and produce a parse error where the truth is "nothing came back".
    const { impl } = scripted([{ status: 200, body: reply('   ') }]);
    const provider = createGroqProvider({ apiKey: 'gsk-x', fetchImpl: impl });
    assert.equal((await provider.structured(request())).json, null);
  });

  it('does NOT retry a 400', async () => {
    // A 400 is a rejected schema or a malformed request. Retrying hides a bug
    // and spends the allowance proving the same thing four times.
    const { impl, seen } = scripted([{ status: 400 }, { status: 200, body: reply('{}') }]);
    const provider = createGroqProvider({ apiKey: 'gsk-x', fetchImpl: impl });

    await assert.rejects(() => provider.structured(request()), GroqRefusal);
    assert.equal(seen.length, 1, 'one attempt only');
  });

  it('retries a 429 and succeeds', async () => {
    const { impl, seen } = scripted([
      { status: 429, headers: { 'retry-after': '0' } },
      { status: 200, body: reply('{"items":[]}') },
    ]);
    const provider = createGroqProvider({ apiKey: 'gsk-x', fetchImpl: impl });

    assert.equal((await provider.structured(request())).json, '{"items":[]}');
    assert.equal(seen.length, 2);
  });

  it('fails fast on a daily allowance instead of waiting it out', async () => {
    // A window measured in minutes is a daily quota. Sleeping through it holds
    // a spend reservation and an open SSE socket for nothing, and the pipeline
    // already treats under-delivery as a correct, reportable outcome.
    const { impl, seen } = scripted([{ status: 429, headers: { 'retry-after': '3600' } }]);
    const provider = createGroqProvider({ apiKey: 'gsk-x', fetchImpl: impl });

    await assert.rejects(
      () => provider.structured(request()),
      (err: Error) => err instanceof GroqRefusal && err.kind === 'daily_limit',
    );
    assert.equal(seen.length, 1, 'must not retry into a daily window');
  });

  it('gives up promptly when the request is abandoned mid-backoff', async () => {
    const controller = new AbortController();
    const { impl } = scripted([
      { status: 429, headers: { 'retry-after': '30' } },
      { status: 200, body: reply('{}') },
    ]);
    const provider = createGroqProvider({ apiKey: 'gsk-x', fetchImpl: impl });

    const pending = provider.structured(request({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 5);
    await assert.rejects(() => pending);
  });

  it('never echoes the key or the provider body in an error', async () => {
    // Groq's error bodies can carry request content back, and this message
    // reaches an SSE frame and the server log.
    const { impl } = scripted([
      { status: 401, body: { error: { message: 'invalid key gsk-secret-value' } } },
    ]);
    const provider = createGroqProvider({ apiKey: 'gsk-secret-value', fetchImpl: impl });

    await assert.rejects(
      () => provider.structured(request()),
      (err: Error) => {
        assert.ok(!err.message.includes('gsk-secret-value'), 'the key must never appear');
        assert.ok(!err.message.includes('invalid key'), 'nor the provider body');
        return true;
      },
    );
  });
});

describe('capabilities', () => {
  it('declares no evaluation runner, and the two agree', () => {
    // Marking a handwritten answer needs vision good enough to read it, and a
    // weak vision model does not refuse — it misreads fluently and marks that
    // confidently. The registry asserts flag and implementation agree at boot.
    const provider = createGroqProvider({ apiKey: 'gsk-x' });
    assert.equal(provider.capabilities.evaluation, false);
    assert.equal(provider.evaluation, null);
    assert.equal(provider.capabilities.structured, true);
    assert.equal(provider.capabilities.reportsCacheTokens, false);
  });
});

describe('strict invariants', () => {
  it('accepts a schema that satisfies strict mode', () => {
    assertStrictInvariants(SCHEMA, 'fixture');
  });

  it('refuses an object with no additionalProperties: false', () => {
    assert.throws(
      () =>
        assertStrictInvariants(
          { type: 'object', required: ['a'], properties: { a: { type: 'string' } } },
          'loose',
        ),
      /additionalProperties/,
    );
  });

  it('refuses a property missing from required, naming it', () => {
    // Strict mode has no optional properties. A field that is genuinely
    // optional is expressed as a nullable type, which the real schemas do.
    assert.throws(
      () =>
        assertStrictInvariants(
          {
            type: 'object',
            additionalProperties: false,
            required: ['a'],
            properties: { a: { type: 'string' }, b: { type: 'string' } },
          },
          'partial',
        ),
      /\.b is not listed in required/,
    );
  });

  it('never mutates the schema it converts', () => {
    // The schemas are module constants shared with the Anthropic path and
    // hashed into `promptVersion`. Mutating one would change what the other
    // provider is sent and what the hash describes.
    const before = JSON.stringify(SCHEMA);
    toStrictSubset(SCHEMA);
    assert.equal(JSON.stringify(SCHEMA), before);
  });
});
