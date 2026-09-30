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
  const b = JSON.parse(init.body);
  let d;
  if (u.pathname.endsWith('/mixed_companies/search')) d = /ghost/i.test(b.q_organization_name) ? { organizations: [] } : orgs;
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
  const { rows, state } = await jobs.runJob({ apiKey: 'k', fileBuffer: csv, filename: 'c.csv', params, fetchImpl, onProgress: (s) => progress.push(s.done) });

  assert.deepStrictEqual({ total: state.total, found: state.found, notFound: state.notFound, noPeople: state.noPeople, prospects: state.prospects }, { total: 3, found: 1, notFound: 1, noPeople: 1, prospects: 5 });
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
  assert.ok(out.startsWith('Company,Company LinkedIn URL,Company Status,Name,Designation,Seniority,Function,LinkedIn URL,Location,Match,Rank,Connections 500+,Activity,Note'));
  assert.ok(!/secret@example|1234567890|email|phone|has_email/i.test(out), 'no contact details in the CSV');

  // enrich: false -> preview only, no bulk_match, masked names kept as-is.
  const before = calls.enrich;
  const r2 = await jobs.runJob({ apiKey: 'k', fileBuffer: csv, filename: 'c.csv', params: { ...params, enrich: false }, fetchImpl });
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
  console.log('PASS: job run against mocked Apollo');
})().catch((e) => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
