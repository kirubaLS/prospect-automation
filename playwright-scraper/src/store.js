const config = require('./config');

// One storage backend for the run loop, chosen by STORAGE_BACKEND:
//   file   - companies from an uploaded/local CSV or XLSX, prospects exported
//            the same way (default; no Google setup needed)
//   sheets - the original Google Sheets tabs
module.exports = config.storageBackend === 'sheets' ? require('./sheets') : require('./filestore');
