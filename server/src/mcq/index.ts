/**
 * Prompt loading and versioning for the question bank.
 *
 * Same pattern as rubrics/index.ts, and for the same reason: prompts are
 * markdown files on the server, editable without an app rebuild, and versioned
 * by content hash so an edit cannot be forgotten.
 *
 * ONE DIFFERENCE THAT MATTERS: the JSON Schema is hashed into the version
 * alongside the prompt text. A schema edit changes the shape of what the model
 * returns exactly as much as a prompt edit changes its content — adding a
 * required field, tightening an enum, changing `maxItems` all alter the
 * output. A version that tracked only the markdown would report an unchanged
 * `promptVersion` across a real change in what was banked, and the retroactive
 * purge that `promptVersion` exists to enable would delete the wrong cohort.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Paper } from '../rubrics/index.js';
import { GENERATION_SCHEMA, VERIFICATION_SCHEMA, schemaFingerprint } from './schema.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Every prompt file, so boot-time compilation can prove they all exist. */
const PROMPT_FILES = ['_preamble', 'generate', 'anthropology', 'verify'] as const;

const ANTHROPOLOGY_PAPERS = new Set<Paper>(['anthro_p1', 'anthro_p2']);

export interface CompiledMcqPrompt {
  systemPrompt: string;
  /** sha256 of the prompt corpus AND the generation schema, first 12 chars. */
  version: string;
}

let generationCache: Map<string, CompiledMcqPrompt> | null = null;
let verifierCache: CompiledMcqPrompt | null = null;

async function readPromptFile(name: string): Promise<string> {
  // Resolves next to the source under tsx and next to dist in production,
  // because the build step copies the markdown alongside the compiled JS.
  // If that copy is ever dropped from package.json, this throws ENOENT — which
  // is why /health compiles the prompts rather than merely reporting a
  // constant: the failure surfaces on a health check, not on the first paid
  // request of the month.
  return readFile(join(here, 'prompts', `${name}.md`), 'utf8');
}

/**
 * Corpus version: every generation-side prompt file plus the generation
 * schema.
 *
 * Corpus-wide rather than per-paper on purpose. `promptVersion` exists so a
 * bad cohort can be deleted with one `DELETE ... WHERE promptVersion = ?`, and
 * the unit that goes bad is the corpus — a fix to the shared preamble changes
 * every paper's output. The per-paper difference is already recoverable from
 * the question's own `paper` field.
 */
async function corpusVersion(): Promise<string> {
  const parts = await Promise.all([
    readPromptFile('_preamble'),
    readPromptFile('generate'),
    readPromptFile('anthropology'),
  ]);
  return createHash('sha256')
    .update(parts.join('\n'))
    .update(schemaFingerprint(GENERATION_SCHEMA))
    .digest('hex')
    .slice(0, 12);
}

export async function compileGenerationPrompt(paper: Paper): Promise<CompiledMcqPrompt> {
  generationCache ??= new Map();
  const cached = generationCache.get(paper);
  if (cached) return cached;

  const [preamble, generate, version] = await Promise.all([
    readPromptFile('_preamble'),
    readPromptFile('generate'),
    corpusVersion(),
  ]);

  const sections = [preamble, generate];
  if (ANTHROPOLOGY_PAPERS.has(paper)) {
    // The optional has no Prelims paper, so these are recall drills rather
    // than exam simulation. Appended last so it overrides the general rules.
    sections.push(await readPromptFile('anthropology'));
  }

  const compiled: CompiledMcqPrompt = {
    systemPrompt: sections.join('\n\n---\n\n'),
    version,
  };
  generationCache.set(paper, compiled);
  return compiled;
}

export async function compileVerifierPrompt(): Promise<CompiledMcqPrompt> {
  if (verifierCache) return verifierCache;
  const systemPrompt = await readPromptFile('verify');
  verifierCache = {
    systemPrompt,
    version: createHash('sha256')
      .update(systemPrompt)
      .update(schemaFingerprint(VERIFICATION_SCHEMA))
      .digest('hex')
      .slice(0, 12),
  };
  return verifierCache;
}

/** Drops the cache so an edited prompt takes effect without a restart. */
export function clearMcqPromptCache(): void {
  generationCache = null;
  verifierCache = null;
}

export interface McqVersions {
  promptVersion: string;
  verifierVersion: string;
}

export async function mcqVersions(): Promise<McqVersions> {
  const [generation, verifier] = await Promise.all([
    corpusVersion(),
    compileVerifierPrompt(),
  ]);
  return { promptVersion: generation, verifierVersion: verifier.version };
}

/**
 * Reads and compiles every prompt, throwing if any is missing or unreadable.
 *
 * Called from index.ts at boot, matching config.ts's rule: a server that
 * cannot serve its own endpoint should refuse to start rather than discover it
 * on the first request. The specific failure this catches is a build that
 * forgot to copy `src/mcq/prompts/*.md` into `dist/` — which works perfectly
 * in dev and throws ENOENT in production.
 */
export async function assertMcqPromptsCompile(): Promise<McqVersions> {
  for (const name of PROMPT_FILES) {
    const text = await readPromptFile(name);
    if (text.trim() === '') {
      throw new Error(`MCQ prompt ${name}.md is empty. Refusing to start with no instructions.`);
    }
  }
  // Compile both paper variants so the anthropology branch is proven too.
  await compileGenerationPrompt('gs1');
  await compileGenerationPrompt('anthro_p1');
  await compileVerifierPrompt();
  return mcqVersions();
}

export * from './types.js';
