# LeadStrategus Sales Navigator Scraper (standalone Playwright)

Reads companies from a Google Sheet, for each one opens LinkedIn Sales
Navigator, applies a title/seniority filter scoped to that company, scrapes
the matching prospects, and writes them to a Prospects sheet. Runs on its
own — independent of the n8n/PhantomBuster pipeline in `../n8n/`.

## Read this before running it

This automates your own logged-in Sales Navigator session with a headless
browser. LinkedIn's User Agreement prohibits automated scraping, including
through Sales Navigator, regardless of tool — this carries a real risk of
account restriction or suspension. That risk exists with PhantomBuster too
(this is the same category of action, just self-hosted instead of run by a
vendor who absorbs some of that risk for you). Pacing is built in
(`MIN_DELAY_MS`/`MAX_DELAY_MS`) to keep requests at a reasonable, non-abusive
rate — this is not designed to evade LinkedIn's bot detection, just to avoid
hammering their servers.

**I could not test this against a real authenticated Sales Navigator
session** — I don't have and shouldn't be given your session cookie. The
CSS selectors in `src/linkedin.js`'s `scrapeSearchResults()` target
commonly-documented Sales Navigator markup, but LinkedIn's DOM changes
periodically and can vary by account/plan. **Expect to tune selectors on
your first real run** — see "First run / selector tuning" below.

## Setup

1. `cd playwright-scraper && npm install && npm run install-browsers`
2. Copy `.env.example` to `.env` and fill in:
   - `LINKEDIN_LI_AT_COOKIE` — from your browser: DevTools → Application (or
     Storage) → Cookies → `https://www.linkedin.com` → `li_at` value. This
     expires periodically (LinkedIn rotates it) — if the script errors with
     "session cookie is invalid or expired", grab a fresh one the same way.
   - `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` — a Google Cloud service account JSON
     key with the Sheets API enabled. Share your target Google Sheet
     (Editor access) with that service account's email address
     (`xxx@xxx.iam.gserviceaccount.com`) or writes will fail with a
     permission error.
   - `SPREADSHEET_ID` — from your sheet's URL:
     `docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit`.
   - `TITLE_KEYWORDS` — defaults to the Sharp SSDI Tier 1/2 titles (CIO, IT
     Head, COO, Procurement Head, etc.) as an OR-boolean string, matching
     Sales Navigator's own keyword search syntax. Edit for other clients.
3. Companies sheet needs at least `Company Name` and `Status` columns
   (matches the columns already used by the n8n pipeline). Rows with
   `Status = Done` are skipped.

## First run / selector tuning

1. Set `HEADLESS=false` and `DEBUG_SCRAPER=true` in `.env`.
2. `npm start` with just one or two companies in the sheet.
3. Watch the browser window as it searches. If `scrapeSearchResults` logs
   `found 0 matching prospects` but you can see results on screen, the
   selectors in `src/linkedin.js` need adjusting:
   - Open the saved `debug-<company>.png` screenshot, or right-click a
     result card in the live browser → Inspect.
   - Update the `cardSelector` and the `data-anonymize="..."` locators near
     the top of `scrapeSearchResults()` to match what you actually see.
4. Once it reliably finds real prospects for your test companies, set
   `HEADLESS=true` and `DEBUG_SCRAPER=false` for normal runs.

## Running on a schedule

This is a plain Node script — schedule it with your OS's own scheduler
rather than building scheduling into the script itself:

- Linux/macOS: `crontab -e`, e.g. `0 */4 * * * cd /path/to/playwright-scraper && npm start >> run.log 2>&1`
- Windows: Task Scheduler running `npm start` in this directory.

## Output

Each matching prospect is appended to the `Prospects` sheet as one row:
`Company, Name, Title, ProfileUrl, Location, Status`. Each processed company
in the `Companies` sheet gets its `Status` column updated to `Done`,
`No Matches`, or `Error` (with a message in the `Error` column if present),
so re-runs only pick up companies not yet processed — same resumability
model as the n8n pipeline.

## What this doesn't do (yet)

- No LLM scoring/tiering step — Sales Navigator's own title/seniority filter
  is the qualification mechanism here, not a downstream rubric. Add one back
  in (reusing the OpenAI prompt from `../n8n/02-ingest-webhook.json`) if you
  want ranked/tiered output instead of a flat prospect list.
- No CAPTCHA/verification-challenge handling — if LinkedIn interrupts the
  session with a checkpoint, the script will fail with the "session cookie
  invalid" error above; you'll need to resolve the checkpoint manually in a
  real browser and grab a fresh cookie.
