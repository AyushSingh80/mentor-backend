/**
 * The DAF and the interview profile. FROZEN.
 *
 * Counterpart to `server/src/interview/types.ts`. Written before either side
 * and edited by neither, for the reason Phase 5's header sets out at length.
 *
 * ## What this feature actually is
 *
 * The Detailed Application Form is submitted with the Mains application — for
 * her, around August 2028 — and the Personality Test follows in early 2029.
 * Every field on it is fair game for the board, and that is the whole point:
 * the questions are PREDICTABLE two years in advance, from a form she has not
 * filled in yet.
 *
 * So the naive build — a form to complete in 2028 — would be useful for four
 * months and dead for two years. This is not that. It is a GAP TRACKER, the
 * same shape as the Phase 2 syllabus tracker, and it earns its place in 2026
 * because three of its fields are commitments about things she must ALREADY
 * have done:
 *
 * - **Hobbies.** A board will take any hobby to its floor in ninety seconds.
 *   Writing "reading" in July 2028 because there is nothing better is a
 *   decision made under deadline about two years she has already spent.
 *   Noticing the gap now leaves time to close it.
 * - **Employment.** She has a job right now, 2:30pm to 11:30pm. What she can
 *   say about it in an interview depends on what she NOTICES about it while
 *   doing it — not on what she reconstructs from memory in 2028.
 * - **Home district and state.** She cannot change these and can absolutely
 *   learn them. Most candidates cannot name their district's main crop, its
 *   literacy rate, or its live administrative dispute.
 *
 * ## The safety rule this phase rests on
 *
 * The server generates QUESTIONS and never answers. A fabricated question is,
 * at worst, one the board will not ask. A fabricated fact about her home
 * district — a literacy figure, a scheme name, a local dispute — is something
 * she would repeat to a board that knows better. Nothing on the server is ever
 * asked to state a fact about her life or her district.
 */

/* ------------------------------------------------------------------ fields */

/**
 * The DAF fields that generate interview questions.
 *
 * A subset of the real form: name and parentage are on it and are asked about
 * (the meaning of a name is a common opener), but community, category and
 * marital status are not things this app should hold, and nothing is lost by
 * omitting them — a board question about category is not one preparation helps
 * with.
 */
export const DAF_FIELDS = [
  'full_name',
  'home_town',
  'home_district',
  'home_state',
  'schooling',
  'graduation_subject',
  'university',
  'post_graduation',
  'achievements',
  'positions_held',
  'hobbies',
  'sports',
  'employment',
  'optional_subject',
  'service_preferences',
  'cadre_preferences',
] as const;

export type DafField = (typeof DAF_FIELDS)[number];

export function isDafField(value: unknown): value is DafField {
  return typeof value === 'string' && (DAF_FIELDS as readonly string[]).includes(value);
}

export type DafGroup = 'identity' | 'education' | 'record' | 'interests' | 'service';

export const GROUP_OF_FIELD: Readonly<Record<DafField, DafGroup>> = {
  full_name: 'identity',
  home_town: 'identity',
  home_district: 'identity',
  home_state: 'identity',
  schooling: 'education',
  graduation_subject: 'education',
  university: 'education',
  post_graduation: 'education',
  achievements: 'record',
  positions_held: 'record',
  hobbies: 'interests',
  sports: 'interests',
  employment: 'record',
  optional_subject: 'education',
  service_preferences: 'service',
  cadre_preferences: 'service',
};

export const GROUP_LABELS: Readonly<Record<DafGroup, string>> = {
  identity: 'Where you are from',
  education: 'What you studied',
  record: 'What you have done',
  interests: 'Hobbies and interests',
  service: 'Services and cadre',
};

/** The label shown above each input. */
export const FIELD_LABELS: Readonly<Record<DafField, string>> = {
  full_name: 'Full name',
  home_town: 'Home town',
  home_district: 'Home district',
  home_state: 'Home state',
  schooling: 'School and board',
  graduation_subject: 'Graduation subject',
  university: 'University or college',
  post_graduation: 'Post-graduation, if any',
  achievements: 'Prizes and achievements',
  positions_held: 'Positions of responsibility',
  hobbies: 'Hobbies',
  sports: 'Sports and extra-curriculars',
  employment: 'Employment',
  optional_subject: 'Optional subject',
  service_preferences: 'Service preferences',
  cadre_preferences: 'Cadre preferences',
};

/**
 * Why the board asks about each field, in her words.
 *
 * Shown under the input, because a form whose purpose is invisible gets filled
 * in carelessly — and carelessly here means a hobby she cannot defend.
 */
export const FIELD_RATIONALE: Readonly<Record<DafField, string>> = {
  full_name:
    'The meaning of a name is a common opener, and so is anything unusual about its spelling or origin.',
  home_town:
    'Expect its one claim to fame, its main occupation, and what you would change about it.',
  home_district:
    'The most reliably asked area on the whole form. Main crop, literacy, sex ratio, one live administrative issue.',
  home_state:
    'Its formation, its current political and administrative questions, and why a candidate from here would or would not want this cadre.',
  schooling: 'Board, medium of instruction, and why you switched streams if you did.',
  graduation_subject:
    'Fair game in full, however long ago. "You studied physics — what is entropy?" is a real question.',
  university: 'Its history, its notable alumni, and anything in the news about it.',
  post_graduation: 'Why you chose it, and why you left the field for the service.',
  achievements: 'Anything you list will be probed. A prize you cannot describe is worse than none.',
  positions_held:
    'What you actually did in the role, what went wrong, and what you would do differently.',
  hobbies:
    'A board will take any hobby to its floor in ninety seconds. Decide this early — it is the field you can still change.',
  sports: 'Rules, current players, and whether you still play.',
  employment:
    'What the job actually involves, what it taught you, and why you are leaving it. You are doing this job now — notice things about it while you can.',
  optional_subject: 'Why this optional, and its relevance to administration.',
  service_preferences: 'Why this order, and why not the ones above it.',
  cadre_preferences: 'Why this cadre, and what you know about it.',
};

/**
 * Fields worth deciding EARLY, and the reason each is on this list.
 *
 * These are the ones where the answer in 2028 is determined by what she does in
 * 2026 and 2027. Everything else on the form is a fact she will report; these
 * are commitments she is making now whether or not she notices.
 */
export const DECIDE_EARLY: readonly DafField[] = ['hobbies', 'sports', 'employment'];

/* -------------------------------------------------------------- preparation */

/**
 * How ready she is on one question area.
 *
 * Three states rather than a percentage, and the middle one is the important
 * one: notes made is NOT the same as being able to say it out loud under
 * pressure, and an interview is entirely the second thing. A single
 * "prepared" flag would let her mark the whole form done on the strength of
 * reading about it.
 */
export const PREP_STATES = ['not_started', 'notes_made', 'rehearsed'] as const;
export type PrepState = (typeof PREP_STATES)[number];

export function isPrepState(value: unknown): value is PrepState {
  return typeof value === 'string' && (PREP_STATES as readonly string[]).includes(value);
}

export const PREP_LABELS: Readonly<Record<PrepState, string>> = {
  not_started: 'Not started',
  notes_made: 'Notes made',
  rehearsed: 'Said out loud',
};

/**
 * How likely a board is to reach an area.
 *
 * Drives ordering, not scoring. `certain` areas — the home district, the
 * optional, why the service — come up in almost every interview, and an app
 * that ordered by "most questions generated" would bury them under whichever
 * field happened to produce the longest list.
 */
export const LIKELIHOODS = ['certain', 'likely', 'possible'] as const;
export type Likelihood = (typeof LIKELIHOODS)[number];

export function isLikelihood(value: unknown): value is Likelihood {
  return typeof value === 'string' && (LIKELIHOODS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------- facts */

export interface DafEntry {
  field: DafField;
  value: string;
  updatedAt: string | null;
}

export interface InterviewQuestion {
  id: number;
  /** The DAF field it came from. Null for a general question. */
  field: DafField | null;
  /** The area it belongs to — a short noun phrase, e.g. "District profile". */
  area: string;
  question: string;
  likelihood: Likelihood;
  /** Her own notes. Never generated — the server writes no answers. */
  notes: string | null;
  prep: PrepState;
  /** True when she has marked it as one she does not want to be asked. */
  flagged: boolean;
  createdAt: string;
}

export interface AreaReadiness {
  area: string;
  field: DafField | null;
  likelihood: Likelihood;
  total: number;
  rehearsed: number;
  notesMade: number;
  notStarted: number;
}

export const DAF_RULES = {
  /** Questions asked for per generation. One field's worth. */
  batchSize: 8,
  /** Below this, an area is worth flagging as a gap. */
  readyShare: 0.6,
  /**
   * Characters a single DAF value may run to.
   *
   * `MAX_VALUE_CHARS` in `server/src/interview/types.ts`, restated and enforced
   * on the INPUT. The server's bound is a safety limit on a request body; this
   * is the one that shapes behaviour, and it has to bite first — a limit that
   * fires only server-side is a 400 on an employment description she has
   * already typed, with no indication which field was too long.
   */
  maxValueChars: 600,
  /**
   * Words below which a DAF value is not really an answer.
   *
   * "Reading" is a hobby entry a board destroys; "Reading — mainly Indian
   * political history, currently Guha" is one she can defend. The gate is a
   * nudge on the form, never a refusal.
   */
  thinValueWords: 3,
} as const;
