// Prospecting web app (Render free tier: no browser, ~100 MB RAM).
// Upload a CSV/XLSX of company LinkedIn URLs, type the geography and ICP for
// this project, choose people per company, run, download one CSV.
//
// Env: APOLLO_API_KEY (required), PORT,
//      PROJECTS_DIR (optional: projects/*/config.json become form presets),
//      RENDER_EXTERNAL_URL (set by Render; used to keep a free instance awake
//      while a job runs - see keepAlive below).
require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');
const { runJob, exportRows, parseGeography, parseIcp, findPeople, personKey, sortRowsByActivity } = require('./jobs');
const { providersFromEnv } = require('./websearch');
const activity = require('./activity');

const PORT = parseInt(process.env.PORT || '3000', 10);
const APOLLO_API_KEY = process.env.APOLLO_API_KEY || null;
const PROJECTS_DIR = process.env.PROJECTS_DIR || path.resolve(__dirname, '..', '..', 'projects');
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_JOBS_KEPT = 20;
const MAX_QUEUED = 10;
const MAX_PEOPLE_PER_COMPANY = 25;
const SEARCH_PROVIDERS = providersFromEnv();
const APIFY = activity.configFromEnv();
let activityRunning = null; // job id whose activity check is running
// Render's free tier spins a web service down after 15 idle minutes, which
// would kill a job mid-run if the browser tab polling /jobs is closed. While
// a job runs, hit our own public URL every few minutes so it counts as
// inbound traffic. No-op when RENDER_EXTERNAL_URL is unset (local runs).
const KEEP_ALIVE_URL = process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL || null;
const KEEP_ALIVE_EVERY_MS = 5 * 60 * 1000;

const jobs = new Map(); // id -> job
const queue = []; // jobs waiting to run, oldest first
let runningId = null;
const processStartedAt = new Date();
let keepAliveTimer = null;

function keepAlive(on) {
  if (!KEEP_ALIVE_URL) return;
  if (on && !keepAliveTimer) {
    keepAliveTimer = setInterval(() => {
      fetch(`${KEEP_ALIVE_URL.replace(/\/+$/, '')}/healthz`).catch((err) => logger.warn(`keep-alive ping failed: ${err.message}`));
    }, KEEP_ALIVE_EVERY_MS);
    logger.info(`Keep-alive: pinging ${KEEP_ALIVE_URL} every ${KEEP_ALIVE_EVERY_MS / 60000} min while the job runs`);
  } else if (!on && keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
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
          icp: (industries.length ? industries.join(', ') + '; ' : '') + (c.titlePriorities ? c.titlePriorities.map((g) => g.titles.join(', ')).join(' > ') : (c.titleKeywords || []).join(', ')),
          peoplePerCompany: c.targetPerCompany || 4,
          activityCheck: !!c.activityCheck,
          activityScheme: c.activityScheme || 'standard',
          activityMaxItems: c.activityMaxItems || null,
          activityAutoFill: !!c.activityAutoFill,
          auto: c.auto !== false,
          candidatePool: c.candidatePool || 7,
          autoRounds: c.autoRounds || 2
        };
      });
  } catch (err) {
    logger.warn(`Could not read presets from ${PROJECTS_DIR}: ${err.message}`);
    return [];
  }
}

// Jobs belong to whoever started them. The browser mints a random owner token
// and sends it as the X-Owner header (or ?owner= on download links); each
// owner only sees and controls their own jobs. Not a login - it just keeps
// users from stepping on each other.
function ownerOf(req, url) {
  const o = String(req.headers['x-owner'] || url.searchParams.get('owner') || '').trim();
  return /^[\w-]{8,64}$/.test(o) ? o : null;
}

function queuePosition(j) {
  const i = queue.indexOf(j);
  return i < 0 ? null : i + (runningId ? 1 : 0);
}

// A job started with ?preset=<slug> takes every setting from that project's
// config.json, read fresh at start time; nothing from the browser form is
// used, so projects can never bleed into each other.
function presetBySlug(slug) {
  if (!slug || !/^[\w-]+$/.test(slug)) return null;
  return presets().find((p) => p.slug === slug) || null;
}

const sameCompanyAs = (row) => (r) => r.company === row.company && r.companyWebsite === row.companyWebsite && r.companyUrl === row.companyUrl;

function applyActivityResult(job, row, a) {
  if (!a) return;
  row.activity = a.label; row.activityReason = a.reason; row.activityProof = a.proof; row.activityDate = a.lastActivity; row.connections = a.connections ?? ''; row.followers = a.followers ?? ''; row.activityCounts = a.counts;
  const prog = (job.activity && job.activity.progress) || null;
  if (prog && a.label) { prog.total = (prog.total || 0) + 1; prog.done = (prog.done || 0) + 1; const k = String(a.label).toLowerCase(); if (k in prog) prog[k]++; }
}

// Remove job.rows[idx] (remembered so it never comes back) and, unless
// replace is false, search that company once more for someone new. With
// awaitActivity the newcomer's label is fetched before returning; otherwise
// it is fetched in the background when the job already carries labels.
async function removeAndReplace(job, idx, { replace = true, awaitActivity = false } = {}) {
  const row = job.rows[idx];
  if (!row || row.companyStatus !== 'Found' || !row.name) throw new Error('no such person row');
  const same = sameCompanyAs(row);
  job.removed = job.removed || [];
  job.removed.push({ company: row.company, name: row.name, title: row.title, profileUrl: row.profileUrl, key: personKey(row) });
  job.rows.splice(idx, 1);
  job.progress.prospects = Math.max(0, (job.progress.prospects || 0) - 1);
  if (!replace) { logger.info(`Job ${job.id}: deleted ${row.name} (${row.company}), no replacement`); return { row, replacement: null, message: `${row.name} deleted` }; }
  const exclude = new Set([...job.removed.filter((r) => r.company === row.company).map((r) => r.key), ...job.rows.filter((r) => same(r) && r.name).map(personKey)]);
  const org = { id: row.apolloOrgId || null, domain: row.apolloDomain || null, name: row.company, industry: row.industry || '', employees: row.employees ?? null };
  if (!org.id && !org.domain) return { row, replacement: null, message: 'removed; cannot search again for this company (no Apollo id or domain on the row)' };
  const ledger = job.progress.apollo || null;
  const people = await findPeople(APOLLO_API_KEY, org, { ...job.params, peoplePerCompany: 1 }, { exclude, ...(ledger ? { ledger } : {}) });
  const p = people[0] || null;
  if (!p) { logger.info(`Job ${job.id}: removed ${row.name} (${row.company}); no one left in Apollo`); return { row, replacement: null, message: `${row.name} removed; no one else in Apollo matches this company's geography/ICP` }; }
  const companyBits = Object.fromEntries(Object.entries(row).filter(([k]) => ['company', 'companyUrl', 'companyWebsite', 'companyStatus', 'apolloOrg', 'apolloOrgId', 'apolloDomain', 'industry', 'employees', 'hq'].includes(k)));
  const after = job.rows.map((r, i) => (same(r) ? i : -1)).filter((i) => i >= 0).pop();
  const at = after == null ? Math.min(idx, job.rows.length) : after + 1;
  const replacement = { ...companyBits, ...p, note: p.note || '', replaced: row.name };
  job.rows.splice(at, 0, replacement);
  job.progress.prospects = (job.progress.prospects || 0) + 1;
  logger.info(`Job ${job.id}: removed ${row.name} (${row.company}); replacement: ${p.name} (${p.title})`);
  const wantLabel = job.params.activityCheck && APIFY.configured && job.activity && replacement.profileUrl;
  if (wantLabel) {
    replacement.activityPending = true;
    const check = activity.runActivityCheck(APIFY, [replacement], { scheme: job.params.activityScheme, maxItems: job.params.activityMaxItems })
      .then(({ results }) => applyActivityResult(job, replacement, results[0]))
      .catch((err) => { replacement.activityReason = `activity check failed: ${err.message}`; })
      .finally(() => { delete replacement.activityPending; sortRowsByActivity(job.rows); });
    if (awaitActivity) await check;
  }
  return { row, replacement, message: `${row.name} removed; ${p.name} (${p.title}) added` };
}

// Sharp-style auto fill: a company must end with `want` HIGH/MEDIUM people.
// LOW (then Unknown) people are swapped for new matches, each labelled on
// arrival, until the target is met, Apollo runs out, or the attempt cap hits.
const AUTOFILL_MAX_SWAPS = 6;
const isGood = (r) => ['high', 'medium'].includes(String(r.activity || '').toLowerCase());
async function autoFill(job) {
  const want = job.params.peoplePerCompany;
  const stats = { companies: 0, swapped: 0, filled: 0, exhausted: 0 };
  job.activity.progress.autofill = stats;
  const keys = [...new Set(job.rows.filter((r) => r.companyStatus === 'Found' && r.name).map((r) => `${r.company}|${r.companyWebsite}|${r.companyUrl}`))];
  for (const key of keys) {
    if (job.activity.stopRequested) break;
    const rowsOf = () => job.rows.filter((r) => `${r.company}|${r.companyWebsite}|${r.companyUrl}` === key && r.companyStatus === 'Found' && r.name);
    let swaps = 0;
    stats.companies++;
    while (rowsOf().filter(isGood).length < want && swaps < AUTOFILL_MAX_SWAPS && !job.activity.stopRequested) {
      const weak = rowsOf().find((r) => String(r.activity || '').toLowerCase() === 'low') || rowsOf().find((r) => !isGood(r) && !r.activityPending);
      if (!weak) break; // nothing left to swap: fewer than `want` people in Apollo
      const idx = job.rows.indexOf(weak);
      job.activity.progress.current = `${weak.company}: swapping ${weak.name} (${weak.activity || 'no label'})`;
      swaps++; stats.swapped++;
      let res;
      try { res = await removeAndReplace(job, idx, { replace: true, awaitActivity: true }); } catch (err) { logger.warn(`autofill ${weak.company}: ${err.message}`); break; }
      if (!res.replacement) { stats.exhausted++; break; }
    }
    if (rowsOf().filter(isGood).length >= want) stats.filled++;
  }
  job.activity.progress.current = '';
  logger.info(`Job ${job.id} autofill: ${stats.swapped} swaps over ${stats.companies} companies; ${stats.filled} reached ${want} HIGH/MEDIUM, ${stats.exhausted} ran out of people`);
}

// ---- single-click automation ----
// Round 1: the job itself fetched `candidatePool` people per company (priority
// order, strict ICP). Label them; keep `finalTarget` HIGH/MEDIUM (HIGH first).
// Short company: fetch `candidatePool` more (everyone seen so far excluded, so
// the search moves on to the remaining priorities), label the newcomers, and
// judge again. After `autoRounds` rounds a short company keeps its good people,
// drops the rest, and waits for a human to press "Next round".
const companyKey = (r) => `${r.company}|${r.companyWebsite}|${r.companyUrl}`;
const foundRows = (job, key) => job.rows.filter((r) => companyKey(r) === key && r.companyStatus === 'Found' && r.name);
const labelRank = (r) => (String(r.activity || '').toLowerCase() === 'high' ? 0 : 1);

async function labelRows(job, people) {
  if (!people.length || !APIFY.configured) return;
  for (const p of people) p.activityPending = true;
  try {
    const { results } = await activity.runActivityCheck(APIFY, people, { onProgress: (st) => { job.activity.progress.current = `labelling ${st.done}/${people.length}`; }, shouldStop: () => job.activity.stopRequested, scheme: job.params.activityScheme, maxItems: job.params.activityMaxItems });
    people.forEach((p, i) => applyActivityResult(job, p, results[i]));
  } finally { for (const p of people) delete p.activityPending; }
}

async function fetchMore(job, key, n) {
  const ref = foundRows(job, key)[0] || job.rows.find((r) => companyKey(r) === key);
  if (!ref) return [];
  const org = { id: ref.apolloOrgId || null, domain: ref.apolloDomain || null, name: ref.company, industry: ref.industry || '', employees: ref.employees ?? null };
  if (!org.id && !org.domain) return [];
  job.removed = job.removed || [];
  const exclude = new Set([...job.removed.filter((r) => r.company === ref.company).map((r) => r.key), ...foundRows(job, key).map(personKey)]);
  const ledger = job.progress.apollo || null;
  const people = await findPeople(APOLLO_API_KEY, org, { ...job.params, peoplePerCompany: n }, { exclude, ...(ledger ? { ledger } : {}) });
  if (!people.length) return [];
  const bits = Object.fromEntries(Object.entries(ref).filter(([k]) => ['company', 'companyUrl', 'companyWebsite', 'apolloOrg', 'apolloOrgId', 'apolloDomain', 'industry', 'employees', 'hq'].includes(k)));
  const last = job.rows.map((r, i) => (companyKey(r) === key ? i : -1)).filter((i) => i >= 0).pop();
  const fresh = people.map((p) => ({ ...bits, companyStatus: 'Found', ...p, note: p.note || '', round: job.auto.round }));
  // a company that had "No people found" now has people: drop the placeholder
  if (ref.companyStatus !== 'Found') { job.rows.splice(job.rows.indexOf(ref), 1, ...fresh); job.progress.noPeople = Math.max(0, (job.progress.noPeople || 0) - 1); job.progress.found++; }
  else job.rows.splice(last + 1, 0, ...fresh);
  job.progress.prospects = (job.progress.prospects || 0) + fresh.length;
  return fresh;
}

function dropRows(job, rows, why) {
  job.removed = job.removed || [];
  for (const r of rows) {
    const i = job.rows.indexOf(r);
    if (i < 0) continue;
    job.removed.push({ company: r.company, name: r.name, title: r.title, profileUrl: r.profileUrl, key: personKey(r), why });
    job.rows.splice(i, 1);
    job.progress.prospects = Math.max(0, (job.progress.prospects || 0) - 1);
  }
}

// Decide one company. Returns 'filled' or 'short'.
function judgeCompany(job, key) {
  const target = job.params.finalTarget;
  const rows = foundRows(job, key);
  const good = rows.filter(isGood).sort((x, y) => labelRank(x) - labelRank(y) || job.rows.indexOf(x) - job.rows.indexOf(y));
  const comp = job.auto.companies[key] || (job.auto.companies[key] = { company: rows[0] ? rows[0].company : key, rounds: 0, good: 0 });
  comp.good = good.length;
  for (const r of rows) { delete r.needsRound; delete r.autoNote; }
  if (good.length >= target) {
    const keep = new Set(good.slice(0, target));
    dropRows(job, rows.filter((r) => !keep.has(r)), 'not among the top HIGH/MEDIUM');
    comp.state = 'filled';
    for (const r of foundRows(job, key)) r.autoNote = `${target}/${target} HIGH/MEDIUM after round ${comp.rounds}`;
  } else {
    comp.state = 'short';
  }
  return comp.state;
}

async function autoStage(job, { fromRound, toRound, onlyKey = null }) {
  job.auto = job.auto || { round: 0, stage: '', companies: {} };
  job.activity = job.activity || { status: 'running', startedAt: new Date().toISOString(), finishedAt: null, progress: { total: 0, done: 0, high: 0, medium: 0, low: 0, unknown: 0, failed: 0, scheme: job.params.activityScheme, autofill: null }, stopRequested: false };
  job.activity.status = 'running'; job.activity.stopRequested = false;
  job.status = 'automating';
  while (activityRunning && activityRunning !== job.id) { job.auto.stage = 'waiting for another activity check to finish'; await new Promise((r) => setTimeout(r, 3000)); }
  activityRunning = job.id;
  keepAlive(true);
  // companies with people, plus short ones whose only row is now a "Not filled" placeholder
  const keys = onlyKey ? [onlyKey] : [...new Set([...job.rows.filter((r) => r.companyStatus === 'Found' && r.name).map(companyKey), ...Object.entries(job.auto.companies).filter(([, c]) => c.state === 'short').map(([k]) => k)])];
  try {
    for (let round = fromRound; round <= toRound; round++) {
      if (job.stopRequested || job.activity.stopRequested) break;
      job.auto.round = round;
      const pending = keys.filter((k) => !job.auto.companies[k] || job.auto.companies[k].state !== 'filled');
      if (!pending.length) break;
      if (round > 1) {
        job.auto.stage = `round ${round}: fetching ${job.params.candidatePool} more for ${pending.length} short compan${pending.length === 1 ? 'y' : 'ies'}`;
        for (const k of pending) {
          if (job.stopRequested) break;
          const comp = job.auto.companies[k];
          job.activity.progress.current = `${comp ? comp.company : k}: searching further priorities`;
          try { const got = await fetchMore(job, k, job.params.candidatePool); if (!got.length && comp) comp.exhausted = true; } catch (err) { logger.warn(`auto round ${round} ${k}: ${err.message}`); }
        }
      }
      job.auto.stage = `round ${round}: LinkedIn activity`;
      const toLabel = job.rows.filter((r) => pending.includes(companyKey(r)) && r.companyStatus === 'Found' && r.profileUrl && !r.activity);
      await labelRows(job, toLabel);
      job.auto.stage = `round ${round}: judging`;
      for (const k of pending) { const c = job.auto.companies[k] || (job.auto.companies[k] = { company: k.split('|')[0], rounds: 0, good: 0 }); c.rounds = round; judgeCompany(job, k); }
    }
    // after the allowed rounds: short companies keep their good people, lose the rest, and wait for a human
    for (const k of keys) {
      const c = job.auto.companies[k];
      if (!c || c.state !== 'short') continue;
      const rows = foundRows(job, k);
      const sample = rows[0] || job.rows.find((r) => companyKey(r) === k) || {};
      const bits = Object.fromEntries(Object.entries(sample).filter(([kk]) => ['company', 'companyUrl', 'companyWebsite', 'apolloOrg', 'apolloOrgId', 'apolloDomain', 'industry', 'employees', 'hq'].includes(kk)));
      dropRows(job, rows.filter((r) => !isGood(r)), 'LOW/Unknown after the automatic rounds');
      const left = foundRows(job, k);
      c.needsRound = c.rounds + 1;
      const msg = c.exhausted ? `${c.good}/${job.params.finalTarget} HIGH/MEDIUM - Apollo has nobody else for this geography/ICP` : `${c.good}/${job.params.finalTarget} HIGH/MEDIUM after ${c.rounds} round${c.rounds === 1 ? '' : 's'} - press Next round for further priorities`;
      if (left.length) for (const r of left) { r.autoNote = msg; r.needsRound = c.exhausted ? 0 : c.needsRound; }
      else {
        const ref = job.rows.find((r) => companyKey(r) === k);
        if (ref) { ref.companyStatus = 'Not filled'; ref.name = 'Not filled'; ref.title = ''; ref.location = ''; ref.profileUrl = ''; ref.activity = ''; ref.note = msg; ref.needsRound = c.exhausted ? 0 : c.needsRound; }
        else job.rows.push({ company: k.split('|')[0], companyWebsite: k.split('|')[1], companyUrl: k.split('|')[2], ...bits, companyStatus: 'Not filled', name: 'Not filled', note: msg, needsRound: c.exhausted ? 0 : c.needsRound });
      }
    }
    job.auto.stage = 'done';
  } catch (err) {
    job.auto.stage = `failed: ${err.message}`;
    logger.error(`Job ${job.id} automation failed: ${err.message}`);
  } finally {
    job.status = job.stopRequested ? 'stopped' : 'done';
    job.activity.status = job.activity.stopRequested ? 'stopped' : 'done';
    job.activity.finishedAt = new Date().toISOString();
    job.activity.progress.current = '';
    activityRunning = null;
    sortRowsByActivity(job.rows);
    if (!runningId && !queue.length) keepAlive(false);
    const cs = Object.values(job.auto.companies);
    logger.info(`Job ${job.id} automation: round ${job.auto.round}; ${cs.filter((c) => c.state === 'filled').length} filled, ${cs.filter((c) => c.state === 'short').length} short`);
  }
}

function publicJob(j) {
  return {
    id: j.id,
    project: j.project || null,
    ahead: queuePosition(j),
    activity: j.activity ? { status: j.activity.status, progress: j.activity.progress, error: j.activity.error || null, startedAt: j.activity.startedAt, finishedAt: j.activity.finishedAt } : null,
    auto: j.auto ? { round: j.auto.round, stage: j.auto.stage, short: Object.values(j.auto.companies).filter((c) => c.state === 'short').length, filled: Object.values(j.auto.companies).filter((c) => c.state === 'filled').length } : null,
    label: j.label,
    filename: j.filename,
    params: { geography: j.paramsText.geography, icp: j.paramsText.icp, peoplePerCompany: j.params.peoplePerCompany, locations: j.params.locations, icpKeywords: j.params.icpKeywords, industries: j.params.industries, priorities: j.params.priorities || null, resolve: j.params.resolve, activityCheck: !!j.params.activityCheck, activityScheme: j.params.activityScheme || 'standard', activityAutoFill: !!j.params.activityAutoFill, auto: !!j.params.auto, finalTarget: j.params.finalTarget || j.params.peoplePerCompany, candidatePool: j.params.candidatePool || null, autoRounds: j.params.autoRounds || null, searchExhausted: !!j.params.searchExhausted },
    status: j.status,
    queuedAt: j.queuedAt || null,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    progress: j.progress,
    error: j.error || null,
    rows: j.rows.length
  };
}

function startJob({ owner, fileBuffer, filename, project = null, geography, icp, peoplePerCompany, label, resolve, activityCheck = false, activityScheme = 'standard', activityMaxItems = null, activityAutoFill = false, auto = false, candidatePool = 7, autoRounds = 2 }) {
  if (!owner) throw new Error('missing owner token - reload the page');
  if (queue.length >= MAX_QUEUED) throw new Error(`the queue is full (${MAX_QUEUED} jobs waiting) - try again later`);
  if (!APOLLO_API_KEY) throw new Error('APOLLO_API_KEY is not set on the server');
  const finalTarget = Math.min(MAX_PEOPLE_PER_COMPANY, Math.max(1, parseInt(peoplePerCompany, 10) || 4));
  // Single-click automation searches a wider pool per company (7 by default),
  // labels them, and keeps `finalTarget` HIGH/MEDIUM people.
  const pool = Math.min(MAX_PEOPLE_PER_COMPANY, Math.max(finalTarget, parseInt(candidatePool, 10) || 7));
  const count = auto ? pool : finalTarget;
  const locations = parseGeography(geography);
  const { industries, keywords, priorities } = parseIcp(icp);
  if (!keywords.length) throw new Error('ICP is empty - list the roles/functions to look for (e.g. "IT, Administration, Procurement, Finance")');
  // Default is always the free path: Apollo people search (0 credits) + web
  // search for the LinkedIn URL. Credit-costing enrichment runs only when
  // 'apollo' or 'apollo+search' is asked for explicitly; a missing web search
  // key is an error, never a silent switch to credits.
  resolve = ['search', 'apollo', 'apollo+search', 'none'].includes(resolve) ? resolve : 'search';
  if ((resolve === 'search' || resolve === 'apollo+search') && !SEARCH_PROVIDERS.length) throw new Error('web search is not configured on the server (SERPER_API_KEY, TAVILY_API_KEY, BRAVE_SEARCH_API_KEY or GOOGLE_CSE_API_KEY + GOOGLE_CSE_CX) - choose Apollo enrichment or none');

  const id = crypto.randomBytes(6).toString('hex');
  const job = {
    id,
    owner,
    project: project ? { slug: project.slug, name: project.name, edited: !!project.edited } : null,
    fileBuffer,
    label: label || filename,
    filename,
    paramsText: { geography, icp },
    params: { locations, industries, icpKeywords: keywords, priorities, peoplePerCompany: count, resolve, activityCheck: !!activityCheck, activityScheme: ['yard', 'sharp'].includes(activityScheme) ? activityScheme : 'standard', activityMaxItems: parseInt(activityMaxItems, 10) || null, activityAutoFill: !!activityAutoFill && !auto, auto: !!auto, finalTarget, candidatePool: pool, autoRounds: Math.max(1, parseInt(autoRounds, 10) || 2), searchProviders: SEARCH_PROVIDERS.map((p) => ({ ...p })) },
    status: 'queued',
    queuedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    progress: { total: 0, done: 0, found: 0, notFound: 0, noPeople: 0, prospects: 0, errors: 0, current: '' },
    rows: [],
    stopRequested: false
  };
  jobs.set(id, job);
  queue.push(job);
  // forget the oldest finished jobs; never a queued or running one
  for (const [k, v] of jobs) {
    if (jobs.size <= MAX_JOBS_KEPT) break;
    if (v.status !== 'running' && v.status !== 'queued') jobs.delete(k);
  }

  if (resolve === 'apollo' || resolve === 'apollo+search') logger.warn(`Job ${id}: Apollo enrichment chosen - 1 credit per person${resolve === 'apollo+search' ? ' Apollo fills in' : ''}`);
  logger.info(`Job ${id} "${job.label}" (owner ${owner.slice(0, 8)}${project ? `, project ${project.slug}` : ', custom settings'}): ${count}/company, resolve=${resolve}, geography=[${locations.join(' | ') || 'any'}], ICP=${priorities ? priorities.map((g, i) => `P${i + 1}[${g.join(', ')}]`).join(' > ') : `[${keywords.join(', ')}]`}${industries.length ? `, industries=[${industries.join(', ')}]` : ''}${runningId ? ` - queued behind ${queuePosition(job)} job(s)` : ''}`);
  keepAlive(true);
  pump();
  return job;
}

// Run queued jobs one at a time, oldest first.
function pump() {
  if (runningId) return;
  const job = queue.shift();
  if (!job) { keepAlive(false); return; }
  if (job.stopRequested) { job.status = 'stopped'; job.finishedAt = new Date().toISOString(); return pump(); }
  const id = job.id;
  const fileBuffer = job.fileBuffer;
  delete job.fileBuffer;
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  runningId = id;
  logger.info(`Job ${id} "${job.label}" started${queue.length ? ` (${queue.length} waiting)` : ''}`);
  runJob({
    apiKey: APOLLO_API_KEY,
    fileBuffer,
    filename: job.filename,
    params: job.params,
    onProgress: (s) => {
      job.progress = { ...s };
    },
    shouldStop: () => job.stopRequested,
    rows: job.rows
  })
    .then(async ({ state }) => {
      job.progress = { ...state };
      job.status = state.fatal ? 'failed' : job.stopRequested ? 'stopped' : 'done';
      if (state.fatal) job.error = state.fatal;
      if (job.params.auto && job.status === 'done' && APIFY.configured) {
        runningId = null; pump(); // let the next queued job start its people search while this one labels
        await autoStage(job, { fromRound: 1, toRound: job.params.autoRounds });
      } else if (job.params.auto && job.status === 'done') {
        job.auto = { round: 0, stage: 'skipped: Apify tokens missing on the server', companies: {} };
      }
    })
    .catch((err) => {
      job.status = 'failed';
      job.error = err.message;
      logger.error(`Job ${id} failed: ${err.message}`);
    })
    .finally(() => {
      job.finishedAt = new Date().toISOString();
      if (runningId === id) { runningId = null; pump(); } // automation may already have handed the slot on
    });
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

  try {
    if (url.pathname === '/presets') return send(200, { apolloKeySet: !!APOLLO_API_KEY, searchProviders: SEARCH_PROVIDERS.map((p) => p.name), apify: APIFY.configured, presets: presets() });

    const owner = ownerOf(req, url);
    if (url.pathname === '/jobs' && req.method === 'GET') {
      const mine = [...jobs.values()].filter((j) => j.owner === owner).reverse();
      const runningJob = runningId && jobs.get(runningId);
      return send(200, {
        running: runningJob && runningJob.owner === owner ? runningId : null,
        busy: { running: !!runningId, mine: !!(runningJob && runningJob.owner === owner), queued: queue.length },
        jobs: mine.map(publicJob)
      });
    }

    if (url.pathname === '/jobs' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.length) return send(400, { error: 'empty upload - choose the companies file' });
      const slug = url.searchParams.get('preset') || '';
      const preset = presetBySlug(slug);
      if (slug && !preset) return send(400, { error: `unknown project preset "${slug}" - reload the page and choose it again` });
      const filename = url.searchParams.get('filename') || 'companies.csv';
      // Geography / titles / count may be edited for one run; activity settings
      // and the label always come from the project.
      const ov = (k) => url.searchParams.get(k);
      const edited = !!(ov('geography') || ov('icp') || ov('count'));
      const job = startJob(preset ? {
        owner,
        fileBuffer: body,
        filename,
        project: { ...preset, edited },
        geography: ov('geography') || preset.geography,
        icp: ov('icp') || preset.icp,
        peoplePerCompany: ov('count') || String(preset.peoplePerCompany),
        label: url.searchParams.get('label') || `${preset.name} - ${filename}`,
        resolve: url.searchParams.get('resolve') || undefined,
        activityCheck: preset.activityCheck,
        activityScheme: preset.activityScheme,
        activityMaxItems: preset.activityMaxItems,
        activityAutoFill: preset.activityAutoFill,
        auto: url.searchParams.get('auto') !== '0' && preset.auto,
        candidatePool: preset.candidatePool,
        autoRounds: preset.autoRounds
      } : {
        owner,
        fileBuffer: body,
        filename,
        geography: url.searchParams.get('geography') || '',
        icp: url.searchParams.get('icp') || '',
        peoplePerCompany: url.searchParams.get('count') || '4',
        label: url.searchParams.get('label') || '',
        resolve: url.searchParams.get('resolve') || (url.searchParams.get('enrich') === '0' ? 'none' : undefined),
        activityCheck: url.searchParams.get('activity') === '1',
        activityScheme: url.searchParams.get('scheme') || 'standard',
        activityMaxItems: url.searchParams.get('items') || null,
        auto: url.searchParams.get('auto') === '1',
        candidatePool: url.searchParams.get('pool') || 7,
        autoRounds: url.searchParams.get('rounds') || 2
      });
      return send(202, { status: job.status === 'running' ? 'started' : 'queued', job: publicJob(job) });
    }

    const m = url.pathname.match(/^\/jobs\/([a-f0-9]+)(?:\/(stop|download|rows|activity|auto))?(?:\/(\d+))?$/);
    if (!m) return send(404, { error: 'not found', routes: ['/', '/healthz', '/presets', 'GET|POST /jobs', '/jobs/:id', '/jobs/:id/rows', 'POST /jobs/:id/stop', '/jobs/:id/download?format=csv|xlsx', 'DELETE /jobs/:id/rows/:index[?replace=0]', 'GET|POST|DELETE /jobs/:id/activity'] });
    const job = jobs.get(m[1]);
    if (!job) return send(404, { error: 'unknown or expired job (results are kept only while the server runs)' });
    if (job.owner !== owner) return send(403, { error: 'this job belongs to another user' });

    if (!m[2]) return send(200, publicJob(job));
    if (m[2] === 'stop' && req.method === 'POST') {
      job.stopRequested = true;
      if (job.activity && job.status === 'automating') job.activity.stopRequested = true;
      if (job.status === 'queued') {
        const i = queue.indexOf(job);
        if (i >= 0) queue.splice(i, 1);
        delete job.fileBuffer;
        job.status = 'stopped';
        job.finishedAt = new Date().toISOString();
        if (!runningId) keepAlive(false);
      }
      return send(202, { status: job.status === 'running' ? 'stopping' : job.status });
    }
    if (m[2] === 'auto' && req.method === 'POST') {
      // One more round (further priorities) for one short company (?company=key) or all short ones.
      if (!job.params.auto || !job.auto) return send(400, { error: 'this job did not run the single-click automation' });
      if (job.status === 'running' || job.status === 'queued' || job.status === 'automating') return send(409, { error: 'wait for the job to finish' });
      if (activityRunning) return send(409, { error: 'an activity check is already running' });
      if (!APIFY.configured) return send(400, { error: `Apify tokens missing on the server: ${APIFY.missing.join(', ')}` });
      const only = url.searchParams.get('company') || null;
      const shortKeys = Object.entries(job.auto.companies).filter(([k, c]) => c.state === 'short' && (!only || k === only)).map(([k]) => k);
      if (!shortKeys.length) return send(200, { status: 'nothing to do', message: 'no short companies' });
      const next = job.auto.round + 1;
      for (const k of shortKeys) delete job.auto.companies[k].needsRound;
      autoStage(job, { fromRound: next, toRound: next, onlyKey: only }).catch((err) => logger.error(`next round failed: ${err.message}`));
      return send(202, { status: 'started', round: next, companies: shortKeys.length });
    }
    if (m[2] === 'activity') {
      if (req.method === 'POST') {
        // Any job may be checked once Apify is configured; the project's flag only
        // picks the scheme and whether auto-fill runs.
        if (!APIFY.configured) return send(400, { error: `Apify tokens missing on the server: ${APIFY.missing.join(', ')}` });
        if (job.status === 'running' || job.status === 'queued' || job.status === 'automating') return send(409, { error: 'wait for the job to finish' });
        if (activityRunning || (job.activity && job.activity.status === 'filling')) return send(409, { error: 'an activity check is already running' });
        // Incremental by default: only people without a label (new after a
        // Replace, or added later) are checked; ?all=1 rechecks everyone.
        const everyone = job.rows.filter((r) => r.companyStatus === 'Found' && r.profileUrl);
        const all = url.searchParams.get('all') === '1';
        const people = all ? everyone : everyone.filter((r) => !r.activity && !r.activityPending);
        if (!everyone.length) return send(400, { error: 'no people with a LinkedIn URL in this job' });
        if (!people.length) return send(200, { status: 'nothing to do', total: 0, message: 'everyone already has a label - use "Recheck all" to redo them' });
        const prior = all ? [] : everyone.filter((r) => r.activity);
        const count = (lbl) => prior.filter((r) => String(r.activity || '').toLowerCase() === lbl).length;
        job.activity = { status: 'running', startedAt: new Date().toISOString(), finishedAt: null, progress: { total: everyone.length, done: prior.length, high: count('high'), medium: count('medium'), low: count('low'), unknown: count('unknown'), failed: 0, scheme: job.params.activityScheme, autofill: null, incremental: !all, newPeople: people.length }, stopRequested: false };
        if (all) for (const r of everyone) { r.activity = ''; r.activityReason = ''; r.activityProof = ''; r.activityDate = ''; }
        activityRunning = job.id;
        keepAlive(true);
        logger.info(`Activity check for job ${job.id}: ${people.length}${all ? '' : ' unlabelled'} people via Apify (${Object.values(APIFY.actors).map((a) => a.id).join(', ')})`);
        const base = { ...job.activity.progress };
        const merge = (st) => ({ ...base, ...st, total: base.total, done: base.done + (st.done || 0), high: base.high + (st.high || 0), medium: base.medium + (st.medium || 0), low: base.low + (st.low || 0), unknown: base.unknown + (st.unknown || 0) });
        activity.runActivityCheck(APIFY, people, { onProgress: (st) => { job.activity.progress = merge(st); }, shouldStop: () => job.activity.stopRequested, scheme: job.params.activityScheme, maxItems: job.params.activityMaxItems })
          .then(async ({ results, state }) => {
            people.forEach((r, i) => {
              const a = results[i];
              if (!a) return;
              r.activity = a.label; r.activityReason = a.reason; r.activityProof = a.proof; r.activityDate = a.lastActivity; r.connections = a.connections ?? ''; r.followers = a.followers ?? ''; r.activityCounts = a.counts;
            });
            job.activity.progress = merge(state);
            if (job.params.activityAutoFill && !job.activity.stopRequested) {
              job.activity.status = 'filling';
              await autoFill(job);
            }
            job.activity.status = job.activity.stopRequested ? 'stopped' : 'done';
            sortRowsByActivity(job.rows);
          })
          .catch((err) => { job.activity.status = 'failed'; job.activity.error = err.message; logger.error(`Activity check ${job.id} failed: ${err.message}`); })
          .finally(() => { job.activity.finishedAt = new Date().toISOString(); activityRunning = null; if (!runningId && !queue.length) keepAlive(false); });
        return send(202, { status: 'started', total: people.length, incremental: !all });
      }
      if (req.method === 'DELETE') { if (job.activity) job.activity.stopRequested = true; return send(202, { status: 'stopping' }); }
      const rows = job.rows.map((r, idx) => ({ r, idx })).filter(({ r }) => r.companyStatus === 'Found' && r.profileUrl).map(({ r, idx }) => ({ idx, pending: !!r.activityPending, company: r.company, name: r.name, title: r.title, profileUrl: r.profileUrl, activity: r.activity || '', reason: r.activityReason || '', proof: r.activityProof || '', date: r.activityDate || '', connections: r.connections ?? '', followers: r.followers ?? '', counts: r.activityCounts || null }));
      return send(200, { activity: job.activity ? publicJob(job).activity : null, rows });
    }

    if (m[2] === 'rows' && m[3] != null && req.method === 'DELETE') {
      // Remove one person and fetch the next match for that company, skipping
      // everyone already listed or removed. Same resolve mode as the job:
      // with web search this costs no Apollo credits.
      if (job.status === 'running' || job.status === 'queued' || job.status === 'automating') return send(409, { error: 'wait for the job to finish' });
      if (job.activity && (job.activity.status === 'running' || job.activity.status === 'filling')) return send(409, { error: 'wait for the activity check to finish' });
      if (job.replacing) return send(409, { error: 'another replacement is in progress - try again in a moment' });
      const idx = parseInt(m[3], 10);
      const row = job.rows[idx];
      if (!row || row.companyStatus !== 'Found' || !row.name) return send(404, { error: 'no such person row' });
      if (url.searchParams.get('name') && url.searchParams.get('name') !== row.name) return send(409, { error: 'the list changed - refresh and try again' });
      job.replacing = true;
      keepAlive(true);
      try {
        const res = await removeAndReplace(job, idx, { replace: url.searchParams.get('replace') !== '0' });
        return send(200, { removed: true, replacement: res.replacement, message: res.message });
      } catch (err) {
        return send(200, { removed: true, replacement: null, message: `${row.name} removed; replacement search failed: ${err.message}` });
      } finally {
        job.replacing = false;
        if (!runningId && !queue.length && !activityRunning) keepAlive(false);
      }
    }
    if (m[2] === 'rows') {
      const from = Math.max(0, parseInt(url.searchParams.get('from') || '0', 10) || 0);
      return send(200, { total: job.rows.length, from, rows: job.rows.slice(from, from + 500) });
    }
    if (m[2] === 'download') {
      const format = url.searchParams.get('format') === 'xlsx' ? 'xlsx' : 'csv';
      const { buffer, contentType, extension } = exportRows(job.rows, format);
      const base = (job.label || 'prospects').replace(/[^\w.-]+/g, '_').replace(/\.(csv|xlsx|xls)$/i, '');
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${base}-prospects.${extension}"`,
        'Content-Length': buffer.length
      });
      return res.end(buffer);
    }
    send(405, { error: 'method not allowed' });
  } catch (err) {
    logger.error(`${req.method} ${url.pathname} failed:`, err.message);
    send(400, { error: err.message });
  }
});

server.listen(PORT, () => {
  logger.info(`Prospecting app on :${PORT} (${presets().length} presets from ${PROJECTS_DIR}; web search: ${SEARCH_PROVIDERS.map((p) => p.name).join(', ') || 'none configured'}; Apify activity: ${APIFY.configured ? 'configured' : 'missing ' + APIFY.missing.join(', ')})`);
  if (!APOLLO_API_KEY) logger.warn('APOLLO_API_KEY is not set - runs will fail until it is');
});

async function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down...`);
  server.close();
  for (const q of queue.splice(0)) { q.status = 'stopped'; q.finishedAt = new Date().toISOString(); }
  const j = runningId && jobs.get(runningId);
  if (j) j.stopRequested = true;
  const start = Date.now();
  while (runningId && Date.now() - start < 30000) await new Promise((r) => setTimeout(r, 500));
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
