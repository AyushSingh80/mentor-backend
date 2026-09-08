/**
 * The decision engine.
 *
 * What is asserted here is structure and refusal, never English. The `title`
 * and `because` strings will be reworded many times and a test pinning their
 * exact wording would go red on every rewording while teaching nothing.
 *
 * The properties that matter are the ones that would fail silently: a rate
 * claimed from no evidence, a prescription that changes between two renders of
 * the same screen, a cap that stops holding, and an order file that quietly
 * stops resolving after a syllabus revision.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FIRST_PASS_ORDER } from '../src/data/first-pass-order';
import { SYLLABUS_V1 } from '../src/data/syllabus-v1';
import {
  MENTOR_RULES,
  chooseSection,
  computePace,
  decideToday,
  sizeToday,
  type DecisionContext,
} from '../src/lib/today-decision';
import type { TopicFact } from '../src/lib/syllabus-coverage';

const TODAY = '2026-09-08';
const TARGET = '2027-03-31';
const PRELIMS = '2028-05-21';

let nextId = 1;
function leaf(overrides: Partial<TopicFact> = {}): TopicFact {
  const id = overrides.id ?? nextId++;
  return {
    id,
    slug: `slug-${id}`,
    paper: 'gs2',
    topic: 'Indian Constitution',
    status: 'not_started',
    confidence: null,
    firstPassAt: null,
    retiredAt: null,
    ...overrides,
  };
}

const NO_HISTORY: DecisionContext['projection'] = {
  topicsPerDay: 0,
  sampleDays: 0,
  behindTarget: false,
  projectedDateIso: null,
};

function context(overrides: Partial<DecisionContext> = {}): DecisionContext {
  return {
    today: TODAY,
    targetFirstPassIso: TARGET,
    prelimsIso: PRELIMS,
    topics: [leaf(), leaf(), leaf(), leaf()],
    projectedHours: 1058,
    todayBlocks: [{ kind: 'active' }],
    revisionDue: null,
    openDrill: null,
    queuedAnswers: 0,
    serverReachable: true,
    lecturesLogged: 3,
    burnoutSuggestion: null,
    order: FIRST_PASS_ORDER,
    projection: NO_HISTORY,
    ...overrides,
  };
}

describe('the order file', () => {
  it('every entry resolves to a real section', () => {
    // The rot guard, and the highest-value single test here. A renamed section
    // must fail loudly rather than silently becoming an unlisted one that sorts
    // last — which would move Anthropology to the back of the queue with no
    // error anywhere.
    const real = new Set(
      (SYLLABUS_V1.entries as { paper: string; topic: string }[]).map(
        (entry) => `${entry.paper}:${entry.topic}`,
      ),
    );
    for (const key of FIRST_PASS_ORDER) {
      assert.ok(real.has(key), `"${key}" is not a section in SYLLABUS_V1`);
    }
  });

  it('starts Anthropology within the first five entries', () => {
    // The optional is 500 of 2025 marks. An order that back-loads it spends
    // eight months truthfully recommending GS and arrives at March 2027 with
    // the optional untouched. Pinned so an edit that appends it fails a test
    // rather than costing her the paper.
    const firstAnthro = FIRST_PASS_ORDER.findIndex((key) => key.startsWith('anthro_'));
    assert.ok(firstAnthro >= 0, 'Anthropology must appear at all');
    assert.ok(firstAnthro < 5, `Anthropology first appears at position ${firstAnthro + 1}`);
  });

  it('gives Anthropology a share of the head that its marks justify', () => {
    const anthro = FIRST_PASS_ORDER.filter((key) => key.startsWith('anthro_')).length;
    assert.ok(
      anthro / FIRST_PASS_ORDER.length >= 0.15,
      `only ${anthro} of ${FIRST_PASS_ORDER.length} entries are the optional`,
    );
  });

  it('lists no section twice', () => {
    assert.equal(new Set(FIRST_PASS_ORDER).size, FIRST_PASS_ORDER.length);
  });
});

describe('decideToday', () => {
  it('is deterministic', () => {
    // The single most important property. The card re-renders on focus and on
    // pull-to-refresh; advice that changes between renders is advice she cannot
    // act on. A stray `Date.now()` creeping in surfaces here.
    const ctx = context();
    assert.deepEqual(decideToday(ctx), decideToday(ctx));
  });

  it('says nothing at all before the syllabus has seeded', () => {
    // A real frame on first launch. "0 of 0 topics, 0.0 a day" would be a
    // confident wrong number on the screen she opens first.
    const decision = decideToday(context({ topics: [] }));
    assert.equal(decision.state, 'no_syllabus');
    assert.equal(decision.pace, null);
    assert.equal(decision.headline, null);
  });

  it('never claims she is behind on a fresh install', () => {
    const decision = decideToday(context({ projection: NO_HISTORY }));
    assert.equal(decision.state, 'fresh');
    assert.equal(decision.pace?.behindTarget, false);
    assert.equal(
      decision.pace?.actualPerDay,
      null,
      'no history must read as null, never as a rate of zero',
    );
    assert.equal(decision.pace?.projectedDateIso, null);
  });

  it('refuses "behind" even when the projection claims it with no sample', () => {
    // The case the guard actually exists for, and the first version of this
    // suite did not cover it: the fixture already carried `behindTarget: false`,
    // so removing the guard broke nothing and the test passed either way.
    //
    // `behindTarget` is inherited rather than recomputed, which means this
    // module must not inherit a verdict drawn from zero evidence. Whether
    // `projectFirstPass` can currently produce this combination is beside the
    // point — depending on another module's internals for a refusal is exactly
    // what the guard is refusing to do.
    const decision = decideToday(
      context({
        projection: {
          topicsPerDay: 3,
          sampleDays: 0,
          behindTarget: true,
          projectedDateIso: '2030-01-01',
        },
      }),
    );
    assert.equal(decision.pace?.behindTarget, false, 'no sample means no verdict');
    assert.equal(decision.pace?.actualPerDay, null);
    assert.equal(decision.pace?.projectedDateIso, null, 'a projected date needs evidence too');
    assert.equal(decision.state, 'fresh');
  });

  it('names the LEAF, not the section, once per leaf', () => {
    // The bug this pins, found on the device: `TopicFact` carried no leaf name,
    // so the card rendered the section heading three times — "Indian
    // Constitution / Indian Constitution / Indian Constitution" — and looked
    // broken. Every screen before this one displayed coverage at section level
    // and never had cause to notice the field was missing.
    const topics = [
      leaf({ id: 1, subtopic: 'Historical underpinnings and evolution' }),
      leaf({ id: 2, subtopic: 'Features and significant provisions' }),
      leaf({ id: 3, subtopic: 'Amendments and basic structure' }),
    ];
    const labels = decideToday(context({ topics })).headline!.leaves.map((entry) => entry.label);

    assert.equal(new Set(labels).size, labels.length, `repeated labels: ${labels.join(' | ')}`);
    assert.ok(labels.includes('Historical underpinnings and evolution'));
    assert.ok(!labels.includes('Indian Constitution'), 'that is the section, not a leaf');
  });

  it('falls back to the section where a heading has no leaf under it', () => {
    const topics = [leaf({ id: 1, subtopic: null })];
    assert.equal(decideToday(context({ topics })).headline!.leaves[0]?.label, 'Indian Constitution');
  });

  it('still gives exactly one headline act on a fresh install', () => {
    // Not zero. This is the property the whole module exists for.
    const decision = decideToday(context());
    assert.notEqual(decision.headline, null);
    assert.ok(decision.headline!.leaves.length >= MENTOR_RULES.minLeavesPerDay);
  });

  it('states the true required rate even with no history', () => {
    // 4 topics over ~204 days. Both figures are computable on day one and are
    // the two most motivating true facts available.
    const pace = decideToday(context()).pace!;
    assert.equal(pace.remainingTopics, 4);
    assert.ok(pace.daysToTarget > 200 && pace.daysToTarget < 210);
    assert.ok(pace.requiredPerDay !== null && pace.requiredPerDay > 0);
    assert.ok(pace.hoursPerTopic !== null && pace.hoursPerTopic > 0);
  });

  it('caps the day however unreachable the target is', () => {
    // 4000 topics in 204 days asks for 20 a day. Naming 20 is not advice.
    const many = Array.from({ length: 4000 }, () => leaf());
    const decision = decideToday(context({ topics: many }));
    assert.ok(decision.headline!.leaves.length <= MENTOR_RULES.maxLeavesPerDay);
  });

  it('shrinks the day to one leaf when a burnout finding is standing', () => {
    // The decision card and the burnout finding must never give opposite advice
    // on one screen. The decision defers.
    const decision = decideToday(
      context({ burnoutSuggestion: 'Three late nights this week. Take tomorrow lighter.' }),
    );
    assert.equal(decision.headline!.leaves.length, MENTOR_RULES.restrainedLeavesPerDay);
    assert.equal(decision.restraint, 'Three late nights this week. Take tomorrow lighter.');
  });

  it('asks for one leaf on a day with no study block', () => {
    const decision = decideToday(context({ todayBlocks: [{ kind: 'micro' }] }));
    assert.equal(decision.headline!.leaves.length, MENTOR_RULES.minLeavesPerDay);
  });

  it('puts an open drill ahead of everything', () => {
    const decision = decideToday(context({ openDrill: { id: 7, kind: 'essay_outline' } }));
    assert.equal(decision.headline?.kind, 'finish_open_drill');
    assert.equal(decision.headline?.route, '/drill/7');
  });

  it('does not prescribe a retry when the server is unreachable', () => {
    // A lever that does nothing. The same finding as the catch-up plan advising
    // a playback-speed change across zero minutes.
    const decision = decideToday(context({ queuedAnswers: 2, serverReachable: false }));
    const kinds = [decision.headline, ...decision.then].map((act) => act?.kind);
    assert.ok(!kinds.includes('retry_queued_answer'));
  });

  it('does not mention revision when the deck has not resolved', () => {
    // `null` is NOT KNOWN YET, not zero. Two counts of "due today" on one
    // screen that can disagree is a bug this app has already shipped once.
    const decision = decideToday(context({ revisionDue: null }));
    const kinds = [decision.headline, ...decision.then].map((act) => act?.kind);
    assert.ok(!kinds.includes('revise_due'));
  });

  it('never offers more than maxActs', () => {
    const decision = decideToday(
      context({
        openDrill: { id: 1, kind: 'essay_outline' },
        queuedAnswers: 1,
        revisionDue: 5,
        lecturesLogged: 0,
      }),
    );
    assert.equal(1 + decision.then.length, MENTOR_RULES.maxActs);
  });

  it('reports the pass as complete rather than dividing by nothing', () => {
    const done = [leaf({ status: 'first_pass' }), leaf({ status: 'revised' })];
    const decision = decideToday(context({ topics: done }));
    assert.equal(decision.state, 'complete');
    assert.equal(decision.pace?.remainingTopics, 0);
    assert.equal(decision.pace?.hoursPerTopic, null);
  });

  it('excludes retired topics from the work remaining', () => {
    const topics = [leaf(), leaf({ retiredAt: '2026-01-01T00:00:00.000Z' })];
    assert.equal(decideToday(context({ topics })).pace?.remainingTopics, 1);
  });
});

describe('computePace', () => {
  it('switches to Prelims once the first-pass date has passed', () => {
    // Not hypothetical: the target is 204 days out with almost no slack.
    const pace = computePace({
      topics: [leaf()],
      today: '2027-06-01',
      targetIso: TARGET,
      prelimsIso: PRELIMS,
      projectedHours: 100,
      projection: NO_HISTORY,
    });
    assert.equal(pace.against, 'prelims');
    assert.ok(pace.daysToTarget > 0, 'must not divide by zero on the day after the target');
    assert.ok(pace.requiredPerDay !== null);
  });

  it('reports no required rate once even Prelims has passed', () => {
    const pace = computePace({
      topics: [leaf()],
      today: '2029-01-01',
      targetIso: TARGET,
      prelimsIso: PRELIMS,
      projectedHours: 100,
      projection: NO_HISTORY,
    });
    assert.equal(pace.daysToTarget, 0);
    assert.equal(pace.requiredPerDay, null);
  });

  it('inherits behindTarget rather than recomputing it', () => {
    const pace = computePace({
      topics: [leaf()],
      today: TODAY,
      targetIso: TARGET,
      prelimsIso: PRELIMS,
      projectedHours: 100,
      projection: { topicsPerDay: 0.4, sampleDays: 14, behindTarget: true, projectedDateIso: '2027-08-01' },
    });
    assert.equal(pace.behindTarget, true);
    assert.equal(pace.actualPerDay, 0.4);
    assert.equal(pace.projectedDateIso, '2027-08-01');
  });
});

describe('chooseSection', () => {
  it('continues an open section before starting a new one', () => {
    // Stickiness. A trail of half-done sections is how a first pass never
    // completes, and this is what protects the rule from a later refactor.
    const topics = [
      // An unlisted-but-open section must still beat the top of the order file.
      leaf({ id: 100, paper: 'gs3', topic: 'Agriculture', status: 'in_progress' }),
      leaf({ id: 101, paper: 'gs3', topic: 'Agriculture' }),
      leaf({ id: 1, paper: 'gs2', topic: 'Indian Constitution' }),
    ];
    assert.equal(chooseSection({ topics, order: FIRST_PASS_ORDER })?.label, 'Agriculture');
  });

  it('opens on the declared first entry when nothing is started', () => {
    const topics = [
      leaf({ id: 50, paper: 'gs1', topic: 'Indian Art and Culture' }),
      leaf({ id: 51, paper: 'gs2', topic: 'Indian Constitution' }),
    ];
    // Printed syllabus order would open with Art and Culture. The order file
    // deliberately does not.
    assert.equal(
      chooseSection({ topics, order: FIRST_PASS_ORDER })?.label,
      'Indian Constitution',
    );
  });

  it('orders two otherwise-identical sections deterministically', () => {
    // Totality. Without the final string compare, `Array.sort` stability would
    // be doing load-bearing work for advice she is meant to trust.
    const topics = [
      leaf({ id: 10, paper: 'gs1', topic: 'Zed Section' }),
      leaf({ id: 10, paper: 'gs1', topic: 'Alpha Section' }),
    ];
    const first = chooseSection({ topics, order: [] })?.label;
    const again = chooseSection({ topics: [...topics].reverse(), order: [] })?.label;
    assert.equal(first, again);
  });

  it('returns null when every section is finished', () => {
    const topics = [leaf({ status: 'first_pass' })];
    assert.equal(chooseSection({ topics, order: FIRST_PASS_ORDER }), null);
  });
});

describe('sizeToday', () => {
  it('never returns zero', () => {
    for (const required of [null, 0, 0.1, 2.1, 40]) {
      const size = sizeToday({
        requiredPerDay: required,
        todayBlocks: [{ kind: 'active' }],
        restrained: false,
      });
      assert.ok(size >= MENTOR_RULES.minLeavesPerDay, `required=${required} gave ${size}`);
      assert.ok(size <= MENTOR_RULES.maxLeavesPerDay);
    }
  });

  it('lets restraint win over the arithmetic', () => {
    assert.equal(
      sizeToday({ requiredPerDay: 40, todayBlocks: [{ kind: 'active' }], restrained: true }),
      MENTOR_RULES.restrainedLeavesPerDay,
    );
  });
});
