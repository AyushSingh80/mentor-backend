/**
 * Prompt loading and versioning for the essay and ethics drills.
 *
 * Same pattern as `rubrics/index.ts`, `mcq/index.ts` and `ca/index.ts`: prompts
 * are markdown on the server, editable without an app rebuild, versioned by
 * content hash so an edit cannot be forgotten.
 *
 * The JSON Schema is hashed into the version alongside the markdown, for the
 * reason `mcq/index.ts` sets out at length: a schema edit changes the shape of
 * what the model returns exactly as much as a prompt edit changes its content,
 * and a version tracking only the markdown would report no change across a real
 * one — making the retroactive purge that `promptVersion` exists for delete the
 * wrong cohort.
 *
 * The EVALUATION prompt is versioned separately from the GENERATION prompt,
 * because they go bad independently: a topic set that turns out to be flat is a
 * different cohort from a marking pass that turns out to be lenient, and the
 * rows they taint are different rows.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVALUATION_SCHEMA, PROMPTS_SCHEMA, schemaFingerprint } from './schema.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Every prompt file, so boot-time compilation can prove they all exist. */
const PROMPT_FILES = ['_preamble', 'generate', 'evaluate'] as const;

export interface CompiledDrillPrompt {
  systemPrompt: string;
  /** sha256 of the prompt text AND its schema, first 12 chars. */
  version: string;
}

let generateCache: CompiledDrillPrompt | null = null;
let evaluateCache: CompiledDrillPrompt | null = null;

async function readPromptFile(name: string): Promise<string> {
  // Resolves next to the source under tsx and next to dist in production,
  // because the build step copies the markdown alongside the compiled JS. If
  // that copy is ever dropped from package.json this throws ENOENT — which is
  // why /health compiles the prompts rather than reporting a constant: the
  // failure surfaces on a health check, not on the first paid request.
  return readFile(join(here, 'prompts', `${name}.md`), 'utf8');
}

function version(parts: readonly string[], schema: Record<string, unknown>): string {
  return createHash('sha256')
    .update(parts.join('\n'))
    .update(schemaFingerprint(schema))
    .digest('hex')
    .slice(0, 12);
}

export async function compileGeneratePrompt(): Promise<CompiledDrillPrompt> {
  if (generateCache) return generateCache;
  const [preamble, generate] = await Promise.all([
    readPromptFile('_preamble'),
    readPromptFile('generate'),
  ]);
  generateCache = {
    systemPrompt: [preamble, generate].join('\n\n---\n\n'),
    version: version([preamble, generate], PROMPTS_SCHEMA),
  };
  return generateCache;
}

/**
 * The marking prompt, with the paper's own rubric appended.
 *
 * The rubric is the existing `rubrics/essay.md` or `rubrics/ethics.md` — the
 * same text Phase 1 marks a full answer against. Two rubrics for one paper is
 * how a drill score and an answer score start disagreeing about what a good
 * thesis is, and she would have no way to tell which was right.
 */
export async function compileEvaluatePrompt(rubricBody: string): Promise<CompiledDrillPrompt> {
  const [preamble, evaluate] = await Promise.all([
    readPromptFile('_preamble'),
    readPromptFile('evaluate'),
  ]);
  return {
    systemPrompt: [preamble, evaluate, rubricBody].join('\n\n---\n\n'),
    // The RUBRIC IS NOT HASHED HERE. `drills.rubricVersion` records it as its
    // own column, exactly as `evaluations` does, so a rubric edit is already
    // findable. Folding it in would change `promptVersion` for every paper
    // whenever one paper's rubric changed, and the purge would take both.
    version: version([preamble, evaluate], EVALUATION_SCHEMA),
  };
}

/** Version of the marking prompt alone, without loading a rubric. */
export async function evaluatePromptVersion(): Promise<string> {
  if (evaluateCache) return evaluateCache.version;
  const [preamble, evaluate] = await Promise.all([
    readPromptFile('_preamble'),
    readPromptFile('evaluate'),
  ]);
  evaluateCache = { systemPrompt: '', version: version([preamble, evaluate], EVALUATION_SCHEMA) };
  return evaluateCache.version;
}

export interface DrillVersions {
  promptVersion: string;
  evaluatorVersion: string;
}

/** For `/health`. Reads from disk, so a missing file fails the check. */
export async function drillVersions(): Promise<DrillVersions> {
  const [generate, evaluator] = await Promise.all([
    compileGeneratePrompt(),
    evaluatePromptVersion(),
  ]);
  return { promptVersion: generate.version, evaluatorVersion: evaluator };
}

/**
 * Boot assertion: every prompt file exists and compiles.
 *
 * Called from `index.ts` before the server listens. A drill server that starts
 * without its prompts is one that fails on her first attempt of the morning,
 * having already spent the reservation.
 */
export async function assertDrillPromptsCompile(): Promise<DrillVersions> {
  for (const name of PROMPT_FILES) {
    const body = await readPromptFile(name);
    if (body.trim() === '') throw new Error(`Drill prompt ${name}.md is empty.`);
  }
  return drillVersions();
}

/** Drops the caches so a running server can pick up an edited prompt. */
export function reloadDrillPrompts(): void {
  generateCache = null;
  evaluateCache = null;
}
