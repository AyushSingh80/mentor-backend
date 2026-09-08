/**
 * The seven structured call sites, over the port.
 *
 * Every other test in this suite replaces the RUNNER, which is the right seam
 * for testing a pipeline and leaves the runner itself — the thing that decides
 * what actually crosses the provider boundary — completely uncovered. This file
 * takes the real, provider-backed runners and gives them a scripted provider.
 *
 * What it is really guarding is the quiet half of a provider swap. A runner
 * that sent the wrong schema, dropped `maxTokens`, mislabelled her own writing
 * as public, or lost the truncation signal would not fail: it would return
 * plausible output, be billed in full, and be wrong in a way that only shows up
 * in the bank weeks later. None of those is a type error, so each one is
 * asserted here.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

process.env.APP_BEARER_TOKEN ??= 'test-token';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-test-not-real';
process.env.MODEL_EVALUATION ??= 'eval-model-1';
process.env.MODEL_BULK ??= 'bulk-model-1';

import type {
  Provider,
  StructuredRequest,
  StructuredResponse,
} from '../src/providers/types.js';

const { setProviderForTier } = await import('../src/providers/registry.js');
const { ZERO_TOKEN_COUNTS } = await import('../src/providers/types.js');

const mcq = await import('../src/mcq/runner.js');
const mcqSchema = await import('../src/mcq/schema.js');
const ca = await import('../src/ca/runner.js');
const caSchema = await import('../src/ca/schema.js');
const drills = await import('../src/drills/runner.js');
const drillSchema = await import('../src/drills/schema.js');
const interview = await import('../src/interview/runner.js');
const interviewSchema = await import('../src/interview/schema.js');

/* ------------------------------------------------------------------ harness */

interface Scripted {
  json?: string | null;
  stopReason?: StructuredResponse['stopReason'];
}

function install(tier: 'evaluation' | 'bulk', scripted: Scripted = {}) {
  const calls: StructuredRequest[] = [];
  const provider: Provider = {
    id: 'anthropic',
    capabilities: {
      structured: true,
      // Declared so the seam's own boot check accepts it on either tier. The
      // runner below never touches it; only /evaluate does.
      evaluation: true,
      acceptsPdfDocuments: true,
      maxImagesPerRequest: 1,
      reportsCacheTokens: true,
    maxRequestBytes: Number.POSITIVE_INFINITY,
    },
    evaluation: () => {
      throw new Error('the structured call sites must never reach the streaming port');
    },
    structured: async (request) => {
      calls.push(request);
      return {
        json: 'json' in scripted ? (scripted.json ?? null) : '{}',
        stopReason: scripted.stopReason ?? 'end_turn',
        usage: { ...ZERO_TOKEN_COUNTS, inputTokens: 11, outputTokens: 22 },
      };
    },
  };
  setProviderForTier(tier, provider);
  return calls;
}

afterEach(() => {
  setProviderForTier('evaluation', null);
  setProviderForTier('bulk', null);
});

const signal = new AbortController().signal;
const base = { model: 'bulk-model-1', system: 'SYSTEM', maxTokens: 4321, requestId: 'req_9', signal };

/* --------------------------------------------------------------------- MCQ */

const CANDIDATE = {
  index: 0,
  url: 'https://example.test/a',
  canonicalUrl: 'https://example.test/a',
  sourceName: 'Example',
  headline: 'A rule changed',
  lede: 'The rule changed today.',
  publishedAt: null,
  feedId: 'example',
};

const DOCUMENT = {
  url: 'https://example.test/a',
  canonicalUrl: 'https://example.test/a',
  sourceName: 'Example',
  feedId: 'example',
  title: 'A rule changed',
  publishedAt: null,
  text: 'The rule changed today.',
  charCount: 23,
  fetchedAt: '2026-09-08T00:00:00.000Z',
};

/**
 * Every call site, as a table: how to invoke it, and what it must have sent.
 *
 * A table rather than fourteen near-identical cases because the properties are
 * shared — the point is that NO call site is missing one, and a table makes an
 * omission a missing row instead of a test nobody wrote.
 */
const SITES = [
  {
    name: 'mcq generation',
    tier: 'bulk' as const,
    schemaName: 'mcq_generation',
    resultKey: 'drafts',
    dataClass: 'public' as const,
    schema: mcqSchema.generationFormat.schema,
    userContains: 'INSTRUCTION',
    call: () =>
      mcq.currentMcqRunner()({
        ...base,
        instruction: 'INSTRUCTION',
        count: 5,
        ordinalOffset: 0,
        topicSlug: 'gs2-dpsp',
        difficulty: 'standard',
      }),
  },
  {
    name: 'mcq verification',
    tier: 'bulk' as const,
    schemaName: 'mcq_verification',
    resultKey: 'verdicts',
    dataClass: 'public' as const,
    schema: mcqSchema.verificationFormat.schema,
    userContains: 'PAYLOAD',
    call: () =>
      mcq.currentVerificationRunner()({
        ...base,
        payload: 'PAYLOAD',
        count: 5,
        ordinalOffset: 0,
        topicSlug: 'gs2-dpsp',
      }),
  },
  {
    name: 'ca shortlist',
    tier: 'bulk' as const,
    schemaName: 'ca_shortlist',
    resultKey: 'picks',
    dataClass: 'public' as const,
    schema: caSchema.shortlistFormat.schema,
    userContains: 'A rule changed',
    call: () =>
      ca.currentShortlistRunner()({
        ...base,
        candidates: [CANDIDATE],
        syllabusSlugs: ['gs2-dpsp'],
        sections: [],
        take: 5,
      }),
  },
  {
    name: 'ca notes',
    tier: 'bulk' as const,
    schemaName: 'ca_notes',
    resultKey: 'drafts',
    dataClass: 'public' as const,
    schema: caSchema.notesFormat.schema,
    userContains: 'The rule changed today.',
    call: () =>
      ca.currentNotesRunner()({
        ...base,
        documents: [DOCUMENT],
        picks: [],
        syllabusSlugs: ['gs2-dpsp'],
        sections: [],
      }),
  },
  {
    name: 'drill prompts',
    tier: 'bulk' as const,
    schemaName: 'drill_prompts',
    resultKey: 'drafts',
    dataClass: 'public' as const,
    schema: drillSchema.promptsFormat.schema,
    userContains: 'essay topic',
    call: () =>
      drills.currentGenerateRunner()({
        ...base,
        want: [{ kind: 'essay_outline', count: 2 }],
        vocabulary: [{ slug: 'gs4-ethics', label: 'Ethics' }],
        excludePrompts: [],
      }),
  },
  {
    name: 'drill marking',
    tier: 'evaluation' as const,
    schemaName: 'drill_evaluation',
    resultKey: 'evaluation',
    // HER OWN WRITING. The one thing a provider swap must not get wrong.
    dataClass: 'personal' as const,
    schema: drillSchema.evaluationFormat.schema,
    userContains: 'HER THESIS',
    call: () =>
      drills.currentEvaluateRunner()({
        ...base,
        model: 'eval-model-1',
        kind: 'essay_outline',
        promptText: 'Discuss.',
        caseDetail: null,
        parts: [{ part: 'thesis', content: 'HER THESIS' }],
      }),
  },
  {
    name: 'interview questions',
    tier: 'bulk' as const,
    schemaName: 'interview_questions',
    resultKey: 'drafts',
    // HER DAF. Public to the board, personal to a provider choice.
    dataClass: 'personal' as const,
    schema: interviewSchema.questionsFormat.schema,
    userContains: 'Bhagalpur',
    call: () =>
      interview.currentInterviewRunner()({
        ...base,
        entries: [{ field: 'home_district', value: 'Bhagalpur' }],
        excludeQuestions: [],
        take: 8,
      }),
  },
];

describe('every structured call site speaks the port', () => {
  for (const site of SITES) {
    it(`${site.name} sends one system turn, one user turn and its own schema`, async () => {
      const calls = install(site.tier);
      await site.call();

      assert.equal(calls.length, 1, 'exactly one provider call');
      const sent = calls[0];
      assert.equal(sent?.system, 'SYSTEM');
      assert.ok(
        sent?.user.includes(site.userContains),
        `the user turn must carry the built payload, got: ${sent?.user.slice(0, 120)}`,
      );
      // Identity, not deep equality: the schema is hashed into `promptVersion`,
      // so a runner that rebuilt it would re-version the bank on a refactor.
      assert.equal(sent?.schema, site.schema);
      assert.equal(sent?.schemaName, site.schemaName);
    });

    it(`${site.name} passes its own maxTokens, requestId and signal through`, async () => {
      // `maxTokens` is COMPUTED per call site — a default here truncates the
      // reply, and a truncated reply is one that was paid for and delivered
      // nothing. The signal is what makes a client disconnect cancel the call.
      const calls = install(site.tier);
      await site.call();

      assert.equal(calls[0]?.maxTokens, 4321);
      assert.equal(calls[0]?.requestId, 'req_9');
      assert.equal(calls[0]?.signal, signal);
    });

    it(`${site.name} declares its data class as ${site.dataClass}`, async () => {
      // The label a provider choice will be made against. Getting `personal`
      // wrong is not a bug that shows up in output — it is her handwriting or
      // her DAF at an endpoint someone decided it must not reach.
      const calls = install(site.tier);
      await site.call();

      assert.equal(calls[0]?.dataClass, site.dataClass);
    });

    it(`${site.name} carries the truncation signal back unchanged`, async () => {
      // Three pipelines discard the whole chunk on this value. A runner that
      // swallowed it would silently accept short output on every truncation.
      const calls = install(site.tier, { stopReason: 'max_tokens' });
      const result = (await site.call()) as { stopReason: string | null };

      assert.equal(calls.length, 1);
      assert.equal(result.stopReason, 'max_tokens');
    });

    it(`${site.name} reports the usage the provider returned`, async () => {
      // Not recomputed and not defaulted: this is what the spend ledger bills.
      install(site.tier);
      const result = (await site.call()) as { usage: { inputTokens: number; outputTokens: number } };

      assert.equal(result.usage.inputTokens, 11);
      assert.equal(result.usage.outputTokens, 22);
    });

    it(`${site.name} yields nothing rather than guessing when the reply is empty`, async () => {
      // `json: null` is "the reply carried no text". Every call site must fail
      // closed; a call site that invented an empty list instead would report a
      // successful batch of zero and bank nothing, with no error to notice.
      install(site.tier, { json: null });
      // Through `unknown`: the table's seven result types share no index
      // signature, and the key each one answers to is named in the row above.
      const result = (await site.call()) as unknown as Record<string, unknown>;

      assert.equal(
        result[site.resultKey],
        null,
        `${site.name} must return null on an empty reply`,
      );
    });

    it(`${site.name} yields nothing rather than throwing on unparseable JSON`, async () => {
      // The parse lives at the call site precisely so a malformed reply still
      // reports the tokens the provider already billed for it.
      install(site.tier, { json: '{not json' });
      // Through `unknown`: the table's seven result types share no index
      // signature, and the key each one answers to is named in the row above.
      const result = (await site.call()) as unknown as Record<string, unknown>;

      assert.equal(result[site.resultKey], null);
      assert.equal((result as { usage: { inputTokens: number } }).usage.inputTokens, 11);
    });
  }
});

/* -------------------------------------------------- the parsed happy paths */

describe('a well-formed reply reaches the coercers', () => {
  it('mcq generation returns the drafts the document carried', async () => {
    install('bulk', { json: JSON.stringify({ questions: [{ stem: 'one' }, { stem: 'two' }] }) });
    const result = await mcq.currentMcqRunner()({
      ...base,
      instruction: 'i',
      count: 2,
      ordinalOffset: 0,
      topicSlug: 't',
      difficulty: 'standard',
    });

    assert.equal(result.drafts?.length, 2);
    assert.equal(result.provenance, 'model');
  });

  it('mcq verification returns the verdicts the document carried', async () => {
    install('bulk', {
      json: JSON.stringify({
        verdicts: [
          { questionIndex: 0, chosenIndex: 2, confidence: 'high', ambiguous: false, timeDependent: false, factuallyDisputed: false },
        ],
      }),
    });
    const result = await mcq.currentVerificationRunner()({
      ...base,
      payload: 'p',
      count: 1,
      ordinalOffset: 0,
      topicSlug: 't',
    });

    assert.equal(result.verdicts?.length, 1);
    assert.equal(result.verdicts?.[0]?.chosenIndex, 2);
  });

  it('ca shortlist returns the picks the document carried', async () => {
    install('bulk', {
      json: JSON.stringify({
        picks: [{ candidateIndex: 0, kind: 'structural', syllabusSlugs: ['gs2-dpsp'], sectionKeys: [], why: 'w' }],
      }),
    });
    const result = await ca.currentShortlistRunner()({
      ...base,
      candidates: [CANDIDATE],
      syllabusSlugs: ['gs2-dpsp'],
      sections: [],
      take: 1,
    });

    assert.equal(result.picks?.length, 1);
    assert.equal(result.picks?.[0]?.kind, 'structural');
  });

  it('ca notes returns the items the document carried', async () => {
    install('bulk', {
      json: JSON.stringify({
        items: [
          {
            url: DOCUMENT.url,
            headline: 'A rule changed',
            kind: 'structural',
            noteMd: 'A note.',
            sentenceEvidence: [0],
            evidence: [{ quote: 'The rule changed today.' }],
            sectionKeys: [],
            syllabusSlugs: ['gs2-dpsp'],
            anthro: null,
          },
        ],
      }),
    });
    const result = await ca.currentNotesRunner()({
      ...base,
      documents: [DOCUMENT],
      picks: [],
      syllabusSlugs: ['gs2-dpsp'],
      sections: [],
    });

    assert.equal(result.drafts?.length, 1);
    // `at` is -1 until grounding resolves it; the coercer must not trust an
    // offset the model supplied.
    assert.equal(result.drafts?.[0]?.evidence[0]?.at, -1);
  });

  it('drill generation returns the prompts the document carried', async () => {
    install('bulk', {
      json: JSON.stringify({
        prompts: [{ kind: 'essay_outline', promptText: 'Discuss.', caseDetail: null, syllabusSlug: null, why: 'w' }],
      }),
    });
    const result = await drills.currentGenerateRunner()({
      ...base,
      want: [{ kind: 'essay_outline', count: 1 }],
      vocabulary: [],
      excludePrompts: [],
    });

    assert.equal(result.drafts?.length, 1);
  });

  it('drill marking returns a total recomputed from the clamped verdicts', async () => {
    // The clamp and the recomputed total are the call site`s, not the
    // provider`s. A model that returned 99/12 and its own total must not be
    // able to put a number on her screen that its own parts do not add to.
    install('evaluation', {
      json: JSON.stringify({
        verdicts: [{ part: 'thesis', score: 99, comment: 'c' }],
        highestLeverageFix: 'f',
        feedbackMarkdown: 'm',
      }),
    });
    const result = await drills.currentEvaluateRunner()({
      ...base,
      model: 'eval-model-1',
      kind: 'essay_outline',
      promptText: 'Discuss.',
      caseDetail: null,
      parts: [{ part: 'thesis', content: 'x' }],
    });

    assert.equal(result.evaluation?.verdicts[0]?.score, 12);
    assert.equal(result.evaluation?.total, 12);
  });

  it('interview generation returns the questions the document carried', async () => {
    install('bulk', {
      json: JSON.stringify({
        questions: [{ field: 'home_district', area: 'district', question: 'Tell us about it.', likelihood: 'likely' }],
      }),
    });
    const result = await interview.currentInterviewRunner()({
      ...base,
      entries: [{ field: 'home_district', value: 'Bhagalpur' }],
      excludeQuestions: [],
      take: 1,
    });

    assert.equal(result.drafts?.length, 1);
    assert.equal(result.drafts?.[0]?.likelihood, 'likely');
  });
});
