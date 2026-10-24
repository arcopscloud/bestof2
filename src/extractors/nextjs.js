const fs = require('fs');
const path = require('path');

function extractNextJsRoutes(projectDir) {
  const nextDir = path.join(projectDir, '.next');
  const routesManifestPath = path.join(nextDir, 'routes-manifest.json');
  const prerenderManifestPath = path.join(nextDir, 'prerender-manifest.json');
  const appPathRoutesManifestPath = path.join(nextDir, 'app-path-routes-manifest.json');

  if (!fs.existsSync(routesManifestPath)) {
    throw new Error(`routes-manifest.json not found in ${nextDir}. Please build first ('next build').`);
  }

  const routesManifest = JSON.parse(fs.readFileSync(routesManifestPath, 'utf8'));
  const prerenderManifest = fs.existsSync(prerenderManifestPath)
    ? JSON.parse(fs.readFileSync(prerenderManifestPath, 'utf8'))
    : { routes: {}, dynamicRoutes: {} };
  const appPathRoutes = fs.existsSync(appPathRoutesManifestPath)
    ? JSON.parse(fs.readFileSync(appPathRoutesManifestPath, 'utf8'))
    : {};

  const prerenderedPaths = new Set(Object.keys(prerenderManifest.routes || {}));

  const serverRoutes = new Set();
  const staticRoutes = new Set();
  const dynamicPatterns = [];

  // 1. App Router API Route handlers (ending with /route, e.g. /api/status/route -> /api/status)
  for (const [appPath, routeUrl] of Object.entries(appPathRoutes)) {
    if (appPath.endsWith('/route')) {
      serverRoutes.add(routeUrl);
      dynamicPatterns.push(`^${escapeRegex(routeUrl)}(?:/)?$`);
    }
  }

  // 2. Declared staticRoutes: If not prerendered, it's dynamic SSR!
  for (const r of (routesManifest.staticRoutes || [])) {
    if (prerenderedPaths.has(r.page)) {
      staticRoutes.add(r.page);
    } else if (!serverRoutes.has(r.page)) {
      serverRoutes.add(r.page);
      if (r.regex) dynamicPatterns.push(r.regex);
    }
  }

  // 3. Dynamic routes from routes-manifest.json (e.g. /users/[id])
  for (const r of (routesManifest.dynamicRoutes || [])) {
    if (!prerenderManifest.dynamicRoutes || !prerenderManifest.dynamicRoutes[r.page]) {
      serverRoutes.add(r.page);
      if (r.regex) dynamicPatterns.push(r.regex);
    }
  }

  return {
    framework: 'nextjs',
    staticRoutes: Array.from(staticRoutes),
    serverRoutes: Array.from(serverRoutes),
    dynamicPatterns: Array.from(new Set(dynamicPatterns))
  };
}

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { extractNextJsRoutes };
