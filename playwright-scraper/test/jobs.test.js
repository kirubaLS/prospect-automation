// Job engine: geography/ICP parsing and a full run against a mocked Apollo.
//   node test/jobs.test.js
const assert = require('assert');
const jobs = require('../src/jobs');

assert.deepStrictEqual(jobs.parseGeography('South India').slice(0, 2), ['Tamil Nadu, India', 'Karnataka, India']);
assert.deepStrictEqual(jobs.parseGeography('US; Karnataka, India\nUK'), ['United States', 'Karnataka, India', 'United Kingdom']);
assert.deepStrictEqual(jobs.parseGeography(''), []);
const icp = jobs.parseIcp('Education, Healthcare, Retail; IT, Administration, Procurement, Finance, Purchasing');
assert.deepStrictEqual(icp.industries, ['Education', 'Healthcare', 'Retail']);
assert.deepStrictEqual(icp.keywords, ['IT', 'Administration', 'Procurement', 'Finance', 'Purchasing']);
assert.deepStrictEqual(jobs.parseIcp('CEO, MD, fleet').industries, []);
assert.ok(jobs.expandKeywords(['IT']).includes('Information Technology'));
assert.ok(jobs.industryMatches('hospital & health care', ['Education', 'Healthcare', 'Retail']));
assert.ok(jobs.industryMatches('education management', ['Education']));
assert.ok(!jobs.industryMatches('retail', ['Education', 'Healthcare']));
console.log('PASS: geography/ICP parsing');

const orgs = { organizations: [
  { id: 'o1', name: 'Kosmoderma Healthcare', linkedin_url: 'http://www.linkedin.com/company/kosmodermahealthcare', industry: 'hospital & health care', estimated_num_employees: 129, city: 'Bengaluru', state: 'Karnataka', country: 'India' },
  { id: 'o3', name: 'Empty Ltd', linkedin_url: 'http://www.linkedin.com/company/empty-ltd', industry: 'retail', estimated_num_employees: 10, country: 'India' }
] };
const P = (f, l, t, s, d, u) => ({ id: u, first_name: f, last_name: l, title: t, seniority: s, departments: d, linkedin_url: 'http://www.linkedin.com/in/' + u, city: 'Bengaluru', state: 'Karnataka', country: 'India', email: 'secret@example.com', phone_numbers: [{ sanitized_number: '+911234567890' }] });
const dm = [P('Chytra', 'Anand', 'Founder & Chairperson', 'founder', ['c_suite'], 'chytra'), P('Siva', 'M', 'Head of Operations', 'head', ['operations'], 'siva'), P('Ravi', 'K', 'Consultant Dermatologist', 'director', [], 'ravi'), P('Priya', 'N', 'IT Head', 'head', ['information_technology'], 'priya')];
const mg = [P('Anu', 'P', 'IT Manager', 'manager', ['information_technology'], 'anu'), P('Dev', 'S', 'Software Developer', 'entry', ['engineering'], 'dev'), P('Raj', 'B', 'Purchase Manager', 'manager', ['operations'], 'raj')];
// Apollo's api_search returns a preview: masked last name, no LinkedIn URL.
// (Exactly the documented shape: last_name_obfuscated, no seniority, no
// location, no LinkedIn URL; total_entries at the top level.)
const preview = (p) => ({ id: p.id, first_name: p.first_name, last_name_obfuscated: p.last_name.slice(0, 2) + '***' + p.last_name.slice(-1), title: p.title, has_email: true, has_city: true, has_direct_phone: 'Yes', organization: { name: 'Kosmoderma Healthcare' } });
const all = [...dm, ...mg];
const calls = { search: 0, enrich: 0, enrichIds: [] };
const fetchImpl = async (url, init) => {
  const u = new URL(url);
  const b = init.body ? JSON.parse(init.body) : {};
  let d;
  if (u.pathname.endsWith('/organizations/enrich')) {
    assert.strictEqual(init.method, 'GET');
    const lu = u.searchParams.get('linkedin_url');
    const o = orgs.organizations.find((x) => x.linkedin_url.endsWith('/' + lu.split('/').pop()));
    d = { organization: o || null };
  } else if (u.pathname.endsWith('/mixed_companies/search')) d = /ghost/i.test(u.searchParams.get('q_organization_name')) ? { organizations: [] } : orgs;
  else if (u.pathname.endsWith('/people/bulk_match')) {
    calls.enrich++;
    assert.strictEqual(b.reveal_personal_emails, false); assert.strictEqual(b.reveal_phone_number, false);
    calls.enrichIds.push(...b.details.map((x) => x.id));
    d = { matches: b.details.map((x) => all.find((p) => p.id === x.id)) };
  } else {
    assert.ok(u.pathname.endsWith('/mixed_people/api_search'), 'people search must use api_search');
    assert.deepStrictEqual(b, {}, 'api_search filters go in the query string, not the body');
    calls.search++;
    const orgId = u.searchParams.get('organization_ids[]');
    const sen = u.searchParams.getAll('person_seniorities[]');
    const titles = u.searchParams.getAll('person_titles[]');
    assert.ok(u.searchParams.getAll('person_locations[]').includes('Tamil Nadu, India'));
    if (orgId === 'o3') d = { people: [], pagination: { total_entries: 0 } };
    else {
      const list = sen.includes('director') ? dm : mg;
      const f = titles.length ? list.filter((p) => titles.some((t) => new RegExp('\\b' + t + '\\b', 'i').test(p.title))) : list;
      d = { total_entries: f.length, people: f.map(preview) };
    }
  }
  return { ok: true, status: 200, json: async () => d, text: async () => JSON.stringify(d) };
};

(async () => {
  const csv = Buffer.from('Company Name,LinkedIn URL\n"Kosmoderma Skin, Hair & Body Clinics",https://www.linkedin.com/company/kosmodermahealthcare/\nGhost Co,https://www.linkedin.com/company/ghost/\nEmpty Ltd,https://www.linkedin.com/company/empty-ltd/\n');
  const params = { ...jobs.parseIcp('Healthcare; IT, Administration, Procurement, Finance, Purchasing'), locations: jobs.parseGeography('South India'), peoplePerCompany: 8 };
  params.icpKeywords = params.keywords;
  const progress = [];
  params.resolve = 'apollo';
  const { rows, state } = await jobs.runJob({ apiKey: 'k', fileBuffer: csv, filename: 'c.csv', params, fetchImpl, onProgress: (s) => progress.push(s.done) });

  assert.deepStrictEqual({ total: state.total, found: state.found, notFound: state.notFound, noPeople: state.noPeople, prospects: state.prospects }, { total: 3, found: 1, notFound: 1, noPeople: 1, prospects: 5 });
  // LinkedIn-URL path: 1 credit per company found via enrichment (2 orgs found, Ghost not), plus 5 enriched people.
  assert.deepStrictEqual({ ...state.apollo }, { peopleSearch: 6, orgSearch: 1, orgEnrich: 3, peopleEnrich: 1, peopleEnriched: 5, estimatedCredits: 8, webSearches: 0 });
  const k = rows.filter((r) => r.companyStatus === 'Found');
  assert.deepStrictEqual(k.map((r) => r.name), ['Priya N', 'Anu P', 'Raj B', 'Chytra Anand', 'Siva M'], 'ICP matches first, then decision-maker fallback');
  assert.deepStrictEqual(k.map((r) => r.match), ['ICP match', 'ICP match', 'ICP match', 'Fallback (no ICP title)', 'Fallback (no ICP title)']);
  assert.deepStrictEqual(k.map((r) => r.profileUrl), ['http://www.linkedin.com/in/priya', 'http://www.linkedin.com/in/anu', 'http://www.linkedin.com/in/raj', 'http://www.linkedin.com/in/chytra', 'http://www.linkedin.com/in/siva'], 'LinkedIn URLs come from enrichment');
  assert.deepStrictEqual(k.map((r) => r.location), Array(5).fill('Bengaluru, Karnataka, India'));
  assert.deepStrictEqual(k.map((r) => r.seniority), ['Head', 'Manager', 'Manager', 'Founder', 'Head'], 'seniority comes from the enriched record');
  assert.strictEqual(k[0].function, 'information_technology');
  assert.strictEqual(calls.enrich, 1, 'one bulk_match call for the 5 kept people');
  assert.deepStrictEqual([...calls.enrichIds].sort(), ['anu', 'chytra', 'priya', 'raj', 'siva'], 'only kept people are enriched, never the excluded doctor/developer');
  assert.ok(!rows.some((r) => /Dermatologist|Developer/.test(r.title || '')), 'clinical/dev titles never written');
  assert.strictEqual(rows.find((r) => r.company === 'Ghost Co').companyStatus, 'Company not found');
  const empty = rows.find((r) => r.company === 'Empty Ltd');
  assert.strictEqual(empty.companyStatus, 'No people found');
  assert.match(empty.note, /Industry "retail" not in ICP list/);

  const out = jobs.toCsv(rows);
  assert.ok(out.startsWith('Company,Company Status,Name,Designation,Location,LinkedIn URL,Activity,Activity Proof,Activity Note,Last Activity,Connections,Note,Company Website,Company LinkedIn URL\r\n'), 'only the requested columns: ' + out.split('\r\n')[0]);
  assert.ok(!/Seniority|Function|Match|Rank|Industry|Employees|HQ/.test(out.split('\r\n')[0]), 'no extra columns');
  assert.ok(!/secret@example|1234567890|email|phone|has_email/i.test(out), 'no contact details in the CSV');

  // resolve: 'search' -> Apollo preview + web search resolves URL/name/location, no bulk_match.
  const web = require('../src/websearch');
  web._cache.clear();
  const searchCalls = [];
  const searchFetch = async (url, init) => {
    const u = new URL(url);
    if (u.hostname === 'api.search.brave.com') {
      searchCalls.push(u.searchParams.get('q'));
      assert.strictEqual(init.headers['X-Subscription-Token'], 'brave-key');
      const q = u.searchParams.get('q');
      const m = q.match(/^"([^"]+)"/);
      const first = m[1];
      const person = all.find((p) => p.first_name === first);
      const results = person ? [
        { title: `${person.first_name} Wrong - ${person.title} - Another Company | LinkedIn`, url: 'https://www.linkedin.com/in/wrong', description: 'Mumbai, Maharashtra, India · Another Company' },
        { title: `${person.first_name} ${person.last_name.slice(0, 2)}xyz${person.last_name.slice(-1)} - ${person.title} - Kosmoderma Healthcare | LinkedIn`, url: `https://in.linkedin.com/in/${person.id}-real?trk=1`, description: `Bengaluru, Karnataka, India · ${person.title} · Kosmoderma Healthcare. Experience: ...` }
      ] : [];
      const d = { web: { results } };
      return { ok: true, status: 200, json: async () => d, text: async () => '' };
    }
    return fetchImpl(url, init);
  };
  const before3 = calls.enrich;
  const r4 = await jobs.runJob({ apiKey: 'k', fileBuffer: csv, filename: 'c.csv', params: { ...params, resolve: 'search', searchProviders: [{ name: 'brave', key: 'brave-key' }] }, fetchImpl: searchFetch });
  assert.strictEqual(calls.enrich, before3, 'no Apollo enrichment in search mode');
  const k4 = r4.rows.filter((r) => r.companyStatus === 'Found');
  assert.strictEqual(searchCalls.length, 5, 'one web search per kept person');
  assert.match(searchCalls[0], /^"Priya" "IT Head" "Kosmoderma Healthcare" site:linkedin\.com\/in$/);
  assert.strictEqual(r4.state.apollo.webSearches, 5);
  assert.deepStrictEqual(k4.map((r) => r.name), ['Priya NxyzN', 'Anu PxyzP', 'Raj BxyzB', 'Chytra Anxyzd', 'Siva MxyzM'], 'surname verified against the mask (Na***d style) and the wrong-surname result rejected');
  assert.deepStrictEqual(k4.map((r) => r.profileUrl), ['https://in.linkedin.com/in/priya-real', 'https://in.linkedin.com/in/anu-real', 'https://in.linkedin.com/in/raj-real', 'https://in.linkedin.com/in/chytra-real', 'https://in.linkedin.com/in/siva-real']);
  assert.deepStrictEqual([...new Set(k4.map((r) => r.location))], ['Bengaluru, Karnataka, India'], 'location parsed from the snippet');
  assert.ok(k4.every((r) => r.resolvedBy === 'brave'));

  // quota exhausted mid-run: remaining people stay listed with a note, job continues.
  let n = 0;
  const quotaFetch = async (url, init) => {
    if (new URL(url).hostname === 'api.search.brave.com' && ++n > 2) return { ok: false, status: 429, json: async () => ({}), text: async () => 'quota' };
    return searchFetch(url, init);
  };
  web._cache.clear();
  const r5 = await jobs.runJob({ apiKey: 'k', fileBuffer: csv, filename: 'c.csv', params: { ...params, resolve: 'search', searchProviders: [{ name: 'brave', key: 'brave-key' }] }, fetchImpl: quotaFetch });
  const k5 = r5.rows.filter((r) => r.companyStatus === 'Found');
  assert.strictEqual(k5.filter((r) => r.profileUrl).length, 2);
  assert.ok(k5.slice(2).every((r) => /quota/.test(r.note)), 'unresolved people carry the quota note');
  assert.strictEqual(r5.params.searchExhausted, true);

  // a broken search response for one person is a note, not a company error.
  let calls2 = 0;
  const flaky = async (url, init) => {
    if (new URL(url).hostname === 'api.search.brave.com' && ++calls2 === 2) return { ok: true, status: 200, json: async () => { throw new Error('bad json'); }, text: async () => '' };
    return searchFetch(url, init);
  };
  web._cache.clear();
  const r5b = await jobs.runJob({ apiKey: 'k', fileBuffer: csv, filename: 'c.csv', params: { ...params, resolve: 'search', searchProviders: [{ name: 'brave', key: 'brave-key' }] }, fetchImpl: flaky });
  const k5b = r5b.rows.filter((r) => r.companyStatus === 'Found');
  assert.strictEqual(k5b.length, 5, 'company still Found');
  assert.strictEqual(k5b.filter((r) => r.profileUrl).length, 5, 'the failed query is retried with the next, looser query');
  assert.strictEqual(r5b.state.apollo.webSearches, 6);
  assert.strictEqual(r5b.state.errors, 0);

  // resolve: 'apollo+search' -> Apollo fills what it can; only the rest go to web search.
  const partialEnrich = async (url, init) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/people/bulk_match')) {
      const b = JSON.parse(init.body);
      // Apollo knows everyone except Raj and Siva
      const d = { matches: b.details.map((x) => ['raj', 'siva'].includes(x.id) ? null : all.find((p) => p.id === x.id)) };
      return { ok: true, status: 200, json: async () => d, text: async () => '' };
    }
    return searchFetch(url, init);
  };
  searchCalls.length = 0; web._cache.clear();
  const r6 = await jobs.runJob({ apiKey: 'k', fileBuffer: csv, filename: 'c.csv', params: { ...params, resolve: 'apollo+search', searchProviders: [{ name: 'brave', key: 'brave-key' }] }, fetchImpl: partialEnrich });
  const k6 = r6.rows.filter((r) => r.companyStatus === 'Found');
  assert.deepStrictEqual(k6.map((r) => [r.name, r.resolvedBy]), [['Priya N', 'apollo'], ['Anu P', 'apollo'], ['Raj BxyzB', 'brave'], ['Chytra Anand', 'apollo'], ['Siva MxyzM', 'brave']], 'Apollo exact first, web search only for the two Apollo lacked');
  assert.strictEqual(searchCalls.length, 2, 'web search queries only for people Apollo left blank');
  assert.ok(k6.every((r) => r.profileUrl));

  // Priority groups: P1 searched first (exact titles, no seniority filter),
  // then P2, then P3, until the target is met; listed P3 titles like
  // Developer are never excluded; "similar" people only fill at the end.
  const prioCalls = [];
  const prioFetch = async (url, init) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/mixed_people/api_search')) {
      const titles = u.searchParams.getAll('person_titles[]');
      prioCalls.push(titles);
      assert.strictEqual(u.searchParams.get('include_similar_titles'), 'false');
      assert.strictEqual(u.searchParams.get('person_seniorities[]'), null, 'priority search is by title, not seniority');
      if (u.searchParams.get('organization_ids[]') !== 'o1') return { ok: true, status: 200, json: async () => ({ total_entries: 0, people: [] }), text: async () => '' };
      const f = all.filter((p) => titles.some((t) => new RegExp('\\b' + t + '\\b', 'i').test(p.title)));
      // Apollo also returns one loosely-similar person for the P1 query
      const extra = titles.includes('CIO') ? [P('Loose', 'Match', 'IT Support Analyst', 'entry', [], 'loose')] : [];
      const d = { total_entries: f.length, people: [...f, ...extra].map(preview) };
      return { ok: true, status: 200, json: async () => d, text: async () => JSON.stringify(d) };
    }
    return fetchImpl(url, init);
  };
  const pr = jobs.parseIcp('Healthcare; CIO, CTO > Head of Operations, IT Head > IT Manager, Software Developer, Purchase Manager');
  const r7 = await jobs.runJob({ apiKey: 'k', fileBuffer: csv, filename: 'c.csv', params: { locations: params.locations, industries: pr.industries, icpKeywords: pr.keywords, priorities: pr.priorities, peoplePerCompany: 4, resolve: 'none' }, fetchImpl: prioFetch });
  const k7 = r7.rows.filter((r) => r.companyStatus === 'Found');
  assert.deepStrictEqual(prioCalls.slice(0, 3), [['CIO', 'CTO'], ['Head of Operations', 'IT Head'], ['IT Manager', 'Software Developer', 'Purchase Manager']], 'groups searched in order');
  assert.deepStrictEqual(k7.map((r) => [r.title, r.match]), [['Head of Operations', 'Priority 2'], ['IT Head', 'Priority 2'], ['IT Manager', 'Priority 3'], ['Software Developer', 'Priority 3']], 'P2 people before P3; developer kept because it is listed; Purchase Manager (P3, 5th) cut by the target of 4');
  assert.ok(!k7.some((r) => r.name.startsWith('Loose')), 'similar-title person not used while listed titles fill the target');

  // resolve: 'none' -> preview only, no bulk_match, masked names kept as-is.
  const before = calls.enrich;
  const r2 = await jobs.runJob({ apiKey: 'k', fileBuffer: csv, filename: 'c.csv', params: { ...params, resolve: 'none' }, fetchImpl });
  assert.strictEqual(calls.enrich, before, 'no enrichment call when switched off');
  const k2 = r2.rows.filter((r) => r.companyStatus === 'Found');
  assert.strictEqual(k2[0].name, 'Priya N***N');
  assert.strictEqual(k2[0].seniority, '');
  assert.strictEqual(k2[0].profileUrl, '');
  assert.strictEqual(out.split('\r\n').filter(Boolean).length, 1 + 5 + 2);
  assert.ok(progress.length >= 3);

  const XLSX = require('xlsx');
  const wb = XLSX.read(jobs.toXlsx(rows), { type: 'buffer' });
  const sheetRows = XLSX.utils.sheet_to_json(wb.Sheets.Prospects, { defval: '' });
  assert.strictEqual(sheetRows.length, 7, 'xlsx has one row per person plus one per company without people');
  assert.deepStrictEqual(Object.keys(sheetRows[0]), jobs.OUTPUT_COLUMNS.map(([h]) => h), 'xlsx columns match the CSV');
  assert.strictEqual(sheetRows[0].Name, 'Priya N');
  assert.strictEqual(sheetRows[0]['LinkedIn URL'], 'http://www.linkedin.com/in/priya');
  assert.strictEqual(sheetRows.find((r) => r.Company === 'Ghost Co').Name, 'Company not found');
  assert.ok(!JSON.stringify(sheetRows).match(/secret@example|1234567890/), 'no contact details in the xlsx');
  const x = jobs.exportRows(rows, 'xlsx');
  assert.strictEqual(x.extension, 'xlsx');
  assert.ok(x.buffer.length > 1000);
  assert.strictEqual(jobs.exportRows(rows, 'csv').buffer.toString('utf8'), out);

  // Website column: people searched by employer domain, zero company-lookup calls.
  const lookups = [];
  const domainFetch = async (url, init) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/organizations/enrich') || u.pathname.endsWith('/mixed_companies/search')) lookups.push(u.pathname);
    if (u.pathname.endsWith('/mixed_people/api_search')) {
      assert.deepStrictEqual(u.searchParams.getAll('q_organization_domains_list[]'), ['kosmoderma.com']);
      assert.strictEqual(u.searchParams.get('organization_ids[]'), null);
    }
    return fetchImpl(url, init);
  };
  const csvDomain = Buffer.from('Company Name,Website,LinkedIn URL\nKosmoderma,https://www.kosmoderma.com/about,https://www.linkedin.com/company/kosmodermahealthcare/\n');
  const r3 = await jobs.runJob({ apiKey: 'k', fileBuffer: csvDomain, filename: 'c.csv', params, fetchImpl: domainFetch });
  assert.deepStrictEqual(lookups, [], 'no company lookup when a website domain is present');
  assert.deepStrictEqual({ ...r3.state.apollo }, { peopleSearch: 3, orgSearch: 0, orgEnrich: 0, peopleEnrich: 1, peopleEnriched: 5, estimatedCredits: 5, webSearches: 0 }, 'ledger: domain path costs only the enrichment');
  const r3b = await jobs.runJob({ apiKey: 'k', fileBuffer: csvDomain, filename: 'c.csv', params: { ...params, resolve: 'none' }, fetchImpl: domainFetch });
  assert.strictEqual(r3b.state.apollo.estimatedCredits, 0, 'domain path + no resolution = 0 credits');
  assert.strictEqual(r3b.state.apollo.peopleSearch, 3);
  const k3 = r3.rows.filter((r) => r.companyStatus === 'Found');
  assert.strictEqual(k3.length, 5);
  assert.strictEqual(k3[0].company, 'Kosmoderma');
  assert.strictEqual(k3[0].companyWebsite, 'https://www.kosmoderma.com/about');
  assert.strictEqual(k3[0].profileUrl, 'http://www.linkedin.com/in/priya');
  console.log('PASS: job run against mocked Apollo');
})().catch((e) => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
