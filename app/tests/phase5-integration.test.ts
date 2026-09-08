/**
 * Phase 5 seams: the handoffs between modules, not the modules.
 *
 * Same charter as `phase2-`, `phase3-` and `phase4-integration.test.ts`. Each
 * case wires two real modules together and asserts the value crossing between
 * them is one the receiver accepts.
 *
 * The wire contract lives in `drill-contract.test.ts` with a server counterpart.
 * What is left for this file is the seams INSIDE the app: the submit gate
 * against the server's part list, the bank against the request builder, the
 * drill's topic against the material selector, and the mark scale against what
 * the screens display.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bankStock, refillTargets, shouldRefillPrompts } from '../src/lib/drill-bank';
import { buildEvaluateDrillRequest, buildGeneratePromptsRequest } from '../src/lib/drill-request';
import {
  DRILL_RULES,
  ESSAY_DIMENSIONS,
  ESSAY_OUTLINE_PARTS,
  ETHICS_CASE_PARTS,
  PARTS_OF_KIND,
  PART_PROMPTS,
  DRILL_KINDS,
  type DrillPartFacts,
  type MaterialFacts,
} from '../src/lib/drill-types';
import { checkSubmittable, namedDimensions, targetMinutes, wordCount } from '../src/lib/drills';
import { suggestMaterial } from '../src/lib/material';

function part(name: string, content: string): DrillPartFacts {
  return { part: name as DrillPartFacts['part'], content, words: wordCount(content) };
}

const OUTLINE: DrillPartFacts[] = [
  part('thesis', 'Order is a continuous administrative achievement, not a settled condition, and treating it as settled is how states are surprised.'),
  part('dimensions', 'Political: policing by consent\nEconomic: the cost of predictability\nHistorical: the Emergency as managed order'),
  part('opening', 'In 1975 the trains ran on time. That sentence has done more damage to Indian political argument than almost any other one.'),
  part('closing', 'The question is never whether order exists but who is asked to bear its cost, and whether they were asked at all before it was imposed.'),
];

const CASE: DrillPartFacts[] = ETHICS_CASE_PARTS.map((name) =>
  part(name, `A written answer for ${name} that is long enough to clear the floor comfortably.`),
);

/* --------------------------------- seam 1: submit gate <-> the server's parts */

describe('seam: what the gate checks <-> what the server marks', () => {
  it('gates exactly the parts the server expects for each kind', () => {
    // Both derive from `PARTS_OF_KIND`, so this holds by construction TODAY. It
    // is asserted because they are two independent uses: add a part to the
    // frozen list and forget the gate, and she submits an attempt the server
    // refuses for a part count she was never asked for.
    for (const kind of DRILL_KINDS) {
      const parts = PARTS_OF_KIND[kind].map((name) => part(name, 'x '.repeat(20)));
      assert.deepEqual(
        checkSubmittable(kind, parts).parts.map((entry) => entry.part),
        [...PARTS_OF_KIND[kind]],
      );
    }
  });

  it('sends exactly what the gate approved', () => {
    // The gate passing and the request carrying a different set is how a
    // "ready" attempt comes back as a 400.
    const check = checkSubmittable('essay_outline', OUTLINE);
    assert.equal(check.ready, true, check.blocker ?? '');

    const request = buildEvaluateDrillRequest({
      requestId: 'r',
      kind: 'essay_outline',
      promptText: 'Order is not the absence of disorder',
      caseDetail: null,
      parts: OUTLINE,
    });
    assert.deepEqual(
      request.parts.map((entry) => entry.part),
      check.parts.map((entry) => entry.part),
    );
  });

  it('has a written prompt for every part of every kind', () => {
    // `PART_PROMPTS` is what appears above each input. A part with no prompt
    // renders a blank hint, which reads as a bug on the screen that matters.
    for (const kind of DRILL_KINDS) {
      for (const name of PARTS_OF_KIND[kind]) {
        assert.notEqual((PART_PROMPTS[name] ?? '').trim(), '', `${name} has no prompt`);
      }
    }
  });

  it('gates a case on its own five parts and never on the lens rule', () => {
    const check = checkSubmittable('ethics_case', CASE);
    assert.equal(check.ready, true, check.blocker ?? '');
    assert.equal(
      check.parts.every((entry) => entry.problem !== 'too_few_dimensions'),
      true,
    );
  });
});

/* ------------------------------------ seam 2: the bank <-> the request builder */

describe('seam: the refill decision -> the request it produces', () => {
  it('asks for exactly what the gate decided', () => {
    const decision = shouldRefillPrompts({
      stock: bankStock({
        counts: [
          { kind: 'essay_outline', banked: 10, inProgress: 0 },
          { kind: 'ethics_case', banked: 1, inProgress: 0 },
        ],
        lastRefillAttemptAt: null,
      }),
      trigger: 'manual',
      now: '2026-09-07T08:00:00.000Z',
      spendCapAllows: true,
      refillInFlight: false,
    });
    assert.equal(decision.refill, true);

    const request = buildGeneratePromptsRequest({
      requestId: 'r',
      want: decision.want,
      vocabulary: [],
      bankedPrompts: [],
    });
    assert.deepEqual(request.want, [...decision.want]);
  });

  it('never asks for more than the server`s batch ceiling', () => {
    // `MAX_PROMPTS_PER_BATCH` on the server is 12. A bank empty of both kinds
    // is the largest request this app can produce.
    const targets = refillTargets(
      bankStock({
        counts: [
          { kind: 'essay_outline', banked: 0, inProgress: 0 },
          { kind: 'ethics_case', banked: 0, inProgress: 0 },
        ],
        lastRefillAttemptAt: null,
      }),
    );
    const total = targets.reduce((sum, entry) => sum + entry.count, 0);
    assert.ok(total <= 12, `a full refill asks for ${total}, over the server's ceiling of 12`);
    assert.equal(total, DRILL_RULES.promptBatchSize);
  });

  it('produces a request the server would not refuse for a zero count', () => {
    // A bank full of one kind and empty of the other: the full kind's target is
    // zero, and sending it would be a 400 on every automatic top-up.
    const targets = refillTargets(
      bankStock({
        counts: [
          { kind: 'essay_outline', banked: DRILL_RULES.targetBankedPrompts, inProgress: 0 },
          { kind: 'ethics_case', banked: 2, inProgress: 0 },
        ],
        lastRefillAttemptAt: null,
      }),
    );
    const request = buildGeneratePromptsRequest({
      requestId: 'r',
      want: targets,
      vocabulary: [],
      bankedPrompts: [],
    });
    assert.ok(request.want.every((entry) => entry.count >= 1));
    assert.deepEqual(request.want.map((entry) => entry.kind), ['ethics_case']);
  });
});

/* -------------------------------- seam 3: a drill's topic -> material surfaced */

describe('seam: a drill`s syllabus topic -> the material offered with it', () => {
  let nextId = 0;
  function material(overrides: Partial<MaterialFacts> = {}): MaterialFacts {
    nextId += 1;
    return {
      id: nextId,
      kind: 'example',
      content: `material ${nextId}`,
      attribution: null,
      sourceNote: null,
      syllabusTopicId: null,
      caItemId: null,
      timesUsed: 0,
      lastUsedAt: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('offers at most the rule`s count, so the panel cannot swamp the editor', () => {
    const bank = Array.from({ length: 30 }, () => material({ syllabusTopicId: 10 }));
    assert.equal(
      suggestMaterial(bank, { syllabusTopicId: 10, siblingTopicIds: [10] }).length,
      DRILL_RULES.materialSuggestions,
    );
  });

  it('still offers material for a drill whose topic did not resolve', () => {
    // An untagged prompt is common — the server tags only from the vocabulary
    // and returns null when nothing fits. An empty panel would read as broken.
    const bank = [material(), material()];
    assert.equal(
      suggestMaterial(bank, { syllabusTopicId: null, siblingTopicIds: [] }).length,
      2,
    );
  });

  it('carries a reason on every suggestion, since the screen renders one', () => {
    const bank = [material({ syllabusTopicId: 10 }), material({ timesUsed: 4 })];
    for (const entry of suggestMaterial(bank, { syllabusTopicId: 10, siblingTopicIds: [10] })) {
      assert.notEqual(entry.reason.trim(), '');
    }
  });
});

/* ------------------------------------- seam 4: the caps and scales agree */

describe('seam: the numbers three modules each display', () => {
  it('keeps every part ceiling under the server`s character limit', () => {
    // `MAX_PART_CHARS` on the server, restated. The two are not redundant: the
    // local one shapes behaviour and explains itself in words, the server one
    // bounds a request body. A safety limit that fires BEFORE the behavioural
    // one is a 400 on twenty minutes of writing after the button said yes —
    // which is what this assertion caught when the server's bound was 1600.
    const SERVER_MAX_PART_CHARS = 2000;
    // Eight characters a word: UPSC prose runs to "intergenerational".
    const worstCase = DRILL_RULES.maxPartWords * 8;
    assert.ok(
      worstCase <= SERVER_MAX_PART_CHARS,
      `${DRILL_RULES.maxPartWords} words can reach ${worstCase} chars, over the server's ${SERVER_MAX_PART_CHARS}`,
    );
  });

  it('keeps the dimension floor reachable within the lens list', () => {
    assert.ok(DRILL_RULES.minDimensions <= ESSAY_DIMENSIONS.length);
    assert.ok(DRILL_RULES.maxDimensions <= ESSAY_DIMENSIONS.length);
    assert.ok(DRILL_RULES.minDimensions < DRILL_RULES.maxDimensions);
  });

  it('keeps the low-water mark under the target, or the bank never settles', () => {
    assert.ok(DRILL_RULES.lowWaterPrompts < DRILL_RULES.targetBankedPrompts);
  });

  it('sizes a batch so one refill can cross the low-water mark', () => {
    // A batch smaller than the shortfall would leave the bank below the floor
    // and the cooldown would then block the next attempt for six hours.
    assert.ok(DRILL_RULES.promptBatchSize >= DRILL_RULES.lowWaterPrompts);
  });

  it('keeps a drill inside the writing block', () => {
    // The block is two hours and answer writing is what it is for. A drill that
    // ate half of it would stop being the thing that makes essay practice fit a
    // working week.
    for (const kind of DRILL_KINDS) {
      assert.ok(targetMinutes(kind) <= 30, `${kind} targets ${targetMinutes(kind)} minutes`);
    }
  });

  it('counts a full dimension map as covering every lens', () => {
    // The end-to-end check on the parser the editor's counter uses: seven
    // labelled lines must read as seven, or the counter under-reports and she
    // pads an outline that was already complete.
    const full = ESSAY_DIMENSIONS.map(
      (lens) => `${lens[0]!.toUpperCase()}${lens.slice(1)}: a specific angle written out`,
    ).join('\n');
    assert.equal(namedDimensions(full).length, ESSAY_DIMENSIONS.length);
  });

  it('agrees with the server on the part list for both kinds', () => {
    // `PARTS_OF_KIND` is duplicated across the package boundary, byte for byte.
    // These are the literals the server's copy holds.
    assert.deepEqual([...ESSAY_OUTLINE_PARTS], ['thesis', 'dimensions', 'opening', 'closing']);
    assert.deepEqual(
      [...ETHICS_CASE_PARTS],
      ['keywords', 'stakeholders', 'options', 'decision', 'theory'],
    );
  });
});
