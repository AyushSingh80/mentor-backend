/**
 * POST /drills/generate — a batch of practice prompts.
 * POST /drills/evaluate — one attempt in, a mark sheet out.
 *
 * Both plain JSON, both non-streaming, and that is a deliberate difference from
 * /evaluate, /mcq/generate and /ca/digest. Those three stream because they run
 * for minutes and a drop at ninety seconds would bill for everything and return
 * nothing. These are one short model call each — six prompts, or one mark sheet
 * — and a JSON body that either arrives or does not is the simpler contract for
 * work that finishes in fifteen seconds. Streaming has a real cost in client
 * complexity and it should be paid only where it buys something.
 *
 * ## The contract
 *
 * `app/src/lib/drill-types.ts` and `src/drills/types.ts` were written before
 * either half and are edited by neither. `tests/drill-contract.test.ts` and its
 * app-side counterpart feed one side's real output to the other side's real
 * parser, because Phases 3 and 4 both shipped with every field name different
 * across the wire while both packages' suites passed.
 */

import express, {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { requireCapability } from '../capability.js';
import { config } from '../config.js';
import { isPaper, rubricBody } from '../rubrics/index.js';
import { capStatus, recordUsage, releaseReservation, tryReserve } from '../usage.js';
import { compileEvaluatePrompt, compileGeneratePrompt } from '../drills/index.js';
import { runEvaluation, runGeneration } from '../drills/pipeline.js';
import {
  DRILL_EVALUATE_TIER,
  DRILL_GENERATE_TIER,
  currentEvaluateRunner,
  currentGenerateRunner,
  evaluateModel,
  generateModel,
} from '../drills/runner.js';
import {
  DRILL_KINDS,
  MAX_PART_CHARS,
  MAX_PARTS_PER_DRILL,
  MAX_PROMPT_CHARS,
  MAX_CASE_DETAIL_CHARS,
  PARTS_OF_KIND,
  RUBRIC_OF_KIND,
  isDrillKind,
  maxForKind,
  type DrillKind,
  type SubmittedPart,
} from '../drills/types.js';

/** Endpoint strings the ledger and the per-endpoint sub-cap key off. */
export const DRILLS_GENERATE_ENDPOINT = '/drills/generate';
export const DRILLS_EVALUATE_ENDPOINT = '/drills/evaluate';

const MAX_ID_CHARS = 128;
const MAX_SLUG_CHARS = 200;
const MAX_VOCABULARY_ENTRIES = 1000;
const MAX_EXCLUSIONS = 200;
/** One batch. Matches `DRILL_RULES.promptBatchSize` on the device. */
const MAX_PROMPTS_PER_BATCH = 12;

/**
 * JSON body parsing, mounted ON THESE ROUTES ONLY.
 *
 * Deliberately not `app.use(express.json())`: a global parser would sit in
 * front of /evaluate's multipart intake, whose staged size enforcement depends
 * on nothing having touched the request stream first. See routes/mcq.ts.
 *
 * The limit is larger than /mcq's 64kb because an evaluation body carries her
 * writing — five parts at up to 1600 characters, plus the case detail.
 */
const parseJsonBody = express.json({ limit: '128kb' });

function badRequest(detail: string): { error: string; detail: string } {
  return { error: 'bad_request', detail };
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max;
}

/* --------------------------------------------------------- generate: body */

export interface ParsedGenerateBody {
  requestId: string;
  want: { kind: DrillKind; count: number }[];
  vocabulary: { slug: string; label: string }[];
  excludePrompts: string[];
  promptVersion: string | null;
}

export function parseGenerateBody(raw: unknown): ParsedGenerateBody | string {
  const body = (raw ?? {}) as Record<string, unknown>;

  if (!isBoundedString(body.requestId, MAX_ID_CHARS)) return 'requestId is required';

  if (!Array.isArray(body.want)) return 'want must be an array of {kind, count}';
  if (body.want.length === 0) {
    // Not a formality: admitting it would reserve budget and make a model call
    // to deliver a guaranteed empty batch.
    return 'want must ask for at least one prompt';
  }

  const want: { kind: DrillKind; count: number }[] = [];
  const seenKinds = new Set<string>();
  for (const [index, entry] of body.want.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return `want[${index}] must be an object`;
    }
    const record = entry as Record<string, unknown>;
    if (!isDrillKind(record.kind)) {
      return `want[${index}].kind must be one of ${DRILL_KINDS.join('|')}`;
    }
    if (seenKinds.has(record.kind)) return `want[${index}] repeats kind ${record.kind}`;
    seenKinds.add(record.kind);

    const count = Number(record.count);
    if (!Number.isInteger(count) || count < 1 || count > MAX_PROMPTS_PER_BATCH) {
      return `want[${index}].count must be an integer between 1 and ${MAX_PROMPTS_PER_BATCH}`;
    }
    want.push({ kind: record.kind, count });
  }

  const total = want.reduce((sum, entry) => sum + entry.count, 0);
  if (total > MAX_PROMPTS_PER_BATCH) {
    return `want asks for ${total} prompts, over the batch ceiling of ${MAX_PROMPTS_PER_BATCH}`;
  }

  // The app owns the taxonomy and ships it on every request; the server may tag
  // only from it. Same rule, and the same reason, as `/ca/digest`.
  const vocabulary: { slug: string; label: string }[] = [];
  if (body.vocabulary !== undefined && body.vocabulary !== null) {
    if (!Array.isArray(body.vocabulary)) return 'vocabulary must be an array';
    if (body.vocabulary.length > MAX_VOCABULARY_ENTRIES) {
      return `vocabulary exceeds ${MAX_VOCABULARY_ENTRIES} entries`;
    }
    const seen = new Set<string>();
    for (const entry of body.vocabulary) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        return 'vocabulary entries must be objects with a slug';
      }
      const record = entry as Record<string, unknown>;
      if (!isBoundedString(record.slug, MAX_SLUG_CHARS)) {
        return 'vocabulary entries must each have a string slug';
      }
      const slug = record.slug.trim();
      if (seen.has(slug)) continue;
      seen.add(slug);
      vocabulary.push({
        slug,
        label: isBoundedString(record.label, MAX_SLUG_CHARS) ? record.label.trim() : slug,
      });
    }
  }

  const excludePrompts: string[] = [];
  if (body.excludePrompts !== undefined && body.excludePrompts !== null) {
    if (!Array.isArray(body.excludePrompts)) return 'excludePrompts must be an array of strings';
    if (body.excludePrompts.length > MAX_EXCLUSIONS) {
      return `excludePrompts exceeds ${MAX_EXCLUSIONS} entries`;
    }
    for (const entry of body.excludePrompts) {
      if (typeof entry !== 'string') return 'excludePrompts must contain only strings';
      const trimmed = entry.trim();
      if (trimmed !== '' && trimmed.length <= MAX_PROMPT_CHARS) excludePrompts.push(trimmed);
    }
  }

  return {
    requestId: body.requestId,
    want,
    vocabulary,
    excludePrompts,
    promptVersion: isBoundedString(body.promptVersion, MAX_ID_CHARS) ? body.promptVersion : null,
  };
}

/* --------------------------------------------------------- evaluate: body */

export interface ParsedEvaluateBody {
  requestId: string;
  kind: DrillKind;
  promptText: string;
  caseDetail: string | null;
  parts: SubmittedPart[];
}

export function parseEvaluateBody(raw: unknown): ParsedEvaluateBody | string {
  const body = (raw ?? {}) as Record<string, unknown>;

  if (!isBoundedString(body.requestId, MAX_ID_CHARS)) return 'requestId is required';
  if (!isDrillKind(body.kind)) return `kind must be one of ${DRILL_KINDS.join('|')}`;
  if (!isBoundedString(body.promptText, MAX_PROMPT_CHARS)) return 'promptText is required';

  const kind = body.kind;
  const rawDetail = body.caseDetail;
  if (rawDetail !== undefined && rawDetail !== null && typeof rawDetail !== 'string') {
    return 'caseDetail must be a string or null';
  }
  const caseDetail =
    typeof rawDetail === 'string' && rawDetail.trim() !== '' ? rawDetail.trim() : null;
  if (caseDetail !== null && caseDetail.length > MAX_CASE_DETAIL_CHARS) {
    return `caseDetail exceeds ${MAX_CASE_DETAIL_CHARS} characters`;
  }
  if (kind === 'ethics_case' && caseDetail === null) {
    // Marking a case without its situation is marking a different question.
    // Every option's merits turn on facts that would not be in the payload.
    return 'caseDetail is required for an ethics_case';
  }

  if (!Array.isArray(body.parts)) return 'parts must be an array of {part, content}';
  const allowed = PARTS_OF_KIND[kind];
  const parts: SubmittedPart[] = [];
  const seen = new Set<string>();

  for (const [index, entry] of body.parts.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return `parts[${index}] must be an object`;
    }
    const record = entry as Record<string, unknown>;
    const part = record.part;
    if (typeof part !== 'string' || !(allowed as readonly string[]).includes(part)) {
      return `parts[${index}].part must be one of ${allowed.join('|')}`;
    }
    if (seen.has(part)) return `parts[${index}] repeats ${part}`;
    seen.add(part);
    if (!isBoundedString(record.content, MAX_PART_CHARS)) {
      return `parts[${index}].content is required and must be under ${MAX_PART_CHARS} characters`;
    }
    parts.push({ part: part as SubmittedPart['part'], content: record.content.trim() });
  }

  if (parts.length === 0) return 'parts must contain at least one part';
  if (parts.length > MAX_PARTS_PER_DRILL) return `parts exceeds ${MAX_PARTS_PER_DRILL}`;
  if (parts.length !== allowed.length) {
    // A partial submission is refused rather than partially marked. She would
    // read three scores out of a total that assumed five, and no number on the
    // screen would be the one she thinks it is.
    return `a ${kind} has ${allowed.length} parts; ${parts.length} were sent`;
  }

  // Declared order, so the payload and the mark sheet always agree.
  parts.sort(
    (a, b) => (allowed as readonly string[]).indexOf(a.part) - (allowed as readonly string[]).indexOf(b.part),
  );

  return { requestId: body.requestId, kind, promptText: body.promptText.trim(), caseDetail, parts };
}

/* ------------------------------------------------------------- cap helper */

function capFastFail(endpoint: string): RequestHandler {
  return async (_req, res, next) => {
    const preCheck = await capStatus({ endpoint });
    if (!preCheck.allowed) {
      res.status(429).json({ error: 'spend_cap_reached', detail: preCheck.reason, caps: preCheck });
      return;
    }
    next();
  };
}

/* ---------------------------------------------------------------- handlers */

const handleGenerate: RequestHandler = async (req, res) => {
  const parsed = parseGenerateBody(req.body);
  if (typeof parsed === 'string') {
    res.status(400).json(badRequest(parsed));
    return;
  }

  const prompt = await compileGeneratePrompt();
  const model = generateModel();
  const total = parsed.want.reduce((sum, entry) => sum + entry.count, 0);

  const reservation = {
    endpoint: DRILLS_GENERATE_ENDPOINT,
    estimateUsd: total * config.caps.estimatedDrillUsdPerPrompt,
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
        want: parsed.want,
        vocabulary: parsed.vocabulary,
        excludePrompts: parsed.excludePrompts,
        model,
        system: prompt.systemPrompt,
      },
      {
        generate: currentGenerateRunner(),
        signal: controller.signal,
        log: (message) => console.log(message),
      },
    );

    await recordUsage({
      endpoint: DRILLS_GENERATE_ENDPOINT,
      tier: DRILL_GENERATE_TIER,
      model,
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
      cacheCreationInputTokens: outcome.usage.cacheCreationInputTokens,
      cacheReadInputTokens: outcome.usage.cacheReadInputTokens,
    }).catch((err) => console.error('[drills] usage write failed', err));

    const caps = await capStatus({ endpoint: DRILLS_GENERATE_ENDPOINT });
    res.json({
      requestId: parsed.requestId,
      batchId: parsed.requestId,
      model,
      promptVersion: prompt.version,
      provenance: outcome.provenance,
      prompts: outcome.prompts.map((entry) => ({
        kind: entry.kind,
        promptText: entry.promptText,
        caseDetail: entry.caseDetail,
        syllabusSlug: entry.syllabusSlug,
        why: entry.why,
      })),
      summary: outcome.summary,
      usage: {
        inputTokens: outcome.usage.inputTokens,
        outputTokens: outcome.usage.outputTokens,
        cacheCreationInputTokens: outcome.usage.cacheCreationInputTokens,
        cacheReadInputTokens: outcome.usage.cacheReadInputTokens,
        monthUsd: Number(caps.monthUsd.toFixed(2)),
        monthlyCapUsd: caps.monthlyCapUsd,
        drillsMonthUsd: Number(caps.drillsMonthUsd.toFixed(2)),
        drillsMonthlyCapUsd: caps.drillsMonthlyCapUsd,
      },
    });
  } catch (err) {
    console.error('[drills]', err);
    if (!res.headersSent) {
      // Never echoes err.message; the detail is in the server log above.
      res.status(502).json({ error: 'generation_failed', detail: 'Check the server logs.' });
    }
  } finally {
    releaseReservation(reservation);
    res.off('close', onClose);
  }
};

const handleEvaluate: RequestHandler = async (req, res) => {
  const parsed = parseEvaluateBody(req.body);
  if (typeof parsed === 'string') {
    res.status(400).json(badRequest(parsed));
    return;
  }

  const paper = RUBRIC_OF_KIND[parsed.kind] === 'essay' ? 'essay' : 'gs4';
  if (!isPaper(paper)) {
    res.status(500).json({ error: 'internal_error' });
    return;
  }

  const rubric = await rubricBody(paper);
  const prompt = await compileEvaluatePrompt(rubric.body);
  const model = evaluateModel();

  const reservation = {
    endpoint: DRILLS_EVALUATE_ENDPOINT,
    estimateUsd: config.caps.estimatedDrillEvalUsd,
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
    const outcome = await runEvaluation(
      {
        requestId: parsed.requestId,
        kind: parsed.kind,
        promptText: parsed.promptText,
        caseDetail: parsed.caseDetail,
        parts: parsed.parts,
        model,
        system: prompt.systemPrompt,
      },
      {
        evaluate: currentEvaluateRunner(),
        signal: controller.signal,
        log: (message) => console.log(message),
      },
    );

    // Billed BEFORE the null check. A truncated reply is unusable and still
    // costs money; a ledger that only records successes under-counts the month
    // and the cap stops binding.
    await recordUsage({
      endpoint: DRILLS_EVALUATE_ENDPOINT,
      tier: DRILL_EVALUATE_TIER,
      model,
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
      cacheCreationInputTokens: outcome.usage.cacheCreationInputTokens,
      cacheReadInputTokens: outcome.usage.cacheReadInputTokens,
    }).catch((err) => console.error('[drills] usage write failed', err));

    if (outcome.evaluation === null) {
      res.status(502).json({
        error: 'evaluation_failed',
        detail: outcome.error ?? 'The marking reply could not be read.',
      });
      return;
    }

    const caps = await capStatus({ endpoint: DRILLS_EVALUATE_ENDPOINT });
    res.json({
      requestId: parsed.requestId,
      kind: parsed.kind,
      model,
      promptVersion: prompt.version,
      rubricVersion: rubric.version,
      provenance: outcome.provenance,
      verdicts: outcome.evaluation.verdicts,
      total: outcome.evaluation.total,
      max: maxForKind(parsed.kind),
      highestLeverageFix: outcome.evaluation.highestLeverageFix,
      feedbackMarkdown: outcome.evaluation.feedbackMd,
      usage: {
        inputTokens: outcome.usage.inputTokens,
        outputTokens: outcome.usage.outputTokens,
        cacheCreationInputTokens: outcome.usage.cacheCreationInputTokens,
        cacheReadInputTokens: outcome.usage.cacheReadInputTokens,
        monthUsd: Number(caps.monthUsd.toFixed(2)),
        monthlyCapUsd: caps.monthlyCapUsd,
        drillsMonthUsd: Number(caps.drillsMonthUsd.toFixed(2)),
        drillsMonthlyCapUsd: caps.drillsMonthlyCapUsd,
      },
    });
  } catch (err) {
    console.error('[drills]', err);
    if (!res.headersSent) {
      res.status(502).json({ error: 'evaluation_failed', detail: 'Check the server logs.' });
    }
  } finally {
    releaseReservation(reservation);
    res.off('close', onClose);
  }
};

/* -------------------------------------------------------------------- router */

/**
 * Four-arity error middleware for the JSON intake, scoped to this router.
 *
 * `express.json` throws on a malformed or over-large body; without this those
 * become a generic 500 and the client cannot tell a typo from an outage.
 */
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
    res.status(413).json({ error: 'payload_too_large', detail: 'Request body exceeds 128kb.' });
    return;
  }
  if (candidate?.type === 'entity.parse.failed' || candidate?.status === 400) {
    res.status(400).json(badRequest('malformed JSON body'));
    return;
  }
  next(err);
}

export const drillsRouter: Router = Router();

drillsRouter.post(
  '/generate',
  parseJsonBody,
  requireCapability('bulk'),
  capFastFail(DRILLS_GENERATE_ENDPOINT),
  handleGenerate,
);
drillsRouter.post(
  '/evaluate',
  parseJsonBody,
  // Marking is evaluation tier; setting a prompt is bulk. Guarding at the
  // mount would have applied one tier to both.
  requireCapability('evaluation'),
  capFastFail(DRILLS_EVALUATE_ENDPOINT),
  handleEvaluate,
);

drillsRouter.use(jsonErrorHandler);
