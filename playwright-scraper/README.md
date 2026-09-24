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

**Do the selector tuning above locally before deploying to Render** — Render
has no display, so `HEADLESS=false` isn't usable there. Get it working
reliably on your machine first; the deployed version just repeats the same
logic on a schedule.

## Running on a schedule

Two ways to run this repeatedly, pick one:

### Option A — local cron (simplest, needs a machine that's always on)

This is a plain Node script — schedule it with your OS's own scheduler
rather than building scheduling into the script itself:

- Linux/macOS: `crontab -e`, e.g. `0 */4 * * * cd /path/to/playwright-scraper && npm start >> run.log 2>&1`
- Windows: Task Scheduler running `npm start` in this directory.

### Option B — Render (free tier)

Render's **free tier only supports Web Services** (Background Workers and
Cron Jobs need a paid plan), and a free Web Service **sleeps after 15
minutes idle**, waking only on an incoming HTTP request. So this deploys as
an HTTP server (`src/server.js`) with a `/run` endpoint, woken periodically
by an external pinger — the same pattern this project's n8n deployment
already uses to keep itself alive.

**Read this before choosing Render:** Chromium is memory-heavy, and
Render's free plan gives **512MB RAM total** — the n8n deployment in this
same repo already hit `JavaScript heap out of memory` at that limit running
Node alone, before adding a browser into the mix. `NODE_OPTIONS`,
`--disable-dev-shm-usage`, and processing one company at a time (never
parallel) are already set up to reduce the footprint, but there's a real
chance this still OOMs under real-world load on the free tier. If it does,
Render's paid tier (~$7/mo, more RAM) or a host with more free RAM (e.g.
Oracle Cloud's Always Free ARM VM) are the fallback options — same trade-off
noted in the n8n README.

Setup:

1. **Render** → New → Blueprint → connect this repo → point it at
   `playwright-scraper/render.yaml` → Deploy Blueprint. This builds from
   `playwright-scraper/Dockerfile`, which uses Playwright's official base
   image (Chromium + OS deps preinstalled) so there's nothing extra to
   configure at the OS level.
2. In the Render dashboard, set the `sync: false` env vars manually (never
   commit these):
   - `LINKEDIN_LI_AT_COOKIE`
   - `GOOGLE_SERVICE_ACCOUNT_KEY_JSON` — paste the entire service account
     key file's JSON content as one line (Render has no persistent disk for
     a key file, so this replaces `GOOGLE_SERVICE_ACCOUNT_KEY_PATH`).
   - `SPREADSHEET_ID`
   - `RUN_TOKEN` — any random string you generate (e.g.
     `openssl rand -hex 16`). This is the shared secret that authorizes
     `/run` and `/status` — without it those endpoints are open to anyone
     with your Render URL.
3. Set up a free external pinger (cron-job.org or UptimeRobot) to hit
   `https://<your-service>.onrender.com/run?token=<RUN_TOKEN>` on whatever
   interval you want scrapes to run — e.g. every 4 hours. Each ping starts
   one full pass over pending companies and returns immediately (`202
   Accepted`); check progress via
   `https://<your-service>.onrender.com/status?token=<RUN_TOKEN>`, which
   also survives the pinger's own request timing out (the scrape itself
   keeps running in the background either way).
4. `GET /healthz` (no token needed) is what Render's own health check polls
   to confirm the service booted — set as `healthCheckPath` in
   `render.yaml` already.

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
