# LeadStrategus Sales Navigator Scraper (standalone Playwright)

Takes a list of companies (a CSV/XLSX file, or a Google Sheet) and, for each
one, mirrors the manual Sales Navigator workflow: open the company's account
page (`/sales/company/<id>`), open its built-in **"Decision makers"** quick
search (under "Common searches"), scrape the resulting prospect list, qualify
each person with the Sharp SSDI rubric via OpenAI, and write the top ones out
as a CSV/XLSX (or to a Prospects sheet). Runs on its own — independent of the
n8n/PhantomBuster pipeline in `../n8n/`.

How each company is handled:

1. **Resolve the company id** from the `LinkedIn URL` column — the regular
   company page embeds LinkedIn's numeric company id, which is the same id
   Sales Navigator uses. Falls back to a Sales Navigator account search by
   `Company Name` if the URL isn't a company page (e.g. a personal profile
   URL was pasted by mistake).
2. **Open "Decision makers"** from the account page — Sales Navigator's own
   preset, which is Current company = this company + Seniority level
   Director / Vice President / CXO (filter ids 6, 7, 8, confirmed from the
   page's own link). The link's href is followed when present; otherwise the
   identical URL is built directly.
3. **Scrape the results** — each row's name, title, company, location,
   tenure, and full "About" text.
4. **Qualify with OpenAI** (if `OPENAI_API_KEY` is set) using the same Sharp
   SSDI Tier 1/2/3 prompt as the n8n pipeline, keep the top
   `TOP_N_PER_COMPANY` (default 4) by score. Without an OpenAI key, every
   decision maker is kept, unscored, as `Needs Review`.
5. **Write the prospects** with the same columns the n8n flow uses:
   `Company, Name, Designation, Seniority, LinkedInURL, Score, Priority,
   Reason, Activity, Status, Location, Tenure`. A profile URL already present
   is never written twice.

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

The result-row selectors were built from a real Sales Navigator "Decision
makers" page's DOM and are exercised by `npm test`, which runs
`scrapeSearchResults()` in a real Chromium against a fixture trimmed from
that page (`test/fixtures/search-results.html`), including LinkedIn's lazy
row rendering; the file import/export path is tested too. That does not
cover login, the account page, or LinkedIn changing its markup later — so
still do one watched local run before trusting it unattended (see "First
run").

## Input file

A `.csv`, `.xlsx` or `.xls` with a header row. Needed columns (header names
are matched loosely — `company`, `Company Name`, `LinkedIn`, `LinkedIn URL`,
`url` all work):

| Column | Notes |
|---|---|
| `Company Name` | Display name. Derived from the URL if missing. |
| `LinkedIn URL` | The company **page** URL, e.g. `https://www.linkedin.com/company/kosmodermahealthcare/`. Not a person's profile, not a Sales Navigator lead link. |
| `Status` | Optional. Rows already marked `Done` are skipped. |

Only the first sheet of a workbook is read. Re-uploading a file merges by
LinkedIn URL: new companies are added as pending, existing ones keep their
status, so you can keep one master list and re-upload it as it grows.

Statuses after a run: `Done` (prospects written), `No Matches` (Sales
Navigator lists no decision makers — not retried), `Error` (retried on later
runs, up to 3 attempts, then left with the reason in the `Error` column).

## Setup

1. `cd playwright-scraper && npm install && npm run install-browsers`
2. Copy `.env.example` to `.env` and fill in:
   - `LINKEDIN_LI_AT_COOKIE` — from your browser: DevTools → Application (or
     Storage) → Cookies → `https://www.linkedin.com` → `li_at` value. This
     expires periodically (LinkedIn rotates it) — if the script errors with
     "session cookie is invalid or expired", grab a fresh one the same way.
   - `OPENAI_API_KEY` — from platform.openai.com (a ChatGPT subscription does
     not include this). Optional; without it nothing is scored.
   - Leave `STORAGE_BACKEND=file`. (Set `sheets` plus the `GOOGLE_*` /
     `SPREADSHEET_ID` values only if you want the Google Sheets flow.)

## Running locally (CLI)

```
npm start -- --input companies.xlsx                       # writes prospects.xlsx next to it
npm start -- --input companies.csv --output out/prospects.csv
npm start                                                 # continues an earlier import
npm start -- --input companies.xlsx --limit 2             # just two companies this run
npm start -- --input companies.xlsx --replace             # discard the previous list first
```

Progress is kept in `data/state.json` (`DATA_DIR`), so a run interrupted
halfway resumes from the next pending company. Every run rewrites the output
file with **all** prospects collected so far, not just this run's.

### First run

1. Set `HEADLESS=false` and `DEBUG_SCRAPER=true` in `.env`.
2. `npm start -- --input companies.xlsx --limit 1` with a company you know
   has decision makers (Kosmoderma is a good one).
3. Watch the browser: it should land on the account page, then on a people
   search showing "Current company" and "Seniority level" filter pills. If
   it logs `found 0 matching prospects` while results are visible on screen,
   LinkedIn's markup has changed — send the saved `debug-<company>.png` and
   the page's HTML (right-click a result → Inspect → copy outer HTML of the
   `<li class="artdeco-list__item">`) so the selectors in
   `src/linkedin.js` can be updated.
4. Once it works, set `HEADLESS=true` and `DEBUG_SCRAPER=false`.

**Do this locally before deploying to Render** — Render has no display, so
`HEADLESS=false` isn't usable there.

## Running on a schedule

### Option A — local cron (needs a machine that's always on)

- Linux/macOS: `crontab -e`, e.g. `0 */4 * * * cd /path/to/playwright-scraper && npm start >> run.log 2>&1`
- Windows: Task Scheduler running `npm start` in this directory.

Drop new companies into the same input file and re-run; already-Done ones
are skipped.

### Option B — Render (free tier)

Render's **free tier only supports Web Services** (Background Workers and
Cron Jobs need a paid plan), and a free Web Service **sleeps after 15
minutes idle**, waking only on an incoming HTTP request. So this deploys as
an HTTP server (`src/server.js`): a small page at `/` to upload the companies
file and download results, plus a `/run` endpoint woken periodically by an
external pinger — the same pattern this project's n8n deployment already
uses to keep itself alive.

**Two things to know before choosing Render:**

- **Memory.** Chromium is memory-heavy, and Render's free plan gives 512MB
  RAM total — the n8n deployment in this repo already hit `JavaScript heap
  out of memory` at that limit with no browser involved. `NODE_OPTIONS`,
  `--disable-dev-shm-usage` and one-company-per-run are set up to keep the
  footprint down, but this may still OOM under real load. If it does, the
  paid tier (~$7/mo, more RAM) is the fallback.
- **No persistent disk.** Uploaded companies and collected prospects live in
  the running container (`DATA_DIR`). They survive between pings, but a
  redeploy, crash or restart starts empty — **download results regularly**
  (`/download`), and keep your master companies file so re-uploading is a
  one-click recovery. If durability matters more than avoiding Google setup,
  use `STORAGE_BACKEND=sheets` instead.

Setup:

1. **Render** → New + → **Web Service** → connect this repo. Set **Root
   Directory** to `playwright-scraper`, runtime **Docker**, instance type
   **Free**. The Dockerfile uses Playwright's official base image (Chromium +
   OS deps preinstalled). Advanced → Health Check Path `/healthz`.
2. Environment variables — secrets:
   - `LINKEDIN_LI_AT_COOKIE`
   - `OPENAI_API_KEY`
   - `RUN_TOKEN` — any random string (e.g. `openssl rand -hex 16`). This
     protects every endpoint except `/healthz`; without it your URL is open
     to anyone.

   Settings (all optional, these are the recommended values):
   `NODE_OPTIONS=--max-old-space-size=400`, `STORAGE_BACKEND=file`,
   `DATA_DIR=/app/data`, `COMPANIES_PER_RUN=1`, `MAX_PROSPECTS_PER_COMPANY=15`,
   `TOP_N_PER_COMPANY=4`, `AUTO_APPROVE_SCORE=70`, `MIN_RUN_INTERVAL_MS=300000`.
   Do not set `PORT` — Render sets it.
3. Deploy. The first build pulls a ~1.5 GB image; expect 5–10 minutes.
   You're live when the log shows `Scraper server listening`.
4. Open `https://<your-service>.onrender.com/?token=<RUN_TOKEN>` — upload
   your companies file, click **Run now** for the first company, watch the
   Render log, then **Prospects .xlsx** to download.
5. Set up a free external pinger (cron-job.org or UptimeRobot) to hit
   `https://<your-service>.onrender.com/run?token=<RUN_TOKEN>` **every
   15 minutes**. Each call processes `COMPANIES_PER_RUN` companies (default
   1); when nothing is pending it returns `nothing_pending` and does nothing.
   A call arriving within `MIN_RUN_INTERVAL_MS` of the previous run gets a
   `429 cooldown` — that's the overlap guard, not an error.

Endpoints (all need `?token=` except `/healthz`):

| Route | What it does |
|---|---|
| `GET /` | Control page: upload, run, status, download, reset |
| `POST /upload?filename=x.xlsx[&replace=1]` | Body = the raw file. Merges into the list (or replaces it) |
| `GET /run` | Starts a run in the background (`202 started`) |
| `GET /status` | Counts (pending/done/error/prospects), last run summary |
| `GET /download?format=xlsx\|csv[&what=companies]` | Prospects (default) or the companies list with statuses |
| `POST /reset` | Clears everything |
| `GET /healthz` | Render's health check, no token |

### Production behavior worth knowing

- **One company per `/run` call by default** (`COMPANIES_PER_RUN=1`) — bounds
  peak memory and request duration on a 512MB host. Raise it only if you've
  confirmed headroom (check Render's metrics dashboard after a few runs).
- **Navigation timeout + retry**: each page load gets `NAVIGATION_TIMEOUT_MS`
  (default 30s) before it's treated as failed, and transient failures retry
  once (`MAX_RETRIES_PER_COMPANY`) before marking a company `Error`. A
  LinkedIn login/checkpoint page is never retried — that means your session
  cookie expired or got challenged, and retrying can't fix that.
- **Graceful shutdown**: on Render's redeploy/restart, the server gets
  `SIGTERM` and waits up to 60s for an in-flight run to finish (closing the
  browser cleanly) before exiting, instead of getting killed mid-write.
- **Run-interval cooldown**: `MIN_RUN_INTERVAL_MS` rejects overlapping or
  back-to-back triggers even if your pinger is misconfigured to fire too
  often — protects both your Render memory and LinkedIn's rate limits.

## Google Sheets backend (optional)

Set `STORAGE_BACKEND=sheets`, `SPREADSHEET_ID`, and either
`GOOGLE_SERVICE_ACCOUNT_KEY_PATH` (local) or `GOOGLE_SERVICE_ACCOUNT_KEY_JSON`
(Render — paste the key file's JSON as one line). Share the sheet (Editor)
with the service account's email. The `Companies` tab needs `Company Name`,
`LinkedIn URL`, `Status`, `Error` headers; prospects go to `Prospects` by
header name; an optional `RunLog` tab (`StartedAt, FinishedAt,
CompaniesProcessed, TotalProspects, FatalError, ErrorCompanies`) gets one row
per run. Uploads/downloads at `/` are not available in this mode.

## What this doesn't do (yet)

- No CAPTCHA/verification-challenge handling — if LinkedIn interrupts the
  session with a checkpoint, the script will fail with the "session cookie
  invalid" error above; you'll need to resolve the checkpoint manually in a
  real browser and grab a fresh cookie.
