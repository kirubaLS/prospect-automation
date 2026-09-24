const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');
const { parseCompaniesFile } = require('./files');

// File-backed store: companies uploaded as CSV/XLSX, prospects exported the
// same way. State is held in memory and mirrored to DATA_DIR/state.json
// after every change, so it survives between runs on one machine/container.
// It does NOT survive a container being replaced (a Render redeploy, crash,
// or free-tier restart) - download results regularly, or use the Sheets
// backend when durability matters more than avoiding Google setup.

const STATE_FILE = path.join(config.dataDir, 'state.json');

let state = { companies: [], prospects: [], runLog: [], uploadedAt: null, sourceFile: null };

function load() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
      logger.info(`Loaded ${state.companies.length} companies / ${state.prospects.length} prospects from ${STATE_FILE}`);
    }
  } catch (err) {
    logger.warn(`Could not load ${STATE_FILE}: ${err.message} - starting empty`);
  }
}

function save() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_FILE);
}

function keyOf(c) {
  return (c['LinkedIn URL'] || c['Company Name'] || '').trim().toLowerCase();
}

// Merges an uploaded companies file into the current list: new companies are
// added as pending, existing ones (matched by LinkedIn URL, else name) keep
// their Status unless the file explicitly sets one. `replace` starts over.
function importCompanies(buffer, filename, { replace = false } = {}) {
  const incoming = parseCompaniesFile(buffer, filename);
  if (replace) state.companies = [];

  const byKey = new Map(state.companies.map((c) => [keyOf(c), c]));
  let added = 0;
  let updated = 0;
  for (const c of incoming) {
    const existing = byKey.get(keyOf(c));
    if (existing) {
      if (c.Status) existing.Status = c.Status;
      if (!existing['Company Name']) existing['Company Name'] = c['Company Name'];
      updated++;
    } else {
      state.companies.push({ ...c });
      byKey.set(keyOf(c), c);
      added++;
    }
  }
  state.uploadedAt = new Date().toISOString();
  state.sourceFile = filename || null;
  save();
  logger.info(`Imported ${filename || 'file'}: ${added} new, ${updated} existing, ${state.companies.length} total`);
  return { added, updated, total: state.companies.length, pending: pendingList().length };
}

// "Done" and "No Matches" are terminal. "Error" is retried on later runs,
// but only MAX_ERROR_ATTEMPTS times so a permanently bad row (wrong URL,
// company gone) doesn't burn a LinkedIn request on every run forever.
const MAX_ERROR_ATTEMPTS = 3;

function isPending(c) {
  const s = (c.Status || '').trim().toLowerCase();
  if (!(c['Company Name'] || '').trim()) return false;
  if (s === 'done' || s === 'no matches') return false;
  if (s === 'error' && (c.Attempts || 0) >= MAX_ERROR_ATTEMPTS) return false;
  return true;
}

function pendingList() {
  return state.companies.map((c, i) => ({ ...c, _rowNumber: i + 1 })).filter(isPending);
}

async function getPendingCompanies() {
  return pendingList();
}

async function appendProspects(rows) {
  const seen = new Set(state.prospects.map((p) => p.profileUrl));
  const fresh = rows.filter((r) => {
    if (!r.profileUrl || seen.has(r.profileUrl)) return false;
    seen.add(r.profileUrl);
    return true;
  });
  state.prospects.push(...fresh.map((r) => ({ ...r, addedAt: new Date().toISOString() })));
  save();
  return fresh.length;
}

async function updateCompanyStatus(rowNumber, status, error = '') {
  const c = state.companies[rowNumber - 1];
  if (!c) throw new Error(`No company at row ${rowNumber}`);
  c.Status = status;
  c.Error = error || '';
  c.UpdatedAt = new Date().toISOString();
  if (status === 'Error') {
    c.Attempts = (c.Attempts || 0) + 1;
    if (c.Attempts >= MAX_ERROR_ATTEMPTS) c.Error = `${c.Error} (gave up after ${c.Attempts} attempts)`;
  }
  save();
}

async function appendRunLog(summary) {
  state.runLog.push(summary);
  if (state.runLog.length > 200) state.runLog = state.runLog.slice(-200);
  save();
}

function snapshot() {
  const statuses = { pending: pendingList().length, done: 0, noMatches: 0, error: 0, givenUp: 0 };
  for (const c of state.companies) {
    const s = (c.Status || '').trim().toLowerCase();
    if (s === 'done') statuses.done++;
    else if (s === 'no matches') statuses.noMatches++;
    else if (s === 'error') {
      statuses.error++;
      if (!isPending(c)) statuses.givenUp++;
    }
  }
  return {
    sourceFile: state.sourceFile,
    uploadedAt: state.uploadedAt,
    companies: state.companies.length,
    ...statuses,
    prospects: state.prospects.length,
    runs: state.runLog.length
  };
}

function getCompanies() {
  return state.companies;
}

function getProspects() {
  return state.prospects;
}

function reset() {
  state = { companies: [], prospects: [], runLog: [], uploadedAt: null, sourceFile: null };
  save();
}

load();

module.exports = {
  importCompanies,
  getPendingCompanies,
  appendProspects,
  updateCompanyStatus,
  appendRunLog,
  snapshot,
  getCompanies,
  getProspects,
  reset
};
