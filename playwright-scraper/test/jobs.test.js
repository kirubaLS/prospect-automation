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
const fetchImpl = async (url, init) => {
  const b = JSON.parse(init.body);
  let d;
  if (url.includes('mixed_companies')) d = /ghost/i.test(b.q_organization_name) ? { organizations: [] } : orgs;
  else if (b.organization_ids[0] === 'o3') d = { people: [], pagination: { total_entries: 0 } };
  else {
    const list = b.person_seniorities.includes('director') ? dm : mg;
    const f = b.person_titles ? list.filter((p) => b.person_titles.some((t) => new RegExp('\\b' + t + '\\b', 'i').test(p.title))) : list;
    d = { people: f, pagination: { total_entries: f.length } };
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
  assert.ok(!rows.some((r) => /Dermatologist|Developer/.test(r.title || '')), 'clinical/dev titles never written');
  assert.strictEqual(rows.find((r) => r.company === 'Ghost Co').companyStatus, 'Company not found');
  const empty = rows.find((r) => r.company === 'Empty Ltd');
  assert.strictEqual(empty.companyStatus, 'No people found');
  assert.match(empty.note, /Industry "retail" not in ICP list/);

  const out = jobs.toCsv(rows);
  assert.ok(out.startsWith('Company,Company LinkedIn URL,Company Status,Name,Designation,Seniority,Function,LinkedIn URL,Location,Match,Rank,Connections 500+,Activity,Note'));
  assert.ok(!/secret@example|1234567890|email|phone/i.test(out), 'no contact details in the CSV');
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
