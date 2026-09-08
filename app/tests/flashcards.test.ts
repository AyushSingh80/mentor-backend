/**
 * Drafting a card from a current-affairs item.
 *
 * The load-bearing assertion in this file is that the FRONT is the topic cue
 * and never the headline. A headline on the front tests recognition — she reads
 * it, thinks "yes, I saw that", flips, and grades herself Good having retrieved
 * nothing. A Mains answer needs the opposite operation, so the cue is the
 * syllabus leaf plus what kind of thing to reach for, and the headline goes on
 * the back where it is the answer rather than the question.
 *
 * The second is that a draft is a COMPLETE insert payload. Every NOT NULL
 * column on `flashcards` is checked against the live schema rather than against
 * a list copied into this file, so adding a column without a default breaks
 * this test rather than breaking a device.
 *
 * The third is the keep cap: two a day, which is what makes ~700 cards over the
 * preparation rather than a two-thousand-card deck she abandons in month four.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getTableColumns } from 'drizzle-orm';

import {
  canKeep,
  cardBack,
  cardCue,
  cardFront,
  draftCardFromItem,
  type CardSource,
  type CardTopic,
} from '../src/lib/flashcards';
import { CA_RULES, type ItemKind } from '../src/lib/ca-types';
import { flashcards } from '../src/db/schema';
import { applyReview } from '../src/lib/sm2';

/* ------------------------------------------------------------------ helpers */

const TODAY = '2026-09-14';

const KINDS: ItemKind[] = ['structural', 'report', 'judgment', 'scheme', 'data', 'event'];

const HEADLINE = 'Cabinet approves the Pradhan Mantri Poshan Shakti Nirman revamp';

function item(overrides: Partial<CardSource> = {}): CardSource {
  return {
    id: 41,
    headline: HEADLINE,
    noteMd:
      'The revamp folds the mid-day meal scheme into a single centrally sponsored head and ' +
      'shifts the state share upward, on the stated rationale of stable nutrition outcomes.',
    kind: 'scheme',
    date: TODAY,
    sourceName: 'PIB',
    anthroLink: null,
    ...overrides,
  };
}

function topic(overrides: Partial<CardTopic> = {}): CardTopic {
  return { id: 7, paper: 'gs2', topic: 'Welfare Schemes', subtopic: null, ...overrides };
}

/* -------------------------------------------------------------------- cues */

describe('cardCue', () => {
  it('has a distinct cue for every item kind', () => {
    const cues = KINDS.map(cardCue);
    assert.equal(new Set(cues).size, KINDS.length);
    for (const cue of cues) assert.ok(cue.length > 0);
  });

  it('names an operation rather than a fact', () => {
    // "what changed", "what it held", "which way it moved" — the thing a Mains
    // paragraph is made of.
    assert.match(cardCue('structural'), /what it changes/);
    assert.match(cardCue('judgment'), /what it held/);
    assert.match(cardCue('data'), /which way it moved/);
  });

  it('falls back to the event cue on a kind this build does not know', () => {
    // `item_kind` is free text with an `'event'` default, so a server-side
    // vocabulary drift must produce a duller card, never a crash.
    assert.equal(cardCue('bulletin' as ItemKind), cardCue('event'));
  });
});

/* -------------------------------------------------------------- the front */

describe('cardFront', () => {
  it('is the topic cue, exactly as specified', () => {
    assert.equal(
      cardFront(topic(), 'scheme'),
      'GS2 · Welfare Schemes — a recent change in scheme design, and its rationale',
    );
  });

  it('carries the paper label, not the raw paper value', () => {
    assert.match(cardFront(topic({ paper: 'anthro_p2' }), 'report'), /^Anthro P2 · /);
  });

  it('includes the subtopic when there is one', () => {
    const front = cardFront(topic({ subtopic: 'Mid-day meals' }), 'scheme');
    assert.match(front, /GS2 · Welfare Schemes · Mid-day meals — /);
  });

  it('does not leave a dangling separator when the subtopic is blank', () => {
    for (const subtopic of [null, '', '   ']) {
      const front = cardFront(topic({ subtopic }), 'scheme');
      assert.equal(front.includes('·  ·'), false, JSON.stringify(subtopic));
      assert.match(front, /^GS2 · Welfare Schemes — /);
    }
  });
});

/* ----------------------------------------------------------- draftCardFromItem */

describe('draftCardFromItem', () => {
  it('puts the topic cue on the front and NOT the headline', () => {
    const draft = draftCardFromItem(item(), topic(), TODAY);

    assert.equal(
      draft.front,
      'GS2 · Welfare Schemes — a recent change in scheme design, and its rationale',
    );
    // The assertion this whole module exists for.
    assert.equal(draft.front.includes(HEADLINE), false);
    assert.equal(draft.front.includes('Cabinet approves'), false);
    assert.equal(draft.front.includes('Pradhan Mantri'), false);
  });

  it('keeps the front a cue for every kind of item', () => {
    for (const kind of KINDS) {
      const draft = draftCardFromItem(item({ kind }), topic(), TODAY);
      assert.equal(draft.front.includes(HEADLINE), false, kind);
      assert.match(draft.front, /^GS2 · Welfare Schemes — /, kind);
    }
  });

  it('puts the headline and the note on the back, where they are the answer', () => {
    const source = item();
    const draft = draftCardFromItem(source, topic(), TODAY);
    assert.ok(draft.back.includes(HEADLINE));
    assert.ok(draft.back.includes(source.noteMd));
  });

  it('attributes the back, so the example is quotable in an answer', () => {
    const draft = draftCardFromItem(item(), topic(), TODAY);
    assert.ok(draft.back.includes('PIB'));
    assert.ok(draft.back.includes(TODAY));
  });

  it('carries the Anthropology link onto the back when there is one', () => {
    const draft = draftCardFromItem(
      item({ anthroLink: 'Scheduled-tribe nutrition as an applied-anthropology intervention.' }),
      topic(),
      TODAY,
    );
    assert.match(draft.back, /Anthropology link: /);
  });

  it('links the card to both the item and the syllabus leaf', () => {
    const draft = draftCardFromItem(item(), topic(), TODAY);
    assert.equal(draft.caItemId, 41);
    assert.equal(draft.syllabusTopicId, 7);
  });

  it('schedules the first recall for tomorrow, at the start of the day', () => {
    // Not now: she has this second finished reading the note. And not a bare
    // "+24 hours" either — `lib/sm2.ts` owns the date boundary, so a card
    // drafted at 22:00 is still visible during the next morning's block.
    const draft = draftCardFromItem(item(), topic(), TODAY);
    assert.equal(draft.dueAt, '2026-09-15T00:00:00.000Z');
    assert.equal(draft.dueAt, applyReview(draft, 4, TODAY).dueAt);
  });

  it('does not spend an SM-2 repetition on having read the note', () => {
    // Reading is not a graded recall. The card starts unseen.
    const draft = draftCardFromItem(item(), topic(), TODAY);
    assert.equal(draft.repetitions, 0);
    assert.equal(draft.lapses, 0);
    assert.equal(draft.easeFactor, 2.5);
  });

  it('satisfies every NOT NULL column on `flashcards`', () => {
    const draft = draftCardFromItem(item(), topic(), TODAY);
    const supplied = draft as unknown as Record<string, unknown>;

    // Read from the live schema rather than a list copied into this test, so a
    // new NOT NULL column breaks here rather than on a device.
    const columns = getTableColumns(flashcards) as unknown as Record<
      string,
      { name: string; notNull: boolean; primary: boolean; defaultFn?: unknown }
    >;

    let checked = 0;
    for (const [key, column] of Object.entries(columns)) {
      if (!column.notNull) continue;
      // The autoincrement key, and `created_at`, which drizzle fills from a
      // runtime default at insert time. Everything else is the draft's job.
      if (column.primary) continue;
      if (typeof column.defaultFn === 'function' && key === 'createdAt') continue;

      checked += 1;
      const value = supplied[key];
      assert.ok(
        value !== undefined && value !== null,
        `${column.name} is NOT NULL but the draft supplies nothing for it`,
      );
      if (typeof value === 'string') {
        assert.notEqual(value.trim(), '', `${column.name} is NOT NULL but the draft supplies ''`);
      }
    }

    // front, back, due_at, interval_days, ease_factor, repetitions, lapses.
    assert.equal(checked, 7);
  });

  it('states the SM-2 start explicitly rather than leaning on the column defaults', () => {
    // Two descriptions of a card's starting state — the schema's and nobody's —
    // is how cards would silently begin life somewhere else on the ladder the
    // day a default changed.
    const draft = draftCardFromItem(item(), topic(), TODAY);
    const columns = getTableColumns(flashcards) as unknown as Record<
      string,
      { default?: unknown }
    >;
    for (const key of ['intervalDays', 'easeFactor', 'repetitions', 'lapses'] as const) {
      assert.notEqual(columns[key]?.default, undefined, `${key} should have a static default`);
      assert.equal(draft[key], columns[key]?.default, key);
    }
  });

  it('still produces a usable back when the note is empty', () => {
    const draft = draftCardFromItem(item({ noteMd: '   ' }), topic(), TODAY);
    assert.notEqual(draft.back.trim(), '');
    assert.ok(draft.back.includes(HEADLINE));
  });

  it('never produces an empty back, even for an untitled item with nothing in it', () => {
    const draft = draftCardFromItem(
      item({ headline: '  ', noteMd: '', sourceName: null }),
      topic(),
      TODAY,
    );
    assert.notEqual(draft.back.trim(), '');
  });

  it('throws on an unparseable day rather than scheduling from a guess', () => {
    assert.throws(() => draftCardFromItem(item(), topic(), 'tomorrow'));
  });
});

describe('cardBack', () => {
  it('leads with the headline — it is the answer to the cue', () => {
    assert.ok(cardBack(item()).startsWith(HEADLINE));
  });
});

/* ----------------------------------------------------------------- the cap */

describe('canKeep', () => {
  const base = { keptToday: 0, hasTopic: true, alreadyKept: false };

  it('allows exactly two keeps a day', () => {
    assert.equal(CA_RULES.maxKeepsPerDay, 2);

    const first = canKeep({ ...base, keptToday: 0 });
    assert.equal(first.allowed, true);
    assert.equal(first.remaining, 2);

    const second = canKeep({ ...base, keptToday: 1 });
    assert.equal(second.allowed, true);
    assert.equal(second.remaining, 1);

    const third = canKeep({ ...base, keptToday: 2 });
    assert.equal(third.allowed, false);
    assert.equal(third.remaining, 0);
    assert.match(third.reason, /2 cards a day/);
  });

  it('stays refused past the cap rather than going negative', () => {
    const decision = canKeep({ ...base, keptToday: 9 });
    assert.equal(decision.allowed, false);
    assert.equal(decision.remaining, 0);
  });

  it('refuses an item with no syllabus tag, and explains that it is still readable', () => {
    // An unknown tag never rejects an item — it only stops it becoming a card,
    // because a cue needs a syllabus leaf.
    const decision = canKeep({ ...base, hasTopic: false });
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /archive/);
  });

  it('refuses a second card from the same item', () => {
    const decision = canKeep({ ...base, alreadyKept: true });
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /already kept/);
  });

  it('always gives a reason, whatever it decides', () => {
    for (const keptToday of [0, 1, 2, 3]) {
      for (const hasTopic of [true, false]) {
        for (const alreadyKept of [true, false]) {
          const decision = canKeep({ keptToday, hasTopic, alreadyKept });
          assert.ok(decision.reason.length > 0, `${keptToday}/${hasTopic}/${alreadyKept}`);
        }
      }
    }
  });
});
