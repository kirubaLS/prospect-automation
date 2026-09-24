require('dotenv').config();

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name} (see .env.example)`);
  return value;
}

module.exports = {
  liAtCookie: requireEnv('LINKEDIN_LI_AT_COOKIE'),
  userAgent:
    process.env.LINKEDIN_USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  googleServiceAccountKeyPath: requireEnv('GOOGLE_SERVICE_ACCOUNT_KEY_PATH'),
  spreadsheetId: requireEnv('SPREADSHEET_ID'),
  companiesSheetName: process.env.COMPANIES_SHEET_NAME || 'Companies',
  prospectsSheetName: process.env.PROSPECTS_SHEET_NAME || 'Prospects',
  titleKeywords:
    process.env.TITLE_KEYWORDS ||
    'CIO OR "Chief Information Officer" OR "IT Head" OR "Head of IT" OR "IT Director" OR "VP IT" OR COO OR "Head of Procurement" OR "Procurement Director" OR "IT Manager"',
  maxProspectsPerCompany: parseInt(process.env.MAX_PROSPECTS_PER_COMPANY || '25', 10),
  minDelayMs: parseInt(process.env.MIN_DELAY_MS || '2000', 10),
  maxDelayMs: parseInt(process.env.MAX_DELAY_MS || '5000', 10),
  headless: process.env.HEADLESS !== 'false',
  debug: process.env.DEBUG_SCRAPER === 'true'
};
