/**
 * The Gemini adapter.
 *
 * No network: `fetch` is injected. What matters here is the streaming path,
 * because that is where a failure is silent rather than loud — a running usage
 * total lost on a broken stream is a call that spent real tokens and recorded
 * none, and a spend cap that under-counts does not error, it over-spends.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.APP_BEARER_TOKEN ??= 'test-token';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-test-not-real';
process.env.GEMINI_API_KEY ??= 'gm-test-not-real';
process.env.MODEL_EVALUATION ??= 'eval-model-1';
process.env.MODEL_BULK ??= 'bulk-model-1';

const {
  createGeminiProvider,
  createSseSplitter,
  textOfChunk,
  toEvaluationUsage,
  toParts,
  GeminiRefusal,
} = await import('../src/providers/gemini.js');

/** A body that yields the given SSE frames, split at awkward boundaries. */
function sseBody(frames: string[], splitAt = 7) {
  const raw = frames.map((f) => `data: ${f}\n\n`).join('');
  const bytes = new TextEncoder().encode(raw);
  let offset = 0;
  return {
    getReader() {
      return {
        async read() {
          if (offset >= bytes.length) return { done: true, value: undefined };
          const slice = bytes.slice(offset, offset + splitAt);
          offset += splitAt;
          return { done: false, value: slice };
        },
      };
    },
  };
}

function scripted(response: { status?: number; body?: unknown; json?: unknown }) {
  const seen: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const status = response.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      body: response.body ?? null,
      json: async () => response.json ?? {},
    };
  }) as unknown as typeof fetch;
  return { impl, seen };
}

const CHUNK = (text: string, usage?: Record<string, number>) =>
  JSON.stringify({
    candidates: [{ content: { parts: [{ text }] } }],
    ...(usage ? { usageMetadata: usage } : {}),
  });

describe('content blocks', () => {
  it('collapses images and PDFs to inlineData', () => {
    // Both become the same wire shape, which is exactly why `ContentBlock`
    // keeps them apart: the CALLER has to be able to ask whether a PDF survives,
    // and `acceptsPdfDocuments` is that question.
    const parts = toParts([
      { type: 'text', text: 'hello' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAA' } },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'BBB' } },
    ]);

    assert.deepEqual(parts[0], { text: 'hello' });
    assert.deepEqual(parts[1], { inlineData: { mimeType: 'image/jpeg', data: 'AAA' } });
    assert.deepEqual(parts[2], { inlineData: { mimeType: 'application/pdf', data: 'BBB' } });
  });
});

describe('the SSE splitter', () => {
  it('reassembles a frame split across chunk boundaries', () => {
    // Boundaries land mid-frame routinely. The app's own `sse-contract.test.ts`
    // exists for the same reason on the other side of the wire.
    const split = createSseSplitter();
    assert.deepEqual(split('data: {"a"'), []);
    assert.deepEqual(split(':1}\n'), ['{"a":1}']);
  });

  it('ignores comments, blank lines and the terminator', () => {
    const split = createSseSplitter();
    assert.deepEqual(split(': keep-alive\n\ndata: [DONE]\n'), []);
  });
});

describe('usage', () => {
  it('reports only the counts that actually arrived', () => {
    // Absent must stay absent rather than becoming zero: the run keeps a
    // running total, and a spurious zero would overwrite a real count with
    // nothing on the next partial frame.
    assert.deepEqual(toEvaluationUsage({ promptTokenCount: 900 }), { inputTokens: 900 });
    assert.deepEqual(toEvaluationUsage({}), {});
    assert.deepEqual(toEvaluationUsage(undefined), {});
  });

  it('ignores malformed counts rather than passing NaN to the ledger', () => {
    assert.deepEqual(toEvaluationUsage({ promptTokenCount: 'lots' }), {});
    assert.deepEqual(toEvaluationUsage({ candidatesTokenCount: -3 }), {});
  });
});

describe('text extraction', () => {
  it('reads text out of a candidate', () => {
    assert.equal(textOfChunk(JSON.parse(CHUNK('hello'))), 'hello');
  });

  it('treats a chunk with no parts as empty, not an error', () => {
    // Gemini sends frames carrying only `usageMetadata`, and a safety-blocked
    // candidate carries no parts at all. Neither is a failure of the stream.
    assert.equal(textOfChunk({ candidates: [{ content: {} }] }), '');
    assert.equal(textOfChunk({}), '');
    assert.equal(textOfChunk(null), '');
  });
});

describe('the evaluation stream', () => {
  it('delivers text deltas in order', async () => {
    const { impl } = scripted({ body: sseBody([CHUNK('The '), CHUNK('answer'), CHUNK(' is')]) });
    const provider = createGeminiProvider({ apiKey: 'gm-x', fetchImpl: impl });

    const deltas: string[] = [];
    const run = provider.evaluation!({
      model: 'm',
      system: 's',
      instruction: 'i',
      blocks: [{ type: 'text', text: 'page' }],
    });
    run.onText((delta) => deltas.push(delta));
    await run.finalUsage();

    assert.equal(deltas.join(''), 'The answer is');
  });

  it('keeps the running total so a BROKEN stream still bills', async () => {
    // The property that matters most here. `/evaluate` bills whatever arrived
    // when a stream dies mid-answer; losing the total would record a call that
    // spent real tokens as having spent none, which is the direction that
    // quietly breaks a spend cap.
    const { impl } = scripted({
      body: sseBody([
        CHUNK('start', { promptTokenCount: 1200 }),
        CHUNK(' more', { candidatesTokenCount: 340 }),
      ]),
    });
    const provider = createGeminiProvider({ apiKey: 'gm-x', fetchImpl: impl });

    const run = provider.evaluation!({ model: 'm', system: 's', instruction: 'i', blocks: [] });
    const final = await run.finalUsage();

    assert.equal(final.inputTokens, 1200, 'a later frame without the input count must not erase it');
    assert.equal(final.outputTokens, 340);
  });

  it('drops an unparseable frame rather than failing the whole answer', async () => {
    // The text already streamed is worth more than the parse error, and the
    // route's own validation decides whether the result is usable.
    const { impl } = scripted({ body: sseBody([CHUNK('good'), '{not json', CHUNK(' more')]) });
    const provider = createGeminiProvider({ apiKey: 'gm-x', fetchImpl: impl });

    const deltas: string[] = [];
    const run = provider.evaluation!({ model: 'm', system: 's', instruction: 'i', blocks: [] });
    run.onText((d) => deltas.push(d));
    await run.finalUsage();

    assert.equal(deltas.join(''), 'good more');
  });

  it('sends the key as a header, never in the URL', async () => {
    // A query parameter lands in every proxy log between here and Google.
    const { impl, seen } = scripted({ body: sseBody([CHUNK('x')]) });
    const provider = createGeminiProvider({ apiKey: 'gm-secret', fetchImpl: impl });
    await provider.evaluation!({ model: 'm', system: 's', instruction: 'i', blocks: [] }).finalUsage();

    assert.ok(!seen[0]!.url.includes('gm-secret'), 'the key must not appear in the URL');
    const headers = seen[0]!.init.headers as Record<string, string>;
    assert.equal(headers['x-goog-api-key'], 'gm-secret');
  });

  it('never echoes the key or the provider body in a failure', async () => {
    const { impl } = scripted({ status: 403, json: { error: { message: 'key gm-secret bad' } } });
    const provider = createGeminiProvider({ apiKey: 'gm-secret', fetchImpl: impl });

    await assert.rejects(
      () => provider.evaluation!({ model: 'm', system: 's', instruction: 'i', blocks: [] }).finalUsage(),
      (err: Error) => {
        assert.ok(!err.message.includes('gm-secret'));
        assert.ok(!err.message.includes('key gm-secret bad'));
        return err instanceof GeminiRefusal;
      },
    );
  });
});

describe('capabilities', () => {
  it('declares an evaluation runner, and the two agree', () => {
    // The registry asserts this pair at boot. A provider claiming evaluation
    // while handing `/evaluate` a null would pass every other check.
    const provider = createGeminiProvider({ apiKey: 'gm-x' });
    assert.equal(provider.capabilities.evaluation, true);
    assert.notEqual(provider.evaluation, null);
  });

  it('accepts PDFs natively, which is why it serves this tier at all', () => {
    // The capture path she actually uses is a phone scanner app producing PDFs.
    // A provider without this would need a rasteriser, ~60MB of pixel buffers
    // against a ~150MB budget, and would still not read handwriting any better.
    assert.equal(createGeminiProvider({ apiKey: 'gm-x' }).capabilities.acceptsPdfDocuments, true);
  });

  it('reports no cache tokens rather than estimating them', () => {
    assert.equal(createGeminiProvider({ apiKey: 'gm-x' }).capabilities.reportsCacheTokens, false);
  });
});
