/**
 * A scripted evaluation runner. No model, no API key, no spend.
 *
 * Two jobs:
 *  1. End-to-end tests can drive the real server over real HTTP and assert the
 *     whole pipeline — multipart intake, SSE framing, usage accounting, cap
 *     release — without an Anthropic account.
 *  2. `npm run dev:fake` lets the phone app be exercised on a real device for
 *     free, which matters when the thing being checked is "do tokens appear
 *     progressively or in one lump after a pause" rather than answer quality.
 *
 * It emits a realistic response: prose in the five sections `_output.md`
 * mandates, ending in a trailing ```json score block. That shape is the point —
 * it exercises `extractTrailingJson` / `stripTrailingJson` and the app's mapper
 * for real, rather than testing a payload the model would never produce.
 *
 * SAFETY: `index.ts` refuses to start with this enabled when NODE_ENV is
 * production. A fake evaluator that silently served real-looking scores would
 * be worse than an outage — the user would trust marks that came from nothing.
 */

import type {
  EvaluationRequest,
  EvaluationRun,
  EvaluationRunner,
  EvaluationTokenCounts,
} from './routes/evaluate.js';

const SCRIPTED_FEEDBACK = `**Directive compliance.** The question asked you to *critically examine*, and this answer describes without ever reaching a judgement. That is a structural failure, not a small deduction.

## Content and syllabus relevance — 1.8 / 4

You cover the institutional history accurately, but you never address the second half of the question. Naming the relevant articles would cost you one line and gain more than the paragraph you spent on background.

## Structure — 1.0 / 2.5

Introduction and conclusion are present. The body is one undifferentiated block; subheadings would let an examiner find your argument in the ten seconds they will spend looking.

## Value addition — 0.6 / 1.5

No committee report, no judgment, no data. "Various schemes" earns nothing where a named scheme with its status earns marks.

## Presentation — 0.6 / 1

Handwriting is legible throughout. Margins are cramped on the second sheet.

## Word limit — 0.5 / 1

Roughly 290 words against a 250 limit.

**The single highest-leverage fix:** end every paragraph with the judgement the directive asked for, not just the description that leads to it.

**Model skeleton**
1. Intro — define the institution and state your verdict in one line.
2. Body — two dimensions, each described then judged, with one named example apiece.
3. Conclusion — resolve the verdict forward, not a summary.

\`\`\`json
{
  "total": 4.5,
  "max": 10,
  "dimensions": [
    { "name": "Content and syllabus relevance", "score": 1.8, "max": 4, "comment": "Accurate but only answers half the question." },
    { "name": "Structure and directive compliance", "score": 1.0, "max": 2.5, "comment": "Described where it needed to judge." },
    { "name": "Value addition", "score": 0.6, "max": 1.5, "comment": "No named reports, judgments or data." },
    { "name": "Presentation", "score": 0.6, "max": 1, "comment": "Legible; cramped margins on sheet two." },
    { "name": "Word limit and time discipline", "score": 0.5, "max": 1, "comment": "About 290 words against 250." }
  ],
  "directiveWord": "critically examine",
  "directiveCompliance": false,
  "highestLeverageFix": "End every paragraph with a judgement, not a description.",
  "legibility": "good",
  "legibilityNote": "Cramped margins on the second sheet.",
  "wordLimitRespected": false,
  "confidence": "high"
}
\`\`\``;

/** Split into small chunks so streaming is genuinely observable, not one blob. */
function chunk(text: string, size = 24): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

export const fakeRunner: EvaluationRunner = (request: EvaluationRequest): EvaluationRun => {
  const textListeners: ((delta: string) => void)[] = [];
  const usageListeners: ((counts: Partial<EvaluationTokenCounts>) => void)[] = [];

  let aborted = false;
  // Roughly proportional to the real thing, so usage accounting is exercised
  // with plausible numbers rather than zeroes.
  const inputTokens = 1200 + request.blocks.length * 800;
  let outputTokens = 0;

  const finished = (async (): Promise<EvaluationTokenCounts> => {
    // Yield once so listeners registered synchronously after the call are
    // attached before the first delta — the real SDK behaves the same way.
    await new Promise((resolve) => setImmediate(resolve));

    usageListeners.forEach((listener) => listener({ inputTokens }));

    const deltaMs = Number(process.env.FAKE_RUNNER_DELAY_MS ?? 8);
    for (const piece of chunk(SCRIPTED_FEEDBACK)) {
      if (aborted) throw new Error('Request was aborted');
      textListeners.forEach((listener) => listener(piece));
      outputTokens += 6;
      usageListeners.forEach((listener) => listener({ outputTokens }));
      if (deltaMs > 0) await new Promise((resolve) => setTimeout(resolve, deltaMs));
    }

    if (aborted) throw new Error('Request was aborted');
    return { inputTokens, outputTokens };
  })();

  // Nothing may await this promise before finalUsage() is called, or an abort
  // becomes an unhandled rejection and takes the process down.
  finished.catch(() => undefined);

  return {
    onText(listener) {
      textListeners.push(listener);
    },
    onUsage(listener) {
      usageListeners.push(listener);
    },
    finalUsage() {
      return finished;
    },
    abort() {
      aborted = true;
    },
  };
};
