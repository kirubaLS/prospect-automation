const http = require('http');
const config = require('./config');
const { runScrape } = require('./run');
const logger = require('./logger');

const isFileMode = config.storageBackend === 'file';
const filestore = isFileMode ? require('./filestore') : null;
const files = isFileMode ? require('./files') : null;

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

let isRunning = false;
let lastRunFinishedAt = null;
let lastSummary = null;
let lastError = null;

function tokenOf(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  return url.searchParams.get('token') || req.headers['x-run-token'] || null;
}

function authorized(req) {
  if (!config.runToken) return true; // no token configured - open (never acceptable for a public URL)
  return tokenOf(req) === config.runToken;
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        reject(new Error(`Upload larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function statusBody() {
  return {
    mode: config.storageBackend,
    isRunning,
    lastRunFinishedAt: lastRunFinishedAt ? lastRunFinishedAt.toISOString() : null,
    nextRunAllowedInMs: isRunning ? null : Math.max(0, config.minRunIntervalMs - msSinceLastRun()),
    ...(isFileMode ? { data: filestore.snapshot() } : {}),
    lastSummary,
    lastError
  };
}

// Minimal control page for file mode: upload companies, trigger a run,
// watch progress, download results. Served at / ; the token is taken from
// the page URL (?token=...) and forwarded on every request it makes.
const PAGE = `<!doctype html><meta charset="utf-8"><title>Sales Navigator scraper</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;color:#222}
h1{font-size:1.4rem}section{border:1px solid #ddd;border-radius:8px;padding:1rem;margin:1rem 0}
button,a.btn{display:inline-block;background:#0a66c2;color:#fff;border:0;border-radius:6px;padding:.5rem .9rem;font-size:14px;cursor:pointer;text-decoration:none;margin:.2rem .3rem .2rem 0}
button.secondary,a.secondary{background:#555}pre{background:#f6f6f6;padding:.75rem;border-radius:6px;overflow:auto;font-size:13px}
.muted{color:#666;font-size:13px}#msg{margin:.5rem 0;font-weight:600}</style>
<h1>Sales Navigator scraper</h1>
<section><h3>1. Upload companies (CSV or Excel)</h3>
<p class="muted">Needs a <b>Company Name</b> and/or <b>LinkedIn URL</b> column (company page URLs, e.g. linkedin.com/company/...). New rows are added as pending; already-Done companies are kept.</p>
<input type="file" id="file" accept=".csv,.xlsx,.xls"> <label><input type="checkbox" id="replace"> Replace existing list</label>
<div><button onclick="upload()">Upload</button></div><div id="msg"></div></section>
<section><h3>2. Run</h3><p class="muted">Each run processes ${config.companiesPerRun || 'all'} pending compan${config.companiesPerRun === 1 ? 'y' : 'ies'}. With a scheduled pinger this happens automatically; click to start one now.</p>
<button onclick="call('/run')">Run now</button> <button class="secondary" onclick="refresh()">Refresh status</button></section>
<section><h3>3. Download results</h3>
<a class="btn" id="dl-xlsx">Prospects .xlsx</a> <a class="btn" id="dl-csv">Prospects .csv</a> <a class="btn secondary" id="dl-companies">Companies status .csv</a></section>
<section><h3>Status</h3><pre id="status">loading…</pre>
<button class="secondary" onclick="if(confirm('Delete all uploaded companies and prospects?'))call('/reset',{method:'POST'})">Reset everything</button></section>
<script>
const token=new URLSearchParams(location.search).get('token')||'';
const q=p=>p+(p.includes('?')?'&':'?')+'token='+encodeURIComponent(token);
document.getElementById('dl-xlsx').href=q('/download?format=xlsx');
document.getElementById('dl-csv').href=q('/download?format=csv');
document.getElementById('dl-companies').href=q('/download?what=companies&format=csv');
async function call(p,opts){const r=await fetch(q(p),opts);const j=await r.json().catch(()=>({}));document.getElementById('msg').textContent=r.ok?JSON.stringify(j):('Error '+r.status+': '+(j.error||''));refresh();}
async function upload(){const f=document.getElementById('file').files[0];if(!f){alert('Choose a file first');return;}
const rep=document.getElementById('replace').checked;await call('/upload?filename='+encodeURIComponent(f.name)+(rep?'&replace=1':''),{method:'POST',body:f});}
async function refresh(){const r=await fetch(q('/status'));document.getElementById('status').textContent=r.ok?JSON.stringify(await r.json(),null,2):'Error '+r.status+' (bad token?)';}
refresh();setInterval(refresh,15000);
</script>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Always instant and unauthenticated - this is what Render's own health
  // check polls, and it must never depend on scrape state.
  if (url.pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname === '/') {
    if (!isFileMode) {
      sendJson(res, 200, { mode: 'sheets', routes: ['/healthz', '/run', '/status'] });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }

  if (!authorized(req)) {
    sendJson(res, 401, { error: 'unauthorized - pass ?token=RUN_TOKEN' });
    return;
  }

  try {
    if (url.pathname === '/run') {
      if (isRunning) return sendJson(res, 202, { status: 'already_running' });
      const cooldownRemainingMs = config.minRunIntervalMs - msSinceLastRun();
      if (cooldownRemainingMs > 0) return sendJson(res, 429, { status: 'cooldown', retryAfterMs: cooldownRemainingMs });
      if (isFileMode && filestore.snapshot().pending === 0) return sendJson(res, 200, { status: 'nothing_pending' });
      // Respond immediately - a scrape run can take minutes, well past most
      // reverse-proxy timeouts (including Render's), so this must be
      // fire-and-forget rather than awaited in the request/response cycle.
      triggerRun();
      return sendJson(res, 202, { status: 'started' });
    }

    if (url.pathname === '/status') return sendJson(res, 200, statusBody());

    if (isFileMode && url.pathname === '/upload' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.length === 0) return sendJson(res, 400, { error: 'empty upload' });
      const filename = url.searchParams.get('filename') || req.headers['x-filename'] || 'upload.csv';
      const info = filestore.importCompanies(body, filename, { replace: url.searchParams.get('replace') === '1' });
      return sendJson(res, 200, { status: 'imported', ...info });
    }

    if (isFileMode && url.pathname === '/download') {
      const format = url.searchParams.get('format') === 'xlsx' ? 'xlsx' : 'csv';
      const what = url.searchParams.get('what') === 'companies' ? 'companies' : 'prospects';
      const buffer =
        what === 'companies'
          ? files.exportCompanies(filestore.getCompanies(), format)
          : files.exportProspects(filestore.getProspects(), format);
      res.writeHead(200, {
        'Content-Type': format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${what}.${format}"`,
        'Content-Length': buffer.length
      });
      return res.end(buffer);
    }

    if (isFileMode && url.pathname === '/reset' && req.method === 'POST') {
      if (isRunning) return sendJson(res, 409, { error: 'a run is in progress' });
      filestore.reset();
      return sendJson(res, 200, { status: 'reset' });
    }

    sendJson(res, 404, {
      error: 'not found',
      routes: isFileMode ? ['/', '/healthz', '/run', '/status', 'POST /upload', '/download', 'POST /reset'] : ['/healthz', '/run', '/status']
    });
  } catch (err) {
    logger.error(`${req.method} ${url.pathname} failed:`, err.message);
    sendJson(res, 400, { error: err.message });
  }
});

server.listen(config.port, () => {
  logger.info(`Scraper server listening on :${config.port} (storage: ${config.storageBackend})`);
  logger.info(
    (isFileMode ? 'Open / in a browser to upload companies and download results. ' : '') +
      'Trigger a run with GET /run' +
      (config.runToken ? '?token=***' : ' (no RUN_TOKEN set - open endpoint!)')
  );
});

// Render sends SIGTERM before killing the container on redeploy/restart. If
// a scrape is mid-flight, let it finish (up to a grace period) instead of
// getting killed with the browser still open and results half-written.
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
