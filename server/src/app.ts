/**
 * The Express application.
 *
 * Exported separately from `listen()` (see index.ts) so tests can drive it
 * with supertest without binding a port.
 *
 * NOTE: do not add `compression` here. It would buffer the SSE response and
 * turn streaming back into a blank wait. If it is ever genuinely needed, it
 * must be mounted with
 *   filter: (req, res) => res.getHeader('Content-Type') !== 'text/event-stream'
 */

import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import { requireAuth } from './auth.js';
import { config, modelConfigured } from './config.js';
import { caVersions, clearCaPromptCache } from './ca/index.js';
import { drillVersions, reloadDrillPrompts } from './drills/index.js';
import { interviewVersions, reloadInterviewPrompts } from './interview/index.js';
import { clearMcqPromptCache, mcqVersions } from './mcq/index.js';
import { evaluateRouter } from './routes/evaluate.js';
import { requireCapability } from './capability.js';
import { caHeadlinesRouter } from './routes/ca-headlines.js';
import { caRouter } from './routes/ca.js';
import { drillsRouter } from './routes/drills.js';
import { interviewRouter } from './routes/interview.js';
import { mcqRouter } from './routes/mcq.js';
import { clearRubricCache, rubricVersions } from './rubrics/index.js';
import { capStatus, usageSummary } from './usage.js';

const requestLogger: RequestHandler = (req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    console.log(`  <-- ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - startedAt}ms`);
  });
  next();
};

export const app: Express = express();

// Keep the test output readable; everything else logs every request.
if (process.env.NODE_ENV !== 'test') app.use(requestLogger);

app.disable('x-powered-by');

/**
 * Unauthenticated so uptime checks and the app's "is the server awake?" ping
 * work without shipping the token into a health probe. Deliberately exposes
 * nothing beyond liveness and rubric versions.
 *
 * The shape is a contract: `HealthResponse` in app/src/lib/api.ts reads it.
 */
app.get('/health', async (_req, res) => {
  const caps = await capStatus();
  res.json({
    ok: true,
    timezone: config.timezone,
    /**
     * Whether paid model features are available.
     *
     * The app reads this to choose between `/ca/digest` and `/ca/headlines`
     * rather than discovering the answer from a 503 after it has already
     * written a digest row. Liveness and capability are the same question for a
     * client deciding what to ask for, so they travel in the same response.
     */
    modelConfigured,
    rubrics: await rubricVersions(),
    // Compiled, not a constant. `mcqVersions()` reads the prompt files from
    // disk, so a build that forgot to copy src/mcq/prompts/*.md into dist
    // fails the health check instead of failing on the first paid request of
    // the month — which is the difference between noticing in seconds and
    // noticing after a wasted call.
    mcq: await mcqVersions(),
    // Same reason as `mcq`: this reads the prompt files from disk, so a build
    // whose script forgot to copy them fails a health check rather than the
    // first paid request of the month.
    ca: await caVersions(),
    // Same reason again: a drill server whose prompts did not reach dist fails
    // here rather than on her first attempt of the morning.
    drills: await drillVersions(),
    interview: await interviewVersions(),
    caps: {
      allowed: caps.allowed,
      monthUsd: Number(caps.monthUsd.toFixed(2)),
      monthlyCapUsd: caps.monthlyCapUsd,
      todayRequests: caps.todayRequests,
      dailyRequestCap: caps.dailyRequestCap,
    },
  });
});

/**
 * Bearer auth, applied per route rather than globally.
 *
 * `app.use(requireAuth)` with no path would also cover /health and break the
 * unauthenticated liveness check. And Express 5 uses path-to-regexp v8, where
 * a bare `*` ('/rubrics/*') throws at boot — the prefix form below is the
 * replacement and covers /rubrics and every subpath, for every method.
 */
app.use('/evaluate', requireAuth, requireCapability('evaluation'), evaluateRouter);

/**
 * Question banking. Behind the same bearer token, with its own route-scoped
 * JSON body parser — see routes/mcq.ts for why that must not be global.
 */
app.use('/mcq', requireAuth, requireCapability('bulk'), mcqRouter);
/**
 * Mounted BEFORE `/ca`, and the order is load-bearing.
 *
 * Express matches `app.use` prefixes in registration order, so `/ca` registered
 * first would take `/ca/headlines` into the digest router and answer 404 from
 * inside it — a route that exists, reachable in tests through the sub-router,
 * and dead in the real app. Specific prefix first.
 *
 * Separate from `caRouter` rather than a route inside it so it cannot inherit
 * the digest's spend reservation by accident: nothing here is billable.
 */
app.use('/ca/headlines', requireAuth, caHeadlinesRouter);
// `/ca/headlines` is mounted ABOVE and takes no capability guard — it is the
// path that exists precisely for the no-model case.
app.use('/ca', requireAuth, requireCapability('bulk'), caRouter);
app.use('/drills', requireAuth, drillsRouter);
app.use('/interview', requireAuth, requireCapability('bulk'), interviewRouter);

app.get('/usage', requireAuth, async (_req, res) => {
  res.json(await usageSummary());
});

/** Picks up rubric edits without a restart. */
const rubricsRouter = express.Router();
rubricsRouter.post('/reload', async (_req, res) => {
  clearRubricCache();
  res.json({ ok: true, rubrics: await rubricVersions() });
});
app.use('/rubrics', requireAuth, rubricsRouter);

/** Same as /rubrics/reload: picks up prompt edits without a restart. */
const mcqAdminRouter = express.Router();
mcqAdminRouter.post('/reload', async (_req, res) => {
  clearMcqPromptCache();
  res.json({ ok: true, mcq: await mcqVersions() });
});
app.use('/mcq-prompts', requireAuth, mcqAdminRouter);

const caAdminRouter = express.Router();
caAdminRouter.post('/reload', async (_req, res) => {
  clearCaPromptCache();
  res.json({ ok: true, ca: await caVersions() });
});
app.use('/ca-prompts', requireAuth, caAdminRouter);

const drillAdminRouter = express.Router();
drillAdminRouter.post('/reload', async (_req, res) => {
  reloadDrillPrompts();
  res.json({ ok: true, drills: await drillVersions() });
});
app.use('/drill-prompts', requireAuth, drillAdminRouter);

const interviewAdminRouter = express.Router();
interviewAdminRouter.post('/reload', async (_req, res) => {
  reloadInterviewPrompts();
  res.json({ ok: true, interview: await interviewVersions() });
});
app.use('/interview-prompts', requireAuth, interviewAdminRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'not_found' });
});

/**
 * Four arguments on purpose: a three-argument function registers as ordinary
 * middleware and would silently never fire.
 *
 * Express 5 forwards rejected promises from async handlers here automatically,
 * so `await`ed failures land in this handler rather than becoming unhandled
 * rejections the way they would under Express 4.
 */
const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  // Logged in full server-side; the response stays generic so internal paths
  // and library error text are not echoed to callers — including on the
  // unauthenticated /health route.
  console.error('[error]', err);

  // Once the SSE headers are flushed there is no status left to set; writing
  // one throws ERR_HTTP_HEADERS_SENT and Express destroys the socket.
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(500).json({ error: 'internal_error' });
};
app.use(errorHandler);
