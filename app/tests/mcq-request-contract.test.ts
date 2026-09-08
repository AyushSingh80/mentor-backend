/**
 * POST /mcq/generate wire contract — the app half.
 *
 * Counterpart: `server/tests/mcq-request-contract.test.ts`, which feeds the very
 * same body through the real `parseMcqBody` and asserts the frames it sends
 * back. Sibling of `ca-request-contract.test.ts`, written for the same reason
 * and after finding the same bug twice.
 *
 * ## What went wrong
 *
 * Phase 3's two halves were built in parallel against a wire nobody wrote down.
 * The app sent `{batchSize, sections[], rationale}`; the server read
 * `{paper, topic, difficulty, count}` and answered **400 to every refill ever
 * attempted** — the offline question bank could never fill — while 584 app
 * tests and 153 server tests passed.
 *
 * Two more breaks sat behind it and would have surfaced only after that one was
 * fixed, each silent in its own way:
 *
 *   - the server sends `eliminationRationale` (one string per option); the app
 *     read `eliminationLogic` and REJECTED every question that lacked it, so
 *     the bank would still have stayed empty, blaming the model;
 *   - the two packages have different difficulty vocabularies, so every banked
 *     question would have been labelled `medium` and `mcq-select.ts`'s
 *     difficulty mix would have been drawing from one bucket.
 *
 * So this file asserts the EXACT key set in both directions, plus every
 * translation the two vocabularies need.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { McqGenerateRequest } from '../src/lib/mcq-api';
import { createBatchMapper } from '../src/lib/mcq-generate-map';
import { MCQ_PROMPT_VERSION, buildGenerateRequest } from '../src/lib/mcq-request';
import { OPTION_LETTERS, type RefillPlan, type SectionDemand } from '../src/lib/mcq-types';

/* ------------------------------------------------------------------ fixtures */

const SECTIONS: SectionDemand[] = [
  {
    sectionKey: 'gs2:Indian Constitution',
    syllabusSlugs: ['gs2-fundamental-rights', 'gs2-dpsp'],
    paper: 'gs2',
    label: 'Indian Constitution and Polity',
    eligible: true,
    percentFirstPass: 0.8,
    attempted: 40,
    wrong: 18,
    unseenStock: 12,
    lastDrilledDay: '2026-09-01',
  },
  {
    sectionKey: 'gs3:Economy',
    syllabusSlugs: ['gs3-budgeting'],
    paper: 'gs3',
    label: 'Indian Economy',
    eligible: true,
    percentFirstPass: 0.5,
    attempted: 20,
    wrong: 4,
    unseenStock: 30,
    lastDrilledDay: null,
  },
];

const PLAN: RefillPlan = {
  batchSize: 12,
  quotas: [
    {
      sectionKey: 'gs2:Indian Constitution',
      syllabusSlug: 'gs2-fundamental-rights',
      count: 7,
      reason: 'lowest accuracy of the sections you have started',
    },
    {
      sectionKey: 'gs3:Economy',
      syllabusSlug: 'gs3-budgeting',
      count: 5,
      reason: 'never drilled',
    },
  ],
  excludeStemHashes: ['9c1f2ab0', '4d7e8f21'],
  rationale: 'topping up the two weakest sections',
};

/** The REAL builder, not a restatement of it. */
function requestAsSent(overrides: Partial<Parameters<typeof buildGenerateRequest>[0]> = {}) {
  return buildGenerateRequest({
    requestId: 'mcq_2026-09-07_5f2a',
    resume: false,
    plan: PLAN,
    sections: SECTIONS,
    ...overrides,
  });
}

/**
 * Every key `parseMcqBody` in `server/src/routes/mcq.ts` reads, restated here.
 *
 * Restated rather than imported: the two packages are never compiled together,
 * which is the whole reason this file exists.
 */
const KEYS_THE_SERVER_READS = [
  'batchSize',
  'excludeStemHashes',
  'promptVersion',
  'rationale',
  'requestId',
  'sections',
] as const;

/** Sent, never read. Each needs a reason, or it is dead weight on mobile data. */
const KEYS_SENT_BUT_NOT_READ = [
  // Re-attachment marker; the server is idempotent on `requestId` instead.
  'resume',
] as const;

/** Per-section keys the server reads. `reason` is logged, not parsed. */
const SECTION_KEYS = [
  'count',
  'label',
  'paper',
  'reason',
  'sectionKey',
  'syllabusSlug',
  'syllabusSlugs',
] as const;

/* -------------------------------------------------------------- the request */

describe('POST /mcq/generate request body', () => {
  it('sends exactly the keys the server reads, and no others', () => {
    const sent = Object.keys(JSON.parse(JSON.stringify(requestAsSent()))).sort();
    assert.deepEqual(sent, [...KEYS_THE_SERVER_READS, ...KEYS_SENT_BUT_NOT_READ].sort());
  });

  it('does not send the names the server never learned', () => {
    // The literal strings from the outage. A rename back to any of them is the
    // bug this file was written for.
    const sent = new Set(Object.keys(requestAsSent()));
    for (const dead of ['paper', 'topic', 'difficulty', 'count']) {
      assert.equal(sent.has(dead), false, `"${dead}" is not a field the app sends`);
    }
  });

  it('sends every per-section key the server reads', () => {
    for (const section of requestAsSent().sections) {
      assert.deepEqual(Object.keys(section).sort(), [...SECTION_KEYS].sort());
    }
  });

  it('makes the section counts sum to batchSize, which the server cross-checks', () => {
    // The server refuses a body where these disagree rather than trusting one
    // of the two numbers, so the planner's rounding reconciliation is now a
    // wire-level invariant rather than a comment.
    const request = requestAsSent();
    const summed = request.sections.reduce((total, section) => total + section.count, 0);
    assert.equal(summed, request.batchSize);
  });

  it('carries the whole section, not just the quota`s anchor leaf', () => {
    // A quota of seven aimed at one leaf produces seven questions about one
    // bullet point. `syllabusSlugs` is what lets generation spread.
    const [polity] = requestAsSent().sections;
    assert.deepEqual(polity?.syllabusSlugs, ['gs2-fundamental-rights', 'gs2-dpsp']);
    assert.equal(polity?.syllabusSlug, 'gs2-fundamental-rights');
  });

  it('falls back to the anchor when a quota names a section that is gone', () => {
    // A re-seed between planning and sending can retire a section. An empty
    // slug list would leave the prompt with no topic at all.
    const orphaned = buildGenerateRequest({
      requestId: 'mcq-orphan',
      resume: false,
      plan: { ...PLAN, batchSize: 7, quotas: [PLAN.quotas[0]!] },
      sections: [],
    });
    assert.deepEqual(orphaned.sections[0]?.syllabusSlugs, ['gs2-fundamental-rights']);
    assert.equal(orphaned.sections[0]?.label, 'gs2:Indian Constitution');
  });

  it('survives a JSON round trip unchanged', () => {
    // `generateMcqs` sends `JSON.stringify(request)` verbatim. A `Set`, a `Map`
    // or an `undefined` here serialises to something the server cannot read,
    // and TypeScript would not say a word.
    const request = requestAsSent();
    assert.deepEqual(JSON.parse(JSON.stringify(request)) as McqGenerateRequest, request);
  });

  it('reports the prompt cohort this build asks for', () => {
    assert.equal(requestAsSent().promptVersion, MCQ_PROMPT_VERSION);
  });

  it('copies the plan`s exclusion list rather than aliasing it', () => {
    const hashes = ['aaa'];
    const request = buildGenerateRequest({
      requestId: 'mcq-alias',
      resume: false,
      plan: { ...PLAN, excludeStemHashes: hashes },
      sections: SECTIONS,
    });
    hashes.push('bbb');
    assert.deepEqual(request.excludeStemHashes, ['aaa']);
  });
});

/* ------------------------------------------------------------- the response */

/**
 * One `question` frame, in the SERVER's field names.
 *
 * Captured from the real route with the runners stubbed, not written to suit
 * the mapper — a fixture shaped like the receiver proves only that the receiver
 * reads itself.
 */
function serverQuestionFrame(overrides: Record<string, unknown> = {}) {
  return {
    form: 'statements_correct',
    stem: 'Consider the following statements regarding the Directive Principles.\nWhich of the statements given above is/are correct?',
    statements: [
      { index: 1, text: 'They are non-justiciable.', isTrue: true },
      { index: 2, text: 'They bind the executive absolutely.', isTrue: false },
    ],
    options: ['1 only', '2 only', 'Both 1 and 2', 'Neither 1 nor 2'],
    answerIndex: 0,
    eliminationRationale: [
      'Correct: Article 37 makes them non-justiciable.',
      'Confuses non-justiciability with having no force.',
      'Assumes both hold.',
      'Assumes neither holds.',
    ],
    factKey: 'polity:dpsp-article-37',
    verifiabilityAnchor: 'Article 37, Constitution of India.',
    id: 'mcq_2026-09-07_5f2a:0:01',
    paper: 'gs2',
    topicSlug: 'gs2-dpsp',
    difficulty: 'standard',
    promptVersion: '0c2236821613',
    verifierVersion: '58657640b4a7',
    provenance: 'model',
    stemHash: 'abc123',
    simHash: 'def456',
    sectionKey: 'gs2:Indian Constitution',
    verification: {
      chosenIndex: 0,
      confidence: 'high',
      ambiguous: false,
      timeDependent: false,
      factuallyDisputed: false,
    },
    ...overrides,
  };
}

function mapped(frame: Record<string, unknown> = serverQuestionFrame()) {
  const mapper = createBatchMapper({
    topicIdBySlug: new Map([['gs2-dpsp', 42]]),
    knownFingerprints: new Set<string>(),
    batchId: 'mcq_2026-09-07_5f2a',
    promptVersion: MCQ_PROMPT_VERSION,
  });
  const outcome = mapper.accept(frame);
  assert.ok(outcome.ok, `mapper rejected a real server frame: ${JSON.stringify(outcome)}`);
  return outcome.question;
}

describe('the server`s question frame -> a banked row', () => {
  it('accepts a frame in the server`s own field names', () => {
    const question = mapped();
    assert.equal(question.correctIndex, 0);
    assert.equal(question.syllabusTopicId, 42);
    assert.equal(question.externalId, 'polity:dpsp-article-37');
    assert.equal(question.sectionKey, 'gs2:Indian Constitution');
  });

  it('translates the server`s generation register into this app`s difficulty', () => {
    // Two vocabularies on purpose — see `DIFFICULTY_FROM_SERVER`. Without the
    // translation every question fell through to `medium` and the whole bank
    // carried one label.
    for (const [sent, stored] of [
      ['foundation', 'easy'],
      ['standard', 'medium'],
      ['challenging', 'hard'],
    ] as const) {
      assert.equal(mapped(serverQuestionFrame({ difficulty: sent })).difficulty, stored);
    }
  });

  it('still accepts this app`s own vocabulary, so a stored row round-trips', () => {
    for (const own of ['easy', 'medium', 'hard'] as const) {
      assert.equal(mapped(serverQuestionFrame({ difficulty: own })).difficulty, own);
    }
  });

  it('folds the per-option rationales into the one block the reveal shows', () => {
    // The server sends one rationale per option INCLUDING the key. The app has
    // a single `elimination_logic` column, so they are joined with their option
    // letters: the association is the whole value of having four of them.
    const logic = mapped().eliminationLogic ?? '';
    const lines = logic.split('\n');
    assert.equal(lines.length, 4);
    for (const [index, letter] of OPTION_LETTERS.entries()) {
      assert.ok(lines[index]?.startsWith(`${letter}. `), `line ${index} must be labelled ${letter}`);
    }
    assert.match(logic, /Article 37 makes them non-justiciable/);
  });

  it('rejects a question with no elimination logic in EITHER shape', () => {
    // The rejection is deliberate and must survive the new reader: a question
    // with no elimination logic teaches nothing beyond its key.
    const mapper = createBatchMapper({
      topicIdBySlug: new Map([['gs2-dpsp', 42]]),
      knownFingerprints: new Set<string>(),
      batchId: 'b',
      promptVersion: MCQ_PROMPT_VERSION,
    });
    const frame = serverQuestionFrame();
    delete (frame as Record<string, unknown>).eliminationRationale;
    const outcome = mapper.accept(frame);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.reason, 'empty_elimination_logic');
  });

  it('carries the section key the batch was planned under', () => {
    // Added by the ROUTE, not the pipeline: the pipeline reasons about one
    // topic and has no notion of a batch spanning sections.
    assert.equal(mapped().sectionKey, 'gs2:Indian Constitution');
  });
});
