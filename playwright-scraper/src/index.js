const config = require('./config');
const sheets = require('./sheets');
const li = require('./linkedin');

async function processCompany(page, company) {
  const companyName = company['Company Name'];
  console.log(`\n[${companyName}] resolving Sales Navigator company id...`);

  const companyId = await li.findCompanyId(page, companyName);
  if (!companyId) {
    console.warn(`[${companyName}] could not resolve company id, skipping`);
    await sheets.updateCompanyStatus(company._rowNumber, 'Error', 'Could not resolve Sales Navigator company id');
    return;
  }
  await li.randomDelay();

  const searchUrl = li.buildPeopleSearchUrl(companyId, companyName, config.titleKeywords);
  console.log(`[${companyName}] searching: ${searchUrl}`);
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
  await li.randomDelay();

  if (config.debug) {
    const safeName = companyName.replace(/\W+/g, '_');
    await page.screenshot({ path: `debug-${safeName}.png`, fullPage: true });
  }

  const prospects = await li.scrapeSearchResults(page, config.maxProspectsPerCompany);
  console.log(`[${companyName}] found ${prospects.length} matching prospects`);

  if (prospects.length === 0) {
    await sheets.updateCompanyStatus(company._rowNumber, 'No Matches');
    return;
  }

  await sheets.appendProspects(
    prospects.map((p) => ({
      company: companyName,
      name: p.name,
      title: p.title,
      profileUrl: p.profileUrl,
      location: p.location,
      status: 'New'
    }))
  );

  await sheets.updateCompanyStatus(company._rowNumber, 'Done');
}

async function main() {
  const { browser, page } = await li.launchSession();
  try {
    const loggedIn = await li.isLoggedIn(page);
    if (!loggedIn) {
      throw new Error(
        'LinkedIn session cookie is invalid or expired (redirected to login/checkpoint) - refresh LINKEDIN_LI_AT_COOKIE in .env'
      );
    }

    const companies = await sheets.getPendingCompanies();
    console.log(`Found ${companies.length} pending companies`);

    for (const company of companies) {
      try {
        await processCompany(page, company);
      } catch (err) {
        console.error(`[${company['Company Name']}] failed: ${err.message}`);
        await sheets.updateCompanyStatus(company._rowNumber, 'Error', err.message).catch(() => {});
      }
      await li.randomDelay();
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
