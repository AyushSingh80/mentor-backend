/**
 * The past-paper extractor's parsers.
 *
 * Every test here guards the one failure this tool can commit that nothing
 * downstream can catch: producing a question that READS correctly and is wrong.
 * A wrong stem is visible; a wrong `correctIndex` is not, and spaced repetition
 * will drill it to mastery. So the tests that matter are not "does it parse the
 * happy case" but "does it REFUSE" — refuse a question with no key, refuse a
 * stem it misread, refuse a key table it can read two ways, refuse to reorder
 * options.
 *
 * `pdftotext` itself is not tested. The fixtures below are hand-written
 * `-layout` output — the shape poppler produces for a Prelims booklet, typed out
 * here rather than extracted, because NO REAL UPSC PDF WAS AVAILABLE while this
 * was written. That is a real limit on how much these tests prove: they pin the
 * parsers' behaviour against a plausible layout, not against the 2023 paper.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AnswerKeyError,
  buildPyqSet,
  classifySegment,
  columnarLineCount,
  declaredBookletLetters,
  parseAnswerKey,
  parseArgs,
  parseKeyLine,
  parseOptions,
  parseStem,
  segmentQuestions,
} from '../tools/pyq-extract';
import { pyqExternalId } from '../src/data/pyq/types';

/* ------------------------------------------------------------- fixtures */

/**
 * Two questions in the layout `pdftotext -layout` produces: the question number
 * at the margin, the statements indented under it, the options at the margin
 * again. Question 1 carries the trap this segmenter exists for — its statements
 * are numbered `1.` and `2.`, and `2.` is exactly what the next question's
 * number looks like.
 */
const PAPER = [
  '                                                                            3',
  '',
  '1.   Consider the following statements regarding',
  '     the Finance Commission :',
  '     1. It is constituted every fifth year.',
  '     2. Its recommendations are binding on the',
  '        Union Government.',
  '     Which of the statements given above is/are',
  '     correct?',
  '     (a) 1 only',
  '     (b) 2 only',
  '     (c) Both 1 and 2',
  '     (d) Neither 1 nor 2',
  '',
  '2.   With reference to the Indian Constitution,',
  '     which one of the following is correct?',
  '     (a) Article 19(1)(a) is absolute',
  '     (b) Article 19(1)(a) is subject to reasonable',
  '         restrictions',
  '     (c) Article 19 applies to non-citizens',
  '     (d) Article 19 was repealed in 1978',
  '',
  '                            Space for rough work',
  '',
  '',
].join('\n');

const KEY = [
  'UNION PUBLIC SERVICE COMMISSION',
  'CIVIL SERVICES (PRELIMINARY) EXAMINATION, 2023',
  'GENERAL STUDIES PAPER I - ANSWER KEY - SET A',
  '',
  'Q. No.   Answer      Q. No.   Answer',
  '   1        c           51       b',
  '   2        b           52       d',
].join('\n');

function build(paper: string, key: string) {
  return buildPyqSet({
    exam: 'prelims-gs1',
    year: 2023,
    booklet: 'a',
    paperText: paper,
    keyText: key,
  });
}

/* ------------------------------------------------------------ segmentation */

describe('segmentQuestions', () => {
  it('splits on the printed numbering and keeps the printed numbers', () => {
    const { segments, warnings } = segmentQuestions(PAPER);
    assert.deepEqual(
      segments.map((segment) => segment.number),
      [1, 2],
    );
    assert.deepEqual(warnings, []);
  });

  it('does not mistake a numbered statement inside a stem for the next question', () => {
    const { segments } = segmentQuestions(PAPER);
    /*
     * The whole hazard in one place. Question 1's stem contains a line beginning
     * `2.`, which is indistinguishable from a question number by shape alone. A
     * segmenter that took it as question 2's start would give question 1 a stem
     * beginning mid-sentence, renumber everything after it, and hand every
     * subsequent key letter to the wrong question — while producing output that
     * looks entirely well-formed.
     */
    assert.equal(segments.length, 2);
    assert.equal(segments[0].number, 1);
    assert.match(segments[0].stemLines[0], /^\s*1\.\s+Consider the following statements/);
    /* Question 1 keeps its whole stem: the opening line AND both statements. */
    assert.match(segments[0].stemLines.join('\n'), /Its recommendations are binding/);
    assert.match(segments[0].stemLines.join('\n'), /constituted every fifth year/);
    assert.equal(segments[1].number, 2);
    assert.match(segments[1].stemLines[0], /^\s*2\.\s+With reference to the Indian Constitution/);
  });

  it('ignores page numbers and rough-work furniture', () => {
    const { segments } = segmentQuestions(PAPER);
    const last = segments[segments.length - 1];
    assert.doesNotMatch(last.optionText, /Space for rough work/i);
    assert.doesNotMatch(last.optionText, /^\s*3\s*$/m);
  });

  it('warns rather than guesses when an option block has no number before it', () => {
    const orphan = ['     (a) one', '     (b) two', '     (c) three', '     (d) four'].join('\n');
    const { segments, warnings } = segmentQuestions(orphan);
    assert.deepEqual(segments, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /no question number/);
  });
});

/* --------------------------------------------------------- option parsing */

describe('parseOptions', () => {
  it('keeps the options in the order the booklet prints them', () => {
    const { segments } = segmentQuestions(PAPER);
    const parsed = parseOptions(segments[0].optionText);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.options, ['1 only', '2 only', 'Both 1 and 2', 'Neither 1 nor 2']);
    assert.deepEqual(parsed.letters, ['a', 'b', 'c', 'd']);
  });

  it('rejoins an option wrapped across two lines', () => {
    const { segments } = segmentQuestions(PAPER);
    const parsed = parseOptions(segments[1].optionText);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.options[1], 'Article 19(1)(a) is subject to reasonable restrictions');
  });

  it('does not read Article 19(1)(a) inside an option as a label', () => {
    const { segments } = segmentQuestions(PAPER);
    const parsed = parseOptions(segments[1].optionText);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.options.length, 4);
    assert.equal(parsed.options[0], 'Article 19(1)(a) is absolute');
  });

  it('reads options printed two to a line', () => {
    const parsed = parseOptions('     (a) 1 only          (b) 2 only\n     (c) Both        (d) Neither');
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.options, ['1 only', '2 only', 'Both', 'Neither']);
  });

  it('refuses a fifth option instead of folding it into the fourth', () => {
    const parsed = parseOptions('(a) one\n(b) two\n(c) three\n(d) four\n(e) five');
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.equal(parsed.cause, 'more_than_four_options');
  });

  it('refuses a short option block', () => {
    const parsed = parseOptions('(a) one\n(b) two\n(c) three');
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.equal(parsed.cause, 'missing_options');
  });

  it('refuses an option with no text', () => {
    const parsed = parseOptions('(a) one\n(b)\n(c) three\n(d) four');
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.equal(parsed.cause, 'malformed_options');
  });
});

/* ------------------------------------------------------------------ stems */

describe('parseStem', () => {
  it('strips the numbering, rejoins wrapped lines and keeps statements apart', () => {
    const { segments } = segmentQuestions(PAPER);
    assert.equal(
      parseStem(segments[0].stemLines),
      [
        'Consider the following statements regarding the Finance Commission :',
        '1. It is constituted every fifth year.',
        '2. Its recommendations are binding on the Union Government.',
        'Which of the statements given above is/are correct?',
      ].join('\n'),
    );
  });
});

/* --------------------------------------------------------------- refusals */

describe('classifySegment', () => {
  function segment(stemLines: string[]) {
    return { number: 1, stemLines, optionText: '' };
  }
  const goodOptions = parseOptions('(a) one\n(b) two\n(c) three\n(d) four');

  it('refuses a question that points at a map', () => {
    const stem = 'Consider the map given below and identify the river marked A.';
    const found = classifySegment(segment([stem]), stem, goodOptions);
    assert.equal(found?.cause, 'map_or_diagram');
  });

  it('refuses match-the-following in both of its printed forms', () => {
    const phrase = 'Match the following pairs and select the correct answer.';
    assert.equal(classifySegment(segment([phrase]), phrase, goodOptions)?.cause, 'match_the_following');
    const lists = 'List-I (Author) and List-II (Book) are given below; select the code.';
    assert.equal(classifySegment(segment([lists]), lists, goodOptions)?.cause, 'match_the_following');
  });

  it('refuses a table laid out in columns in the stem', () => {
    const lines = [
      'Consider the following data :',
      '   State            Literacy      Density',
      '   Kerala           94.0          860',
      '   Bihar            61.8          1106',
    ];
    const stem = parseStem(lines);
    assert.equal(classifySegment(segment(lines), stem, goodOptions)?.cause, 'table_in_stem');
  });

  it('keeps an ordinary statements question', () => {
    const lines = [
      'Consider the following statements regarding the Finance Commission :',
      '1. It is constituted every fifth year.',
      'Which of the statements given above is correct?',
    ];
    assert.equal(classifySegment(segment(lines), parseStem(lines), goodOptions), null);
  });

  it('decides readability before it reads any words out of the stem', () => {
    /*
     * A stem that came out garbled is not evidence about maps, lists or tables.
     * Classifying on its words would attach a confident reason to a question
     * nobody can actually see.
     */
    const stem = 'Consider the map �� given below';
    assert.equal(classifySegment(segment([stem]), stem, goodOptions)?.cause, 'garbled_text');
  });

  it('does not call ordinary prose a table', () => {
    const lines = ['Which one of the following  is  the  largest  producer of tea?'];
    assert.equal(columnarLineCount(lines), 0);
  });
});

/* ---------------------------------------------------------------- the key */

describe('parseKeyLine', () => {
  it('reads a multi-column key row', () => {
    assert.deepEqual(parseKeyLine('   1        c           51       b'), [
      { number: 1, letter: 'c' },
      { number: 51, letter: 'b' },
    ]);
  });

  it('reads the bracketed and dotted spellings', () => {
    assert.deepEqual(parseKeyLine('1. (a)   2) (d)'), [
      { number: 1, letter: 'a' },
      { number: 2, letter: 'd' },
    ]);
  });

  it('refuses a prose line that merely opens like a key row', () => {
    /*
     * `1. A candidate may raise an objection...` is real answer-key preamble. A
     * scanning parser reads `1 -> a` out of it and writes a wrong answer into
     * the bank, where nothing downstream can tell it from a real one. Requiring
     * the WHOLE line to be number/letter pairs is what stops that.
     */
    assert.equal(parseKeyLine('1. A candidate may raise an objection within 7 days.'), null);
    assert.equal(parseKeyLine('Q. No.   Answer      Q. No.   Answer'), null);
    assert.equal(parseKeyLine('GENERAL STUDIES PAPER I'), null);
  });
});

describe('parseAnswerKey', () => {
  it('reads the table and ignores the surrounding prose', () => {
    const key = parseAnswerKey(KEY);
    assert.deepEqual([...key.entries.entries()].sort((a, b) => a[0] - b[0]), [
      [1, 'c'],
      [2, 'b'],
      [51, 'b'],
      [52, 'd'],
    ]);
    assert.equal(key.warnings.length, 1);
    assert.match(key.warnings[0], /skips question numbers between 2 and 51/);
  });

  it('refuses to choose when one number is given two answers', () => {
    assert.throws(
      () => parseAnswerKey('1 a\n2 b\n1 d'),
      (error: unknown) => error instanceof AnswerKeyError && /two different answers/.test(String(error)),
    );
  });
});

describe('declaredBookletLetters', () => {
  it('finds the booklet the key declares about itself', () => {
    assert.deepEqual(declaredBookletLetters(KEY), ['a']);
  });

  it('reports every letter when a key covers all four booklets', () => {
    assert.deepEqual(declaredBookletLetters('SET A   SET B   SET C   SET D'), ['a', 'b', 'c', 'd']);
  });
});

/* ------------------------------------------------------------- the assembly */

describe('buildPyqSet', () => {
  it('takes correctIndex from the key letter, in the booklet\'s printed order', () => {
    const result = build(PAPER, KEY);
    const q1 = result.set.mcqs.find((mcq) => mcq.number === 1);
    assert.ok(q1);
    /* The key says (c); (c) is printed third; so correctIndex is 2 and the text is that option's. */
    assert.equal(q1.correctIndex, 2);
    assert.equal(q1.options[q1.correctIndex], 'Both 1 and 2');
    const q2 = result.set.mcqs.find((mcq) => mcq.number === 2);
    assert.ok(q2);
    assert.equal(q2.correctIndex, 1);
    assert.match(q2.options[q2.correctIndex], /^Article 19\(1\)\(a\) is subject/);
  });

  it('leaves verification and every syllabusSlug null', () => {
    const result = build(PAPER, KEY);
    assert.equal(result.set.verification, null);
    for (const mcq of result.set.mcqs) {
      assert.equal(mcq.syllabusSlug, null);
      assert.equal(mcq.eliminationLogic, null);
    }
  });

  it('drops a question the key does not answer instead of keeping it unkeyed', () => {
    /* Key covers question 1 only. Question 2 is printed, readable, and has no key. */
    const result = build(PAPER, '1 c');
    assert.deepEqual(
      result.set.mcqs.map((mcq) => mcq.number),
      [1],
    );
    assert.deepEqual(result.set.dropped, [
      {
        number: 2,
        reason: 'no_verified_key',
        note: 'key_absent: the key PDF has no entry for this question',
      },
    ]);
  });

  it('drops a question the key lists but the text layer does not yield', () => {
    /* An image-only page produces exactly this: a key entry with no text behind it. */
    const result = build(PAPER, '1 c\n2 b\n3 a');
    const missing = result.set.dropped.find((entry) => entry.number === 3);
    assert.deepEqual(missing, {
      number: 3,
      reason: 'unreadable_scan',
      note: 'no_text_layer: the key lists this question but the paper yielded no text for it',
    });
  });

  it('drops the whole roster when the paper has no text layer at all', () => {
    const result = build('', '1 a\n2 b\n3 c');
    assert.deepEqual(result.set.mcqs, []);
    assert.equal(result.set.dropped.length, 3);
    for (const entry of result.set.dropped) assert.equal(entry.reason, 'unreadable_scan');
    assert.deepEqual(result.counts, {
      keyEntries: 3,
      extracted: 0,
      dropped: 3,
      droppedByReason: { unreadable_scan: 3 },
    });
  });

  it('refuses outright when the key PDF yields nothing', () => {
    assert.throws(() => build(PAPER, 'ANSWER KEY\n\n(image only)'), AnswerKeyError);
  });

  it('mints ids through pyqExternalId, never by hand', () => {
    const result = build(PAPER, KEY);
    assert.equal(result.identity.setKey, 'pyq-prelims-gs1-2023-a');
    assert.deepEqual(result.identity.externalIds, {
      '1': pyqExternalId('prelims-gs1', 2023, 'a', 1),
      '2': pyqExternalId('prelims-gs1', 2023, 'a', 2),
    });
    assert.equal(result.identity.externalIds['1'], 'pyq-prelims-gs1-2023-a-q001');
  });

  it('counts everything it found and everything it refused', () => {
    const result = build(PAPER, KEY);
    assert.deepEqual(result.counts, {
      keyEntries: 4,
      extracted: 2,
      dropped: 2,
      droppedByReason: { unreadable_scan: 2 },
    });
    assert.equal(
      result.counts.extracted + result.counts.dropped,
      result.counts.keyEntries,
      'every key entry is either extracted or recorded as dropped',
    );
  });
});

/* ---------------------------------------------------------------- the cli */

describe('parseArgs', () => {
  const base = [
    '--pdf', 'p.pdf',
    '--key', 'k.pdf',
    '--exam', 'prelims-gs1',
    '--year', '2023',
    '--booklet', 'a',
    '--out', 'working/2023-a.json',
  ];

  it('accepts a complete objective-paper invocation', () => {
    assert.deepEqual(parseArgs(base), {
      pdf: 'p.pdf',
      key: 'k.pdf',
      exam: 'prelims-gs1',
      year: 2023,
      booklet: 'a',
      out: 'working/2023-a.json',
    });
  });

  it('refuses an uppercase booklet rather than lowercasing it', () => {
    /*
     * The booklet letter goes into the id byte for byte. A tool that quietly
     * accepted `A` here would mint `pyq-...-A-q001` beside an existing
     * `pyq-...-a-q001` and the importer would treat one question as two.
     */
    const argv = base.map((token) => (token === 'a' ? 'A' : token));
    assert.throws(() => parseArgs(argv), /not a-d or x/);
  });

  it('refuses a written paper', () => {
    const argv = base.map((token) => (token === 'prelims-gs1' ? 'mains-essay' : token));
    assert.throws(() => parseArgs(argv), /objective papers only/);
  });

  it('refuses a missing key', () => {
    const argv = base.filter((token, index) => token !== '--key' && base[index - 1] !== '--key');
    assert.throws(() => parseArgs(argv), /missing --key/);
  });
});
