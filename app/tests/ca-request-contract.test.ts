/**
 * POST /ca/digest request-body contract — the app half.
 *
 * Counterpart: `server/tests/ca-request-contract.test.ts`, which feeds the very
 * same object through the real `parseCaBody`. Neither half is sufficient alone,
 * and this pair exists because the gap between them shipped a total outage.
 *
 * ## What went wrong, so it cannot go wrong the same way twice
 *
 * Phase 4's two halves were built in parallel against a wire nobody wrote down.
 * The app sent `{vocabulary, excludeCanonicalUrls, excludeHeadlineFingerprints}`;
 * the server read `{syllabusSlugs, sections, seenCanonicalUrls, seenFingerprints}`.
 * Not one field name matched. `parseCaBody` saw no `syllabusSlugs`, took the
 * empty-list branch, and answered **400 on every digest request ever made** —
 * while 745 app tests and 407 server tests passed, because each side tested its
 * own half against its own idea of the shape.
 *
 * Two of the mismatches would have been worse than the outage. Had only the
 * exclusion lists been misnamed, the server would have answered 200 and quietly
 * re-delivered yesterday's stories forever: no error, no log line, just a feed
 * that slowly stops being new.
 *
 * So the assertion that matters here is the EXACT key set, in both directions.
 * A field the app stops sending and a field the app adds that nothing reads are
 * the same defect wearing different clothes.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CaDigestRequest } from '../src/lib/ca-api';
import { CA_PROMPT_VERSION, buildDigestRequest, itemCapFor } from '../src/lib/ca-request';
import { sectionKeyOf, tagVocabulary, type TagFact } from '../src/lib/ca-tags';
import type { PaperValue } from '../src/lib/papers';
import type { TopicStatus } from '../src/lib/syllabus-coverage';

/* ------------------------------------------------------------------ fixtures */

let nextId = 0;

function leaf(
  paper: PaperValue,
  topic: string,
  slug: string,
  status: TopicStatus = 'not_started',
): TagFact {
  nextId += 1;
  return { id: nextId, slug, paper, topic, subtopic: null, status, retiredAt: null };
}

/** A syllabus with one started section and one she has not opened. */
const SYLLABUS: TagFact[] = [
  leaf('gs2', 'Indian Constitution', 'gs2-fundamental-rights', 'in_progress'),
  leaf('gs2', 'Indian Constitution', 'gs2-dpsp', 'in_progress'),
  leaf('gs3', 'Environment', 'gs3-biodiversity'),
  leaf('anthro_p2', 'Tribal India', 'ap2-scheduled-tribes'),
];

/**
 * The REAL builder, not a restatement of it.
 *
 * `buildDigestRequest` exists as its own pure module precisely so this test can
 * call it: while the assembly lived inside `runDailyDigest` it was unreachable
 * from Node, and unreachable is how it shipped wrong.
 */
function requestAsSent(facts: readonly TagFact[] = SYLLABUS): CaDigestRequest {
  return buildDigestRequest({
    requestId: 'req_2026-09-07_5f2a',
    resume: false,
    date: '2026-09-07',
    timezone: 'Asia/Kolkata',
    maxItems: itemCapFor('2026-09-07'),
    tagFacts: facts,
    knownCanonicalUrls: ['https://pib.gov.in/pressrelease/1234'],
    knownStoryFingerprints: ['bond-quash-scheme'],
    sectionCountsThisWeek: { [sectionKeyOf('gs2', 'Indian Constitution')]: 2 },
  });
}

/**
 * Every key `parseCaBody` in `server/src/routes/ca.ts` reads, restated here.
 *
 * Restated rather than imported: the two packages are never compiled together,
 * which is the whole reason this file exists. Keep it in step by hand — the
 * server half of the pair fails loudly if you do not.
 */
const KEYS_THE_SERVER_READS = [
  'date',
  'linkAnthropology',
  'maxItems',
  'requestId',
  'sectionCountsThisWeek',
  'seenCanonicalUrls',
  'seenFingerprints',
  'vocabulary',
] as const;

/** Sent, never read. Each one needs a reason, or it is dead weight on mobile data. */
const KEYS_SENT_BUT_NOT_READ = [
  // Echoed into `ca_digests` and shown on the digest screen's provenance line.
  'promptVersion',
  // Re-attachment marker; the server is idempotent on `requestId` instead.
  'resume',
  // The day is already resolved app-side; carried so a server-side log can say
  // which zone produced `date` when one lands on an unexpected day.
  'timezone',
] as const;

/* --------------------------------------------------------------------- tests */

describe('POST /ca/digest request body', () => {
  it('sends exactly the keys the server reads, and no others', () => {
    const sent = Object.keys(JSON.parse(JSON.stringify(requestAsSent()))).sort();
    assert.deepEqual(sent, [...KEYS_THE_SERVER_READS, ...KEYS_SENT_BUT_NOT_READ].sort());
  });

  it('sends every key the server requires', () => {
    const sent = new Set(Object.keys(requestAsSent()));
    for (const key of KEYS_THE_SERVER_READS) {
      assert.ok(sent.has(key), `server reads "${key}" and the app never sends it`);
    }
  });

  it('does not send the names the server never learned', () => {
    // The literal strings from the outage. A rename back to any of them is the
    // bug this file was written for.
    const sent = new Set(Object.keys(requestAsSent()));
    for (const dead of ['excludeCanonicalUrls', 'excludeHeadlineFingerprints', 'syllabusSlugs']) {
      assert.equal(sent.has(dead), false, `"${dead}" is not a field the server reads`);
    }
  });

  it('survives a JSON round trip unchanged', () => {
    // `streamCaDigest` sends `JSON.stringify(request)` verbatim. A `Set`, a
    // `Map` or an `undefined` in this object serialises to something the server
    // cannot read, and TypeScript would not say a word.
    const request = requestAsSent();
    const round = JSON.parse(JSON.stringify(request)) as CaDigestRequest;
    assert.deepEqual(round, request);
  });
});

describe('the vocabulary the server is constrained to', () => {
  it('carries slug, label, paper and level on every entry', () => {
    for (const entry of requestAsSent().vocabulary) {
      assert.equal(typeof entry.slug, 'string');
      assert.equal(typeof entry.label, 'string');
      assert.equal(typeof entry.paper, 'string');
      assert.ok(entry.level === 'section' || entry.level === 'leaf');
      assert.notEqual(entry.slug.trim(), '');
    }
  });

  it('is never empty on a syllabus where nothing has been started', () => {
    // The day-one case, and the reason the server's allowlist is FLAT.
    //
    // `tagVocabulary` offers leaves only for sections she has opened, so on a
    // fresh install it returns sections and nothing else. A server that built
    // its allowlist from leaves alone would reject this body outright — and it
    // would reject it for the one user who just installed the app.
    const fresh = SYLLABUS.map((fact) => ({ ...fact, status: 'not_started' as TopicStatus }));
    const vocabulary = tagVocabulary(fresh);

    assert.ok(vocabulary.length > 0, 'a fresh syllabus must still offer its shelves');
    assert.ok(
      vocabulary.every((entry) => entry.level === 'section'),
      'nothing started means leaves are withheld — that is the design',
    );
  });

  it('offers section keys a leaf slug can never collide with', () => {
    // `ca-tags.ts` calls the `:` separator load-bearing: one flat allowlist on
    // the server holds both levels only because a section key cannot be
    // mistaken for a kebab-case leaf slug.
    const vocabulary = requestAsSent().vocabulary;
    const sections = vocabulary.filter((entry) => entry.level === 'section');
    const leaves = vocabulary.filter((entry) => entry.level === 'leaf');

    assert.ok(sections.length > 0 && leaves.length > 0, 'fixture must exercise both levels');
    for (const section of sections) assert.match(section.slug, /:/);
    for (const item of leaves) assert.doesNotMatch(item.slug, /:/);
  });
});

describe('the scalars the server range-checks', () => {
  it('asks for an item count inside the server’s accepted range', () => {
    // `MIN_MAX_ITEMS` and `MAX_DAILY_ITEMS` in `server/src/ca/pipeline.ts`.
    // A weekend cap raised past the server's ceiling is a 400 on Saturdays
    // only, which is the kind of bug that takes a month to notice.
    for (const day of ['2026-09-07', '2026-09-12', '2026-09-13']) {
      const cap = itemCapFor(day);
      assert.ok(Number.isInteger(cap), `${day}: maxItems must be an integer`);
      assert.ok(cap >= 1 && cap <= 8, `${day}: maxItems ${cap} is outside the server's 1..8`);
    }
  });

  it('sends the digest day as YYYY-MM-DD', () => {
    assert.match(requestAsSent().date, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('reports the prompt cohort this build asks for', () => {
    assert.equal(requestAsSent().promptVersion, CA_PROMPT_VERSION);
  });

  it('copies the caller\u2019s lists rather than aliasing them', () => {
    // `streamCaDigest` stringifies this object at an `await` boundary, so a
    // context mutated in between would change what actually went on the wire.
    const urls = ['https://pib.gov.in/a'];
    const request = buildDigestRequest({
      requestId: 'req-alias',
      resume: false,
      date: '2026-09-07',
      timezone: 'Asia/Kolkata',
      maxItems: 6,
      tagFacts: SYLLABUS,
      knownCanonicalUrls: urls,
      knownStoryFingerprints: [],
      sectionCountsThisWeek: {},
    });
    urls.push('https://pib.gov.in/b');
    assert.deepEqual(request.seenCanonicalUrls, ['https://pib.gov.in/a']);
  });

  it('keys the weekly section counts the way the vocabulary names sections', () => {
    // The server's cap looks these keys up against the `sectionKeys` the model
    // returned, which it took from the vocabulary. Keyed any other way, the cap
    // matches nothing and silently never binds.
    const request = requestAsSent();
    const offered = new Set(request.vocabulary.map((entry) => entry.slug));
    for (const key of Object.keys(request.sectionCountsThisWeek)) {
      assert.ok(offered.has(key), `section count key "${key}" is not in the vocabulary`);
    }
  });
});
