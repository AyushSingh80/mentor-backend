/**
 * Prompt loading and versioning for the digest.
 *
 * Same pattern as `rubrics/index.ts` and `mcq/index.ts`, and for the same
 * reason: prompts are markdown files on the server, editable without an app
 * rebuild, and versioned by content hash so an edit cannot be forgotten.
 *
 * BOTH SCHEMAS ARE HASHED IN alongside the prompt text. A schema edit changes
 * the shape of what the model returns exactly as much as a prompt edit changes
 * its content — tightening an enum, adding a required field, changing
 * `maxItems` all alter the output. A version tracking only the markdown would
 * report an unchanged `promptVersion` across a real change in what was written
 * into `ca_items`, and the retroactive purge that `promptVersion` exists to
 * enable would then delete the wrong cohort.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOTES_SCHEMA, SHORTLIST_SCHEMA, schemaFingerprint } from './schema.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Every prompt file, so boot-time compilation can prove they all exist. */
const PROMPT_FILES = ['_preamble', 'shortlist', 'notes', 'anthropology'] as const;

export interface CompiledCaPrompt {
  systemPrompt: string;
  /** sha256 of the whole prompt corpus AND both schemas, first 12 chars. */
  version: string;
}

let shortlistCache: CompiledCaPrompt | null = null;
const notesCache = new Map<string, CompiledCaPrompt>();
let versionCache: string | null = null;

async function readPromptFile(name: string): Promise<string> {
  // Resolves next to the source under tsx and next to dist in production,
  // because the build step copies the markdown alongside the compiled JS. If
  // that copy is ever dropped from package.json this throws ENOENT — which is
  // why /health compiles the prompts rather than reporting a constant: the
  // failure surfaces on a health check, not on the first paid run of the day.
  return readFile(join(here, 'prompts', `${name}.md`), 'utf8');
}

/**
 * Corpus version: every prompt file plus both schemas.
 *
 * Corpus-wide rather than per-call, because `promptVersion` exists so a bad
 * cohort can be deleted with one `DELETE ... WHERE prompt_version = ?`, and the
 * unit that goes bad is the corpus — a fix to the shared preamble changes what
 * both calls produce. The per-call difference is not something anyone would
 * want to purge separately.
 */
export async function caCorpusVersion(): Promise<string> {
  if (versionCache) return versionCache;
  const parts = await Promise.all(PROMPT_FILES.map((name) => readPromptFile(name)));
  versionCache = createHash('sha256')
    .update(parts.join('\n'))
    .update(schemaFingerprint(SHORTLIST_SCHEMA))
    .update(schemaFingerprint(NOTES_SCHEMA))
    .digest('hex')
    .slice(0, 12);
  return versionCache;
}

export async function compileShortlistPrompt(): Promise<CompiledCaPrompt> {
  if (shortlistCache) return shortlistCache;
  const [preamble, shortlist, version] = await Promise.all([
    readPromptFile('_preamble'),
    readPromptFile('shortlist'),
    caCorpusVersion(),
  ]);
  shortlistCache = { systemPrompt: [preamble, shortlist].join('\n\n---\n\n'), version };
  return shortlistCache;
}

/**
 * The notes prompt, with the Anthropology section appended when asked for.
 *
 * Appended LAST so it overrides the general rules, and gated rather than always
 * on so a GS-only digest does not pay for instructions it will not use — and so
 * both branches are compiled at boot, which is what proves the file exists.
 */
export async function compileNotesPrompt(
  opts: { linkAnthropology: boolean } = { linkAnthropology: true },
): Promise<CompiledCaPrompt> {
  const key = opts.linkAnthropology ? 'anthro' : 'plain';
  const cached = notesCache.get(key);
  if (cached) return cached;

  const [preamble, notes, version] = await Promise.all([
    readPromptFile('_preamble'),
    readPromptFile('notes'),
    caCorpusVersion(),
  ]);

  const sections = [preamble, notes];
  if (opts.linkAnthropology) sections.push(await readPromptFile('anthropology'));

  const compiled: CompiledCaPrompt = {
    systemPrompt: sections.join('\n\n---\n\n'),
    version,
  };
  notesCache.set(key, compiled);
  return compiled;
}

/** Drops the cache so an edited prompt takes effect without a restart. */
export function clearCaPromptCache(): void {
  shortlistCache = null;
  notesCache.clear();
  versionCache = null;
}

export interface CaVersions {
  promptVersion: string;
}

export async function caVersions(): Promise<CaVersions> {
  return { promptVersion: await caCorpusVersion() };
}

/**
 * Reads and compiles every prompt, throwing if any is missing or unreadable.
 *
 * Called from index.ts at boot, matching config.ts's rule: a server that cannot
 * serve its own endpoint should refuse to start rather than discover it on the
 * first request. The specific failure this catches is a build that forgot to
 * copy `src/ca/prompts/*.md` into `dist/` — which works perfectly in dev and
 * throws ENOENT in production, after the reservation has been taken.
 */
export async function assertCaPromptsCompile(): Promise<CaVersions> {
  for (const name of PROMPT_FILES) {
    const text = await readPromptFile(name);
    if (text.trim() === '') {
      throw new Error(`CA prompt ${name}.md is empty. Refusing to start with no instructions.`);
    }
  }
  await compileShortlistPrompt();
  // Both branches, so the anthropology file is proven to load too.
  await compileNotesPrompt({ linkAnthropology: true });
  await compileNotesPrompt({ linkAnthropology: false });
  return caVersions();
}

export * from './types.js';
