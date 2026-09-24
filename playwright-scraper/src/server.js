const http = require('http');
const config = require('./config');
const { runScrape } = require('./run');
const logger = require('./logger');

let isRunning = false;
let lastRunFinishedAt = null;
let lastSummary = null;
let lastError = null;

function authorized(req) {
  if (!config.runToken) return true; // no token configured - open (only acceptable behind a trusted internal network, never as-is in production)
  const url = new URL(req.url, `http://${req.headers.host}`);
  return url.searchParams.get('token') === config.runToken;
}

function msSinceLastRun() {
  return lastRunFinishedAt ? Date.now() - lastRunFinishedAt.getTime() : Infinity;
}

async function triggerRun() {
  isRunning = true;
  lastError = null;
  logger.info(`Scrape run triggered (limit=${config.companiesPerRun || 'all'})`);
  try {
    lastSummary = await runScrape({ limit: config.companiesPerRun });
    logger.info('Scrape run finished:', JSON.stringify(lastSummary));
  } catch (err) {
    lastError = err.message;
    logger.error('Scrape run failed:', err.message);
  } finally {
    isRunning = false;
    lastRunFinishedAt = new Date();
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Always instant and unauthenticated - this is what Render's own health
  // check polls, and it must never depend on scrape state.
  if (url.pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname === '/run') {
    if (!authorized(req)) {
      sendJson(res, 401, { error: 'unauthorized - pass ?token=RUN_TOKEN' });
      return;
    }
    if (isRunning) {
      sendJson(res, 202, { status: 'already_running' });
      return;
    }
    const cooldownRemainingMs = config.minRunIntervalMs - msSinceLastRun();
    if (cooldownRemainingMs > 0) {
      sendJson(res, 429, { status: 'cooldown', retryAfterMs: cooldownRemainingMs });
      return;
    }
    // Respond immediately - a scrape run can take minutes, well past most
    // reverse-proxy timeouts (including Render's), so this must be
    // fire-and-forget rather than awaited in the request/response cycle.
    triggerRun();
    sendJson(res, 202, { status: 'started' });
    return;
  }

  if (url.pathname === '/status') {
    if (!authorized(req)) {
      sendJson(res, 401, { error: 'unauthorized - pass ?token=RUN_TOKEN' });
      return;
    }
    sendJson(res, 200, {
      isRunning,
      lastRunFinishedAt: lastRunFinishedAt ? lastRunFinishedAt.toISOString() : null,
      nextRunAllowedInMs: isRunning ? null : Math.max(0, config.minRunIntervalMs - msSinceLastRun()),
      lastSummary,
      lastError
    });
    return;
  }

  sendJson(res, 404, { error: 'not found', routes: ['/healthz', '/run', '/status'] });
});

server.listen(config.port, () => {
  logger.info(`Scraper server listening on :${config.port}`);
  logger.info('Trigger a run with GET /run' + (config.runToken ? '?token=***' : ' (no RUN_TOKEN set - open endpoint!)'));
});

// Render sends SIGTERM before killing the container on redeploy/restart. If
// a scrape is mid-flight, let it finish (up to a grace period) instead of
// getting killed with the browser still open and sheet writes half-done.
async function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down...`);
  server.close();

  const graceMs = 60000;
  const start = Date.now();
  while (isRunning && Date.now() - start < graceMs) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (isRunning) {
    logger.warn('Grace period expired while a run was still in progress - exiting anyway');
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
