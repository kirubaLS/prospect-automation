const logger = require('./logger');

const BASE = 'https://api.apollo.io/api/v1';

let lastCallAt = 0;
const MIN_GAP_MS = 1200; // stay well under Apollo's per-minute limit

async function pace() {
  const wait = MIN_GAP_MS - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

async function post(apiKey, path, body, { fetchImpl = fetch } = {}) {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await pace();
    const res = await fetchImpl(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'X-Api-Key': apiKey
      },
      body: JSON.stringify(body)
    });
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

// Company row (name + LinkedIn URL) -> Apollo organization. Matches on the
// LinkedIn company slug first (exact), then website domain, then an exact
// case-insensitive name; a fuzzy name hit alone is not trusted.
async function findOrganization(apiKey, company, opts = {}) {
  const name = (company['Company Name'] || '').trim();
  const wantSlug = linkedInSlug(company['LinkedIn URL']);
  const wantDomain = company.Website ? domainOf(company.Website) : null;
  if (!name && !wantSlug) return { organization: null, reason: 'no company name or LinkedIn URL' };

  const data = await post(apiKey, '/mixed_companies/search', { q_organization_name: name || wantSlug, page: 1, per_page: 10 }, opts);
  const orgs = (data.organizations || data.accounts || []).map(mapOrganization);
  if (orgs.length === 0) return { organization: null, reason: 'no Apollo organization matched the name' };

  const bySlug = wantSlug && orgs.find((o) => linkedInSlug(o.linkedinUrl) === wantSlug);
  if (bySlug) return { organization: bySlug, matchedBy: 'linkedin' };
  const byDomain = wantDomain && orgs.find((o) => domainOf(o.website) === wantDomain);
  if (byDomain) return { organization: byDomain, matchedBy: 'domain' };
  const byName = orgs.find((o) => o.name.trim().toLowerCase() === name.toLowerCase());
  if (byName) return { organization: byName, matchedBy: 'name' };

  return {
    organization: null,
    reason: `Apollo returned ${orgs.length} candidate(s) but none matched the LinkedIn URL/name (closest: ${orgs[0].name} ${orgs[0].linkedinUrl})`
  };
}

function mapPerson(p, org) {
  return {
    apolloId: p.id,
    name: [p.first_name, p.last_name].filter(Boolean).join(' ') || p.name || '',
    title: p.title || '',
    headline: p.headline || '',
    seniority: p.seniority || '',
    departments: p.departments || [],
    profileUrl: p.linkedin_url || '',
    location: [p.city, p.state, p.country].filter(Boolean).join(', '),
    company: (p.organization && p.organization.name) || org.name
  };
}

// One people search for one seniority tier. Titles and locations are
// optional; Apollo treats person_titles as an OR list matched against the
// current title.
async function searchPeople(apiKey, org, { seniorities, titles, locations, perPage = 25, page = 1 }, opts = {}) {
  const body = {
    organization_ids: [org.id],
    person_seniorities: seniorities,
    page,
    per_page: perPage
  };
  if (titles && titles.length) body.person_titles = titles;
  if (locations && locations.length) body.person_locations = locations;

  const data = await post(apiKey, '/mixed_people/search', body, opts);
  const people = (data.people || data.contacts || []).map((p) => mapPerson(p, org));
  const total = data.pagination ? data.pagination.total_entries : people.length;
  return { people, total };
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

module.exports = { findOrganization, searchPeople, collectCandidates, linkedInSlug, mapOrganization, mapPerson };
