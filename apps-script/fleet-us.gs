/**
 * Fleet & Transport (US) - Apollo.io prospecting for Google Sheets
 *
 * Setup (once):
 *   1. In this Google Sheet: Extensions -> Apps Script, delete the sample code,
 *      paste this whole file, save (Ctrl+S).
 *   2. Reload the Sheet. A "Prospecting" menu appears.
 *   3. Prospecting -> Set Apollo API key (stored privately in Script Properties).
 *   4. Prospecting -> Create / repair tabs. Fill the "Companies" tab
 *      (Company Name, LinkedIn URL) - or File -> Import your Excel into it.
 *   5. Prospecting -> Run pending companies. Results land in "Prospects".
 *      Download: File -> Download -> Microsoft Excel (.xlsx).
 *
 * The run stops itself before Google's 6-minute limit and schedules itself
 * to continue a minute later until nothing is pending.
 *
 * Columns the script cannot fill (no data API has LinkedIn activity or
 * connection counts) are left blank for the researcher:
 *   Connections 500+, Activity, Open to work?
 */

// ============================ PROJECT CONFIG ============================
const CONFIG = {
  "name": "Fleet & Transport (US)",
  "description": "US transport/fleet companies. ICP: CEO, MD, President; fleet, maintenance, operations, safety, logistics, procurement.",
  "targetPerCompany": 8,
  "maxCandidatesPerCompany": 20,
  "prescreen": {
    "requireOrganizationFound": true,
    "minEmployees": 1,
    "countries": [
      "United States"
    ],
    "industriesAnyOf": [],
    "enforceIndustry": false
  },
  "personLocations": [
    "United States"
  ],
  "seniorityTiers": [
    {
      "label": "Decision makers",
      "seniorities": [
        "owner",
        "founder",
        "c_suite",
        "partner",
        "vp",
        "head",
        "director"
      ]
    },
    {
      "label": "All employees (managers last)",
      "seniorities": [
        "manager",
        "senior"
      ]
    }
  ],
  "titleKeywords": [
    "CEO",
    "Chief Executive",
    "President",
    "Managing Director",
    "Owner",
    "Vice President",
    "Director",
    "Fleet",
    "Maintenance",
    "Operations",
    "Safety",
    "Logistics",
    "Procurement",
    "Purchasing",
    "Transportation",
    "Terminal"
  ],
  "rules": {
    "tiers": [
      {
        "priority": "Tier 1",
        "score": 92,
        "patterns": [
          "\\bCEO\\b",
          "Chief Executive",
          "President\\b",
          "Managing Director",
          "\\bMD\\b",
          "Owner",
          "Founder"
        ]
      },
      {
        "priority": "Tier 1",
        "score": 88,
        "patterns": [
          "(VP|Vice President|Director|Head).*(Fleet|Maintenance|Operations|Safety|Logistics|Procurement|Purchasing|Transportation)",
          "Chief Operating",
          "\\bCOO\\b",
          "Chief (Safety|Logistics|Procurement)"
        ]
      },
      {
        "priority": "Tier 2",
        "score": 76,
        "patterns": [
          "Fleet",
          "Maintenance (Manager|Director|Supervisor)",
          "Operations Manager",
          "Safety (Manager|Director)",
          "Logistics Manager",
          "Procurement Manager",
          "Purchasing Manager",
          "Terminal Manager"
        ]
      },
      {
        "priority": "Tier 3",
        "score": 60,
        "patterns": [
          "Manager",
          "Supervisor",
          "Superintendent"
        ]
      }
    ],
    "exclude": [
      "Software (Engineer|Developer)",
      "Developer",
      "Programmer",
      "Assistant",
      "Intern",
      "Trainee",
      "Analyst",
      "Executive\\b",
      "Associate\\b",
      "Coordinator",
      "Recruiter",
      "Sales",
      "Marketing",
      "Business Development",
      "Driver\\b",
      "Dispatcher",
      "Technician",
      "Mechanic\\b",
      "Clerk",
      "Receptionist",
      "Student"
    ],
    "seniorityBonus": {
      "c_suite": 4,
      "owner": 4,
      "founder": 4,
      "partner": 3,
      "vp": 3,
      "head": 3,
      "director": 2,
      "manager": 0,
      "senior": -5,
      "entry": -15,
      "intern": -30
    }
  },
  "manualColumns": [
    "Connections 500+",
    "Activity",
    "Open to work?"
  ],
  "notes": "SOP: decision makers -> all employees -> managers as last priority. Activity: High <=1 month, else Medium; none = exclude (manual)."
};
// ========================================================================

const SHEETS = { companies: 'Companies', prospects: 'Prospects', log: 'RunLog' };
const COMPANY_HEADERS = ['Company Name', 'LinkedIn URL', 'Status', 'Error', 'PreScreen', 'ApolloOrg', 'ApolloLinkedIn', 'Industry', 'Employees', 'HQ', 'Prospects', 'UpdatedAt'];
const PROSPECT_HEADERS = ['Company', 'Name', 'Designation', 'Seniority', 'Function', 'LinkedInURL', 'Location', 'Score', 'Priority', 'Reason', 'Status', 'Connections 500+', 'Activity', 'Open to work?', 'Source', 'AddedAt'];
const TERMINAL = ['done', 'no matches', 'not in apollo', 'pre-screen failed', 'skipped'];
const TIME_BUDGET_MS = 5 * 60 * 1000;
const APOLLO = 'https://api.apollo.io/api/v1';

// ------------------------------- menu ----------------------------------
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Prospecting')
    .addItem('Run pending companies', 'runPending')
    .addItem('Run next 3 only (test)', 'runNext3')
    .addSeparator()
    .addItem('Create / repair tabs', 'ensureTabs')
    .addItem('Set Apollo API key', 'setApiKey')
    .addItem('Reset all statuses (re-run everything)', 'resetStatuses')
    .addItem('Stop scheduled continuation', 'clearTriggers')
    .addToUi();
}

function setApiKey() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('Apollo API key', 'Paste the key from Apollo -> Settings -> Integrations -> API. It is stored in this script\'s private properties, not in the sheet.', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  PropertiesService.getScriptProperties().setProperty('APOLLO_API_KEY', r.getResponseText().trim());
  ui.alert('Saved.');
}

function apiKey() {
  const k = PropertiesService.getScriptProperties().getProperty('APOLLO_API_KEY');
  if (!k) throw new Error('No Apollo API key set. Use Prospecting -> Set Apollo API key.');
  return k;
}

// ------------------------------- tabs ----------------------------------
function ensureTabs() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet(ss, SHEETS.companies, COMPANY_HEADERS);
  ensureSheet(ss, SHEETS.prospects, PROSPECT_HEADERS);
  ensureSheet(ss, SHEETS.log, ['StartedAt', 'FinishedAt', 'Companies', 'Prospects', 'Notes']);
  SpreadsheetApp.getUi().alert('Tabs are ready. Fill "Companies" (Company Name, LinkedIn URL) and run.');
}

function ensureSheet(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  const existing = sh.getRange(1, 1, 1, Math.max(headers.length, sh.getLastColumn() || 1)).getValues()[0].map((h) => String(h).trim());
  // Add any missing header without disturbing user columns.
  headers.forEach((h) => {
    if (!existing.map(norm).includes(norm(h))) {
      const col = existing.filter(Boolean).length + 1;
      sh.getRange(1, col).setValue(h);
      existing[col - 1] = h;
    }
  });
  sh.setFrozenRows(1);
  return sh;
}

function norm(s) { return String(s || '').trim().toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' '); }

function headerMap(sh) {
  const row = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const map = {};
  row.forEach((h, i) => { if (String(h).trim()) map[norm(h)] = i + 1; });
  const aliases = { 'company name': ['company', 'name', 'account', 'organisation', 'organization'], 'linkedin url': ['linkedin', 'url', 'company url', 'linkedin company url', 'link'] };
  Object.keys(aliases).forEach((canon) => { if (!map[canon]) aliases[canon].forEach((a) => { if (map[a] && !map[canon]) map[canon] = map[a]; }); });
  return map;
}

// ------------------------------- runs ----------------------------------
function runNext3() { runPending_(3); }
function runPending() { runPending_(0); }

function runPending_(limit) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { toast('A run is already in progress.'); return; }
  try {
    const key = apiKey();
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const csh = ss.getSheetByName(SHEETS.companies) || ensureSheet(ss, SHEETS.companies, COMPANY_HEADERS);
    const psh = ss.getSheetByName(SHEETS.prospects) || ensureSheet(ss, SHEETS.prospects, PROSPECT_HEADERS);
    const cm = headerMap(csh);
    if (!cm['company name'] && !cm['linkedin url']) throw new Error('Companies tab needs a "Company Name" and/or "LinkedIn URL" column in row 1.');
    ['status', 'error', 'prescreen', 'apolloorg', 'apollolinkedin', 'industry', 'employees', 'hq', 'prospects', 'updatedat'].forEach((h) => { if (!cm[h]) { const col = csh.getLastColumn() + 1; csh.getRange(1, col).setValue(COMPANY_HEADERS.find((x) => norm(x) === h)); cm[h] = col; } });

    const existingUrls = new Set(colValues(psh, headerMap(psh)['linkedinurl'] || 6).map((v) => String(v).trim()));
    const started = Date.now();
    const last = csh.getLastRow();
    let processed = 0, kept = 0, deferred = false;

    for (let r = 2; r <= last; r++) {
      const name = String(csh.getRange(r, cm['company name'] || cm['linkedin url']).getValue()).trim();
      const url = cm['linkedin url'] ? String(csh.getRange(r, cm['linkedin url']).getValue()).trim() : '';
      const status = norm(csh.getRange(r, cm['status']).getValue());
      if (!name && !url) continue;
      if (TERMINAL.includes(status)) continue;
      if (limit && processed >= limit) break;
      if (Date.now() - started > TIME_BUDGET_MS) { deferred = true; break; }

      const res = processCompany_(key, { name: name || slugOf(url), url }, existingUrls, psh);
      processed++;
      kept += res.prospects || 0;
      writeCompany_(csh, r, cm, res);
      SpreadsheetApp.flush();
    }

    logRun_(ss, started, processed, kept, deferred ? 'stopped before time limit; continuing in 1 min' : 'complete');
    if (deferred && !limit) { scheduleContinue_(); toast(`Processed ${processed} companies (${kept} prospects). Continuing automatically in ~1 minute.`); }
    else { clearTriggers(); toast(`Done: ${processed} companies, ${kept} prospects kept.`); }
  } finally {
    lock.releaseLock();
  }
}

function scheduleContinue_() {
  clearTriggers();
  ScriptApp.newTrigger('runPending').timeBased().after(60 * 1000).create();
}
function clearTriggers() {
  ScriptApp.getProjectTriggers().forEach((t) => { if (t.getHandlerFunction() === 'runPending') ScriptApp.deleteTrigger(t); });
}
function toast(msg) { try { SpreadsheetApp.getActiveSpreadsheet().toast(msg, 'Prospecting', 8); } catch (e) { Logger.log(msg); } }
function colValues(sh, col) { const n = sh.getLastRow() - 1; return n > 0 ? sh.getRange(2, col, n, 1).getValues().map((r) => r[0]) : []; }
function slugOf(url) { const m = String(url).match(/linkedin\.com\/(?:company|school|showcase)\/([^/?#]+)/i); return m ? m[1] : url; }

function resetStatuses() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const csh = ss.getSheetByName(SHEETS.companies); if (!csh) return;
  const cm = headerMap(csh); const n = csh.getLastRow() - 1; if (n < 1) return;
  ['status', 'error', 'prescreen', 'apolloorg', 'apollolinkedin', 'industry', 'employees', 'hq', 'prospects', 'updatedat'].forEach((h) => { if (cm[h]) csh.getRange(2, cm[h], n, 1).clearContent(); });
  toast('Statuses cleared. Prospects tab left as is (duplicates by LinkedIn URL are still skipped).');
}

function writeCompany_(sh, r, cm, res) {
  const set = (h, v) => { if (cm[h] && v !== undefined) sh.getRange(r, cm[h]).setValue(v); };
  set('status', res.status); set('error', res.error || ''); set('prescreen', res.prescreen || '');
  if (res.org) { set('apolloorg', res.org.name); set('apollolinkedin', res.org.linkedinUrl); set('industry', res.org.industry); set('employees', res.org.employees); set('hq', res.org.hq); }
  set('prospects', res.prospects || 0); set('updatedat', new Date());
}

function logRun_(ss, started, processed, kept, notes) {
  const sh = ss.getSheetByName(SHEETS.log) || ensureSheet(ss, SHEETS.log, ['StartedAt', 'FinishedAt', 'Companies', 'Prospects', 'Notes']);
  sh.appendRow([new Date(started), new Date(), processed, kept, notes]);
}

// --------------------------- one company -------------------------------
function processCompany_(key, company, existingUrls, psh) {
  let found;
  try { found = findOrganization_(key, company); }
  catch (e) { return { status: 'Error', error: String(e.message || e) }; }
  const org = found.organization;
  const screen = prescreen_(org, CONFIG.prescreen || {});
  if (!org) return { status: 'Not in Apollo', error: found.reason + ' - find the decision maker manually', prescreen: screen.note };
  if (!screen.pass) return { status: 'Pre-screen failed', error: screen.note, prescreen: screen.note, org };

  let candidates;
  try { candidates = collectCandidates_(key, org); }
  catch (e) { return { status: 'Error', error: String(e.message || e), prescreen: screen.note, org }; }
  if (!candidates.length) return { status: 'No Matches', error: 'No people matched the ICP titles/geography in Apollo - try the manual route', prescreen: screen.note, org, prospects: 0 };

  const selected = qualifyAndSelect_(candidates);
  const now = new Date();
  let written = 0;
  selected.forEach((p) => {
    if (!p.profileUrl || existingUrls.has(p.profileUrl)) return;
    existingUrls.add(p.profileUrl);
    psh.appendRow([company.name, p.name, p.title, p.seniorityLabel, (p.departments || []).join(', '), p.profileUrl, p.location, p.score, p.priority, p.reason + (p.tierLabel ? ' [' + p.tierLabel + ']' : ''), p.status, '', '', '', 'apollo', now]);
    written++;
  });
  return { status: 'Done', error: written < selected.length ? (selected.length - written) + ' already present' : '', prescreen: screen.note, org, prospects: selected.length };
}

function prescreen_(org, rules) {
  if (!org) return rules.requireOrganizationFound === false ? { pass: true, note: 'not in Apollo' } : { pass: false, note: 'Not in Apollo' };
  if (rules.minEmployees && org.employees != null && org.employees < rules.minEmployees) return { pass: false, note: 'Employees ' + org.employees + ' < ' + rules.minEmployees };
  if (rules.countries && rules.countries.length && org.country && rules.countries.map((c) => c.toLowerCase()).indexOf(org.country.toLowerCase()) < 0) return { pass: false, note: 'HQ ' + org.country + ' not in ' + rules.countries.join('/') };
  if (rules.industriesAnyOf && rules.industriesAnyOf.length) {
    const ind = (org.industry || '').toLowerCase();
    if (!rules.industriesAnyOf.some((k) => ind.indexOf(k.toLowerCase()) >= 0)) {
      if (rules.enforceIndustry) return { pass: false, note: 'Industry "' + (org.industry || 'unknown') + '" not in ICP' };
      return { pass: true, note: 'Industry "' + (org.industry || 'unknown') + '" not in ICP list (warning only)' };
    }
  }
  return { pass: true, note: 'Pass' };
}

// ------------------------------ Apollo ---------------------------------
function apolloPost_(key, path, body) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    Utilities.sleep(1200);
    const res = UrlFetchApp.fetch(APOLLO + path, {
      method: 'post', contentType: 'application/json', payload: JSON.stringify(body),
      headers: { 'X-Api-Key': key, 'Cache-Control': 'no-cache' }, muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    if (code >= 200 && code < 300) return JSON.parse(res.getContentText() || '{}');
    if (code === 401 || code === 403) throw new Error('Apollo rejected the API key or plan (' + code + '): ' + res.getContentText().slice(0, 200));
    if ((code === 429 || code >= 500) && attempt < 4) { Utilities.sleep(5000 * attempt); continue; }
    throw new Error('Apollo ' + path + ' failed (' + code + '): ' + res.getContentText().slice(0, 200));
  }
}

function linkedInSlug_(url) { const m = String(url || '').match(/linkedin\.com\/(?:company|school|showcase)\/([^/?#]+)/i); return m ? m[1].toLowerCase() : null; }

function findOrganization_(key, company) {
  const wantSlug = linkedInSlug_(company.url);
  const data = apolloPost_(key, '/mixed_companies/search', { q_organization_name: company.name || wantSlug, page: 1, per_page: 10 });
  const orgs = (data.organizations || data.accounts || []).map((o) => ({
    id: o.id, name: o.name || '', linkedinUrl: o.linkedin_url || '', industry: o.industry || '', employees: o.estimated_num_employees == null ? null : o.estimated_num_employees,
    country: o.country || '', hq: [o.city, o.state, o.country].filter(Boolean).join(', ')
  }));
  if (!orgs.length) return { organization: null, reason: 'no Apollo organization matched the name' };
  const bySlug = wantSlug && orgs.find((o) => linkedInSlug_(o.linkedinUrl) === wantSlug);
  if (bySlug) return { organization: bySlug, matchedBy: 'linkedin' };
  const byName = orgs.find((o) => o.name.trim().toLowerCase() === String(company.name).trim().toLowerCase());
  if (byName) return { organization: byName, matchedBy: 'name' };
  return { organization: null, reason: 'Apollo candidates did not match the LinkedIn URL/name (closest: ' + orgs[0].name + ' ' + orgs[0].linkedinUrl + ')' };
}

function collectCandidates_(key, org) {
  const seen = {}; const out = [];
  const tiers = CONFIG.seniorityTiers || [];
  for (let t = 0; t < tiers.length && out.length < CONFIG.maxCandidatesPerCompany; t++) {
    const body = { organization_ids: [org.id], person_seniorities: tiers[t].seniorities, page: 1, per_page: CONFIG.maxCandidatesPerCompany };
    if (CONFIG.titleKeywords && CONFIG.titleKeywords.length) body.person_titles = CONFIG.titleKeywords;
    if (CONFIG.personLocations && CONFIG.personLocations.length) body.person_locations = CONFIG.personLocations;
    const data = apolloPost_(key, '/mixed_people/search', body);
    (data.people || data.contacts || []).forEach((p) => {
      if (out.length >= CONFIG.maxCandidatesPerCompany) return;
      const person = {
        name: [p.first_name, p.last_name].filter(Boolean).join(' ') || p.name || '', title: p.title || '', headline: p.headline || '',
        seniority: p.seniority || '', departments: p.departments || [], profileUrl: p.linkedin_url || '',
        location: [p.city, p.state, p.country].filter(Boolean).join(', '), tierIndex: t, tierLabel: tiers[t].label
      };
      const k = person.profileUrl || (person.name + '|' + person.title);
      if (!person.name || seen[k]) return;
      seen[k] = true; out.push(person);
    });
  }
  return out;
}

// --------------------------- qualification -----------------------------
function seniorityLabel_(s) {
  return ({ owner: 'C-Suite', founder: 'C-Suite', c_suite: 'C-Suite', partner: 'C-Suite', vp: 'VP', head: 'Director', director: 'Director', manager: 'Manager' })[s] || 'Other';
}

function qualify_(c) {
  const rules = CONFIG.rules || {};
  const title = c.title || '';
  const text = title + ' | ' + (c.headline || '');
  const ex = (rules.exclude || []).find((p) => new RegExp(p, 'i').test(title));
  if (ex) return { score: 0, priority: 'Skip', excluded: true, reason: 'Excluded title pattern: ' + ex };
  const bonus = (rules.seniorityBonus || {})[c.seniority] || 0;
  for (const tier of rules.tiers || []) {
    const hit = (tier.patterns || []).find((p) => new RegExp(p, 'i').test(title)) || (tier.patterns || []).find((p) => new RegExp(p, 'i').test(text));
    if (hit) return { score: Math.max(1, Math.min(100, tier.score + bonus)), priority: tier.priority, reason: tier.priority + ': title matched "' + hit + '"' + (c.seniority ? ' (Apollo seniority: ' + c.seniority + ')' : '') };
  }
  return { score: Math.max(1, 30 + bonus), priority: 'Skip', reason: 'No ICP title pattern matched' };
}

function qualifyAndSelect_(candidates) {
  const scored = candidates.map((c) => Object.assign({}, c, qualify_(c), { seniorityLabel: seniorityLabel_(c.seniority) })).filter((c) => !c.excluded);
  scored.sort((a, b) => b.score - a.score || a.tierIndex - b.tierIndex);
  const matched = scored.filter((c) => c.priority !== 'Skip');
  const pool = matched.length >= CONFIG.targetPerCompany ? matched : scored;
  return pool.slice(0, CONFIG.targetPerCompany).map((c) => Object.assign(c, { status: c.priority === 'Skip' ? 'Needs Review' : 'Auto-Approved' }));
}
