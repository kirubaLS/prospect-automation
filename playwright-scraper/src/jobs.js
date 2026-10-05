// Ad-hoc prospecting job: a companies file + the parameters typed on the
// page (person geography, ICP keywords, people per company) -> one CSV of
// prospects, with a "Company not found" / "No people found" row for every
// company that produced nothing. No emails or phone numbers are ever kept.
const XLSX = require('xlsx');
const logger = require('./logger');
const apollo = require('./apollo');
const websearch = require('./websearch');
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
  // "CIO, CTO > Head of IT, IT Head > IT Manager": '>' separates priority
  // groups, searched in order until enough people are found.
  const groups = people.split(/\s*>\s*/).map((g) => g.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean)).filter((g) => g.length);
  const keywords = groups.flat();
  return { industries, keywords, priorities: groups.length > 1 ? groups : null };
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

// Titles that are never prospects regardless of ICP. A listed title may
// still contain one of these words ("Executive Director", "Chief of Staff"):
// see excludedTitle.
const ALWAYS_EXCLUDE = /\b(intern|trainee|student|assistant|associate|executive|analyst|coordinator|receptionist|clerk|cashier|driver|dispatcher|technician|mechanic|developer|programmer|engineer(?!ing (manager|head|director))|recruiter|nurse|teacher|lecturer|professor|therapist|pharmacist|physician|surgeon|dentist|doctor|dr\.?|clinician|\w+ologist|\w+iatrist|medical officer|chief of staff|(?:md|cmd|ceo|cxo|coo|cfo|cto|chairman|chairperson|director|president|founder|promoter)['\u2019]?s? office|office of the|secretary to|\bea\b|\bpa\b)\b/i;

// Words in front of a matched title that change its meaning: "Vice President"
// is not a "President", "Associate Director" is not a "Director". A pattern
// that itself starts with such a word ("Vice President Operations") is fine.
const MODIFIERS = '(?:vice|assistant|asst|associate|deputy|junior|jr|sub|under)';

function titleMatches(title, patterns) {
  const t = String(title || '').replace(/&/g, 'and').replace(/[\u2013\u2014]/g, '-');
  return patterns.some((k) => {
    const k2 = k.replace(/&/g, 'and');
    const body = k2.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*[-/]?\\s*');
    return new RegExp(`(^|[^a-z0-9])(?<!\\b${MODIFIERS}[\\s.-]*)${body}($|[^a-z0-9])`, 'i').test(t);
  });
}

// True when the title carries an excluded word that none of the group's own
// patterns contains - so "Executive Director" survives a group listing it,
// but "Assistant Manager - MD's Office" never does.
function excludedTitle(title, patterns = []) {
  const m = ALWAYS_EXCLUDE.exec(String(title || ''));
  if (!m) return false;
  const word = m[0].toLowerCase().replace(/[^a-z ]/g, '');
  return !patterns.some((p) => String(p).toLowerCase().replace(/[^a-z ]/g, '').includes(word));
}

function sanitize(p, org, tier, icpHit) {
  // Explicitly whitelist fields: never emails, phones, or anything else.
  return {
    apolloId: p.apolloId,
    apolloOrgName: p.company && p.company !== org.name ? p.company : '',
    firstName: p.firstName || '',
    lastMasked: p.lastMasked || '',
    nameMasked: !!p.nameMasked,
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
// Two search strategies:
//   priorities (ICP given as "P1 titles > P2 titles > P3 titles"): each
//     group is searched in turn, exact titles only, until `want` people are
//     found; people Apollo returns as "similar" to a group's titles are
//     held back and used only if every group leaves the company short.
//   seniority (plain ICP keywords): decision makers with the keywords in
//     their title, then managers, then any decision maker.
// `opts.exclude` (iterable of person keys, see personKey) skips people already
// listed or removed, so a replacement search returns someone new.
function personKey(p) { return p.apolloId || p.profileUrl || `${p.name}|${p.title}`; }
async function findPeople(apiKey, org, params, opts = {}) {
  const want = params.peoplePerCompany;
  const seen = new Set(opts.exclude || []);
  const perPage = Math.min(50, Math.max((want + seen.size) * 2, 10));
  // api_search may omit the LinkedIn URL (preview plans), so dedupe on
  // the Apollo id and let enrichment fill the URL in afterwards.
  const keyOf = personKey;
  let out = [];

  if (params.priorities && params.priorities.length) {
    const similar = [];
    for (let i = 0; i < params.priorities.length && out.length < want; i++) {
      const group = params.priorities[i];
      const tier = { label: `Priority ${i + 1}`, priority: i + 1 };
      const { people, total } = await apollo.searchPeople(apiKey, org, { titles: group, locations: params.locations, perPage, includeSimilar: false }, opts);
      logger.info(`    ${tier.label}: ${people.length} returned (${total} in Apollo)`);
      const fresh = people.filter((p) => p.name && !seen.has(keyOf(p)));
      // An explicitly listed title is never excluded, whatever it is.
      const exact = fresh.filter((p) => titleMatches(p.title, group) && !excludedTitle(p.title, group)).sort((a, b) => (SENIORITY_RANK[a.seniority] ?? 9) - (SENIORITY_RANK[b.seniority] ?? 9));
      const rest = fresh.filter((p) => !titleMatches(p.title, group) && !excludedTitle(p.title));
      for (const p of exact) {
        if (out.length >= want) break;
        seen.add(keyOf(p));
        out.push({ ...sanitize(p, org, tier, true), match: tier.label });
      }
      for (const p of rest) if (!seen.has(keyOf(p))) { seen.add(keyOf(p)); similar.push({ p, tier }); }
    }
    for (const { p, tier } of similar) {
      if (out.length >= want) break;
      out.push({ ...sanitize(p, org, tier, false), match: `${tier.label} (similar title)` });
    }
  } else {
    const titles = expandKeywords(params.icpKeywords);
    const tiers = [
      { label: 'Decision makers · ICP titles', seniorities: DECISION_MAKERS, titles },
      { label: 'Managers · ICP titles', seniorities: MANAGERS, titles },
      { label: 'Decision makers · any title', seniorities: DECISION_MAKERS, titles: [], fallback: true }
    ];
    for (const tier of tiers) {
      if (out.length >= want) break;
      if (!titles.length && tier.titles.length) continue;
      const { people, total } = await apollo.searchPeople(apiKey, org, { seniorities: tier.seniorities, titles: tier.titles, locations: params.locations, perPage }, opts);
      logger.info(`    ${tier.label}: ${people.length} returned (${total} in Apollo)`);
      const ranked = people
        .filter((p) => p.name && !seen.has(keyOf(p)) && !excludedTitle(p.title, titles))
        .map((p) => ({ p, icp: titles.length ? titleMatches(p.title, titles) : false }))
        .sort((a, b) => Number(b.icp) - Number(a.icp) || (SENIORITY_RANK[a.p.seniority] ?? 9) - (SENIORITY_RANK[b.p.seniority] ?? 9));
      for (const { p, icp } of ranked) {
        if (out.length >= want) break;
        seen.add(keyOf(p));
        out.push(sanitize(p, org, tier, icp));
      }
    }
  }
  // Only the people being kept are resolved, and only those whose preview
  // lacked a LinkedIn URL or full name:
  //   search  - web search API (Brave / Google), free, verified against the
  //             obfuscated surname
  //   apollo  - Apollo Bulk People Enrichment, 1 credit per person
  //   none    - leave the preview as is
  //   apollo+search - Apollo first (exact), web search only for anyone
  //             Apollo left without a URL
  let need = out.filter((p) => !p.profileUrl || p.nameMasked);
  if (!need.length || params.resolve === 'none') return out;
  if (params.resolve === 'apollo' || params.resolve === 'apollo+search') {
    const { people: full, requested, enriched } = await apollo.enrichPeople(apiKey, out, opts);
    logger.info(`    enrichment: ${enriched}/${requested} filled in`);
    out = full.map((p) => ({ ...p, seniority: SENIORITY_LABEL[p.seniority] || p.seniority || '', function: p.function || (p.departments || []).join(', '), resolvedBy: p.profileUrl && !p.nameMasked ? 'apollo' : p.resolvedBy }));
    need = out.filter((p) => !p.profileUrl || p.nameMasked);
    if (params.resolve === 'apollo' || !need.length) {
      for (const p of need) p.note = 'Apollo enrichment returned no LinkedIn URL for this person';
      return out;
    }
    logger.info(`    ${need.length} still without a URL after Apollo - trying web search`);
  }
  const providers = params.searchProviders || [];
  if (!providers.length) throw new Error('no web search provider configured - set SERPER_API_KEY, TAVILY_API_KEY, BRAVE_SEARCH_API_KEY or GOOGLE_CSE_API_KEY + GOOGLE_CSE_CX on the server, or choose Apollo enrichment');
  let found = 0;
  for (const p of out) {
    if (p.profileUrl && !p.nameMasked) continue;
    try {
      const hit = await websearch.findProfile(
        { apolloId: p.apolloId, firstName: p.firstName, lastMasked: p.lastMasked, title: p.title, company: p.apolloOrgName || p.company || org.name },
        providers,
        { ...opts, gl: websearch.countryCode(params.locations), counter: opts.ledger }
      );
      if (hit) {
        found++;
        p.name = hit.fullName || p.name;
        p.nameMasked = false;
        p.profileUrl = hit.profileUrl;
        if (hit.location) p.location = hit.location;
        p.resolvedBy = hit.provider;
      } else {
        p.note = 'LinkedIn URL not found by web search';
      }
    } catch (err) {
      if (err.quota) {
        logger.warn(`    ${err.message}`);
        p.note = 'web search quota exhausted - rerun later or use Apollo enrichment';
        params.searchExhausted = true;
        // keep going so the remaining people are still listed (masked)
        for (const q of out) if (q !== p && (!q.profileUrl || q.nameMasked) && !q.note) q.note = p.note;
        break;
      }
      // One person's search failing (network blip, odd response) must not
      // fail the company: note it and carry on with the next person.
      logger.warn(`    web search failed for ${p.name}: ${err.message}`);
      p.note = `web search failed: ${err.message}`;
    }
  }
  logger.info(`    web search: ${found}/${need.length} profiles resolved`);
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
    companyWebsite: company.Website || '',
    companyStatus: status,
    note: note || '',
    apolloOrg: org ? org.name : '',
    apolloOrgId: org ? org.id || '' : '',
    apolloDomain: org ? org.domain || '' : '',
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
  // Every Apollo call is counted here so the job can show where credits went.
  const ledger = apollo.newLedger();
  const opts = { ledger, ...(fetchImpl ? { fetchImpl } : {}) };
  // `rows` may be the caller's own array so partial results are downloadable mid-run.
  const state = { total: companies.length, done: 0, found: 0, notFound: 0, noPeople: 0, prospects: 0, errors: 0, current: '', apollo: ledger };
  params = { resolve: 'search', ...params };
  if (params.enrich === false && !('resolve' in (arguments[0].params || {}))) params.resolve = 'none';
  if (params.enrich === true && !('resolve' in (arguments[0].params || {}))) params.resolve = 'apollo';

  for (const company of companies) {
    if (shouldStop()) {
      logger.warn('Stop requested');
      break;
    }
    const name = company['Company Name'] || company['LinkedIn URL'] || company.Domain;
    state.current = name;
    onProgress(state);
    try {
      // A website domain lets People Search filter by employer directly, so
      // the company lookup (1 credit) is skipped entirely. The LinkedIn
      // URL / name route is used only when the row has no domain.
      let org, matchedBy, reason;
      if (company.Domain) {
        org = { id: null, domain: company.Domain, name: company['Company Name'] || company.Domain, industry: '', employees: null };
        matchedBy = 'domain';
      } else {
        ({ organization: org, matchedBy, reason } = await apollo.findOrganization(apiKey, company, opts));
      }
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
        // By domain the company's own name comes back on each person.
        if (!org.id && people.length && people[0].apolloOrgName && !company['Company Name']) org.name = people[0].apolloOrgName;
        if (!people.length) {
          rows.push({ ...companyRow(company, org.id ? 'No people found' : 'Company not found', [industryNote, org.id ? 'no one matched geography/ICP in Apollo' : `Apollo has no people for ${org.domain} matching the geography/ICP (or no such company)`].filter(Boolean).join('; '), org), name: org.id ? 'No people found' : 'Company not found' });
          if (org.id) state.noPeople++; else state.notFound++;
        } else {
          people.forEach((p, i) => rows.push({ ...companyRow(company, 'Found', industryNote, org), ...p, note: [p.note, industryNote].filter(Boolean).join('; '), rank: i + 1 }));
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
  logger.info(`Apollo calls: ${ledger.peopleSearch} people searches (0 credits), ${ledger.orgEnrich} company enrichments, ${ledger.orgSearch} company searches, ${ledger.peopleEnrich} enrichment batches (${ledger.peopleEnriched} people) - about ${ledger.estimatedCredits} credits; ${ledger.webSearches || 0} web search queries`);
  return { rows, state, params };
}

// Exactly what the researchers asked for: who, their designation, where
// they are, the profile link; Activity is left blank for them to fill from
// the profile (no data API has it). Company Status / Note explain rows
// with nothing found. Nothing else, and never emails or phone numbers.
const OUTPUT_COLUMNS = [
  ['Company', 'company'], ['Company Status', 'companyStatus'], ['Name', 'name'], ['Designation', 'title'], ['Location', 'location'],
  ['LinkedIn URL', 'profileUrl'], ['Activity', 'activity'], ['Activity Proof', 'activityProof'], ['Activity Note', 'activityReason'], ['Last Activity', 'activityDate'], ['Connections', 'connections'], ['Followers', 'followers'],
  ['Note', 'note'], ['Company Website', 'companyWebsite'], ['Company LinkedIn URL', 'companyUrl']
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

module.exports = { runJob, personKey, companyRow, titleMatches, excludedTitle, toCsv, toXlsx, exportRows, industryMatches, parseGeography, parseIcp, expandKeywords, findPeople, GEO_ALIASES, OUTPUT_COLUMNS };
