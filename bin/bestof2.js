#!/usr/bin/env node

const { deploy } = require('../src/commands/deploy');

deploy().catch(err => {
  console.error('\n❌ Deployment failed:', err.message);
  process.exit(1);
});
