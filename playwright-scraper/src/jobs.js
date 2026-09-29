// Ad-hoc prospecting job: a companies file + the parameters typed on the
// page (person geography, ICP keywords, people per company) -> one CSV of
// prospects, with a "Company not found" / "No people found" row for every
// company that produced nothing. No emails or phone numbers are ever kept.
const XLSX = require('xlsx');
const logger = require('./logger');
const apollo = require('./apollo');
const { parseCompaniesFile } = require('./files');

// Friendly geography names -> Apollo person_locations values.
const GEO_ALIASES = {
  'south india': ['Tamil Nadu, India', 'Karnataka, India', 'Kerala, India', 'Andhra Pradesh, India', 'Telangana, India', 'Puducherry, India'],
  'north india': ['Delhi, India', 'Haryana, India', 'Punjab, India', 'Uttar Pradesh, India', 'Rajasthan, India', 'Uttarakhand, India', 'Himachal Pradesh, India', 'Chandigarh, India'],
  'west india': ['Maharashtra, India', 'Gujarat, India', 'Goa, India'],
  'east india': ['West Bengal, India', 'Odisha, India', 'Bihar, India', 'Jharkhand, India', 'Assam, India'],
  india: ['India'],
  us: ['United States'],
  usa: ['United States'],
  'united states': ['United States'],
  uk: ['United Kingdom'],
  uae: ['United Arab Emirates'],
  gcc: ['United Arab Emirates', 'Saudi Arabia', 'Qatar', 'Kuwait', 'Bahrain', 'Oman'],
  apac: ['India', 'Singapore', 'Malaysia', 'Indonesia', 'Philippines', 'Thailand', 'Vietnam', 'Sri Lanka', 'Bangladesh', 'Australia', 'New Zealand', 'Japan', 'South Korea', 'Hong Kong', 'Taiwan'],
  europe: ['United Kingdom', 'Germany', 'France', 'Netherlands', 'Spain', 'Italy', 'Sweden', 'Switzerland', 'Belgium', 'Ireland', 'Poland', 'Denmark', 'Norway', 'Finland', 'Austria'],
  'north america': ['United States', 'Canada'],
  worldwide: [],
  any: [],
  '': []
};

// "South India" / "US; Canada" / one per line -> Apollo location strings.
function parseGeography(text) {
  const parts = String(text || '')
    .split(/[\n;|]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const p of parts) {
    const alias = GEO_ALIASES[p.toLowerCase()];
    if (alias) out.push(...alias);
    else out.push(p);
  }
  return [...new Set(out)];
}

// "Education, Healthcare, Retail; IT, Administration, Procurement" ->
// the part after ';' is people ICP; before it (if a ';' exists) is industries.
function parseIcp(text) {
  const raw = String(text || '');
  let industries = [];
  let people = raw;
  if (raw.includes(';')) {
    const [a, b] = raw.split(';');
    industries = a.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);
    people = b;
  }
  const keywords = people.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);
  return { industries, keywords };
}

// Title keyword expansions so "IT" also finds "Information Technology" etc.
const KEYWORD_EXPANSIONS = {
  it: ['IT', 'Information Technology', 'Technology', 'CIO', 'CTO', 'Systems', 'Infrastructure', 'Digital'],
  finance: ['Finance', 'Financial', 'CFO', 'Accounts', 'Controller', 'Treasury'],
  hr: ['HR', 'Human Resources', 'People', 'Talent', 'CHRO'],
  'human resources': ['Human Resources', 'HR', 'People', 'CHRO'],
  admin: ['Administration', 'Admin', 'Administrative'],
  administration: ['Administration', 'Admin', 'Administrative'],
  procurement: ['Procurement', 'Purchase', 'Purchasing', 'Sourcing', 'Supply Chain'],
  purchasing: ['Purchasing', 'Purchase', 'Procurement', 'Buyer'],
  purchase: ['Purchase', 'Purchasing', 'Procurement'],
  operations: ['Operations', 'COO', 'Operating'],
  ops: ['Operations', 'COO'],
  fleet: ['Fleet'],
  maintenance: ['Maintenance'],
  safety: ['Safety', 'HSE', 'EHS'],
  logistics: ['Logistics', 'Supply Chain', 'Transportation'],
  ceo: ['CEO', 'Chief Executive'],
  md: ['Managing Director', 'MD'],
  founder: ['Founder', 'Co-Founder'],
  cofounder: ['Co-Founder', 'Cofounder', 'Founder'],
  'co-founder': ['Co-Founder', 'Cofounder', 'Founder'],
  owner: ['Owner', 'Proprietor'],
  president: ['President'],
  'chief of staff': ['Chief of Staff'],
  facility: ['Facility', 'Facilities'],
  facilities: ['Facilities', 'Facility'],
  marketing: ['Marketing', 'CMO'],
  sales: ['Sales', 'CRO', 'Revenue']
};

function expandKeywords(keywords) {
  const out = [];
  for (const k of keywords) {
    const exp = KEYWORD_EXPANSIONS[k.toLowerCase()];
    out.push(...(exp || [k]));
  }
  return [...new Set(out)];
}

const SENIORITY_RANK = { owner: 0, founder: 0, c_suite: 1, partner: 1, vp: 2, head: 3, director: 3, manager: 4, senior: 5, entry: 6, intern: 7 };
const SENIORITY_LABEL = { owner: 'Owner', founder: 'Founder', c_suite: 'C-Suite', partner: 'Partner', vp: 'VP', head: 'Head', director: 'Director', manager: 'Manager', senior: 'Senior', entry: 'Entry', intern: 'Intern' };
const DECISION_MAKERS = ['owner', 'founder', 'c_suite', 'partner', 'vp', 'head', 'director'];
const MANAGERS = ['manager', 'senior'];

// Titles that are never prospects regardless of ICP.
const ALWAYS_EXCLUDE = /\b(intern|trainee|student|assistant|associate|executive|analyst|coordinator|receptionist|clerk|cashier|driver|dispatcher|technician|mechanic|developer|programmer|engineer(?!ing (manager|head|director))|recruiter|nurse|teacher|lecturer|professor|therapist|pharmacist|physician|surgeon|dentist|doctor|dr\.?|clinician|\w+ologist|\w+iatrist|medical officer)\b/i;

function titleMatches(title, patterns) {
  const t = String(title || '');
  return patterns.some((k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t));
}

function sanitize(p, org, tier, icpHit) {
  // Explicitly whitelist fields: never emails, phones, or anything else.
  return {
    name: p.name,
    title: p.title,
    seniority: SENIORITY_LABEL[p.seniority] || p.seniority || '',
    seniorityKey: p.seniority || '',
    function: (p.departments || []).join(', '),
    profileUrl: p.profileUrl,
    location: p.location,
    company: org.name,
    match: icpHit ? 'ICP match' : tier.fallback ? 'Fallback (no ICP title)' : 'Decision maker',
    tier: tier.label
  };
}

// Tiered search mirroring the manual SOP:
//   1. decision makers whose title matches the ICP keywords
//   2. managers whose title matches the ICP keywords
//   3. any decision maker (the "All Employees / Decision makers" fallback)
async function findPeople(apiKey, org, params, opts = {}) {
  const want = params.peoplePerCompany;
  const titles = expandKeywords(params.icpKeywords);
  const tiers = [
    { label: 'Decision makers · ICP titles', seniorities: DECISION_MAKERS, titles },
    { label: 'Managers · ICP titles', seniorities: MANAGERS, titles },
    { label: 'Decision makers · any title', seniorities: DECISION_MAKERS, titles: [], fallback: true }
  ];
  const seen = new Set();
  const out = [];
  for (const tier of tiers) {
    if (out.length >= want) break;
    if (!titles.length && tier.titles.length) continue;
    const { people, total } = await apollo.searchPeople(
      apiKey,
      org,
      { seniorities: tier.seniorities, titles: tier.titles, locations: params.locations, perPage: Math.min(50, Math.max(want * 2, 10)) },
      opts
    );
    logger.info(`    ${tier.label}: ${people.length} returned (${total} in Apollo)`);
    const ranked = people
      .filter((p) => p.name && p.profileUrl && !seen.has(p.profileUrl) && !ALWAYS_EXCLUDE.test(p.title || ''))
      .map((p) => ({ p, icp: titles.length ? titleMatches(p.title, titles) : false }))
      .sort((a, b) => Number(b.icp) - Number(a.icp) || (SENIORITY_RANK[a.p.seniority] ?? 9) - (SENIORITY_RANK[b.p.seniority] ?? 9));
    for (const { p, icp } of ranked) {
      if (out.length >= want) break;
      seen.add(p.profileUrl);
      out.push(sanitize(p, org, tier, icp));
    }
  }
  return out;
}

// "Healthcare" should match Apollo's "hospital & health care", "Retail" its
// "retail" / "consumer goods & retail": compare letters only, both ways.
function industryMatches(apolloIndustry, wanted) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  const have = norm(apolloIndustry);
  return wanted.some((w) => {
    const n = norm(w);
    return n && (have.includes(n) || (n.length > 4 && n.includes(have)));
  });
}

function companyRow(company, status, note, org) {
  return {
    company: (org && org.name) || company['Company Name'] || '',
    companyUrl: company['LinkedIn URL'] || '',
    companyStatus: status,
    note: note || '',
    apolloOrg: org ? org.name : '',
    industry: org ? org.industry : '',
    employees: org ? org.employees : '',
    hq: org ? [org.city, org.state, org.country].filter(Boolean).join(', ') : ''
  };
}

// Runs the whole job. `onProgress(state)` is called after each company so
// a UI can show live counts; `shouldStop()` lets a run end early.
async function runJob({ apiKey, fileBuffer, filename, params, onProgress = () => {}, shouldStop = () => false, fetchImpl, rows = [] }) {
  if (!apiKey) throw new Error('APOLLO_API_KEY is not set on the server');
  const companies = parseCompaniesFile(fileBuffer, filename);
  const opts = fetchImpl ? { fetchImpl } : {};
  // `rows` may be the caller's own array so partial results are downloadable mid-run.
  const state = { total: companies.length, done: 0, found: 0, notFound: 0, noPeople: 0, prospects: 0, errors: 0, current: '' };

  for (const company of companies) {
    if (shouldStop()) {
      logger.warn('Stop requested');
      break;
    }
    const name = company['Company Name'] || company['LinkedIn URL'];
    state.current = name;
    onProgress(state);
    try {
      const { organization: org, matchedBy, reason } = await apollo.findOrganization(apiKey, company, opts);
      if (!org) {
        logger.warn(`[${name}] not found: ${reason}`);
        rows.push({ ...companyRow(company, 'Company not found', reason), name: 'Company not found' });
        state.notFound++;
      } else {
        logger.info(`[${name}] -> ${org.name} (${matchedBy}) | ${org.industry || '?'} | ${org.employees ?? '?'} employees`);
        const industryNote =
          params.industries.length && org.industry && !industryMatches(org.industry, params.industries)
            ? `Industry "${org.industry}" not in ICP list`
            : '';
        const people = await findPeople(apiKey, org, params, opts);
        if (!people.length) {
          rows.push({ ...companyRow(company, 'No people found', [industryNote, 'no one matched geography/ICP in Apollo'].filter(Boolean).join('; '), org), name: 'No people found' });
          state.noPeople++;
        } else {
          people.forEach((p, i) => rows.push({ ...companyRow(company, 'Found', industryNote, org), ...p, rank: i + 1 }));
          state.found++;
          state.prospects += people.length;
          logger.info(`[${name}] ${people.length} people: ${people.map((p) => `${p.name} (${p.title})`).join('; ')}`);
        }
      }
    } catch (err) {
      logger.error(`[${name}] error: ${err.message}`);
      rows.push({ ...companyRow(company, 'Error', err.message), name: 'Error' });
      state.errors++;
      if (/rejected the API key|plan/i.test(err.message)) {
        state.fatal = err.message;
        break;
      }
    }
    state.done++;
    onProgress(state);
  }
  state.current = '';
  return { rows, state, params };
}

const OUTPUT_COLUMNS = [
  ['Company', 'company'], ['Company LinkedIn URL', 'companyUrl'], ['Company Status', 'companyStatus'], ['Name', 'name'], ['Designation', 'title'],
  ['Seniority', 'seniority'], ['Function', 'function'], ['LinkedIn URL', 'profileUrl'], ['Location', 'location'], ['Match', 'match'], ['Rank', 'rank'],
  ['Connections 500+', '_manual'], ['Activity', '_manual'], ['Note', 'note'], ['Apollo Org', 'apolloOrg'], ['Industry', 'industry'], ['Employees', 'employees'], ['HQ', 'hq']
];

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  const lines = [OUTPUT_COLUMNS.map(([h]) => csvEscape(h)).join(',')];
  for (const r of rows) lines.push(OUTPUT_COLUMNS.map(([, k]) => csvEscape(k === '_manual' ? '' : r[k])).join(','));
  return lines.join('\r\n') + '\r\n';
}

// Same columns as the CSV, as an .xlsx workbook (sheet "Prospects") so the
// output can be handed over as Excel without a conversion step.
function toXlsx(rows) {
  const headers = OUTPUT_COLUMNS.map(([h]) => h);
  const data = rows.map((r) => Object.fromEntries(OUTPUT_COLUMNS.map(([h, k]) => [h, k === '_manual' ? '' : r[k] == null ? '' : r[k]])));
  const sheet = XLSX.utils.json_to_sheet(data, { header: headers });
  sheet['!cols'] = headers.map((h) => ({ wch: /url/i.test(h) ? 48 : /company|name|designation|note|location/i.test(h) ? 30 : 14 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'Prospects');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// format: 'csv' | 'xlsx' -> { buffer, contentType, extension }
function exportRows(rows, format) {
  if (format === 'xlsx') {
    return { buffer: toXlsx(rows), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extension: 'xlsx' };
  }
  return { buffer: Buffer.from(toCsv(rows), 'utf8'), contentType: 'text/csv; charset=utf-8', extension: 'csv' };
}

module.exports = { runJob, toCsv, toXlsx, exportRows, industryMatches, parseGeography, parseIcp, expandKeywords, findPeople, GEO_ALIASES, OUTPUT_COLUMNS };
