/**
 * POST /interview/questions — the app half of the contract.
 *
 * Counterpart: `server/tests/interview-contract.test.ts`. Written before the
 * screens, which is the process this repo adopted in Phase 5 after Phases 3 and
 * 4 each shipped with every field name different across the wire.
 *
 * There is a second reason for the pair here. This is the most personal payload
 * the app sends — her name, her home district, her employer — and the contract
 * includes a guarantee about what is NOT sent: an empty field never leaves the
 * device, because a blank transmitted as `""` is where an invented biography
 * would come from.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { QuestionsRequest } from '../src/lib/daf-api';
import { INTERVIEW_PROMPT_VERSION, buildQuestionsRequest } from '../src/lib/daf-request';
import { DAF_FIELDS, DAF_RULES, type DafEntry, type DafField } from '../src/lib/daf-types';

function entry(field: DafField, value: string): DafEntry {
  return { field, value, updatedAt: '2026-09-08T00:00:00.000Z' };
}

const FILLED: DafEntry[] = [
  entry('home_district', 'Barpeta, Assam'),
  entry('hobbies', 'Reading — mainly Indian political history, currently Guha'),
  entry('employment', 'Operations analyst on an evening shift'),
];

function asSent(
  overrides: Partial<Parameters<typeof buildQuestionsRequest>[0]> = {},
): QuestionsRequest {
  return buildQuestionsRequest({
    requestId: 'iv_2026-09-08_5f2a',
    entries: FILLED,
    bankedQuestions: ['What is your district known for?'],
    ...overrides,
  });
}

/** Every key `parseInterviewBody` reads, restated. */
const KEYS = ['entries', 'excludeQuestions', 'promptVersion', 'requestId', 'take'] as const;

describe('POST /interview/questions request body', () => {
  it('sends exactly the keys the server reads, and no others', () => {
    assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(asSent()))).sort(), [...KEYS].sort());
  });

  it('sends each entry as {field, value}', () => {
    for (const each of asSent().entries) {
      assert.deepEqual(Object.keys(each).sort(), ['field', 'value']);
    }
  });

  it('DROPS an empty field rather than sending it blank', () => {
    // The guarantee that matters. A field transmitted as `""` invites a
    // question about a university she never named, which is how a generated
    // biography starts. Sending only what she wrote means an invented field
    // has nowhere to come from.
    const sent = asSent({ entries: [...FILLED, entry('university', '   ')] });
    assert.equal(
      sent.entries.some((each) => each.field === 'university'),
      false,
    );
    assert.equal(sent.entries.length, FILLED.length);
  });

  it('sends nothing at all from an empty form', () => {
    // The server refuses this with a 400, which is correct: with no entries
    // there is nothing to generate from except invention.
    assert.deepEqual(asSent({ entries: [] }).entries, []);
  });

  it('sends entries in declared order, whatever order they were stored', () => {
    const shuffled = [...FILLED].reverse();
    assert.deepEqual(
      asSent({ entries: shuffled }).entries.map((each) => each.field),
      DAF_FIELDS.filter((field) => FILLED.some((each) => each.field === field)),
    );
  });

  it('trims the values it does send', () => {
    const sent = asSent({ entries: [entry('home_town', '  Barpeta  ')] });
    assert.equal(sent.entries[0]?.value, 'Barpeta');
  });

  it('sends the banked questions under the name the server reads', () => {
    // The quiet failure: a misnamed exclusion list means the server answers 200
    // and returns questions she already has, which she notices only by reading
    // her own bank twice.
    assert.deepEqual(asSent().excludeQuestions, ['What is your district known for?']);
  });

  it('asks for the rule`s batch size by default', () => {
    assert.equal(asSent().take, DAF_RULES.batchSize);
  });

  it('never asks for fewer than one', () => {
    assert.equal(asSent({ take: 0 }).take, 1);
    assert.equal(asSent({ take: -5 }).take, 1);
  });

  it('reports the prompt cohort this build asks for', () => {
    assert.equal(asSent().promptVersion, INTERVIEW_PROMPT_VERSION);
  });

  it('does not send names from shapes this contract could have taken', () => {
    const sent = new Set(Object.keys(asSent()));
    for (const dead of ['daf', 'fields', 'profile', 'count', 'batchSize', 'vocabulary']) {
      assert.equal(sent.has(dead), false, `"${dead}" is not a field the server reads`);
    }
  });

  it('survives a JSON round trip unchanged', () => {
    const request = asSent();
    assert.deepEqual(JSON.parse(JSON.stringify(request)) as QuestionsRequest, request);
  });

  it('copies the banked list rather than aliasing it', () => {
    const banked = ['a'];
    const request = buildQuestionsRequest({
      requestId: 'iv-alias',
      entries: FILLED,
      bankedQuestions: banked,
    });
    banked.push('b');
    assert.deepEqual(request.excludeQuestions, ['a']);
  });
});
