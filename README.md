# Prospect Automation — n8n on Render + PhantomBuster + Groq

LeadStrategus AI Prospect Research Agent implementation. Automates the
company → decision-maker → qualified-prospect pipeline: PhantomBuster runs
the Sales Navigator scraping (your own logged-in seat), n8n orchestrates,
Groq (free tier, `llama-3.3-70b-versatile`) scores candidates against the
ICP rubric, results land in Google Sheets.

## What's here

- `render.yaml` — Blueprint for deploying n8n + a free Postgres database on Render (free tier, no credit card). Postgres gives n8n persistent storage so workflows/credentials survive Render's free-tier restarts.
- `n8n/01-kickoff.json` — reads pending companies from Google Sheets, launches PhantomBuster's Sales Navigator Account Employees Export agent per company, paces launches.
- `n8n/02-ingest-webhook.json` — receives PhantomBuster's completion webhook, fetches the scraped candidates, scores each with Groq against the Sharp SSDI Tier 1/2/3 rubric, writes results to the Prospects sheet.

## Deploy

1. **Render** → New → Blueprint → connect this repo → Deploy Blueprint. This provisions the n8n web service and its Postgres database together.
2. In the Render dashboard, set the `sync: false` env vars manually (never commit these to this repo):
   - `N8N_BASIC_AUTH_USER` / `N8N_BASIC_AUTH_PASSWORD`
   - `N8N_ENCRYPTION_KEY` — **required**, generate once with `openssl rand -hex 32` and set it before n8n's first successful boot. Render's free web service has no persistent disk, so n8n's own auto-generated key gets thrown away on every restart while the Postgres database (which *is* persistent) keeps data encrypted with whatever key was active when it was written. Without a fixed key, every restart mismatches the two and n8n crash-loops with `Deployment key 'signing.hmac' cannot be read with this instance encryption key`. Set this once, never change it afterward — changing it later makes all previously stored credentials/workflow secrets unreadable.
   - `GROQ_API_KEY` — free, no card, from [console.groq.com/keys](https://console.groq.com/keys)
   - `PHANTOMBUSTER_API_KEY`
   - `PB_ACCOUNT_EMPLOYEES_AGENT_ID`
3. Set up a free keep-alive ping (cron-job.org or UptimeRobot) hitting your `*.onrender.com` URL every ~10 minutes, since Render's free tier sleeps after 15 minutes idle otherwise.
4. In n8n: import both `n8n/01-kickoff.json` and `n8n/02-ingest-webhook.json`, set Google Sheets/PhantomBuster credentials, replace the `YOUR_GOOGLE_SHEET_ID` placeholders, activate both workflows.
5. Copy the Production URL from `02-ingest-webhook.json`'s Webhook node into PhantomBuster's agent → Advanced Notification Settings.

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

- Verify the phantom's exact `argument` field names against its own API tab in the PhantomBuster console.
- Confirm the `resultObject.jsonUrl` key in a real webhook payload before trusting `Fetch Result JSON` in `02-ingest-webhook.json`.
- Multi-client support isn't built yet — rules are hardcoded to Sharp SSDI.

## Security

Never commit API keys, LinkedIn session cookies, or database passwords to
this repo. Everything sensitive goes through Render's environment variable
UI (`sync: false` fields in `render.yaml`) or n8n's own Credentials store,
never into a tracked file.
