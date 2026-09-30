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
assert.deepStrictEqual(w.providersFromEnv({ BRAVE_SEARCH_API_KEY: 'b', GOOGLE_CSE_API_KEY: 'g', GOOGLE_CSE_CX: 'c' }).map((p) => p.name), ['brave', 'google']);
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
  const hit = await w.findProfile(person, providers, { fetchImpl });
  assert.strictEqual(hit.provider, 'google');
  assert.strictEqual(hit.profileUrl, 'https://www.linkedin.com/in/priya-nathan');
  assert.deepStrictEqual(seen, ['api.search.brave.com', 'www.googleapis.com']);
  assert.strictEqual(providers[0].exhausted, true);
  // second call skips brave entirely
  seen.length = 0;
  await w.findProfile(person, providers, { fetchImpl });
  assert.deepStrictEqual(seen, ['www.googleapis.com']);
  console.log('PASS: web search profile resolution');
})().catch((e) => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
