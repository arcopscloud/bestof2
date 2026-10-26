const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { loadConfig, DEFAULT_CONFIG } = require('../src/commands/deploy');
const { generateEdgeWorker } = require('../src/router-generator');

const TEST_DIR = path.resolve(__dirname, 'scratch-config-test');

function runTests() {
  console.log(`\n🧪 Running BestOf2 Config & Routing Unit Tests...`);
  fs.mkdirSync(TEST_DIR, { recursive: true });

  try {
    // TEST 1: Default fallback when bestof2.json does not exist
    const emptyDir = path.join(TEST_DIR, 'empty');
    fs.mkdirSync(emptyDir, { recursive: true });
    const def = loadConfig(emptyDir);
    assert.strictEqual(def.limits.maxMonthlyInvocations, 500000);
    assert.strictEqual(def.limits.onLimitExceeded, 'stop');
    assert.strictEqual(def.backend.memoryMB, 256);
    assert.strictEqual(def.backend.timeoutSeconds, 60);
    assert.strictEqual(def.backend.maxConcurrency, 100);
    console.log(`  ✔ Test 1: Fallback to embedded defaults passed (60s timeout, 100 concurrency)`);

    // TEST 2: Load custom bestof2.json
    const customDir = path.join(TEST_DIR, 'custom');
    fs.mkdirSync(customDir, { recursive: true });
    fs.writeFileSync(
      path.join(customDir, 'bestof2.json'),
      JSON.stringify({
        limits: { maxMonthlyInvocations: 2000000, onLimitExceeded: 'payg' },
        backend: { memoryMB: 512, timeoutSeconds: 90, maxConcurrency: 128 }
      })
    );
    const custom = loadConfig(customDir);
    assert.strictEqual(custom.limits.maxMonthlyInvocations, 2000000);
    assert.strictEqual(custom.limits.onLimitExceeded, 'payg');
    assert.strictEqual(custom.backend.memoryMB, 512);
    assert.strictEqual(custom.backend.timeoutSeconds, 90);
    assert.strictEqual(custom.backend.maxConcurrency, 128);
    console.log(`  ✔ Test 2: Custom bestof2.json loaded passed`);

    // TEST 3: Edge Worker code generation
    const workerCode = generateEdgeWorker({
      backendUrl: 'https://backend.test.on.aws',
      dynamicPatterns: ['^/api/.*$'],
      secretToken: 'sec-123',
      framework: 'Next.js'
    });
    assert.ok(workerCode.includes('proxyToBackend'), 'Must have proxyToBackend');
    assert.ok(workerCode.includes('x-bestof2-secret'), 'Must have secret handshake');
    assert.ok(!workerCode.includes('/__bestof2/unlock'), 'No fake unlock routes in edge worker');
    console.log(`  ✔ Test 3: Clean edge router generation passed`);

    console.log(`🎉 All tests passed cleanly!\n`);
  } finally {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

runTests();
