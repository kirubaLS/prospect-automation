// Runs scrapeSearchResults() against a fixture trimmed from a real Sales
// Navigator "Decision makers" results page, in a real Chromium, including
// the page's lazy row rendering. No LinkedIn access, no credentials.
//
//   node test/scrape-results.test.js
process.env.LINKEDIN_LI_AT_COOKIE ||= 'test';
process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON ||= '{}';
process.env.SPREADSHEET_ID ||= 'test';
process.env.MIN_DELAY_MS = '0';
process.env.MAX_DELAY_MS = '0';

const assert = require('assert');
const path = require('path');
const { chromium } = require('playwright');
const li = require('../src/linkedin');

(async () => {
  // CHROMIUM_PATH lets the test run against a system/preinstalled Chromium
  // when Playwright's own download isn't present.
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.goto('file://' + path.join(__dirname, 'fixtures', 'search-results.html'));

  const rows = await li.scrapeSearchResults(page, 25);
  await browser.close();

  console.log(JSON.stringify(rows, null, 2));

  assert.strictEqual(rows.length, 7, 'all 7 lead rows scraped, account card skipped, lazy rows rendered');
  assert.deepStrictEqual(rows[0], {
    name: 'Len Tyrrell',
    profileUrl: 'https://www.linkedin.com/sales/lead/ACwAABw-RqYBvR5Os6ZHBuE53towQslZNymd11A,NAME_SEARCH,n7cD',
    title: 'Chief Operating Officer',
    company: 'GTS Transportation Corp',
    location: 'Greater Chicago Area',
    tenure: '3 months in role 3 months in company',
    titleDescription:
      'Results driven executive with a proven track record of generating substantial revenue, building high-performing teams, and fostering client relationships.  Expert in logistics and transportation, with exceptional negotiation and leadership skills.\n\nhttps://blog.foodshippers.org/2022-top-food-chain-pros-to-know'
  });
  assert.strictEqual(rows[1].titleDescription, '', 'row with no About block yields empty description');
  assert.strictEqual(rows[2].title, 'Director of Operations');
  assert.deepStrictEqual(
    rows.slice(3).map((r) => r.name),
    ['Ray Chaudry', 'GTS Transportation', 'Temur Primkulov', 'Loretis Andriuskevicius'],
    'lazy-rendered rows are scrolled into view and read'
  );
  assert.strictEqual(new Set(rows.map((r) => r.profileUrl)).size, 7, 'profile URLs unique and query-stripped');

  console.log('\nPASS: scrapeSearchResults against real-DOM fixture');
})().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
