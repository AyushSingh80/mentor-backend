/**
 * Process entrypoint. Everything that makes up the HTTP surface lives in
 * app.ts so it can be exercised without binding a port.
 */

// FIRST, and the order is load-bearing: `config.ts` reads `process.env` at
// module scope, and ESM evaluates imports in order. See the header of env.ts.
import { loadedEnvFile } from './env.js';

import { app } from './app.js';
import { config } from './config.js';
import { assertCaPromptsCompile } from './ca/index.js';
import { setNotesRunner, setShortlistRunner } from './ca/runner.js';
import { assertDrillPromptsCompile } from './drills/index.js';
import { assertInterviewPromptsCompile } from './interview/index.js';
import { setInterviewRunner } from './interview/runner.js';
import { setEvaluateRunner, setGenerateRunner } from './drills/runner.js';
import { assertMcqPromptsCompile } from './mcq/index.js';
import { setMcqRunner, setVerificationRunner } from './mcq/runner.js';
import { providerIdFor } from './providers/registry.js';
import { setCaIngest } from './routes/ca.js';
import { setEvaluationRunner } from './routes/evaluate.js';

/**
 * Opt-in scripted evaluator: `EVAL_RUNNER=fake npm run dev`.
 *
 * Exists so the phone app can be walked end to end on a real device without
 * spending anything — the questions worth answering there ("do tokens arrive
 * progressively?", "does an airplane-mode capture survive?") have nothing to do
 * with answer quality.
 *
 * The production guard is not paranoia. A fake evaluator serving real-looking
 * marks is worse than an outage: an outage is obvious, invented scores are
 * trusted. Refuse to start rather than risk it.
 */
if (process.env.EVAL_RUNNER === 'fake') {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('EVAL_RUNNER=fake is refused in production — it would serve invented scores.');
  }
  const { fakeRunner } = await import('./fake-runner.js');
  setEvaluationRunner(fakeRunner);

  // ONE switch installs BOTH fakes. A separate MCQ_RUNNER=fake variable would
  // be a footgun: the failure mode is setting one and forgetting the other,
  // which produces a server that looks fake, is billed as real, and banks
  // invented questions permanently.
  const { fakeMcqRunner, fakeVerificationRunner } = await import('./fake-mcq-runner.js');
  setMcqRunner(fakeMcqRunner);
  setVerificationRunner(fakeVerificationRunner);

  // Current affairs, from the SAME switch. A fake FACT is more dangerous than a
  // fake score: a score is obviously a score, but an invented scheme or
  // judgment date looks exactly like a real one and gets written into an
  // answer. The fake also supplies its own documents, so scripted text can
  // never carry a real outlet's name.
  const { fakeShortlistRunner, fakeNotesRunner, fakeCaIngest } = await import(
    './fake-ca-runner.js'
  );
  setShortlistRunner(fakeShortlistRunner);
  setNotesRunner(fakeNotesRunner);
  setCaIngest(fakeCaIngest);

  // Drills, from the SAME switch. The dangerous half here is the MARK: a topic
  // is only a prompt, but "31/40, your thesis carries the essay" is a sentence
  // she can believe and calibrate against.
  const { fakeGenerateRunner, fakeEvaluateRunner } = await import('./fake-drill-runner.js');
  setGenerateRunner(fakeGenerateRunner);
  setEvaluateRunner(fakeEvaluateRunner);

  // Interview questions, from the SAME switch. The danger here is different
  // from a fake score: a scripted QUESTION is harmless, but a fake that slipped
  // a fact about her district into one would be exactly the failure the whole
  // phase is built to prevent. The fake therefore states nothing.
  const { fakeInterviewRunner } = await import('./fake-interview-runner.js');
  setInterviewRunner(fakeInterviewRunner);

  console.warn('');
  console.warn('  ****************************************************');
  console.warn('  *  FAKE RUNNERS — scores and questions are NOT real.*');
  console.warn('  *  No model is called and nothing is billed.       *');
  console.warn('  *  Every question stem is prefixed [SAMPLE].       *');
  console.warn('  *  Every digest headline is prefixed [SAMPLE].     *');
  console.warn('  *  Every drill mark is scripted and prefixed too.  *');
  console.warn('  ****************************************************');
  console.warn('');
}

/**
 * Compile every prompt before binding the port.
 *
 * Same rule as config.ts: fail loudly at boot, not at first request. The
 * specific disaster this prevents is a production build whose script no longer
 * copies src/mcq/prompts/*.md into dist — dev works perfectly, and production
 * throws ENOENT on the first request of the day, after the reservation has
 * been taken.
 */
const mcq = await assertMcqPromptsCompile();
const ca = await assertCaPromptsCompile();
const drills = await assertDrillPromptsCompile();
const interview = await assertInterviewPromptsCompile();

const server = app.listen(config.port, () => {
  console.log(`upsc-mentor-server listening on http://localhost:${config.port}`);
  // Printed because "which configuration is this process actually using" was
  // unanswerable for a whole session: `.env` was never read and nothing said so.
  console.log(`  env file      ${loadedEnvFile ?? 'none (host environment only)'}`);
  console.log(`  timezone      ${config.timezone}`);
  // Provider first, then the model it is being asked for. A mis-set
  // PROVIDER_BULK is otherwise invisible: the registry refuses an id it does
  // not know, but `PROVIDER_BULK=anthropic` on a deployment that meant to move
  // to Groq starts perfectly and bills the wrong account all month.
  console.log(`  eval model    ${providerIdFor('evaluation')} / ${config.models.evaluation ?? 'not configured'}`);
  console.log(`  bulk model    ${providerIdFor('bulk')} / ${config.models.bulk ?? 'not configured'}`);
  console.log(`  monthly cap   $${config.caps.monthlyUsd}`);
  console.log(`  mcq sub-cap   $${config.caps.mcqMonthlyUsd}`);
  console.log(`  daily cap     ${config.caps.dailyRequests} model calls`);
  console.log(`  mcq prompt    ${mcq.promptVersion} / verifier ${mcq.verifierVersion}`);
  console.log(`  ca sub-cap    $${config.caps.caMonthlyUsd}`);
  console.log(`  ca prompt     ${ca.promptVersion}`);
  console.log(`  drill sub-cap $${config.caps.drillsMonthlyUsd}`);
  console.log(`  drill prompt  ${drills.promptVersion} / evaluator ${drills.evaluatorVersion}`);
  console.log(`  interview     $${config.caps.interviewMonthlyUsd} / prompt ${interview.promptVersion}`);
});

// A streamed evaluation can legitimately run for minutes. The Node default
// would cut the connection mid-answer.
server.requestTimeout = 0;
server.headersTimeout = 60_000;
