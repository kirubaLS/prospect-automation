const { chromium } = require('playwright');
const config = require('./config');

function randomDelay() {
  const ms = config.minDelayMs + Math.random() * (config.maxDelayMs - config.minDelayMs);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function launchSession() {
  const browser = await chromium.launch({ headless: config.headless });
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
  return { browser, context, page };
}

async function isLoggedIn(page) {
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
  const url = page.url();
  return !url.includes('/login') && !url.includes('/checkpoint');
}

// Resolves a company name to Sales Navigator's internal numeric company id by
// running a Sales Navigator company search and reading the id out of the first
// result's /sales/company/<id> link. This id is required to build a precise
// CURRENT_COMPANY filter for the people search below.
async function findCompanyId(page, companyName) {
  const searchUrl = `https://www.linkedin.com/sales/search/company?keywords=${encodeURIComponent(companyName)}`;
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
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

module.exports = { launchSession, isLoggedIn, findCompanyId, buildPeopleSearchUrl, scrapeSearchResults, randomDelay };
