// Web-search profile resolution: parsing, masked-surname verification, providers.
//   node test/websearch.test.js
const assert = require('assert');
const w = require('../src/websearch');

assert.deepStrictEqual(w.parseTitle('Priya Nathan - IT Head - Kosmoderma Healthcare | LinkedIn'), { name: 'Priya Nathan', title: 'IT Head', company: 'Kosmoderma Healthcare' });
assert.deepStrictEqual(w.parseTitle('Ravi Kumar – CFO – Acme Ltd - LinkedIn'), { name: 'Ravi Kumar', title: 'CFO', company: 'Acme Ltd' });
assert.strictEqual(w.parseLocation('Chennai, Tamil Nadu, India · IT Head · Kosmoderma. Experience: X'), 'Chennai, Tamil Nadu, India');
assert.strictEqual(w.parseLocation('Experience: Kosmoderma · Education: Anna University · 500+ connections'), '');
assert.ok(w.maskedToRegex('Na***n').test('nathan'));
assert.ok(!w.maskedToRegex('Na***n').test('sharma'));
assert.ok(w.maskedToRegex('S.').test('sharma'));
assert.strictEqual(w.maskedToRegex(''), null);
assert.strictEqual(w.buildQuery({ firstName: 'Priya', title: 'IT Head', company: 'Kosmoderma' }), '"Priya" "IT Head" "Kosmoderma" site:linkedin.com/in');
assert.deepStrictEqual(w.buildQueries({ firstName: 'Priya', title: 'IT Head', company: 'Kosmoderma Skin, Hair & Body Clinics' }), [
  '"Priya" "IT Head" "Kosmoderma Skin, Hair & Body Clinics" site:linkedin.com/in',
  '"Priya" IT Head "Kosmoderma Skin" site:linkedin.com/in',
  '"Priya" "Kosmoderma Skin" linkedin'
]);
assert.strictEqual(w.shortCompany('The Acme Group Pvt Ltd'), 'Acme');
assert.strictEqual(w.countryCode(['Tamil Nadu, India', 'Karnataka, India']), 'in');
assert.strictEqual(w.countryCode(['United States']), 'us');
assert.strictEqual(w.countryCode([]), null);
assert.ok(w.scoreResult({ title: 'Priya Nathan - Head of IT - Kosmoderma | LinkedIn', url: 'https://linkedin.com/in/pn', snippet: '' }, { firstName: 'Priya', lastMasked: 'Na***n', title: 'IT Head', company: 'Kosmoderma' }), '"IT" counts as a title word, so "Head of IT" matches "IT Head"');

const person = { firstName: 'Priya', lastMasked: 'Na***n', title: 'IT Head', company: 'Kosmoderma Healthcare' };
const good = w.scoreResult({ title: 'Priya Nathan - IT Head - Kosmoderma Healthcare | LinkedIn', url: 'https://in.linkedin.com/in/priya-nathan?trk=x', snippet: 'Chennai, Tamil Nadu, India · IT Head · Kosmoderma' }, person);
assert.ok(good && good.score >= 4);
assert.strictEqual(good.profileUrl, 'https://in.linkedin.com/in/priya-nathan');
assert.strictEqual(good.fullName, 'Priya Nathan');
assert.strictEqual(good.location, 'Chennai, Tamil Nadu, India');
assert.strictEqual(w.scoreResult({ title: 'Priya Sharma - IT Head - Kosmoderma | LinkedIn', url: 'https://linkedin.com/in/ps', snippet: '' }, person), null, 'surname must fit the mask');
assert.strictEqual(w.scoreResult({ title: 'Priya Nathan - Dermatologist - Random Clinic | LinkedIn', url: 'https://linkedin.com/in/pn', snippet: '' }, person), null, 'neither company nor title matched');
assert.strictEqual(w.scoreResult({ title: 'Priya Nathan - IT Head - Kosmoderma', url: 'https://www.linkedin.com/company/kosmoderma', snippet: '' }, person), null, 'not a profile URL');
assert.strictEqual(w.scoreResult({ title: 'Kosmoderma Healthcare | LinkedIn', url: 'https://linkedin.com/in/x', snippet: '' }, person), null, 'first name must lead the title');
assert.deepStrictEqual(w.providersFromEnv({ BRAVE_SEARCH_API_KEY: 'b', GOOGLE_CSE_API_KEY: 'g', GOOGLE_CSE_CX: 'c', SERPER_API_KEY: 's', TAVILY_API_KEY: 't' }).map((p) => p.name), ['serper', 'tavily', 'brave', 'google']);
assert.deepStrictEqual(w.providersFromEnv({ GOOGLE_CSE_API_KEY: 'g' }), [], 'google needs both key and cx');

(async () => {
  // Provider fallback: brave out of quota -> google answers.
  const seen = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    seen.push(u.hostname);
    if (u.hostname === 'api.search.brave.com') return { ok: false, status: 429, text: async () => 'quota' };
    assert.strictEqual(u.searchParams.get('key'), 'g'); assert.strictEqual(u.searchParams.get('cx'), 'c');
    const d = { items: [{ title: 'Priya Nathan - IT Head - Kosmoderma | LinkedIn', link: 'https://www.linkedin.com/in/priya-nathan', snippet: 'Chennai, Tamil Nadu, India · IT Head · Kosmoderma' }] };
    return { ok: true, status: 200, json: async () => d, text: async () => '' };
  };
  const providers = w.providersFromEnv({ BRAVE_SEARCH_API_KEY: 'b', GOOGLE_CSE_API_KEY: 'g', GOOGLE_CSE_CX: 'c' });
  w._cache.clear();
  const hit = await w.findProfile(person, providers, { fetchImpl });
  assert.strictEqual(hit.provider, 'google');
  assert.strictEqual(hit.profileUrl, 'https://www.linkedin.com/in/priya-nathan');
  assert.deepStrictEqual(seen, ['api.search.brave.com', 'www.googleapis.com']);
  assert.strictEqual(providers[0].exhausted, true);
  // second call skips brave entirely
  seen.length = 0; w._cache.clear();
  await w.findProfile(person, providers, { fetchImpl });
  assert.deepStrictEqual(seen, ['www.googleapis.com']);

  // Escalating queries: strict query finds nothing, the looser second one does; a counter and a cache.
  w._cache.clear();
  const seenQ = [];
  const escalate = async (url, init) => {
    const q = JSON.parse(init.body).q; seenQ.push(q);
    assert.strictEqual(JSON.parse(init.body).gl, 'in');
    const d = /site:linkedin\.com\/in$/.test(q) && q.includes('"IT Head"') ? { organic: [] } : { organic: [{ title: 'Priya Nathan - Head of IT - Kosmoderma | LinkedIn', link: 'https://in.linkedin.com/in/priya-nathan', snippet: 'Chennai, Tamil Nadu, India · Head of IT · Kosmoderma' }] };
    return { ok: true, status: 200, json: async () => d, text: async () => '' };
  };
  const counter = {};
  const pe = { ...person, apolloId: 'p1', company: 'Kosmoderma Healthcare' };
  const he = await w.findProfile(pe, w.providersFromEnv({ SERPER_API_KEY: 's' }), { fetchImpl: escalate, gl: 'in', counter });
  assert.strictEqual(he.profileUrl, 'https://in.linkedin.com/in/priya-nathan');
  assert.strictEqual(seenQ.length, 2, 'strict query missed, second query hit, third never sent');
  assert.strictEqual(counter.webSearches, 2);
  const again = await w.findProfile(pe, w.providersFromEnv({ SERPER_API_KEY: 's' }), { fetchImpl: escalate, gl: 'in', counter });
  assert.strictEqual(again.profileUrl, he.profileUrl);
  assert.strictEqual(counter.webSearches, 2, 'cached: no new queries for the same person');
  w._cache.clear();

  // Serper (POST, X-API-KEY, organic[]) and Tavily (POST, Bearer, results[]) shapes.
  const serperFetch = async (url, init) => {
    assert.strictEqual(url, 'https://google.serper.dev/search'); assert.strictEqual(init.method, 'POST'); assert.strictEqual(init.headers['X-API-KEY'], 's');
    assert.match(JSON.parse(init.body).q, /site:linkedin\.com\/in$/);
    const d = { organic: [{ title: 'Priya Nathan - IT Head - Kosmoderma | LinkedIn', link: 'https://in.linkedin.com/in/priya-nathan', snippet: 'Chennai, Tamil Nadu, India · IT Head · Kosmoderma' }] };
    return { ok: true, status: 200, json: async () => d, text: async () => '' };
  };
  w._cache.clear();
  const hs = await w.findProfile(person, w.providersFromEnv({ SERPER_API_KEY: 's' }), { fetchImpl: serperFetch });
  assert.strictEqual(hs.provider, 'serper'); assert.strictEqual(hs.profileUrl, 'https://in.linkedin.com/in/priya-nathan'); assert.strictEqual(hs.location, 'Chennai, Tamil Nadu, India');
  const tavilyFetch = async (url, init) => {
    assert.strictEqual(url, 'https://api.tavily.com/search'); assert.strictEqual(init.headers.Authorization, 'Bearer t');
    assert.deepStrictEqual(JSON.parse(init.body).include_domains, ['linkedin.com']);
    const d = { results: [{ title: 'Priya Nathan - IT Head - Kosmoderma Healthcare | LinkedIn', url: 'https://www.linkedin.com/in/priya-nathan', content: 'Chennai, Tamil Nadu, India · IT Head · Kosmoderma Healthcare · Experience ...' }] };
    return { ok: true, status: 200, json: async () => d, text: async () => '' };
  };
  w._cache.clear();
  const ht = await w.findProfile(person, w.providersFromEnv({ TAVILY_API_KEY: 't' }), { fetchImpl: tavilyFetch });
  assert.strictEqual(ht.provider, 'tavily'); assert.strictEqual(ht.fullName, 'Priya Nathan');
  // Serper "not enough credits" (400) counts as quota -> next provider.
  const p2 = w.providersFromEnv({ SERPER_API_KEY: 's', TAVILY_API_KEY: 't' });
  const mixed = async (url, init) => url.includes('serper') ? { ok: false, status: 400, clone() { return this; }, text: async () => '{"message":"Not enough credits"}' } : tavilyFetch(url, init);
  w._cache.clear();
  const hm = await w.findProfile(person, p2, { fetchImpl: mixed });
  assert.strictEqual(hm.provider, 'tavily'); assert.strictEqual(p2[0].exhausted, true);
    // company website lookup: skips LinkedIn/directories, wants the name in the domain or title
  {
    const calls = [];
    const f = async (url) => { calls.push(url); return { ok: true, status: 200, json: async () => ({ web: { results: [
      { title: 'NeenOpal Inc. | LinkedIn', url: 'https://www.linkedin.com/company/neenopal', description: '' },
      { title: 'NeenOpal - Company profile', url: 'https://www.zoominfo.com/c/neenopal/1', description: '' },
      { title: 'NeenOpal: Data Science & Analytics Consulting', url: 'https://www.neenopal.com/about-us', description: '' }
    ] } }), text: async () => '' }; };
    w._cache.clear();
    const hit = await w.findCompanyDomain({ name: 'NeenOpal Inc.' }, [{ name: 'brave', key: 'k' }], { fetchImpl: f });
    assert.strictEqual(hit.domain, 'neenopal.com'); assert.strictEqual(hit.url, 'https://www.neenopal.com/about-us');
    assert.match(decodeURIComponent(calls[0]), /q=NeenOpal Inc\. official website/);
    const none = await w.findCompanyDomain({ name: 'Ghost Co' }, [{ name: 'brave', key: 'k' }], { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ web: { results: [{ title: 'Ghost | LinkedIn', url: 'https://www.linkedin.com/company/ghost' }] } }), text: async () => '' }) });
    assert.strictEqual(none, null, 'a LinkedIn page is not a website');
  }
console.log('PASS: web search profile resolution');
})().catch((e) => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
