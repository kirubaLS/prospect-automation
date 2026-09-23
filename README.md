# Prospect Automation — n8n on Render + PhantomBuster + OpenAI

LeadStrategus AI Prospect Research Agent implementation. Automates the
company → decision-maker → qualified-prospect pipeline: PhantomBuster runs
the Sales Navigator scraping (your own logged-in seat), n8n orchestrates,
OpenAI (`gpt-4o-mini`, paid — see cost note below) scores candidates against
the ICP rubric, results land in Google Sheets.

## What's here

- `render.yaml` — Blueprint for deploying n8n + a free Postgres database on Render (free tier, no credit card). Postgres gives n8n persistent storage so workflows/credentials survive Render's free-tier restarts.
- `n8n/01-kickoff.json` — launches PhantomBuster's Sales Navigator Account Employees Export agent **once per schedule tick**, pointing it directly at the Companies Google Sheet as its input list (this phantom processes a whole spreadsheet of company URLs in one run — it isn't launched per-company).
- `n8n/02-ingest-webhook.json` — receives PhantomBuster's completion webhook, fetches the scraped candidates, scores each with OpenAI against the Sharp SSDI Tier 1/2/3 rubric, keeps only the **top 4 highest-scoring candidates per company**, writes results to the Prospects sheet, and marks each company `Done` in the Companies sheet once its prospects are written.

## Cost note: this is no longer a fully free pipeline

Render, PhantomBuster (your existing plan) and Google Sheets stay as before,
but the qualification-scoring step now uses OpenAI's paid API, not a free
tier — OpenAI removed free trial credits for new accounts. **A ChatGPT
Plus/Pro subscription does not include API access or credits** — they're
billed completely separately; you need a funded account at
platform.openai.com with a payment method on file. At `gpt-4o-mini` pricing
($0.15/$0.60 per 1M input/output tokens) this is roughly **$0.0001-0.0002
per candidate scored** — trivial in absolute terms, but a real ongoing cost,
unlike Groq's free tier this replaces.

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
   - `02-ingest-webhook.json`'s "OpenAI - Qualify Candidate" node: create another **"Header Auth"** credential — Name: `Authorization`, Value: `Bearer YOUR_OPENAI_KEY` (include the literal word "Bearer" and a space) — select it on that node. The key comes from platform.openai.com, not from a ChatGPT subscription.
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

## Why OpenAI instead of Groq

This started on Groq's free tier, but hit a hard wall: `llama-3.3-70b-versatile`
was deprecated (Aug 2026), and its replacement `openai/gpt-oss-120b` only
gets 8,000 tokens/minute on the free tier — too tight for reliable
production use at this prompt's size, and every stable alternative on
Groq's free tier (`gpt-oss-20b`, `qwen/qwen3.6-27b`) shares the same 8,000
TPM ceiling. `gemma2-9b-it` was considered as a higher-TPM option but has
since been decommissioned. Moving to OpenAI's paid API removes the rate-limit
chase entirely — new accounts start around 500 RPM / 200,000 TPM for
`gpt-4o-mini`, far more headroom than Groq's free tier ever offered, at the
cost of no longer being free (see the cost note above).

## Input / Output — mapped from the original spec

| Spec field | Where it lives |
|---|---|
| Input: Company name / LinkedIn URL | `Companies` sheet: `Company Name`, `LinkedIn URL` |
| Input: Client-specific prospecting rules | Phantom's `search` argument + the Tier 1/2/3 rubric in the OpenAI prompt (currently hardcoded to Sharp SSDI) |
| Output: Decision makers / Designation | `Prospects` sheet: `Name`, `Designation` |
| Output: LinkedIn profile URL | `Prospects` sheet: `LinkedInURL` |
| Output: Seniority | `Prospects` sheet: `Seniority` |
| Output: Relevance score | `Prospects` sheet: `Score` |
| Output: Reason for selection | `Prospects` sheet: `Reason` |
| Output: LinkedIn activity indicators | `Prospects` sheet: `Activity` — always writes `Unknown`. Not in scope: spec §10 lists "LinkedIn activity detection / Recent posts analysis" under **Future Enhancements**, not Phase 1-4. Intentionally deferred, not a bug to fix now. |

Human review loop (spec §9) maps to the `Status` column (`Auto-Approved` /
`Needs Review`, threshold score ≥ 70).

## Known gaps to close before this is fully load-bearing

- `resultObject` came back `null` in the webhook payload even on a successful run for this agent, so `02-ingest-webhook.json` now calls `/containers/fetch-result-object` separately instead. That endpoint's exact response shape for this specific agent isn't confirmed yet — "Split Out Candidates" (now a Code node) tries several likely shapes defensively, but check its output on a real run and adjust if it comes back empty.
- Multi-client support isn't built yet — rules are hardcoded to Sharp SSDI.
- **Per-company completion tracking is back, but works differently than the original per-launch design.** `01-kickoff.json` still doesn't filter on `Status` when launching the phantom (it always sends the whole sheet). But `02-ingest-webhook.json`'s "Mark Company Done" node now matches by `Company Name` (not `ContainerId`, which was a run-level ID never actually written to the sheet and silently matched nothing) — it fires once per top-4 candidate written for that company, setting `Status = Done`. Filter the Companies sheet on `Status` to see which companies actually got prospects written to the Prospects sheet, independent of whether PhantomBuster itself finished scraping them.
- **Resuming an interrupted multi-company scrape**: enable **Watcher Mode** on the PhantomBuster agent (Behavior step in its setup) — it skips companies already scraped in a prior run automatically, so if the phantom run dies partway through a 5-10 minute multi-company scrape, the next launch continues with unscraped companies instead of starting over. This is separate from and complementary to the `Status` tracking above: Watcher Mode governs what PhantomBuster re-scrapes, `Status` tells you what actually made it into your Prospects sheet.
- **If PhantomBuster's webhook keeps "disconnecting"**: check whether you're pointing it at n8n's **Test** URL instead of the **Production** URL. The Test URL only listens while the editor is actively open with "Listen for test event" running — it drops the moment you navigate away, which looks exactly like random disconnects on a scrape that takes several minutes. Make sure `02-ingest-webhook.json` is **Active**, and copy the webhook node's **Production URL** (not Test URL) into PhantomBuster's Advanced Notification Settings.

## Deliberately out of scope for this phase

- **Company context (size, industry, tech maturity)** — spec §7 lists it as a scoring factor to consider, but companies enter this pipeline pre-vetted by the researcher (spec §2 step 1), so this phase's qualification work is about title relevance among already-selected companies, not re-scoring the companies themselves. The Account Employees Export phantom's output has no company-size/industry fields anyway, and adding a separate LinkedIn Company Scraper phantom to fetch them isn't worth the added scraping volume/risk for a secondary factor.
- **Activity indicators (posts, engagement)** — spec §10 explicitly places "LinkedIn activity detection / Recent posts analysis" under Future Enhancements, not the Phase 1-4 build. `Activity` always writes `Unknown` by design, not as a bug.

## Security

Never commit API keys, LinkedIn session cookies, or database passwords to
this repo. Everything sensitive goes through Render's environment variable
UI (`sync: false` fields in `render.yaml`) or n8n's own Credentials store,
never into a tracked file.
