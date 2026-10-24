const fs = require('fs');
const path = require('path');

/**
 * Universally extracts or scans server & dynamic routes for ANY fullstack framework
 * (Remix, SvelteKit, Astro, SolidStart, TanStack, etc.)
 * 
 * @param {string} projectDir 
 * @returns {object} { framework: string, staticRoutes: string[], serverRoutes: string[], dynamicPatterns: string[] }
 */
function extractUniversalRoutes(projectDir, frameworkInfo = {}) {
  const serverRoutes = new Set();
  const dynamicPatterns = new Set();
  const staticRoutes = new Set();

  // 1. Scan common API route directories
  const candidateApiDirs = [
    'app/api',
    'src/app/api',
    'pages/api',
    'src/pages/api',
    'server/api',
    'src/routes/api',
    'routes/api',
    'api'
  ];

  for (const dir of candidateApiDirs) {
    const fullDir = path.join(projectDir, dir);
    if (fs.existsSync(fullDir)) {
      scanApiFiles(fullDir, '', serverRoutes, dynamicPatterns);
    }
  }

  // 2. Scan SvelteKit server endpoints (+server.js / +server.ts)
  const svelteKitRoutesDir = path.join(projectDir, 'src/routes');
  if (fs.existsSync(svelteKitRoutesDir)) {
    scanSvelteKitEndpoints(svelteKitRoutesDir, '', serverRoutes, dynamicPatterns);
  }

  // 3. Scan Remix / React Router routes in app/routes
  const remixRoutesDir = path.join(projectDir, 'app/routes');
  if (fs.existsSync(remixRoutesDir)) {
    scanRemixRoutes(remixRoutesDir, '', serverRoutes, dynamicPatterns);
  }

  // 4. Scan static assets in staticDir if present
  if (frameworkInfo.staticDir && fs.existsSync(frameworkInfo.staticDir)) {
    scanStaticFiles(frameworkInfo.staticDir, '', staticRoutes);
  }

  // 5. Default catch-all for dynamic mutations and API endpoints
  if (serverRoutes.size === 0) {
    serverRoutes.add('/api/*');
    dynamicPatterns.add('^/api(?:/.*)?$');
  }

  return {
    framework: frameworkInfo.name || 'generic',
    staticRoutes: Array.from(staticRoutes),
    serverRoutes: Array.from(serverRoutes),
    dynamicPatterns: Array.from(dynamicPatterns)
  };
}

function scanApiFiles(baseDir, currentRel, serverRoutes, dynamicPatterns) {
  const entries = fs.readdirSync(path.join(baseDir, currentRel), { withFileTypes: true });
  for (const entry of entries) {
    const rel = path.join(currentRel, entry.name);
    if (entry.isDirectory()) {
      scanApiFiles(baseDir, rel, serverRoutes, dynamicPatterns);
    } else if (/\.(js|ts|mjs|cjs)$/.test(entry.name)) {
      const routePath = '/api/' + rel.replace(/\.[^/.]+$/, '').replace(/\/index$/, '');
      serverRoutes.add(routePath);
      dynamicPatterns.add('^' + routePath.replace(/\[([^\]]+)\]/g, '[^/]+') + '(?:/.*)?$');
    }
  }
}

function scanSvelteKitEndpoints(baseDir, currentRel, serverRoutes, dynamicPatterns) {
  const currentPath = path.join(baseDir, currentRel);
  const entries = fs.readdirSync(currentPath, { withFileTypes: true });
  for (const entry of entries) {
    const rel = path.join(currentRel, entry.name);
    if (entry.isDirectory()) {
      scanSvelteKitEndpoints(baseDir, rel, serverRoutes, dynamicPatterns);
    } else if (/^\+server\.(js|ts)$/.test(entry.name)) {
      const routePath = '/' + currentRel;
      serverRoutes.add(routePath);
      dynamicPatterns.add('^' + routePath.replace(/\[([^\]]+)\]/g, '[^/]+') + '(?:/.*)?$');
    }
  }
}

function scanStaticFiles(baseDir, currentRel, staticRoutes) {
  try {
    const currentPath = path.join(baseDir, currentRel);
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const rel = path.join(currentRel, entry.name);
      if (entry.isDirectory()) {
        scanStaticFiles(baseDir, rel, staticRoutes);
      } else {
        staticRoutes.add('/' + rel);
      }
    }
  } catch (e) {}
}

function scanRemixRoutes(baseDir, currentRel, serverRoutes, dynamicPatterns) {
  try {
    const currentPath = path.join(baseDir, currentRel);
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const rel = path.join(currentRel, entry.name);
      if (entry.isDirectory()) {
        scanRemixRoutes(baseDir, rel, serverRoutes, dynamicPatterns);
      } else if (/\.(js|ts|jsx|tsx)$/.test(entry.name)) {
        const cleanName = entry.name.replace(/\.[^/.]+$/, '');
        if (cleanName.startsWith('api.') || currentRel.startsWith('api')) {
          let routePath = '/' + path.join(currentRel, cleanName).replace(/\./g, '/').replace(/\/index$/, '');
          routePath = routePath.replace(/\/+/g, '/');
          serverRoutes.add(routePath);
          dynamicPatterns.add('^' + routePath.replace(/\$([^/]+)/g, '[^/]+').replace(/\[([^\]]+)\]/g, '[^/]+') + '(?:/.*)?$');
        }
      }
    }
  } catch (e) {}
}

module.exports = { extractUniversalRoutes };
