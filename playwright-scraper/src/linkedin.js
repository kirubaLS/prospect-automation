const { chromium } = require('playwright');
const config = require('./config');
const logger = require('./logger');

function randomDelay() {
  const ms = config.minDelayMs + Math.random() * (config.maxDelayMs - config.minDelayMs);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wraps page.goto with a couple of retries for transient network/timeout
// failures - a real page load failing once shouldn't fail the whole company.
async function gotoWithRetry(page, url, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await page.goto(url, { waitUntil: 'domcontentloaded' });
      const title = await page.title().catch(() => '');
      logger.info(`  -> ${res ? res.status() : '???'} ${page.url()} "${title}"`);
      return res;
    } catch (err) {
      lastErr = err;
      // A redirect loop on a /sales/ URL means Sales Navigator is bouncing
      // the session (missing li_a cookie, UA mismatch, or a challenge) - it
      // will do the same for every company, so don't keep retrying.
      if (/ERR_TOO_MANY_REDIRECTS/.test(err.message) && /\/sales\//.test(url)) {
        throw new Error(
          `Sales Navigator redirect loop at ${url.split('?')[0]} - the session is not accepted for Sales Navigator ` +
            '(add the li_a cookie as LINKEDIN_LI_A_COOKIE and set LINKEDIN_USER_AGENT to your real browser UA)'
        );
      }
      logger.warn(`goto failed (attempt ${i + 1}/${attempts}): ${err.message.split('\n')[0]}`);
      if (i < attempts - 1) await randomDelay();
    }
  }
  throw lastErr;
}

function looksLikeCheckpoint(url) {
  return /\/(login|checkpoint|authwall|uas\/login|sales\/login|sales\/contract-chooser)/.test(url);
}

// Everything here is about fitting Chromium into a 512MB container:
// - headless shell is the slimmer headless-only build (Playwright >= 1.49)
// - one renderer process instead of one per site
// - images/fonts/media are never needed for scraping text, and LinkedIn
//   pages are heavy with profile photos
async function launchSession() {
  const browser = await chromium.launch({
    headless: config.headless,
    channel: config.headless && !config.chromiumPath ? 'chromium-headless-shell' : undefined,
    executablePath: config.chromiumPath || undefined,
    args: [
      // avoids Chromium crashing in containers with a small /dev/shm
      '--disable-dev-shm-usage',
      // required to run as root in most containers
      '--no-sandbox',
      '--disable-gpu',
      '--disable-features=site-per-process,IsolateOrigins',
      '--renderer-process-limit=2',
      '--disable-background-networking',
      '--disable-extensions',
      '--js-flags=--max-old-space-size=128'
    ]
  });
  const context = await browser.newContext({ userAgent: config.userAgent, viewport: { width: 1280, height: 800 } });
  if (config.blockMedia) {
    await context.route('**/*', (route) => {
      const type = route.request().resourceType();
      return ['image', 'media', 'font'].includes(type) ? route.abort() : route.continue();
    });
  }
  const cookies = [{ name: 'li_at', value: config.liAtCookie, domain: '.linkedin.com', path: '/', httpOnly: true, secure: true }];
  if (config.liACookie) {
    cookies.push({ name: 'li_a', value: config.liACookie, domain: '.linkedin.com', path: '/', httpOnly: true, secure: true });
  }
  await context.addCookies(cookies);
  const page = await context.newPage();
  // Fail fast instead of hanging: a stuck navigation on a constrained host
  // ties up memory/CPU indefinitely without this.
  page.setDefaultNavigationTimeout(config.navigationTimeoutMs);
  page.setDefaultTimeout(config.navigationTimeoutMs);
  return { browser, context, page };
}

async function isLoggedIn(page) {
  await gotoWithRetry(page, 'https://www.linkedin.com/feed/');
  return !looksLikeCheckpoint(page.url());
}

function assertNotCheckpoint(page) {
  if (looksLikeCheckpoint(page.url())) {
    throw new Error('Hit a LinkedIn login/checkpoint page mid-run - session cookie likely expired or was challenged');
  }
}

// The numeric id in a Sales Navigator /sales/company/<id> URL is LinkedIn's
// regular company id, and the regular company page embeds it in its markup
// (as urn:li:...company:<id>). Reading it from the exact URL in the sheet
// is more precise than a name search, which can land on a similarly-named
// company. Returns null if the URL isn't a company page or the id isn't found.
async function companyIdFromLinkedInUrl(page, linkedInUrl) {
  if (!linkedInUrl) return null;
  // A row may already hold a Sales Navigator account URL - the id is right there.
  const direct = linkedInUrl.match(/\/sales\/company\/(\d+)/);
  if (direct) return direct[1];
  if (!/linkedin\.com\/company\//i.test(linkedInUrl)) return null;

  await gotoWithRetry(page, linkedInUrl.split('?')[0]);
  assertNotCheckpoint(page);
  await randomDelay();

  const html = await page.content();
  const match =
    html.match(/urn:li:(?:fsd_company|fs_normalized_company|company):(\d+)/) ||
    html.match(/"companyId"\s*:\s*"?(\d+)/) ||
    html.match(/\/sales\/company\/(\d+)/);
  return match ? match[1] : null;
}

// Fallback: Sales Navigator account search by name, first result's id.
async function companyIdFromNameSearch(page, companyName) {
  const searchUrl = `https://www.linkedin.com/sales/search/company?keywords=${encodeURIComponent(companyName)}`;
  await gotoWithRetry(page, searchUrl);
  assertNotCheckpoint(page);
  await randomDelay();

  const links = page.locator('a[href*="/sales/company/"]');
  if ((await links.count()) === 0) return null;

  const href = await links.first().getAttribute('href');
  const match = href && href.match(/\/sales\/company\/(\d+)/);
  return match ? match[1] : null;
}

async function findCompanyId(page, company) {
  const fromUrl = await companyIdFromLinkedInUrl(page, company['LinkedIn URL']).catch((err) => {
    if (/checkpoint/i.test(err.message)) throw err;
    logger.warn(`Could not read company id from LinkedIn URL: ${err.message}`);
    return null;
  });
  if (fromUrl) return fromUrl;
  return companyIdFromNameSearch(page, company['Company Name']);
}

// Sales Navigator's "Decision makers" quick search on an account page is
// (confirmed from the page's own link markup) CURRENT_COMPANY = <id> plus
// SENIORITY_LEVEL ids 6, 7, 8 = Director, Vice President, CXO. Building the
// URL directly is deterministic; the account page is still visited first so
// the "Decision makers (N)" count can be read and a 0 short-circuited.
const DECISION_MAKER_SENIORITY_IDS = [6, 7, 8];

function buildDecisionMakersUrl(companyId) {
  const seniority = DECISION_MAKER_SENIORITY_IDS.map((id) => `(id:${id},selectionType:INCLUDED)`).join(',');
  const query =
    `(filters:List(` +
    `(type:CURRENT_COMPANY,values:List((id:${companyId},selectionType:INCLUDED))),` +
    `(type:SENIORITY_LEVEL,values:List(${seniority}))` +
    `))`;
  return `https://www.linkedin.com/sales/search/people?query=${encodeURIComponent(query)}`;
}

// Mirrors the manual workflow: open the company's account page, then go to
// its "Decision makers" search. Prefers the page's own link href (exactly what
// a click would load); falls back to the equivalent built URL if the link is
// absent. Returns the count shown next to the link, or null if unknown.
async function openDecisionMakers(page, companyId) {
  await gotoWithRetry(page, `https://www.linkedin.com/sales/company/${companyId}`);
  assertNotCheckpoint(page);
  await randomDelay();

  let count = null;
  let target = buildDecisionMakersUrl(companyId);

  const link = page.locator('a[aria-label*="decision makers" i], a:has-text("Decision makers")').first();
  if ((await link.count()) > 0) {
    const label = `${(await link.getAttribute('aria-label')) || ''} ${(await link.textContent()) || ''}`;
    const m = label.match(/(\d+)/);
    count = m ? parseInt(m[1], 10) : null;
    if (count === 0) return 0;
    const href = await link.getAttribute('href');
    if (href) target = href.startsWith('http') ? href : `https://www.linkedin.com${href}`;
  } else {
    logger.warn(`No "Decision makers" link on account page ${companyId}; using built search URL`);
  }

  await gotoWithRetry(page, target);
  assertNotCheckpoint(page);
  await randomDelay();
  return count;
}

// Reads one rendered lead row in a single in-page evaluation. Every field
// carries a stable data-anonymize attribute (confirmed from the live DOM);
// the About blurb's full text lives in its title attribute, the visible span
// is clamped to one line. Done via evaluate() rather than per-field locators
// because a locator call on a field a row lacks (e.g. no About block) would
// auto-wait the full default timeout instead of returning empty.
async function extractLead(leadEl) {
  const raw = await leadEl.evaluate((el) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const pick = (sel) => clean(el.querySelector(sel)?.textContent);
    const link =
      el.querySelector('a[data-control-name="view_lead_panel_via_search_lead_name"]') ||
      el.querySelector('a[href*="/sales/lead/"]');
    const blurb = el.querySelector('[data-anonymize="person-blurb"]');
    return {
      href: link ? link.getAttribute('href') : null,
      name: pick('[data-anonymize="person-name"]'),
      title: pick('[data-anonymize="title"]'),
      company: pick('[data-anonymize="company-name"]'),
      location: pick('[data-anonymize="location"]'),
      tenure: pick('[data-anonymize="job-title"]'),
      blurb: blurb ? blurb.getAttribute('title') || clean(blurb.textContent) : ''
    };
  });
  if (!raw.href || !raw.name) return null;

  const { href, blurb, ...fields } = raw;
  return {
    ...fields,
    profileUrl: (href.startsWith('http') ? href : `https://www.linkedin.com${href}`).split('?')[0],
    titleDescription: blurb.replace(/…\s*Show more$/, '').trim()
  };
}

// Result rows render lazily: only rows near the viewport of the scrollable
// #search-results-container hold a [data-x-search-result="LEAD"]; the rest
// are skeleton placeholders until scrolled into view. The first card is the
// company itself ("ACCOUNT"), not a lead. Pages hold up to 25 rows; "Next"
// is followed while more results are wanted.
async function scrapeSearchResults(page, maxResults) {
  const results = [];
  const seen = new Set();

  for (let pageNo = 1; results.length < maxResults; pageNo++) {
    await page.locator('#search-results-container').waitFor({ timeout: config.navigationTimeoutMs }).catch(() => {});
    const containerFound = (await page.locator('#search-results-container').count()) > 0;
    const items = page.locator('#search-results-container li.artdeco-list__item');
    const total = await items.count();
    if (!containerFound) {
      // The Sales Navigator app never rendered its results panel - that's a
      // page/session problem, not "this company has no decision makers".
      throw new Error(
        `Search results page did not render (no #search-results-container) at ${page.url().split('?')[0]} - title "${await page.title().catch(() => '')}"`
      );
    }
    if (total === 0) {
      logger.info('Results container rendered with no rows - treating as no matches');
      break;
    }

    for (let i = 0; i < total && results.length < maxResults; i++) {
      const li = items.nth(i);
      await li.scrollIntoViewIfNeeded().catch(() => {});
      const lead = li.locator('[data-x-search-result="LEAD"]');
      const rendered = await lead.waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
      if (!rendered) continue; // ACCOUNT card, or a row that never rendered

      const row = await extractLead(lead).catch((err) => {
        logger.warn(`Could not read row ${i + 1}: ${err.message}`);
        return null;
      });
      if (!row || seen.has(row.profileUrl)) continue;
      seen.add(row.profileUrl);
      results.push(row);
      await page.waitForTimeout(300 + Math.random() * 500);
    }

    const next = page.locator('.artdeco-pagination button[aria-label="Next"]:not([disabled])');
    if (results.length >= maxResults || (await next.count()) === 0) break;
    logger.info(`Following pagination to page ${pageNo + 1}`);
    await next.click();
    await randomDelay();
    assertNotCheckpoint(page);
  }

  return results.slice(0, maxResults);
}

// Compact description of the current page for the per-run debug file.
async function pageSnapshot(page) {
  return {
    url: page.url(),
    title: await page.title().catch(() => ''),
    text: await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 1500)).catch(() => '')
  };
}

module.exports = {
  pageSnapshot,
  launchSession,
  isLoggedIn,
  findCompanyId,
  openDecisionMakers,
  buildDecisionMakersUrl,
  scrapeSearchResults,
  randomDelay,
  gotoWithRetry,
  looksLikeCheckpoint
};
