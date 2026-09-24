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
      return await page.goto(url, { waitUntil: 'domcontentloaded' });
    } catch (err) {
      lastErr = err;
      logger.warn(`goto failed (attempt ${i + 1}/${attempts}): ${err.message}`);
      if (i < attempts - 1) await randomDelay();
    }
  }
  throw lastErr;
}

function looksLikeCheckpoint(url) {
  return url.includes('/login') || url.includes('/checkpoint') || url.includes('/authwall');
}

async function launchSession() {
  const browser = await chromium.launch({
    headless: config.headless,
    // --disable-dev-shm-usage avoids Chromium crashing in containers with a
    // small /dev/shm (default on most PaaS free tiers, including Render).
    // --no-sandbox is required to run Chromium as root in most containers.
    args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-gpu']
  });
  const context = await browser.newContext({ userAgent: config.userAgent });
  await context.addCookies([
    {
      name: 'li_at',
      value: config.liAtCookie,
      domain: '.linkedin.com',
      path: '/',
      httpOnly: true,
      secure: true
    }
  ]);
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

// Resolves a company name to Sales Navigator's internal numeric company id by
// running a Sales Navigator company search and reading the id out of the first
// result's /sales/company/<id> link. This id is required to build a precise
// CURRENT_COMPANY filter for the people search below.
async function findCompanyId(page, companyName) {
  const searchUrl = `https://www.linkedin.com/sales/search/company?keywords=${encodeURIComponent(companyName)}`;
  await gotoWithRetry(page, searchUrl);
  if (looksLikeCheckpoint(page.url())) {
    throw new Error('Hit a LinkedIn login/checkpoint page mid-run - session cookie likely expired or was challenged');
  }
  await randomDelay();

  const links = page.locator('a[href*="/sales/company/"]');
  const count = await links.count();
  if (count === 0) return null;

  const href = await links.first().getAttribute('href');
  const match = href && href.match(/\/sales\/company\/(\d+)/);
  return match ? match[1] : null;
}

// Builds a Sales Navigator people-search URL scoped to one company via its
// resolved id, combined with a keyword filter for title/seniority. Navigating
// straight to this URL is equivalent to applying both filters in the UI.
function buildPeopleSearchUrl(companyId, companyName, titleKeywords) {
  const filters = `(filters:List((type:CURRENT_COMPANY,values:List((id:${companyId},text:${encodeURIComponent(
    companyName
  )},selectionType:INCLUDED)))))`;
  return `https://www.linkedin.com/sales/search/people?query=${filters}&keywords=${encodeURIComponent(titleKeywords)}`;
}

// Selectors below target commonly-documented Sales Navigator search-result
// markup, but LinkedIn changes this DOM periodically and it can vary by
// account/plan. Run with DEBUG_SCRAPER=true and HEADLESS=false on a small
// test company first - if scrapeSearchResults returns 0 despite visible
// results on screen, open the saved debug-*.png / inspect the live page and
// update the selectors in this function to match what you actually see.
async function scrapeSearchResults(page, maxResults) {
  const results = [];
  let previousCount = -1;
  const cardSelector = 'li[data-x-search-result], .artdeco-list__item, [data-view-name="search-results-list-item"]';

  while (results.length < maxResults) {
    await page.waitForTimeout(1500);
    const cards = page.locator(cardSelector);
    const count = await cards.count();
    if (count === previousCount) break; // no new cards after scrolling - end of results or selector mismatch
    previousCount = count;

    for (let i = results.length; i < count && results.length < maxResults; i++) {
      const card = cards.nth(i);
      const nameEl = card.locator('a[data-anonymize="person-name"], a[href*="/sales/lead/"]').first();
      const name = ((await nameEl.textContent().catch(() => '')) || '').trim();
      const profileHref = await nameEl.getAttribute('href').catch(() => null);
      const title = ((await card.locator('[data-anonymize="title"]').first().textContent().catch(() => '')) || '').trim();
      const location = (
        (await card.locator('[data-anonymize="location"]').first().textContent().catch(() => '')) || ''
      ).trim();

      if (name && profileHref) {
        results.push({ name, title, location, profileUrl: profileHref.split('?')[0] });
      }
    }

    await page.mouse.wheel(0, 2000);
    await randomDelay();
  }

  return results.slice(0, maxResults);
}

module.exports = {
  launchSession,
  isLoggedIn,
  findCompanyId,
  buildPeopleSearchUrl,
  scrapeSearchResults,
  randomDelay,
  gotoWithRetry,
  looksLikeCheckpoint
};
