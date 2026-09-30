const logger = require('./logger');

const BASE = 'https://api.apollo.io/api/v1';

let lastCallAt = 0;
const MIN_GAP_MS = 1200; // stay well under Apollo's per-minute limit

async function pace() {
  const wait = MIN_GAP_MS - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

// Apollo's newer endpoints (mixed_people/api_search) take their filters as
// URL query parameters on a POST; arrays use the key[]=value form.
function toQuery(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v == null || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => q.append(`${k}[]`, x));
    else q.append(k, String(v));
  }
  const str = q.toString();
  return str ? `?${str}` : '';
}

async function request(apiKey, method, path, body, { fetchImpl = fetch, query = null } = {}) {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await pace();
    const init = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'X-Api-Key': apiKey
      }
    };
    if (method !== 'GET') init.body = JSON.stringify(body || {});
    const res = await fetchImpl(`${BASE}${path}${toQuery(query)}`, init);
    if (res.ok) return res.json();

    const text = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Apollo rejected the API key or plan for ${path} (${res.status}): ${text.slice(0, 300)}`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
      const backoff = 5000 * attempt;
      logger.warn(`Apollo ${res.status} on ${path}, retrying in ${backoff / 1000}s (${attempt}/${maxAttempts})`);
      await new Promise((r) => setTimeout(r, backoff));
      continue;
    }
    throw new Error(`Apollo ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  throw new Error(`Apollo ${path} failed after ${maxAttempts} attempts`);
}

const post = (apiKey, path, body, opts) => request(apiKey, 'POST', path, body, opts);
const get = (apiKey, path, query, opts) => request(apiKey, 'GET', path, null, { ...opts, query });

function linkedInSlug(url) {
  const m = String(url || '').match(/linkedin\.com\/(?:company|school|showcase)\/([^/?#]+)/i);
  return m ? m[1].toLowerCase().replace(/\/+$/, '') : null;
}

function domainOf(url) {
  const m = String(url || '').match(/^(?:https?:\/\/)?(?:www\.)?([^/?#]+)/i);
  return m ? m[1].toLowerCase() : null;
}

function mapOrganization(o) {
  return {
    id: o.id,
    name: o.name,
    linkedinUrl: o.linkedin_url || '',
    website: o.website_url || o.primary_domain || '',
    industry: o.industry || '',
    employees: o.estimated_num_employees ?? null,
    city: o.city || '',
    state: o.state || '',
    country: o.country || ''
  };
}

function slugWords(slug) {
  let s = slug || '';
  try { s = decodeURIComponent(s); } catch { /* keep raw */ }
  return s.replace(/[-_+]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function cleanCompanyUrl(url) {
  const slug = linkedInSlug(url);
  return slug ? `https://www.linkedin.com/company/${slug}` : null;
}

// Company row (name + LinkedIn URL) -> Apollo organization.
//
// With a company-page URL: Organization Enrichment, which matches on the
// LinkedIn URL itself (1 credit per company) and returns industry, headcount
// and HQ, which Organization Search does not. Without a usable URL:
// Organization Search by name (1 credit per page), trusting only an exact
// case-insensitive name match. A single search, never two, to keep the
// credit cost predictable.
async function findOrganization(apiKey, company, opts = {}) {
  const name = (company['Company Name'] || '').trim();
  const url = company['LinkedIn URL'] || '';
  if (/linkedin\.com\/in\//i.test(url)) {
    return { organization: null, reason: 'the LinkedIn URL is a person profile (linkedin.com/in/...), not a company page (linkedin.com/company/...)' };
  }
  const wantSlug = linkedInSlug(url);
  const wantDomain = company.Website ? domainOf(company.Website) : null;
  if (!name && !wantSlug) return { organization: null, reason: 'no company name or LinkedIn URL' };

  if (wantSlug) {
    const query = { linkedin_url: cleanCompanyUrl(url) };
    if (name && name.toLowerCase() !== slugWords(wantSlug).toLowerCase()) query.name = name;
    const data = await get(apiKey, '/organizations/enrich', query, opts);
    const o = data && data.organization;
    if (o && o.id) {
      const org = mapOrganization(o);
      const gotSlug = linkedInSlug(org.linkedinUrl);
      // Apollo matched on the URL we sent; a different slug back means it
      // fell through to a looser match, which is still usually right, so
      // keep it but say so.
      return { organization: org, matchedBy: !gotSlug || gotSlug === wantSlug ? 'linkedin' : `linkedin (Apollo returned ${org.linkedinUrl})` };
    }
    if (!name) return { organization: null, reason: `Apollo has no organization for ${cleanCompanyUrl(url)}` };
  }

  const q = name || slugWords(wantSlug);
  const data = await post(apiKey, '/mixed_companies/search', {}, { ...opts, query: { q_organization_name: q, page: 1, per_page: 10 } });
  const orgs = (data.organizations || data.accounts || []).map(mapOrganization);
  if (orgs.length === 0) return { organization: null, reason: `no Apollo organization matched "${q}"${wantSlug ? ` or ${cleanCompanyUrl(url)}` : ''}` };

  const bySlug = wantSlug && orgs.find((o) => linkedInSlug(o.linkedinUrl) === wantSlug);
  if (bySlug) return { organization: bySlug, matchedBy: 'linkedin' };
  const byDomain = wantDomain && orgs.find((o) => domainOf(o.website) === wantDomain);
  if (byDomain) return { organization: byDomain, matchedBy: 'domain' };
  const byName = orgs.find((o) => o.name.trim().toLowerCase() === q.toLowerCase());
  if (byName) return { organization: byName, matchedBy: 'name' };

  return {
    organization: null,
    reason: `Apollo returned ${orgs.length} candidate(s) for "${q}" but none matched the LinkedIn URL/name (closest: ${orgs[0].name} ${orgs[0].linkedinUrl})`
  };
}

// Explicit whitelist: emails, phone numbers and anything else Apollo
// returns are dropped here and never reach the rest of the app.
function mapPerson(p, org) {
  // api_search returns last_name_obfuscated ("Sm***h") instead of last_name
  // - flagged so the enrichment step knows this person needs the full record.
  const masked = !p.last_name && !!p.last_name_obfuscated;
  const last = p.last_name || p.last_name_obfuscated || '';
  return {
    apolloId: p.id,
    name: [p.first_name, last].filter(Boolean).join(' ') || p.name || '',
    nameMasked: masked,
    title: p.title || '',
    headline: p.headline || '',
    seniority: p.seniority || '',
    departments: p.departments || [],
    profileUrl: p.linkedin_url || '',
    location: [p.city, p.state, p.country].filter(Boolean).join(', '),
    company: (p.organization && p.organization.name) || org.name || ''
  };
}

// One people search for one seniority tier via mixed_people/api_search
// (the endpoint Apollo now requires for API callers; filters go in the
// query string, no credits are consumed). Titles and locations are
// optional; person_titles is an OR list matched against the current title.
// On plans where this endpoint returns only a preview (masked last name,
// no LinkedIn URL), enrichPeople() fills in the rest for selected people.
// `org` is either a matched Apollo organization ({id, name}) or a domain
// stand-in ({domain, name}); by domain no company lookup call is needed.
async function searchPeople(apiKey, org, { seniorities, titles, locations, perPage = 25, page = 1 }, opts = {}) {
  const query = {
    person_seniorities: seniorities,
    page,
    per_page: perPage
  };
  if (org.id) query.organization_ids = [org.id];
  else if (org.domain) query.q_organization_domains_list = [org.domain];
  else throw new Error('searchPeople needs an organization id or a domain');
  if (titles && titles.length) query.person_titles = titles;
  if (locations && locations.length) query.person_locations = locations;

  const data = await post(apiKey, '/mixed_people/api_search', {}, { ...opts, query });
  const people = (data.people || data.contacts || []).map((p) => mapPerson(p, org));
  const total = data.total_entries ?? (data.pagination ? data.pagination.total_entries : people.length);
  return { people, total };
}

// Fills in full name, LinkedIn URL and location for people whose search
// preview lacked them, via Bulk People Enrichment (up to 10 ids per call).
// This consumes Apollo credits, so callers only pass the people they will
// actually keep. Emails and phone numbers are explicitly not requested,
// and mapPerson drops them even if Apollo sends any anyway.
async function enrichPeople(apiKey, people, opts = {}) {
  const need = people.filter((p) => p.apolloId && (!p.profileUrl || p.nameMasked));
  const byId = new Map();
  for (let i = 0; i < need.length; i += 10) {
    const batch = need.slice(i, i + 10);
    const data = await post(
      apiKey,
      '/people/bulk_match',
      { details: batch.map((p) => ({ id: p.apolloId })), reveal_personal_emails: false, reveal_phone_number: false },
      opts
    );
    for (const m of data.matches || []) if (m && m.id) byId.set(m.id, m);
  }
  let enriched = 0;
  const out = people.map((p) => {
    const m = byId.get(p.apolloId);
    if (!m) return p;
    enriched++;
    // The preview has no seniority, departments, location or LinkedIn URL;
    // the enriched record is authoritative for all of those.
    const full = mapPerson(m, { name: p.company });
    return {
      ...p,
      name: full.nameMasked ? p.name : full.name || p.name,
      nameMasked: full.nameMasked,
      title: p.title || full.title,
      seniority: full.seniority || p.seniority,
      departments: full.departments && full.departments.length ? full.departments : p.departments,
      profileUrl: full.profileUrl || p.profileUrl,
      location: full.location || p.location
    };
  });
  return { people: out, requested: need.length, enriched };
}

// Walks the project's seniority tiers in order (decision makers first,
// managers as fallback...) until maxCandidates distinct people are found -
// the "if no decision makers, go to All Employees / add managers last" step
// of the manual SOP. Each person carries the tier index they came from.
async function collectCandidates(apiKey, org, project, opts = {}) {
  const seen = new Set();
  const out = [];
  for (let tierIdx = 0; tierIdx < project.seniorityTiers.length && out.length < project.maxCandidatesPerCompany; tierIdx++) {
    const tier = project.seniorityTiers[tierIdx];
    const { people, total } = await searchPeople(
      apiKey,
      org,
      { seniorities: tier.seniorities, titles: project.titleKeywords, locations: project.personLocations, perPage: project.maxCandidatesPerCompany },
      opts
    );
    logger.info(`  ${tier.label}: ${people.length} returned (${total} total in Apollo)`);
    for (const p of people) {
      const key = p.profileUrl || `${p.name}|${p.title}`;
      if (!p.name || seen.has(key)) continue;
      seen.add(key);
      out.push({ ...p, tierIndex: tierIdx, tierLabel: tier.label });
      if (out.length >= project.maxCandidatesPerCompany) break;
    }
  }
  return out;
}

module.exports = { findOrganization, searchPeople, enrichPeople, collectCandidates, linkedInSlug, cleanCompanyUrl, mapOrganization, mapPerson, toQuery };
