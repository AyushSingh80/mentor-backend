/**
 * Phase 7 seams.
 *
 * The last of five such files. The seam that carries the most here is the one
 * between the app's frozen `DAF_FIELDS` and the server's copy: they are two
 * literal arrays in two packages that are never compiled together, and the
 * server's JSON Schema turns its copy into an `enum`. A field present on one
 * side and not the other is not a type error — it is a question silently
 * dropped as `unknown_field`, or an entry rejected with a 400 naming a list she
 * cannot see.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DAF_FIELDS,
  DAF_RULES,
  DECIDE_EARLY,
  FIELD_LABELS,
  FIELD_RATIONALE,
  LIKELIHOODS,
  PREP_STATES,
  type DafEntry,
  type DafField,
  type InterviewQuestion,
} from '../src/lib/daf-types';
import { buildQuestionsRequest } from '../src/lib/daf-request';
import {
  formState,
  questionOrder,
  readinessByArea,
  readyShare,
  summariseForm,
  summariseReadiness,
} from '../src/lib/daf';

function entry(field: DafField, value: string): DafEntry {
  return { field, value, updatedAt: null };
}

let nextId = 0;
function question(overrides: Partial<InterviewQuestion> = {}): InterviewQuestion {
  nextId += 1;
  return {
    id: nextId,
    field: 'home_district',
    area: 'District profile',
    question: `Question ${nextId}?`,
    likelihood: 'likely',
    notes: null,
    prep: 'not_started',
    flagged: false,
    createdAt: '2026-09-08T00:00:00.000Z',
    ...overrides,
  };
}

/* ------------------------- seam 1: the two frozen field lists */

describe('seam: the app`s DAF fields <-> the server`s', () => {
  /**
   * `DAF_FIELDS` from `server/src/interview/types.ts`, restated.
   *
   * Restated rather than imported: the two packages are never compiled
   * together, which is the whole reason this file exists. The server turns its
   * copy into a JSON Schema `enum`, so a field here and not there comes back as
   * a question dropped for `unknown_field` — with a 200 on the wire.
   */
  const SERVER_FIELDS = [
    'full_name',
    'home_town',
    'home_district',
    'home_state',
    'schooling',
    'graduation_subject',
    'university',
    'post_graduation',
    'achievements',
    'positions_held',
    'hobbies',
    'sports',
    'employment',
    'optional_subject',
    'service_preferences',
    'cadre_preferences',
  ] as const;

  it('holds exactly the same fields, in the same order', () => {
    assert.deepEqual([...DAF_FIELDS], [...SERVER_FIELDS]);
  });

  it('sends only fields the server`s enum will accept', () => {
    const request = buildQuestionsRequest({
      requestId: 'r',
      entries: DAF_FIELDS.map((field) => entry(field, 'a filled value')),
      bankedQuestions: [],
    });
    for (const each of request.entries) {
      assert.ok(
        (SERVER_FIELDS as readonly string[]).includes(each.field),
        `"${each.field}" is not in the server's enum`,
      );
    }
  });

  it('restates the same likelihoods the server`s enum holds', () => {
    assert.deepEqual([...LIKELIHOODS], ['certain', 'likely', 'possible']);
  });
});

/* ------------------------- seam 2: the form -> the request */

describe('seam: what she has filled -> what gets generated from', () => {
  it('sends every field `formState` calls filled, and no others', () => {
    // The two must agree on "filled": a field the form shows as answered but
    // the request omits would produce questions she cannot see the source of.
    const entries = [entry('hobbies', 'Reading Indian political history'), entry('sports', '  ')];
    const filled = formState(entries).filter((f) => !f.empty).map((f) => f.field);
    const sent = buildQuestionsRequest({ requestId: 'r', entries, bankedQuestions: [] }).entries.map(
      (e) => e.field,
    );
    assert.deepEqual(sent, filled);
  });

  it('sends nothing from an empty form, which the server refuses', () => {
    // A 400 is the correct outcome and the screen says so — with no entries
    // there is nothing to generate from except invention.
    const request = buildQuestionsRequest({ requestId: 'r', entries: [], bankedQuestions: [] });
    assert.equal(request.entries.length, 0);
  });

  it('asks for a batch the server`s ceiling will accept', () => {
    // `MAX_QUESTIONS_PER_BATCH` on the server is 20.
    assert.ok(DAF_RULES.batchSize >= 1 && DAF_RULES.batchSize <= 20);
  });

  it('caps a value where she types it, not only at the server', () => {
    // `MAX_VALUE_CHARS` on the server is 600 and the form now enforces the same
    // number on the input. The two are not redundant: the server's is a safety
    // limit on a request body, and a safety limit that fires FIRST is a 400 on
    // an employment description she has already typed, with nothing on screen
    // saying which field was too long. This assertion caught exactly that.
    const SERVER_MAX_VALUE_CHARS = 600;
    assert.equal(DAF_RULES.maxValueChars, SERVER_MAX_VALUE_CHARS);
  });
});

/* ------------------------- seam 3: questions -> readiness -> screen */

describe('seam: banked questions -> what the screens show', () => {
  it('agrees between the area list and the summary`s weakest', () => {
    // Two sorts that could disagree would put a different area at the top of
    // the list from the one the sentence above it names.
    const questions = [
      question({ area: 'Hobbies', likelihood: 'possible', field: 'hobbies' }),
      question({ area: 'District profile', likelihood: 'certain' }),
    ];
    const areas = readinessByArea(questions);
    assert.equal(summariseReadiness(areas, questions).weakest?.area, areas[0]?.area);
  });

  it('never reports an area as ready on notes alone', () => {
    // Notes count half by design; the threshold is above half so that reading
    // about an area cannot mark it done.
    const questions = [question({ prep: 'notes_made' }), question({ prep: 'notes_made' })];
    const areas = readinessByArea(questions);
    assert.ok(readyShare(areas[0]!) < DAF_RULES.readyShare);
    assert.equal(summariseReadiness(areas, questions).ready, 0);
  });

  it('surfaces a flagged question at the top of the list she works through', () => {
    const flagged = question({ flagged: true, likelihood: 'possible', prep: 'rehearsed' });
    const ordered = questionOrder([question({ likelihood: 'certain' }), flagged]);
    assert.equal(ordered[0]?.id, flagged.id);
    // And it is counted, not hidden.
    const questions = [flagged, question()];
    assert.equal(summariseReadiness(readinessByArea(questions), questions).flagged, 1);
  });

  it('renders every prep state the repository can return', () => {
    // `db/daf.ts` coerces an unrecognised value to `not_started`, so the three
    // here are the complete set a screen must handle.
    const questions = PREP_STATES.map((prep) => question({ prep }));
    const areas = readinessByArea(questions);
    assert.equal(areas[0]?.total, PREP_STATES.length);
    assert.equal(areas[0]!.rehearsed + areas[0]!.notesMade + areas[0]!.notStarted, PREP_STATES.length);
  });
});

/* ------------------------- seam 4: the 2026 case */

describe('seam: the reason this is open two years early', () => {
  it('treats a one-word hobby as an unfilled early decision', () => {
    // The whole argument for building this now. "Reading" in July 2028 is a
    // decision made under deadline about two years already spent, and counting
    // it as done would defeat the feature.
    const summary = summariseForm(formState([entry('hobbies', 'Reading')]));
    assert.ok(summary.earlyGaps.includes('hobbies'));
  });

  it('names the employment she holds right now as an early decision', () => {
    // What she can say about the job depends on what she notices while doing
    // it, not on what she reconstructs in 2028.
    assert.ok(DECIDE_EARLY.includes('employment'));
    assert.match(FIELD_RATIONALE.employment, /notice things about it while you can/);
  });

  it('explains every field on the form', () => {
    // A form whose purpose is invisible gets filled in carelessly, and
    // carelessly here means a hobby she cannot defend.
    for (const field of DAF_FIELDS) {
      assert.notEqual((FIELD_LABELS[field] ?? '').trim(), '');
      assert.notEqual((FIELD_RATIONALE[field] ?? '').trim(), '');
    }
  });
});
