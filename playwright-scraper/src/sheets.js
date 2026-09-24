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
  return companies.filter(
    (c) => (c.Status || '').trim().toLowerCase() !== 'done' && (c['Company Name'] || '').trim() !== ''
  );
}

async function appendProspects(rows) {
  if (rows.length === 0) return;
  const sheets = await getSheetsClient();
  const values = rows.map((r) => [r.company, r.name, r.title, r.profileUrl, r.location, r.status || 'New']);
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.spreadsheetId,
    range: `${config.prospectsSheetName}!A:F`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values }
  });
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
