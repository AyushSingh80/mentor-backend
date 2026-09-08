/**
 * SSE wire-format contract — the app half.
 *
 * Counterpart: `server/tests/sse.test.ts`. That file asserts the server EMITS
 * this byte format; this one asserts the app PARSES it. Neither test is
 * sufficient alone — the bug class they exist to catch lives in the gap
 * between two packages that are never compiled together.
 *
 * Why this is not covered by `tests/sse.test.ts`: that file tests `SSEParser`
 * against hand-written fragments of its own choosing. This one pins the exact
 * literal bytes `server/src/sse.ts` produces —
 *
 *     event: <name>\ndata: <compact json>\n\n
 *
 * — for a full `meta` / `token` x3 / `scores` / `usage` / `done` sequence, fed
 * through arbitrary chunk boundaries.
 *
 * The server's SSE writer is hand-rolled (Express has no streaming helper) and
 * is being migrated from Hono right now. The failure mode that motivates this
 * test is silent: a refactor starts pretty-printing the JSON, or drops the
 * blank line between frames, and the app stops parsing while the server logs a
 * perfectly happy 200. Nothing throws. The evaluation screen just never fills
 * in. So the negative cases at the bottom are as load-bearing as the positive
 * ones.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SSEParser } from '../src/lib/sse';
import type {
  EvaluationMeta,
  EvaluationScores,
  EvaluationUsage,
} from '../src/lib/api';

/**
 * The one and only place the wire format is spelled out on this side.
 * Byte-identical to `SseStream.send()` in `server/src/sse.ts`.
 */
function frame(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/* ------------------------------------------------------- the fixture stream */

const META: EvaluationMeta = {
  model: 'eval-model-4-5-20260101',
  rubricVersion: '9f2c1ab4',
  rubricName: 'gs-mains',
  paper: 'gs2',
  // A file count, not a page count: a 4-page scanned PDF is 1 here.
  pages: 3,
};

const TOKENS = [
  '## Directive compliance\n',
  'The question said **critically examine** — you described.',
  ' Marks lost: ~2.5 of 15.',
];

const SCORES: EvaluationScores = {
  total: 9,
  max: 15,
  dimensions: [
    { name: 'Directive compliance', score: 1.5, max: 3, comment: 'Described, did not critique.' },
    { name: 'Content & examples', score: 4, max: 6, comment: 'Two committees, no data.' },
    { name: 'Structure', score: 3.5, max: 6, comment: '' },
  ],
  directiveWord: 'critically examine',
  directiveCompliance: false,
  highestLeverageFix: 'Add a two-line counterview before the way forward.',
  legibility: 'mixed',
  legibilityNote: 'Page 2 margins are cramped.',
  wordLimitRespected: true,
  confidence: 'high',
};

const USAGE: EvaluationUsage = {
  inputTokens: 4821,
  outputTokens: 1140,
  estCostUsd: 0.1372,
  monthUsd: 3.41,
  monthlyCapUsd: 20,
};

const SCORES_FRAME_PAYLOAD = {
  scores: SCORES,
  feedbackMarkdown: TOKENS.join(''),
  parsed: true,
};

/** The full stream, exactly as the server writes it. */
const WIRE =
  frame('meta', META) +
  TOKENS.map((text) => frame('token', { text })).join('') +
  frame('scores', SCORES_FRAME_PAYLOAD) +
  frame('usage', USAGE) +
  frame('done', {});

const EXPECTED_EVENTS = ['meta', 'token', 'token', 'token', 'scores', 'usage', 'done'];

/** Feeds `WIRE` through a parser in the given chunks and returns every frame. */
function feed(chunks: string[]): { event: string; data: string }[] {
  const parser = new SSEParser();
  const frames: { event: string; data: string }[] = [];
  for (const chunk of chunks) frames.push(...parser.push(chunk));
  return frames;
}

function chunkEvery(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** Deterministic so a failure reproduces exactly. */
function chunkRandomly(text: string, seed: number): string[] {
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };

  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const size = 1 + Math.floor(next() * 40);
    out.push(text.slice(i, i + size));
    i += size;
  }
  return out;
}

function assertStreamParsesCorrectly(frames: { event: string; data: string }[], label: string) {
  assert.deepEqual(
    frames.map((f) => f.event),
    EXPECTED_EVENTS,
    `event names, ${label}`,
  );

  const [meta, t0, t1, t2, scores, usage, done] = frames;

  assert.deepEqual(JSON.parse(meta.data), META, `meta payload, ${label}`);
  assert.deepEqual(JSON.parse(t0.data), { text: TOKENS[0] }, `token 0, ${label}`);
  assert.deepEqual(JSON.parse(t1.data), { text: TOKENS[1] }, `token 1, ${label}`);
  assert.deepEqual(JSON.parse(t2.data), { text: TOKENS[2] }, `token 2, ${label}`);
  assert.deepEqual(JSON.parse(scores.data), SCORES_FRAME_PAYLOAD, `scores payload, ${label}`);
  assert.deepEqual(JSON.parse(usage.data), USAGE, `usage payload, ${label}`);
  assert.deepEqual(JSON.parse(done.data), {}, `done payload, ${label}`);
}

/* -------------------------------------------------------------------- tests */

describe('SSE contract — wire format', () => {
  it('is exactly "event: <name>\\ndata: <compact json>\\n\\n"', () => {
    assert.equal(frame('done', {}), 'event: done\ndata: {}\n\n');
    assert.equal(frame('token', { text: 'hi' }), 'event: token\ndata: {"text":"hi"}\n\n');
  });

  it('never emits a raw newline inside the data line', () => {
    // A token frame legitimately carries markdown newlines; JSON.stringify
    // escapes them to \n, which is what keeps one `data:` line sufficient. If
    // this ever fails, the multi-line join in the parser becomes load-bearing.
    const tokenFrame = frame('token', { text: '## Heading\n\n- bullet\n' });
    const dataLine = tokenFrame.slice(0, -2).split('\n')[1];
    assert.ok(dataLine.startsWith('data: '));
    assert.equal(tokenFrame.split('\n').length, 4); // event, data, '', ''
  });

  it('separates every frame with a blank line', () => {
    assert.equal(WIRE.split('\n\n').length - 1, EXPECTED_EVENTS.length);
    assert.ok(WIRE.endsWith('\n\n'));
  });
});

describe('SSE contract — full evaluation stream', () => {
  it('parses the whole sequence delivered as one chunk', () => {
    assertStreamParsesCorrectly(feed([WIRE]), 'single chunk');
  });

  it('parses it one character at a time (every boundary is mid-something)', () => {
    // The harshest split there is: mid-event-name, mid-field-name, after the
    // colon but before the space, mid-JSON-string, and between the two
    // terminating newlines. All of them, on every frame.
    assertStreamParsesCorrectly(feed(chunkEvery(WIRE, 1)), '1-char chunks');
  });

  it('parses it across a range of fixed chunk sizes', () => {
    for (const size of [2, 3, 5, 7, 13, 17, 64, 100, 512]) {
      assertStreamParsesCorrectly(feed(chunkEvery(WIRE, size)), `${size}-char chunks`);
    }
  });

  it('parses it across randomised chunk boundaries', () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      assertStreamParsesCorrectly(feed(chunkRandomly(WIRE, seed)), `seed ${seed}`);
    }
  });

  it('splits mid-field, mid-JSON and between the two terminating newlines', () => {
    const parser = new SSEParser();

    // Mid event name.
    assert.equal(parser.push('event: me').length, 0);
    // Mid field name.
    assert.equal(parser.push('ta\ndat').length, 0);
    // Immediately after the colon, before the space.
    assert.equal(parser.push('a:').length, 0);
    // Mid JSON, inside a string value.
    assert.equal(parser.push(` {"model":"eval-mod`).length, 0);
    assert.equal(parser.push('el","rubricVersion":"9f2c1ab4",').length, 0);
    assert.equal(parser.push('"rubricName":"gs-mains","paper":"gs2","pages":3}').length, 0);
    // Between the two newlines that terminate the frame.
    assert.equal(parser.push('\n').length, 0);

    const frames = parser.push('\n');
    assert.equal(frames.length, 1);
    assert.equal(frames[0].event, 'meta');
    assert.deepEqual(JSON.parse(frames[0].data), {
      model: 'eval-model',
      rubricVersion: '9f2c1ab4',
      rubricName: 'gs-mains',
      paper: 'gs2',
      pages: 3,
    });
  });

  it('delivers a frame only once, never re-emitting it on the next chunk', () => {
    const parser = new SSEParser();
    assert.equal(parser.push(frame('done', {})).length, 1);
    assert.equal(parser.push(frame('done', {})).length, 1);
    assert.equal(parser.push('').length, 0);
  });

  it('tolerates keep-alive comments interleaved between frames', () => {
    // A long Opus evaluation can go quiet; a proxy-defeating comment must not
    // be mistaken for a frame or corrupt the one that follows.
    const withComments = `: ping\n\n${frame('meta', META)}: ping\n\n${frame('done', {})}`;
    const frames = feed(chunkEvery(withComments, 3));
    assert.deepEqual(
      frames.map((f) => f.event),
      ['meta', 'done'],
    );
  });
});

describe('SSE contract — formats that would silently break the app', () => {
  /**
   * These assert the NEGATIVE side of the contract. They are what makes this
   * file a guard rather than a restatement: if the server is ever refactored
   * into one of these shapes, the app stops parsing without an error anywhere,
   * so the format must be pinned from both ends.
   */

  it('breaks on pretty-printed JSON — which is why the server must stay compact', () => {
    const pretty = `event: meta\ndata: ${JSON.stringify(META, null, 2)}\n\n`;
    const frames = new SSEParser().push(pretty);

    assert.equal(frames.length, 1);
    // Only the first physical line kept the `data:` prefix; the rest were read
    // as unknown fields and dropped. What survives is unparseable.
    assert.throws(() => JSON.parse(frames[0].data));
  });

  it('breaks when the blank line between frames is dropped', () => {
    const missingSeparator = `event: meta\ndata: ${JSON.stringify(META)}\nevent: done\ndata: {}\n\n`;
    const frames = new SSEParser().push(missingSeparator);

    // Two frames collapse into one: the last `event:` wins and both `data:`
    // lines are joined, so `meta` is lost outright and the surviving frame
    // carries two JSON objects glued together.
    assert.equal(frames.length, 1);
    assert.throws(() => JSON.parse(frames[0].data));
  });

  it('still parses "data:" with no space, since the spec makes the space optional', () => {
    // Not a break — recorded so a server-side reformat here is a known no-op
    // rather than a surprise either way.
    const frames = new SSEParser().push(`event: token\ndata:{"text":"hi"}\n\n`);
    assert.equal(frames.length, 1);
    assert.deepEqual(JSON.parse(frames[0].data), { text: 'hi' });
  });

  it('drops a frame that carries no data line at all', () => {
    assert.equal(new SSEParser().push('event: done\n\n').length, 0);
  });
});
