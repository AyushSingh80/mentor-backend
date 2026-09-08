/**
 * Rubric loading and versioning.
 *
 * Rubrics are markdown files on the server, not strings in the app. Editing
 * one and restarting changes how answers are scored, with no app rebuild and
 * no Play Store round trip. This is the main reason the backend exists.
 *
 * Versioning is a content hash rather than a manual version number, so a
 * rubric edit is impossible to forget to version. Every evaluation stores the
 * hash that produced it, which is what makes a score trend meaningful — a
 * jump in scores after a rubric edit is visible rather than mysterious.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const PAPERS = [
  'gs1',
  'gs2',
  'gs3',
  'gs4',
  'essay',
  'anthro_p1',
  'anthro_p2',
] as const;

export type Paper = (typeof PAPERS)[number];

export function isPaper(value: unknown): value is Paper {
  return typeof value === 'string' && (PAPERS as readonly string[]).includes(value);
}

const RUBRIC_FOR_PAPER: Record<Paper, string> = {
  gs1: 'gs',
  gs2: 'gs',
  gs3: 'gs',
  gs4: 'ethics',
  essay: 'essay',
  anthro_p1: 'anthropology',
  anthro_p2: 'anthropology',
};

export interface CompiledRubric {
  paper: Paper;
  rubricName: string;
  systemPrompt: string;
  /** First 12 chars of the sha256 of the compiled prompt. */
  version: string;
}

const cache = new Map<Paper, CompiledRubric>();

async function readRubricFile(name: string): Promise<string> {
  // Resolves next to the source in dev (tsx) and next to dist in production,
  // because the build step copies the markdown alongside the compiled JS.
  return readFile(join(here, `${name}.md`), 'utf8');
}

export async function compileRubric(paper: Paper): Promise<CompiledRubric> {
  const cached = cache.get(paper);
  if (cached) return cached;

  const rubricName = RUBRIC_FOR_PAPER[paper];
  const [preamble, rubric, output] = await Promise.all([
    readRubricFile('_preamble'),
    readRubricFile(rubricName),
    readRubricFile('_output'),
  ]);

  const systemPrompt = [preamble, rubric, output].join('\n\n---\n\n');
  const version = createHash('sha256').update(systemPrompt).digest('hex').slice(0, 12);

  const compiled: CompiledRubric = { paper, rubricName, systemPrompt, version };
  cache.set(paper, compiled);
  return compiled;
}

/**
 * The rubric BODY alone — no preamble, no output format.
 *
 * `compileRubric` returns a complete system prompt for Phase 1's answer
 * evaluation, and `_output.md` in it dictates a markdown reply. The drill
 * evaluator returns STRUCTURED output against its own schema, so including that
 * section would instruct the model to do two contradictory things and the
 * structured parse would be the loser.
 *
 * What the drills need is the dimension table and its specific instructions —
 * the actual standard — appended to their own marking prompt. This is that.
 *
 * The version is deliberately the same string `compileRubric` produces for the
 * paper, so `drills.rubricVersion` and `evaluations.rubricVersion` name the same
 * cohort. Two version schemes for one rubric would make "which rubric scored
 * this" unanswerable across the two tables.
 */
export async function rubricBody(paper: Paper): Promise<{ body: string; version: string }> {
  const [body, compiled] = await Promise.all([
    readRubricFile(RUBRIC_FOR_PAPER[paper]),
    compileRubric(paper),
  ]);
  return { body, version: compiled.version };
}

/** Drops the cache so an edited rubric takes effect without a restart. */
export function clearRubricCache(): void {
  cache.clear();
}

export async function rubricVersions(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const paper of PAPERS) {
    out[paper] = (await compileRubric(paper)).version;
  }
  return out;
}
