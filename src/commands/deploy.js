const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');

// Auto-load .env from cwd or parent directories
require('dotenv').config();
let envSearchDir = process.cwd();
for (let i = 0; i < 3; i++) {
  const envCandidate = path.join(envSearchDir, '.env');
  if (fs.existsSync(envCandidate)) {
    require('dotenv').config({ path: envCandidate });
    break;
  }
  const parent = path.dirname(envSearchDir);
  if (parent === envSearchDir) break;
  envSearchDir = parent;
}

const { detectFramework } = require('../detector');
const { extractNextJsRoutes } = require('../extractors/nextjs');
const { extractNitroRoutes } = require('../extractors/nitro');
const { extractUniversalRoutes } = require('../extractors/universal');
const { generateEdgeWorker } = require('../router-generator');
const { deployToLambda } = require('../deployers/lambda');
const { deployToWrangler } = require('../deployers/wrangler');

/**
 * Universal Dual-Cloud Deployer
 * Frontends -> Cloudflare Pages CDN ($0 egress bandwidth)
 * Backends  -> AWS Lambda Web Functions (Active-CPU serverless, ARM64 Graviton)
 */
async function deploy(options = {}) {
  const projectDir = options.cwd || process.cwd();
  console.log(`\n🏆 BestOf2 Dual-Cloud Deployer`);
  console.log(`------------------------------------------------------------`);
  console.log(`📂 Project: ${projectDir}`);

  // 1. Detect Framework & Architecture Tier
  const frameworkInfo = detectFramework(projectDir);
  console.log(`✔ Framework detected: ${frameworkInfo.name}`);

  // 2. Build Project if Needed
  ensureBuilt(frameworkInfo, projectDir);

  const projectName = options.projectName || process.env.PROJECT_NAME || frameworkInfo.projectName || 'bestof2-app';
  const isLocal = options.local !== undefined ? options.local : !!process.env.BESTOF2_LOCAL;
  const hasAws = hasAwsConfig(options);
  const secretToken = getSecretToken(projectDir);

  let backendUrl = options.backendUrl || process.env.BACKEND_URL || '';
  let frontendResult = null;

  // -------------------------------------------------------------------------
  // Case 1: Pure Frontend Framework (Cloudflare Pages only)
  // -------------------------------------------------------------------------
  if (frameworkInfo.category === 'frontend-only') {
    frontendResult = deployToWrangler({
      projectDir,
      staticDir: frameworkInfo.staticDir,
      staticPrefix: frameworkInfo.staticPrefix || '',
      publicDir: frameworkInfo.publicDir,
      projectName,
      local: isLocal,
      port: options.port || 8788
    });

    printSummary({
      mode: 'Cloudflare Pages (Frontend CDN Only)',
      framework: frameworkInfo.name,
      url: frontendResult.url
    });

    return { url: frontendResult.url, mode: 'frontend-only', framework: frameworkInfo.name };
  }

  // -------------------------------------------------------------------------
  // Case 2: Backend Deploy (AWS Lambda Web Function or Self-Host)
  // -------------------------------------------------------------------------
  if (hasAws) {
    backendUrl = await deployToLambda({
      functionName: options.functionName || `${projectName}-backend`,
      serverDir: frameworkInfo.serverDir,
      secretToken: frameworkInfo.category === 'backend-only' ? null : secretToken,
      imageUri: options.imageUri,
      endpointUrl: options.endpointUrl || process.env.AWS_ENDPOINT_URL,
      roleArn: options.roleArn || process.env.AWS_ROLE_ARN
    });
  } else if (frameworkInfo.category === 'backend-only') {
    console.log(`\n⚠ AWS credentials not found: skipping standalone backend deployment.`);
    return { skipped: true, mode: 'backend-only' };
  }

  // Standalone backend-only completes here
  if (frameworkInfo.category === 'backend-only') {
    printSummary({
      mode: 'AWS Lambda Web Function Only',
      framework: frameworkInfo.name,
      backendUrl
    });

    return { backendUrl, mode: 'backend-only', framework: frameworkInfo.name };
  }

  // -------------------------------------------------------------------------
  // Case 3: Full-Stack Separable (Pages + Edge Router Rules + Lambda)
  // -------------------------------------------------------------------------
  const routeData = getRoutes(projectDir, frameworkInfo);
  console.log(`✔ Routes extracted: ${routeData.staticRoutes.length} static assets, ${routeData.serverRoutes.length} server routes, ${routeData.dynamicPatterns.length} regexes`);

  const workerCode = generateEdgeWorker({
    backendUrl,
    dynamicPatterns: routeData.dynamicPatterns,
    secretToken,
    framework: frameworkInfo.name
  });

  frontendResult = deployToWrangler({
    projectDir,
    staticDir: frameworkInfo.staticDir,
    staticPrefix: frameworkInfo.staticPrefix || '',
    publicDir: frameworkInfo.publicDir,
    workerCode,
    projectName,
    local: isLocal,
    port: options.port || 8788
  });

  printSummary({
    mode: 'Dual-Cloud (Cloudflare Pages + AWS Lambda)',
    framework: frameworkInfo.name,
    url: frontendResult.url,
    backendUrl,
    secretToken,
    hasAws
  });

  return {
    url: frontendResult.url,
    backendUrl,
    framework: frameworkInfo.name,
    routes: routeData
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getRoutes(projectDir, frameworkInfo) {
  if (frameworkInfo.type === 'nextjs' && fs.existsSync(path.join(projectDir, '.next/routes-manifest.json'))) {
    return extractNextJsRoutes(projectDir);
  }
  if (frameworkInfo.type === 'nitro' && fs.existsSync(path.join(projectDir, '.output'))) {
    return extractNitroRoutes(projectDir);
  }
  return extractUniversalRoutes(projectDir, frameworkInfo);
}

function ensureBuilt(frameworkInfo, projectDir) {
  const isMonorepo = frameworkInfo.category === 'decoupled-monorepo';
  const targetDir = isMonorepo ? frameworkInfo.frontendDir : projectDir;
  scanAndWarnHardcodedUrls(targetDir);

  const needsBuild = isMonorepo
    ? !frameworkInfo.staticDir || !fs.existsSync(frameworkInfo.staticDir)
    : (!frameworkInfo.serverDir || !fs.existsSync(frameworkInfo.serverDir)) &&
      (!frameworkInfo.staticDir || !fs.existsSync(frameworkInfo.staticDir));

  if (needsBuild && fs.existsSync(path.join(targetDir, 'package.json'))) {
    console.log(`🔨 Building ${frameworkInfo.name} for production...`);
    try {
      execSync('npm run build', {
        cwd: targetDir,
        stdio: 'inherit',
        env: {
          ...process.env,
          NODE_ENV: 'production',
          NEXT_PRIVATE_STANDALONE: 'true',
          VITE_API_URL: process.env.VITE_API_URL || '',
          NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || ''
        }
      });
      if (isMonorepo) frameworkInfo.staticDir = path.join(targetDir, 'dist');
    } catch (e) {
      console.warn(`⚠ Build command finished with code ${e.status || 1}`);
    }
  }
}

function getSecretToken(projectDir) {
  if (process.env.BESTOF2_SECRET) return process.env.BESTOF2_SECRET;
  const secretPath = path.join(projectDir, '.bestof2/secret');
  if (fs.existsSync(secretPath)) {
    return fs.readFileSync(secretPath, 'utf8').trim();
  }
  const token = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(secretPath), { recursive: true });
    fs.writeFileSync(secretPath, token, 'utf8');
  } catch {}
  return token;
}

function hasAwsConfig(options) {
  return !!(
    options.endpointUrl ||
    process.env.AWS_ENDPOINT_URL ||
    (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
    fs.existsSync(path.join(os.homedir(), '.aws/credentials'))
  );
}

function scanAndWarnHardcodedUrls(targetDir) {
  const srcDir = path.join(targetDir, 'src');
  if (!fs.existsSync(srcDir)) return;
  try {
    const files = fs.readdirSync(srcDir, { recursive: true });
    for (const f of files) {
      if (/\.(jsx?|tsx?|vue|svelte)$/.test(f)) {
        const content = fs.readFileSync(path.join(srcDir, f), 'utf8');
        if (/http:\/\/(localhost|127\.0\.0\.1):(3000|4000|5000|8080)/i.test(content)) {
          console.log(`💡 [BestOf2 Notice]: Detected hardcoded localhost API in ${f}. Use relative '/api' for zero-CORS auto-routing.`);
          break;
        }
      }
    }
  } catch {}
}

function printSummary({ mode, framework, url, backendUrl, secretToken, hasAws }) {
  console.log(`------------------------------------------------------------`);
  console.log(`🎉 Deployment Complete!`);
  if (url) console.log(`🌐 Production URL:    ${url}`);
  if (backendUrl) {
    console.log(`⚡ Backend URL:       ${backendUrl} ${hasAws ? '(100% Shielded)' : ''}`);
  }
  if (secretToken) {
    console.log(`🛡️ Secret Handshake:  ${secretToken.slice(0, 6)}...${secretToken.slice(-6)} (256-bit Crypto Hex)`);
  }
  console.log(`⚡ Mode:              ${mode} (${framework})`);
  console.log(`------------------------------------------------------------\n`);
}

module.exports = { deploy };
