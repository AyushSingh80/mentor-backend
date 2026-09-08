/**
 * Drill attempt logic.
 *
 * The dimension parser gets the most attention here, because it is the one
 * piece of Phase 5 that gives feedback with no model and no signal, and because
 * its failure mode is the expensive direction: telling her she has covered a
 * lens she has not means the outline goes into an essay one dimension thinner
 * than she believes it is.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  checkSubmittable,
  drillProgress,
  elapsedMinutes,
  namedDimensions,
  openDimensions,
  targetMinutes,
  wordCount,
} from '../src/lib/drills';
import { DRILL_RULES, ESSAY_DIMENSIONS, type DrillPartFacts } from '../src/lib/drill-types';

function part(name: string, content: string): DrillPartFacts {
  return { part: name as DrillPartFacts['part'], content, words: wordCount(content) };
}

/** A dimensions block naming `n` lenses, each with a real angle. */
function dimensionsBlock(n: number): string {
  return ESSAY_DIMENSIONS.slice(0, n)
    .map((d) => `${d[0]!.toUpperCase()}${d.slice(1)}: a specific angle written out here`)
    .join('\n');
}

/* ------------------------------------------------------------------ words */

describe('wordCount', () => {
  it('counts whitespace-separated tokens', () => {
    assert.equal(wordCount('one two three'), 3);
    assert.equal(wordCount('  padded   out  '), 2);
    assert.equal(wordCount('line\nbreaks\tcount'), 3);
  });

  it('counts nothing as zero, not one', () => {
    assert.equal(wordCount(''), 0);
    assert.equal(wordCount('   \n  '), 0);
  });
});

/* ------------------------------------------------------------- dimensions */

describe('namedDimensions', () => {
  it('reads a labelled line', () => {
    assert.deepEqual(
      namedDimensions('Political: federal friction over data localisation'),
      ['political'],
    );
  });

  it('tolerates the list furniture she actually writes', () => {
    const content = [
      '- Political: federal friction over data localisation',
      '* Economic — compliance cost falls hardest on small firms',
      '1. Social: who is left outside the digital perimeter',
      '**Ethical**: privacy as a positive right, not a permission',
    ].join('\n');
    assert.deepEqual(namedDimensions(content), ['political', 'economic', 'social', 'ethical']);
  });

  it('accepts the word "angle" as the separator', () => {
    assert.deepEqual(
      namedDimensions('Historical angle the Emergency and the memory of surveillance'),
      ['historical'],
    );
  });

  it('is case-insensitive on the label', () => {
    assert.deepEqual(namedDimensions('ENVIRONMENTAL: the water cost of data centres'), [
      'environmental',
    ]);
  });

  it('does NOT count a lens merely mentioned in prose', () => {
    // The whole reason this is a label parser and not `includes()`. An outline
    // that uses the word in a sentence has not worked the topic through that
    // lens, and telling her it has is the direction that costs marks.
    const prose =
      'The political classes have long argued that economic growth settles social questions.';
    assert.deepEqual(namedDimensions(prose), []);
  });

  it('does NOT count a bare heading with no angle after it', () => {
    // Otherwise a full-marks dimension map is seven bare words, which is
    // exactly the padding the floor exists to prevent.
    assert.deepEqual(namedDimensions('Political:\nEconomic:\nSocial:'), []);
    assert.deepEqual(namedDimensions('Political: yes'), []);
  });

  it('counts a lens once however many times it is labelled', () => {
    const content = 'Political: one angle here\nPolitical: another angle here';
    assert.deepEqual(namedDimensions(content), ['political']);
  });

  it('ignores labels that are not lenses', () => {
    assert.deepEqual(namedDimensions('Thesis: the state is the wrong unit of analysis'), []);
  });

  it('returns lenses in the declared order, not the order written', () => {
    // So two outlets of the same outline compare byte-for-byte, and so a
    // screen listing them never reshuffles between renders.
    const content = 'Social: b angle written out\nPolitical: a angle written out';
    assert.deepEqual(namedDimensions(content), ['political', 'social']);
  });
});

describe('openDimensions', () => {
  it('names what is left, in the declared order', () => {
    const open = openDimensions('Political: a real angle here\nEconomic: another real angle');
    assert.deepEqual(open, ['social', 'ethical', 'environmental', 'historical', 'international']);
  });

  it('is empty when every lens is named', () => {
    assert.deepEqual(openDimensions(dimensionsBlock(ESSAY_DIMENSIONS.length)), []);
  });

  it('is the whole list for an empty part', () => {
    assert.deepEqual(openDimensions(''), [...ESSAY_DIMENSIONS]);
  });
});

/* ------------------------------------------------------------- submission */

describe('checkSubmittable — essay outline', () => {
  const good: DrillPartFacts[] = [
    part('thesis', 'Data localisation is a sovereignty claim dressed as a privacy measure, and the two pull apart.'),
    part('dimensions', dimensionsBlock(4)),
    part('opening', 'In 1975 the state read the post. In 2026 it does not have to. '.repeat(3)),
    part('closing', 'Sovereignty over data is worth having only if the citizen is sovereign first. '.repeat(3)),
  ];

  it('passes a complete outline', () => {
    const check = checkSubmittable('essay_outline', good);
    assert.equal(check.ready, true, check.blocker ?? '');
    assert.equal(check.blocker, null);
  });

  it('reports every part, not only the failing one', () => {
    // The screen marks each part; a check that returned only the first problem
    // would make her fix them one round trip at a time.
    const check = checkSubmittable('essay_outline', good);
    assert.deepEqual(
      check.parts.map((p) => p.part),
      ['thesis', 'dimensions', 'opening', 'closing'],
    );
  });

  it('blocks a missing part', () => {
    const check = checkSubmittable('essay_outline', good.filter((p) => p.part !== 'closing'));
    assert.equal(check.ready, false);
    assert.match(check.blocker ?? '', /^closing:/);
    assert.equal(check.parts.find((p) => p.part === 'closing')?.problem, 'missing');
  });

  it('blocks a part that is a heading rather than an answer', () => {
    const check = checkSubmittable('essay_outline', [
      part('thesis', 'Data localisation is bad'),
      ...good.slice(1),
    ]);
    assert.equal(check.parts.find((p) => p.part === 'thesis')?.problem, 'too_short');
  });

  it('blocks a part that has become prose', () => {
    const check = checkSubmittable('essay_outline', [
      part('thesis', 'word '.repeat(DRILL_RULES.maxPartWords + 1)),
      ...good.slice(1),
    ]);
    assert.equal(check.parts.find((p) => p.part === 'thesis')?.problem, 'too_long');
    assert.match(check.blocker ?? '', /has become prose/);
  });

  it('blocks a dimension map under the floor, and says which lenses are open', () => {
    const thin = [good[0]!, part('dimensions', dimensionsBlock(2)), ...good.slice(2)];
    const check = checkSubmittable('essay_outline', thin);
    assert.equal(check.ready, false);
    assert.equal(check.parts.find((p) => p.part === 'dimensions')?.problem, 'too_few_dimensions');
    assert.match(check.blocker ?? '', /2 of 7 lenses named/);
  });

  it('says something useful when no lens is labelled at all', () => {
    // A different failure from "too few": the answer may be full of angles and
    // simply unlabelled, and telling her to write "0 of 7" would be wrong.
    const unlabelled = [
      good[0]!,
      part('dimensions', 'There is a sovereignty argument, a cost argument, and a rights argument.'),
      ...good.slice(2),
    ];
    const check = checkSubmittable('essay_outline', unlabelled);
    assert.match(check.blocker ?? '', /Label each line/);
  });

  it('accepts exactly the floor', () => {
    const atFloor = [
      good[0]!,
      part('dimensions', dimensionsBlock(DRILL_RULES.minDimensions)),
      ...good.slice(2),
    ];
    assert.equal(checkSubmittable('essay_outline', atFloor).ready, true);
  });
});

describe('checkSubmittable — ethics case', () => {
  const good: DrillPartFacts[] = [
    part('keywords', 'Probity is conduct that does not require a witness. Conflict of interest is a structural fact, not an accusation.'),
    part('stakeholders', 'The contractor, the sub-district engineer, the villagers awaiting the road, my own subordinates, and the office after I leave it.'),
    part('options', 'Accept and expedite: the road is built, and the office is purchasable thereafter. Refuse and record: slower, and the record protects my successor. Refer upward: honest, but abdicates a decision that is mine.'),
    part('decision', 'Refuse and record in writing, naming the delay it causes to the villagers, who are the ones harmed by my choice.'),
    part('theory', 'Deontological: the rule against gratification does not bend to a good outcome. Constitutional morality holds the office above the officer.'),
  ];

  it('passes a complete case answer', () => {
    const check = checkSubmittable('ethics_case', good);
    assert.equal(check.ready, true, check.blocker ?? '');
  });

  it('checks the five parts the rubric names, in its order', () => {
    assert.deepEqual(
      checkSubmittable('ethics_case', good).parts.map((p) => p.part),
      ['keywords', 'stakeholders', 'options', 'decision', 'theory'],
    );
  });

  it('never applies the dimension rule to a case', () => {
    // `dimensions` is an essay part. A case answer has no lens map, and a gate
    // leaking across kinds would make ethics undrillable.
    const check = checkSubmittable('ethics_case', good);
    assert.equal(
      check.parts.every((p) => p.problem !== 'too_few_dimensions'),
      true,
    );
  });
});

/* ---------------------------------------------------------------- elapsed */

describe('elapsedMinutes', () => {
  it('measures a normal attempt', () => {
    assert.equal(
      elapsedMinutes('essay_outline', '2026-09-07T08:00:00.000Z', '2026-09-07T08:22:00.000Z'),
      22,
    );
  });

  it('returns null for a screen left open overnight', () => {
    // The number this protects is `minutesSpent`, which is the only signal that
    // says whether she is getting faster. One nine-hour outline poisons that
    // average for months.
    assert.equal(
      elapsedMinutes('essay_outline', '2026-09-07T08:00:00.000Z', '2026-09-07T17:00:00.000Z'),
      null,
    );
  });

  it('returns null rather than the cap, so an unknown is never a measurement', () => {
    const capped = elapsedMinutes(
      'ethics_case',
      '2026-09-07T08:00:00.000Z',
      '2026-09-07T20:00:00.000Z',
    );
    assert.equal(capped, null);
    assert.notEqual(capped, targetMinutes('ethics_case') * 4);
  });

  it('keeps a genuinely slow first attempt', () => {
    // Three times the target is information worth having, not an error.
    assert.equal(
      elapsedMinutes('essay_outline', '2026-09-07T08:00:00.000Z', '2026-09-07T09:00:00.000Z'),
      60,
    );
  });

  it('returns null when the drill was never started', () => {
    assert.equal(elapsedMinutes('essay_outline', null, '2026-09-07T08:22:00.000Z'), null);
  });

  it('returns null on a clock that went backwards', () => {
    assert.equal(
      elapsedMinutes('essay_outline', '2026-09-07T08:22:00.000Z', '2026-09-07T08:00:00.000Z'),
      null,
    );
  });

  it('returns null on an unparseable instant rather than NaN', () => {
    assert.equal(elapsedMinutes('essay_outline', 'yesterday', '2026-09-07T08:00:00.000Z'), null);
  });

  it('allows a case longer than an outline', () => {
    assert.ok(targetMinutes('ethics_case') > targetMinutes('essay_outline'));
  });
});

/* --------------------------------------------------------------- progress */

describe('drillProgress', () => {
  it('counts parts with something in them', () => {
    const progress = drillProgress('essay_outline', [
      part('thesis', 'a real thesis sentence written out here'),
      part('dimensions', ''),
    ]);
    assert.equal(progress.written, 1);
    assert.equal(progress.total, 4);
  });

  it('points at the first empty part, in the declared order', () => {
    const progress = drillProgress('essay_outline', [
      part('thesis', 'a real thesis sentence written out here'),
      part('closing', 'a closing written out here'),
    ]);
    assert.equal(progress.nextPart, 'dimensions');
  });

  it('has no next part once every one is started', () => {
    const progress = drillProgress('ethics_case', [
      part('keywords', 'x y z'),
      part('stakeholders', 'x y z'),
      part('options', 'x y z'),
      part('decision', 'x y z'),
      part('theory', 'x y z'),
    ]);
    assert.equal(progress.nextPart, null);
    assert.equal(progress.written, 5);
  });

  it('treats whitespace as empty', () => {
    const progress = drillProgress('essay_outline', [part('thesis', '   \n  ')]);
    assert.equal(progress.written, 0);
    assert.equal(progress.nextPart, 'thesis');
  });
});
