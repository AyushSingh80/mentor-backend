/**
 * The set-level gate on an extracted past paper.
 *
 * Every test here is about an extraction that produces a hundred perfectly
 * VALID questions and one invalid PAPER: a number that is not there, a stem
 * that is there twice, a running header pasted into six questions, a key column
 * read one row out of alignment. `lib/pyq-import.ts` cannot see any of them —
 * it validates one row at a time and every row is fine.
 *
 * Two properties are load-bearing and both are asserted directly rather than
 * left implied: a failing invariant BLOCKS (non-zero exit), and nothing is ever
 * repaired (a frozen set survives the whole run unchanged).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EXIT_BLOCKED,
  EXIT_OK,
  EXIT_UNUSABLE,
  checkDropAccounting,
  checkDuplicateStems,
  checkKeyDistribution,
  checkKeyRuns,
  checkNumbering,
  checkPdfArtefacts,
  checkSuspiciousStems,
  defaultSampleSize,
  hasNegation,
  keySkewThreshold,
  normaliseStem,
  parseArgs,
  parseSetsJson,
  runCli,
  sampleForEyeCheck,
  verifySet,
  type VerifiableSet,
} from '../tools/pyq-verify';
import type { PyqMcq, PyqSet } from '../src/data/pyq/types';

/* ------------------------------------------------------------- fixtures */

const EXAM = 'prelims-gs1' as const;
const YEAR = 2023;
const BOOKLET = 'a' as const;

function mcq(number: number, overrides: Partial<PyqMcq> = {}): PyqMcq {
  return {
    number,
    stem: `Consider the following statements about topic ${number}.`,
    options: ['1 only', '2 only', 'Both 1 and 2', 'Neither 1 nor 2'],
    correctIndex: number % 4,
    eliminationLogic: null,
    difficulty: 'medium',
    syllabusSlug: null,
    ...overrides,
  };
}

function set(overrides: Partial<PyqSet> = {}): PyqSet {
  return {
    exam: EXAM,
    year: YEAR,
    booklet: BOOKLET,
    verification: {
      verifiedBy: 'SD',
      verifiedOn: '2026-09-08',
      keySource: 'upsc_official',
      sourceUrl: null,
      note: null,
    },
    mcqs: [],
    written: [],
    dropped: [],
    ...overrides,
  };
}

/** A clean paper of `n` questions with a rotating, run-free key. */
function paper(n: number, overrides: Partial<PyqSet> = {}): PyqSet {
  const mcqs: PyqMcq[] = [];
  for (let i = 1; i <= n; i += 1) mcqs.push(mcq(i));
  return set({ mcqs, ...overrides });
}

/** A paper whose keys are given explicitly, so a histogram can be built by hand. */
function paperWithKeys(keys: readonly number[]): PyqSet {
  return set({ mcqs: keys.map((key, i) => mcq(i + 1, { correctIndex: key })) });
}

function messagesOf(outcome: { messages: readonly string[] }): string {
  return outcome.messages.join(' | ');
}

/* ------------------------------------------------------------ numbering */

describe('checkNumbering', () => {
  it('passes when shipped plus dropped are exactly 1..N', () => {
    const s = set({
      mcqs: Array.from({ length: 97 }, (_, i) => mcq(i + 1)),
      dropped: [
        { number: 98, reason: 'map_or_diagram', note: null },
        { number: 99, reason: 'table_in_stem', note: null },
        { number: 100, reason: 'unreadable_scan', note: null },
      ],
    });
    assert.equal(checkNumbering(s, 100).status, 'pass');
  });

  it('FAILS on a gap — the segmenter swallowed a question', () => {
    const mcqs = Array.from({ length: 100 }, (_, i) => mcq(i + 1)).filter((m) => m.number !== 47);
    const outcome = checkNumbering(set({ mcqs }), 100);
    assert.equal(outcome.status, 'fail');
    assert.deepEqual(outcome.numbers, [47]);
    assert.match(messagesOf(outcome), /q047/);
  });

  it('FAILS on a duplicate number and names both', () => {
    const outcome = checkNumbering(set({ mcqs: [mcq(1), mcq(2), mcq(2), mcq(3)] }), 3);
    assert.equal(outcome.status, 'fail');
    assert.deepEqual(outcome.numbers, [2]);
    assert.match(messagesOf(outcome), /q002/);
  });

  it('FAILS when a number falls outside 1..N', () => {
    const outcome = checkNumbering(set({ mcqs: [mcq(1), mcq(2), mcq(101)] }), 3);
    assert.equal(outcome.status, 'fail');
    assert.match(messagesOf(outcome), /q101/);
  });

  it('FAILS on a non-integer number', () => {
    const outcome = checkNumbering(set({ mcqs: [mcq(1), mcq(2.5)] }), 2);
    assert.equal(outcome.status, 'fail');
    assert.match(messagesOf(outcome), /not whole numbers/);
  });

  it('FAILS on an extraction that produced nothing at all', () => {
    assert.equal(checkNumbering(set(), null).status, 'fail');
  });

  it('infers N from the highest number when none is given, and says so', () => {
    const outcome = checkNumbering(paper(97), null);
    assert.equal(outcome.status, 'pass');
    assert.match(messagesOf(outcome), /inferred/);
  });

  it('counts dropped numbers, so a drop is not also a gap', () => {
    const s = set({
      mcqs: [mcq(1), mcq(3)],
      dropped: [{ number: 2, reason: 'map_or_diagram', note: null }],
    });
    assert.equal(checkNumbering(s, 3).status, 'pass');
  });
});

/* ----------------------------------------------------- key distribution */

describe('checkKeyDistribution', () => {
  it('passes a near-uniform key', () => {
    assert.equal(checkKeyDistribution(paper(100)).status, 'pass');
  });

  it('FAILS a key skewed past the ceiling — the booklet/key catastrophe', () => {
    const keys = Array.from({ length: 100 }, (_, i) => (i < 45 ? 0 : (i % 3) + 1));
    const outcome = checkKeyDistribution(paperWithKeys(keys));
    assert.equal(outcome.status, 'fail');
    assert.match(messagesOf(outcome), /key 'A' takes 45 of 100/);
    assert.equal(outcome.numbers.length, 45);
  });

  it('passes just under the ceiling, so the threshold is a real line', () => {
    const keys = Array.from({ length: 100 }, (_, i) => (i < 44 ? 0 : (i % 3) + 1));
    assert.equal(checkKeyDistribution(paperWithKeys(keys)).status, 'pass');
  });

  it('FAILS when a letter never occurs at all — an off-by-one option mapping', () => {
    const keys = Array.from({ length: 40 }, (_, i) => i % 3);
    const outcome = checkKeyDistribution(paperWithKeys(keys));
    assert.equal(outcome.status, 'fail');
    assert.match(messagesOf(outcome), /never occurs/);
  });

  it('FAILS when a correctIndex names no option at all', () => {
    const s = paper(30);
    const broken = set({ mcqs: [...s.mcqs.slice(0, 29), mcq(30, { correctIndex: 7 })] });
    const outcome = checkKeyDistribution(broken);
    assert.equal(outcome.status, 'fail');
    assert.deepEqual(outcome.numbers, [30]);
  });

  it('SKIPS rather than passes when there are too few questions to conclude', () => {
    const outcome = checkKeyDistribution(paperWithKeys([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    assert.equal(outcome.status, 'skipped');
    assert.match(messagesOf(outcome), /cannot distinguish/);
  });

  it('tightens the ceiling as the paper gets longer', () => {
    assert.ok(keySkewThreshold(100) > 0.44 && keySkewThreshold(100) < 0.46);
    assert.ok(keySkewThreshold(400) < keySkewThreshold(100));
    assert.ok(keySkewThreshold(25) > keySkewThreshold(100));
  });
});

/* ------------------------------------------------------------- key runs */

describe('checkKeyRuns', () => {
  it('passes a rotating key', () => {
    assert.equal(checkKeyRuns(paper(100)).status, 'pass');
  });

  it('FAILS a page of key read out of alignment, which the histogram misses', () => {
    const keys = Array.from({ length: 100 }, (_, i) => (i >= 20 && i < 45 ? 0 : i % 4));
    const s = paperWithKeys(keys);
    // The whole point of this check: the share of 'A' stays under the ceiling.
    assert.equal(checkKeyDistribution(s).status, 'pass');
    const outcome = checkKeyRuns(s);
    assert.equal(outcome.status, 'fail');
    assert.match(messagesOf(outcome), /25 consecutive questions all answer 'A'/);
  });
});

/* ------------------------------------------------------ duplicate stems */

describe('checkDuplicateStems', () => {
  it('passes distinct stems', () => {
    assert.equal(checkDuplicateStems(paper(100)).status, 'pass');
  });

  it('FAILS two questions carrying one stem, and names both', () => {
    const s = set({ mcqs: [mcq(1), mcq(2, { stem: mcq(1).stem }), mcq(3)] });
    const outcome = checkDuplicateStems(s);
    assert.equal(outcome.status, 'fail');
    assert.deepEqual(outcome.numbers, [1, 2]);
  });

  it('sees through punctuation, case and whitespace', () => {
    const s = set({
      mcqs: [
        mcq(1, { stem: 'Which  river\nrises in the Amarkantak plateau?' }),
        mcq(2, { stem: 'which river rises in the amarkantak plateau' }),
      ],
    });
    assert.equal(checkDuplicateStems(s).status, 'fail');
  });

  it('does not call two questions duplicates for sharing a long preamble', () => {
    const preamble = 'Consider the following statements regarding the Indian Constitution and its amendment procedure as laid down in Article 368 together with the judicial interpretation applied to it over time. '.repeat(2);
    const s = set({
      mcqs: [
        mcq(1, { stem: `${preamble} 1. Statement about the basic structure.` }),
        mcq(2, { stem: `${preamble} 1. Statement about the ratification of states.` }),
      ],
    });
    assert.equal(checkDuplicateStems(s).status, 'pass');
  });

  it('normaliseStem does not truncate', () => {
    const long = 'a'.repeat(300);
    assert.equal(normaliseStem(long).length, 300);
  });
});

/* -------------------------------------------------------- PDF artefacts */

describe('checkPdfArtefacts', () => {
  it('passes clean text', () => {
    assert.equal(checkPdfArtefacts(paper(20)).status, 'pass');
  });

  it('FAILS a (cid: marker in a stem', () => {
    const s = set({ mcqs: [mcq(1, { stem: 'Which of the following (cid:31) is correct?' })] });
    const outcome = checkPdfArtefacts(s);
    assert.equal(outcome.status, 'fail');
    assert.match(messagesOf(outcome), /q001 stem/);
  });

  it('FAILS a (cid: marker in an option, naming the option', () => {
    const s = set({
      mcqs: [mcq(1, { options: ['1 only', '2 only', 'Both (cid:12) and 2', 'Neither'] })],
    });
    const outcome = checkPdfArtefacts(s);
    assert.equal(outcome.status, 'fail');
    assert.match(messagesOf(outcome), /q001 option C/);
  });

  it('FAILS a form feed', () => {
    const s = set({ mcqs: [mcq(1, { stem: 'Which river\f rises here?' })] });
    assert.equal(checkPdfArtefacts(s).status, 'fail');
  });

  it('FAILS a bare page number sitting on its own line', () => {
    const s = set({ mcqs: [mcq(1, { stem: 'Which river rises here?\n12\nSelect one.' })] });
    const outcome = checkPdfArtefacts(s);
    assert.equal(outcome.status, 'fail');
    assert.match(messagesOf(outcome), /page number/);
  });

  it('does not flag a numeric option, because the number IS the answer', () => {
    const s = set({ mcqs: [mcq(1, { options: ['28', '29', '30', '31'] })] });
    assert.equal(checkPdfArtefacts(s).status, 'pass');
  });

  it('FAILS a running header repeated across questions', () => {
    const header = 'General Studies Paper I Series A';
    const mcqs = [1, 2, 3, 4].map((n) =>
      mcq(n, { stem: `${header}\nConsider the statements for topic ${n}.` }),
    );
    const outcome = checkPdfArtefacts(set({ mcqs }));
    assert.equal(outcome.status, 'fail');
    assert.match(messagesOf(outcome), /running header/);
    assert.deepEqual(outcome.numbers, [1, 2, 3, 4]);
  });

  it('tolerates a header repeated only twice — that is not yet a pattern', () => {
    const header = 'General Studies Paper I Series A';
    const mcqs = [1, 2].map((n) => mcq(n, { stem: `${header}\nStatements for topic ${n}.` }));
    assert.equal(checkPdfArtefacts(set({ mcqs })).status, 'pass');
  });

  it('does not flag stock UPSC phrasing that legitimately repeats', () => {
    const mcqs = [1, 2, 3, 4, 5].map((n) =>
      mcq(n, {
        stem: `Topic ${n}.\n1. A statement.\nSelect the correct answer using the code given below`,
      }),
    );
    assert.equal(checkPdfArtefacts(set({ mcqs })).status, 'pass');
  });

  it('--allow-line lets a human declare a repeated line to be content', () => {
    const header = 'Read the passage and answer';
    const mcqs = [1, 2, 3, 4].map((n) => mcq(n, { stem: `${header}\nTopic ${n} statements.` }));
    assert.equal(checkPdfArtefacts(set({ mcqs })).status, 'fail');
    assert.equal(checkPdfArtefacts(set({ mcqs }), [header]).status, 'pass');
  });
});

/* ----------------------------------------------------- suspicious stems */

describe('checkSuspiciousStems', () => {
  it('flags negation for attention and never blocks on it', () => {
    const s = set({
      mcqs: [
        mcq(1, { stem: 'Which of the following is NOT a fundamental right?' }),
        mcq(2, { stem: 'All of the following are true except one.' }),
        mcq(3, { stem: 'Which statement is incorrect?' }),
        mcq(4),
      ],
    });
    const outcome = checkSuspiciousStems(s);
    assert.equal(outcome.status, 'attention');
    assert.deepEqual(outcome.numbers, [1, 2, 3]);
    assert.equal(verifySet(s, { expectedTotal: 4 }).blocked, false);
  });

  it('matches on word boundaries, so cannot and note are not negation', () => {
    assert.equal(hasNegation('One cannot note anything here.'), false);
    assert.equal(hasNegation('Nothing is exceptional.'), false);
    assert.equal(hasNegation('Which is NOT true?'), true);
    assert.equal(hasNegation('all except two'), true);
    assert.equal(hasNegation('the incorrectly matched pair'), true);
  });
});

/* ------------------------------------------------------ drop accounting */

describe('checkDropAccounting', () => {
  it('passes when shipped plus dropped equals the paper, every drop reasoned', () => {
    const s = set({
      mcqs: Array.from({ length: 98 }, (_, i) => mcq(i + 1)),
      dropped: [
        { number: 99, reason: 'map_or_diagram', note: null },
        { number: 100, reason: 'withdrawn_by_upsc', note: null },
      ],
    });
    assert.equal(checkDropAccounting(s, 100).status, 'pass');
  });

  it('FAILS a drop with no reason, naming the question', () => {
    // Typed as `VerifiableSet` because `PyqDropReason` makes this unrepresentable
    // in TypeScript — and JSON off a disk is under no such obligation.
    const s: VerifiableSet = { ...set({ mcqs: [mcq(1)] }), dropped: [{ number: 2, reason: '' }] };
    const outcome = checkDropAccounting(s, 2);
    assert.equal(outcome.status, 'fail');
    assert.deepEqual(outcome.numbers, [2]);
  });

  it('FAILS a reason that is not a PyqDropReason', () => {
    const s: VerifiableSet = {
      ...set({ mcqs: [mcq(1)] }),
      dropped: [{ number: 2, reason: 'looked_odd', note: null }],
    };
    const outcome = checkDropAccounting(s, 2);
    assert.equal(outcome.status, 'fail');
    assert.match(messagesOf(outcome), /not a PyqDropReason/);
  });

  it('FAILS when shipped plus dropped does not reach the paper total', () => {
    const outcome = checkDropAccounting(paper(94), 100);
    assert.equal(outcome.status, 'fail');
    assert.match(messagesOf(outcome), /6 question\(s\) are accounted for nowhere/);
  });

  it('SKIPS rather than passes when nobody said how long the paper is', () => {
    const outcome = checkDropAccounting(set({ ...paper(10), exam: 'mains-essay' }), null);
    assert.equal(outcome.status, 'skipped');
  });
});

/* ------------------------------------------------------------ verifySet */

describe('verifySet', () => {
  it('does not block a clean 100-question prelims paper', () => {
    const report = verifySet(paper(100));
    assert.equal(report.blocked, false);
    assert.equal(report.expectedTotal, 100, 'prelims-gs1 is 100 questions by default');
    assert.equal(report.setKey, 'pyq-prelims-gs1-2023-a');
  });

  it('blocks as soon as any one invariant fails', () => {
    const mcqs = Array.from({ length: 100 }, (_, i) => mcq(i + 1)).filter((m) => m.number !== 47);
    const report = verifySet(set({ mcqs }));
    assert.equal(report.blocked, true);
    assert.ok(report.checks.some((c) => c.check === 'numbering' && c.status === 'fail'));
  });

  it('runs every named invariant, so none can be quietly dropped', () => {
    const names = verifySet(paper(100)).checks.map((c) => c.check);
    assert.deepEqual(names, [
      'numbering',
      'drop_accounting',
      'key_distribution',
      'key_runs',
      'duplicate_stems',
      'pdf_artefacts',
      'suspicious_stems',
    ]);
  });

  it('NEVER repairs: a deeply frozen set survives the whole run unchanged', () => {
    const s = paper(100);
    const before = JSON.stringify(s);
    const freeze = (value: unknown): void => {
      if (typeof value !== 'object' || value === null) return;
      Object.freeze(value);
      for (const child of Object.values(value)) freeze(child);
    };
    freeze(s);
    const report = verifySet(s);
    sampleForEyeCheck(s, 15);
    assert.equal(report.blocked, false);
    assert.equal(JSON.stringify(s), before);
  });
});

/* ------------------------------------------------------------- sampling */

describe('sampleForEyeCheck', () => {
  const NEGATION_STEM = 'Which of the following is NOT correct about topic ';

  /** 100 questions of which `negations` carry a negation word. */
  function mixedPaper(negations: number): PyqSet {
    const mcqs = Array.from({ length: 100 }, (_, i) =>
      mcq(i + 1, i % Math.floor(100 / negations) === 0 ? { stem: `${NEGATION_STEM}${i + 1}?` } : {}),
    );
    return set({ mcqs });
  }

  it('is fifteen per hundred by default', () => {
    assert.equal(defaultSampleSize(100), 15);
    assert.equal(defaultSampleSize(200), 30);
    assert.equal(defaultSampleSize(0), 0);
    assert.equal(defaultSampleSize(1), 1);
  });

  it('weights the sample toward negation stems', () => {
    const s = mixedPaper(20);
    const picked = sampleForEyeCheck(s, 15);
    assert.equal(picked.length, 15);
    const negation = picked.filter((item) => item.negation).length;
    assert.equal(negation, 9, 'ceil(15 * 0.6) of the sample is negation-bearing');
    assert.ok(negation / 15 > 20 / 100, 'over-weighted relative to the paper');
  });

  it('still fills the sample when there are few negation stems', () => {
    const mcqs = Array.from({ length: 100 }, (_, i) =>
      mcq(i + 1, i < 3 ? { stem: `${NEGATION_STEM}${i + 1}?` } : {}),
    );
    const picked = sampleForEyeCheck(set({ mcqs }), 15);
    assert.equal(picked.length, 15);
    assert.equal(picked.filter((item) => item.negation).length, 3);
  });

  it('spreads across the whole paper rather than clumping', () => {
    const picked = sampleForEyeCheck(paper(100), 15);
    const numbers = picked.map((item) => item.number);
    assert.ok(Math.min(...numbers) < 15, 'reaches the first page');
    assert.ok(Math.max(...numbers) > 85, 'reaches the last page');
  });

  it('is deterministic, so a re-run gives the same list to check', () => {
    const s = mixedPaper(20);
    assert.deepEqual(sampleForEyeCheck(s, 15), sampleForEyeCheck(s, 15));
  });

  it('carries the key letter and the options in printed order', () => {
    const picked = sampleForEyeCheck(set({ mcqs: [mcq(1, { correctIndex: 2 })] }), 1);
    assert.equal(picked[0].keyLetter, 'C');
    assert.deepEqual(picked[0].options, ['1 only', '2 only', 'Both 1 and 2', 'Neither 1 nor 2']);
  });

  it('never asks for more than exists, and never for less than nothing', () => {
    assert.equal(sampleForEyeCheck(paper(5), 50).length, 5);
    assert.equal(sampleForEyeCheck(paper(5), 0).length, 0);
    assert.equal(sampleForEyeCheck(set(), 15).length, 0);
  });
});

/* --------------------------------------------------------- reading JSON */

describe('parseSetsJson', () => {
  it('accepts a bare set, an array of sets and a dataset', () => {
    const one = paper(3);
    for (const text of [
      JSON.stringify(one),
      JSON.stringify([one]),
      JSON.stringify({ version: 1, sets: [one], renames: [] }),
    ]) {
      const parsed = parseSetsJson(text);
      assert.equal(parsed.ok, true);
      if (parsed.ok) assert.equal(parsed.sets.length, 1);
    }
  });

  it('refuses text it cannot read as a set, naming the path', () => {
    const parsed = parseSetsJson('{"exam":"prelims-gs1","year":2023,"booklet":"a","mcqs":[{"number":1}]}');
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.match(parsed.errors.join(' '), /sets\[0\]\.mcqs\[0\]\.stem/);
  });

  it('refuses invalid JSON', () => {
    assert.equal(parseSetsJson('{not json').ok, false);
  });

  it('does not invent a reason for a drop that has none — the check reports it', () => {
    const text = JSON.stringify({ ...set({ mcqs: [mcq(1)] }), dropped: [{ number: 2 }] });
    const parsed = parseSetsJson(text);
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.sets[0].dropped[0].reason, '');
      assert.equal(checkDropAccounting(parsed.sets[0], 2).status, 'fail');
    }
  });
});

/* ------------------------------------------------------------------ CLI */

describe('runCli', () => {
  function reader(text: string): (path: string) => string {
    return () => text;
  }

  it('exits clean on a good paper', () => {
    const result = runCli(['set.json'], reader(JSON.stringify(paper(100))));
    assert.equal(result.exitCode, EXIT_OK);
    assert.match(result.lines.join('\n'), /A pass is NOT a verified key/);
  });

  it('BLOCKS with a non-zero exit when an invariant fails', () => {
    const mcqs = Array.from({ length: 100 }, (_, i) => mcq(i + 1)).filter((m) => m.number !== 47);
    const result = runCli(['set.json'], reader(JSON.stringify(set({ mcqs }))));
    assert.equal(result.exitCode, EXIT_BLOCKED);
    assert.match(result.lines.join('\n'), /BLOCKED/);
    assert.match(result.lines.join('\n'), /q047/);
  });

  it('BLOCKS a mis-keyed paper — every question valid, the set is not', () => {
    const keys = Array.from({ length: 100 }, (_, i) => (i < 60 ? 0 : (i % 3) + 1));
    const result = runCli(['set.json'], reader(JSON.stringify(paperWithKeys(keys))));
    assert.equal(result.exitCode, EXIT_BLOCKED);
    assert.match(result.lines.join('\n'), /wrong column or the wrong booklet/);
  });

  it('exits 2, not 1, when the input itself cannot be read', () => {
    assert.equal(runCli(['set.json'], reader('{not json')).exitCode, EXIT_UNUSABLE);
    assert.equal(runCli([], reader('{}')).exitCode, EXIT_UNUSABLE);
    assert.equal(runCli(['--nope', 'set.json'], reader('{}')).exitCode, EXIT_UNUSABLE);
    const throwing = (): string => {
      throw new Error('ENOENT');
    };
    assert.equal(runCli(['missing.json'], throwing).exitCode, EXIT_UNUSABLE);
  });

  it('prints usage on --help and exits clean', () => {
    const result = runCli(['--help'], reader('{}'));
    assert.equal(result.exitCode, EXIT_OK);
    assert.match(result.lines.join('\n'), /--sample/);
  });

  it('--sample prints questions to check against the paper', () => {
    const result = runCli(['set.json', '--sample'], reader(JSON.stringify(paper(100))));
    const out = result.lines.join('\n');
    assert.match(out, /SAMPLE — 15 of 100 questions/);
    assert.match(out, /key: /);
    assert.equal(result.exitCode, EXIT_OK);
  });

  it('--sample N honours the count', () => {
    const result = runCli(['set.json', '--sample', '4'], reader(JSON.stringify(paper(100))));
    assert.match(result.lines.join('\n'), /SAMPLE — 4 of 100 questions/);
  });

  it('--expected overrides the per-exam default', () => {
    const text = JSON.stringify(paper(80));
    assert.equal(runCli(['set.json'], reader(text)).exitCode, EXIT_BLOCKED);
    assert.equal(runCli(['set.json', '--expected', '80'], reader(text)).exitCode, EXIT_OK);
  });

  it('--json emits the report as data', () => {
    const result = runCli(['set.json', '--json'], reader(JSON.stringify(paper(100))));
    const parsed = JSON.parse(result.lines.join('\n')) as { blocked: boolean };
    assert.equal(parsed.blocked, false);
  });
});

describe('parseArgs', () => {
  it('reads every flag', () => {
    const parsed = parseArgs([
      'a.json',
      '--sample',
      '20',
      '--expected',
      '100',
      '--allow-line',
      'Series A',
      '--json',
    ]);
    assert.ok(!('error' in parsed));
    if ('error' in parsed) return;
    assert.deepEqual(parsed.options, {
      path: 'a.json',
      sample: 20,
      expectedTotal: 100,
      allowLines: ['Series A'],
      json: true,
      help: false,
    });
  });

  it('treats a bare --sample as "the default size"', () => {
    const parsed = parseArgs(['a.json', '--sample']);
    assert.ok(!('error' in parsed));
    if ('error' in parsed) return;
    assert.equal(parsed.options.sample, -1);
  });

  it('refuses a flag with a missing value and a second input file', () => {
    assert.ok('error' in parseArgs(['--expected']));
    assert.ok('error' in parseArgs(['--allow-line']));
    assert.ok('error' in parseArgs(['a.json', 'b.json']));
    assert.ok('error' in parseArgs(['--wat']));
  });
});
