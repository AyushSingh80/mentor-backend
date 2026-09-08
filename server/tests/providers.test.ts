/**
 * The provider boundary itself.
 *
 * Everything else in this suite injects a runner and never reaches a provider,
 * which is correct for testing a pipeline and useless for testing the seam the
 * pipeline sits on. Before this file the real model calls had NO coverage at
 * all: the cache breakpoint, the single system turn, the `stop_reason`
 * translation and the usage normalisation were exercised only by production.
 *
 * The property that matters most here is the truncation signal. Three pipelines
 * discard a whole chunk on `'max_tokens'`, because a truncated structured reply
 * parses perfectly and is simply short by questions nobody counted. An adapter
 * that dropped or renamed that value would turn every truncation into silent
 * data loss, and no other test in this suite would notice.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

process.env.APP_BEARER_TOKEN ??= 'test-token';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-test-not-real';
process.env.MODEL_EVALUATION ??= 'eval-model-1';
process.env.MODEL_BULK ??= 'bulk-model-1';

const { createAnthropicProvider, mapStopReason } = await import('../src/providers/anthropic.js');
const { assertTierCapable, providerIdFor, selectProvider, setProviderForTier } = await import(
  '../src/providers/registry.js'
);
const { ZERO_TOKEN_COUNTS } = await import('../src/providers/types.js');

type AnthropicStructuredParams = Parameters<
  Parameters<typeof createAnthropicProvider>[0] & object
>[0];
type Provider = ReturnType<typeof createAnthropicProvider>;

/* ------------------------------------------------------------------ helpers */

interface ScriptedReply {
  parsed_output?: string | null;
  stop_reason?: string | null;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
}

function scripted(reply: ScriptedReply = {}) {
  const sent: AnthropicStructuredParams[] = [];
  const signals: AbortSignal[] = [];
  const provider = createAnthropicProvider(async (params, options) => {
    sent.push(params);
    signals.push(options.signal);
    return {
      // `in` and not `??`, so a case can script an explicit null reply.
      parsed_output: 'parsed_output' in reply ? (reply.parsed_output ?? null) : '{"ok":true}',
      stop_reason: reply.stop_reason ?? 'end_turn',
      usage: reply.usage ?? { input_tokens: 0, output_tokens: 0 },
    };
  });
  return { provider, sent, signals };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    model: 'bulk-model-1',
    system: 'You set questions.',
    user: 'Set five.',
    schema: { type: 'object' } as Record<string, unknown>,
    schemaName: 'a_schema',
    maxTokens: 9000,
    dataClass: 'public' as const,
    requestId: 'req_1',
    signal: new AbortController().signal,
    ...overrides,
  };
}

/* ----------------------------------------------------------- request shaping */

describe('the Anthropic adapter — what it sends', () => {
  it('sends exactly one system turn and exactly one user turn', async () => {
    // The narrowness IS the contract. Seven call sites need one of each, and a
    // request that grew a second user turn would be accepted by Anthropic,
    // rejected by Gemini, and caught by nothing until the provider changed.
    const { provider, sent } = scripted();
    await provider.structured(request());

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.system.length, 1);
    assert.equal(sent[0]?.system[0]?.text, 'You set questions.');
    assert.equal(sent[0]?.messages.length, 1);
    assert.deepEqual(sent[0]?.messages[0], { role: 'user', content: 'Set five.' });
  });

  it('puts a cache breakpoint on the system block', async () => {
    // Every chunk after the first in an MCQ batch is a cache read on the same
    // long prompt. Losing this is not a failure, it is a bill: the difference
    // between paying for the system prompt once and paying for it per chunk.
    const { provider, sent } = scripted();
    await provider.structured(request());

    assert.deepEqual(sent[0]?.system[0]?.cache_control, { type: 'ephemeral' });
  });

  it('passes the caller`s own max_tokens through, never a default', async () => {
    // A hardcoded ceiling here truncates every chunk of every batch, and a
    // truncated chunk is one that was paid for and delivered nothing.
    const { provider, sent } = scripted();
    await provider.structured(request({ maxTokens: 12_345 }));

    assert.equal(sent[0]?.max_tokens, 12_345);
  });

  it('sends the caller`s schema by identity, not a copy', async () => {
    // The schema is hashed into `promptVersion`. An adapter that rebuilt or
    // reordered it would re-version the whole bank on a refactor.
    const schema = { type: 'object', required: ['questions'] };
    const { provider, sent } = scripted();
    await provider.structured(request({ schema }));

    assert.equal(sent[0]?.output_config.format.schema, schema);
    assert.equal(sent[0]?.output_config.format.type, 'json_schema');
  });

  it('forwards the abort signal, so a disconnect still cancels the call', async () => {
    const controller = new AbortController();
    const { provider, signals } = scripted();
    await provider.structured(request({ signal: controller.signal }));

    assert.equal(signals[0], controller.signal);
  });

  it('carries the model it was given and never resolves one itself', async () => {
    const { provider, sent } = scripted();
    await provider.structured(request({ model: 'some-other-model' }));

    assert.equal(sent[0]?.model, 'some-other-model');
  });
});

/* ------------------------------------------------------------ reply handling */

describe('the Anthropic adapter — what it returns', () => {
  it('returns the JSON document unparsed', async () => {
    // Unparsed on purpose: the caller`s own parser never throws, so a malformed
    // reply still reports the tokens the provider already billed for it.
    const { provider } = scripted({ parsed_output: '{"questions":[]}' });
    const response = await provider.structured(request());

    assert.equal(response.json, '{"questions":[]}');
  });

  it('returns null when the reply carried no text at all', async () => {
    const { provider } = scripted({ parsed_output: null });
    const response = await provider.structured(request());

    assert.equal(response.json, null);
  });

  it('counts the cache tokens, which are NOT inside input_tokens', async () => {
    // Reading only `input_tokens` under-counts every cached call, which is
    // every MCQ chunk after the first.
    const { provider } = scripted({
      usage: {
        input_tokens: 100,
        output_tokens: 200,
        cache_creation_input_tokens: 300,
        cache_read_input_tokens: 400,
      },
    });
    const response = await provider.structured(request());

    assert.deepEqual(response.usage, {
      inputTokens: 100,
      outputTokens: 200,
      cacheCreationInputTokens: 300,
      cacheReadInputTokens: 400,
    });
  });

  it('reports zero rather than NaN when the cache fields are absent', async () => {
    const { provider } = scripted({ usage: { input_tokens: 7, output_tokens: 9 } });
    const response = await provider.structured(request());

    assert.deepEqual(response.usage, {
      ...ZERO_TOKEN_COUNTS,
      inputTokens: 7,
      outputTokens: 9,
    });
  });

  it('preserves the truncation signal exactly', async () => {
    // THE load-bearing assertion of this file. `mcq/pipeline.ts`,
    // `ca/pipeline.ts` and `drills/pipeline.ts` all discard a chunk on this
    // value; anything else here silently accepts short output.
    const { provider } = scripted({ stop_reason: 'max_tokens' });
    const response = await provider.structured(request());

    assert.equal(response.stopReason, 'max_tokens');
  });
});

describe('stop reason translation', () => {
  it('maps max_tokens to max_tokens and nothing else to it', () => {
    assert.equal(mapStopReason('max_tokens'), 'max_tokens');

    for (const raw of [
      'end_turn',
      'stop_sequence',
      'tool_use',
      'pause_turn',
      'refusal',
      'model_context_window_exceeded',
      'a_reason_this_sdk_version_does_not_have',
      null,
    ]) {
      assert.notEqual(
        mapStopReason(raw),
        'max_tokens',
        `${String(raw)} must not be reported as truncation`,
      );
    }
  });

  it('keeps a refusal distinguishable from a normal finish', () => {
    assert.equal(mapStopReason('refusal'), 'refusal');
    assert.equal(mapStopReason('end_turn'), 'end_turn');
  });

  it('passes null through rather than inventing a reason', () => {
    assert.equal(mapStopReason(null), null);
  });

  it('collapses the reasons no pipeline branches on, including a future one', () => {
    // Behaviour-preserving rather than merely tidy: nothing has ever compared
    // `stopReason` against anything but `'max_tokens'`, and it never reaches a
    // client. An unknown reason from a newer SDK collapses the same way, which
    // is the safe direction — the alternative is a crash on a string.
    assert.equal(mapStopReason('stop_sequence'), 'end_turn');
    assert.equal(mapStopReason('tool_use'), 'end_turn');
    assert.equal(mapStopReason('pause_turn'), 'end_turn');
    assert.equal(mapStopReason('something_new'), 'end_turn');
  });

  it('does NOT yet treat a context-window cutoff as truncation', () => {
    // Documented, not endorsed. Before the provider port this value passed
    // through verbatim and `=== 'max_tokens'` was false, so the chunk was kept.
    // Treating it as truncation is probably right and is a BEHAVIOUR CHANGE,
    // which is why a refactor phase is not where it happens. Delete this test
    // when that decision is made deliberately.
    assert.equal(mapStopReason('model_context_window_exceeded'), 'end_turn');
  });
});

/* -------------------------------------------------------------- the registry */

/** A provider that declares exactly the capabilities a case needs. */
function fakeProvider(overrides: {
  structured?: boolean;
  evaluation?: boolean;
  runner?: 'present' | 'absent';
}): Provider {
  const evaluation = overrides.evaluation ?? false;
  const hasRunner = (overrides.runner ?? (evaluation ? 'present' : 'absent')) === 'present';
  return {
    id: 'anthropic',
    capabilities: {
      structured: overrides.structured ?? true,
      evaluation,
      acceptsPdfDocuments: false,
      maxImagesPerRequest: 1,
      reportsCacheTokens: false,
    maxRequestBytes: Number.POSITIVE_INFINITY,
    },
    evaluation: hasRunner
      ? () => {
          throw new Error('not called');
        }
      : null,
    structured: async () => ({ json: null, stopReason: null, usage: ZERO_TOKEN_COUNTS }),
  };
}

describe('provider selection', () => {
  it('refuses an id no adapter answers to, and lists the ones that exist', () => {
    assert.throws(
      () => selectProvider('grok', 'PROVIDER_BULK'),
      // 'grok' is a plausible typo for a provider that now exists, which is
      // exactly why the message lists the real ids rather than saying 'unknown'.
      /PROVIDER_BULK=grok is not a known provider\. Valid ids: anthropic, groq, gemini\./,
    );
  });

  it('refuses `fake` specifically, and says why it is not a provider', () => {
    // A provider abstraction must never become a second route to the scripted
    // runners. That switch is one variable, refuses production, and prints a
    // banner; a provider id would have none of those and would look ordinary
    // in a deployment config.
    assert.throws(() => selectProvider('fake', 'PROVIDER_EVALUATION'), (err: Error) => {
      assert.match(err.message, /PROVIDER_EVALUATION=fake is refused/);
      assert.match(err.message, /EVAL_RUNNER=fake/);
      return true;
    });
  });

  it('resolves a known id', () => {
    assert.equal(selectProvider('anthropic', 'PROVIDER_BULK').id, 'anthropic');
  });
});

describe('tier capability assertions', () => {
  it('refuses a non-streaming provider on the evaluation tier, naming the reason', () => {
    assert.throws(
      () => assertTierCapable('evaluation', fakeProvider({ evaluation: false }), 'PROVIDER_EVALUATION'),
      /cannot serve the evaluation tier: it has no streaming evaluation runner/,
    );
  });

  it('allows that same provider on the bulk tier', () => {
    assert.doesNotThrow(() =>
      assertTierCapable('bulk', fakeProvider({ evaluation: false }), 'PROVIDER_BULK'),
    );
  });

  it('refuses a provider with no structured output on EITHER tier', () => {
    // Not obvious and worth asserting: the evaluation tier is not only the
    // streaming path. `drills/runner.ts` marks a drill with a STRUCTURED call
    // on the evaluation tier, so a stream-only provider would serve marked
    // answers and fail every drill mark.
    for (const tier of ['evaluation', 'bulk'] as const) {
      assert.throws(
        () => assertTierCapable(tier, fakeProvider({ structured: false, evaluation: true }), 'PROVIDER_X'),
        /does not support structured output/,
      );
    }
  });

  it('refuses a provider whose capability flag disagrees with its runner', () => {
    // Otherwise the check above is theatre: a provider could declare
    // `evaluation: true`, pass the gate, and hand `/evaluate` a null.
    assert.throws(
      () =>
        assertTierCapable(
          'evaluation',
          fakeProvider({ evaluation: true, runner: 'absent' }),
          'PROVIDER_EVALUATION',
        ),
      /is inconsistent: capabilities\.evaluation is true but its evaluation runner is null/,
    );
  });
});

describe('the default binding', () => {
  afterEach(() => {
    setProviderForTier('evaluation', null);
    setProviderForTier('bulk', null);
  });

  it('is anthropic on both tiers when the environment sets neither variable', () => {
    // What makes this phase a pure refactor: an existing deployment changes
    // nothing and gets exactly what it had.
    assert.equal(providerIdFor('evaluation'), 'anthropic');
    assert.equal(providerIdFor('bulk'), 'anthropic');
  });

  it('is restored by passing null back to the test seam', () => {
    setProviderForTier('bulk', fakeProvider({ evaluation: false }));
    setProviderForTier('bulk', null);
    assert.equal(providerIdFor('bulk'), 'anthropic');
  });
});
