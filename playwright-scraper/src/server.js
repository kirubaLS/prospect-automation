const http = require('http');
const config = require('./config');
const { runScrape } = require('./run');

let isRunning = false;
let lastSummary = null;
let lastError = null;

function authorized(req) {
  if (!config.runToken) return true; // no token configured - open (only do this behind Render's private networking, never in production)
  const url = new URL(req.url, `http://${req.headers.host}`);
  return url.searchParams.get('token') === config.runToken;
}

async function triggerRun() {
  if (isRunning) return { alreadyRunning: true };
  isRunning = true;
  lastError = null;
  console.log('Scrape run triggered');
  try {
    lastSummary = await runScrape();
    console.log('Scrape run finished:', JSON.stringify(lastSummary));
  } catch (err) {
    lastError = err.message;
    console.error('Scrape run failed:', err);
  } finally {
    isRunning = false;
  }
  return { started: true };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === '/run') {
    if (!authorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized - pass ?token=RUN_TOKEN' }));
      return;
    }
    if (isRunning) {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'already_running' }));
      return;
    }
    // Respond immediately - a scrape run can take minutes, well past most
    // reverse-proxy timeouts (including Render's), so this must be
    // fire-and-forget rather than awaited in the request/response cycle.
    triggerRun();
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'started' }));
    return;
  }

  if (url.pathname === '/status') {
    if (!authorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized - pass ?token=RUN_TOKEN' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ isRunning, lastSummary, lastError }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found', routes: ['/healthz', '/run', '/status'] }));
});

server.listen(config.port, () => {
  console.log(`Scraper server listening on :${config.port}`);
  console.log('Trigger a run with GET /run' + (config.runToken ? '?token=***' : ' (no RUN_TOKEN set - open endpoint!)'));
});
