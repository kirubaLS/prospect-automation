// Groq designation expansion: parsing, cleaning, caching, graceful failure.
//   node test/llm.test.js
const assert = require('assert');
const llm = require('../src/llm');

assert.strictEqual(llm.configFromEnv({}).configured, false);
assert.deepStrictEqual(llm.configFromEnv({ GROQ_API_KEY: 'k' }), { apiKey: 'k', model: 'llama-3.1-8b-instant', configured: true });
assert.deepStrictEqual(llm.clean(['IT Head', ' it head ', 'Head of IT', '- GM IT', '{bad}', 'x'.repeat(70), 7], ['Head of IT']), ['IT Head', 'GM IT']);

(async () => {
  const cfg = llm.configFromEnv({ GROQ_API_KEY: 'k' });
  let calls = 0; let lastBody = null;
  const fetchImpl = async (url, init) => {
    calls++; lastBody = JSON.parse(init.body);
    assert.ok(url.startsWith('https://api.groq.com/'));
    assert.strictEqual(init.headers.Authorization, 'Bearer k');
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ variants: ['IT Head', 'Head - Information Technology', 'Head of IT'] }) } }] }), text: async () => '' };
  };
  const counter = {};
  const r = await llm.expandTitles({ company: 'Acme', industry: 'retail', titles: ['Head of IT'], priority: 1 }, cfg, { fetchImpl, counter });
  assert.deepStrictEqual(r.added, ['IT Head', 'Head - Information Technology']);
  assert.deepStrictEqual(r.titles, ['Head of IT', 'IT Head', 'Head - Information Technology']);
  assert.strictEqual(lastBody.model, 'llama-3.1-8b-instant');
  assert.ok(/Acme/.test(lastBody.messages[1].content) && /Head of IT/.test(lastBody.messages[1].content));
  assert.strictEqual(counter.llmCalls, 1);
  // cached: same company + titles = no second call
  await llm.expandTitles({ company: 'Acme', industry: 'retail', titles: ['Head of IT'], priority: 1 }, cfg, { fetchImpl, counter });
  assert.strictEqual(calls, 1);
  // not configured: originals untouched, no call
  const none = await llm.expandTitles({ company: 'Acme', titles: ['CFO'] }, llm.configFromEnv({}), { fetchImpl });
  assert.deepStrictEqual(none, { titles: ['CFO'], added: [] });
  assert.strictEqual(calls, 1);
  // Groq down: originals kept, no throw
  const bad = await llm.expandTitles({ company: 'Beta', titles: ['CFO'] }, cfg, { fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'boom' }) });
  assert.deepStrictEqual(bad, { titles: ['CFO'], added: [] });
  console.log('PASS: llm expansion');
})().catch((e) => { console.error(e); process.exit(1); });
