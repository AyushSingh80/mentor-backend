/**
 * The DAF form and interview readiness.
 *
 * Two properties carry most of the value here, and both read as odd until you
 * know why: readiness is ordered by LIKELIHOOD rather than by how much is
 * outstanding, and flagged questions sort FIRST rather than being hidden.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  describeForm,
  formState,
  monthsToDaf,
  questionOrder,
  readinessByArea,
  readyShare,
  summariseForm,
  summariseReadiness,
  wordCount,
} from '../src/lib/daf';
import {
  DAF_FIELDS,
  DAF_RULES,
  DECIDE_EARLY,
  FIELD_LABELS,
  FIELD_RATIONALE,
  GROUP_LABELS,
  GROUP_OF_FIELD,
  PREP_LABELS,
  PREP_STATES,
  type DafEntry,
  type DafField,
  type InterviewQuestion,
  type Likelihood,
  type PrepState,
} from '../src/lib/daf-types';

function entry(field: DafField, value: string): DafEntry {
  return { field, value, updatedAt: '2026-09-08T00:00:00.000Z' };
}

let nextId = 0;
function question(overrides: Partial<InterviewQuestion> = {}): InterviewQuestion {
  nextId += 1;
  return {
    id: nextId,
    field: 'home_district',
    area: 'District profile',
    question: `A question ${nextId}?`,
    likelihood: 'likely',
    notes: null,
    prep: 'not_started',
    flagged: false,
    createdAt: '2026-09-08T00:00:00.000Z',
    ...overrides,
  };
}

/* -------------------------------------------------------------- the form */

describe('formState', () => {
  it('returns every field, filled or not', () => {
    // A form showing only what has been answered makes the gaps invisible, and
    // the gaps are the product.
    const state = formState([entry('home_district', 'Barpeta')]);
    assert.equal(state.length, DAF_FIELDS.length);
    assert.equal(state.filter((f) => f.empty).length, DAF_FIELDS.length - 1);
  });

  it('keeps the declared order', () => {
    assert.deepEqual(formState([]).map((f) => f.field), [...DAF_FIELDS]);
  });

  it('marks a one-word answer as thin without refusing it', () => {
    // "Reading" is a hobby a board takes apart in ninety seconds. It is still
    // her form, and a one-word answer may be the true one.
    const state = formState([entry('hobbies', 'Reading')]);
    const hobbies = state.find((f) => f.field === 'hobbies')!;
    assert.equal(hobbies.thin, true);
    assert.equal(hobbies.empty, false);
    assert.equal(hobbies.value, 'Reading');
  });

  it('does not call a defended answer thin', () => {
    const state = formState([
      entry('hobbies', 'Reading — mainly Indian political history, currently Guha'),
    ]);
    assert.equal(state.find((f) => f.field === 'hobbies')?.thin, false);
  });

  it('flags the fields whose answer is decided by what she does now', () => {
    const state = formState([]);
    for (const field of DECIDE_EARLY) {
      assert.equal(state.find((f) => f.field === field)?.decideEarly, true);
    }
    assert.equal(state.find((f) => f.field === 'home_district')?.decideEarly, false);
  });

  it('treats whitespace as empty', () => {
    assert.equal(formState([entry('hobbies', '   \n ')]).find((f) => f.field === 'hobbies')?.empty, true);
  });
});

describe('summariseForm and describeForm', () => {
  it('leads with the early-decision gaps, because only those cost time', () => {
    const summary = summariseForm(formState([entry('home_district', 'Barpeta, Assam')]));
    assert.ok(summary.earlyGaps.length > 0);
    const text = describeForm(summary, 23);
    assert.match(text ?? '', /23 months away/);
    assert.match(text ?? '', /these you decide/);
  });

  it('counts a thin early field as a gap, not as filled', () => {
    // "Reading" is exactly the decision made under deadline this exists to
    // catch, and counting it as done would defeat the feature.
    const summary = summariseForm(formState([entry('hobbies', 'Reading')]));
    assert.ok(summary.earlyGaps.includes('hobbies'));
  });

  it('mentions thin answers once the early fields are settled', () => {
    const filled = DECIDE_EARLY.map((field) => entry(field, 'a properly defended answer here'));
    const summary = summariseForm(formState([...filled, entry('home_town', 'Barpeta')]));
    assert.deepEqual(summary.earlyGaps, []);
    assert.match(describeForm(summary, 20) ?? '', /ninety seconds/);
  });

  it('says nothing about a complete form', () => {
    // An app that always has an opinion is one whose opinions stop being read.
    const full = DAF_FIELDS.map((field) => entry(field, 'a properly defended answer here'));
    assert.equal(describeForm(summariseForm(formState(full)), 20), null);
  });

  it('works without a horizon', () => {
    const summary = summariseForm(formState([]));
    assert.match(describeForm(summary, null) ?? '', /before the form is due/);
  });
});

/* --------------------------------------------------------------- readiness */

describe('readinessByArea', () => {
  it('orders certain areas before likely ones, whatever the counts', () => {
    // The property that reads as odd and matters most. Ordering by outstanding
    // count would bury the home district under hobbies, which generate the
    // longest lists because they are the easiest to ask about.
    const areas = readinessByArea([
      ...Array.from({ length: 10 }, () =>
        question({ area: 'Hobbies', likelihood: 'possible', field: 'hobbies' }),
      ),
      question({ area: 'District profile', likelihood: 'certain' }),
    ]);
    assert.equal(areas[0]?.area, 'District profile');
  });

  it('takes an area`s likelihood from its most likely question', () => {
    // The board reaching that question is what opens the area; everything
    // after it follows.
    const areas = readinessByArea([
      question({ area: 'District profile', likelihood: 'possible' }),
      question({ area: 'District profile', likelihood: 'certain' }),
    ]);
    assert.equal(areas[0]?.likelihood, 'certain');
  });

  it('puts the least ready area first among equally likely ones', () => {
    const areas = readinessByArea([
      question({ area: 'Optional', likelihood: 'certain', prep: 'rehearsed' }),
      question({ area: 'District profile', likelihood: 'certain', prep: 'not_started' }),
    ]);
    assert.equal(areas[0]?.area, 'District profile');
  });

  it('counts each prep state separately', () => {
    const areas = readinessByArea([
      question({ prep: 'rehearsed' }),
      question({ prep: 'notes_made' }),
      question({ prep: 'not_started' }),
    ]);
    assert.deepEqual(
      { r: areas[0]?.rehearsed, n: areas[0]?.notesMade, s: areas[0]?.notStarted, t: areas[0]?.total },
      { r: 1, n: 1, s: 1, t: 3 },
    );
  });

  it('is deterministic', () => {
    const questions = [
      question({ area: 'B', likelihood: 'likely' }),
      question({ area: 'A', likelihood: 'likely' }),
    ];
    assert.deepEqual(
      readinessByArea(questions).map((a) => a.area),
      readinessByArea(questions).map((a) => a.area),
    );
  });
});

describe('readyShare', () => {
  it('counts notes as half, because saying it out loud is the other skill', () => {
    const [area] = readinessByArea([
      question({ prep: 'notes_made' }),
      question({ prep: 'notes_made' }),
    ]);
    assert.equal(readyShare(area!), 0.5);
  });

  it('counts a rehearsed question in full', () => {
    const [area] = readinessByArea([question({ prep: 'rehearsed' })]);
    assert.equal(readyShare(area!), 1);
  });

  it('is zero for an empty area rather than NaN', () => {
    assert.equal(
      readyShare({
        area: 'x',
        field: null,
        likelihood: 'possible',
        total: 0,
        rehearsed: 0,
        notesMade: 0,
        notStarted: 0,
      }),
      0,
    );
  });
});

describe('summariseReadiness', () => {
  it('names the most likely unready area as the weakest', () => {
    const questions = [
      question({ area: 'Optional', likelihood: 'certain', prep: 'not_started' }),
      question({ area: 'Hobbies', likelihood: 'possible', prep: 'not_started' }),
    ];
    const summary = summariseReadiness(readinessByArea(questions), questions);
    assert.equal(summary.weakest?.area, 'Optional');
  });

  it('agrees with the ordering rather than re-sorting', () => {
    // Two sorts that could disagree would put a different area at the top of
    // the list from the one the summary sentence names.
    const questions = [
      question({ area: 'A', likelihood: 'likely', prep: 'not_started' }),
      question({ area: 'B', likelihood: 'certain', prep: 'not_started' }),
    ];
    const areas = readinessByArea(questions);
    assert.equal(summariseReadiness(areas, questions).weakest?.area, areas[0]?.area);
  });

  it('has no weakest when everything is ready', () => {
    const questions = [question({ prep: 'rehearsed' })];
    assert.equal(summariseReadiness(readinessByArea(questions), questions).weakest, null);
  });

  it('counts flagged questions rather than hiding them', () => {
    const questions = [question({ flagged: true }), question()];
    assert.equal(summariseReadiness(readinessByArea(questions), questions).flagged, 1);
  });
});

/* ------------------------------------------------------------------ order */

describe('questionOrder', () => {
  it('puts flagged questions FIRST', () => {
    // The question she flinched at is the one to prepare. Burying it would be
    // helping her avoid the interview rather than prepare for it.
    const flagged = question({ flagged: true, likelihood: 'possible', prep: 'rehearsed' });
    const ordered = questionOrder([question({ likelihood: 'certain' }), flagged]);
    assert.equal(ordered[0]?.id, flagged.id);
  });

  it('then orders by likelihood', () => {
    const certain = question({ likelihood: 'certain' });
    const ordered = questionOrder([question({ likelihood: 'possible' }), certain]);
    assert.equal(ordered[0]?.id, certain.id);
  });

  it('then puts the least prepared first', () => {
    const fresh = question({ likelihood: 'likely', prep: 'not_started' });
    const ordered = questionOrder([question({ likelihood: 'likely', prep: 'rehearsed' }), fresh]);
    assert.equal(ordered[0]?.id, fresh.id);
  });

  it('does not mutate its input', () => {
    const questions = [question({ id: 2 }), question({ id: 1, flagged: true })];
    const before = questions.map((q) => q.id);
    questionOrder(questions);
    assert.deepEqual(questions.map((q) => q.id), before);
  });
});

/* ---------------------------------------------------------------- horizon */

describe('monthsToDaf', () => {
  it('counts months to the Mains application window', () => {
    assert.equal(monthsToDaf('2026-09-08', 2028), 23);
  });

  it('floors at zero rather than going negative', () => {
    assert.equal(monthsToDaf('2029-01-01', 2028), 0);
  });

  it('returns null on an unparseable day rather than NaN', () => {
    assert.equal(monthsToDaf('someday', 2028), null);
  });
});

/* ------------------------------------------------------------ the vocabulary */

describe('the frozen vocabulary', () => {
  it('labels, groups and explains every field', () => {
    // A form whose purpose is invisible gets filled in carelessly, and
    // carelessly here means a hobby she cannot defend.
    for (const field of DAF_FIELDS) {
      assert.notEqual((FIELD_LABELS[field] ?? '').trim(), '', `${field} has no label`);
      assert.notEqual((FIELD_RATIONALE[field] ?? '').trim(), '', `${field} has no rationale`);
      assert.notEqual(GROUP_LABELS[GROUP_OF_FIELD[field]], undefined, `${field} has no group`);
    }
  });

  it('labels every prep state', () => {
    for (const state of PREP_STATES) {
      assert.notEqual((PREP_LABELS[state as PrepState] ?? '').trim(), '');
    }
  });

  it('keeps the ready threshold reachable with notes alone impossible', () => {
    // Notes count half, so an area of pure notes scores 0.5 — deliberately
    // below the threshold. Being able to say it out loud is the point.
    assert.ok(DAF_RULES.readyShare > 0.5, 'notes alone must not make an area ready');
    assert.ok(DAF_RULES.readyShare <= 1);
  });

  it('every decide-early field is a real field', () => {
    for (const field of DECIDE_EARLY) {
      assert.ok((DAF_FIELDS as readonly string[]).includes(field));
    }
  });
});

describe('wordCount', () => {
  it('counts nothing as zero', () => {
    assert.equal(wordCount('  '), 0);
    assert.equal(wordCount('one two'), 2);
  });
});

/* keeps `Likelihood` imported and asserted rather than merely declared */
describe('likelihood', () => {
  it('orders certain before likely before possible', () => {
    const order: Likelihood[] = ['certain', 'likely', 'possible'];
    const areas = readinessByArea(order.map((likelihood, i) => question({ area: `A${i}`, likelihood })));
    assert.deepEqual(areas.map((a) => a.likelihood), order);
  });
});
