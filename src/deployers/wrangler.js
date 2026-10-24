const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

/**
 * Prepares the Cloudflare Pages deployment directory (.bestof2/cdn)
 * and deploys to Cloudflare Pages (Production if token present, or Local Edge Emulator).
 * 
 * @param {object} options
 * @param {string} options.projectDir - Root project dir
 * @param {string} options.staticDir - Path to static assets
 * @param {string} [options.staticPrefix] - Optional subpath inside CDN (e.g. '_next/static')
 * @param {string} [options.publicDir] - Path to public folder
 * @param {string} [options.workerCode] - Generated _worker.js code
 * @param {string} [options.projectName] - Cloudflare project name
 * @param {number} [options.port] - Port for emulator fallback
 */
function deployToWrangler({
  projectDir,
  staticDir,
  staticPrefix = '',
  publicDir,
  workerCode,
  projectName = 'bestof2-app',
  local = false,
  port = 8788
}) {
  const cdnDir = path.join(projectDir, '.bestof2/cdn');

  console.log(`🌐 Preparing Cloudflare Pages CDN directory (.bestof2/cdn)...`);
  fs.mkdirSync(cdnDir, { recursive: true });

  // 1. Copy static assets if they exist (Universal prefix handling)
  if (staticDir && fs.existsSync(staticDir)) {
    if (staticPrefix) {
      const destPath = path.join(cdnDir, staticPrefix);
      fs.mkdirSync(destPath, { recursive: true });
      copyRecursiveSync(staticDir, destPath);
    } else {
      copyRecursiveSync(staticDir, cdnDir);
    }
  }

  // 2. Copy public directory if exists
  if (publicDir && fs.existsSync(publicDir)) {
    copyRecursiveSync(publicDir, cdnDir);
  }

  // 2b. For Next.js, copy prerendered static HTML & RSC files to CDN root
  const serverAppDir = path.join(projectDir, '.next/server/app');
  if (fs.existsSync(serverAppDir)) {
    copyPrerenderedFiles(serverAppDir, cdnDir);
    if (fs.existsSync(path.join(serverAppDir, '_not-found.html'))) {
      fs.copyFileSync(path.join(serverAppDir, '_not-found.html'), path.join(cdnDir, '404.html'));
    }
  }
  const serverPagesDir = path.join(projectDir, '.next/server/pages');
  if (fs.existsSync(serverPagesDir)) {
    copyPrerenderedFiles(serverPagesDir, cdnDir);
  }

  // 3. Write dynamically generated _worker.js for fullstack edge routing
  if (workerCode) {
    const workerPath = path.join(cdnDir, '_worker.js');
    fs.writeFileSync(workerPath, workerCode, 'utf8');
    console.log(`✔ Generated Edge Router: .bestof2/cdn/_worker.js`);
  }

  // 4. Deploy: Production if Cloudflare Auth is present and not running local mode
  const isAuthed = !local && hasCloudflareAuth();

  if (isAuthed) {
    try {
      console.log(`🚀 Deploying to Cloudflare Pages production (${projectName})...`);
      try {
        execSync(`npx wrangler pages project create "${projectName}" --production-branch main --force`, {
          cwd: projectDir,
          stdio: 'pipe'
        });
      } catch (e) {}

      const deployOut = execSync(`npx wrangler pages deploy "${cdnDir}" --project-name "${projectName}" --branch main --commit-dirty=true`, {
        cwd: projectDir,
        stdio: 'pipe'
      }).toString();
      process.stdout.write(deployOut);

      const urlMatches = deployOut.match(/https:\/\/[a-zA-Z0-9.-]+\.pages\.dev/g) || [];
      const deploymentUrl = urlMatches[0] || `https://${projectName}.pages.dev`;
      let canonicalUrl = urlMatches.length > 1 ? urlMatches[urlMatches.length - 1] : deploymentUrl;
      canonicalUrl = canonicalUrl.replace(/https:\/\/(main|master)\./, 'https://');
      // Strip Cloudflare 7-10 hex deployment commit/hash prefix: e.g. 005a972b.project.pages.dev -> project.pages.dev
      canonicalUrl = canonicalUrl.replace(/https:\/\/[a-f0-9]{7,10}\./, 'https://');

      return {
        mode: 'production',
        cdnDir,
        url: canonicalUrl,
        deploymentUrl: deploymentUrl
      };
    } catch (err) {
      console.warn(`⚠ Cloudflare deploy notice: falling back to preview: ${err.message}`);
      return startLocalPreview(cdnDir, projectDir, port);
    }
  }

  // Fallback to local Edge CDN emulator when running without cloud credentials
  return startLocalPreview(cdnDir, projectDir, port);
}

function hasCloudflareAuth() {
  if (process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN) return true;
  try {
    const wranglerConfig = path.join(require('os').homedir(), '.wrangler/config/default.toml');
    if (fs.existsSync(wranglerConfig)) return true;
  } catch (e) {}
  return false;
}

function startLocalPreview(cdnDir, projectDir, port) {
  try {
    execSync('pkill -f "wrangler pages dev" || true', { stdio: 'ignore' });
  } catch (e) {}

  console.log(`⛅ Launching Cloudflare Pages emulator (Wrangler) on http://127.0.0.1:${port}...`);
  const wrangler = spawn('npx', [
    'wrangler', 'pages', 'dev', cdnDir,
    '--port', String(port),
    '--ip', '127.0.0.1',
    '--compatibility-date', '2026-10-19'
  ], {
    cwd: projectDir,
    detached: true,
    stdio: 'ignore'
  });
  wrangler.unref();

  return {
    mode: 'local',
    url: `http://127.0.0.1:${port}`,
    cdnDir
  };
}

function copyRecursiveSync(src, dest) {
  if (!fs.existsSync(src)) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const item of fs.readdirSync(src)) {
      copyRecursiveSync(path.join(src, item), path.join(dest, item));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

function copyPrerenderedFiles(srcDir, destDir, relDir = '') {
  const current = path.join(srcDir, relDir);
  if (!fs.existsSync(current)) return;
  for (const item of fs.readdirSync(current)) {
    const srcPath = path.join(current, item);
    const relPath = path.join(relDir, item);
    const destPath = path.join(destDir, relPath);
    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) {
      if (item === 'api') continue; // Skip api route directories
      fs.mkdirSync(destPath, { recursive: true });
      copyPrerenderedFiles(srcDir, destDir, relPath);
    } else if (item.endsWith('.html') || item.endsWith('.rsc')) {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

module.exports = { deployToWrangler };
