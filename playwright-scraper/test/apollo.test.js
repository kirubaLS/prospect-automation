// Rules qualification, Apollo organization matching, and a full project run
// against a mocked Apollo API.   node test/apollo.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
function runCli(args, env) {
  const r = spawnSync(process.execPath, args, { env: { ...process.env, ...env }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`CLI exited ${r.status}:\n${r.stdout}\n${r.stderr}`);
  return r.stdout + r.stderr;
}
const XLSX = require('xlsx');

const sharp = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'projects', 'sharp', 'config.json'), 'utf8'));

// --- rules ---
const { buildMatcher, qualifyAndSelectByRules } = require('../src/rules');
const q = buildMatcher(sharp.rules);
assert.strictEqual(q({ title: 'Chief Information Officer', seniority: 'c_suite' }).priority, 'Tier 1');
assert.strictEqual(q({ title: 'Head of IT', seniority: 'head' }).priority, 'Tier 1');
assert.strictEqual(q({ title: 'IT Manager', seniority: 'manager' }).priority, 'Tier 2');
assert.strictEqual(q({ title: 'Head of Procurement', seniority: 'head' }).priority, 'Tier 2');
assert.strictEqual(q({ title: 'Senior Purchase Manager', seniority: 'senior' }).priority, 'Tier 3');
assert.strictEqual(q({ title: 'Founder & Chairperson', seniority: 'founder' }).priority, 'Tier 3');
assert.strictEqual(q({ title: 'Software Developer', seniority: 'entry' }).priority, 'Skip');
assert.strictEqual(q({ title: 'Consultant Dermatologist', seniority: 'senior' }).priority, 'Skip', 'doctors excluded');
assert.ok(q({ title: 'Chief Information Officer', seniority: 'c_suite' }).score > q({ title: 'IT Manager', seniority: 'manager' }).score);

const picked = qualifyAndSelectByRules(
  [
    { name: 'A', title: 'Founder', seniority: 'founder', tierIndex: 0 },
    { name: 'B', title: 'Head of Operations', seniority: 'head', tierIndex: 0 },
    { name: 'C', title: 'IT Manager', seniority: 'manager', tierIndex: 1 },
    { name: 'D', title: 'Software Developer', seniority: 'entry', tierIndex: 1 },
    { name: 'E', title: 'Purchase Manager', seniority: 'manager', tierIndex: 1 },
    { name: 'F', title: 'CIO', seniority: 'c_suite', tierIndex: 0 }
  ],
  { ...sharp, targetPerCompany: 4 }
);
assert.deepStrictEqual(picked.map((p) => p.name), ['F', 'B', 'C', 'E'], 'top 4 by score, developer skipped');
const short = qualifyAndSelectByRules(
  [{ name: 'X', title: 'Software Developer', seniority: 'entry' }, { name: 'Y', title: 'Regional Coordinator', seniority: 'manager' }, { name: 'Z', title: 'CIO', seniority: 'c_suite' }],
  { ...sharp, targetPerCompany: 3 }
);
assert.deepStrictEqual(short.map((p) => [p.name, p.status]), [['Z', 'Auto-Approved'], ['Y', 'Needs Review']], 'unmatched filler is flagged, excluded never included');
console.log('PASS: rules qualification');

// --- organization matching ---
const apollo = require('../src/apollo');
const orgs = {
  organizations: [
    { id: 'o1', name: 'Kosmoderma Healthcare', linkedin_url: 'http://www.linkedin.com/company/kosmodermahealthcare', website_url: 'http://kosmoderma.com', industry: 'hospital & health care', estimated_num_employees: 129, city: 'Bengaluru', state: 'Karnataka', country: 'India' },
    { id: 'o2', name: 'Kosmoderma Skin, Hair & Body Clinics', linkedin_url: 'http://www.linkedin.com/company/other-kosmo', industry: 'retail', estimated_num_employees: 5, country: 'India' }
  ]
};
// Enrichment answers by LinkedIn URL from the same org list; search reads
// q_organization_name from the query string.
const mockFetch = (responses) => async (url, init) => {
  const u = new URL(url);
  if (u.pathname.endsWith('/organizations/enrich')) {
    const want = apollo.linkedInSlug(u.searchParams.get('linkedin_url'));
    const o = (responses.companies.organizations || []).find((x) => apollo.linkedInSlug(x.linkedin_url) === want);
    const data = { organization: o || null };
    return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
  }
  const key = url.includes('mixed_companies') ? 'companies' : 'people';
  const body = init.body ? JSON.parse(init.body) : {};
  if (key === 'companies') body.q_organization_name = u.searchParams.get('q_organization_name');
  const data = typeof responses[key] === 'function' ? responses[key](body) : responses[key];
  return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
};
(async () => {
  const opts = { fetchImpl: mockFetch({ companies: orgs }) };
  const bySlug = await apollo.findOrganization('k', { 'Company Name': 'Kosmoderma Skin, Hair & Body Clinics', 'LinkedIn URL': 'https://www.linkedin.com/company/kosmodermahealthcare/' }, opts);
  assert.strictEqual(bySlug.organization.id, 'o1', 'LinkedIn URL enrichment beats exact name match');
  assert.strictEqual(bySlug.matchedBy, 'linkedin');
  const byName = await apollo.findOrganization('k', { 'Company Name': 'Kosmoderma Skin, Hair & Body Clinics', 'LinkedIn URL': '' }, opts);
  assert.strictEqual(byName.organization.id, 'o2', 'no URL: exact name match via search');
  const none = await apollo.findOrganization('k', { 'Company Name': 'Kosmoderma', 'LinkedIn URL': 'https://www.linkedin.com/company/nope/' }, opts);
  assert.strictEqual(none.organization, null);
  assert.match(none.reason, /none matched/);

  // The URL is the anchor: a junk name and a URL with a query string still
  // resolve through enrichment, with the query string stripped and a
  // single call (no second search burning a credit).
  const calls = [];
  const byUrl = await apollo.findOrganization(
    'k',
    { 'Company Name': '?originalSubdomain=in', 'LinkedIn URL': 'https://www.linkedin.com/company/kosmodermahealthcare/?originalSubdomain=in' },
    { fetchImpl: async (url, init) => { calls.push(url); return mockFetch({ companies: orgs })(url, init); } }
  );
  assert.strictEqual(byUrl.organization.id, 'o1');
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0], /\/organizations\/enrich\?linkedin_url=https%3A%2F%2Fwww.linkedin.com%2Fcompany%2Fkosmodermahealthcare&name=/);
  assert.strictEqual(apollo.cleanCompanyUrl('http://linkedin.com/company/Acme-Co/?originalSubdomain=fr'), 'https://www.linkedin.com/company/acme-co');
  assert.strictEqual(apollo.toQuery({ organization_ids: ['o1'], person_titles: ['IT Head', 'CFO'], per_page: 8, person_locations: [] }), '?organization_ids%5B%5D=o1&person_titles%5B%5D=IT+Head&person_titles%5B%5D=CFO&per_page=8');
  const person = await apollo.findOrganization('k', { 'Company Name': 'X', 'LinkedIn URL': 'https://www.linkedin.com/in/some-person/' }, opts);
  assert.strictEqual(person.organization, null);
  assert.match(person.reason, /person profile/);
  console.log('PASS: organization matching');

  // --- full project run with a mocked Apollo, via the CLI ---
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-'));
  fs.mkdirSync(path.join(tmp, 'sharp'));
  fs.writeFileSync(path.join(tmp, 'sharp', 'config.json'), JSON.stringify(sharp));
  fs.writeFileSync(
    path.join(tmp, 'sharp', 'companies.csv'),
    'Company Name,LinkedIn URL\n"Kosmoderma Skin, Hair & Body Clinics",https://www.linkedin.com/company/kosmodermahealthcare/\nGhost Co,https://www.linkedin.com/company/ghost-co/\nTiny Retail,https://www.linkedin.com/company/tiny-retail/\n'
  );
  const people = (body) => {
    const tier = body.person_seniorities.includes('director') ? 'dm' : 'mgr';
    const all = {
      dm: [
        { id: 'p1', first_name: 'Chytra', last_name: 'Anand', title: 'Founder & Chairperson', seniority: 'founder', departments: ['c_suite'], linkedin_url: 'http://www.linkedin.com/in/chytra', city: 'Bengaluru', state: 'Karnataka', country: 'India' },
        { id: 'p2', first_name: 'Siva', last_name: 'M', title: 'Head of Operations', seniority: 'head', departments: ['operations'], linkedin_url: 'http://www.linkedin.com/in/siva', city: 'Bengaluru', country: 'India' },
        { id: 'p3', first_name: 'Ravi', last_name: 'K', title: 'Consultant Dermatologist', seniority: 'director', departments: ['medical_health'], linkedin_url: 'http://www.linkedin.com/in/ravi', country: 'India' }
      ],
      mgr: [
        { id: 'p4', first_name: 'Anu', last_name: 'P', title: 'IT Manager', seniority: 'manager', departments: ['information_technology'], linkedin_url: 'http://www.linkedin.com/in/anu', city: 'Chennai', state: 'Tamil Nadu', country: 'India' },
        { id: 'p5', first_name: 'Dev', last_name: 'S', title: 'Software Developer', seniority: 'entry', departments: ['engineering'], linkedin_url: 'http://www.linkedin.com/in/dev', country: 'India' }
      ]
    };
    return { people: all[tier], pagination: { total_entries: all[tier].length } };
  };
  const companies = (body) => {
    if (/ghost/i.test(body.q_organization_name)) return { organizations: [] };
    if (/tiny/i.test(body.q_organization_name)) return { organizations: [{ id: 'o9', name: 'Tiny Retail', linkedin_url: 'http://www.linkedin.com/company/tiny-retail', industry: 'retail', estimated_num_employees: 0, country: 'India' }] };
    return orgs;
  };
  // Inject the mock into the child process through a preload module.
  const preload = path.join(tmp, 'mock-fetch.js');
  fs.writeFileSync(preload, `
    const orgs = ${JSON.stringify(orgs)};
    const companies = ${companies.toString()};
    const people = ${people.toString()};
    global.fetch = async (url, init) => {
      const body = init.body ? JSON.parse(init.body) : {};
      const u = new URL(url);
      if (u.pathname.endsWith('/organizations/enrich')) {
        const want = u.searchParams.get('linkedin_url').split('/').pop();
        const all = [...orgs.organizations, ...(companies({ q_organization_name: 'tiny' }).organizations)];
        const data = { organization: all.find((o) => o.linkedin_url.endsWith('/' + want)) || null };
        return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
      }
      if (u.pathname.endsWith('/mixed_people/api_search')) {
        if (Object.keys(body).length) throw new Error('api_search takes no JSON body');
        body.person_seniorities = u.searchParams.getAll('person_seniorities[]');
      }
      if (u.pathname.endsWith('/mixed_companies/search')) body.q_organization_name = u.searchParams.get('q_organization_name');
      const data = url.includes('mixed_companies') ? companies(body) : people(body);
      return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
    };
  `);
  const out = runCli(['-r', preload, path.join(__dirname, '..', 'src', 'project.js'), '--project', 'sharp'], { PROJECTS_DIR: tmp, APOLLO_API_KEY: 'test' });
  assert.match(out, /Kosmoderma Healthcare \(linkedin\)/);
  assert.match(out, /kept 3: Siva M - Head of Operations \(\d+, Tier 2\); Anu P - IT Manager \(\d+, Tier 2\); Chytra Anand - Founder & Chairperson \(\d+, Tier 3\)$/m, 'excluded doctor never used as filler');
  assert.match(out, /\[Ghost Co\] no Apollo organization matched/);
  assert.match(out, /\[Tiny Retail\] pre-screen failed: Employees 0 < 1/);

  const status = fs.readFileSync(path.join(tmp, 'sharp', 'companies-status.csv'), 'utf8');
  assert.match(status, /Kosmoderma Skin, Hair & Body Clinics.*,Done,.*Kosmoderma Healthcare,http:\/\/www.linkedin.com\/company\/kosmodermahealthcare,hospital & health care,129,"Bengaluru, Karnataka, India",3/);
  assert.match(status, /Ghost Co,.*Not in Apollo/);
  assert.match(status, /Tiny Retail,.*Pre-screen failed/);

  const rows = XLSX.utils.sheet_to_json(XLSX.read(fs.readFileSync(path.join(tmp, 'sharp', 'prospects.xlsx')), { type: 'buffer' }).Sheets.Prospects);
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].Name, 'Siva M');
  assert.strictEqual(rows[0].Function, 'operations');
  assert.strictEqual(rows[0].LinkedInURL, 'http://www.linkedin.com/in/siva');
  assert.ok(!rows[0]['Connections 500+'], 'manual columns left blank');
  assert.ok(!rows.find((r) => /Dermatologist|Developer/.test(r.Designation)), 'excluded titles never written');

  // Second run: nothing pending, nothing duplicated.
  const out2 = runCli(['-r', preload, path.join(__dirname, '..', 'src', 'project.js'), '--project', 'sharp'], { PROJECTS_DIR: tmp, APOLLO_API_KEY: 'test' });
  assert.match(out2, /Processing 0 companies/);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('PASS: project run against mocked Apollo');
})().catch((err) => { console.error('FAIL:', err.stack || err.message); process.exit(1); });
