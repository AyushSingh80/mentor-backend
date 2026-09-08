/**
 * Evaluation orchestration — the seam between capture and the server.
 *
 * The types below are the frozen contract between the New Answer screen and
 * the evaluation pipeline. Do not change the exported signatures.
 *
 * Behavioural contract, all of it load-bearing:
 *
 * 1. `createAnswer` runs FIRST, always, before any network call. An answer
 *    captured on the train with no signal must be durably saved and appear in
 *    History as pending. This is the whole offline requirement.
 * 2. `runEvaluation` NEVER rejects. Every failure path calls `onFailed` and
 *    returns, so the screen needs no try/catch.
 * 3. Completion is confirmed by the terminal `done` frame (api.ts now surfaces
 *    it via `onDone`). If `evaluateAnswer` resolves without both `scores` and
 *    `done` having fired, the stream was truncated: mark the answer 'failed'
 *    rather than saving a partial evaluation as if it were complete.
 * 4. On success, `saveEvaluation` writes the evaluation, its dimensions and the
 *    answer's 'evaluated' status in one transaction.
 * 5. On a network failure or no configured server, the phase is 'offline' and
 *    the answer becomes 'queued' — retryable, never lost.
 * 6. `onError` from the stream is terminal. Never also call `onDone`.
 * 7. `evaluateAnswer` has NO timeout (an evaluation legitimately takes
 *    minutes), so this layer must arm its own: a connect timer (~20s) cleared
 *    on the first `onMeta`, and an idle timer (~90s) reset on every `onToken`.
 *    Without them a captive portal hangs the submit screen forever.
 *
 * ---------------------------------------------------------------------------
 * The `syncStatus` state machine this file implements, in full:
 *
 *   (no row) --createAnswer--> pending
 *   pending  --saveEvaluation (transactional)--> evaluated     [terminal]
 *   pending  --transport failure / unconfigured / timeout / cancel--> queued
 *   pending  --stream `error` frame--> failed
 *   pending  --stream truncated (no scores or no done)--> failed
 *   pending  --saveEvaluation threw--> failed
 *   queued|failed --retryAnswer (queue.ts)--> re-enters the same machine
 *
 * `pendingAnswers()` selects pending | queued | failed, so every non-terminal
 * state is visible in the offline queue and retryable. The only status this
 * file never writes is 'pending' — `createAnswer` owns that.
 *
 * The split between 'queued' and 'failed' is the split between "the network
 * did not happen" and "the network happened and went wrong". Only the second
 * needs the user to change something before retrying, and only the second is
 * worth showing as an error rather than as a queue entry.
 * ---------------------------------------------------------------------------
 */

import { createAnswer, saveEvaluation, setSyncStatus, type PaperValue } from '@/db/answers';
import { ApiError, evaluateAnswer, type EvaluationMeta, type EvaluationScores } from '@/lib/api';
import { toEvaluationInput } from '@/lib/evaluation-map';
import type { CapturedFile } from '@/lib/scan-rules';

export type EvaluationPhase =
  | 'idle'
  | 'saving'
  | 'uploading'
  | 'streaming'
  | 'scoring'
  | 'saved'
  | 'failed'
  | 'offline';

export interface RunEvaluationInput {
  paper: PaperValue;
  question: string;
  directiveWord?: string;
  wordLimit: number;
  pages: CapturedFile[];
  previousAttempt?: string;
  signal?: AbortSignal;
}

export interface RunEvaluationResult {
  answerId: number;
  evaluationId: number;
  /** 0–100, normalised so papers with different maxima are comparable. */
  percent: number | null;
}

export interface RunEvaluationCallbacks {
  onPhase?: (phase: EvaluationPhase) => void;
  /** Fires as soon as the answer is durably saved, before any network call. */
  onAnswerCreated?: (answerId: number) => void;
  onMeta?: (meta: EvaluationMeta) => void;
  onToken?: (text: string) => void;
  onDone?: (result: RunEvaluationResult) => void;
  onFailed?: (reason: string, answerId: number | null) => void;
}

/**
 * How long the request may take to produce its first `meta` frame.
 *
 * Deliberately generous: `meta` is sent only after the whole multipart body has
 * reached the server, so this window covers reading up to 25MB off disk and
 * uploading it. Deliberately finite: without it, a captive portal that accepts
 * the connection and then black-holes it leaves the submit screen spinning
 * until the OS socket timeout, which is minutes.
 */
const CONNECT_TIMEOUT_MS = 20_000;

/**
 * How long the stream may go silent once it has started.
 *
 * Reset on every token. Generation legitimately runs for minutes, so the
 * ceiling is on the gap between tokens, never on the total.
 */
const IDLE_TIMEOUT_MS = 90_000;

const CONNECT_TIMEOUT_REASON =
  'The server did not respond within 20 seconds. The answer is saved and queued for retry.';
const IDLE_TIMEOUT_REASON =
  'The evaluation stalled mid-stream. The answer is saved and queued for retry.';
const CANCELLED_REASON = 'Evaluation cancelled. The answer is saved and queued for retry.';
const TRUNCATED_REASON = 'The evaluation stream ended early.';

/**
 * Everything `runEvaluation` needs once the answer row exists.
 *
 * Exported so `queue.ts` can retry a stored answer through exactly this code
 * path without creating a second `answers` row. It is an addition to the
 * module's surface, not a change to any frozen signature: a retry that
 * re-implemented the ordering, the timers and the status transitions would be a
 * second state machine to keep in step with this one.
 */
export interface EvaluateExistingInput {
  answerId: number;
  paper: PaperValue;
  question: string;
  directiveWord?: string;
  wordLimit: number;
  pages: CapturedFile[];
  previousAttempt?: string;
  signal?: AbortSignal;
}

export interface PendingItem {
  answerId: number;
  paper: string;
  questionText: string;
  createdAt: string;
  syncStatus: string;
  pageCount: number;
}

/* ------------------------------------------------------------------ helpers */

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const text = String(error);
  return text === '' || text === '[object Object]' ? 'Unknown error.' : text;
}

function isAbortLike(error: unknown): boolean {
  const name = (error as { name?: unknown } | null | undefined)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/**
 * True when the failure means the request never completed a round trip, so
 * retrying later is the right and sufficient response.
 *
 * An `ApiError` with no status never reached a responding server: it is either
 * an unconfigured device or a dead socket. An `ApiError` with a status means
 * the server answered, so the network is fine and the problem is real —
 * except for 408/429/5xx, which are the server itself saying "later".
 */
function isRetryableTransportFailure(error: unknown): boolean {
  if (error instanceof ApiError) {
    if (error.status === undefined) return true;
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  if (isAbortLike(error)) return true;
  // `expo/fetch` surfaces an unreachable host as a bare TypeError.
  return error instanceof TypeError;
}

/**
 * A status write that must never become the reason an evaluation is lost.
 *
 * The answer row is already durable at this point; failing to update its status
 * leaves it as 'pending', which `pendingAnswers()` still selects. Rethrowing
 * would turn a cosmetic problem into a rejected promise out of a function whose
 * whole contract is that it does not reject.
 */
async function markStatus(
  answerId: number,
  status: 'queued' | 'failed',
): Promise<void> {
  try {
    await setSyncStatus(answerId, status);
  } catch {
    // Intentionally swallowed; see above.
  }
}

/* ------------------------------------------------------------------- public */

export async function runEvaluation(
  input: RunEvaluationInput,
  callbacks: RunEvaluationCallbacks,
): Promise<void> {
  // 1. Durably save FIRST. Not after validation, not after a connectivity
  //    probe, not concurrently with the upload. If the process dies on the next
  //    line, the answer is still in History.
  callbacks.onPhase?.('saving');

  let answerId: number;
  try {
    answerId = await createAnswer({
      paper: input.paper,
      questionText: input.question,
      ...(input.directiveWord === undefined ? {} : { directiveWord: input.directiveWord }),
      wordLimit: input.wordLimit,
      imagePaths: input.pages.map((page) => page.uri),
    });
  } catch (error) {
    // Nothing was written, so there is no id to report and nothing to retry.
    callbacks.onPhase?.('failed');
    callbacks.onFailed?.(`Could not save the answer to this device: ${messageOf(error)}`, null);
    return;
  }

  callbacks.onAnswerCreated?.(answerId);

  await evaluateExistingAnswer({ ...input, answerId }, callbacks);
}

/**
 * Runs the network half of an evaluation against an answer row that already
 * exists. Never rejects; every failure path calls `onFailed`.
 */
export async function evaluateExistingAnswer(
  input: EvaluateExistingInput,
  callbacks: RunEvaluationCallbacks,
): Promise<void> {
  const { answerId } = input;

  // Observed stream state. A truncated stream and a clean one are only
  // distinguishable by these fields: `evaluateAnswer` resolves either way.
  //
  // Held on one mutable record rather than in four `let`s because TypeScript's
  // control-flow analysis narrows a `let` assigned only inside a callback to
  // its initialiser — `meta` would be `never` at the completeness check below,
  // and the check would silently compile to nothing.
  const observed: {
    meta: EvaluationMeta | null;
    scores: { scores: EvaluationScores | null; feedbackMarkdown: string } | null;
    done: boolean;
    error: string | null;
  } = { meta: null, scores: null, done: false, error: null };

  // 7. Timers. `evaluateAnswer` has none by design, so they live here, on the
  //    same holder-record trick and for the same reason.
  const controller = new AbortController();
  const timers: {
    connect: ReturnType<typeof setTimeout> | null;
    idle: ReturnType<typeof setTimeout> | null;
    /** Set by whichever timer fired, so the abort can be told apart from a cancel. */
    reason: string | null;
  } = { connect: null, idle: null, reason: null };

  const clearConnectTimer = () => {
    if (timers.connect !== null) {
      clearTimeout(timers.connect);
      timers.connect = null;
    }
  };

  const clearIdleTimer = () => {
    if (timers.idle !== null) {
      clearTimeout(timers.idle);
      timers.idle = null;
    }
  };

  const resetIdleTimer = () => {
    clearIdleTimer();
    timers.idle = setTimeout(() => {
      timers.reason = IDLE_TIMEOUT_REASON;
      controller.abort();
    }, IDLE_TIMEOUT_MS);
  };

  const external = input.signal;
  const onExternalAbort = () => controller.abort();

  let transportError: unknown = null;

  try {
    callbacks.onPhase?.('uploading');

    // Chain the caller's signal into ours rather than passing it through:
    // the timers need their own controller, and handing `evaluateAnswer` the
    // external signal instead would make our timeouts unable to abort anything.
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener('abort', onExternalAbort, { once: true });
    }

    timers.connect = setTimeout(() => {
      timers.reason = CONNECT_TIMEOUT_REASON;
      controller.abort();
    }, CONNECT_TIMEOUT_MS);

    await evaluateAnswer(
      {
        paper: input.paper,
        question: input.question,
        ...(input.directiveWord === undefined ? {} : { directiveWord: input.directiveWord }),
        wordLimit: input.wordLimit,
        ...(input.previousAttempt === undefined ? {} : { previousAttempt: input.previousAttempt }),
        files: input.pages.map((page) => ({ uri: page.uri, name: page.name, type: page.type })),
        signal: controller.signal,
      },
      {
        onMeta: (value) => {
          observed.meta = value;
          // The server has the whole upload and has started work: the connect
          // window is over and the idle window begins.
          clearConnectTimer();
          resetIdleTimer();
          callbacks.onPhase?.('streaming');
          callbacks.onMeta?.(value);
        },
        onToken: (text) => {
          resetIdleTimer();
          callbacks.onToken?.(text);
        },
        onScores: (payload) => {
          resetIdleTimer();
          observed.scores = { scores: payload.scores, feedbackMarkdown: payload.feedbackMarkdown };
          callbacks.onPhase?.('scoring');
        },
        onDone: () => {
          observed.done = true;
        },
        // 6. Terminal. Recorded, never acted on mid-stream, and it outranks
        //    everything else once the stream ends.
        onError: (message) => {
          observed.error = message;
        },
      },
    );
  } catch (error) {
    transportError = error;
  } finally {
    // Both timers, on every path. A leaked idle timer would abort a controller
    // nothing is listening to 90 seconds after the screen moved on — harmless
    // today, and exactly the kind of thing that stops being harmless later.
    clearConnectTimer();
    clearIdleTimer();
    external?.removeEventListener('abort', onExternalAbort);
  }

  // 5. The request never completed a round trip: queue it.
  if (transportError !== null) {
    // A caller-driven abort and a timer-driven one arrive identically; only
    // these two flags say which happened.
    const reason = external?.aborted
      ? CANCELLED_REASON
      : (timers.reason ?? describeTransportFailure(transportError));

    if (timers.reason !== null || external?.aborted || isRetryableTransportFailure(transportError)) {
      await markStatus(answerId, 'queued');
      callbacks.onPhase?.('offline');
      callbacks.onFailed?.(reason, answerId);
      return;
    }

    // The server answered and refused. Retrying unchanged will refuse again.
    await markStatus(answerId, 'failed');
    callbacks.onPhase?.('failed');
    callbacks.onFailed?.(reason, answerId);
    return;
  }

  // 6. An `error` frame replaces `done`. It outranks a scores frame that may
  //    have arrived before the server gave up.
  if (observed.error !== null) {
    await markStatus(answerId, 'failed');
    callbacks.onPhase?.('failed');
    callbacks.onFailed?.(observed.error, answerId);
    return;
  }

  // 3. Resolved without the frames that prove completion. `meta` is checked
  //    alongside them because `model` and `rubricVersion` are only knowable
  //    from it, and a stream that never sent one never really started.
  if (observed.meta === null || observed.scores === null || !observed.done) {
    await markStatus(answerId, 'failed');
    callbacks.onPhase?.('failed');
    callbacks.onFailed?.(TRUNCATED_REASON, answerId);
    return;
  }

  // 4. One transaction: the evaluation, its dimensions, and 'evaluated'.
  //    Mapping and writing share a try, so a surprise from either one lands on
  //    `onFailed` rather than rejecting out of a function whose contract says
  //    the screen needs no try/catch.
  let evaluationId: number;
  let evaluationInput: ReturnType<typeof toEvaluationInput>;
  try {
    evaluationInput = toEvaluationInput({
      answerId,
      meta: observed.meta,
      scores: observed.scores.scores,
      feedbackMarkdown: observed.scores.feedbackMarkdown,
      wordLimit: input.wordLimit,
      paper: input.paper,
    });
    evaluationId = await saveEvaluation(evaluationInput);
  } catch (error) {
    await markStatus(answerId, 'failed');
    callbacks.onPhase?.('failed');
    callbacks.onFailed?.(`Could not save the evaluation: ${messageOf(error)}`, answerId);
    return;
  }

  callbacks.onPhase?.('saved');
  callbacks.onDone?.({
    answerId,
    evaluationId,
    // Mirrors `toPercent` in answers.ts exactly, including the null when the
    // score block was unparseable and `max` came out as 0.
    percent: evaluationInput.max > 0 ? (evaluationInput.total / evaluationInput.max) * 100 : null,
  });
}

/**
 * Turns a thrown error into something worth showing.
 *
 * The failure the user can act on is almost never the one the stack trace
 * describes, so the two cases that are actually actionable — an unconfigured or
 * unreachable server, and a rejected token — say what to do about it.
 */
function describeTransportFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === undefined) {
      // Covers both "Server is not configured yet." and a dead socket; the
      // message from api.ts already says which.
      return `${error.message} The answer is saved and queued for retry.`;
    }
    if (error.status === 401 || error.status === 403) {
      return 'The server rejected this device’s token. Re-enter it in onboarding, then retry from History.';
    }
    return error.message;
  }
  return `Could not reach the server: ${messageOf(error)} The answer is saved and queued for retry.`;
}
