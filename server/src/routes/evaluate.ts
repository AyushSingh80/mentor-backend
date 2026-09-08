/**
 * POST /evaluate — scan pages in, rubric-scored evaluation out.
 *
 * Streams over SSE so feedback appears as it is written rather than after a
 * 30-second blank wait. Events emitted, in order:
 *
 *   meta   { model, rubricVersion, paper, pages }
 *   token  { text }                      (many)
 *   scores { ...parsed score block }     (once, may be omitted if unparseable)
 *   usage  { inputTokens, outputTokens, estCostUsd, monthUsd }
 *   done   { ok: true }
 *   error  { message }                   (terminal, replaces done)
 *
 * The order is guaranteed by `SseStream`, which serialises writes: a `scores`
 * frame cannot overtake a `token` frame that is still waiting on backpressure.
 */

import { Router, type RequestHandler } from 'express';
import { extractTrailingJson, isImageMediaType, stripTrailingJson } from '../anthropic.js';
import { modelForTier } from '../config.js';
import { evaluationRunner } from '../providers/registry.js';
import { compileRubric, isPaper } from '../rubrics/index.js';
import { SseStream, clientHasDisconnected } from '../sse.js';
import {
  MAX_FILES,
  assertTotalWithinLimit,
  isAllowedMediaType,
  parseUpload,
  rejectOversizedBody,
  uploadErrorHandler,
} from '../upload.js';
import { capStatus, recordUsage, releaseReservation, tryReserve } from '../usage.js';

// Text fields are embedded verbatim into the prompt and are not counted toward
// the upload byte budget, so they need their own ceilings.
const MAX_QUESTION_CHARS = 2000;
const MIN_QUESTION_CHARS = 5;
const MAX_DIRECTIVE_CHARS = 64;
const MAX_PREVIOUS_ATTEMPT_CHARS = 20_000;

/* ------------------------------------------------------------ model boundary */

/**
 * The evaluation port, re-exported.
 *
 * The TYPES moved to `providers/types.ts` when the provider port landed, so an
 * adapter can implement them without importing a route. The SHAPE is unchanged
 * and stays that way: it is the one part of the model boundary that was already
 * right, having been written against what this route actually needs rather than
 * against what an SDK happens to offer. Re-exported from here because
 * `fake-runner.ts` and the tests import them from this module and there is no
 * reason to make them move.
 */
export type {
  ContentBlock,
  EvaluationRequest,
  EvaluationRun,
  EvaluationRunner,
  EvaluationTokenCounts,
} from '../providers/types.js';

import type { ContentBlock, EvaluationRun, EvaluationRunner } from '../providers/types.js';

/**
 * Resolved per call rather than captured at module load.
 *
 * `evaluationRunner()` asks the registry which provider `PROVIDER_EVALUATION`
 * selected; the registry refused to boot if that provider had no streaming
 * runner, so this cannot be null here.
 */
let activeRunner: EvaluationRunner | null = null;

/**
 * Test seam. Swapping the runner is the only way to exercise the SSE framing
 * without a real API key — the HTTP layer is what is under test here, not the
 * model call. Passing null restores the configured provider's runner.
 */
export function setEvaluationRunner(runner: EvaluationRunner | null): void {
  activeRunner = runner;
}

/* ------------------------------------------------------------------ handlers */

const requireMultipart: RequestHandler = (req, res, next) => {
  if (!req.is('multipart/form-data')) {
    res.status(400).json({
      error: 'bad_request',
      detail: 'multipart/form-data body is required',
    });
    return;
  }
  next();
};

/**
 * Advisory fast-fail so a capped account does not pay to parse a body.
 * The authoritative check is the atomic reservation in the handler below.
 */
const capFastFail: RequestHandler = async (_req, res, next) => {
  const preCheck = await capStatus();
  if (!preCheck.allowed) {
    res.status(429).json({ error: 'spend_cap_reached', detail: preCheck.reason, caps: preCheck });
    return;
  }
  next();
};

function badRequest(detail: string): { error: string; detail: string } {
  return { error: 'bad_request', detail };
}

const handleEvaluate: RequestHandler = async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const files: Express.Multer.File[] = Array.isArray(req.files) ? req.files : [];

  const paper = body.paper;
  const question = body.question;
  const directiveWord = body.directiveWord;
  const wordLimitRaw = body.wordLimit;
  const previousAttempt = body.previousAttempt;

  if (!isPaper(paper)) {
    res
      .status(400)
      .json(badRequest('paper must be one of gs1|gs2|gs3|gs4|essay|anthro_p1|anthro_p2'));
    return;
  }
  if (typeof question !== 'string' || question.trim().length < MIN_QUESTION_CHARS) {
    res.status(400).json(badRequest('question is required'));
    return;
  }
  if (question.length > MAX_QUESTION_CHARS) {
    res.status(400).json(badRequest(`question exceeds ${MAX_QUESTION_CHARS} characters`));
    return;
  }
  if (typeof directiveWord === 'string' && directiveWord.length > MAX_DIRECTIVE_CHARS) {
    res.status(400).json(badRequest(`directiveWord exceeds ${MAX_DIRECTIVE_CHARS} characters`));
    return;
  }
  if (typeof previousAttempt === 'string' && previousAttempt.length > MAX_PREVIOUS_ATTEMPT_CHARS) {
    res
      .status(400)
      .json(badRequest(`previousAttempt exceeds ${MAX_PREVIOUS_ATTEMPT_CHARS} characters`));
    return;
  }

  const wordLimit = Number(wordLimitRaw ?? 250);
  if (!Number.isFinite(wordLimit) || wordLimit <= 0) {
    res.status(400).json(badRequest('wordLimit must be a positive number'));
    return;
  }

  if (files.length === 0) {
    res.status(400).json(badRequest('at least one page image or PDF is required'));
    return;
  }
  if (files.length > MAX_FILES) {
    res.status(400).json(badRequest(`at most ${MAX_FILES} files`));
    return;
  }

  // Layer 3 of the size enforcement. Throws PayloadTooLargeError, which the
  // router's error handler turns into a 413.
  assertTotalWithinLimit(files);

  const pageBlocks: ContentBlock[] = [];
  for (const file of files) {
    const mediaType = file.mimetype || 'application/octet-stream';

    // multer's fileFilter already rejected anything off the allow-list; this
    // repeats the check so the block builder cannot be the weak link.
    if (!isAllowedMediaType(mediaType)) {
      res
        .status(400)
        .json(badRequest(`unsupported file type ${mediaType} for ${file.originalname}`));
      return;
    }

    const data = file.buffer.toString('base64');
    if (mediaType === 'application/pdf') {
      pageBlocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data },
      });
    } else if (isImageMediaType(mediaType)) {
      pageBlocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
    }
  }

  const rubric = await compileRubric(paper);
  const model = modelForTier('evaluation');

  const instruction = [
    `Paper: ${paper}`,
    `Question: ${question.trim()}`,
    directiveWord && typeof directiveWord === 'string'
      ? `Directive word as the candidate identified it: ${directiveWord.trim()}`
      : `Directive word: not supplied — infer it from the question and say what you inferred.`,
    `Stated word limit: ${wordLimit}`,
    '',
    typeof previousAttempt === 'string' && previousAttempt.trim()
      ? `Her previous attempt on this topic, for comparison:\n${previousAttempt.trim()}`
      : 'No previous attempt on this topic is available; skip the comparison section.',
    '',
    'The scanned pages of her handwritten answer follow. Evaluate them against the rubric.',
  ].join('\n');

  // Authoritative admission. Atomic check-and-reserve, so concurrent requests
  // see each other rather than all reading the same pre-billing snapshot.
  const reservation = await tryReserve();
  if (!reservation.ok) {
    res.status(429).json({
      error: 'spend_cap_reached',
      detail: reservation.caps.reason,
      caps: reservation.caps,
    });
    return;
  }

  // Idempotent: a race between the disconnect path and normal completion must
  // not double-decrement, and a missed call ratchets the cap down until restart.
  let released = false;
  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    releaseReservation();
  };

  let run: EvaluationRun | null = null;
  let peerGone = false;

  const onPeerGone = (): void => {
    if (peerGone) return;
    // `req` emits 'close' as soon as the parsed body is done, long before the
    // client actually leaves, so the socket has to be checked as well.
    if (!clientHasDisconnected(res)) return;
    peerGone = true;
    console.error('[evaluate] client disconnected mid-stream; aborting model call');
    try {
      run?.abort();
    } catch (err) {
      console.error('[evaluate] abort after disconnect failed', err);
    }
  };
  req.on('close', onPeerGone);
  res.on('close', onPeerGone);

  let sse: SseStream | null = null;
  let fullText = '';
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    sse = new SseStream(res);

    sse.send('meta', {
      model,
      rubricVersion: rubric.version,
      rubricName: rubric.rubricName,
      paper,
      pages: pageBlocks.length,
    });

    const runner = activeRunner ?? evaluationRunner();
    run = runner({ model, system: rubric.systemPrompt, instruction, blocks: pageBlocks });

    run.onText((delta) => {
      fullText += delta;
      sse?.send('token', { text: delta });
    });
    run.onUsage((counts) => {
      if (counts.inputTokens !== undefined) inputTokens = counts.inputTokens;
      if (counts.outputTokens !== undefined) outputTokens = counts.outputTokens;
    });

    const final = await run.finalUsage();
    inputTokens = final.inputTokens;
    outputTokens = final.outputTokens;

    const scores = extractTrailingJson(fullText);
    sse.send('scores', {
      scores,
      feedbackMarkdown: stripTrailingJson(fullText),
      parsed: scores !== null,
    });

    const record = await recordUsage({
      endpoint: '/evaluate',
      tier: 'evaluation',
      model,
      inputTokens,
      outputTokens,
    });
    const after = await capStatus();

    sse.send('usage', {
      inputTokens,
      outputTokens,
      estCostUsd: Number(record.estCostUsd.toFixed(4)),
      monthUsd: Number(after.monthUsd.toFixed(2)),
      monthlyCapUsd: after.monthlyCapUsd,
    });

    sse.send('done', { ok: true });
  } catch (err) {
    console.error('[evaluate]', err);
    // Bill for partial work: tokens were consumed even though the stream broke.
    if (inputTokens || outputTokens) {
      await recordUsage({
        endpoint: '/evaluate:partial',
        tier: 'evaluation',
        model,
        inputTokens,
        outputTokens,
      }).catch(() => undefined);
    }
    // Never echoes err.message — the full detail is in the server log above.
    sse?.send('error', { message: 'Evaluation failed. Check the server logs.' });
  } finally {
    // Outermost level of the handler on purpose. If this is ever moved inside a
    // stream callback, a throw on the way there leaks the slot until restart.
    releaseOnce();
    req.off('close', onPeerGone);
    res.off('close', onPeerGone);
    if (sse) await sse.end();
    else if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
  }
};

/* -------------------------------------------------------------------- router */

export const evaluateRouter: Router = Router();

evaluateRouter.post(
  '/',
  // Order matters: refuse on declared size, then on content type, then on the
  // spend cap — all before multer reads a single byte of the body.
  rejectOversizedBody,
  requireMultipart,
  capFastFail,
  parseUpload,
  handleEvaluate,
);

// Four-arity error middleware, scoped to this router. Turns intake failures
// into 413/400 and lets everything else fall through to the app handler.
evaluateRouter.use(uploadErrorHandler);
