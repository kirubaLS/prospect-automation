function ts() {
  return new Date().toISOString();
}

module.exports = {
  info: (...args) => console.log(`[${ts()}]`, ...args),
  warn: (...args) => console.warn(`[${ts()}] WARN`, ...args),
  error: (...args) => console.error(`[${ts()}] ERROR`, ...args)
};
