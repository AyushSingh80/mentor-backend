/**
 * The shared MCQ vocabulary. Pure — no RN, no expo-sqlite.
 *
 * Every type crossing an agent boundary lives here and ONLY the owner edits it.
 * That is the whole point: four agents building in parallel against one frozen
 * file cannot disagree about what a skip is or how a mark is counted.
 *
 * Safe value imports from here: `@/lib/papers` only.
 */

import type { PaperValue } from '@/lib/papers';

export type SessionMode = 'micro' | 'timed';
export type SessionStatus = 'in_progress' | 'completed' | 'abandoned';
export type QuestionSource = 'generated' | 'pyq';
export type Difficulty = 'easy' | 'medium' | 'hard';
export type DisputeReason = 'wrong_key' | 'ambiguous' | 'outdated';
export type DisputeVerdict = 'upheld' | 'rejected';

/** The four tiers of the selection ladder, walked in this order. */
export type SelectionTier = 'unseen_targeted' | 'unseen_any' | 'redrill_due' | 'stale_correct';

/**
 * There is no Prelims paper for Anthropology, Essay or Ethics.
 *
 * Generating MCQs for them spends money on questions she can never be examined
 * on in Prelims, and it would crowd out the three papers that matter.
 */
export const PRELIMS_PAPERS: readonly PaperValue[] = ['gs1', 'gs2', 'gs3'];

export const OPTION_COUNT = 4;

/**
 * UPSC Prelims marking, and the arithmetic that makes it worth teaching.
 *
 * Expected value of answering with probability p:
 *     EV = 2p − (2/3)(1 − p) = (8/3)p − 2/3
 * which is positive exactly when **p > 1/4**. A blind four-way guess is
 * precisely EV-neutral; eliminating even one option makes guessing pay.
 *
 * So the trainable rule is "guess if and only if you eliminated something",
 * and the reason candidates lose marks is that they BELIEVE they eliminated
 * when they did not. A drill without negative marking trains the opposite
 * habit and would actively cost her marks in the exam.
 */
/**
 * A, B, C, D. Spoken by the screen reader and printed on the option target.
 *
 * Here rather than beside the pad it is drawn on, because the ingest mapper
 * labels the server's per-option rationales with the same letters and cannot
 * import a React component: anything pulling in `react-native` fails to load
 * under Node, where the mapper is tested. Two arrays would let the reveal panel
 * and the option pad disagree about which letter is which.
 */
export const OPTION_LETTERS = ['A', 'B', 'C', 'D'] as const;

export const MARKS = {
  perCorrect: 2,
  perWrong: -2 / 3,
  perSkip: 0,
} as const;

/**
 * A question as dealt to the drill screen.
 *
 * `priorAttempts` is DERIVED from `mcq_attempts`, never stored — a stored copy
 * drifts, and this one is cheap to compute.
 */
export interface DrillQuestion {
  questionId: number;
  stem: string;
  /** Always length `OPTION_COUNT`. A three-option question renders a broken pad. */
  options: string[];
  correctIndex: number;
  eliminationLogic: string | null;
  difficulty: Difficulty;
  source: QuestionSource;
  pyqYear: number | null;
  pyqPaper: string | null;
  paper: string;
  sectionLabel: string | null;
  syllabusTopicId: number | null;
  /** > 0 renders as a repeat and is scored apart: a remembered answer is not a known one. */
  priorAttempts: number;
  tier: SelectionTier;
}

export interface AttemptRecord {
  questionId: number;
  /** `null` IS the skip. There is no separate flag — see the schema comment. */
  chosenIndex: number | null;
  correct: boolean;
  guessed: boolean;
  /** Foreground-only, clamped. Advisory: never affects scoring or selection. */
  timeTakenSec: number;
  /** Real instant, not a calendar day. */
  attemptedAt: string;
}

export interface SessionFacts {
  sessionId: number;
  mode: SessionMode;
  status: SessionStatus;
  /** Local calendar day, fixed at session start. */
  studyDate: string;
  plannedCount: number;
  markPerCorrect: number;
  markPerWrong: number;
}

export interface SectionDemand {
  /** `${paper}:${topic}`, matching what `coverageBySection` emits. */
  sectionKey: string;
  syllabusSlugs: string[];
  paper: string;
  label: string;
  /** False for sections she has never studied — drilling those destroys trust. */
  eligible: boolean;
  percentFirstPass: number;
  attempted: number;
  wrong: number;
  unseenStock: number;
  lastDrilledDay: string | null;
}

export interface QuotaLine {
  sectionKey: string;
  syllabusSlug: string;
  count: number;
  /** Human-readable. An app that silently decides what to drill is second-guessed. */
  reason: string;
}

export interface RefillPlan {
  batchSize: number;
  /** Sums to exactly `batchSize` after rounding reconciliation. */
  quotas: QuotaLine[];
  excludeStemHashes: string[];
  rationale: string;
}

/**
 * Bank depth measured in DAYS, not rows.
 *
 * "60 questions" means nothing before a commute. "Six days of runway" is
 * actionable while she is still at home with wifi.
 */
export interface BankRunway {
  unseenEligible: number;
  totalBanked: number;
  quarantined: number;
  redrillDueToday: number;
  demandPerDay: number;
  runwayDays: number;
  belowLowWater: boolean;
  lastSuccessfulRefillAt: string | null;
}

export interface SessionPreset {
  mode: SessionMode;
  questionCount: number;
  maxQuestionCount: number;
  /** Timed sets reveal at the end: a set that shows the answer mid-way is not a measurement. */
  revealMode: 'per_question' | 'at_end';
  secondsPerQuestion: number | null;
  resumableWithinDay: boolean;
  preferPyq: boolean;
  /**
   * May a past question be dealt from a section she has not started?
   *
   * Separate from `preferPyq`, which only orders. This one decides whether a
   * question is DEALT at all, and the two are different claims that happen to
   * agree today — coupling them means a later change to the ordering rule
   * silently changes what is eligible.
   *
   * The eligibility gate exists because "drilling a section she has never
   * opened destroys trust" — true of a GENERATED question, whose key is a
   * model's guess about material she has not read. A past paper in a timed set
   * is a different act: it is a measurement, and the exam will not restrict
   * itself to what she has covered either. Without this, importing two thousand
   * real past questions would deal exactly zero of them until every section had
   * been opened.
   */
  allowUnstudiedPyq: boolean;
}

/**
 * Quarantine, stated once so both repositories implement the same rule.
 *
 * A question is quarantined while `disputedAt IS NOT NULL AND
 * disputeResolvedAt IS NULL`, and a quarantined question must appear in NO
 * selection tier and in NO inventory count. Pinned by an integration test
 * rather than shared as a query builder across ownership boundaries.
 */
export const QUARANTINE_RULE =
  'disputedAt IS NOT NULL AND disputeResolvedAt IS NULL' as const;
