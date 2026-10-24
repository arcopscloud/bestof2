const fs = require('fs');
const path = require('path');

/**
 * Universal Framework & Architecture Detector.
 * Zero hardcoded framework limitations.
 * Detects:
 * - 'fullstack-separable': Next.js, Nuxt, Remix, SvelteKit, Astro, TanStack Start, SolidStart
 * - 'frontend-only': Vite (React/Vue/Svelte/Lit), CRA, Angular, Gatsby, Static HTML
 * - 'backend-only': Express, Fastify, NestJS, Hono, Koa, AdonisJS, Generic Node Servers
 * 
 * @param {string} projectDir 
 * @returns {object} frameworkInfo
 */
function detectFramework(projectDir) {
  const pkgPath = path.join(projectDir, 'package.json');
  let pkg = {};
  if (fs.existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch (e) {}
  }

  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const sanitizedName = pkg.name ? pkg.name.replace(/[^a-zA-Z0-9-_]/g, '-') : path.basename(projectDir);

  // -------------------------------------------------------------------------
  // 0. DECOUPLED MONOREPO (frontend/ + backend/ or client/ + server/)
  // -------------------------------------------------------------------------
  const candidateFrontendDirs = ['frontend', 'client', 'web', 'ui'];
  const candidateBackendDirs = ['backend', 'server', 'api'];

  const foundFrontend = candidateFrontendDirs.find(d => fs.existsSync(path.join(projectDir, d)));
  const foundBackend = candidateBackendDirs.find(d => fs.existsSync(path.join(projectDir, d)));

  if (foundFrontend && foundBackend) {
    const fPath = path.join(projectDir, foundFrontend);
    const bPath = path.join(projectDir, foundBackend);
    const staticCandidates = ['dist', 'build', 'out', 'public'];
    let staticDir = path.join(fPath, 'dist');
    for (const c of staticCandidates) {
      if (fs.existsSync(path.join(fPath, c))) {
        staticDir = path.join(fPath, c);
        break;
      }
    }

    return {
      category: 'decoupled-monorepo',
      type: 'monorepo',
      name: `Monorepo (${foundFrontend} + ${foundBackend})`,
      projectName: sanitizedName,
      frontendDir: fPath,
      backendDir: bPath,
      staticDir: staticDir,
      staticPrefix: '',
      publicDir: path.join(fPath, 'public'),
      serverDir: bPath
    };
  }

  // Next.js
  if (deps['next'] || fs.existsSync(path.join(projectDir, '.next'))) {
    return {
      category: 'fullstack-separable',
      type: 'nextjs',
      name: 'Next.js',
      projectName: sanitizedName,
      staticDir: path.join(projectDir, '.next/static'),
      staticPrefix: '_next/static',
      publicDir: path.join(projectDir, 'public'),
      serverDir: path.join(projectDir, '.next/standalone')
    };
  }

  // Nuxt / Nitro / TanStack Start / SolidStart
  if (deps['nuxt'] || deps['nitropack'] || deps['@tanstack/start'] || deps['solid-start'] || fs.existsSync(path.join(projectDir, '.output/nitro.json'))) {
    const name = deps['nuxt'] ? 'Nuxt' : deps['@tanstack/start'] ? 'TanStack Start' : deps['solid-start'] ? 'SolidStart' : 'Nitro';
    return {
      category: 'fullstack-separable',
      type: 'nitro',
      name: name,
      projectName: sanitizedName,
      staticDir: path.join(projectDir, '.output/public'),
      staticPrefix: '',
      publicDir: path.join(projectDir, 'public'),
      serverDir: path.join(projectDir, '.output/server')
    };
  }

  // SvelteKit (with Node adapter)
  if (deps['@sveltejs/kit']) {
    const staticDir = fs.existsSync(path.join(projectDir, 'build/client'))
      ? path.join(projectDir, 'build/client')
      : path.join(projectDir, '.svelte-kit/output/client');
    const serverDir = fs.existsSync(path.join(projectDir, 'build'))
      ? path.join(projectDir, 'build')
      : path.join(projectDir, '.svelte-kit/output/server');

    return {
      category: 'fullstack-separable',
      type: 'sveltekit',
      name: 'SvelteKit',
      projectName: sanitizedName,
      staticDir: staticDir,
      staticPrefix: '',
      publicDir: path.join(projectDir, 'static'),
      serverDir: serverDir
    };
  }

  // Remix / React Router v7
  if (deps['@react-router/node'] || deps['@react-router/serve'] || deps['@remix-run/react'] || deps['@remix-run/node'] || deps['@remix-run/serve']) {
    const isRR7 = deps['@react-router/node'] || deps['@react-router/serve'];
    return {
      category: 'fullstack-separable',
      type: 'remix',
      name: isRR7 ? 'React Router v7' : 'Remix',
      projectName: sanitizedName,
      staticDir: path.join(projectDir, 'build/client'),
      staticPrefix: '',
      publicDir: path.join(projectDir, 'public'),
      serverDir: projectDir
    };
  }

  // Astro (SSR mode)
  if (deps['astro'] && (deps['@astrojs/node'] || fs.existsSync(path.join(projectDir, 'dist/server')))) {
    return {
      category: 'fullstack-separable',
      type: 'astro',
      name: 'Astro (SSR)',
      projectName: sanitizedName,
      staticDir: path.join(projectDir, 'dist/client'),
      staticPrefix: '',
      publicDir: path.join(projectDir, 'public'),
      serverDir: projectDir
    };
  }

  // -------------------------------------------------------------------------
  // 2. BACKEND ONLY OR MONOLITHS (Lambda Web Function)
  // -------------------------------------------------------------------------
  const backendFrameworks = [
    { dep: 'express', name: 'Express' },
    { dep: 'fastify', name: 'Fastify' },
    { dep: '@nestjs/core', name: 'NestJS' },
    { dep: 'koa', name: 'Koa' },
    { dep: '@adonisjs/core', name: 'AdonisJS' },
    { dep: '@hapi/hapi', name: 'Hapi' }
  ];

  for (const bf of backendFrameworks) {
    if (deps[bf.dep]) {
      return {
        category: 'backend-only',
        type: 'backend',
        name: bf.name,
        projectName: sanitizedName,
        serverDir: projectDir
      };
    }
  }

  if (deps['hono'] && !deps['vite']) {
    return {
      category: 'backend-only',
      type: 'backend',
      name: 'Hono',
      projectName: sanitizedName,
      serverDir: projectDir
    };
  }

  // -------------------------------------------------------------------------
  // 3. PURE FRONTEND FRAMEWORKS (Cloudflare Pages CDN)
  // -------------------------------------------------------------------------
  if (deps['vite'] || deps['react-scripts'] || deps['@vue/cli-service'] || deps['astro'] || deps['@angular/core'] || deps['gatsby']) {
    const name = deps['vite'] ? 'Vite' : deps['@angular/core'] ? 'Angular' : deps['gatsby'] ? 'Gatsby' : 'Frontend SPA';
    const staticCandidates = ['dist', 'build', 'out', 'public'];
    let staticDir = path.join(projectDir, 'dist');
    for (const c of staticCandidates) {
      if (fs.existsSync(path.join(projectDir, c))) {
        staticDir = path.join(projectDir, c);
        break;
      }
    }

    return {
      category: 'frontend-only',
      type: 'frontend',
      name: name,
      projectName: sanitizedName,
      staticDir: staticDir,
      staticPrefix: '',
      publicDir: path.join(projectDir, 'public')
    };
  }

  // -------------------------------------------------------------------------
  // 4. FALLBACK INSPECTION (Filesystem Artifacts)
  // -------------------------------------------------------------------------
  if (fs.existsSync(path.join(projectDir, 'index.html')) || fs.existsSync(path.join(projectDir, 'dist'))) {
    return {
      category: 'frontend-only',
      type: 'static',
      name: 'Static Site',
      projectName: sanitizedName,
      staticDir: fs.existsSync(path.join(projectDir, 'dist')) ? path.join(projectDir, 'dist') : projectDir,
      staticPrefix: '',
      publicDir: path.join(projectDir, 'public')
    };
  }

  return {
    category: 'backend-only',
    type: 'generic-server',
    name: 'Node Server',
    projectName: sanitizedName,
    serverDir: projectDir
  };
}

module.exports = { detectFramework };
