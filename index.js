const { deploy } = require('./src/commands/deploy');
const { detectFramework } = require('./src/detector');
const { extractNextJsRoutes } = require('./src/extractors/nextjs');
const { extractNitroRoutes } = require('./src/extractors/nitro');
const { generateEdgeWorker } = require('./src/router-generator');
const { deployToLambda } = require('./src/deployers/lambda');
const { deployToWrangler } = require('./src/deployers/wrangler');

module.exports = {
  deploy,
  detectFramework,
  extractNextJsRoutes,
  extractNitroRoutes,
  generateEdgeWorker,
  deployToLambda,
  deployToWrangler
};
