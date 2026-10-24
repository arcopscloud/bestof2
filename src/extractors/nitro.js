const fs = require('fs');
const path = require('path');

/**
 * Extracts static assets and server route patterns from Nitro build output (.output).
 * Supports Nuxt 3/4, TanStack Start, SolidStart, and Nitro Standalone.
 * @param {string} projectDir 
 */
function extractNitroRoutes(projectDir) {
  const outputDir = path.join(projectDir, '.output');
  const publicDir = path.join(outputDir, 'public');
  const serverDir = path.join(outputDir, 'server');
  const routesChunkDir = path.join(serverDir, 'chunks/routes');

  const staticFiles = [];
  const serverRoutes = new Set();
  const dynamicPatterns = [];

  // 1. Discover static assets from .output/public
  if (fs.existsSync(publicDir)) {
    function walkDir(currentDir, relativePath = '') {
      const files = fs.readdirSync(currentDir);
      for (const file of files) {
        const fullPath = path.join(currentDir, file);
        const rel = path.join(relativePath, file);
        if (fs.statSync(fullPath).isDirectory()) {
          walkDir(fullPath, rel);
        } else {
          staticFiles.push('/' + rel.replace(/\\/g, '/'));
        }
      }
    }
    walkDir(publicDir);
  }

  // 2. Discover server routes from compiled chunks (.output/server/chunks/routes)
  if (fs.existsSync(routesChunkDir)) {
    function walkRoutes(currentDir, prefix = '') {
      const entries = fs.readdirSync(currentDir);
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry);
        if (fs.statSync(fullPath).isDirectory()) {
          walkRoutes(fullPath, `${prefix}/${entry}`);
        } else if (entry.endsWith('.mjs') && entry !== 'renderer.mjs') {
          const routeName = entry.replace(/\.mjs$/, '');
          const routePath = `${prefix}/${routeName}`.replace(/\/index$/, '');
          serverRoutes.add(routePath || '/');
          dynamicPatterns.push(`^${escapeRegex(routePath)}(?:/.*)?$`);
        }
      }
    }
    walkRoutes(routesChunkDir);
  }

  // Always ensure /api/* is routed to server
  if (dynamicPatterns.length === 0 || !dynamicPatterns.some(p => p.includes('api'))) {
    dynamicPatterns.push('^/api(?:/.*)?$');
  }

  return {
    framework: 'nitro',
    staticRoutes: staticFiles,
    serverRoutes: Array.from(serverRoutes),
    dynamicPatterns: Array.from(new Set(dynamicPatterns))
  };
}

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { extractNitroRoutes };
