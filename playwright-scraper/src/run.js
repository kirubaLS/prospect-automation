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
    return { company: companyName, status: 'error', prospects: 0 };
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
    return { company: companyName, status: 'no_matches', prospects: 0 };
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
  return { company: companyName, status: 'done', prospects: prospects.length };
}

// Runs one full pass over pending companies and returns a summary. Always
// closes the browser before returning/throwing, so callers (CLI or an HTTP
// server) don't need to manage browser lifecycle themselves - important on
// a memory-constrained host where a leaked browser process is fatal.
async function runScrape() {
  const startedAt = new Date();
  const { browser, page } = await li.launchSession();
  const results = [];
  try {
    const loggedIn = await li.isLoggedIn(page);
    if (!loggedIn) {
      throw new Error(
        'LinkedIn session cookie is invalid or expired (redirected to login/checkpoint) - refresh LINKEDIN_LI_AT_COOKIE'
      );
    }

    const companies = await sheets.getPendingCompanies();
    console.log(`Found ${companies.length} pending companies`);

    for (const company of companies) {
      try {
        results.push(await processCompany(page, company));
      } catch (err) {
        console.error(`[${company['Company Name']}] failed: ${err.message}`);
        await sheets.updateCompanyStatus(company._rowNumber, 'Error', err.message).catch(() => {});
        results.push({ company: company['Company Name'], status: 'error', prospects: 0, error: err.message });
      }
      await li.randomDelay();
    }
  } finally {
    await browser.close();
  }

  return {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    companiesProcessed: results.length,
    totalProspects: results.reduce((sum, r) => sum + (r.prospects || 0), 0),
    results
  };
}

module.exports = { runScrape };
