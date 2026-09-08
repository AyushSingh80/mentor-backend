/**
 * Essay and Ethics drill vocabulary. FROZEN.
 *
 * The counterpart to `server/src/drills/types.ts`. Written BEFORE either side,
 * and neither side edits it — Phases 3 and 4 both shipped with every field name
 * different across the wire because each half was built against its own idea of
 * the contract, and both packages' test suites passed the whole time.
 *
 * ## Why these two papers get their own phase
 *
 * Essay is 125 marks and GS4 is 250: 375 of 1750, over a fifth of Mains. They
 * are also the two papers where the SHAPE of a good answer is knowable in
 * advance, which is exactly what Phase 1's "scan a full answer, get a score"
 * loop cannot teach.
 *
 * An essay is ninety minutes. The only uninterrupted block that long is
 * Saturday's timed set, which GS also needs — so at one essay a week she writes
 * about sixty before the exam with nothing between attempts telling her why the
 * last one was flat. An ethics case study is worse served still: the rubric
 * names a five-part structure, and a single mark out of twenty cannot say that
 * the decision was fine and the options were straw men.
 *
 * So a drill is SUB-ANSWER and STRUCTURED. An essay outline costs twenty
 * minutes and carries 70% of the essay rubric's weight; an ethics case is
 * answered and scored part by part.
 */

import type { PaperValue } from '@/lib/papers';

/* ------------------------------------------------------------------ kinds */

export const DRILL_KINDS = ['essay_outline', 'ethics_case'] as const;
export type DrillKind = (typeof DRILL_KINDS)[number];

export function isDrillKind(value: unknown): value is DrillKind {
  return typeof value === 'string' && (DRILL_KINDS as readonly string[]).includes(value);
}

/** The paper a drill kind scores against. Drives which rubric the server loads. */
export const PAPER_OF_KIND: Readonly<Record<DrillKind, PaperValue>> = {
  essay_outline: 'essay',
  ethics_case: 'gs4',
};

/* ------------------------------------------------------------------ parts */

/**
 * The parts of an essay outline, in the order they are written and shown.
 *
 * Deliberately NOT the whole essay. Thesis (25%), multi-dimensional coverage
 * (25%) and the opening/closing pair (20%) are 70% of the essay rubric between
 * them, and all three are decidable in twenty minutes. Narrative flow (20%) and
 * quotes (10%) need the full prose and are what a Saturday full essay is for.
 */
export const ESSAY_OUTLINE_PARTS = ['thesis', 'dimensions', 'opening', 'closing'] as const;

/**
 * The parts of an ethics case answer, in the order the rubric names them.
 *
 * One-to-one with `server/src/rubrics/ethics.md`'s dimensions, and that is the
 * point: a part-by-part score says which of the five failed, where a single
 * mark out of twenty says only that something did.
 */
export const ETHICS_CASE_PARTS = [
  'keywords',
  'stakeholders',
  'options',
  'decision',
  'theory',
] as const;

export type EssayOutlinePart = (typeof ESSAY_OUTLINE_PARTS)[number];
export type EthicsCasePart = (typeof ETHICS_CASE_PARTS)[number];
export type DrillPart = EssayOutlinePart | EthicsCasePart;

export const PARTS_OF_KIND: Readonly<Record<DrillKind, readonly DrillPart[]>> = {
  essay_outline: ESSAY_OUTLINE_PARTS,
  ethics_case: ETHICS_CASE_PARTS,
};

/** What each part asks for, shown above its input. Rendered, never parsed. */
export const PART_PROMPTS: Readonly<Record<DrillPart, string>> = {
  thesis:
    'One sentence carrying the whole essay. Not the topic restated — a position on it that the last paragraph can return to.',
  dimensions:
    'Which lenses this topic can be worked through, and the specific angle for each. Breadth is what separates an essay from a long GS answer.',
  opening:
    'The first paragraph, written out. An anecdote, a paradox, a historical vignette — something that holds a tired examiner at 4pm on their ninetieth script.',
  closing:
    'The last paragraph, written out. It must resolve the thesis, not restate the introduction.',
  keywords:
    'Define the ethical terms the case turns on, precisely and up front. An answer on probity that never defines probity has already lost marks.',
  stakeholders:
    'Everyone affected, including the ones easy to overlook — subordinates, future citizens, the institution itself.',
  options:
    'Genuine alternatives, each with honest merits AND demerits. One obviously-correct option and two straw men is the most common case-study failure.',
  decision:
    'What you would do, committed, and why. Fence-sitting scores badly. Name who is harmed by your decision.',
  theory:
    'The ethical grounding — deontology, consequentialism, virtue ethics, Gandhian ethics, constitutional morality, a named thinker.',
};

/* ------------------------------------------------------- essay dimensions */

/**
 * The lenses an essay can be worked through.
 *
 * A closed list because the drill's whole job is to make breadth mechanical:
 * "name three more angles" is answerable against a list and unanswerable
 * against a blank page. The rubric names political, economic, social, ethical,
 * environmental, historical and international explicitly.
 */
export const ESSAY_DIMENSIONS = [
  'political',
  'economic',
  'social',
  'ethical',
  'environmental',
  'historical',
  'international',
] as const;

export type EssayDimension = (typeof ESSAY_DIMENSIONS)[number];

export function isEssayDimension(value: unknown): value is EssayDimension {
  return typeof value === 'string' && (ESSAY_DIMENSIONS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------- the rules */

export const DRILL_RULES = {
  /**
   * Minutes an outline is meant to take.
   *
   * Twenty, because the weekday block is two hours and an outline that eats an
   * hour has become a slow essay — it stops being the thing that makes essay
   * practice fit a working week and starts competing with GS answer writing.
   */
  essayOutlineMinutes: 20,
  /** A case study is 20 marks and UPSC allows roughly this long for one. */
  ethicsCaseMinutes: 25,

  /**
   * Dimensions an outline must name before it can be submitted.
   *
   * Three, not seven. Seven is the ceiling the rubric rewards reaching for, but
   * a gate at seven would be met by writing seven empty lines — and a drill
   * that teaches padding is worse than no drill. Three real angles is what
   * separates an essay from a long GS answer.
   */
  minDimensions: 3,
  /** Above this an outline is listing lenses rather than choosing between them. */
  maxDimensions: 7,

  /** Per-part ceiling. An outline part running longer has become prose. */
  maxPartWords: 220,
  /** Below this a part is a heading, not an answer. */
  minPartWords: 12,

  /**
   * Prompts kept ahead. Matches the MCQ bank's reasoning: a drill she cannot
   * start on a morning with no signal is a drill she does not do.
   */
  targetBankedPrompts: 12,
  lowWaterPrompts: 4,
  /** One batch. Small on purpose — a topic bank goes stale as current affairs move. */
  promptBatchSize: 6,
  /** Matches `BANK_RULES.refillCooldownHours` and `CA_RULES.digestCooldownHours`. */
  refillCooldownHours: 6,

  /**
   * Material surfaced per drill, as a reminder of what she already has.
   *
   * Five, and they are SUGGESTIONS rather than a requirement: an essay written
   * to fit the quotes it was handed is the tail wagging the dog, and the rubric
   * is explicit that a misattributed or decorative quote costs more than it
   * gains.
   */
  materialSuggestions: 5,
} as const;

/* -------------------------------------------------------------- the facts */

export type DrillStatus = 'banked' | 'in_progress' | 'submitted' | 'evaluated' | 'failed';

/** One part of an attempt, as written. */
export interface DrillPartFacts {
  part: DrillPart;
  content: string;
  words: number;
}

/** One part's score, as returned. `max` is per-part, never the whole drill. */
export interface DrillScoreFacts {
  part: DrillPart;
  score: number;
  max: number;
  comment: string | null;
}

export interface DrillFacts {
  id: number;
  kind: DrillKind;
  status: DrillStatus;
  /** The topic or case, as generated. Never edited on the device. */
  promptText: string;
  /** For an ethics case, the extra situational detail. Null for an outline. */
  caseDetail: string | null;
  /** The syllabus section this was generated against, when it resolved. */
  syllabusTopicId: number | null;
  /** Local calendar day the prompt was banked, `YYYY-MM-DD`. */
  bankedOn: string;
  /** ISO instant she started writing, or null. */
  startedAt: string | null;
  submittedAt: string | null;
  minutesSpent: number | null;
  parts: readonly DrillPartFacts[];
  scores: readonly DrillScoreFacts[];
  total: number | null;
  max: number | null;
  feedbackMd: string | null;
}

/* ---------------------------------------------------------- material bank */

export const MATERIAL_KINDS = ['quote', 'example', 'anecdote', 'thinker', 'data'] as const;
export type MaterialKind = (typeof MATERIAL_KINDS)[number];

export function isMaterialKind(value: unknown): value is MaterialKind {
  return typeof value === 'string' && (MATERIAL_KINDS as readonly string[]).includes(value);
}

export interface MaterialFacts {
  id: number;
  kind: MaterialKind;
  /** The quote, the example, the thinker's position. What gets used. */
  content: string;
  /** Who said or did it. A misattributed quote costs more than it gains. */
  attribution: string | null;
  /** Where she found it, so a doubtful one can be checked rather than dropped. */
  sourceNote: string | null;
  syllabusTopicId: number | null;
  /** Set when this came from a kept current-affairs item. */
  caItemId: number | null;
  timesUsed: number;
  lastUsedAt: string | null;
  createdAt: string;
}
