// CLI: Apollo prospecting for one project folder.
//   node src/project.js --project sharp [--limit N] [--replace]
const path = require('path');
require('dotenv').config();
const { runProject } = require('./projectRunner');
const logger = require('./logger');

function parseArgs(argv) {
  const args = { limit: 0, replace: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') args.project = argv[++i];
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10) || 0;
    else if (a === '--replace') args.replace = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.project) throw new Error('--project <name> is required (a folder under projects/)');
  return args;
}

const args = parseArgs(process.argv.slice(2));
const projectsRoot = process.env.PROJECTS_DIR || path.resolve(__dirname, '..', '..', 'projects');

runProject({
  projectDir: path.join(projectsRoot, args.project),
  apiKey: process.env.APOLLO_API_KEY,
  openAiKey: process.env.OPENAI_API_KEY,
  limit: args.limit,
  replace: args.replace
}).catch((err) => {
  logger.error('Fatal:', err.message);
  process.exit(1);
});
