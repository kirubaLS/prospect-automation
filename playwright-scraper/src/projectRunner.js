// Runs Apollo prospecting for one project folder. Used by the CLI
// (src/project.js) and the web app (src/app.js).
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const files = require('./files');
const apollo = require('./apollo');
const { createFileStore } = require('./filestore');
const { qualifyAndSelectByRules } = require('./rules');

function loadProject(projectDir) {
  const file = path.join(projectDir, 'config.json');
  if (!fs.existsSync(file)) throw new Error(`No config.json in ${projectDir}`);
  const project = JSON.parse(fs.readFileSync(file, 'utf8'));
  project.slug = path.basename(projectDir);
  project.targetPerCompany = project.targetPerCompany || 4;
  project.maxCandidatesPerCompany = project.maxCandidatesPerCompany || Math.max(12, project.targetPerCompany * 3);
  return project;
}

function listProjects(projectsRoot) {
  if (!fs.existsSync(projectsRoot)) return [];
  return fs
    .readdirSync(projectsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && fs.existsSync(path.join(projectsRoot, d.name, 'config.json')))
    .map((d) => d.name)
    .sort();
}

function prescreen(org, rules = {}) {
  if (!org) return rules.requireOrganizationFound === false ? { pass: true, note: 'not in Apollo' } : { pass: false, note: 'Not in Apollo' };
  if (rules.minEmployees && org.employees != null && org.employees < rules.minEmployees) {
    return { pass: false, note: `Employees ${org.employees} < ${rules.minEmployees}` };
  }
  if (rules.countries && rules.countries.length && org.country && !rules.countries.map((c) => c.toLowerCase()).includes(org.country.toLowerCase())) {
    return { pass: false, note: `HQ ${org.country} not in ${rules.countries.join('/')}` };
  }
  if (rules.industriesAnyOf && rules.industriesAnyOf.length) {
    const ind = (org.industry || '').toLowerCase();
    const ok = rules.industriesAnyOf.some((k) => ind.includes(k.toLowerCase()));
    if (!ok) {
      if (rules.enforceIndustry) return { pass: false, note: `Industry "${org.industry || 'unknown'}" not in ICP` };
      return { pass: true, note: `Industry "${org.industry || 'unknown'}" not in ICP list (warning only)` };
    }
  }
  return { pass: true, note: 'Pass' };
}

async function processCompany({ company, project, store, apiKey, openAiKey }) {
  const name = company['Company Name'];
  logger.info(`[${name}] looking up organization in Apollo...`);
  const { organization: org, matchedBy, reason } = await apollo.findOrganization(apiKey, company);

  const meta = org
    ? { ApolloOrg: org.name, ApolloLinkedIn: org.linkedinUrl, Industry: org.industry, Employees: org.employees, HQ: [org.city, org.state, org.country].filter(Boolean).join(', ') }
    : {};
  const screen = prescreen(org, project.prescreen);
  await store.setCompanyMeta(company._rowNumber, { ...meta, PreScreen: screen.note });

  if (!org) {
    logger.warn(`[${name}] ${reason}`);
    await store.updateCompanyStatus(company._rowNumber, 'Not in Apollo', `${reason} - find the decision maker manually (Google / LinkedIn)`);
    return { company: name, status: 'not_found', prospects: 0 };
  }
  logger.info(`[${name}] -> ${org.name} (${matchedBy}) | ${org.industry || '?'} | ${org.employees ?? '?'} employees | ${meta.HQ || '?'}`);

  if (!screen.pass) {
    logger.info(`[${name}] pre-screen failed: ${screen.note}`);
    await store.updateCompanyStatus(company._rowNumber, 'Pre-screen failed', screen.note);
    return { company: name, status: 'prescreen_failed', prospects: 0 };
  }

  const candidates = await apollo.collectCandidates(apiKey, org, project);
  logger.info(`[${name}] ${candidates.length} candidates across seniority tiers`);
  if (candidates.length === 0) {
    await store.updateCompanyStatus(company._rowNumber, 'No Matches', 'No people matched the ICP titles/geography in Apollo - try the manual route');
    return { company: name, status: 'no_matches', prospects: 0 };
  }

  let selected;
  if (project.qualification === 'openai') {
    if (!openAiKey) throw new Error('Project uses OpenAI qualification but OPENAI_API_KEY is not set');
    const { qualifyAndSelect } = require('./qualify');
    selected = await qualifyAndSelect(
      candidates.map((c) => ({ ...c, titleDescription: c.headline })),
      { topN: project.targetPerCompany }
    );
  } else {
    selected = qualifyAndSelectByRules(candidates, project);
  }

  const rows = selected.map((p) => ({
    company: name,
    name: p.name,
    title: p.title,
    seniority: p.seniority,
    departments: p.departments,
    profileUrl: p.profileUrl,
    location: p.location,
    score: p.score,
    priority: p.priority,
    reason: `${p.reason}${p.tierLabel ? ` [${p.tierLabel}]` : ''}`,
    status: p.status,
    source: 'apollo'
  }));
  const written = await store.appendProspects(rows);
  logger.info(`[${name}] kept ${selected.length}: ` + selected.map((s) => `${s.name} - ${s.title} (${s.score}, ${s.priority})`).join('; '));
  await store.setCompanyMeta(company._rowNumber, { Prospects: selected.length });
  await store.updateCompanyStatus(company._rowNumber, 'Done', written < selected.length ? `${selected.length - written} already present` : '');
  return { company: name, status: 'done', prospects: selected.length };
}

function writeOutputs(projectDir, store) {
  fs.writeFileSync(path.join(projectDir, 'prospects.xlsx'), files.exportProspects(store.getProspects(), 'xlsx'));
  fs.writeFileSync(path.join(projectDir, 'companies-status.csv'), files.exportCompanies(store.getCompanies(), 'csv'));
}

// Imports the project's companies file if present (or the given upload),
// processes pending companies, writes prospects.xlsx + companies-status.csv,
// and returns a summary. `stores` lets callers keep one store per project
// across runs (the web app); the CLI passes nothing and gets a fresh one.
async function runProject({ projectDir, apiKey, openAiKey, limit = 0, replace = false, upload = null, store = null, shouldStop = () => false }) {
  if (!apiKey) throw new Error('APOLLO_API_KEY is not set');
  const project = loadProject(projectDir);
  store = store || createFileStore(projectDir);
  const startedAt = new Date();
  logger.info(`Project "${project.name}" (${project.slug}) - ${project.targetPerCompany} per company, ${project.qualification || 'rules'} qualification`);

  if (upload) {
    const info = store.importCompanies(upload.buffer, upload.filename, { replace });
    logger.info(`Imported ${upload.filename}: ${info.added} new, ${info.updated} existing, ${info.pending} pending`);
  } else {
    const input = ['companies.xlsx', 'companies.csv'].map((f) => path.join(projectDir, f)).find((f) => fs.existsSync(f));
    if (input) {
      const info = store.importCompanies(fs.readFileSync(input), path.basename(input), { replace });
      logger.info(`Imported ${path.basename(input)}: ${info.added} new, ${info.updated} existing, ${info.pending} pending`);
    } else if (store.snapshot().companies === 0) {
      throw new Error(`No companies: upload a file or put companies.xlsx/companies.csv in ${projectDir}`);
    }
  }

  let pending = await store.getPendingCompanies();
  if (limit) pending = pending.slice(0, limit);
  logger.info(`Processing ${pending.length} companies`);

  const results = [];
  let fatalError = null;
  for (const company of pending) {
    if (shouldStop()) {
      logger.warn('Stop requested - finishing early');
      break;
    }
    try {
      results.push(await processCompany({ company, project, store, apiKey, openAiKey }));
    } catch (err) {
      logger.error(`[${company['Company Name']}] failed: ${err.message}`);
      await store.updateCompanyStatus(company._rowNumber, 'Error', err.message).catch(() => {});
      results.push({ company: company['Company Name'], status: 'error', prospects: 0, error: err.message });
      if (/rejected the API key|plan/i.test(err.message)) {
        fatalError = err.message;
        break;
      }
    }
  }

  const summary = {
    project: project.slug,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    companiesProcessed: results.length,
    totalProspects: results.reduce((s, r) => s + (r.prospects || 0), 0),
    fatalError,
    results
  };
  await store.appendRunLog(summary);
  writeOutputs(projectDir, store);
  const snap = store.snapshot();
  logger.info(`Done: ${summary.companiesProcessed} companies this run, ${summary.totalProspects} prospects kept; ${snap.prospects} total; ${snap.pending} still pending`);
  return summary;
}

module.exports = { runProject, loadProject, listProjects, prescreen, writeOutputs };
