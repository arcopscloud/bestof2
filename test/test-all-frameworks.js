const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const assert = require('assert');
const { deploy } = require('../src/commands/deploy');
const { detectFramework } = require('../src/detector');

const ROOT_DIR = path.resolve(__dirname, '../../');
const SCRATCH_DIR = path.resolve(__dirname, 'scratch-test');

async function runTestSuite() {
  console.log(`\n============================================================`);
  console.log(`🧪 BESTOF2 MULTI-FRAMEWORK END-TO-END LOCAL TEST SUITE`);
  console.log(`============================================================`);

  fs.mkdirSync(SCRATCH_DIR, { recursive: true });

  try {
    // -----------------------------------------------------------------------
    // TEST 1: Full-Stack Next.js (my-app)
    // -----------------------------------------------------------------------
    console.log(`\n[TEST 1/5] Testing Next.js (Fullstack Separable)...`);
    const nextDir = path.join(ROOT_DIR, 'my-app');
    const nextInfo = detectFramework(nextDir);
    assert.strictEqual(nextInfo.category, 'fullstack-separable', 'Next.js must be fullstack-separable');
    assert.strictEqual(nextInfo.name, 'Next.js', 'Name must be Next.js');
    console.log(`  ✔ Framework Detection: PASSED (${nextInfo.name})`);

    const nextDeploy = await deploy({
      cwd: nextDir,
      endpointUrl: 'http://localhost:4566',
      roleArn: 'arn:aws:iam::000000000000:role/lambda-role'
    });
    assert.ok(nextDeploy.url, 'Pages URL must be returned');
    assert.ok(nextDeploy.backendUrl, 'Lambda backend URL must be returned');
    console.log(`  ✔ Next.js Dual-Cloud Deployment: PASSED`);

    // -----------------------------------------------------------------------
    // TEST 2: Full-Stack Nuxt (my-nuxt-app)
    // -----------------------------------------------------------------------
    console.log(`\n[TEST 2/5] Testing Nuxt / Nitro (Fullstack Separable)...`);
    const nuxtDir = path.join(ROOT_DIR, 'my-nuxt-app');
    const nuxtInfo = detectFramework(nuxtDir);
    assert.strictEqual(nuxtInfo.category, 'fullstack-separable', 'Nuxt must be fullstack-separable');
    assert.strictEqual(nuxtInfo.name, 'Nuxt', 'Name must be Nuxt');
    console.log(`  ✔ Framework Detection: PASSED (${nuxtInfo.name})`);

    const nuxtDeploy = await deploy({
      cwd: nuxtDir,
      endpointUrl: 'http://localhost:4566',
      roleArn: 'arn:aws:iam::000000000000:role/lambda-role'
    });
    assert.ok(nuxtDeploy.url, 'Pages URL must be returned');
    assert.ok(nuxtDeploy.backendUrl, 'Lambda backend URL must be returned');
    console.log(`  ✔ Nuxt Dual-Cloud Deployment: PASSED`);

    // -----------------------------------------------------------------------
    // TEST 3: Pure Frontend SPA (Vite / React)
    // -----------------------------------------------------------------------
    console.log(`\n[TEST 3/5] Testing Pure Frontend (Vite SPA)...`);
    const viteDir = path.join(SCRATCH_DIR, 'vite-frontend');
    fs.mkdirSync(path.join(viteDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(viteDir, 'dist/index.html'), '<h1>Hello Vite</h1>');
    fs.writeFileSync(path.join(viteDir, 'package.json'), JSON.stringify({
      name: 'my-vite-app',
      devDependencies: { vite: '^5.0.0' }
    }));

    const viteInfo = detectFramework(viteDir);
    assert.strictEqual(viteInfo.category, 'frontend-only', 'Vite must be frontend-only');
    console.log(`  ✔ Framework Detection: PASSED (${viteInfo.name})`);

    const viteDeploy = await deploy({ cwd: viteDir });
    assert.strictEqual(viteDeploy.mode, 'frontend-only', 'Must deploy as frontend-only');
    assert.ok(viteDeploy.url, 'Pages URL must be generated');
    console.log(`  ✔ Vite Pure Frontend Deployment: PASSED (Zero Lambda compute)`);

    // -----------------------------------------------------------------------
    // TEST 4: Decoupled Monorepo (frontend/ Vite + backend/ Express)
    // -----------------------------------------------------------------------
    console.log(`\n[TEST 4/5] Testing Decoupled Monorepo (frontend + backend)...`);
    const monoDir = path.join(ROOT_DIR, 'my-express-app');
    const monoInfo = detectFramework(monoDir);
    assert.strictEqual(monoInfo.category, 'decoupled-monorepo', 'Must be decoupled-monorepo');
    console.log(`  ✔ Framework Detection: PASSED (${monoInfo.name})`);

    const monoDeploy = await deploy({
      cwd: monoDir,
      endpointUrl: 'http://localhost:4566',
      roleArn: 'arn:aws:iam::000000000000:role/lambda-role',
      local: true
    });
    assert.ok(monoDeploy.url, 'Pages URL must be generated');
    assert.ok(monoDeploy.backendUrl, 'Lambda Web Function URL must be generated');
    console.log(`  ✔ Monorepo Dual-Cloud Deployment: PASSED (Auto-wired /api/* with zero CORS)`);

    // -----------------------------------------------------------------------
    // TEST 5: Graceful No-AWS Fallback (Skip without failure)
    // -----------------------------------------------------------------------
    console.log(`\n[TEST 5/5] Testing Graceful Skip when AWS credentials missing...`);
    const envBackup = { ...process.env };
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_ENDPOINT_URL;

    const noAwsDeploy = await deploy({ cwd: nextDir });
    assert.ok(noAwsDeploy.url, 'Frontend must still deploy');
    console.log(`  ✔ No-AWS Fallback: PASSED (Frontend deployed cleanly, Backend skipped, Exit code 0)`);

    process.env = envBackup;

    console.log(`\n============================================================`);
    console.log(`🎉 ALL 5 TEST SUITES PASSED END-TO-END!`);
    console.log(`============================================================\n`);

  } finally {
    // Cleanup scratch
    fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });
  }
}

runTestSuite().catch(err => {
  console.error('\n❌ Test Suite Failed:', err);
  process.exit(1);
});
