// Resolves a person's LinkedIn profile URL, full name and location from a
// web search, at no Apollo cost. Apollo's free People API Search gives the
// first name, an obfuscated surname ("Na***n": first two letters, last
// letter), title and employer; a search such as
//   "Priya" "IT Head" "Kosmoderma" site:linkedin.com/in
// returns the profile, whose result title reads
//   "Priya Nathan - IT Head - Kosmoderma Healthcare | LinkedIn"
// and whose snippet usually opens with the location. The obfuscated
// surname is used to verify the match before anything is accepted.
//
// Providers (official APIs, used within their terms, all with free tiers):
//   serper  SERPER_API_KEY                       Google results; 2,500 free on signup, no card
//   tavily  TAVILY_API_KEY                       1,000 queries/month free, no card
//   brave   BRAVE_SEARCH_API_KEY                 2,000 queries/month free
//   google  GOOGLE_CSE_API_KEY + GOOGLE_CSE_CX   100 queries/day free
// They are tried in this order; one that runs out of quota is skipped for
// the rest of the job.
const logger = require('./logger');

let lastCallAt = 0;
const MIN_GAP_MS = 1100; // Brave's free tier allows 1 request/second

async function pace() {
  const wait = MIN_GAP_MS - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

function providersFromEnv(env = process.env) {
  const out = [];
  if (env.SERPER_API_KEY) out.push({ name: 'serper', key: env.SERPER_API_KEY });
  if (env.TAVILY_API_KEY) out.push({ name: 'tavily', key: env.TAVILY_API_KEY });
  if (env.BRAVE_SEARCH_API_KEY) out.push({ name: 'brave', key: env.BRAVE_SEARCH_API_KEY });
  if (env.GOOGLE_CSE_API_KEY && env.GOOGLE_CSE_CX) out.push({ name: 'google', key: env.GOOGLE_CSE_API_KEY, cx: env.GOOGLE_CSE_CX });
  return out;
}

// Normalised {title, url, snippet} list from either provider.
async function webSearch(provider, q, opts = {}) {
  const { fetchImpl = fetch } = opts;
  if (opts.counter) opts.counter.webSearches = (opts.counter.webSearches || 0) + 1;
  await pace();
  let url;
  let init = { headers: { Accept: 'application/json' } };
  if (provider.name === 'serper') {
    url = 'https://google.serper.dev/search';
    const body = { q, num: 10 };
    if (opts.gl) body.gl = opts.gl;
    init = { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-KEY': provider.key }, body: JSON.stringify(body) };
  } else if (provider.name === 'tavily') {
    url = 'https://api.tavily.com/search';
    init = { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.key}` }, body: JSON.stringify({ query: q, max_results: 10, ...(opts.anyDomain ? {} : { include_domains: ['linkedin.com'] }), search_depth: 'basic' }) };
  } else if (provider.name === 'brave') {
    url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=10&safesearch=off${opts.gl ? `&country=${opts.gl}` : ''}`;
    init.headers['X-Subscription-Token'] = provider.key;
  } else if (provider.name === 'google') {
    url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(provider.key)}&cx=${encodeURIComponent(provider.cx)}&q=${encodeURIComponent(q)}&num=10${opts.gl ? `&gl=${opts.gl}` : ''}`;
  } else {
    throw new Error(`unknown search provider ${provider.name}`);
  }
  const res = await fetchImpl(url, init);
  if (res.status === 429 || res.status === 402 || res.status === 432 || res.status === 433 || (res.status === 400 && provider.name === 'serper' && /credit/i.test(await res.clone().text().catch(() => '')))) {
    const err = new Error(`${provider.name} search quota exhausted (${res.status})`);
    err.quota = true;
    throw err;
  }
  if (!res.ok) throw new Error(`${provider.name} search failed (${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const data = (await res.json().catch(() => null)) || {};
  if (provider.name === 'serper') {
    return (data.organic || []).map((r) => ({ title: r.title || '', url: r.link || '', snippet: r.snippet || '' }));
  }
  if (provider.name === 'tavily') {
    return (data.results || []).map((r) => ({ title: r.title || '', url: r.url || '', snippet: r.content || '' }));
  }
  if (provider.name === 'brave') {
    return ((data.web && data.web.results) || []).map((r) => ({ title: r.title || '', url: r.url || '', snippet: r.description || '' }));
  }
  return (data.items || []).map((r) => ({ title: r.title || '', url: r.link || '', snippet: r.snippet || '' }));
}

function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// "Na***n" -> /^na.*n$/ ; "S." or "S" -> /^s/ ; "" -> anything
function maskedToRegex(masked) {
  const m = String(masked || '').trim().toLowerCase();
  if (!m) return null;
  const parts = m.match(/^([a-z' -]*)\*+([a-z' -]*)$/);
  if (parts) return new RegExp(`^${norm(parts[1])}.*${norm(parts[2])}$`);
  const bare = norm(m.replace(/\./g, ''));
  return bare ? new RegExp(`^${bare}`) : null;
}

// Result title -> { name, title, company } from "Name - Title - Company | LinkedIn"
function parseTitle(t) {
  const clean = stripHtml(t).replace(/\s*[|–-]\s*LinkedIn\s*$/i, '').trim();
  const parts = clean.split(/\s+[-–—|]\s+/).map((x) => x.trim()).filter(Boolean);
  return { name: parts[0] || '', title: parts[1] || '', company: parts.slice(2).join(' - ') || '' };
}

// The snippet for a profile usually opens with the location:
// "Chennai, Tamil Nadu, India · IT Head · Kosmoderma. Experience: ..."
function parseLocation(snippet) {
  const s = stripHtml(snippet).trim();
  const first = s.split(/\s+·\s+/)[0] || '';
  if (first && first.length <= 60 && first.includes(',') && !/experience|education|connections|followers/i.test(first)) return first.replace(/\.$/, '');
  const m = s.match(/(?:Location|Located in)[:\s]+([A-Z][^.·]{3,60})/);
  return m ? m[1].trim() : '';
}

const STOP = ['the', 'and', 'ltd', 'limited', 'pvt', 'private', 'inc', 'llc', 'llp', 'group', 'company', 'co', 'of', 'at', 'in', 'for'];
function significantWords(s) {
  // Two-letter words are kept because IT, HR, GM, VP, MD carry meaning here.
  return norm(s).split(' ').filter((w) => w.length >= 2 && !STOP.includes(w));
}
// "Kosmoderma Skin, Hair & Body Clinics" -> "Kosmoderma Skin": the first
// two distinctive words identify the company without over-restricting.
function shortCompany(name) {
  const words = String(name || '').replace(/[|,()]/g, ' ').split(/\s+/).filter((w) => w && !STOP.includes(w.toLowerCase()));
  return words.slice(0, 2).join(' ');
}
// Serper/Google country code from the job's person locations ("Tamil Nadu,
// India" -> "in"), so the search is run against that country's index.
const COUNTRY_CODES = { india: 'in', 'united states': 'us', usa: 'us', us: 'us', 'united kingdom': 'gb', uk: 'gb', 'united arab emirates': 'ae', uae: 'ae', singapore: 'sg', australia: 'au', canada: 'ca', germany: 'de', france: 'fr', netherlands: 'nl', 'saudi arabia': 'sa', qatar: 'qa', malaysia: 'my', indonesia: 'id', philippines: 'ph', japan: 'jp', 'south africa': 'za', ireland: 'ie', spain: 'es', italy: 'it' };
function countryCode(locations) {
  for (const loc of locations || []) {
    const last = String(loc).split(',').pop().trim().toLowerCase();
    if (COUNTRY_CODES[last]) return COUNTRY_CODES[last];
  }
  return null;
}

// Scores one search result against what Apollo told us. Returns null when
// it cannot be the same person.
function scoreResult(r, person) {
  if (!/linkedin\.com\/in\//i.test(r.url)) return null;
  const parsed = parseTitle(r.title);
  const nameWords = norm(parsed.name).split(' ').filter(Boolean);
  if (!nameWords.length) return null;
  const first = norm(person.firstName);
  if (!first || nameWords[0] !== first.split(' ')[0]) return null;
  let score = 1;
  const lastRe = maskedToRegex(person.lastMasked);
  const last = nameWords[nameWords.length - 1];
  if (lastRe) {
    if (nameWords.length < 2 || !lastRe.test(last)) return null;
    score += 3;
  }
  const hay = norm(`${parsed.title} ${parsed.company} ${stripHtml(r.snippet)}`);
  const companyWords = significantWords(person.company);
  const companyHit = companyWords.length ? companyWords.filter((w) => hay.includes(w)).length / companyWords.length : 0;
  const titleWords = significantWords(person.title);
  const titleHit = titleWords.length ? titleWords.filter((w) => hay.includes(w)).length / titleWords.length : 0;
  if (companyHit === 0 && titleHit === 0) return null;
  score += companyHit * 3 + titleHit * 2;
  return { score, fullName: parsed.name.trim(), profileUrl: r.url.split('?')[0], location: parseLocation(r.snippet), titleSeen: parsed.title };
}

// Three queries, strict to loose; the search stops at the first one that
// yields a verified match, so most people cost a single query.
function buildQueries(person) {
  const first = `"${person.firstName}"`;
  const title = String(person.title || '').replace(/[|"]/g, ' ').replace(/\s+/g, ' ').trim();
  const company = String(person.company || '').replace(/["]/g, '').trim();
  const short = shortCompany(company);
  const qs = [];
  if (title && company) qs.push(`${first} "${title}" "${company}" site:linkedin.com/in`);
  if (title && short) qs.push(`${first} ${title} "${short}" site:linkedin.com/in`);
  if (short) qs.push(`${first} "${short}" linkedin`);
  else if (title) qs.push(`${first} "${title}" site:linkedin.com/in`);
  return [...new Set(qs)];
}
function buildQuery(person) {
  return buildQueries(person)[0] || '';
}

// People already resolved in this process are not searched again (a rerun
// of the same file costs no queries for them).
const cache = new Map();
const CACHE_MAX = 5000;

// person: { firstName, lastMasked, title, company, apolloId }
// opts: { fetchImpl, gl, counter }
// Returns { profileUrl, fullName, location, provider } or null.
async function findProfile(person, providers, opts = {}) {
  if (!person.firstName) return null;
  const cacheKey = person.apolloId || `${person.firstName}|${person.lastMasked}|${person.title}|${person.company}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const queries = buildQueries(person);
  let searchedOk = false;
  for (const q of queries) {
    for (const provider of providers) {
      if (provider.exhausted) continue;
      let results;
      try {
        results = await webSearch(provider, q, opts);
      } catch (err) {
        if (err.quota) {
          provider.exhausted = true;
          logger.warn(`${provider.name}: ${err.message} - trying the next provider`);
          continue;
        }
        throw err;
      }
      searchedOk = true;
      const best = results.map((r) => scoreResult(r, person)).filter(Boolean).sort((a, b) => b.score - a.score)[0];
      if (best && best.score >= 4) {
        const hit = { ...best, provider: provider.name, query: q };
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
        cache.set(cacheKey, hit);
        return hit;
      }
      break; // this query searched fine but found nothing - try the next, looser query
    }
  }
  if (!searchedOk) {
    const err = new Error('all web search providers are out of quota');
    err.quota = true;
    throw err;
  }
  return null;
}

// Company website by web search (0 Apollo credits): the first result whose
// domain or title carries the company's name, skipping social networks and
// directories. Used when an input row has no Website column.
const NOT_A_COMPANY_SITE = /(^|\.)(linkedin|facebook|instagram|twitter|x|youtube|wikipedia|crunchbase|zoominfo|apollo|glassdoor|indeed|ambitionbox|justdial|indiamart|tofler|zaubacorp|bloomberg|dnb|tracxn|g2|rocketreach|signalhire|naukri|google|amazon|flipkart|yelp|bbb|owler|craft|pitchbook|cbinsights|companycheck|opencorporates|economictimes|business-standard|reuters|forbes|medium|github|wikidata|yellowpages|sulekha|mca\.gov|thecompanycheck|tofler|kompass|europages|alibaba|tradeindia|exportersindia|angel|wellfound|clutch|goodfirms|trustpilot|mouthshut)\.(com|co|in|org|net|io|me|gov)$/i;
function domainOfUrl(u) { try { return new URL(u).hostname.replace(/^www\./i, '').toLowerCase(); } catch { return ''; } }
async function findCompanyDomain(company, providers, opts = {}) {
  const name = String(company.name || '').trim();
  if (!name) return null;
  const key = `co|${name.toLowerCase()}`;
  if (cache.has(key)) return cache.get(key);
  const words = significantWords(name).filter((wd) => wd.length >= 3);
  const q = `${name} official website`;
  let searchedOk = false;
  for (const provider of providers) {
    if (provider.exhausted) continue;
    let results;
    try { results = await webSearch(provider, q, { ...opts, anyDomain: true }); } catch (err) {
      if (err.quota) { provider.exhausted = true; logger.warn(`${provider.name}: ${err.message} - trying the next provider`); continue; }
      throw err;
    }
    searchedOk = true;
    let best = null;
    for (const r of results) {
      const d = domainOfUrl(r.url);
      if (!d || NOT_A_COMPANY_SITE.test(d)) continue;
      const dflat = d.replace(/[^a-z0-9]/g, '');
      const inDomain = words.filter((wd) => dflat.includes(wd.replace(/[^a-z0-9]/g, ''))).length;
      const inTitle = words.filter((wd) => norm(r.title).includes(wd)).length;
      const score = inDomain * 3 + inTitle;
      if (score > 0 && (!best || score > best.score)) best = { domain: d, url: r.url, title: r.title, score, provider: provider.name };
    }
    // a name word in the domain, or every name word in the title, is good enough
    if (best && (best.score >= 3 || (words.length && best.score >= words.length))) {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(key, best);
      return best;
    }
    break;
  }
  if (!searchedOk) { const err = new Error('all web search providers are out of quota'); err.quota = true; throw err; }
  return null;
}

module.exports = { findProfile, findCompanyDomain, providersFromEnv, webSearch, scoreResult, parseTitle, parseLocation, maskedToRegex, buildQuery, buildQueries, countryCode, shortCompany, _cache: cache };
