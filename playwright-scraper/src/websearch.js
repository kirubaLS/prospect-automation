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
// Providers (official APIs, used within their terms, both with free tiers):
//   brave   BRAVE_SEARCH_API_KEY                 2,000 queries/month free
//   google  GOOGLE_CSE_API_KEY + GOOGLE_CSE_CX   100 queries/day free
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
  if (env.BRAVE_SEARCH_API_KEY) out.push({ name: 'brave', key: env.BRAVE_SEARCH_API_KEY });
  if (env.GOOGLE_CSE_API_KEY && env.GOOGLE_CSE_CX) out.push({ name: 'google', key: env.GOOGLE_CSE_API_KEY, cx: env.GOOGLE_CSE_CX });
  return out;
}

// Normalised {title, url, snippet} list from either provider.
async function webSearch(provider, q, { fetchImpl = fetch } = {}) {
  await pace();
  let url;
  let headers = { Accept: 'application/json' };
  if (provider.name === 'brave') {
    url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=10&safesearch=off`;
    headers['X-Subscription-Token'] = provider.key;
  } else if (provider.name === 'google') {
    url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(provider.key)}&cx=${encodeURIComponent(provider.cx)}&q=${encodeURIComponent(q)}&num=10`;
  } else {
    throw new Error(`unknown search provider ${provider.name}`);
  }
  const res = await fetchImpl(url, { headers });
  if (res.status === 429 || res.status === 402) {
    const err = new Error(`${provider.name} search quota exhausted (${res.status})`);
    err.quota = true;
    throw err;
  }
  if (!res.ok) throw new Error(`${provider.name} search failed (${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const data = await res.json();
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

function significantWords(s) {
  return norm(s).split(' ').filter((w) => w.length >= 3 && !['the', 'and', 'ltd', 'limited', 'pvt', 'private', 'inc', 'llc', 'llp', 'group', 'company', 'co'].includes(w));
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

function buildQuery(person) {
  const parts = [`"${person.firstName}"`];
  if (person.title) parts.push(`"${person.title}"`);
  if (person.company) parts.push(`"${person.company}"`);
  parts.push('site:linkedin.com/in');
  return parts.join(' ');
}

// person: { firstName, lastMasked, title, company }
// Returns { profileUrl, fullName, location, provider } or null.
async function findProfile(person, providers, opts = {}) {
  if (!person.firstName) return null;
  const q = buildQuery(person);
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
    const best = results.map((r) => scoreResult(r, person)).filter(Boolean).sort((a, b) => b.score - a.score)[0];
    if (best && best.score >= 4) return { ...best, provider: provider.name };
    return null; // searched fine, just no confident match - do not spend a second provider's quota
  }
  const err = new Error('all web search providers are out of quota');
  err.quota = true;
  throw err;
}

module.exports = { findProfile, providersFromEnv, webSearch, scoreResult, parseTitle, parseLocation, maskedToRegex, buildQuery };
