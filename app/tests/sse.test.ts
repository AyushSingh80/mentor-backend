import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SSEParser } from '../src/lib/sse';

describe('SSEParser', () => {
  it('parses a complete frame', () => {
    const frames = new SSEParser().push('event: token\ndata: {"text":"hi"}\n\n');
    assert.equal(frames.length, 1);
    assert.equal(frames[0]?.event, 'token');
    assert.equal(frames[0]?.data, '{"text":"hi"}');
  });

  it('buffers across chunk boundaries', () => {
    const parser = new SSEParser();
    assert.equal(parser.push('event: tok').length, 0);
    assert.equal(parser.push('en\ndata: {"text":"a"}').length, 0);
    const frames = parser.push('\n\n');
    assert.equal(frames.length, 1);
    assert.equal(frames[0]?.data, '{"text":"a"}');
  });

  it('returns multiple frames from one chunk', () => {
    const frames = new SSEParser().push(
      'event: token\ndata: 1\n\nevent: token\ndata: 2\n\nevent: done\ndata: {}\n\n',
    );
    assert.equal(frames.length, 3);
    assert.deepEqual(
      frames.map((f) => f.event),
      ['token', 'token', 'done'],
    );
  });

  it('joins multi-line data fields', () => {
    const frames = new SSEParser().push('event: x\ndata: line1\ndata: line2\n\n');
    assert.equal(frames[0]?.data, 'line1\nline2');
  });

  it('ignores keep-alive comments', () => {
    const frames = new SSEParser().push(': keep-alive\n\nevent: token\ndata: ok\n\n');
    assert.equal(frames.length, 1);
    assert.equal(frames[0]?.data, 'ok');
  });

  it('defaults to the message event when none is given', () => {
    const frames = new SSEParser().push('data: bare\n\n');
    assert.equal(frames[0]?.event, 'message');
  });
});
