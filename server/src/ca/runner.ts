/**
 * The model boundary for the digest. Two seams, both swappable.
 *
 * `setShortlistRunner` for call 1 and `setNotesRunner` for call 2, mirroring
 * `mcq/runner.ts`. Two rather than one because the fake needs to make the
 * second call FABRICATE against the first's picks — a fake pair that always
 * agrees with the fixture leaves the grounding drop path, the most expensive
 * branch in the pipeline, never exercised outside production.
 *
 * Both calls are non-streaming and structured. Both replies are
 * LISTS, and fence-scraping a list is how you lose nine of ten items while
 * reporting success — see the note on `extractTrailingJson`, which is scoped to
 * evaluation and must not be reused here.
 *
 * `max_tokens` is COMPUTED per call. Ten notes at ninety words each with three
 * verbatim quotes apiece is several thousand output tokens; a hardcoded 4096
 * truncates the run and a truncated run is one that was paid for and delivered
 * nothing.
 */

import { modelForTier, type ModelTier } from '../config.js';
import { providerFor } from '../providers/registry.js';
import { notesFormat, shortlistFormat } from './schema.js';
import { isItemKind, type Candidate } from './select.js';
import {
  MAX_EVIDENCE_PER_ITEM,
  type CaUsage,
  type DigestItemDraft,
  type ItemKind,
  type SourceDocument,
} from './types.js';

/**
 * The digest runs on the bulk tier.
 *
 * Not the evaluation tier, and the reason is that neither call is a judgement
 * call: call 1 picks from a list against explicit rules, call 2 paraphrases
 * supplied text and copies quotes out of it. Both are checked mechanically
 * afterwards. Opus would cost five times as much to be marked by the same
 * substring test.
 */
export const CA_TIER: ModelTier = 'bulk';

export const ZERO_USAGE: CaUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

export function addUsage(a: CaUsage, b: CaUsage): CaUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
  };
}

/* ------------------------------------------------------------- max_tokens */

/** A pick is five short fields. Generous, because truncation loses the run. */
const SHORTLIST_TOKENS_PER_PICK = 140;
const SHORTLIST_TOKENS_ENVELOPE = 500;

/** A note is ~90 words plus up to three verbatim quotes plus the tag arrays. */
const NOTES_TOKENS_PER_ITEM = 900;
const NOTES_TOKENS_ENVELOPE = 700;

export function shortlistMaxTokens(take: number): number {
  return Math.max(1, take) * SHORTLIST_TOKENS_PER_PICK + SHORTLIST_TOKENS_ENVELOPE;
}

export function notesMaxTokens(documentCount: number): number {
  return Math.max(1, documentCount) * NOTES_TOKENS_PER_ITEM + NOTES_TOKENS_ENVELOPE;
}

/* ---------------------------------------------------------------- call one */

export interface ShortlistRequest {
  model: string;
  system: string;
  /** Headline + lede only. The full text has not been fetched yet. */
  candidates: readonly Candidate[];
  syllabusSlugs: readonly string[];
  sections: readonly string[];
  slugLabels?: Readonly<Record<string, string>>;
  /** How many to pick. A ceiling, never a quota. */
  take: number;
  maxTokens: number;
  requestId: string;
  signal: AbortSignal;
}

export interface ShortlistPick {
  candidateIndex: number;
  kind: ItemKind;
  syllabusSlugs: string[];
  sectionKeys: string[];
  why: string;
}

export interface ShortlistResult {
  /** Null when the reply could not be parsed or was truncated. */
  picks: ShortlistPick[] | null;
  stopReason: string | null;
  usage: CaUsage;
  provenance: 'model' | 'fake';
}

export type ShortlistRunner = (request: ShortlistRequest) => Promise<ShortlistResult>;

/**
 * The user turn for call 1.
 *
 * The candidate index is printed explicitly rather than left implicit in the
 * ordering, because the model returns indices and an off-by-one there silently
 * writes a note about the wrong article.
 */
/**
 * One vocabulary line: the key, then its printed heading when there is one.
 *
 * The key comes FIRST and unadorned. The model copies it verbatim, and a label
 * in front of it — or any punctuation the label could be mistaken for part of —
 * is how a copied key comes back with a heading welded onto it and resolves to
 * nothing on the device.
 */
function vocabularyLine(slug: string, labels?: Readonly<Record<string, string>>): string {
  const label = labels?.[slug];
  return label === undefined || label === slug ? `  - ${slug}` : `  - ${slug}  (${label})`;
}

/**
 * Trims a slug list to fit a byte budget, keeping SECTIONS first.
 *
 * The app sends up to 48 KB of vocabulary — every section key plus a leaf for
 * every section she has started. Anthropic takes that without comment; Groq's
 * free tier answers 413. Measured live: 438 leaves (~39 KB) refused, ~25 KB
 * accepted.
 *
 * Sections survive first because they are the coarse taxonomy every item can
 * resolve against, and `ca-map.ts` treats a section key as a valid tag. Losing
 * leaves costs precision; losing sections costs the ability to tag at all, and
 * an untagged item is dropped as `no_syllabus_tag`.
 *
 * Truncating rather than failing is deliberate: a digest tagged at section
 * level is worth having, and refusing the whole run because the syllabus grew
 * would break the feature on exactly the day she has studied the most.
 */
export function fitVocabulary(
  slugs: readonly string[],
  sections: readonly string[],
  labels: Readonly<Record<string, string>> | undefined,
  maxBytes: number,
): { slugs: string[]; sections: string[]; dropped: number } {
  if (!Number.isFinite(maxBytes)) {
    return { slugs: [...slugs], sections: [...sections], dropped: 0 };
  }

  const cost = (key: string): number => Buffer.byteLength(vocabularyLine(key, labels)) + 1;
  let budget = maxBytes;

  const keptSections: string[] = [];
  for (const key of sections) {
    const size = cost(key);
    if (size > budget) break;
    budget -= size;
    keptSections.push(key);
  }

  const sectionSet = new Set(keptSections);
  const keptSlugs: string[] = [];
  for (const slug of slugs) {
    // A slug that is also a kept section is already paid for.
    if (sectionSet.has(slug)) {
      keptSlugs.push(slug);
      continue;
    }
    const size = cost(slug);
    if (size > budget) break;
    budget -= size;
    keptSlugs.push(slug);
  }

  return {
    slugs: keptSlugs,
    sections: keptSections,
    dropped: slugs.length - keptSlugs.length + (sections.length - keptSections.length),
  };
}

/** Serialised size of the candidate block, which the vocabulary must share a body with. */
function candidateBytes(candidates: readonly Candidate[]): number {
  let total = 0;
  for (const candidate of candidates) {
    total += Buffer.byteLength(candidate.headline) + Buffer.byteLength(candidate.lede ?? '') + 48;
  }
  return total;
}

/**
 * What is left for the vocabulary once everything else in the body is paid for.
 *
 * The 15% margin covers JSON escaping, the schema, and the difference between a
 * character count and its UTF-8 length. Over-reserving costs precision in the
 * tags; under-reserving costs the entire request with a 413, so the asymmetry
 * decides the direction.
 */
function vocabularyBudget(
  maxRequestBytes: number | undefined,
  reservedBytes: number | undefined,
  otherBytes: number,
): number {
  const ceiling = maxRequestBytes ?? Number.POSITIVE_INFINITY;
  if (!Number.isFinite(ceiling)) return Number.POSITIVE_INFINITY;
  const spent = (reservedBytes ?? 0) + otherBytes;
  return Math.max(0, Math.floor((ceiling - spent) * 0.85));
}

export function buildShortlistPayload(request: {
  candidates: readonly Candidate[];
  syllabusSlugs: readonly string[];
  sections: readonly string[];
  slugLabels?: Readonly<Record<string, string>>;
  take: number;
  /** The configured provider's ceiling for the WHOLE body. */
  maxRequestBytes?: number;
  /** Bytes already spoken for by the system prompt and the schema. */
  reservedBytes?: number;
}): string {
  // The vocabulary gets what is LEFT, not a fixed slice.
  //
  // The first version budgeted the vocabulary alone at 20KB and the body still
  // arrived at 39KB: forty candidates with their ledes, the instructions and
  // the schema came to another nineteen. A budget that ignores most of the
  // thing it is budgeting is not a budget.
  const fitted = fitVocabulary(
    request.syllabusSlugs,
    request.sections,
    request.slugLabels,
    vocabularyBudget(request.maxRequestBytes, request.reservedBytes, candidateBytes(request.candidates)),
  );

  const lines: string[] = [
    `Syllabus slugs in scope (use these verbatim, or none):`,
    ...fitted.slugs.map((slug) => vocabularyLine(slug, request.slugLabels)),
  ];
  if (fitted.sections.length > 0) {
    lines.push(
      '',
      'Section keys in scope:',
      ...fitted.sections.map((key) => vocabularyLine(key, request.slugLabels)),
    );
  }
  lines.push(
    '',
    `Pick AT MOST ${request.take} of the ${request.candidates.length} candidates below.`,
    'Returning fewer is correct. Returning none is correct on a quiet day.',
    '',
    '--- candidates ---',
  );
  for (const candidate of request.candidates) {
    lines.push(
      `[${candidate.index}] ${candidate.headline}`,
      `    source: ${candidate.sourceName}${candidate.publishedAt ? ` | published: ${candidate.publishedAt}` : ''}`,
    );
    if (candidate.lede) lines.push(`    ${candidate.lede}`);
  }
  return lines.join('\n');
}

/* --------------------------------------------------------------- call two */

export interface NotesRequest {
  model: string;
  system: string;
  /** The FULL extracted text of the shortlist, and nothing else. */
  documents: readonly SourceDocument[];
  picks: readonly ShortlistPick[];
  syllabusSlugs: readonly string[];
  sections: readonly string[];
  slugLabels?: Readonly<Record<string, string>>;
  maxTokens: number;
  requestId: string;
  signal: AbortSignal;
}

export interface NotesResult {
  drafts: DigestItemDraft[] | null;
  stopReason: string | null;
  usage: CaUsage;
  provenance: 'model' | 'fake';
}

export type NotesRunner = (request: NotesRequest) => Promise<NotesResult>;

/**
 * The user turn for call 2: the fetched text, verbatim, and nothing else.
 *
 * This payload IS the permitted universe of facts. Every downstream check —
 * the substring test on each quote, the number and date checks on the note —
 * is run against exactly these bytes, so anything the model writes that is not
 * in here fails mechanically rather than by anyone noticing.
 */
export function buildNotesPayload(request: {
  documents: readonly SourceDocument[];
  picks: readonly ShortlistPick[];
  syllabusSlugs: readonly string[];
  sections: readonly string[];
  slugLabels?: Readonly<Record<string, string>>;
  /** The configured provider's ceiling for the WHOLE body. */
  maxRequestBytes?: number;
  /** Bytes already spoken for by the system prompt and the schema. */
  reservedBytes?: number;
}): string {
  const kindByUrl = new Map<string, ShortlistPick>();
  for (const pick of request.picks) kindByUrl.set(String(pick.candidateIndex), pick);

  // The notes call carries whole articles as well as the vocabulary, so it is
  // the LARGER of the two prompts and needs the trim at least as much.
  const fitted = fitVocabulary(
    request.syllabusSlugs,
    request.sections,
    request.slugLabels,
    // The notes call carries WHOLE ARTICLES, which dwarf everything else here.
    vocabularyBudget(
      request.maxRequestBytes,
      request.reservedBytes,
      request.documents.reduce((total, doc) => total + doc.text.length, 0),
    ),
  );

  const lines: string[] = [
    'Syllabus slugs in scope (use these verbatim, or none):',
    ...fitted.slugs.map((slug) => vocabularyLine(slug, request.slugLabels)),
  ];
  if (fitted.sections.length > 0) {
    lines.push(
      '',
      'Section keys in scope:',
      ...fitted.sections.map((key) => vocabularyLine(key, request.slugLabels)),
    );
  }
  lines.push(
    '',
    `Below are ${request.documents.length} full articles. Write at most one note per`,
    'article, and only for the articles whose text actually supports one.',
    'The text below is the ONLY thing you may write from.',
  );

  for (const document of request.documents) {
    lines.push(
      '',
      '=== ARTICLE ===',
      `SOURCE URL: ${document.url}`,
      `SOURCE NAME: ${document.sourceName}`,
      `PUBLISHED: ${document.publishedAt ?? 'unknown'}`,
      `TITLE: ${document.title}`,
      '',
      document.text,
      '=== END ARTICLE ===',
    );
  }
  return lines.join('\n');
}

/* -------------------------------------------------------- provider runners */

const providerShortlistRunner: ShortlistRunner = async (request) => {
  const response = await providerFor(CA_TIER).structured({
    model: request.model,
    system: request.system,
    user: buildShortlistPayload({
      ...request,
      maxRequestBytes: providerFor(CA_TIER).capabilities.maxRequestBytes,
      reservedBytes: Buffer.byteLength(request.system),
    }),
    schema: shortlistFormat.schema,
    schemaName: 'ca_shortlist',
    maxTokens: request.maxTokens,
    // Published news headlines. Nothing here came from her device.
    dataClass: 'public',
    requestId: request.requestId,
    signal: request.signal,
  });

  const parsed = response.json === null ? null : shortlistFormat.parse(response.json);
  return {
    picks: parsed?.ok === true ? coercePicks(parsed.value.picks) : null,
    stopReason: response.stopReason,
    usage: response.usage,
    provenance: 'model',
  };
};

const providerNotesRunner: NotesRunner = async (request) => {
  const response = await providerFor(CA_TIER).structured({
    model: request.model,
    system: request.system,
    user: buildNotesPayload({
      ...request,
      maxRequestBytes: providerFor(CA_TIER).capabilities.maxRequestBytes,
      reservedBytes: Buffer.byteLength(request.system),
    }),
    schema: notesFormat.schema,
    schemaName: 'ca_notes',
    maxTokens: request.maxTokens,
    dataClass: 'public',
    requestId: request.requestId,
    signal: request.signal,
  });

  const parsed = response.json === null ? null : notesFormat.parse(response.json);
  return {
    drafts: parsed?.ok === true ? coerceDrafts(parsed.value.items) : null,
    stopReason: response.stopReason,
    usage: response.usage,
    provenance: 'model',
  };
};

/* ------------------------------------------------------------- coercion */

/**
 * Structured outputs constrain the shape; this code still treats the reply as
 * untrusted. Anything malformed is dropped here rather than throwing, so one
 * bad entry costs one item and not the whole run.
 */
function coercePicks(value: unknown): ShortlistPick[] {
  if (!Array.isArray(value)) return [];
  const out: ShortlistPick[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const pick = entry as Record<string, unknown>;
    if (!Number.isInteger(pick.candidateIndex)) continue;
    if (!isItemKind(pick.kind)) continue;
    out.push({
      candidateIndex: pick.candidateIndex as number,
      kind: pick.kind,
      syllabusSlugs: coerceStrings(pick.syllabusSlugs),
      sectionKeys: coerceStrings(pick.sectionKeys),
      why: typeof pick.why === 'string' ? pick.why : '',
    });
  }
  return out;
}

function coerceStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '');
}

export function coerceDrafts(value: unknown): DigestItemDraft[] {
  if (!Array.isArray(value)) return [];
  const out: DigestItemDraft[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.url !== 'string' || typeof item.headline !== 'string') continue;
    if (typeof item.noteMd !== 'string') continue;
    if (!isItemKind(item.kind)) continue;

    const evidence = Array.isArray(item.evidence)
      ? item.evidence
          .filter((span): span is { quote: unknown } => typeof span === 'object' && span !== null)
          .map((span) => span.quote)
          .filter((quote): quote is string => typeof quote === 'string' && quote.trim() !== '')
          .slice(0, MAX_EVIDENCE_PER_ITEM)
          // `at` is -1 until grounding resolves it against the fetched text.
          // An offset the model supplied would be an offset it could be wrong
          // about, and a wrong offset that still parses is worse than none.
          .map((quote) => ({ quote, at: -1 }))
      : [];
    if (evidence.length === 0) continue;

    out.push({
      url: item.url,
      headline: item.headline,
      kind: item.kind,
      noteMd: item.noteMd,
      sentenceEvidence: Array.isArray(item.sentenceEvidence)
        ? item.sentenceEvidence.filter((n): n is number => Number.isInteger(n) && (n as number) >= 0)
        : [],
      evidence,
      sectionKeys: coerceStrings(item.sectionKeys),
      syllabusSlugs: coerceStrings(item.syllabusSlugs),
      anthro: coerceAnthro(item.anthro),
    });
  }
  return out;
}

/**
 * All-empty means "no claim" — see the note on the schema's `anthro` object.
 * The pairing rule itself is enforced in `select.ts`, not here.
 */
export function coerceAnthro(value: unknown): DigestItemDraft['anthro'] {
  if (typeof value !== 'object' || value === null) return null;
  const anthro = value as Record<string, unknown>;
  const p1 = typeof anthro.p1Slug === 'string' ? anthro.p1Slug.trim() : '';
  const p2 = typeof anthro.p2Slug === 'string' ? anthro.p2Slug.trim() : '';
  const line = typeof anthro.usageLine === 'string' ? anthro.usageLine.trim() : '';
  if (p1 === '' && p2 === '' && line === '') return null;
  return { p1Slug: p1 === '' ? null : p1, p2Slug: p2 === '' ? null : p2, usageLine: line };
}

/* ---------------------------------------------------------------- seams */

let activeShortlistRunner: ShortlistRunner = providerShortlistRunner;
let activeNotesRunner: NotesRunner = providerNotesRunner;

/** Test/dev seam. Passing null restores the real provider-backed runner. */
export function setShortlistRunner(runner: ShortlistRunner | null): void {
  activeShortlistRunner = runner ?? providerShortlistRunner;
}

/** Second seam, so a fake notes call can fabricate against a real fixture. */
export function setNotesRunner(runner: NotesRunner | null): void {
  activeNotesRunner = runner ?? providerNotesRunner;
}

export function currentShortlistRunner(): ShortlistRunner {
  return activeShortlistRunner;
}

export function currentNotesRunner(): NotesRunner {
  return activeNotesRunner;
}

export function caModel(): string {
  return modelForTier(CA_TIER);
}
