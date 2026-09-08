import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.ANTHROPIC_API_KEY ??= 'sk-ant-test-not-real';
process.env.MODEL_EVALUATION ??= 'eval-model-1';
process.env.MODEL_BULK ??= 'bulk-model-1';
process.env.APP_BEARER_TOKEN ??= 'test-token';

const { extractTrailingJson, stripTrailingJson } = await import('../src/anthropic.js');

const SCORES = '{"total": 4.5, "max": 10}';

describe('extractTrailingJson', () => {
  it('reads the trailing score block', () => {
    const text = `Feedback here.\n\n\`\`\`json\n${SCORES}\n\`\`\``;
    assert.deepEqual(extractTrailingJson(text), { total: 4.5, max: 10 });
  });

  it('prefers the last fence when the prose contains an earlier one', () => {
    const text = [
      'Try a table like this:',
      '```json',
      '{"illustrative": true}',
      '```',
      'Now the real verdict.',
      '```json',
      SCORES,
      '```',
    ].join('\n');
    assert.deepEqual(extractTrailingJson(text), { total: 4.5, max: 10 });
  });

  it('returns null rather than throwing on malformed JSON', () => {
    assert.equal(extractTrailingJson('```json\n{not valid,\n```'), null);
  });

  it('returns null when there is no fence at all', () => {
    assert.equal(extractTrailingJson('Just prose.'), null);
  });
});

describe('stripTrailingJson', () => {
  it('removes only the trailing fence', () => {
    const text = `Feedback here.\n\n\`\`\`json\n${SCORES}\n\`\`\``;
    assert.equal(stripTrailingJson(text), 'Feedback here.');
  });

  it('keeps prose between an illustrative fence and the score fence', () => {
    // Regression: a single $-anchored lazy regex backtracks from the FIRST
    // fence to the LAST, silently deleting the real verdict in between.
    const text = [
      'Your structure is clear.',
      '',
      '```json',
      '{"illustrative": true}',
      '```',
      '',
      'But the introduction is weak and the conclusion does not resolve the thesis.',
      '',
      '```json',
      SCORES,
      '```',
    ].join('\n');

    const stripped = stripTrailingJson(text);
    assert.ok(
      stripped.includes('the introduction is weak'),
      'the substantive feedback must survive',
    );
    assert.ok(stripped.includes('{"illustrative": true}'), 'the inline example must survive');
    assert.ok(!stripped.includes(SCORES), 'the trailing score block must be removed');
  });

  it('leaves text untouched when the only fence is mid-prose', () => {
    const text = 'Before.\n```json\n{"a":1}\n```\nAfter.';
    assert.equal(stripTrailingJson(text), text);
  });

  it('is a no-op when there is no fence', () => {
    assert.equal(stripTrailingJson('Just prose.  '), 'Just prose.');
  });
});
