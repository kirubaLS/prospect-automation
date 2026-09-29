// Web app for Apollo prospecting across projects (Render-friendly: no
// browser, small memory). One page: pick a project, upload a companies
// file, run, watch status, download prospects.xlsx / companies-status.csv.
//
// Env: APOLLO_API_KEY (required), RUN_TOKEN (recommended), OPENAI_API_KEY
// (only for projects with "qualification": "openai"), PROJECTS_DIR
// (default ../projects), PORT.
require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const files = require('./files');
const { createFileStore } = require('./filestore');
const { runProject, loadProject, listProjects } = require('./projectRunner');

const PROJECTS_DIR = process.env.PROJECTS_DIR || path.resolve(__dirname, '..', '..', 'projects');
const PORT = parseInt(process.env.PORT || '3000', 10);
const RUN_TOKEN = process.env.RUN_TOKEN || null;
const APOLLO_API_KEY = process.env.APOLLO_API_KEY || null;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const stores = new Map();
const running = new Map(); // project -> { startedAt, stop }
const lastRuns = new Map(); // project -> { summary | error, finishedAt }
const processStartedAt = new Date();

function storeFor(project) {
  if (!stores.has(project)) stores.set(project, createFileStore(path.join(PROJECTS_DIR, project)));
  return stores.get(project);
}

function projectInfo(slug) {
  const cfg = loadProject(path.join(PROJECTS_DIR, slug));
  return { slug, name: cfg.name, description: cfg.description || '', targetPerCompany: cfg.targetPerCompany, qualification: cfg.qualification || 'rules', manualColumns: cfg.manualColumns || [] };
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function authorized(req, url) {
  if (!RUN_TOKEN) return true;
  return (url.searchParams.get('token') || req.headers['x-run-token']) === RUN_TOKEN;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_UPLOAD_BYTES) {
        reject(new Error(`Upload larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function statusFor(slug) {
  const run = running.get(slug);
  return {
    project: slug,
    isRunning: !!run,
    runStartedAt: run ? run.startedAt : null,
    lastRun: lastRuns.get(slug) || null,
    data: storeFor(slug).snapshot()
  };
}

function startRun(slug, { limit = 0, replace = false, upload = null } = {}) {
  if (running.has(slug)) return { status: 'already_running' };
  let stopRequested = false;
  const state = { startedAt: new Date().toISOString(), stop: () => (stopRequested = true) };
  running.set(slug, state);
  runProject({
    projectDir: path.join(PROJECTS_DIR, slug),
    apiKey: APOLLO_API_KEY,
    openAiKey: OPENAI_API_KEY,
    limit,
    replace,
    upload,
    store: storeFor(slug),
    shouldStop: () => stopRequested
  })
    .then((summary) => lastRuns.set(slug, { summary, finishedAt: new Date().toISOString() }))
    .catch((err) => {
      logger.error(`[${slug}] run failed: ${err.message}`);
      lastRuns.set(slug, { error: err.message, finishedAt: new Date().toISOString() });
    })
    .finally(() => running.delete(slug));
  return { status: 'started' };
}

const PAGE = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const send = (s, b) => sendJson(res, s, b);

  if (url.pathname === '/healthz') return send(200, { ok: true, uptimeMin: Math.round((Date.now() - processStartedAt) / 60000) });
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(PAGE);
  }
  if (!authorized(req, url)) return send(401, { error: 'unauthorized - pass ?token=RUN_TOKEN' });

  try {
    if (url.pathname === '/projects') {
      return send(200, { apolloKeySet: !!APOLLO_API_KEY, projects: listProjects(PROJECTS_DIR).map((slug) => ({ ...projectInfo(slug), ...statusFor(slug) })) });
    }

    const m = url.pathname.match(/^\/projects\/([\w.-]+)\/(status|upload|run|stop|download|reset|template)$/);
    if (!m) return send(404, { error: 'not found', routes: ['/', '/healthz', '/projects', '/projects/:slug/{status,upload,run,stop,download,reset,template}'] });
    const [, slug, action] = m;
    if (!listProjects(PROJECTS_DIR).includes(slug)) return send(404, { error: `unknown project "${slug}"` });
    const store = storeFor(slug);

    if (action === 'status') return send(200, statusFor(slug));

    if (action === 'template') {
      const buf = files.exportCompanies([{ 'Company Name': 'Example Company', 'LinkedIn URL': 'https://www.linkedin.com/company/example/' }], 'xlsx');
      res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${slug}-companies-template.xlsx"` });
      return res.end(buf);
    }

    if (action === 'upload' && req.method === 'POST') {
      if (running.has(slug)) return send(409, { error: 'a run is in progress' });
      const body = await readBody(req);
      if (!body.length) return send(400, { error: 'empty upload' });
      const filename = url.searchParams.get('filename') || 'upload.csv';
      const info = store.importCompanies(body, filename, { replace: url.searchParams.get('replace') === '1' });
      if (url.searchParams.get('run') === '1') {
        const r = startRun(slug, { limit: parseInt(url.searchParams.get('limit') || '0', 10) || 0 });
        return send(202, { status: 'imported', ...info, run: r.status });
      }
      return send(200, { status: 'imported', ...info });
    }

    if (action === 'run') {
      if (!APOLLO_API_KEY) return send(500, { error: 'APOLLO_API_KEY is not set on the server' });
      if (store.snapshot().pending === 0) return send(200, { status: 'nothing_pending' });
      const r = startRun(slug, { limit: parseInt(url.searchParams.get('limit') || '0', 10) || 0 });
      return send(r.status === 'started' ? 202 : 200, r);
    }

    if (action === 'stop' && req.method === 'POST') {
      const run = running.get(slug);
      if (!run) return send(200, { status: 'not_running' });
      run.stop();
      return send(202, { status: 'stopping' });
    }

    if (action === 'download') {
      const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'xlsx';
      const what = url.searchParams.get('what') === 'companies' ? 'companies' : 'prospects';
      const buf = what === 'companies' ? files.exportCompanies(store.getCompanies(), format) : files.exportProspects(store.getProspects(), format);
      res.writeHead(200, {
        'Content-Type': format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${slug}-${what}.${format}"`,
        'Content-Length': buf.length
      });
      return res.end(buf);
    }

    if (action === 'reset' && req.method === 'POST') {
      if (running.has(slug)) return send(409, { error: 'a run is in progress' });
      store.reset();
      lastRuns.delete(slug);
      return send(200, { status: 'reset' });
    }

    send(405, { error: `method not allowed for ${action}` });
  } catch (err) {
    logger.error(`${req.method} ${url.pathname} failed:`, err.message);
    send(400, { error: err.message });
  }
});

server.listen(PORT, () => {
  const projects = listProjects(PROJECTS_DIR);
  logger.info(`Prospecting app on :${PORT} - projects: ${projects.join(', ') || '(none found in ' + PROJECTS_DIR + ')'}`);
  if (!APOLLO_API_KEY) logger.warn('APOLLO_API_KEY is not set - runs will fail until it is');
  if (!RUN_TOKEN) logger.warn('RUN_TOKEN is not set - the app is open to anyone with the URL');
});

async function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down...`);
  server.close();
  for (const run of running.values()) run.stop();
  const start = Date.now();
  while (running.size && Date.now() - start < 30000) await new Promise((r) => setTimeout(r, 500));
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
