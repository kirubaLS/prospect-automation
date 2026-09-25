// CLI entry point.
//
//   npm start -- --input companies.xlsx --output prospects.xlsx
//   npm start -- --input companies.csv                (writes prospects.csv next to it)
//   npm start                                         (file mode: resumes whatever was
//                                                      imported before; sheets mode:
//                                                      reads the Google Sheet)
//
// Options: --input <csv|xlsx>  --output <csv|xlsx>  --replace  --limit <n>
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');
const { runScrape } = require('./run');

function parseArgs(argv) {
  const args = { replace: false, limit: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input') args.input = argv[++i];
    else if (a === '--output') args.output = argv[++i];
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10) || 0;
    else if (a === '--replace') args.replace = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(0, 10).join('\n'));
    return;
  }

  if (config.storageBackend === 'file') {
    const store = require('./filestore');
    const files = require('./files');

    if (args.input) {
      const buffer = fs.readFileSync(args.input);
      const info = store.importCompanies(buffer, path.basename(args.input), { replace: args.replace });
      logger.info(`Imported ${args.input}: ${info.pending} pending of ${info.total}`);
    } else if (store.snapshot().companies === 0) {
      throw new Error('Nothing to do: pass --input <companies.csv|xlsx> (see --help)');
    }

    const summary = await runScrape({ limit: args.limit });
    logger.info(`Done: ${summary.companiesProcessed} companies, ${summary.totalProspects} prospects this run`);

    const output =
      args.output ||
      (args.input ? path.join(path.dirname(args.input), `prospects.${files.formatFromName(args.input)}`) : 'prospects.csv');
    fs.writeFileSync(output, files.exportProspects(store.getProspects(), files.formatFromName(output)));
    logger.info(`Wrote ${store.getProspects().length} prospects to ${output}`);

    const statusFile = path.join(path.dirname(output), 'companies-status.csv');
    fs.writeFileSync(statusFile, files.exportCompanies(store.getCompanies(), 'csv'));
    logger.info(`Wrote per-company status to ${statusFile}`);

    const snap = store.snapshot();
    if (snap.pending > 0) logger.info(`${snap.pending} companies still pending - run again to continue`);
    if (snap.error > 0) logger.warn(`${snap.error} companies ended in Error - see the Companies status export or state.json`);
  } else {
    if (args.input || args.output) throw new Error('--input/--output only apply to STORAGE_BACKEND=file');
    const summary = await runScrape({ limit: args.limit });
    logger.info('Done: ' + JSON.stringify(summary, null, 2));
  }
})().catch((err) => {
  logger.error('Fatal error:', err.message);
  process.exit(1);
});
