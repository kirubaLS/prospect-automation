const { google } = require('googleapis');
const config = require('./config');

let cachedClient = null;

async function getSheetsClient() {
  if (cachedClient) return cachedClient;
  const authOptions = { scopes: ['https://www.googleapis.com/auth/spreadsheets'] };
  if (config.googleServiceAccountKeyJson) {
    authOptions.credentials = JSON.parse(config.googleServiceAccountKeyJson);
  } else {
    authOptions.keyFile = config.googleServiceAccountKeyPath;
  }
  const auth = new google.auth.GoogleAuth(authOptions);
  const client = await auth.getClient();
  cachedClient = google.sheets({ version: 'v4', auth: client });
  return cachedClient;
}

function columnLetter(index) {
  let letter = '';
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

function rowsToObjects(rows) {
  if (!rows || rows.length === 0) return [];
  const headers = rows[0].map((h) => (h || '').trim());
  return rows.slice(1).map((row, idx) => {
    const obj = { _rowNumber: idx + 2 };
    headers.forEach((h, i) => {
      obj[h] = row[i] !== undefined ? row[i] : '';
    });
    return obj;
  });
}

async function getHeaderMap() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId,
    range: `${config.companiesSheetName}!1:1`
  });
  const headers = (res.data.values && res.data.values[0]) || [];
  const map = {};
  headers.forEach((h, i) => {
    map[(h || '').trim()] = i;
  });
  return map;
}

async function getPendingCompanies() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId,
    range: `${config.companiesSheetName}!A:Z`
  });
  const companies = rowsToObjects(res.data.values);
  // "Done" and "No Matches" are terminal; "Error" rows are retried each run.
  return companies.filter((c) => {
    const s = (c.Status || '').trim().toLowerCase();
    return s !== 'done' && s !== 'no matches' && (c['Company Name'] || '').trim() !== '';
  });
}

// Same column set the n8n pipeline writes, so both can share one Prospects tab.
const DEFAULT_PROSPECT_HEADERS = [
  'Company', 'Name', 'Designation', 'Seniority', 'LinkedInURL', 'Score', 'Priority', 'Reason', 'Activity', 'Status', 'Location'
];

// Header name -> prospect field. Written by header position so the sheet's
// column order can change freely; unknown headers are left blank.
const PROSPECT_FIELD_BY_HEADER = {
  company: 'company',
  name: 'name',
  designation: 'title',
  title: 'title',
  seniority: 'seniority',
  linkedinurl: 'profileUrl',
  profileurl: 'profileUrl',
  score: 'score',
  priority: 'priority',
  reason: 'reason',
  activity: 'activity',
  status: 'status',
  location: 'location',
  tenure: 'tenure'
};

function normalizeHeader(h) {
  return (h || '').toLowerCase().replace(/[^a-z]/g, '');
}

// Appends rows to the Prospects sheet, skipping any profile URL already
// present (mirrors n8n's appendOrUpdate-by-LinkedInURL, without ever
// overwriting a row a human may have edited). Returns how many were written.
async function appendProspects(rows) {
  if (rows.length === 0) return 0;
  const sheets = await getSheetsClient();

  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId,
    range: `${config.prospectsSheetName}!A:Z`
  });
  let allRows = existing.data.values || [];
  let headers = allRows[0] || [];

  if (headers.length === 0) {
    headers = DEFAULT_PROSPECT_HEADERS;
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.spreadsheetId,
      range: `${config.prospectsSheetName}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [headers] }
    });
    allRows = [headers];
  }

  const urlCol = headers.findIndex((h) => ['linkedinurl', 'profileurl'].includes(normalizeHeader(h)));
  const seen = new Set(
    urlCol >= 0 ? allRows.slice(1).map((r) => (r[urlCol] || '').trim()).filter(Boolean) : []
  );

  const values = rows
    .filter((r) => !seen.has(r.profileUrl))
    .map((r) =>
      headers.map((h) => {
        const field = PROSPECT_FIELD_BY_HEADER[normalizeHeader(h)];
        const v = field ? r[field] : '';
        return v === undefined || v === null ? '' : v;
      })
    );
  if (values.length === 0) return 0;

  await sheets.spreadsheets.values.append({
    spreadsheetId: config.spreadsheetId,
    range: `${config.prospectsSheetName}!A:${columnLetter(headers.length - 1)}`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values }
  });
  return values.length;
}

async function updateCompanyStatus(rowNumber, status, error = '') {
  const sheets = await getSheetsClient();
  const headerMap = await getHeaderMap();
  if (headerMap['Status'] === undefined) {
    throw new Error(`Companies sheet has no "Status" column (checked header row of ${config.companiesSheetName})`);
  }
  const statusCol = columnLetter(headerMap['Status']);
  await sheets.spreadsheets.values.update({
    spreadsheetId: config.spreadsheetId,
    range: `${config.companiesSheetName}!${statusCol}${rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[status]] }
  });

  if (error && headerMap['Error'] !== undefined) {
    const errorCol = columnLetter(headerMap['Error']);
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.spreadsheetId,
      range: `${config.companiesSheetName}!${errorCol}${rowNumber}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[error]] }
    });
  }
}

// Best-effort persistent run history, since Render's free tier keeps no
// disk/log retention across restarts - the sheet is the durable record.
// No-ops (doesn't throw) if RUN_LOG_SHEET_NAME isn't configured; the caller
// still wraps this in its own try/catch since a missing/misnamed tab in
// Sheets should never fail the actual scrape run.
async function appendRunLog(summary) {
  if (!config.runLogSheetName) return;
  const sheets = await getSheetsClient();
  const errorCompanies = summary.results.filter((r) => r.status === 'error').map((r) => r.company).join('; ');
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.spreadsheetId,
    range: `${config.runLogSheetName}!A:F`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [
        [
          summary.startedAt,
          summary.finishedAt,
          summary.companiesProcessed,
          summary.totalProspects,
          summary.fatalError || '',
          errorCompanies
        ]
      ]
    }
  });
}

module.exports = { getPendingCompanies, appendProspects, updateCompanyStatus, appendRunLog };
