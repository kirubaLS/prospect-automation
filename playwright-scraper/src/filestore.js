const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { parseCompaniesFile } = require('./files');

// File-backed store: companies uploaded as CSV/XLSX, prospects exported the
// same way. State is held in memory and mirrored to <dataDir>/state.json
// after every change, so it survives between runs on one machine/container.
// It does NOT survive a container being replaced (a Render redeploy, crash,
// or free-tier restart) - download results regularly.
//
// createFileStore(dataDir) gives one independent store per directory (one
// per project); the module's default export is the store for config.dataDir,
// used by the legacy single-list CLI/server.

// "Done"-like outcomes are terminal. "Error" is retried on later runs, but
// only MAX_ERROR_ATTEMPTS times so a permanently bad row doesn't burn an
// API call on every run forever.
const MAX_ERROR_ATTEMPTS = 3;
const TERMINAL = ['done', 'no matches', 'not in apollo', 'pre-screen failed'];

function createFileStore(dataDir) {
  const STATE_FILE = path.join(dataDir, 'state.json');
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
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE_FILE);
  }

  function keyOf(c) {
    return (c['LinkedIn URL'] || c['Company Name'] || '').trim().toLowerCase();
  }

  // Merges an uploaded companies file into the current list: new companies
  // are added as pending, existing ones (matched by LinkedIn URL, else name)
  // keep their Status unless the file explicitly sets one. `replace` starts over.
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

  function isPending(c) {
    const s = (c.Status || '').trim().toLowerCase();
    if (!(c['Company Name'] || '').trim()) return false;
    if (TERMINAL.includes(s)) return false;
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

  async function setCompanyMeta(rowNumber, meta) {
    const c = state.companies[rowNumber - 1];
    if (!c) throw new Error(`No company at row ${rowNumber}`);
    Object.assign(c, meta);
    save();
  }

  async function appendRunLog(summary) {
    state.runLog.push(summary);
    if (state.runLog.length > 200) state.runLog = state.runLog.slice(-200);
    save();
  }

  function snapshot() {
    const statuses = { pending: pendingList().length, done: 0, noMatches: 0, notInApollo: 0, prescreenFailed: 0, error: 0, givenUp: 0 };
    for (const c of state.companies) {
      const s = (c.Status || '').trim().toLowerCase();
      if (s === 'done') statuses.done++;
      else if (s === 'no matches') statuses.noMatches++;
      else if (s === 'not in apollo') statuses.notInApollo++;
      else if (s === 'pre-screen failed') statuses.prescreenFailed++;
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
      runs: state.runLog.length,
      lastRun: state.runLog.length ? state.runLog[state.runLog.length - 1] : null
    };
  }

  function reset() {
    state = { companies: [], prospects: [], runLog: [], uploadedAt: null, sourceFile: null };
    save();
  }

  load();

  return {
    dataDir,
    importCompanies,
    getPendingCompanies,
    appendProspects,
    updateCompanyStatus,
    setCompanyMeta,
    appendRunLog,
    snapshot,
    getCompanies: () => state.companies,
    getProspects: () => state.prospects,
    reset
  };
}

// Default store (legacy single-list CLI/server) - lazy so requiring this
// module for createFileStore alone doesn't need config to be loadable.
let defaultStore = null;
function getDefault() {
  if (!defaultStore) defaultStore = createFileStore(require('./config').dataDir);
  return defaultStore;
}

module.exports = new Proxy(
  { createFileStore },
  {
    get(target, prop) {
      if (prop in target) return target[prop];
      const store = getDefault();
      return store[prop];
    }
  }
);
