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
  if (!linkedInUrl || !/linkedin\.com\/company\//i.test(linkedInUrl)) return null;
  // A sheet row may already hold a Sales Navigator account URL.
  const direct = linkedInUrl.match(/\/sales\/company\/(\d+)/);
  if (direct) return direct[1];

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

// Mirrors the manual workflow: open the company's Sales Navigator account
// page and click its built-in "Decision makers" quick search (under "Common
// searches"). That preset applies Sales Navigator's own seniority filter,
// scoped to this company, without us needing to know the internal filter ids.
// Returns the count shown next to the link (e.g. "Decision makers (4)" -> 4),
// or null if the link wasn't found on the page.
async function openDecisionMakers(page, companyId) {
  await gotoWithRetry(page, `https://www.linkedin.com/sales/company/${companyId}`);
  assertNotCheckpoint(page);
  await randomDelay();

  const link = page.getByRole('link', { name: /decision makers/i }).first();
  if ((await link.count()) === 0) return null;

  const label = ((await link.textContent()) || '').trim();
  const countMatch = label.match(/\((\d+)\)/);
  const count = countMatch ? parseInt(countMatch[1], 10) : null;
  if (count === 0) return 0;

  await Promise.all([
    page.waitForURL(/\/sales\/search\/people/, { timeout: config.navigationTimeoutMs }),
    link.click()
  ]);
  assertNotCheckpoint(page);
  await randomDelay();
  return count;
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

// A Sales Navigator lead result row reads, line by line:
//   "Dr Chytra Anand · 1st · Viewed"
//   "Founder & Chairperson · Kosmoderma Skin, Hair & Body Clinics"
//   "Bengaluru, Karnataka, India"
//   "20 years 9 months in role | 20 years 9 months in company"
//   "About: ... Show more"
// This parses that shape from the row's visible text, which is more stable
// than LinkedIn's generated class names. Title/company are split on " · ".
function parseResultText(text, name) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const nameIdx = lines.findIndex((l) => l.startsWith(name));
  const after = nameIdx >= 0 ? lines.slice(nameIdx + 1) : lines;

  const titleLine = after[0] || '';
  const [title, ...companyParts] = titleLine.split(' · ');
  const company = companyParts.join(' · ').trim();

  const location = after[1] && !/ in role| in company/.test(after[1]) ? after[1] : '';
  const tenure = after.find((l) => / in role| in company/.test(l)) || '';
  const aboutLine = after.find((l) => /^About:/.test(l)) || '';
  const titleDescription = aboutLine.replace(/^About:\s*/, '').replace(/\s*Show more$/, '').trim();

  return { title: title.trim(), company, location, tenure, titleDescription };
}

// Run with DEBUG_SCRAPER=true and HEADLESS=false on a small test company
// first - if this returns 0 despite visible results on screen, open the
// saved debug-*.png / inspect the live page and adjust cardSelector.
async function scrapeSearchResults(page, maxResults) {
  const results = [];
  const seen = new Set();
  let previousCount = -1;
  // Every result row links to the lead's /sales/lead/... page, so anchoring
  // on that is far more stable than LinkedIn's generated class names.
  const cardSelector = 'li:has(a[href*="/sales/lead/"])';

  while (results.length < maxResults) {
    await page.waitForTimeout(1500);
    const cards = page.locator(cardSelector);
    const count = await cards.count();
    if (count === previousCount) break; // no new cards after scrolling - end of results or selector mismatch
    previousCount = count;

    for (let i = 0; i < count && results.length < maxResults; i++) {
      const card = cards.nth(i);
      const nameEl = card.locator('a[data-anonymize="person-name"], a[href*="/sales/lead/"]').first();
      const name = ((await nameEl.textContent().catch(() => '')) || '').trim();
      const profileHref = await nameEl.getAttribute('href').catch(() => null);
      if (!name || !profileHref) continue;

      const profileUrl = profileHref.startsWith('http')
        ? profileHref.split('?')[0]
        : `https://www.linkedin.com${profileHref.split('?')[0]}`;
      if (seen.has(profileUrl)) continue;
      seen.add(profileUrl);

      const parsed = parseResultText((await card.innerText().catch(() => '')) || '', name);
      results.push({ name, profileUrl, ...parsed });
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
  openDecisionMakers,
  buildPeopleSearchUrl,
  scrapeSearchResults,
  randomDelay,
  gotoWithRetry,
  looksLikeCheckpoint
};
