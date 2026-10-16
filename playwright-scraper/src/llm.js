// Designation expansion through Groq's free, OpenAI-compatible chat API.
// Given one priority group of designations and the company, the model
// returns the variants that company might actually use ("Head of IT" ->
// "IT Head", "Head - Information Technology", "Manager IT & Systems").
// The originals are always kept; the variants only widen the Apollo search.
// Our own title rules still decide what counts (exclusions apply), so a
// wild variant can at most waste an Apollo call. No key -> no expansion.
const logger = require('./logger');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MAX_VARIANTS = 20;
// A variant carrying one of these words is a different (lower) role unless
// the typed designation itself has the word.
const DOWNGRADE = /\b(assistant|asst|associate|deputy|vice|junior|jr|intern|trainee|executive assistant|secretary|coordinator|analyst|officer|specialist|support)\b/i;
const cache = new Map();
const CACHE_MAX = 500;

function configFromEnv(env = process.env) {
  return { apiKey: env.GROQ_API_KEY || null, model: env.GROQ_MODEL || 'openai/gpt-oss-20b', configured: !!env.GROQ_API_KEY };
}

function clean(list, originals) {
  const seen = new Set(originals.map((t) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()));
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    if (typeof raw !== 'string') continue;
    const t = raw.replace(/[\s ]+/g, ' ').replace(/^[\-•*\d.)\s]+/, '').trim();
    if (!t || t.length > 60 || t.length < 2 || /[{}[\]<>|;:]/.test(t)) continue;
    const k = t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (seen.has(k)) continue;
    const dg = DOWNGRADE.exec(t);
    if (dg && !originals.some((o) => new RegExp('\\b' + dg[1] + '\\b', 'i').test(o))) continue;
    seen.add(k); out.push(t);
    if (out.length >= MAX_VARIANTS) break;
  }
  return out;
}

async function expandTitles({ company, industry = '', titles, priority = 1 }, cfg, { fetchImpl = fetch, counter = null } = {}) {
  if (!cfg || !cfg.apiKey || !titles || !titles.length) return { titles: titles || [], added: [] };
  const key = `${(company || '').toLowerCase()}|${industry.toLowerCase()}|${titles.join('|').toLowerCase()}`;
  if (cache.has(key)) return cache.get(key);
  const system = 'You expand B2B prospecting job titles for a search filter. Reply with JSON only: {"variants": ["..."]}. Each variant must be a real job title that a person holding one of the given roles could carry at this company: synonyms, abbreviations, regional wording (India/US/UK), "Head -", "VP -", "AVP", "GM" forms, and department phrasings. Rules: same function and same seniority band as the given roles only; never a junior, assistant, deputy, associate or support role; never a different department; never a person name or a description; nothing you are not confident is a real title. 8 to 20 variants, fewer if unsure.';
  const user = `Company: ${company || 'unknown'}${industry ? ` (industry: ${industry})` : ''}\nPriority ${priority} designations: ${titles.join(', ')}`;
  const body = { model: cfg.model, temperature: 0.2, max_tokens: 400, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  let added = [];
  try {
    if (counter) counter.llmCalls = (counter.llmCalls || 0) + 1;
    const res = await fetchImpl(GROQ_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`);
    const data = await res.json();
    const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { const m = String(text || '').match(/\{[\s\S]*\}/); if (m) { try { parsed = JSON.parse(m[0]); } catch {} } }
    added = clean(parsed && (parsed.variants || parsed.titles || parsed.designations), titles);
  } catch (err) {
    logger.warn(`    designation expansion skipped (${err.message})`);
  }
  const result = { titles: [...titles, ...added], added };
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, result);
  return result;
}

module.exports = { configFromEnv, expandTitles, clean, _cache: cache };
