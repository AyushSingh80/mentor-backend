/**
 * The UPSC Civil Services (Mains) syllabus, version 1.
 *
 * Reproduced from the official notification at leaf granularity: `topic` is the
 * section heading UPSC prints, `subtopic` is the bullet under it. That grouping
 * is not cosmetic — `coverageBySection` groups on `(paper, topic)`, and at ~430
 * leaves a section is the only unit small enough for one evening of work to
 * visibly move.
 *
 * ## Slugs
 *
 * Every slug is `<paper>-<section>-<leaf>`, kebab-case, and is the row's
 * permanent identity. Wording may be corrected freely; a slug may not. To
 * change one, add a `renames` entry — that is the only thing standing between a
 * typo fix and eighteen months of erased self-assessment. See `lib/syllabus-seed.ts`.
 *
 * ## Positions
 *
 * Assigned by `build()` rather than written by hand, so they are unique within
 * a paper and follow the printed order of the syllabus by construction. Inserting
 * a leaf renumbers everything after it, which is exactly why position is one of
 * the four fields a re-seed is allowed to rewrite.
 *
 * ## Essay
 *
 * UPSC publishes no Essay syllabus. The Essay sections below are thematic
 * clusters distilled from past papers, and every screen that shows Essay
 * coverage must say so — "Essay 40% covered" asserts something about an
 * official syllabus that does not exist, and she will plan against it.
 */

import type { PaperValue } from '@/lib/papers';
import type { SyllabusDataset, SyllabusRename, SyllabusSeedEntry } from '@/lib/syllabus-seed';

/** `[slug suffix, leaf text]`. The paper prefix and position are added by `build`. */
type Leaf = readonly [slug: string, subtopic: string | null];

interface Section {
  /** The printed section heading. The grouping key for section coverage. */
  readonly topic: string;
  readonly leaves: readonly Leaf[];
}

function build(paper: PaperValue, sections: readonly Section[]): SyllabusSeedEntry[] {
  const prefix = paper.replace(/_/g, '-');
  const entries: SyllabusSeedEntry[] = [];
  let position = 0;

  for (const section of sections) {
    for (const [slug, subtopic] of section.leaves) {
      entries.push({
        slug: `${prefix}-${slug}`,
        paper,
        topic: section.topic,
        subtopic,
        position: (position += 1),
      });
    }
  }

  return entries;
}

/* ------------------------------------------------------------------- GS1 --
 * Indian Heritage and Culture, History and Geography of the World and Society.
 */

/* ------------------------------------------------------------------- GS1 --
 * Indian Heritage and Culture, History and Geography of the World and Society.
 */

const GS1: readonly Section[] = [
  {
    topic: 'Indian Art and Culture',
    leaves: [
      ['culture-indus-and-early-art', 'Indus Valley and early Indian art'],
      ['culture-buddhist-and-jain-art', 'Buddhist and Jain art, stupas and cave architecture'],
      ['culture-temple-architecture', 'Temple architecture — Nagara, Dravida and Vesara'],
      ['culture-indo-islamic-architecture', 'Indo-Islamic and Mughal architecture'],
      ['culture-colonial-and-modern-architecture', 'Colonial and modern Indian architecture'],
      ['culture-sculpture-and-bronzes', 'Sculpture traditions and bronzes'],
      ['culture-painting-schools', 'Painting — murals, miniatures and folk schools'],
      ['culture-classical-dance', 'Classical dance forms'],
      ['culture-music-traditions', 'Hindustani and Carnatic music traditions'],
      ['culture-theatre-and-puppetry', 'Theatre, drama and puppetry'],
      ['culture-literature-and-languages', 'Literature — Sanskrit, Sangam, Pali, Prakrit and regional'],
      ['culture-philosophy-schools', 'Indian schools of philosophy, orthodox and heterodox'],
    ],
  },
  {
    topic: 'Modern Indian History',
    leaves: [
      ['modern-advent-of-europeans', 'Advent of the Europeans and the rise of British power'],
      ['modern-british-expansion', 'British expansion, annexations and subsidiary alliance'],
      ['modern-land-revenue-systems', 'Land revenue settlements and agrarian policy'],
      ['modern-economic-impact', 'Deindustrialisation, commercialisation and the drain of wealth'],
      ['modern-tribal-and-peasant-uprisings', 'Tribal and peasant uprisings before 1857'],
      ['modern-revolt-of-1857', 'The Revolt of 1857 — causes, course and consequences'],
      ['modern-socio-religious-reform', 'Socio-religious reform movements of the 19th century'],
      ['modern-administrative-structure', 'Education, the press and the evolution of British administrative structure'],
    ],
  },
  {
    topic: 'The Freedom Struggle',
    leaves: [
      ['freedom-early-nationalism', 'Early nationalism, the Congress, Moderates, Extremists and Home Rule'],
      ['freedom-swadeshi-movement', 'Partition of Bengal and the Swadeshi movement'],
      ['freedom-revolutionary-nationalism', 'Revolutionary nationalism at home and abroad'],
      ['freedom-gandhian-phase-begins', 'Gandhi’s early satyagrahas, Rowlatt and Jallianwala Bagh'],
      ['freedom-non-cooperation-and-khilafat', 'Non-Cooperation and Khilafat movements'],
      ['freedom-civil-disobedience', 'Civil Disobedience and the Round Table Conferences'],
      ['freedom-quit-india', 'Quit India movement and the 1942 upsurge'],
      ['freedom-ina-and-post-war-upsurge', 'INA, the naval mutiny and the post-war upsurge'],
      ['freedom-left-and-labour-movements', 'Left, peasant and working class movements'],
      ['freedom-social-justice-movements', 'Depressed classes, Ambedkar and social justice movements'],
      ['freedom-women-in-the-struggle', 'Role of women and women’s organisations in the struggle'],
      ['freedom-regional-contributions', 'Regional and princely state movements and their contributors'],
      ['freedom-reforms-and-partition', 'Constitutional reforms 1909–1935, Partition and the transfer of power'],
    ],
  },
  {
    topic: 'Post-Independence Consolidation',
    leaves: [
      ['postind-integration-of-states', 'Integration of the princely states'],
      ['postind-linguistic-reorganisation', 'Linguistic reorganisation of states'],
      ['postind-land-reforms-and-planning', 'Land reforms, planning and the mixed economy'],
      ['postind-north-east-and-tribal', 'North-East and tribal integration'],
      ['postind-foreign-policy-and-wars', 'Early foreign policy, wars and nuclear policy'],
      ['postind-emergency-and-regional-aspirations', 'The Emergency, coalition politics and regional accords'],
    ],
  },
  {
    topic: 'World History',
    leaves: [
      ['world-industrial-revolution', 'The Industrial Revolution and its social effects'],
      ['world-revolutions-and-nationalism', 'American and French Revolutions; nationalism and unification in Europe'],
      ['world-colonisation', 'Colonisation and imperialism in Asia and Africa'],
      ['world-war-one', 'First World War and the Versailles settlement'],
      ['world-russian-revolution', 'The Russian Revolution and the Soviet experiment'],
      ['world-depression-and-fascism', 'The Great Depression, fascism and Nazism'],
      ['world-war-two', 'Second World War and its aftermath'],
      ['world-decolonisation', 'Decolonisation and the redrawal of national boundaries'],
      ['world-cold-war', 'Cold War, non-alignment and the disintegration of the USSR'],
      ['world-political-philosophies', 'Communism, capitalism and socialism — forms and social effects'],
    ],
  },
  {
    topic: 'Indian Society',
    leaves: [
      ['society-salient-features', 'Salient features of Indian society'],
      ['society-diversity-of-india', 'Diversity of India — religious, linguistic, caste, tribal and regional'],
      ['society-unity-in-diversity', 'Unity in diversity and the strains upon it'],
      ['society-family-and-kinship', 'Family, marriage and kinship in transition'],
    ],
  },
  {
    topic: 'Social Issues',
    leaves: [
      ['social-role-of-women', 'Role of women and women’s organisations'],
      ['social-population-issues', 'Population and associated issues'],
      ['social-poverty-and-development', 'Poverty and developmental issues'],
      ['social-urbanisation', 'Urbanisation — problems and remedies'],
      ['social-globalisation-effects', 'Effects of globalisation on Indian society'],
      ['social-empowerment', 'Social empowerment'],
      ['social-communalism', 'Communalism'],
      ['social-regionalism', 'Regionalism'],
      ['social-secularism', 'Secularism'],
    ],
  },
  {
    topic: 'Physical Geography of the World',
    leaves: [
      ['geo-geomorphology', 'Earth’s interior, plate tectonics and rock systems'],
      ['geo-landforms', 'Landforms and the processes that shape them'],
      ['geo-atmosphere-pressure-and-winds', 'Atmosphere, insolation, heat budget, pressure belts, winds and jet streams'],
      ['geo-precipitation-and-climate-regions', 'Precipitation, climatic regions and the Indian monsoon'],
      ['geo-oceanography', 'Ocean currents, tides, salinity, ocean relief and coral reefs'],
      ['geo-soils-and-vegetation', 'Soils and natural vegetation of the world'],
    ],
  },
  {
    topic: 'Resource and Economic Geography',
    leaves: [
      ['resource-distribution-of-resources', 'Distribution of key natural resources and the world’s agricultural regions'],
      ['resource-india-minerals-and-energy', 'Mineral and energy resources of South Asia and India'],
      ['resource-primary-industry-location', 'Location factors for primary sector industries'],
      ['resource-secondary-and-tertiary-location', 'Location factors for secondary and tertiary sector industries'],
      ['resource-population-and-settlements', 'Population distribution, migration and settlement patterns'],
    ],
  },
  {
    topic: 'Geophysical Phenomena',
    leaves: [
      ['phenomena-earthquakes-and-tsunami', 'Earthquakes and tsunami'],
      ['phenomena-volcanic-activity', 'Volcanic activity'],
      ['phenomena-cyclones-and-hydro-hazards', 'Cyclones, floods, droughts and landslides'],
      ['phenomena-critical-feature-changes', 'Changes in critical water bodies, ice caps, flora and fauna'],
      ['phenomena-geographical-features', 'Important geographical features and their location'],
    ],
  },
];

/* ------------------------------------------------------------------- GS2 --
 * Governance, Constitution, Polity, Social Justice and International Relations.
 */

const GS2: readonly Section[] = [
  {
    topic: 'Indian Constitution',
    leaves: [
      ['constitution-historical-underpinnings', 'Historical underpinnings and the Constituent Assembly'],
      ['constitution-evolution-and-sources', 'Evolution and sources of the Constitution'],
      ['constitution-salient-features', 'Salient features, the Preamble, citizenship and the schedules'],
      ['constitution-fundamental-rights', 'Fundamental Rights and their enforcement'],
      ['constitution-dpsp-and-duties', 'Directive Principles and Fundamental Duties'],
      ['constitution-amendments', 'Amendment procedure and significant amendments'],
      ['constitution-basic-structure', 'Basic structure doctrine'],
      ['constitution-emergency-provisions', 'Emergency provisions'],
    ],
  },
  {
    topic: 'Federalism and Devolution',
    leaves: [
      ['federal-union-and-state-functions', 'Functions and responsibilities of the Union and the States'],
      ['federal-challenges', 'Issues and challenges pertaining to the federal structure'],
      ['federal-fiscal-devolution', 'Devolution of finances and the Finance Commission'],
      ['federal-local-government', 'Devolution of powers to local levels and challenges therein'],
      ['federal-interstate-relations', 'Inter-state relations, councils and disputes'],
    ],
  },
  {
    topic: 'Separation of Powers',
    leaves: [
      ['sop-doctrine', 'Separation of powers between the organs of state, and checks and balances'],
      ['sop-dispute-redressal', 'Dispute redressal mechanisms and institutions'],
      ['sop-judicial-review-and-activism', 'Judicial review, activism and overreach'],
    ],
  },
  {
    topic: 'Comparison of Constitutions',
    leaves: [
      ['comparative-with-other-countries', 'Comparison of the Indian constitutional scheme with other countries'],
      ['comparative-systems-and-federal-models', 'Parliamentary and presidential systems, and federal models compared'],
    ],
  },
  {
    topic: 'Parliament and State Legislatures',
    leaves: [
      ['legislature-structure', 'Structure of Parliament and the State legislatures'],
      ['legislature-functioning-and-business', 'Functioning and conduct of business'],
      ['legislature-committees', 'Parliamentary committees and financial control'],
      ['legislature-powers-and-privileges', 'Powers, privileges and immunities'],
      ['legislature-issues-arising', 'Issues arising — disruption, anti-defection and declining sittings'],
    ],
  },
  {
    topic: 'Executive and Judiciary',
    leaves: [
      ['exec-president-and-council', 'President, Governors and the Council of Ministers'],
      ['exec-ministries-and-departments', 'Structure and organisation of Ministries and Departments'],
      ['judiciary-structure-and-appointments', 'Supreme Court, High Courts, appointments and the collegium'],
      ['judiciary-functioning-and-pendency', 'Functioning of the judiciary, pendency and reform'],
      ['exec-pressure-groups', 'Pressure groups and formal and informal associations in the polity'],
    ],
  },
  {
    topic: 'Representation of People’s Act',
    leaves: [
      ['rpa-salient-features', 'Salient features of the Representation of People’s Act'],
      ['rpa-electoral-reforms', 'Electoral reforms, disqualification and criminalisation of politics'],
      ['rpa-party-funding', 'Political party funding and transparency'],
    ],
  },
  {
    topic: 'Constitutional Bodies',
    leaves: [
      ['cbody-appointments', 'Appointment to constitutional posts, including the law officers'],
      ['cbody-election-commission', 'Election Commission of India'],
      ['cbody-upsc-and-spsc', 'UPSC and State Public Service Commissions'],
      ['cbody-cag', 'Comptroller and Auditor General'],
      ['cbody-finance-commission', 'Finance Commission'],
      ['cbody-scst-and-backward-classes', 'Commissions for SCs, STs and Backward Classes'],
    ],
  },
  {
    topic: 'Statutory and Regulatory Bodies',
    leaves: [
      ['sbody-statutory', 'Statutory bodies — NHRC, NCW, Lokpal and others'],
      ['sbody-regulatory', 'Regulatory bodies — RBI, SEBI, TRAI, CCI and sectoral regulators'],
      ['sbody-quasi-judicial', 'Quasi-judicial bodies and tribunals'],
    ],
  },
  {
    topic: 'Government Policies and Interventions',
    leaves: [
      ['policy-design-and-implementation', 'Policies for development and issues in their design'],
      ['policy-implementation-and-evaluation', 'Implementation gaps, last-mile delivery and outcome evaluation'],
    ],
  },
  {
    topic: 'Development Processes and the Development Industry',
    leaves: [
      ['devproc-ngos', 'Role of NGOs and the regulation of foreign funding'],
      ['devproc-shgs-and-cbos', 'Self-help groups and community-based organisations'],
      ['devproc-donors-and-stakeholders', 'Donors, charities, institutional stakeholders and their accountability'],
    ],
  },
  {
    topic: 'Welfare Schemes and Vulnerable Sections',
    leaves: [
      ['welfare-scheduled-castes-and-tribes', 'Welfare of Scheduled Castes and Scheduled Tribes'],
      ['welfare-women-and-children', 'Welfare of women and children'],
      ['welfare-elderly-disabled-and-minorities', 'Welfare of the elderly, persons with disabilities and minorities'],
      ['welfare-scheme-performance', 'Performance of welfare schemes and leakages'],
      ['welfare-protective-laws-and-bodies', 'Laws, institutions and bodies protecting vulnerable sections'],
    ],
  },
  {
    topic: 'Social Sector and Services',
    leaves: [
      ['social-sector-health', 'Development and management of health services'],
      ['social-sector-education', 'Development and management of education'],
      ['social-sector-human-resources', 'Human resources, skilling and employment services'],
      ['social-sector-poverty-and-hunger', 'Poverty, hunger, nutrition and food security'],
    ],
  },
  {
    topic: 'Governance, Transparency and Accountability',
    leaves: [
      ['gov-important-aspects', 'Important aspects of governance'],
      ['gov-transparency-and-rti', 'Transparency, accountability and the Right to Information'],
      ['gov-e-governance', 'E-governance — applications, models, successes and limitations'],
      ['gov-citizens-charters', 'Citizens’ charters and service delivery standards'],
      ['gov-institutional-measures', 'Institutional and other measures against corruption'],
      ['gov-civil-services', 'Role of civil services in a democracy, and civil services reform'],
    ],
  },
  {
    topic: 'India and its Neighbourhood',
    leaves: [
      ['ir-neighbourhood-first', 'India’s neighbourhood policy and its evolution'],
      ['ir-pakistan', 'India and Pakistan'],
      ['ir-china', 'India and China — border, trade and strategic competition'],
      ['ir-nepal-bhutan', 'India, Nepal and Bhutan'],
      ['ir-bangladesh-myanmar', 'India, Bangladesh and Myanmar'],
      ['ir-sri-lanka-and-indian-ocean', 'Sri Lanka, the Maldives and the Indian Ocean Region'],
      ['ir-afghanistan-and-central-asia', 'India, Afghanistan and Central Asia'],
    ],
  },
  {
    topic: 'Groupings and Agreements',
    leaves: [
      ['ir-bilateral-agreements', 'Bilateral agreements involving India'],
      ['ir-regional-groupings', 'Regional groupings — SAARC, BIMSTEC, ASEAN and IORA'],
      ['ir-global-groupings', 'Global groupings — G20, BRICS, SCO and the Quad'],
      ['ir-trade-agreements', 'Trade agreements and India’s negotiating position'],
    ],
  },
  {
    topic: 'Global Policies and the Diaspora',
    leaves: [
      ['ir-developed-country-policies', 'Effect of policies of developed countries on India’s interests'],
      ['ir-developing-country-politics', 'Politics of developing countries and South-South cooperation'],
      ['ir-indian-diaspora', 'Indian diaspora — profile, remittances and policy'],
    ],
  },
  {
    topic: 'International Institutions',
    leaves: [
      ['ir-united-nations', 'United Nations, its organs and Security Council reform'],
      ['ir-bretton-woods', 'World Bank, IMF and multilateral development banks'],
      ['ir-wto', 'World Trade Organization — structure and mandate'],
      ['ir-other-agencies-and-fora', 'WHO, ILO, UNESCO, treaty bodies and other fora'],
    ],
  },
];

/* ------------------------------------------------------------------- GS3 --
 * Technology, Economic Development, Bio-diversity, Environment, Security and
 * Disaster Management.
 */

const GS3: readonly Section[] = [
  {
    topic: 'Indian Economy',
    leaves: [
      ['econ-planning-and-niti', 'Planning, from the Five Year Plans to NITI Aayog'],
      ['econ-mobilisation-of-resources', 'Mobilisation of resources — savings, taxation and borrowing'],
      ['econ-growth-and-development', 'Growth and development, and the difference between them'],
      ['econ-employment', 'Employment, unemployment and the informal sector'],
      ['econ-inclusive-growth', 'Inclusive growth and issues arising from it'],
      ['econ-money-and-banking', 'Money, banking, NPAs and financial inclusion'],
      ['econ-inflation-and-monetary-policy', 'Inflation and monetary policy'],
      ['econ-external-sector', 'External sector — balance of payments, FDI and exchange rate'],
    ],
  },
  {
    topic: 'Government Budgeting',
    leaves: [
      ['budget-structure-and-process', 'Structure of the budget and the budgetary process'],
      ['budget-deficits-and-fiscal-policy', 'Deficits, FRBM and fiscal policy'],
      ['budget-gst-and-tax-reform', 'GST and tax reform'],
      ['budget-subsidies-and-expenditure', 'Subsidies, expenditure quality and public debt'],
    ],
  },
  {
    topic: 'Agriculture',
    leaves: [
      ['agri-major-crops-and-cropping-patterns', 'Major crops and cropping patterns across the country'],
      ['agri-irrigation-systems', 'Types of irrigation and irrigation systems'],
      ['agri-storage-transport-and-marketing', 'Storage, transport and marketing of produce, and their constraints'],
      ['agri-e-technology-for-farmers', 'E-technology in the aid of farmers'],
      ['agri-subsidies-and-msp', 'Direct and indirect farm subsidies and minimum support prices'],
      ['agri-pds', 'Public Distribution System — objectives, functioning and revamping'],
      ['agri-buffer-stocks-and-food-security', 'Buffer stocks and food security'],
      ['agri-technology-missions', 'Technology missions in agriculture'],
      ['agri-animal-rearing', 'Economics of animal rearing, dairy and fisheries'],
      ['agri-land-reforms', 'Land reforms in India'],
      ['agri-cropping-sustainability', 'Soil health, cropping sustainability and natural farming'],
    ],
  },
  {
    topic: 'Food Processing',
    leaves: [
      ['food-scope-and-significance', 'Food processing — scope and significance in India'],
      ['food-location-factors', 'Location of food processing industries'],
      ['food-supply-chain', 'Upstream and downstream requirements and supply chain management'],
    ],
  },
  {
    topic: 'Industry and Infrastructure',
    leaves: [
      ['industry-liberalisation-effects', 'Effects of liberalisation on the economy'],
      ['industry-policy-changes', 'Changes in industrial policy and their effects on industrial growth'],
      ['industry-msmes', 'MSMEs, manufacturing competitiveness and industrial corridors'],
      ['infra-energy', 'Energy infrastructure and the transition to renewables'],
      ['infra-transport', 'Roads, railways, ports and airports'],
      ['infra-urban-and-digital', 'Urban and digital infrastructure'],
      ['infra-investment-models', 'Investment models — PPP, hybrid annuity and asset monetisation'],
    ],
  },
  {
    topic: 'Science and Technology',
    leaves: [
      ['st-developments-and-everyday-life', 'Developments in science and technology and their everyday applications'],
      ['st-indian-achievements', 'Achievements of Indians in science and technology'],
      ['st-indigenisation', 'Indigenisation of technology and developing new technology'],
      ['st-space', 'Space technology and India’s space programme'],
      ['st-nuclear-and-defence-technology', 'Nuclear and defence technology'],
      ['st-it-and-computers', 'IT, computers and emerging digital technologies'],
      ['st-robotics-and-ai', 'Robotics, artificial intelligence and automation'],
      ['st-nanotechnology', 'Nanotechnology and new materials'],
      ['st-biotechnology', 'Biotechnology, health technology and pharmaceuticals'],
      ['st-ipr', 'Intellectual property rights and their issues'],
    ],
  },
  {
    topic: 'Environment and Biodiversity',
    leaves: [
      ['env-ecology-basics', 'Ecosystems, ecological succession and food chains'],
      ['env-biodiversity', 'Biodiversity — levels, hotspots and loss'],
      ['env-conservation-efforts', 'Conservation — protected areas, species programmes and community conservation'],
      ['env-pollution-and-degradation', 'Pollution, environmental degradation and desertification'],
      ['env-impact-assessment', 'Environmental impact assessment'],
      ['env-laws-and-institutions', 'Environmental laws, institutions and the National Green Tribunal'],
      ['env-climate-change', 'Climate change — science, impacts and mitigation'],
      ['env-international-agreements', 'International environmental agreements and India’s commitments'],
      ['env-sustainable-development', 'Sustainable development and the SDGs'],
    ],
  },
  {
    topic: 'Disaster Management',
    leaves: [
      ['disaster-types-and-vulnerability', 'Types of disasters and India’s vulnerability profile'],
      ['disaster-institutional-framework', 'Institutional and legal framework — NDMA, SDMA and the DM Act'],
      ['disaster-mitigation-and-preparedness', 'Mitigation, preparedness and early warning'],
      ['disaster-response-and-relief', 'Response, relief and rehabilitation'],
      ['disaster-international-frameworks', 'Sendai Framework and international cooperation'],
    ],
  },
  {
    topic: 'Internal Security',
    leaves: [
      ['sec-development-and-extremism', 'Linkages between development and the spread of extremism'],
      ['sec-left-wing-extremism', 'Left wing extremism'],
      ['sec-insurgency-in-the-north-east', 'Insurgency in the North-East and in Jammu and Kashmir'],
      ['sec-external-state-actors', 'Role of external state actors in creating internal security challenges'],
      ['sec-non-state-actors', 'Role of non-state actors and terrorism'],
      ['sec-communication-networks-and-media', 'Communication networks, media and social networking as security challenges'],
      ['sec-cyber-security', 'Basics of cyber security and critical information infrastructure'],
      ['sec-money-laundering', 'Money laundering and its prevention'],
      ['sec-border-management', 'Security challenges and management in border areas'],
      ['sec-organised-crime', 'Linkages of organised crime with terrorism'],
      ['sec-forces-and-agencies', 'Security forces and agencies and their mandate'],
    ],
  },
];

/* ------------------------------------------------------------------- GS4 --
 * Ethics, Integrity and Aptitude.
 */

const GS4: readonly Section[] = [
  {
    topic: 'Ethics and Human Interface',
    leaves: [
      ['ethics-essence-and-determinants', 'Essence, determinants and consequences of ethics in human actions'],
      ['ethics-dimensions', 'Dimensions of ethics'],
      ['ethics-private-and-public-relationships', 'Ethics in private and public relationships'],
      ['ethics-human-values', 'Human values and lessons from great leaders, reformers and administrators'],
      ['ethics-role-of-family-and-society', 'Role of family, society and educational institutions in inculcating values'],
    ],
  },
  {
    topic: 'Attitude',
    leaves: [
      ['attitude-content-structure-function', 'Attitude — content, structure and function'],
      ['attitude-thought-and-behaviour', 'Influence of attitude and its relation with thought and behaviour'],
      ['attitude-moral-and-political', 'Moral and political attitudes'],
      ['attitude-social-influence-and-persuasion', 'Social influence and persuasion'],
    ],
  },
  {
    topic: 'Foundational Values for Civil Service',
    leaves: [
      ['values-aptitude', 'Aptitude and foundational values for civil service'],
      ['values-integrity', 'Integrity'],
      ['values-impartiality-and-non-partisanship', 'Impartiality and non-partisanship'],
      ['values-objectivity', 'Objectivity'],
      ['values-dedication-to-public-service', 'Dedication to public service'],
      ['values-empathy-tolerance-compassion', 'Empathy, tolerance and compassion towards the weaker sections'],
    ],
  },
  {
    topic: 'Emotional Intelligence',
    leaves: [
      ['ei-concepts', 'Emotional intelligence — concepts and models'],
      ['ei-utility-and-application', 'Utilities and application in administration and governance'],
    ],
  },
  {
    topic: 'Moral Thinkers and Philosophers',
    leaves: [
      ['thinkers-indian', 'Contributions of moral thinkers and philosophers from India'],
      ['thinkers-western', 'Contributions of moral thinkers and philosophers from the world'],
      ['thinkers-ethical-theories', 'Major ethical theories — deontology, consequentialism and virtue ethics'],
    ],
  },
  {
    topic: 'Public Service Values and Ethics in Public Administration',
    leaves: [
      ['pubadmin-status-and-problems', 'Status and problems of public and civil service values'],
      ['pubadmin-ethical-dilemmas', 'Ethical concerns and dilemmas in government and private institutions'],
      ['pubadmin-sources-of-guidance', 'Laws, rules, regulations and conscience as sources of ethical guidance'],
      ['pubadmin-accountability', 'Accountability and ethical governance'],
      ['pubadmin-strengthening-values', 'Strengthening of ethical and moral values in governance'],
      ['pubadmin-international-relations-and-funding', 'Ethical issues in international relations and funding'],
      ['pubadmin-corporate-governance', 'Corporate governance'],
    ],
  },
  {
    topic: 'Probity in Governance',
    leaves: [
      ['probity-concept-of-public-service', 'Concept of public service'],
      ['probity-philosophical-basis', 'Philosophical basis of governance and probity'],
      ['probity-information-sharing-and-rti', 'Information sharing, transparency and the Right to Information'],
      ['probity-codes-of-ethics-and-conduct', 'Codes of ethics and codes of conduct'],
      ['probity-work-culture-and-charters', 'Citizens’ charters, work culture and quality of service delivery'],
      ['probity-utilisation-of-public-funds', 'Utilisation of public funds'],
      ['probity-challenges-of-corruption', 'Challenges of corruption'],
    ],
  },
  {
    topic: 'Case Studies',
    leaves: [
      ['case-structure-and-approach', 'Structure of a case study answer and the approach to it'],
      ['case-administrative-dilemmas', 'Administrative dilemmas — pressure, discretion and whistleblowing'],
      ['case-social-and-development', 'Social and development dilemmas'],
      ['case-corporate-environmental-and-crisis', 'Corporate, environmental and crisis situations'],
    ],
  },
];

/* ----------------------------------------------------------------- ESSAY --
 * UPSC publishes NO syllabus for the Essay paper. What follows are thematic
 * clusters distilled from past papers — a study scaffold, not an official list.
 * Any screen reporting Essay coverage must say so; a percentage measured
 * against an invented syllabus is a number she would plan eighteen months on.
 */

const ESSAY: readonly Section[] = [
  {
    topic: 'Philosophical and Abstract Prompts',
    leaves: [
      ['philos-quotation-essays', 'Quotation and aphorism prompts'],
      ['philos-paradox-and-duality', 'Paradox and duality prompts'],
      ['philos-time-change-and-progress', 'Time, change and the idea of progress'],
    ],
  },
  {
    topic: 'Education and Knowledge',
    leaves: [
      ['edu-purpose-of-education', 'Purpose and philosophy of education'],
      ['edu-access-and-equity', 'Access, equity and the quality of schooling'],
      ['edu-knowledge-and-wisdom', 'Knowledge, information and wisdom'],
    ],
  },
  {
    topic: 'Women, Gender and Society',
    leaves: [
      ['gender-womens-agency', 'Women’s agency, work and representation'],
      ['gender-patriarchy-and-law', 'Patriarchy, law and social change'],
      ['gender-family-and-changing-roles', 'Family, changing roles and the care economy'],
    ],
  },
  {
    topic: 'Economy, Growth and Livelihoods',
    leaves: [
      ['econ-growth-and-distribution', 'Growth, distribution and the safety net'],
      ['econ-work-and-automation', 'Work, livelihoods and automation'],
      ['econ-agriculture-and-rural-life', 'Agriculture, rural life and migration'],
    ],
  },
  {
    topic: 'Science, Technology and the Digital Age',
    leaves: [
      ['tech-science-and-society', 'Science, scepticism and society'],
      ['tech-digital-life', 'Digital life, attention and privacy'],
      ['tech-ai-and-the-human', 'Artificial intelligence and what remains human'],
    ],
  },
  {
    topic: 'Environment and Sustainability',
    leaves: [
      ['envt-development-and-ecology', 'Development against ecology'],
      ['envt-climate-and-responsibility', 'Climate change and intergenerational responsibility'],
      ['envt-consumption-and-lifestyle', 'Consumption, lifestyle and sufficiency'],
    ],
  },
  {
    topic: 'Governance, Democracy and Institutions',
    leaves: [
      ['gov-democracy-and-dissent', 'Democracy, dissent and the citizen'],
      ['gov-institutions-and-justice', 'Institutions, trust, accountability and justice'],
      ['gov-federalism-and-diversity', 'Federalism, diversity and the idea of India'],
    ],
  },
  {
    topic: 'India and the World',
    leaves: [
      ['world-globalisation-and-identity', 'Globalisation, identity and the nation'],
      ['world-power-and-cooperation', 'Power, conflict and international cooperation'],
      ['world-soft-power-and-culture', 'Soft power, culture and the diaspora'],
    ],
  },
  {
    topic: 'Ethics, Values and the Individual',
    leaves: [
      ['ethics-character-and-conduct', 'Character, conduct and moral courage'],
      ['ethics-success-and-failure', 'Success, failure and ambition'],
      ['ethics-freedom-and-responsibility', 'Freedom and responsibility'],
    ],
  },
  {
    topic: 'Social Justice and Inequality',
    leaves: [
      ['justice-caste-and-exclusion', 'Caste, exclusion and affirmative action'],
      ['justice-inequality-and-opportunity', 'Inequality and equality of opportunity'],
      ['justice-youth-and-demography', 'Youth, demography and aspiration'],
    ],
  },
  {
    topic: 'Culture, Media and Health',
    leaves: [
      ['culture-media-and-narrative', 'Media, narrative and public opinion'],
      ['culture-tradition-and-modernity', 'Tradition, modernity and cultural continuity'],
      ['culture-health-and-wellbeing', 'Health, mental wellbeing and the good life'],
    ],
  },
];

/* -------------------------------------------------------- ANTHROPOLOGY I --
 * Optional Paper 1. Sections follow the numbered heads of the official syllabus.
 */

const ANTHRO_P1: readonly Section[] = [
  {
    topic: 'Meaning, Scope and Development of Anthropology',
    leaves: [
      ['intro-meaning-and-scope', 'Meaning, scope and development of anthropology'],
      ['intro-relations-with-other-disciplines', 'Relationships with social, behavioural, life, medical and earth sciences'],
      ['intro-branch-social-and-biological', 'Social-cultural and biological anthropology — scope and relevance'],
      ['intro-branch-archaeological-and-linguistic', 'Archaeological and linguistic anthropology — scope and relevance'],
    ],
  },
  {
    topic: 'Human Evolution and the Emergence of Man',
    leaves: [
      ['evol-biological-and-cultural-factors', 'Biological and cultural factors in human evolution'],
      ['evol-theories-of-organic-evolution', 'Theories of organic evolution — pre-Darwinian, Darwinian and post-Darwinian'],
      ['evol-synthetic-theory', 'Synthetic theory of evolution'],
      ['evol-concepts-of-evolutionary-biology', 'Dollo’s, Cope’s and Gause’s rules, parallelism, convergence, adaptive radiation and mosaic evolution'],
    ],
  },
  {
    topic: 'Primates',
    leaves: [
      ['primate-characteristics-and-taxonomy', 'Characteristics of primates, evolutionary trend and taxonomy'],
      ['primate-adaptations-and-behaviour', 'Primate adaptations — arboreal and terrestrial — and primate behaviour'],
      ['primate-fossil-and-living-primates', 'Tertiary and Quaternary fossil primates and living major primates'],
      ['primate-anatomy-and-erect-posture', 'Comparative anatomy of man and apes; skeletal changes due to erect posture'],
    ],
  },
  {
    topic: 'Fossil Hominids',
    leaves: [
      ['fossil-australopithecines', 'Plio-Pleistocene hominids of South and East Africa — Australopithecines'],
      ['fossil-homo-erectus', 'Homo erectus in Africa, Europe and Asia, and Paranthropus'],
      ['fossil-neanderthal-and-rhodesian', 'Neanderthal man — classical and progressive types — and Rhodesian man'],
      ['fossil-homo-sapiens', 'Homo sapiens — Cromagnon, Grimaldi and Chancelade'],
    ],
  },
  {
    topic: 'Biological Basis of Life',
    leaves: [
      ['bio-cell-and-cell-division', 'The cell and cell division'],
      ['bio-dna-structure-and-replication', 'DNA structure and replication'],
      ['bio-protein-synthesis', 'Protein synthesis'],
      ['bio-gene-mutation-and-chromosomes', 'Gene, mutation and chromosomes'],
    ],
  },
  {
    topic: 'Prehistoric Archaeology',
    leaves: [
      ['prehist-principles-and-dating', 'Principles of prehistoric archaeology; relative and absolute dating'],
      ['prehist-palaeolithic-and-mesolithic', 'Palaeolithic and Mesolithic cultures'],
      ['prehist-neolithic', 'Neolithic cultures'],
      ['prehist-metal-ages', 'Chalcolithic, Copper-Bronze and Iron ages'],
    ],
  },
  {
    topic: 'Culture and Society',
    leaves: [
      ['cult-concept-of-culture', 'Concept and characteristics of culture and civilization'],
      ['cult-ethnocentrism-and-relativism', 'Ethnocentrism against cultural relativism'],
      ['cult-concept-of-society', 'Concept of society; society and culture'],
      ['cult-institutions-groups-and-stratification', 'Social institutions, social groups and social stratification'],
    ],
  },
  {
    topic: 'Marriage',
    leaves: [
      ['marriage-definition-and-functions', 'Definition, universality and functions of marriage'],
      ['marriage-laws-and-regulations', 'Laws of marriage and marriage regulations — preferential, prescriptive and proscriptive'],
      ['marriage-types', 'Types of marriage — monogamy, polygamy, polyandry and group marriage'],
      ['marriage-payments', 'Marriage payments — bride wealth and dowry'],
    ],
  },
  {
    topic: 'Family and Kinship',
    leaves: [
      ['family-definition-and-household', 'Definition and universality of the family; household and domestic groups'],
      ['family-functions-and-types', 'Functions and types of family'],
      ['family-impact-of-change', 'Impact of urbanization, industrialization and feminist movements on the family'],
      ['kinship-consanguinity-and-affinity', 'Consanguinity and affinity'],
      ['kinship-descent-principles-and-groups', 'Principles and types of descent; lineage, clan, phratry, moiety and kindred'],
      ['kinship-terminology-and-alliance', 'Kinship terminology; descent, filiation and alliance'],
    ],
  },
  {
    topic: 'Economic Organization',
    leaves: [
      ['econ-scope-of-economic-anthropology', 'Meaning, scope and relevance of economic anthropology'],
      ['econ-formalist-substantivist-debate', 'Formalist and substantivist debate'],
      ['econ-production-distribution-exchange', 'Reciprocity, redistribution and market exchange'],
      ['econ-subsistence-and-globalisation', 'Subsistence types, and globalization against indigenous economic systems'],
    ],
  },
  {
    topic: 'Political Organization and Social Control',
    leaves: [
      ['pol-band-tribe-chiefdom-state', 'Band, tribe, chiefdom, kingdom and state'],
      ['pol-power-authority-legitimacy', 'Concepts of power, authority and legitimacy'],
      ['pol-social-control-law-justice', 'Social control, law and justice in simple societies'],
    ],
  },
  {
    topic: 'Religion',
    leaves: [
      ['rel-anthropological-approaches', 'Evolutionary, psychological and functional approaches to religion'],
      ['rel-sacred-profane-myth-ritual', 'Monism, polytheism and monotheism; sacred and profane; myths and rituals'],
      ['rel-forms-in-tribal-societies', 'Animism, animatism, fetishism, naturism and totemism'],
      ['rel-magic-science-and-functionaries', 'Religion, magic and science distinguished; priest, shaman, sorcerer and witch'],
    ],
  },
  {
    topic: 'Anthropological Theories',
    leaves: [
      ['theory-classical-evolutionism', 'Classical evolutionism — Tylor, Morgan and Frazer'],
      ['theory-particularism-and-diffusionism', 'Historical particularism (Boas) and diffusionism'],
      ['theory-functionalism', 'Functionalism (Malinowski) and structural functionalism (Radcliffe-Brown)'],
      ['theory-structuralism', 'Structuralism — Levi-Strauss and Leach'],
      ['theory-culture-and-personality', 'Culture and personality — Benedict, Mead, Linton, Kardiner and Du Bois'],
      ['theory-neo-evolutionism', 'Neo-evolutionism (Childe, White, Steward, Sahlins, Service) and cultural materialism (Harris)'],
      ['theory-symbolic-and-interpretive', 'Symbolic and interpretive theories — Turner, Schneider and Geertz'],
      ['theory-cognitive-and-post-modernism', 'Cognitive theories and post-modernism in anthropology'],
    ],
  },
  {
    topic: 'Culture, Language and Communication',
    leaves: [
      ['lang-nature-and-origin', 'Nature, origin and characteristics of language'],
      ['lang-communication-and-social-context', 'Verbal and non-verbal communication, and the social context of language use'],
    ],
  },
  {
    topic: 'Research Methods in Anthropology',
    leaves: [
      ['method-fieldwork-tradition', 'Fieldwork tradition in anthropology'],
      ['method-technique-method-methodology', 'Distinction between technique, method and methodology'],
      ['method-observation-interview-and-schedules', 'Observation, interview, schedules and questionnaires'],
      ['method-case-study-and-life-history', 'Case study, genealogy, life history, secondary sources and participatory methods'],
      ['method-analysis-and-presentation', 'Analysis, interpretation and presentation of data'],
    ],
  },
  {
    topic: 'Human Genetics',
    leaves: [
      ['genet-family-and-twin-study', 'Family study — pedigree analysis, twin, foster child and co-twin methods'],
      ['genet-cytogenetic-and-biochemical', 'Cytogenetic, karyotype, biochemical and immunological methods'],
      ['genet-dna-and-recombinant-technology', 'DNA technology and recombinant technologies'],
      ['genet-mendelian-and-polygenic', 'Mendelian, lethal, sub-lethal and polygenic inheritance in man'],
    ],
  },
  {
    topic: 'Chromosomal Aberrations and Genetic Disorders',
    leaves: [
      ['chrom-methodology-and-aberrations', 'Chromosomal aberrations in man — methodology, numerical and structural disorders'],
      ['chrom-sex-chromosomal-aberrations', 'Klinefelter, Turner, super female and intersex conditions'],
      ['chrom-autosomal-aberrations', 'Down, Patau, Edward and Cri-du-chat syndromes'],
      ['chrom-screening-counselling-and-profiling', 'Genetic screening, counselling, DNA profiling, gene mapping and genome study'],
    ],
  },
  {
    topic: 'Human Variation and Race',
    leaves: [
      ['var-race-and-racism', 'Race and racism'],
      ['var-racial-criteria-and-classification', 'Morphological variation, racial criteria, classification and race crossing'],
      ['var-genetic-markers', 'ABO, Rh, HLA, Hp, transferrin, Gm and blood enzymes as genetic markers'],
      ['var-physiological-characteristics', 'Haemoglobin, body fat, pulse rate, respiratory function and sensory perception'],
    ],
  },
  {
    topic: 'Ecological and Epidemiological Anthropology',
    leaves: [
      ['eco-concepts-and-methods', 'Concepts and methods of ecological anthropology'],
      ['eco-bio-cultural-adaptations', 'Bio-cultural adaptations — genetic and non-genetic factors'],
      ['eco-responses-to-environmental-stress', 'Responses to hot desert, cold and high altitude stress'],
      ['epi-health-and-disease', 'Health and disease; infectious, non-infectious and deficiency diseases'],
    ],
  },
  {
    topic: 'Human Growth, Development and Demography',
    leaves: [
      ['growth-stages-and-factors', 'Stages of growth from prenatal to senescence, and the factors affecting them'],
      ['growth-ageing-and-longevity', 'Ageing, senescence and biological against chronological longevity'],
      ['growth-physique-and-methodologies', 'Human physique, somatotypes and methodologies for growth studies'],
      ['demo-bioevents-and-fertility', 'Menarche, menopause and other bioevents; fertility patterns and differentials'],
      ['demo-theories-and-determinants', 'Demographic theories and the determinants of fertility, natality and mortality'],
    ],
  },
  {
    topic: 'Applications of Anthropology',
    leaves: [
      ['appl-sports-and-nutritional', 'Anthropology of sports and nutritional anthropology'],
      ['appl-ergonomics-and-defence', 'Anthropology in the design of defence and other equipment'],
      ['appl-forensic-anthropology', 'Forensic anthropology and personal identification'],
      ['appl-genetics-in-medicine', 'Paternity diagnosis, genetic counselling, eugenics and DNA technology in medicine'],
    ],
  },
];

/* ------------------------------------------------------- ANTHROPOLOGY II --
 * Optional Paper 2 — Indian anthropology.
 */

const ANTHRO_P2: readonly Section[] = [
  {
    topic: 'Evolution of Indian Culture and Civilization',
    leaves: [
      ['ind-prehistoric-cultures', 'Prehistoric India — Palaeolithic, Mesolithic, Neolithic and Neolithic-Chalcolithic'],
      ['ind-protohistoric-indus', 'Protohistoric India — the Indus civilization'],
      ['ind-pre-and-post-harappan', 'Pre-Harappan, Harappan and post-Harappan cultures'],
      ['ind-tribal-contributions', 'Contributions of tribal cultures to Indian civilization'],
      ['ind-palaeoanthropological-evidence', 'Siwaliks and the Narmada basin — Ramapithecus, Sivapithecus and Narmada man'],
      ['ind-ethno-archaeology', 'Ethno-archaeology in India — survivals and parallels among Indian communities'],
    ],
  },
  {
    topic: 'Demographic Profile of India',
    leaves: [
      ['demo-ethnic-elements', 'Ethnic elements in the Indian population and their distribution'],
      ['demo-linguistic-elements', 'Linguistic elements in the Indian population and their distribution'],
      ['demo-structure-and-growth', 'Factors influencing the structure and growth of the Indian population'],
    ],
  },
  {
    topic: 'Traditional Indian Social System',
    leaves: [
      ['trad-varnashram', 'Varnashram'],
      ['trad-purushartha-karma-rina-rebirth', 'Purushartha, Karma, Rina and Rebirth'],
      ['caste-structure-and-characteristics', 'Caste system — structure and characteristics; varna and caste'],
      ['caste-theories-of-origin', 'Theories of the origin of the caste system'],
      ['caste-dominant-caste-and-mobility', 'Dominant caste, caste mobility and the future of the caste system'],
      ['caste-jajmani-system', 'Jajmani system'],
      ['caste-tribe-caste-continuum', 'Tribe-caste continuum'],
      ['trad-sacred-complex', 'Sacred complex and the nature-man-spirit complex'],
      ['trad-impact-of-religions', 'Impact of Buddhism, Jainism, Islam and Christianity on Indian society'],
    ],
  },
  {
    topic: 'Emergence and Growth of Anthropology in India',
    leaves: [
      ['hist-scholar-administrators', 'Contributions of 18th, 19th and early 20th century scholar-administrators'],
      ['hist-indian-anthropologists', 'Contributions of Indian anthropologists to tribal and caste studies'],
    ],
  },
  {
    topic: 'The Indian Village and Social Change',
    leaves: [
      ['vill-significance-of-village-study', 'Significance of village study in India'],
      ['vill-village-as-social-system', 'The Indian village as a social system'],
      ['vill-settlement-and-agrarian-relations', 'Settlement patterns, inter-caste and agrarian relations'],
      ['vill-impact-of-globalisation', 'Impact of globalization on Indian villages'],
      ['vill-linguistic-and-religious-minorities', 'Linguistic and religious minorities and their status'],
      ['change-sanskritization', 'Sanskritization'],
      ['change-westernization-and-modernization', 'Westernization and modernization'],
      ['change-little-and-great-traditions', 'Interplay of little and great traditions'],
      ['change-panchayati-raj-and-media', 'Panchayati raj, media and social change'],
    ],
  },
  {
    topic: 'Tribal Situation in India',
    leaves: [
      ['tribe-biogenetic-variability', 'Bio-genetic variability of tribal populations'],
      ['tribe-linguistic-and-socio-economic', 'Linguistic and socio-economic characteristics and distribution'],
      ['tribe-land-alienation', 'Land alienation'],
      ['tribe-poverty-and-indebtedness', 'Poverty and indebtedness'],
      ['tribe-literacy-and-employment', 'Low literacy, poor educational facilities and underemployment'],
      ['tribe-health-and-nutrition', 'Health and nutrition'],
      ['tribe-displacement-and-rehabilitation', 'Developmental projects, displacement, rehabilitation and industrialization'],
      ['tribe-forest-policy', 'Development of forest policy and the tribals'],
    ],
  },
  {
    topic: 'Deprivation, Ethnicity and Social Change',
    leaves: [
      ['depriv-sc-st-obc-exploitation', 'Exploitation and deprivation of Scheduled Castes, Scheduled Tribes and OBCs'],
      ['depriv-constitutional-safeguards', 'Constitutional safeguards for Scheduled Castes and Scheduled Tribes'],
      ['depriv-institutions-and-welfare', 'Impact of democratic institutions, development programmes and welfare measures'],
      ['ethn-concept-of-ethnicity', 'The concept of ethnicity'],
      ['ethn-conflicts-and-political-development', 'Ethnic conflicts and political developments'],
      ['ethn-unrest-and-autonomy', 'Unrest among tribal communities, regionalism and demands for autonomy'],
      ['ethn-pseudo-tribalism', 'Pseudo-tribalism'],
      ['ethn-social-change-colonial-and-post', 'Social change among tribes in colonial and post-Independence India'],
    ],
  },
  {
    topic: 'Religion and the Tribe-State Relationship',
    leaves: [
      ['relig-impact-on-tribal-societies', 'Impact of Hinduism, Buddhism, Christianity, Islam and other religions on tribal societies'],
      ['relig-tribe-and-nation-state', 'Tribe and nation state — a comparative study'],
    ],
  },
  {
    topic: 'Tribal Administration and Development',
    leaves: [
      ['admin-history-of-tribal-administration', 'History of the administration of tribal areas'],
      ['admin-tribal-policies-and-plans', 'Tribal policies, plans and programmes and their implementation'],
      ['admin-particularly-vulnerable-groups', 'Particularly Vulnerable Tribal Groups — distribution and special programmes'],
      ['admin-role-of-ngos', 'Role of NGOs in tribal development'],
      ['admin-anthropology-in-development', 'Role of anthropology in tribal and rural development'],
      ['admin-regionalism-and-communalism', 'Anthropology and the understanding of regionalism and communalism'],
      ['admin-ethnic-and-political-movements', 'Anthropology and the understanding of ethnic and political movements'],
    ],
  },
];

/* --------------------------------------------------------------- dataset -- */

/**
 * Empty at v1, and must stay in step with any slug change made afterwards.
 *
 * A reworded bullet needs no entry here — matching on slug already handles it.
 * An entry is needed only when a slug ITSELF changes, or when one bullet is
 * split into several. Annotated rather than left to inference so that the first
 * rename anyone adds is type-checked against `SyllabusRename` instead of
 * widening a `never[]`.
 */
const RENAMES: readonly SyllabusRename[] = [];

export const SYLLABUS_V1 = {
  version: 1,
  entries: [
    ...build('gs1', GS1),
    ...build('gs2', GS2),
    ...build('gs3', GS3),
    ...build('gs4', GS4),
    ...build('essay', ESSAY),
    ...build('anthro_p1', ANTHRO_P1),
    ...build('anthro_p2', ANTHRO_P2),
  ],
  renames: RENAMES,
} satisfies SyllabusDataset;
