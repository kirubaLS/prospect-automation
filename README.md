# Prospect Automation — n8n on Render + PhantomBuster + Groq

LeadStrategus AI Prospect Research Agent implementation. Automates the
company → decision-maker → qualified-prospect pipeline: PhantomBuster runs
the Sales Navigator scraping (your own logged-in seat), n8n orchestrates,
Groq (free tier, `llama-3.3-70b-versatile`) scores candidates against the
ICP rubric, results land in Google Sheets.

## What's here

- `render.yaml` — Blueprint for deploying n8n + a free Postgres database on Render (free tier, no credit card). Postgres gives n8n persistent storage so workflows/credentials survive Render's free-tier restarts.
- `n8n/01-kickoff.json` — launches PhantomBuster's Sales Navigator Account Employees Export agent **once per schedule tick**, pointing it directly at the Companies Google Sheet as its input list (this phantom processes a whole spreadsheet of company URLs in one run — it isn't launched per-company).
- `n8n/02-ingest-webhook.json` — receives PhantomBuster's completion webhook, fetches the scraped candidates, scores each with Groq against the Sharp SSDI Tier 1/2/3 rubric, writes results to the Prospects sheet.

## Deploy

1. **Render** → New → Blueprint → connect this repo → Deploy Blueprint. This provisions the n8n web service and its Postgres database together.
2. In the Render dashboard, set the `sync: false` env vars manually (never commit these to this repo):
   - `N8N_BASIC_AUTH_USER` / `N8N_BASIC_AUTH_PASSWORD`
   - `N8N_ENCRYPTION_KEY` — **required**, generate once with `openssl rand -hex 32` and set it before n8n's first successful boot. Render's free web service has no persistent disk, so n8n's own auto-generated key gets thrown away on every restart while the Postgres database (which *is* persistent) keeps data encrypted with whatever key was active when it was written. Without a fixed key, every restart mismatches the two and n8n crash-loops with `Deployment key 'signing.hmac' cannot be read with this instance encryption key`. Set this once, never change it afterward — changing it later makes all previously stored credentials/workflow secrets unreadable.
3. Set up a free keep-alive ping (cron-job.org or UptimeRobot) hitting your `*.onrender.com` URL every ~10 minutes, since Render's free tier sleeps after 15 minutes idle otherwise.
4. **In PhantomBuster itself first** — open your agent's own setup page and fill in (then Save):
   - **Spreadsheet URL of LinkedIn companies URLs** — your Companies sheet's shareable link (Share → Anyone with the link → Viewer, in Google Sheets — PhantomBuster reads it unauthenticated, separate from n8n's OAuth access to the same sheet).
   - **Name of column containing companies URLs** — `LinkedIn URL`.
   - Any keyword/title filter you want applied.
   PhantomBuster's launch API call doesn't take these as per-launch arguments for this agent — it just triggers the agent to run with whatever's saved here. `01-kickoff.json`'s Launch node sends nothing but `{"id": "<your agent id>"}`.
5. In n8n: import both `n8n/01-kickoff.json` and `n8n/02-ingest-webhook.json`, replace `YOUR_GOOGLE_SHEET_ID` (in `02-ingest-webhook.json`'s Google Sheets nodes) with your spreadsheet's ID, activate both workflows.
6. Set up n8n **Credentials** (not env vars) for the two API calls — this instance blocks `$env.X` expressions in nodes, so secrets go through n8n's own Credentials store instead:
   - Google Sheets nodes: create a "Google Sheets OAuth2 API" credential, select it on every Google Sheets node.
   - `01-kickoff.json`'s "Launch Sales Nav Employees Phantom" node: create a **"Header Auth"** credential — Name: `X-Phantombuster-Key`, Value: your PhantomBuster API key — select it on that node's Authentication dropdown.
   - `02-ingest-webhook.json`'s "Groq - Qualify Candidate" node: create another **"Header Auth"** credential — Name: `Authorization`, Value: `Bearer YOUR_GROQ_KEY` (include the literal word "Bearer" and a space) — select it on that node.
7. Copy the Production URL from `02-ingest-webhook.json`'s Webhook node into PhantomBuster's agent → Advanced Notification Settings.

## Memory: the real limit of Render's free tier

Render's free web service gives 512 MB RAM. n8n's own Node process plus its
separate task-runner subprocess (needed to execute the Code nodes both
workflows use) can exceed that under load, crashing with `JavaScript heap
out of memory`. `NODE_OPTIONS=--max-old-space-size=400` in `render.yaml`
caps V8's heap so it garbage-collects more aggressively instead of trying to
grow past what's available — this helps, but doesn't add memory Render
doesn't give you. If it still OOMs under real workflow load (not just idle),
512 MB is a hard ceiling free-tier Render can't lift; at that point the
options are Render's paid tier (starts ~$7/mo, more RAM) or moving to a host
with more free RAM (e.g. Oracle Cloud's Always Free ARM VM, which requires
card verification but is never charged on the free shape).

## Groq free tier — what governs your throughput

`llama-3.3-70b-versatile` (the model used for scoring): **30 requests/min, 1,000 requests/day, 100,000 tokens/day** on the free tier. The `Pace (Groq free tier: 30 req/min)` Wait node in `02-ingest-webhook.json` adds a 2.5s delay before each scoring call to stay under the per-minute cap regardless of batch size. The 1,000/day cap is the harder ceiling — at the current pacing setup (~30 companies/day × up to 25 candidates each), you're close to it; lower `numberOfResultsPerLaunch` in `01-kickoff.json` or your daily company count if you consistently hit it. If you need higher volume than quality, `llama-3.1-8b-instant` allows up to 14,400 requests/day but is a weaker model for the nuanced Tier 1/2/3 judgment calls this rubric needs.

## Input / Output — mapped from the original spec

| Spec field | Where it lives |
|---|---|
| Input: Company name / LinkedIn URL | `Companies` sheet: `Company Name`, `LinkedIn URL` |
| Input: Client-specific prospecting rules | Phantom's `search` argument + the Tier 1/2/3 rubric in the Groq prompt (currently hardcoded to Sharp SSDI) |
| Output: Decision makers / Designation | `Prospects` sheet: `Name`, `Designation` |
| Output: LinkedIn profile URL | `Prospects` sheet: `LinkedInURL` |
| Output: Seniority | `Prospects` sheet: `Seniority` |
| Output: Relevance score | `Prospects` sheet: `Score` |
| Output: Reason for selection | `Prospects` sheet: `Reason` |
| Output: LinkedIn activity indicators | `Prospects` sheet: `Activity` (best-effort — coverage depends on the phantom's output) |

Human review loop (spec §9) maps to the `Status` column (`Auto-Approved` /
`Needs Review`, threshold score ≥ 70).

## Known gaps to close before this is fully load-bearing

- Confirm the `resultObject.jsonUrl` key in a real webhook payload before trusting `Fetch Result JSON` in `02-ingest-webhook.json`.
- Multi-client support isn't built yet — rules are hardcoded to Sharp SSDI.
- **No more per-company `Pending`/`Processing`/`Done` tracking in the `Companies` sheet.** Since the phantom processes the whole sheet in one run rather than one company at a time, `01-kickoff.json` no longer reads or filters on the `Status` column, and `02-ingest-webhook.json`'s "Log Failure"/"Mark Company Done" nodes (which match by `ContainerId`) are now best-effort bookkeeping rather than reliable per-company state — one phantom run covers multiple companies under a single `ContainerId`. Manage which companies are in the sheet manually (add/remove rows) rather than relying on that Status column to control what gets scraped.

## Security

Never commit API keys, LinkedIn session cookies, or database passwords to
this repo. Everything sensitive goes through Render's environment variable
UI (`sync: false` fields in `render.yaml`) or n8n's own Credentials store,
never into a tracked file.
