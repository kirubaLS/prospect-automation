const XLSX = require('xlsx');

// Accepts the header spellings people actually use in a companies file.
const COMPANY_HEADER_ALIASES = {
  'Company Name': ['company name', 'company', 'name', 'account', 'account name', 'organisation', 'organization'],
  'LinkedIn URL': ['linkedin url', 'linkedin', 'url', 'company url', 'linkedin company url', 'link', 'website'],
  Status: ['status', 'state'],
  Error: ['error', 'notes', 'note']
};

const PROSPECT_COLUMNS = [
  'Company', 'Name', 'Designation', 'Seniority', 'LinkedInURL', 'Score', 'Priority', 'Reason', 'Activity', 'Status', 'Location', 'Tenure'
];

function normalize(h) {
  return String(h || '').trim().toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ');
}

function canonicalHeader(h) {
  const n = normalize(h);
  for (const [canon, aliases] of Object.entries(COMPANY_HEADER_ALIASES)) {
    if (aliases.includes(n)) return canon;
  }
  return String(h || '').trim();
}

// Parses a CSV or XLSX/XLS buffer into company rows with canonical headers.
// The first sheet of a workbook is used. Throws if no usable company column.
function parseCompaniesFile(buffer, filename = '') {
  const workbook = XLSX.read(buffer, { type: 'buffer', raw: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error(`No sheets found in ${filename || 'file'}`);
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });

  const companies = rows
    .map((row) => {
      const out = { 'Company Name': '', 'LinkedIn URL': '', Status: '', Error: '' };
      for (const [key, value] of Object.entries(row)) {
        const canon = canonicalHeader(key);
        if (canon in out && value !== '' && out[canon] === '') out[canon] = String(value).trim();
      }
      return out;
    })
    .filter((c) => c['Company Name'] || c['LinkedIn URL']);

  if (companies.length === 0) {
    throw new Error(
      `No companies found in ${filename || 'file'} - need a "Company Name" and/or "LinkedIn URL" column (first sheet, header in row 1)`
    );
  }
  // A row with only a URL still needs a display name for the sheet/log.
  for (const c of companies) {
    if (!c['Company Name']) c['Company Name'] = c['LinkedIn URL'].replace(/\/+$/, '').split('/').pop();
  }
  return companies;
}

function toRow(p) {
  return {
    Company: p.company || '',
    Name: p.name || '',
    Designation: p.title || '',
    Seniority: p.seniority || '',
    LinkedInURL: p.profileUrl || '',
    Score: p.score ?? '',
    Priority: p.priority || '',
    Reason: p.reason || '',
    Activity: p.activity || 'Unknown',
    Status: p.status || '',
    Location: p.location || '',
    Tenure: p.tenure || ''
  };
}

// Builds a downloadable results file. format: 'csv' | 'xlsx'.
function exportProspects(prospects, format = 'csv') {
  const sheet = XLSX.utils.json_to_sheet(prospects.map(toRow), { header: PROSPECT_COLUMNS });
  if (format === 'xlsx') {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, 'Prospects');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  }
  return Buffer.from(XLSX.utils.sheet_to_csv(sheet), 'utf8');
}

// Companies with their current Status/Error, for a progress download.
function exportCompanies(companies, format = 'csv') {
  const sheet = XLSX.utils.json_to_sheet(
    companies.map((c) => ({
      'Company Name': c['Company Name'],
      'LinkedIn URL': c['LinkedIn URL'],
      Status: c.Status || '',
      Error: c.Error || '',
      Attempts: c.Attempts || 0,
      UpdatedAt: c.UpdatedAt || ''
    })),
    { header: ['Company Name', 'LinkedIn URL', 'Status', 'Error', 'Attempts', 'UpdatedAt'] }
  );
  if (format === 'xlsx') {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, 'Companies');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  }
  return Buffer.from(XLSX.utils.sheet_to_csv(sheet), 'utf8');
}

function formatFromName(name = '') {
  return /\.xlsx?$/i.test(name) ? 'xlsx' : 'csv';
}

module.exports = { parseCompaniesFile, exportProspects, exportCompanies, formatFromName, PROSPECT_COLUMNS };
