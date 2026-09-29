// Apollo-based prospecting for one project folder:
//   projects/<name>/config.json   ICP, geography, tiers, per-company target
//   projects/<name>/companies.xlsx|csv   input (yours)
//   projects/<name>/prospects.xlsx, companies-status.csv, state.json   outputs
//
//   node src/project.js --project sharp [--limit N] [--replace]
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = { limit: 0, replace: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') args.project = argv[++i];
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10) || 0;
    else if (a === '--replace') args.replace = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.project) throw new Error('--project <name> is required (a folder under projects/)');
  return args;
}

const args = parseArgs(process.argv.slice(2));
const projectsRoot = process.env.PROJECTS_DIR || path.resolve(__dirname, '..', '..', 'projects');
const projectDir = path.join(projectsRoot, args.project);
if (!fs.existsSync(path.join(projectDir, 'config.json'))) {
  throw new Error(`No config.json in ${projectDir}`);
}
// The file store keeps state per project folder; must be set before config loads.
process.env.DATA_DIR = projectDir;
process.env.STORAGE_BACKEND = 'file';

const config = require('./config');
const logger = require('./logger');
const store = require('./filestore');
const files = require('./files');
const apollo = require('./apollo');
const { qualifyAndSelectByRules } = require('./rules');

const project = JSON.parse(fs.readFileSync(path.join(projectDir, 'config.json'), 'utf8'));

function prescreen(org, rules = {}) {
  if (!org) return rules.requireOrganizationFound === false ? { pass: true, note: 'not in Apollo' } : { pass: false, note: 'Not in Apollo' };
  if (rules.minEmployees && org.employees != null && org.employees < rules.minEmployees) return { pass: false, note: `Employees ${org.employees} < ${rules.minEmployees}` };
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

async function processCompany(company) {
  const name = company['Company Name'];
  logger.info(`[${name}] looking up organization in Apollo...`);
  const { organization: org, matchedBy, reason } = await apollo.findOrganization(config.apolloApiKey, company);

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

  const candidates = await apollo.collectCandidates(config.apolloApiKey, org, project);
  logger.info(`[${name}] ${candidates.length} candidates across seniority tiers`);
  if (candidates.length === 0) {
    await store.updateCompanyStatus(company._rowNumber, 'No Matches', 'No people matched the ICP titles/geography in Apollo - try the manual route');
    return { company: name, status: 'no_matches', prospects: 0 };
  }

  let selected;
  if (project.qualification === 'openai') {
    if (!config.openAiApiKey) throw new Error('Project uses OpenAI qualification but OPENAI_API_KEY is not set');
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
  logger.info(
    `[${name}] kept ${selected.length}: ` + selected.map((s) => `${s.name} - ${s.title} (${s.score}, ${s.priority})`).join('; ')
  );
  await store.setCompanyMeta(company._rowNumber, { Prospects: selected.length });
  await store.updateCompanyStatus(company._rowNumber, 'Done', written < selected.length ? `${selected.length - written} already present` : '');
  return { company: name, status: 'done', prospects: selected.length };
}

(async () => {
  if (!config.apolloApiKey) throw new Error('APOLLO_API_KEY is not set');
  logger.info(`Project "${project.name}" (${args.project}) - ${project.targetPerCompany} per company, ${project.qualification} qualification`);

  const input = ['companies.xlsx', 'companies.csv'].map((f) => path.join(projectDir, f)).find((f) => fs.existsSync(f));
  if (input) {
    const info = store.importCompanies(fs.readFileSync(input), path.basename(input), { replace: args.replace });
    logger.info(`Imported ${path.basename(input)}: ${info.added} new, ${info.updated} existing, ${info.pending} pending`);
  } else if (store.snapshot().companies === 0) {
    throw new Error(`Put a companies.xlsx or companies.csv in ${projectDir}`);
  }

  let pending = await store.getPendingCompanies();
  if (args.limit) pending = pending.slice(0, args.limit);
  logger.info(`Processing ${pending.length} companies`);

  const results = [];
  for (const company of pending) {
    try {
      results.push(await processCompany(company));
    } catch (err) {
      logger.error(`[${company['Company Name']}] failed: ${err.message}`);
      await store.updateCompanyStatus(company._rowNumber, 'Error', err.message).catch(() => {});
      results.push({ company: company['Company Name'], status: 'error', prospects: 0, error: err.message });
      // An auth/plan rejection will repeat for every company - stop now.
      if (/rejected the API key|plan/i.test(err.message)) break;
    }
  }

  const summary = {
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    companiesProcessed: results.length,
    totalProspects: results.reduce((s, r) => s + (r.prospects || 0), 0),
    fatalError: null,
    results
  };
  await store.appendRunLog(summary);

  const prospectsFile = path.join(projectDir, 'prospects.xlsx');
  fs.writeFileSync(prospectsFile, files.exportProspects(store.getProspects(), 'xlsx'));
  fs.writeFileSync(path.join(projectDir, 'companies-status.csv'), files.exportCompanies(store.getCompanies(), 'csv'));
  const snap = store.snapshot();
  logger.info(
    `Done: ${summary.companiesProcessed} companies this run, ${summary.totalProspects} prospects kept; ` +
      `${store.getProspects().length} total in ${prospectsFile}; ${snap.pending} still pending`
  );
})().catch((err) => {
  logger.error('Fatal:', err.message);
  process.exit(1);
});
