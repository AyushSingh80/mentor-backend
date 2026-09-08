/**
 * Prompt loading and versioning for interview question generation.
 *
 * Same pattern as `rubrics/`, `mcq/`, `ca/` and `drills/`: markdown on the
 * server, editable without an app rebuild, versioned by content hash so an edit
 * cannot be forgotten, with the JSON Schema folded into the hash because a
 * schema edit changes the output as much as a prompt edit does.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QUESTIONS_SCHEMA, schemaFingerprint } from './schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const PROMPT_FILES = ['_preamble', 'generate'] as const;

export interface CompiledInterviewPrompt {
  systemPrompt: string;
  version: string;
}

let cache: CompiledInterviewPrompt | null = null;

async function readPromptFile(name: string): Promise<string> {
  // Resolves next to the source under tsx and next to dist in production. If
  // the build's copy step is ever dropped this throws ENOENT — which is why
  // /health compiles the prompts rather than reporting a constant.
  return readFile(join(here, 'prompts', `${name}.md`), 'utf8');
}

export async function compileInterviewPrompt(): Promise<CompiledInterviewPrompt> {
  if (cache) return cache;
  const [preamble, generate] = await Promise.all([
    readPromptFile('_preamble'),
    readPromptFile('generate'),
  ]);
  cache = {
    systemPrompt: [preamble, generate].join('\n\n---\n\n'),
    version: createHash('sha256')
      .update([preamble, generate].join('\n'))
      .update(schemaFingerprint(QUESTIONS_SCHEMA))
      .digest('hex')
      .slice(0, 12),
  };
  return cache;
}

export interface InterviewVersions {
  promptVersion: string;
}

/** For `/health`. Reads from disk, so a missing file fails the check. */
export async function interviewVersions(): Promise<InterviewVersions> {
  return { promptVersion: (await compileInterviewPrompt()).version };
}

/** Boot assertion: the prompts exist and compile. */
export async function assertInterviewPromptsCompile(): Promise<InterviewVersions> {
  for (const name of PROMPT_FILES) {
    const body = await readPromptFile(name);
    if (body.trim() === '') throw new Error(`Interview prompt ${name}.md is empty.`);
  }
  return interviewVersions();
}

export function reloadInterviewPrompts(): void {
  cache = null;
}
