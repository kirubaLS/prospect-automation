const { runScrape } = require('./run');

runScrape()
  .then((summary) => {
    console.log('\nDone:', JSON.stringify(summary, null, 2));
  })
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
