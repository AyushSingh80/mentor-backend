/**
 * POST /mcq/generate — a topic in, validated practice questions out.
 *
 * Events emitted, in order:
 *
 *   meta     { model, promptVersion, verifierVersion, requested, ... }
 *   question { ...one banked question }        (0..N, never more than asked)
 *   summary  { requested, delivered, rejections, keyDisagreements, ... }
 *   usage    { inputTokens, outputTokens, estCostUsd, monthUsd }
 *   done     { ok: true }
 *   error    { message }                        (terminal, replaces done)
 *
 * WHY SSE AND NOT JSON: a batch is inherently incremental. Twenty questions
 * across four chunks takes a couple of minutes, and a JSON response that drops
 * at ninety seconds of a hundred and fifty returns nothing while having billed
 * for everything — on a phone, on mobile data, which is where this is used. A
 * question that has cleared the pipeline is finished work and belongs on the
 * wire immediately.
 *
 * A `question` frame is a PROMISE: it has passed every structural check, its
 * key has been recomputed from its own statement verdicts, and a second model
 * that never saw the key answered it the same way. Nothing partially checked
 * is ever emitted.
 */

import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { config, estimateCostUsd } from '../config.js';
import { isPaper } from '../rubrics/index.js';
import { SseStream, clientHasDisconnected } from '../sse.js';
import { capStatus, recordUsage, releaseReservation, tryReserve } from '../usage.js';
import {
  compileGenerationPrompt,
  compileVerifierPrompt,
} from '../mcq/index.js';
import {
  CHUNK_SIZE,
  MAX_COUNT,
  MIN_COUNT,
  plannedChunksFor,
  runMcqPipeline,
} from '../mcq/pipeline.js';
import {
  MCQ_TIER,
  currentMcqRunner,
  currentVerificationRunner,
  mcqModel,
} from '../mcq/runner.js';
import { type Difficulty, isDifficulty } from '../mcq/types.js';

/** Endpoint string the ledger and the per-endpoint sub-cap key off. */
export const MCQ_ENDPOINT = '/mcq/generate';

const MAX_ID_CHARS = 128;
const MAX_LABEL_CHARS = 200;
/** Enough for a large existing bank without letting the body become a weapon. */
const MAX_EXCLUSIONS = 1000;

/**
 * JSON body parsing, mounted ON THIS ROUTE ONLY.
 *
 * Deliberately not `app.use(express.json())`. A global JSON parser would sit
 * in front of /evaluate's multipart intake, and the carefully staged
 * size enforcement in upload.ts — refuse on Content-Length, then count bytes
 * per chunk while streaming — depends on nothing having touched the request
 * stream first.
 */
const parseJsonBody = express.json({ limit: '64kb' });

function badRequest(detail: string): { error: string; detail: string } {
  return { error: 'bad_request', detail };
}

/** Advisory fast-fail, matching /evaluate. The reservation below is truth. */
const capFastFail: RequestHandler = async (_req, res, next) => {
  const preCheck = await capStatus({ endpoint: MCQ_ENDPOINT });
  if (!preCheck.allowed) {
    res.status(429).json({ error: 'spend_cap_reached', detail: preCheck.reason, caps: preCheck });
    return;
  }
  next();
};

/**
 * One section of a batch: a topic to generate for, and how many.
 *
 * The unit the app plans in. `mcq-bank.ts` caps any one section at 25% of a
 * batch, so a 30-question refill always spans four sections or more — which is
 * why the route loops and the pipeline does not. The pipeline generates for one
 * topic at a time and that is the right shape for it: the prompt, the chunking,
 * the fact-key dedup and the blind verification are all per-topic.
 */
export interface ParsedSection {
  /** `${paper}:${topic}`. Opaque here; echoed onto every question it produces. */
  sectionKey: string;
  /** The section's anchor leaf. The dedup key the pipeline reasons about. */
  syllabusSlug: string;
  /**
   * Every leaf in the section, so generation can spread across it.
   *
   * A quota of seven aimed at one bullet point produces seven questions about
   * one bullet point. Advisory to the prompt; never parsed.
   */
  syllabusSlugs: string[];
  paper: string;
  label: string;
  count: number;
  /** The sentence the app showed the user. Logged so the logs agree with the UI. */
  reason: string;
}

interface ParsedBody {
  requestId: string;
  /** Total across sections. Range-checked; the per-section counts sum to it. */
  batchSize: number;
  sections: ParsedSection[];
  difficulty: Difficulty;
  excludeFactKeys: string[];
  excludeStemHashes: string[];
  /** The client's prompt cohort. Echoed on `meta`, never compared. */
  promptVersion: string | null;
  /** Human-readable, from the app's own planner. Logged, never parsed. */
  rationale: string | null;
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max;
}

function readExclusions(value: unknown, field: string): string[] | string {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return `${field} must be an array of strings`;
  if (value.length > MAX_EXCLUSIONS) return `${field} exceeds ${MAX_EXCLUSIONS} entries`;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return `${field} must contain only strings`;
    if (entry.length > MAX_ID_CHARS) return `${field} contains an over-long entry`;
    if (entry.trim() !== '') out.push(entry);
  }
  return out;
}

/** Maximum sections in one batch. `maxSectionShare` makes 4-6 the real shape. */
const MAX_SECTIONS = 12;

/**
 * The DEFAULT generation difficulty.
 *
 * The app has no per-section difficulty concept — its own `Difficulty` type is
 * `easy|medium|hard` and describes a BANKED question's drill difficulty, which
 * is a different thing from the register a prompt is asked to write in. So the
 * field is optional and this is what a request without one gets. Sending it is
 * allowed so a future planner can vary it without a wire change.
 */
const DEFAULT_DIFFICULTY: Difficulty = 'standard';

function readSection(raw: unknown, index: number): ParsedSection | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return `sections[${index}] must be an object`;
  }
  const entry = raw as Record<string, unknown>;

  // The slugs are OPAQUE dedup keys. They are length-checked, echoed, and never
  // parsed: the syllabus taxonomy belongs to the app, and a server that
  // inferred meaning from slug structure would break the moment the app
  // renamed a node. The prompt is driven by `label`.
  if (!isBoundedString(entry.sectionKey, MAX_ID_CHARS)) {
    return `sections[${index}].sectionKey is required`;
  }
  if (!isBoundedString(entry.syllabusSlug, MAX_ID_CHARS)) {
    return `sections[${index}].syllabusSlug is required`;
  }
  if (!isBoundedString(entry.label, MAX_LABEL_CHARS)) {
    return `sections[${index}].label is required`;
  }
  if (!isPaper(entry.paper)) {
    return `sections[${index}].paper must be one of gs1|gs2|gs3|gs4|essay|anthro_p1|anthro_p2`;
  }

  const count = Number(entry.count);
  // Per-section counts are NOT held to `MIN_COUNT`: that bound is about whether
  // a whole request is worth two model calls, and here the batch as a whole
  // clears it. A quota of three is a legitimate plan — the pipeline chunks at
  // five and simply runs one short chunk.
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
    return `sections[${index}].count must be an integer between 1 and ${MAX_COUNT}`;
  }

  const slugs = readExclusions(entry.syllabusSlugs, `sections[${index}].syllabusSlugs`);
  if (typeof slugs === 'string') return slugs;

  return {
    sectionKey: entry.sectionKey,
    syllabusSlug: entry.syllabusSlug,
    // Falling back to the anchor keeps the prompt's topic list non-empty.
    syllabusSlugs: slugs.length > 0 ? slugs : [entry.syllabusSlug],
    paper: entry.paper,
    label: entry.label,
    count,
    reason: isBoundedString(entry.reason, MAX_LABEL_CHARS) ? entry.reason : '',
  };
}

/** Returns the parsed body, or a message describing the first problem. */
export function parseMcqBody(raw: unknown): ParsedBody | string {
  const body = (raw ?? {}) as Record<string, unknown>;

  if (!isBoundedString(body.requestId, MAX_ID_CHARS)) return 'requestId is required';

  if (!Array.isArray(body.sections)) return 'sections must be an array';
  if (body.sections.length === 0) {
    // Not a formality: a batch with no section has nothing to generate for, and
    // admitting it would reserve budget and open a stream to deliver nothing.
    return 'sections must contain at least one section';
  }
  if (body.sections.length > MAX_SECTIONS) {
    return `sections exceeds ${MAX_SECTIONS} entries`;
  }

  const sections: ParsedSection[] = [];
  const seenKeys = new Set<string>();
  for (const [index, raw] of body.sections.entries()) {
    const section = readSection(raw, index);
    if (typeof section === 'string') return section;
    // A repeated section would generate against the same topic twice inside one
    // batch with two independent fact-key sets, so the second run cannot see
    // what the first produced and near-duplicates get through.
    if (seenKeys.has(section.sectionKey)) {
      return `sections[${index}] repeats sectionKey ${section.sectionKey}`;
    }
    seenKeys.add(section.sectionKey);
    sections.push(section);
  }

  const summed = sections.reduce((total, section) => total + section.count, 0);
  const batchSize = body.batchSize === undefined ? summed : Number(body.batchSize);
  if (!Number.isInteger(batchSize) || batchSize < MIN_COUNT || batchSize > MAX_COUNT) {
    return `batchSize must be an integer between ${MIN_COUNT} and ${MAX_COUNT}`;
  }
  if (batchSize !== summed) {
    // Checked rather than reconciled. The app's planner documents that its
    // quotas "sum to exactly batchSize after rounding reconciliation", so a
    // disagreement is a bug in that arithmetic — and silently trusting one of
    // the two numbers would bill for one batch size and deliver another.
    return `batchSize ${batchSize} does not equal the sum of section counts (${summed})`;
  }

  if (body.difficulty !== undefined && !isDifficulty(body.difficulty)) {
    return 'difficulty must be one of foundation|standard|challenging';
  }

  const factKeys = readExclusions(body.excludeFactKeys, 'excludeFactKeys');
  if (typeof factKeys === 'string') return factKeys;
  const stemHashes = readExclusions(body.excludeStemHashes, 'excludeStemHashes');
  if (typeof stemHashes === 'string') return stemHashes;

  return {
    requestId: body.requestId,
    batchSize,
    sections,
    difficulty: isDifficulty(body.difficulty) ? body.difficulty : DEFAULT_DIFFICULTY,
    excludeFactKeys: factKeys,
    excludeStemHashes: stemHashes,
    promptVersion: isBoundedString(body.promptVersion, MAX_ID_CHARS) ? body.promptVersion : null,
    rationale: isBoundedString(body.rationale, MAX_LABEL_CHARS) ? body.rationale : null,
  };
}

/* ------------------------------------------------------------------ handler */

const handleGenerate: RequestHandler = async (req, res) => {
  const parsed = parseMcqBody(req.body);
  if (typeof parsed === 'string') {
    res.status(400).json(badRequest(parsed));
    return;
  }

  /**
   * Prompts, compiled once per distinct paper.
   *
   * `corpusVersion()` hashes every prompt file, so `version` is the same string
   * whichever paper is asked for; only `systemPrompt` differs, because the
   * Anthropology papers append a section. That is what makes one `promptVersion`
   * correct for a batch spanning several papers.
   */
  const papers = [...new Set(parsed.sections.map((section) => section.paper))];
  const compiled = new Map<string, Awaited<ReturnType<typeof compileGenerationPrompt>>>();
  const [generations, verifier] = await Promise.all([
    Promise.all(papers.map((paper) => compileGenerationPrompt(paper as Parameters<typeof compileGenerationPrompt>[0]))),
    compileVerifierPrompt(),
  ]);
  papers.forEach((paper, index) => compiled.set(paper, generations[index]!));
  const generation = generations[0]!;

  const model = mcqModel();
  const plannedChunks = parsed.sections.reduce(
    (total, section) => total + plannedChunksFor(section.count),
    0,
  );

  /**
   * The reservation, for the WHOLE batch and taken once.
   *
   * `units` counts MODEL CALLS — two per chunk, generation and verification —
   * because that is the quantity the daily cap has always meant. A batch is not
   * "one request" in any sense the cap cares about: it is eight calls or more,
   * and counting it as one would let twenty batches a day through a cap set at
   * a hundred and twenty single calls.
   *
   * Taken once rather than per section, and that is the whole reason the loop
   * lives here rather than in the client. A per-section reservation can be
   * refused at section four of six, having already billed for three sections
   * and opened a stream that must now end with an error — full spend, partial
   * value, and a ledger that disagrees with what the user was told.
   *
   * The dollar estimate carries 1.3x headroom for the bounded top-up chunks
   * that rejections trigger.
   */
  const reservation = {
    endpoint: MCQ_ENDPOINT,
    estimateUsd: parsed.batchSize * config.caps.estimatedMcqUsdPerQuestion * 1.3,
    units: plannedChunks * 2,
  };

  const admitted = await tryReserve(reservation);
  if (!admitted.ok) {
    res.status(429).json({
      error: 'spend_cap_reached',
      detail: admitted.caps.reason,
      caps: admitted.caps,
    });
    return;
  }

  // Idempotent: a race between the disconnect path and normal completion must
  // not double-release, which would hand budget back that was never held.
  let released = false;
  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    releaseReservation(reservation);
  };

  /**
   * Cancellation.
   *
   * This is the part that genuinely differs from /evaluate. One evaluation is
   * one model call, so aborting it is the whole story. A batch is a dozen calls
   * over minutes, and the client leaving after question five must abort the
   * call in flight, stop the pipeline from starting another chunk, AND stop the
   * loop from starting another section. Doing only the first still pays for the
   * rest and delivers none of it: full spend, zero value.
   */
  const controller = new AbortController();
  let peerGone = false;
  const onPeerGone = (): void => {
    if (peerGone) return;
    // `req` emits 'close' as soon as the JSON body has been consumed, well
    // before the client actually leaves, so the socket has to be checked too.
    if (!clientHasDisconnected(res)) return;
    peerGone = true;
    console.error('[mcq] client disconnected mid-batch; aborting and stopping further sections');
    controller.abort();
  };
  req.on('close', onPeerGone);
  res.on('close', onPeerGone);

  let sse: SseStream | null = null;

  try {
    sse = new SseStream(res);
    const stream = sse;

    stream.send('meta', {
      requestId: parsed.requestId,
      // The app keys its banked rows on `batchId` and falls back to the request
      // id when it is absent. Sending both, under both names, so the fallback
      // is a safety net rather than the normal path.
      batchId: parsed.requestId,
      model,
      verifierModel: model,
      requested: parsed.batchSize,
      sections: parsed.sections.length,
      difficulty: parsed.difficulty,
      chunkSize: CHUNK_SIZE,
      plannedChunks,
      promptVersion: generation.version,
      verifierVersion: verifier.version,
      clientPromptVersion: parsed.promptVersion,
    });

    if (parsed.rationale !== null) {
      console.log(`[mcq] batch ${parsed.requestId}: ${parsed.rationale}`);
    }

    /**
     * Exclusions ACCUMULATE across sections.
     *
     * Seeded from the device's bank, then grown with every question this batch
     * delivers. Without that, section four cannot see what section one wrote
     * and one batch can bank the same fact twice — the sections are different
     * shelves but the syllabus overlaps, and "electoral bonds" is reachable
     * from Polity and from Governance alike.
     */
    const factKeys = [...parsed.excludeFactKeys];
    const stemHashes = [...parsed.excludeStemHashes];

    let delivered = 0;
    let generated = 0;
    let rejected = 0;
    let keyDisagreements = 0;
    let chunksRun = 0;
    let chunksTruncated = 0;
    let cancelled = false;
    const rejections: Record<string, number> = {};
    let totalUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };

    for (const [index, section] of parsed.sections.entries()) {
      if (peerGone) {
        cancelled = true;
        break;
      }

      // Emitted BEFORE the two model calls, not after. A section that generates
      // five questions and rejects all five emits nothing for a minute or more,
      // and the client's idle timer cuts a stream that goes silent — so the
      // frame that says "still working" has to come first.
      stream.send('progress', {
        phase: 'section',
        done: index,
        total: parsed.sections.length,
        detail: `${section.label} — ${section.count} question${section.count === 1 ? '' : 's'}`,
      });

      const result = await runMcqPipeline(
        {
          requestId: `${parsed.requestId}:${index}`,
          paper: section.paper,
          topic: {
            slug: section.syllabusSlug,
            label: section.label,
            section: section.sectionKey,
          },
          difficulty: parsed.difficulty,
          count: section.count,
          excludeFactKeys: factKeys,
          excludeStemHashes: stemHashes,
          model,
          verifierModel: model,
          generationSystem: (compiled.get(section.paper) ?? generation).systemPrompt,
          verifierSystem: verifier.systemPrompt,
          promptVersion: generation.version,
          verifierVersion: verifier.version,
        },
        {
          generate: currentMcqRunner(),
          verify: currentVerificationRunner(),
          emitQuestion: (question) => {
            // `sectionKey` is added HERE rather than inside the pipeline: the
            // pipeline reasons about one topic and has no notion of a batch
            // spanning sections, and the app files a banked row under the
            // section it was planned for.
            stream.send('question', { ...question, sectionKey: section.sectionKey });
            // Grown as they are delivered, so the NEXT section already knows.
            factKeys.push(question.factKey);
            stemHashes.push(question.stemHash);
          },
          // Billed per chunk, awaited. A batch that dies in section three has
          // consumed three sections' worth of tokens and the ledger says three.
          onChunkUsage: async (event) => {
            totalUsage = {
              inputTokens: totalUsage.inputTokens + event.usage.inputTokens,
              outputTokens: totalUsage.outputTokens + event.usage.outputTokens,
              cacheCreationInputTokens:
                totalUsage.cacheCreationInputTokens + event.usage.cacheCreationInputTokens,
              cacheReadInputTokens:
                totalUsage.cacheReadInputTokens + event.usage.cacheReadInputTokens,
            };
            await recordUsage({
              endpoint: MCQ_ENDPOINT,
              tier: MCQ_TIER,
              model: event.model,
              inputTokens: event.usage.inputTokens,
              outputTokens: event.usage.outputTokens,
              cacheCreationInputTokens: event.usage.cacheCreationInputTokens,
              cacheReadInputTokens: event.usage.cacheReadInputTokens,
            }).catch((err) => {
              // Never let a ledger write failure kill a batch that is otherwise
              // delivering; the error is logged and the next chunk still runs.
              console.error('[mcq] usage write failed', err);
            });
          },
          isCancelled: () => peerGone,
          signal: controller.signal,
          log: (message, detail) =>
            detail === undefined ? console.log(message) : console.log(message, detail),
        },
      );

      delivered += result.summary.delivered;
      generated += result.summary.generated;
      rejected += result.summary.rejected;
      keyDisagreements += result.summary.keyDisagreements;
      chunksRun += result.summary.chunksRun;
      chunksTruncated += result.summary.chunksTruncated;
      if (result.summary.cancelled) cancelled = true;
      for (const [reason, n] of Object.entries(result.summary.rejections)) {
        rejections[reason] = (rejections[reason] ?? 0) + n;
      }
    }

    stream.send('summary', {
      batchId: parsed.requestId,
      requested: parsed.batchSize,
      // `delivered` is what reached the wire. `generated` is what the model
      // produced before quality control, and it is legitimately much larger —
      // reporting it as the delivered count would tell the app it banked
      // fifteen questions when it banked none.
      delivered,
      underDelivered: delivered < parsed.batchSize,
      generated,
      rejected,
      rejections,
      keyDisagreements,
      sections: parsed.sections.length,
      chunksRun,
      chunksTruncated,
      cancelled,
    });

    const after = await capStatus({ endpoint: MCQ_ENDPOINT });
    stream.send('usage', {
      inputTokens: totalUsage.inputTokens,
      outputTokens: totalUsage.outputTokens,
      cacheCreationInputTokens: totalUsage.cacheCreationInputTokens,
      cacheReadInputTokens: totalUsage.cacheReadInputTokens,
      // Both present because the app reads both. `estCostUsd` is THIS batch;
      // `monthUsd` is the running total, and a client showing one where it
      // meant the other is off by the whole month.
      estCostUsd: Number(
        estimateCostUsd(MCQ_TIER, totalUsage.inputTokens, totalUsage.outputTokens).toFixed(4),
      ),
      model,
      monthUsd: Number(after.monthUsd.toFixed(2)),
      monthlyCapUsd: after.monthlyCapUsd,
      mcqMonthUsd: Number(after.mcqMonthUsd.toFixed(2)),
      mcqMonthlyCapUsd: after.mcqMonthlyCapUsd,
    });

    stream.send('done', { ok: true });
  } catch (err) {
    console.error('[mcq]', err);
    // Never echoes err.message; the detail is in the server log above.
    sse?.send('error', { message: 'Question generation failed. Check the server logs.' });
  } finally {
    // Outermost level of the handler. Moving this inside a callback would
    // leak the reservation on any throw before that callback ran, and a leaked
    // MCQ reservation is large — it ratchets the cap down until restart.
    releaseOnce();
    req.off('close', onPeerGone);
    res.off('close', onPeerGone);
    if (sse) await sse.end();
    else if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
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
    res.status(413).json({ error: 'payload_too_large', detail: 'Request body exceeds 64kb.' });
    return;
  }
  if (candidate?.type === 'entity.parse.failed' || candidate?.status === 400) {
    res.status(400).json(badRequest('malformed JSON body'));
    return;
  }
  next(err);
}

export const mcqRouter: Router = Router();

mcqRouter.post('/generate', parseJsonBody, capFastFail, handleGenerate);

mcqRouter.use(jsonErrorHandler);
