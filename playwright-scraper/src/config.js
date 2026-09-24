require('dotenv').config();

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name} (see .env.example)`);
  return value;
}

// Render's free tier has no persistent disk to keep a service-account.json
// file across deploys/restarts, so the key can also be supplied as a raw
// JSON string env var (GOOGLE_SERVICE_ACCOUNT_KEY_JSON) instead of a file
// path (GOOGLE_SERVICE_ACCOUNT_KEY_PATH, still supported for local dev).
if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH && !process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON) {
  throw new Error('Set either GOOGLE_SERVICE_ACCOUNT_KEY_PATH or GOOGLE_SERVICE_ACCOUNT_KEY_JSON (see .env.example)');
}

module.exports = {
  liAtCookie: requireEnv('LINKEDIN_LI_AT_COOKIE'),
  userAgent:
    process.env.LINKEDIN_USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  googleServiceAccountKeyPath: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || null,
  googleServiceAccountKeyJson: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON || null,
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
  debug: process.env.DEBUG_SCRAPER === 'true',
  // HTTP server mode (Render deploy) - see src/server.js
  port: parseInt(process.env.PORT || '3000', 10),
  runToken: process.env.RUN_TOKEN || null
};
