import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseInline, parseMarkdown } from '../src/lib/markdown-parse';

describe('parseMarkdown', () => {
  it('parses headings by level', () => {
    const blocks = parseMarkdown('## Directive compliance\n### Content');
    assert.deepEqual(blocks, [
      { kind: 'heading', level: 2, text: 'Directive compliance' },
      { kind: 'heading', level: 3, text: 'Content' },
    ]);
  });

  it('joins wrapped lines into one paragraph and splits on blank lines', () => {
    const blocks = parseMarkdown('First line\ncontinues here.\n\nSecond para.');
    assert.deepEqual(blocks, [
      { kind: 'paragraph', text: 'First line continues here.' },
      { kind: 'paragraph', text: 'Second para.' },
    ]);
  });

  it('parses bullets with any marker', () => {
    const blocks = parseMarkdown('- one\n* two\n+ three');
    assert.deepEqual(
      blocks.map((b) => b.kind),
      ['bullet', 'bullet', 'bullet'],
    );
  });

  it('parses numbered lists and keeps the number', () => {
    const blocks = parseMarkdown('1. first\n2) second');
    assert.deepEqual(blocks, [
      { kind: 'numbered', marker: '1.', text: 'first' },
      { kind: 'numbered', marker: '2.', text: 'second' },
    ]);
  });

  it('passes fenced code through verbatim', () => {
    const blocks = parseMarkdown('Intro\n\n```\nline  one\n  line two\n```');
    assert.deepEqual(blocks[1], { kind: 'code', text: 'line  one\n  line two' });
  });

  it('renders an unterminated fence rather than swallowing it', () => {
    // The evaluator streams token by token, so a partially-received response
    // routinely has an open fence. Dropping it would blank the screen mid-stream.
    const blocks = parseMarkdown('Feedback\n\n```json\n{"total": 4');
    assert.equal(blocks.at(-1)?.kind, 'code');
    assert.match((blocks.at(-1) as { text: string }).text, /total/);
  });

  it('parses horizontal rules', () => {
    assert.deepEqual(parseMarkdown('---'), [{ kind: 'rule' }]);
  });

  it('returns nothing for empty input', () => {
    assert.deepEqual(parseMarkdown(''), []);
  });
});

describe('parseInline', () => {
  it('parses bold before italic', () => {
    assert.deepEqual(parseInline('**strong** text'), [
      { text: 'strong', style: 'bold' },
      { text: ' text' },
    ]);
  });

  it('parses italic', () => {
    assert.deepEqual(parseInline('an *emphasis* here'), [
      { text: 'an ' },
      { text: 'emphasis', style: 'italic' },
      { text: ' here' },
    ]);
  });

  it('parses inline code', () => {
    assert.deepEqual(parseInline('use `critically examine`'), [
      { text: 'use ' },
      { text: 'critically examine', style: 'code' },
    ]);
  });

  it('handles several spans in one line', () => {
    const spans = parseInline('**Content** was weak but *structure* held.');
    assert.deepEqual(
      spans.filter((s) => s.style).map((s) => [s.text, s.style]),
      [
        ['Content', 'bold'],
        ['structure', 'italic'],
      ],
    );
  });

  it('leaves plain text untouched', () => {
    assert.deepEqual(parseInline('no markup here'), [{ text: 'no markup here' }]);
  });
});
