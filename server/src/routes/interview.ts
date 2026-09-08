/**
 * POST /interview/questions — her DAF in, the questions a board would ask out.
 *
 * Plain JSON, one short model call. Same reasoning as `/drills/*`: streaming
 * has a real cost in client complexity and should be paid only where it buys
 * something, and this finishes in fifteen seconds.
 *
 * ## What this endpoint holds
 *
 * Her name, her home district, her employer. That is the most personal payload
 * any endpoint here handles, and three things follow from it: the entries are
 * NEVER persisted server-side, they are never logged, and the response contains
 * no field a fact could travel back in. See `interview/types.ts`.
 */

import express, {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { config } from '../config.js';
import { capStatus, recordUsage, releaseReservation, tryReserve } from '../usage.js';
import { compileInterviewPrompt } from '../interview/index.js';
import { runGeneration } from '../interview/pipeline.js';
import {
  INTERVIEW_TIER,
  currentInterviewRunner,
  interviewModel,
} from '../interview/runner.js';
import {
  DAF_FIELDS,
  MAX_ENTRIES,
  MAX_QUESTIONS_PER_BATCH,
  MAX_QUESTION_CHARS,
  MAX_VALUE_CHARS,
  isDafField,
  type DafEntryInput,
} from '../interview/types.js';

export const INTERVIEW_ENDPOINT = '/interview/questions';

const MAX_ID_CHARS = 128;
const MAX_EXCLUSIONS = 300;
const DEFAULT_TAKE = 8;

/** Mounted on this route only — see routes/mcq.ts for why it is not global. */
const parseJsonBody = express.json({ limit: '64kb' });

function badRequest(detail: string): { error: string; detail: string } {
  return { error: 'bad_request', detail };
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max;
}

export interface ParsedBody {
  requestId: string;
  entries: DafEntryInput[];
  excludeQuestions: string[];
  take: number;
  promptVersion: string | null;
}

export function parseInterviewBody(raw: unknown): ParsedBody | string {
  const body = (raw ?? {}) as Record<string, unknown>;

  if (!isBoundedString(body.requestId, MAX_ID_CHARS)) return 'requestId is required';

  if (!Array.isArray(body.entries)) return 'entries must be an array of {field, value}';
  if (body.entries.length === 0) {
    // Not a formality: with no entries there is nothing to generate from, and
    // admitting it would reserve budget and make a call to produce either
    // nothing or an invented biography.
    return 'entries must contain at least one filled DAF field';
  }
  if (body.entries.length > MAX_ENTRIES) return `entries exceeds ${MAX_ENTRIES}`;

  const entries: DafEntryInput[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of body.entries.entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return `entries[${index}] must be an object`;
    }
    const entry = raw as Record<string, unknown>;
    if (!isDafField(entry.field)) {
      return `entries[${index}].field must be one of ${DAF_FIELDS.join('|')}`;
    }
    if (seen.has(entry.field)) return `entries[${index}] repeats ${entry.field}`;
    seen.add(entry.field);
    if (!isBoundedString(entry.value, MAX_VALUE_CHARS)) {
      return `entries[${index}].value is required and must be under ${MAX_VALUE_CHARS} characters`;
    }
    entries.push({ field: entry.field, value: entry.value.trim() });
  }

  const excludeQuestions: string[] = [];
  if (body.excludeQuestions !== undefined && body.excludeQuestions !== null) {
    if (!Array.isArray(body.excludeQuestions)) {
      return 'excludeQuestions must be an array of strings';
    }
    if (body.excludeQuestions.length > MAX_EXCLUSIONS) {
      return `excludeQuestions exceeds ${MAX_EXCLUSIONS} entries`;
    }
    for (const entry of body.excludeQuestions) {
      if (typeof entry !== 'string') return 'excludeQuestions must contain only strings';
      const trimmed = entry.trim();
      if (trimmed !== '' && trimmed.length <= MAX_QUESTION_CHARS) excludeQuestions.push(trimmed);
    }
  }

  const take = body.take === undefined ? DEFAULT_TAKE : Number(body.take);
  if (!Number.isInteger(take) || take < 1 || take > MAX_QUESTIONS_PER_BATCH) {
    return `take must be an integer between 1 and ${MAX_QUESTIONS_PER_BATCH}`;
  }

  return {
    requestId: body.requestId,
    entries,
    excludeQuestions,
    take,
    promptVersion: isBoundedString(body.promptVersion, MAX_ID_CHARS) ? body.promptVersion : null,
  };
}

const capFastFail: RequestHandler = async (_req, res, next) => {
  const preCheck = await capStatus({ endpoint: INTERVIEW_ENDPOINT });
  if (!preCheck.allowed) {
    res.status(429).json({ error: 'spend_cap_reached', detail: preCheck.reason, caps: preCheck });
    return;
  }
  next();
};

const handleQuestions: RequestHandler = async (req, res) => {
  const parsed = parseInterviewBody(req.body);
  if (typeof parsed === 'string') {
    res.status(400).json(badRequest(parsed));
    return;
  }

  const prompt = await compileInterviewPrompt();
  const model = interviewModel();

  const reservation = {
    endpoint: INTERVIEW_ENDPOINT,
    estimateUsd: config.caps.estimatedInterviewUsd,
    units: 1,
  };
  const admitted = await tryReserve(reservation);
  if (!admitted.ok) {
    res
      .status(429)
      .json({ error: 'spend_cap_reached', detail: admitted.caps.reason, caps: admitted.caps });
    return;
  }

  const controller = new AbortController();
  const onClose = (): void => controller.abort();
  res.on('close', onClose);

  try {
    const outcome = await runGeneration(
      {
        requestId: parsed.requestId,
        entries: parsed.entries,
        excludeQuestions: parsed.excludeQuestions,
        take: parsed.take,
        model,
        system: prompt.systemPrompt,
      },
      {
        generate: currentInterviewRunner(),
        signal: controller.signal,
        // The DROP is logged, never the entry. A log line carrying her home
        // district would put the most personal payload this server handles
        // into a file that outlives the request.
        log: (message) => console.log(message),
      },
    );

    await recordUsage({
      endpoint: INTERVIEW_ENDPOINT,
      tier: INTERVIEW_TIER,
      model,
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
      cacheCreationInputTokens: outcome.usage.cacheCreationInputTokens,
      cacheReadInputTokens: outcome.usage.cacheReadInputTokens,
    }).catch((err) => console.error('[interview] usage write failed', err));

    const caps = await capStatus({ endpoint: INTERVIEW_ENDPOINT });
    res.json({
      requestId: parsed.requestId,
      batchId: parsed.requestId,
      model,
      promptVersion: prompt.version,
      provenance: outcome.provenance,
      questions: outcome.questions.map((entry) => ({
        field: entry.field,
        area: entry.area,
        question: entry.question,
        likelihood: entry.likelihood,
      })),
      summary: outcome.summary,
      usage: {
        inputTokens: outcome.usage.inputTokens,
        outputTokens: outcome.usage.outputTokens,
        monthUsd: Number(caps.monthUsd.toFixed(2)),
        monthlyCapUsd: caps.monthlyCapUsd,
      },
    });
  } catch (err) {
    console.error('[interview]', err);
    if (!res.headersSent) {
      res.status(502).json({ error: 'generation_failed', detail: 'Check the server logs.' });
    }
  } finally {
    releaseReservation(reservation);
    res.off('close', onClose);
  }
};

export function jsonErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  const candidate = err as { type?: string; status?: number };
  if (candidate?.type === 'entity.too.large') {
    res.status(413).json({ error: 'payload_too_large', detail: 'Request body exceeds 64kb.' });
    return;
  }
  if (candidate?.type === 'entity.parse.failed' || candidate?.status === 400) {
    res.status(400).json(badRequest('malformed JSON body'));
    return;
  }
  next(err);
}

export const interviewRouter: Router = Router();
interviewRouter.post('/questions', parseJsonBody, capFastFail, handleQuestions);
interviewRouter.use(jsonErrorHandler);
