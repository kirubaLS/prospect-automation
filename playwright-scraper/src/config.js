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
  maxProspectsPerCompany: parseInt(process.env.MAX_PROSPECTS_PER_COMPANY || '25', 10),
  minDelayMs: parseInt(process.env.MIN_DELAY_MS || '2000', 10),
  maxDelayMs: parseInt(process.env.MAX_DELAY_MS || '5000', 10),
  headless: process.env.HEADLESS !== 'false',
  debug: process.env.DEBUG_SCRAPER === 'true',
  navigationTimeoutMs: parseInt(process.env.NAVIGATION_TIMEOUT_MS || '30000', 10),
  maxRetriesPerCompany: parseInt(process.env.MAX_RETRIES_PER_COMPANY || '1', 10),
  // Optional - appends one summary row per run to this sheet tab if set, so
  // run history survives Render's free tier having no persistent disk/logs
  // retention. Unset = skip (no separate sheet required).
  runLogSheetName: process.env.RUN_LOG_SHEET_NAME || null,

  // --- OpenAI qualification (Sharp SSDI rubric) ---
  // Optional: with no key set, every scraped decision maker is written
  // unscored as "Needs Review" instead of being ranked.
  openAiApiKey: process.env.OPENAI_API_KEY || null,
  openAiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  topNPerCompany: parseInt(process.env.TOP_N_PER_COMPANY || '4', 10),
  autoApproveScore: parseInt(process.env.AUTO_APPROVE_SCORE || '70', 10),

  // --- HTTP server mode (Render deploy) - see src/server.js ---
  port: parseInt(process.env.PORT || '3000', 10),
  runToken: process.env.RUN_TOKEN || null,
  // Bounds memory/duration per /run call on a constrained host: each
  // invocation processes at most this many companies, not the whole
  // pending list. Ping /run more often (e.g. every 15-20 min) to work
  // through a larger backlog instead of raising this.
  companiesPerRun: parseInt(process.env.COMPANIES_PER_RUN || '1', 10),
  // Rejects a /run call that arrives before the previous run finished this
  // long ago - protects against a misconfigured/duplicate external pinger
  // triggering overlapping or back-to-back LinkedIn sessions.
  minRunIntervalMs: parseInt(process.env.MIN_RUN_INTERVAL_MS || '300000', 10)
};
