# Apps Script versions (one Google Sheet per project)

Each `.gs` file is a complete, self-contained script for one project: the
project's settings are in the `CONFIG` block at the top, the engine below is
identical across files (generated from `_engine.gs.tmpl`).

| File | Project | Geography | Per company |
|---|---|---|---|
| `sharp.gs` | Sharp SSDI — IT/Admin/Procurement/Finance/Purchasing | South India | 4 |
| `fleet-us.gs` | Fleet & transport — CEO/MD/President, fleet, maintenance, ops, safety, logistics, procurement | US | 8 |
| `finance-it-india.gs` | Owners/partners, CEO/co-founder/MD, Finance & IT heads | India | 5 |
| `maintenance-ops.gs` | Operations, fleet maintenance, logistics, safety, procurement | **not set in the SOP — edit `personLocations` / `prescreen.countries`** | 6 |
| `hr-ops-india.gs` | CEO/co-founders, HR, Ops, People Ops, Admin, Chief of Staff, Facility/Office Manager, HRBP | People: APAC · Company HQ: India | 6 |

## Setup per project (5 minutes)

1. Create a Google Sheet for the project (or open the existing one).
2. **Extensions → Apps Script** → delete the sample code → paste the whole
   `.gs` file → **Save**.
3. Back in the Sheet, **reload the page**. A **Prospecting** menu appears.
   The first click asks you to authorise the script (it needs Sheets access
   and permission to call Apollo over HTTPS) — accept.
4. **Prospecting → Set Apollo API key** — paste the key. It's stored in the
   script's private properties, never in a cell.
5. **Prospecting → Create / repair tabs** — creates `Companies`, `Prospects`,
   `RunLog`.
6. Put companies in **Companies** (`Company Name`, `LinkedIn URL` = the
   company page URL). To use an Excel file: File → Import → Upload → choose
   *Replace current sheet* while on the Companies tab.
7. **Prospecting → Run pending companies.** Start with **Run next 3 only
   (test)** the first time.

Results appear in **Prospects**; each company's outcome (Done / No Matches /
Not in Apollo / Pre-screen failed / Error) and what Apollo matched go into
the Companies row. Download: File → Download → Microsoft Excel.

Google stops any script after 6 minutes; the run stops itself at ~5 and
schedules a continuation one minute later until nothing is pending. Leave
the Sheet open or not — it continues either way. **Prospecting → Stop
scheduled continuation** cancels that.

## What the researcher still does

`Connections 500+`, `Activity`, `Open to work?` are left blank on every
prospect row — no data API has LinkedIn activity or connection counts. Fill
them from the `LinkedInURL` column. Each project's activity rule (e.g. Sharp:
reject if too old; fleet-us: High ≤ 1 month else Medium) is in the SOP, not
the script.

## Changing a project

Edit the `CONFIG` block at the top of its script:

- `targetPerCompany` — how many to keep per company.
- `personLocations` — Apollo location strings (`"Karnataka, India"`,
  `"United States"`, `"Singapore"`).
- `seniorityTiers` — searched in order; first tier is "decision makers",
  later tiers are the "if none, go to all employees / managers" fallback.
- `titleKeywords` — what to search for (Apollo matches any, against the
  current title).
- `rules.tiers` — priority/score by title regex, first match wins;
  `rules.exclude` — titles never written, even as filler.
- `prescreen` — company must be in Apollo, have employees, HQ in
  `countries`; `industriesAnyOf` warns (or blocks with `enforceIndustry`).

Regenerate all five after changing the engine: edit `_engine.gs.tmpl`, then
re-run the generator in the repo history (`git log -- apps-script`).
