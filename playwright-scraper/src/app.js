// Prospecting web app (Render free tier: no browser, ~100 MB RAM).
// Upload a CSV/XLSX of company LinkedIn URLs, type the geography and ICP for
// this project, choose people per company, run, download one CSV.
//
// Env: APOLLO_API_KEY (required), RUN_TOKEN (recommended), PORT,
//      PROJECTS_DIR (optional: projects/*/config.json become form presets).
require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');
const { runJob, toCsv, parseGeography, parseIcp } = require('./jobs');

const PORT = parseInt(process.env.PORT || '3000', 10);
const RUN_TOKEN = process.env.RUN_TOKEN || null;
const APOLLO_API_KEY = process.env.APOLLO_API_KEY || null;
const PROJECTS_DIR = process.env.PROJECTS_DIR || path.resolve(__dirname, '..', '..', 'projects');
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_JOBS_KEPT = 20;
const MAX_PEOPLE_PER_COMPANY = 25;

const jobs = new Map(); // id -> job
let runningId = null;
const processStartedAt = new Date();

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

function presets() {
  try {
    return fs
      .readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(PROJECTS_DIR, d.name, 'config.json')))
      .map((d) => {
        const c = JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, d.name, 'config.json'), 'utf8'));
        const industries = (c.prescreen && c.prescreen.industriesAnyOf) || [];
        return {
          slug: d.name,
          name: c.name || d.name,
          geography: (c.personLocations || []).join('; '),
          icp: (industries.length ? industries.join(', ') + '; ' : '') + (c.titleKeywords || []).join(', '),
          peoplePerCompany: c.targetPerCompany || 8
        };
      });
  } catch (err) {
    logger.warn(`Could not read presets from ${PROJECTS_DIR}: ${err.message}`);
    return [];
  }
}

function publicJob(j) {
  return {
    id: j.id,
    label: j.label,
    filename: j.filename,
    params: { geography: j.paramsText.geography, icp: j.paramsText.icp, peoplePerCompany: j.params.peoplePerCompany, locations: j.params.locations, icpKeywords: j.params.icpKeywords, industries: j.params.industries },
    status: j.status,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    progress: j.progress,
    error: j.error || null,
    rows: j.rows.length
  };
}

function startJob({ fileBuffer, filename, geography, icp, peoplePerCompany, label }) {
  if (runningId) throw new Error('another job is running - wait for it to finish or stop it');
  if (!APOLLO_API_KEY) throw new Error('APOLLO_API_KEY is not set on the server');
  const count = Math.min(MAX_PEOPLE_PER_COMPANY, Math.max(1, parseInt(peoplePerCompany, 10) || 8));
  const locations = parseGeography(geography);
  const { industries, keywords } = parseIcp(icp);
  if (!keywords.length) throw new Error('ICP is empty - list the roles/functions to look for (e.g. "IT, Administration, Procurement, Finance")');

  const id = crypto.randomBytes(6).toString('hex');
  const job = {
    id,
    label: label || filename,
    filename,
    paramsText: { geography, icp },
    params: { locations, industries, icpKeywords: keywords, peoplePerCompany: count },
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    progress: { total: 0, done: 0, found: 0, notFound: 0, noPeople: 0, prospects: 0, errors: 0, current: '' },
    rows: [],
    stopRequested: false
  };
  jobs.set(id, job);
  runningId = id;
  while (jobs.size > MAX_JOBS_KEPT) jobs.delete(jobs.keys().next().value);

  logger.info(`Job ${id} "${job.label}": ${count}/company, geography=[${locations.join(' | ') || 'any'}], ICP=[${keywords.join(', ')}]${industries.length ? `, industries=[${industries.join(', ')}]` : ''}`);
  runJob({
    apiKey: APOLLO_API_KEY,
    fileBuffer,
    filename,
    params: job.params,
    onProgress: (s) => {
      job.progress = { ...s };
    },
    shouldStop: () => job.stopRequested,
    rows: job.rows
  })
    .then(({ state }) => {
      job.progress = { ...state };
      job.status = state.fatal ? 'failed' : job.stopRequested ? 'stopped' : 'done';
      if (state.fatal) job.error = state.fatal;
    })
    .catch((err) => {
      job.status = 'failed';
      job.error = err.message;
      logger.error(`Job ${id} failed: ${err.message}`);
    })
    .finally(() => {
      job.finishedAt = new Date().toISOString();
      runningId = null;
    });
  return job;
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
    if (url.pathname === '/presets') return send(200, { apolloKeySet: !!APOLLO_API_KEY, presets: presets() });

    if (url.pathname === '/jobs' && req.method === 'GET') {
      return send(200, { running: runningId, jobs: [...jobs.values()].reverse().map(publicJob) });
    }

    if (url.pathname === '/jobs' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.length) return send(400, { error: 'empty upload - choose the companies file' });
      const job = startJob({
        fileBuffer: body,
        filename: url.searchParams.get('filename') || 'companies.csv',
        geography: url.searchParams.get('geography') || '',
        icp: url.searchParams.get('icp') || '',
        peoplePerCompany: url.searchParams.get('count') || '8',
        label: url.searchParams.get('label') || ''
      });
      return send(202, { status: 'started', job: publicJob(job) });
    }

    const m = url.pathname.match(/^\/jobs\/([a-f0-9]+)(?:\/(stop|download))?$/);
    if (!m) return send(404, { error: 'not found', routes: ['/', '/healthz', '/presets', 'GET|POST /jobs', '/jobs/:id', 'POST /jobs/:id/stop', '/jobs/:id/download'] });
    const job = jobs.get(m[1]);
    if (!job) return send(404, { error: 'unknown or expired job (results are kept only while the server runs)' });

    if (!m[2]) return send(200, publicJob(job));
    if (m[2] === 'stop' && req.method === 'POST') {
      job.stopRequested = true;
      return send(202, { status: job.status === 'running' ? 'stopping' : job.status });
    }
    if (m[2] === 'download') {
      const csv = toCsv(job.rows);
      const base = (job.label || 'prospects').replace(/[^\w.-]+/g, '_').replace(/\.(csv|xlsx|xls)$/i, '');
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${base}-prospects.csv"`,
        'Content-Length': Buffer.byteLength(csv)
      });
      return res.end(csv);
    }
    send(405, { error: 'method not allowed' });
  } catch (err) {
    logger.error(`${req.method} ${url.pathname} failed:`, err.message);
    send(400, { error: err.message });
  }
});

server.listen(PORT, () => {
  logger.info(`Prospecting app on :${PORT} (${presets().length} presets from ${PROJECTS_DIR})`);
  if (!APOLLO_API_KEY) logger.warn('APOLLO_API_KEY is not set - runs will fail until it is');
  if (!RUN_TOKEN) logger.warn('RUN_TOKEN is not set - the app is open to anyone with the URL');
});

async function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down...`);
  server.close();
  const j = runningId && jobs.get(runningId);
  if (j) j.stopRequested = true;
  const start = Date.now();
  while (runningId && Date.now() - start < 30000) await new Promise((r) => setTimeout(r, 500));
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
