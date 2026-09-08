/**
 * Loads `.env` into `process.env`, for development only.
 *
 * ## Why this file exists at all
 *
 * It did not, and nothing else did the job either: no `dotenv` dependency, no
 * `--env-file` flag on any script, no `loadEnvFile()` call. `.env.example`
 * opens with "Copy to .env and fill in", and a key written into `.env` reached
 * nothing. Every run that appeared to work was passing variables on the command
 * line instead. A credential that is present, correct, and invisible is worse
 * than a missing one — the missing one fails loudly at boot, which is this
 * codebase's whole discipline.
 *
 * ## Why it must be imported FIRST
 *
 * `config.ts` reads `process.env` at module scope, so the file has to be loaded
 * before that module is evaluated. ESM hoists imports, so a `loadEnvFile()`
 * statement at the top of `index.ts` would still run after `./app.js` — and
 * therefore after `config.ts` — had already been evaluated. A side-effect
 * module placed as the first import is the only ordering that works, which is
 * why this is a file and not three lines somewhere.
 *
 * ## Why only development
 *
 * Allow-listed rather than blocked, because the failure modes differ and both
 * are real.
 *
 * PRODUCTION: `DEPLOYMENT.md` puts every secret in the host's environment —
 * Render's dashboard, Cloud Run's secret manager. There is no `.env` on a
 * deployed host, and reading one would mean an image layer could ship
 * credentials.
 *
 * TEST: a suite must not depend on what happens to be in a developer's `.env`.
 * The first version of this file excluded only production, and the end-to-end
 * test — which spawns a real server with a deliberately small `MONTHLY_USD_CAP`
 * — immediately failed its boot assertion, because the `.env` supplied
 * sub-caps that over-claimed the pool the test had set. The test was right and
 * the loading rule was wrong: a green suite that depends on an untracked file
 * is not a green suite.
 *
 * Real env vars always win either way — `loadEnvFile` does not overwrite a
 * variable that is already set, so a host's configuration cannot be clobbered.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENV_PATH = fileURLToPath(new URL('../.env', import.meta.url));

/**
 * True when this process read a `.env`. Printed in the boot banner so "which
 * configuration am I actually running" is never a guess — the question that
 * cost an afternoon when the answer was "none".
 */
export const loadedEnvFile: string | null = (() => {
  // Allow-list, not a block-list. An unrecognised NODE_ENV reads as "not
  // development" and the file is skipped — the safe direction.
  const env = process.env.NODE_ENV;
  if (env !== undefined && env !== 'development') return null;
  if (!existsSync(ENV_PATH)) return null;
  try {
    process.loadEnvFile(ENV_PATH);
    return ENV_PATH;
  } catch (err) {
    // A malformed .env must not take the server down: the host environment may
    // already carry everything needed, and `config.ts` will say precisely what
    // is missing if it does not. Warn and continue.
    console.warn(`Could not read ${ENV_PATH}: ${(err as Error).message}`);
    return null;
  }
})();
