const config = require('./config');
const sheets = require('./store');
const li = require('./linkedin');
const logger = require('./logger');
const { qualifyAndSelect } = require('./qualify');

async function scrapeCompanyOnce(page, company) {
  const companyName = company['Company Name'];
  logger.info(`[${companyName}] resolving Sales Navigator company id...`);

  const companyId = await li.findCompanyId(page, company);
  if (!companyId) {
    logger.warn(`[${companyName}] could not resolve company id, skipping`);
    return { company: companyName, status: 'error', prospects: 0, error: 'Could not resolve Sales Navigator company id' };
  }
  logger.info(`[${companyName}] company id ${companyId} - opening account page, clicking "Decision makers"`);
  await li.randomDelay();

  const decisionMakerCount = await li.openDecisionMakers(page, companyId);
  if (decisionMakerCount === 0) {
    logger.info(`[${companyName}] Sales Navigator shows 0 decision makers`);
    return { company: companyName, status: 'no_matches', prospects: 0, prospectRows: [] };
  }
  logger.info(
    decisionMakerCount === null
      ? `[${companyName}] opened decision-makers search (count unknown)`
      : `[${companyName}] Sales Navigator lists ${decisionMakerCount} decision makers`
  );

  if (config.debug) {
    const safeName = companyName.replace(/\W+/g, '_');
    await page.screenshot({ path: `debug-${safeName}.png`, fullPage: true });
  }

  const prospects = await li.scrapeSearchResults(page, config.maxProspectsPerCompany);
  logger.info(`[${companyName}] found ${prospects.length} matching prospects`);
  return { company: companyName, status: prospects.length > 0 ? 'done' : 'no_matches', prospects: prospects.length, prospectRows: prospects };
}

// A checkpoint/session error means every subsequent company will fail the
// same way, so it's not worth retrying - only retry genuinely transient
// failures (timeouts, one-off navigation errors).
function isRetryable(err) {
  return !/checkpoint|session cookie/i.test(err.message);
}

async function processCompany(page, company) {
  const companyName = company['Company Name'];
  let lastErr;

  for (let attempt = 1; attempt <= config.maxRetriesPerCompany + 1; attempt++) {
    try {
      const result = await scrapeCompanyOnce(page, company);
      if (result.status === 'error') {
        await sheets.updateCompanyStatus(company._rowNumber, 'Error', result.error);
        return result;
      }
      if (result.status === 'no_matches') {
        await sheets.updateCompanyStatus(company._rowNumber, 'No Matches');
        return result;
      }
      const candidates = result.prospectRows.map((p) => ({
        company: companyName,
        name: p.name,
        title: p.title,
        titleDescription: p.titleDescription,
        profileUrl: p.profileUrl,
        location: p.location,
        tenure: p.tenure,
        activity: 'Unknown'
      }));

      let selected;
      if (config.openAiApiKey) {
        logger.info(`[${companyName}] qualifying ${candidates.length} decision makers with the Sharp SSDI rubric`);
        selected = await qualifyAndSelect(candidates);
        logger.info(
          `[${companyName}] keeping top ${selected.length}: ` +
            selected.map((s) => `${s.name} (${s.score}, ${s.priority})`).join('; ')
        );
      } else {
        selected = candidates.map((c) => ({ ...c, status: 'Needs Review' }));
      }

      const written = await sheets.appendProspects(selected);
      logger.info(`[${companyName}] wrote ${written} new prospect rows (${selected.length - written} already present)`);
      await sheets.updateCompanyStatus(company._rowNumber, 'Done');
      return { company: companyName, status: 'done', prospects: selected.length };
    } catch (err) {
      lastErr = err;
      logger.error(`[${companyName}] attempt ${attempt} failed: ${err.message}`);
      if (!isRetryable(err) || attempt > config.maxRetriesPerCompany) break;
      await li.randomDelay();
    }
  }

  await sheets.updateCompanyStatus(company._rowNumber, 'Error', lastErr.message).catch(() => {});
  return { company: companyName, status: 'error', prospects: 0, error: lastErr.message };
}

// Runs one pass over up to `limit` pending companies (all of them if limit is
// falsy) and returns a summary. Always closes the browser before
// returning/throwing, so callers (CLI or an HTTP server) don't need to manage
// browser lifecycle themselves - important on a memory-constrained host where
// a leaked browser process is fatal.
function rssMb() {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

async function runScrape({ limit } = {}) {
  const startedAt = new Date();
  logger.info(`Run starting (node rss ${rssMb()} MB before browser launch)`);
  const { browser, page } = await li.launchSession();
  logger.info(`Browser launched (node rss ${rssMb()} MB; Chromium's own processes are extra)`);
  const results = [];
  let fatalError = null;

  try {
    const loggedIn = await li.isLoggedIn(page);
    if (!loggedIn) {
      throw new Error(
        'LinkedIn session cookie is invalid or expired (redirected to login/checkpoint) - refresh LINKEDIN_LI_AT_COOKIE'
      );
    }

    let companies = await sheets.getPendingCompanies();
    if (limit) companies = companies.slice(0, limit);
    logger.info(`Processing ${companies.length} companies this run`);

    for (const company of companies) {
      const result = await processCompany(page, company);
      results.push(result);
      // A checkpoint/session error is unrecoverable for the rest of this
      // run too - stop early instead of burning through remaining companies
      // against a dead session.
      if (result.error && /checkpoint|session cookie/i.test(result.error)) {
        fatalError = result.error;
        break;
      }
      await li.randomDelay();
    }
  } catch (err) {
    fatalError = err.message;
    logger.error('Run aborted:', err.message);
  } finally {
    await browser.close().catch((err) => logger.error('Error closing browser:', err.message));
    logger.info(`Browser closed (node rss ${rssMb()} MB)`);
  }

  const summary = {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    companiesProcessed: results.length,
    totalProspects: results.reduce((sum, r) => sum + (r.prospects || 0), 0),
    fatalError,
    results
  };

  await sheets.appendRunLog(summary).catch((err) => logger.warn('Could not write run log:', err.message));

  if (fatalError && results.length === 0) throw new Error(fatalError);
  return summary;
}

module.exports = { runScrape };
