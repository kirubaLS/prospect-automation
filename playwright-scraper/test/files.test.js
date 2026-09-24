// File backend: CSV/XLSX parsing with loose headers, status tracking, and
// export round-trips.   node test/files.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const XLSX = require('xlsx');

process.env.LINKEDIN_LI_AT_COOKIE ||= 'test';
process.env.STORAGE_BACKEND = 'file';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scraper-test-'));

const files = require('../src/files');
const store = require('../src/filestore');

(async () => {
  // CSV with unusual-but-reasonable headers and a blank line.
  const csv = Buffer.from(
    'company,LinkedIn,status\n' +
      'IVF Access,https://www.linkedin.com/company/ivf-access/?originalSubdomain=in,\n' +
      '"Kosmoderma Skin, Hair & Body Clinics",https://www.linkedin.com/company/kosmodermahealthcare/,\n' +
      ',,\n' +
      'Already Done Co,https://www.linkedin.com/company/done-co/,Done\n'
  );
  const parsed = files.parseCompaniesFile(csv, 'companies.csv');
  assert.strictEqual(parsed.length, 3, 'blank row skipped');
  assert.strictEqual(parsed[1]['Company Name'], 'Kosmoderma Skin, Hair & Body Clinics', 'quoted comma preserved');
  assert.strictEqual(parsed[0]['LinkedIn URL'], 'https://www.linkedin.com/company/ivf-access/?originalSubdomain=in');
  assert.strictEqual(parsed[2].Status, 'Done');

  // XLSX with canonical headers, plus a URL-only row.
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet([
      { 'Company Name': 'GTS Transportation Corp', 'LinkedIn URL': 'https://www.linkedin.com/company/gts-transportation-corp/' },
      { 'Company Name': '', 'LinkedIn URL': 'https://www.linkedin.com/company/only-url-co/' }
    ]),
    'Sheet1'
  );
  const xlsxParsed = files.parseCompaniesFile(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), 'companies.xlsx');
  assert.strictEqual(xlsxParsed.length, 2);
  assert.strictEqual(xlsxParsed[1]['Company Name'], 'only-url-co', 'name derived from URL slug');

  assert.throws(() => files.parseCompaniesFile(Buffer.from('foo,bar\n1,2\n'), 'x.csv'), /No companies found/);

  // Store: import, pending, status updates, merge semantics.
  let info = store.importCompanies(csv, 'companies.csv');
  assert.deepStrictEqual([info.added, info.total, info.pending], [3, 3, 2], 'Done row not pending');
  let pending = await store.getPendingCompanies();
  assert.deepStrictEqual(
    pending.map((c) => c['Company Name']),
    ['IVF Access', 'Kosmoderma Skin, Hair & Body Clinics']
  );

  await store.updateCompanyStatus(pending[0]._rowNumber, 'Done');
  await store.updateCompanyStatus(pending[1]._rowNumber, 'Error', 'boom');
  pending = await store.getPendingCompanies();
  assert.strictEqual(pending.length, 1, 'Error rows stay pending for retry; Done rows drop out');

  info = store.importCompanies(csv, 'companies.csv'); // re-upload same file
  assert.deepStrictEqual([info.added, info.updated], [0, 3], 're-upload merges instead of duplicating');
  assert.strictEqual((await store.getPendingCompanies()).length, 1, 'existing statuses kept on merge');

  const written = await store.appendProspects([
    { company: 'IVF Access', name: 'A', title: 'CIO', profileUrl: 'https://www.linkedin.com/sales/lead/1', score: 95, priority: 'Tier 1', status: 'Auto-Approved' },
    { company: 'IVF Access', name: 'B', title: 'COO', profileUrl: 'https://www.linkedin.com/sales/lead/2', score: 75, priority: 'Tier 2', status: 'Auto-Approved' },
    { company: 'IVF Access', name: 'A again', title: 'CIO', profileUrl: 'https://www.linkedin.com/sales/lead/1', score: 95 }
  ]);
  assert.strictEqual(written, 2, 'duplicate profile URL skipped');

  // Export round-trip: CSV and XLSX both re-parse to the same rows.
  const csvOut = files.exportProspects(store.getProspects(), 'csv').toString('utf8');
  assert.ok(csvOut.startsWith('Company,Name,Designation,Seniority,LinkedInURL,Score,Priority,Reason,Activity,Status,Location,Tenure'));
  const xlsxOut = files.exportProspects(store.getProspects(), 'xlsx');
  const back = XLSX.utils.sheet_to_json(XLSX.read(xlsxOut, { type: 'buffer' }).Sheets.Prospects);
  assert.strictEqual(back.length, 2);
  assert.strictEqual(back[0].Designation, 'CIO');
  assert.strictEqual(back[0].Score, 95);

  const companiesOut = files.exportCompanies(store.getCompanies(), 'csv').toString('utf8');
  assert.ok(companiesOut.includes('Kosmoderma Skin, Hair & Body Clinics'));
  assert.ok(companiesOut.includes('Error,boom'));

  // Persistence: a fresh require of the store reloads state.json.
  delete require.cache[require.resolve('../src/filestore')];
  const reloaded = require('../src/filestore');
  assert.strictEqual(reloaded.snapshot().prospects, 2, 'state persisted to DATA_DIR');
  assert.deepStrictEqual(reloaded.snapshot(), { ...reloaded.snapshot(), companies: 3, done: 2, error: 1, pending: 1, givenUp: 0 });

  // Error retry cap: after MAX attempts the row stops being pending.
  const errRow = (await reloaded.getPendingCompanies())[0];
  await reloaded.updateCompanyStatus(errRow._rowNumber, 'Error', 'still broken');
  await reloaded.updateCompanyStatus(errRow._rowNumber, 'Error', 'still broken');
  assert.strictEqual((await reloaded.getPendingCompanies()).length, 0, 'gave up after 3 error attempts');
  assert.strictEqual(reloaded.snapshot().givenUp, 1);
  assert.match(reloaded.getCompanies()[errRow._rowNumber - 1].Error, /gave up after 3 attempts/);

  // "No Matches" is terminal too.
  reloaded.importCompanies(Buffer.from('Company Name,LinkedIn URL\nNoOne Ltd,https://www.linkedin.com/company/noone/\n'), 'more.csv');
  const nm = (await reloaded.getPendingCompanies())[0];
  await reloaded.updateCompanyStatus(nm._rowNumber, 'No Matches');
  assert.strictEqual((await reloaded.getPendingCompanies()).length, 0, 'No Matches rows are not re-scraped');

  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  console.log('PASS: files + filestore');
})().catch((err) => {
  console.error('FAIL:', err.stack || err.message);
  process.exit(1);
});
