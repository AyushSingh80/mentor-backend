/**
 * The order in which sections are recommended for a first pass.
 *
 * ## Why a declared order exists at all
 *
 * The decision engine is supposed to compute from data that already exists, and
 * it does — except on day one, when every section is 0% and every data-driven
 * rule degenerates to a tie-break. A tie-break produces a random-looking answer
 * at exactly the moment the app is being judged for the first time. So the
 * opening move is an opinion, written down where it can be read and argued
 * with, rather than an accident of `Array.sort` stability.
 *
 * This is local data. No network, no model.
 *
 * ## Two decisions encoded here, both deliberate
 *
 * **1. Polity and Modern History open, not Art and Culture.** The printed
 * syllabus starts GS1 at Indian Art and Culture, and following printed order
 * would open with the most memorisation-heavy, lowest-retention material in the
 * paper. Constitution and Modern History are structurally taught, reward
 * understanding over recall, and pay in Prelims and Mains both. Culture is
 * better done later, closer to when it will be revised.
 *
 * **2. Anthropology is interleaved from position three, never appended.** This
 * is the single most expensive thing this file could get wrong. The optional is
 * 500 of 2025 marks across two papers and 143 leaves — a quarter of the total
 * on a quarter of the syllabus. An order that lists all of GS before any
 * optional would spend eight months truthfully telling her to do GS, and she
 * would reach March 2027 with the optional untouched and no warning that it had
 * happened. Roughly one entry in four below is Anthropology, which is the share
 * the marks justify.
 *
 * ## What happens to sections not listed
 *
 * They sort AFTER every listed section, in printed syllabus order — which
 * `topicFacts()` already supplies via `position`. So this list is a head, not a
 * complete ordering, and a syllabus revision that adds a section cannot break
 * the algorithm. The new section simply ranks last, which is visible and
 * recoverable, rather than throwing or silently disappearing.
 *
 * ## Format
 *
 * `${paper}:${topic}`, matching `coverageBySection`'s key exactly. A test
 * asserts every entry resolves against `SYLLABUS_V1`, so a renamed section
 * fails a test rather than silently becoming an unlisted one.
 */
export const FIRST_PASS_ORDER: readonly string[] = [
  // --- The opening. Structural, high-yield, and it makes the rest legible. ---
  'gs2:Indian Constitution',
  'gs1:Modern Indian History',

  // Position three. The optional starts before GS is a third done, on purpose.
  'anthro_p1:Meaning, Scope and Development of Anthropology',

  'gs2:Federalism and Devolution',
  'gs3:Indian Economy',

  // P1's social-cultural core. Pairs with GS1 Indian Society, which is why they
  // sit near each other — the same material read twice from two angles.
  'anthro_p1:Culture and Society',

  'gs1:The Freedom Struggle',
  'gs2:Parliament and State Legislatures',

  // P2's largest block, and it feeds GS1 Social Issues and GS2 welfare directly.
  'anthro_p2:Tribal Situation in India',

  'gs3:Environment and Biodiversity',
  'gs1:Indian Society',
  'gs2:Executive and Judiciary',

  'anthro_p1:Anthropological Theories',

  'gs3:Agriculture',
  'gs2:Governance, Transparency and Accountability',
  'gs1:Social Issues',

  'anthro_p2:The Indian Village and Social Change',

  'gs3:Science and Technology',
  'gs2:India and its Neighbourhood',
  'gs4:Ethics and Human Interface',

  'anthro_p1:Family and Kinship',

  'gs3:Internal Security',
  'gs1:Post-Independence Consolidation',
  'gs2:Constitutional Bodies',

  'anthro_p2:Tribal Administration and Development',

  'gs4:Foundational Values for Civil Service',
  'gs3:Industry and Infrastructure',
  'gs1:Physical Geography of the World',

  'anthro_p1:Research Methods in Anthropology',

  'gs2:Welfare Schemes and Vulnerable Sections',
  'gs4:Probity in Governance',
  'gs1:Indian Art and Culture',
];
