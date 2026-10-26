const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
require('dotenv').config();

const {
  LambdaWebClient,
  CreateWebFunctionCommand,
  CreateWebFunctionRevisionCommand,
  GetWebFunctionCommand,
  GetWebFunctionEndpointCommand
} = require('@aws-sdk/client-lambda-web');

const {
  S3Client,
  PutObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand
} = require('@aws-sdk/client-s3');

/**
 * Creates a clean production zip bundle from a server directory (standalone Next.js or Nitro).
 * @param {string} serverDir - Path to server directory (.next/standalone or .output/server)
 * @param {string} outputZipPath - Destination .zip file path
 */
function createServerZip(serverDir, outputZipPath, secretToken) {
  const absServerDir = path.resolve(serverDir);
  const absOutputZip = path.resolve(outputZipPath);

  if (!fs.existsSync(absServerDir)) {
    throw new Error(`Server directory not found: ${absServerDir}`);
  }

  // 1. Next.js standalone static asset linking (official standalone convention)
  if (path.basename(absServerDir) === 'standalone') {
    const parentNextDir = path.dirname(absServerDir);
    const staticSource = path.join(parentNextDir, 'static');
    const staticDest = path.join(absServerDir, '.next', 'static');
    if (fs.existsSync(staticSource) && !fs.existsSync(staticDest)) {
      try {
        fs.cpSync(staticSource, staticDest, { recursive: true });
        console.log(`✔ Copied .next/static into standalone distribution`);
      } catch (e) {
        // Non-critical if copy fails
      }
    }

    const projectDir = path.dirname(parentNextDir);
    const publicSource = path.join(projectDir, 'public');
    const publicDest = path.join(absServerDir, 'public');
    if (fs.existsSync(publicSource) && !fs.existsSync(publicDest)) {
      try {
        fs.cpSync(publicSource, publicDest, { recursive: true });
        console.log(`✔ Copied public assets into standalone distribution`);
      } catch (e) {
        // Non-critical
      }
    }
  }

  // 2. Ensure entrypoint index.js exists for Node.js runtime in Lambda Web Functions
  const serverJsPath = path.join(absServerDir, 'server.js');
  const indexJsPath = path.join(absServerDir, 'index.js');
  const indexMjsPath = path.join(absServerDir, 'index.mjs');

  const shieldCode = `
// =========================================================================
// BestOf2 Security Shield: Strict Edge Token Enforcement
// Direct requests to raw Lambda Web Function URL without valid handshake
// are strictly blocked with 403 Forbidden.
// =========================================================================
const http = require('http');
const EXPECTED_SECRET = ${secretToken ? `process.env.BESTOF2_SECRET || ${JSON.stringify(secretToken)}` : `""`};

if (EXPECTED_SECRET) {
  const origEmit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (type, req, res) {
    if (type === 'request') {
      const clientSecret = req.headers['x-bestof2-secret'];
      if (!clientSecret || clientSecret !== EXPECTED_SECRET) {
        res.writeHead(403, {
          'Content-Type': 'application/json',
          'X-BestOf2-Shield': 'Blocked'
        });
        res.end(JSON.stringify({
          error: '403 Forbidden',
          reason: 'Direct access to raw Lambda Web Function is blocked by BestOf2 Shield',
          message: 'Direct requests without the x-bestof2-secret handshake header are forbidden. Traffic must pass through Cloudflare Pages Edge Router.'
        }));
        return true;
      }
    }
    return origEmit.apply(this, arguments);
  };
}
`;

  if (fs.existsSync(serverJsPath)) {
    // Next.js standalone entrypoint bridge
    const bridgeContent = `// Auto-generated entrypoint bridge for AWS Lambda Web Functions by bestof2
${shieldCode}
if (process.env.AWS_LAMBDA_HTTP_ENDPOINT) {
  const [host, port] = process.env.AWS_LAMBDA_HTTP_ENDPOINT.split(':');
  if (host) process.env.HOSTNAME = host;
  if (port) process.env.PORT = port;
} else {
  process.env.HOSTNAME = process.env.HOSTNAME || '0.0.0.0';
  process.env.PORT = process.env.PORT || '3000';
}

require('./server.js');
`;
    fs.writeFileSync(indexJsPath, bridgeContent, 'utf8');
    console.log(`🛡️ Generated Next.js Lambda Web entrypoint bridge with BestOf2 Security Shield`);
  } else if (fs.existsSync(path.join(absServerDir, 'build/server/index.js'))) {
    // React Router v7 / Remix entrypoint bridge
    const remixBridgeContent = `// Auto-generated entrypoint bridge for AWS Lambda Web Functions by bestof2 (React Router / Remix)
import http from 'node:http';

const EXPECTED_SECRET = ${secretToken ? `process.env.BESTOF2_SECRET || ${JSON.stringify(secretToken)}` : `""`};

if (EXPECTED_SECRET) {
  const origEmit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (type, req, res) {
    if (type === 'request') {
      const clientSecret = req.headers['x-bestof2-secret'];
      if (!clientSecret || clientSecret !== EXPECTED_SECRET) {
        res.writeHead(403, {
          'Content-Type': 'application/json',
          'X-BestOf2-Shield': 'Blocked'
        });
        res.end(JSON.stringify({
          error: '403 Forbidden',
          reason: 'Direct access to raw Lambda Web Function is blocked by BestOf2 Shield',
          message: 'Direct requests without the x-bestof2-secret handshake header are forbidden. Traffic must pass through Cloudflare Pages Edge Router.'
        }));
        return true;
      }
    }
    return origEmit.apply(this, arguments);
  };
}

let host = '0.0.0.0';
let port = 3000;
if (process.env.AWS_LAMBDA_HTTP_ENDPOINT) {
  const parts = process.env.AWS_LAMBDA_HTTP_ENDPOINT.split(':');
  if (parts[0]) host = parts[0];
  if (parts[1]) port = parseInt(parts[1], 10);
} else if (process.env.PORT) {
  port = parseInt(process.env.PORT, 10);
}
if (process.env.HOSTNAME) host = process.env.HOSTNAME;

async function start() {
  const express = (await import('express')).default;
  const build = await import('./build/server/index.js');
  let createHandler;
  try {
    const rr = await import('@react-router/express');
    createHandler = rr.createRequestHandler;
  } catch (e) {
    const rx = await import('@remix-run/express');
    createHandler = rx.createRequestHandler;
  }
  const app = express();
  try {
    app.all('/{*splat}', createHandler({ build }));
  } catch (e) {
    app.all('*', createHandler({ build }));
  }
  
  app.listen(port, host, () => {
    console.log('✔ React Router / Remix SSR Web Function listening on ' + host + ':' + port);
  });
}

start().catch(err => {
  console.error('Failed to start React Router / Remix server:', err);
  process.exit(1);
});
`;
    fs.writeFileSync(path.join(absServerDir, 'bestof2-server.mjs'), remixBridgeContent, 'utf8');
    fs.writeFileSync(path.join(absServerDir, 'index.mjs'), `import('./bestof2-server.mjs');\n`, 'utf8');
    fs.writeFileSync(path.join(absServerDir, 'index.js'), remixBridgeContent, 'utf8');
    console.log(`🛡️ Generated React Router / Remix Lambda Web entrypoint bridge with BestOf2 Security Shield`);
  } else if (fs.existsSync(indexMjsPath)) {
    // Nitro / Nuxt entrypoint bridge (Native ESM)
    const nitroShieldCode = `
// =========================================================================
// BestOf2 Security Shield: Strict Edge Token Enforcement
// Direct requests to raw Lambda Web Function URL without valid handshake
// are strictly blocked with 403 Forbidden.
// =========================================================================
import http from 'node:http';
const EXPECTED_SECRET = ${secretToken ? `process.env.BESTOF2_SECRET || ${JSON.stringify(secretToken)}` : `""`};

if (EXPECTED_SECRET) {
  const origEmit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (type, req, res) {
    if (type === 'request') {
      const clientSecret = req.headers['x-bestof2-secret'];
      if (!clientSecret || clientSecret !== EXPECTED_SECRET) {
        res.writeHead(403, {
          'Content-Type': 'application/json',
          'X-BestOf2-Shield': 'Blocked'
        });
        res.end(JSON.stringify({
          error: '403 Forbidden',
          reason: 'Direct access to raw Lambda Web Function is blocked by BestOf2 Shield',
          message: 'Direct requests without the x-bestof2-secret handshake header are forbidden. Traffic must pass through Cloudflare Pages Edge Router.'
        }));
        return true;
      }
    }
    return origEmit.apply(this, arguments);
  };
}
`;
    const bridgeContent = `// Auto-generated entrypoint bridge for AWS Lambda Web Functions by bestof2 (Nitro / Nuxt)
${nitroShieldCode}
if (process.env.AWS_LAMBDA_HTTP_ENDPOINT) {
  const [host, port] = process.env.AWS_LAMBDA_HTTP_ENDPOINT.split(':');
  if (host) process.env.NITRO_HOST = host;
  if (port) process.env.NITRO_PORT = port;
}
import('./index.mjs');
`;
    fs.writeFileSync(indexJsPath, bridgeContent, 'utf8');
    console.log(`🛡️ Generated Nitro/Nuxt Lambda Web entrypoint bridge with BestOf2 Security Shield`);
  } else if (fs.existsSync(path.join(absServerDir, 'server/adapter-index.js')) || (fs.existsSync(path.join(absServerDir, 'handler.js')) && fs.existsSync(indexJsPath))) {
    // SvelteKit (Node Adapter) entrypoint bridge
    const svelteKitShieldCode = `
// =========================================================================
// BestOf2 Security Shield: Strict Edge Token Enforcement
// Direct requests to raw Lambda Web Function URL without valid handshake
// are strictly blocked with 403 Forbidden.
// =========================================================================
import http from 'node:http';
const EXPECTED_SECRET = ${secretToken ? `process.env.BESTOF2_SECRET || ${JSON.stringify(secretToken)}` : `""`};

if (EXPECTED_SECRET) {
  const origEmit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (type, req, res) {
    if (type === 'request') {
      const clientSecret = req.headers['x-bestof2-secret'];
      if (!clientSecret || clientSecret !== EXPECTED_SECRET) {
        res.writeHead(403, {
          'Content-Type': 'application/json',
          'X-BestOf2-Shield': 'Blocked'
        });
        res.end(JSON.stringify({
          error: '403 Forbidden',
          reason: 'Direct access to raw Lambda Web Function is blocked by BestOf2 Shield',
          message: 'Direct requests without the x-bestof2-secret handshake header are forbidden. Traffic must pass through Cloudflare Pages Edge Router.'
        }));
        return true;
      }
    }
    return origEmit.apply(this, arguments);
  };
}
`;
    const svelteBridgeContent = `// Auto-generated entrypoint bridge for AWS Lambda Web Functions by bestof2 (SvelteKit)
${svelteKitShieldCode}
if (process.env.AWS_LAMBDA_HTTP_ENDPOINT) {
  const [host, port] = process.env.AWS_LAMBDA_HTTP_ENDPOINT.split(':');
  if (host) process.env.HOST = host;
  if (port) process.env.PORT = port;
}
import('./server/adapter-index.js');
`;
    fs.writeFileSync(indexJsPath, svelteBridgeContent, 'utf8');
    console.log(`🛡️ Generated SvelteKit Lambda Web entrypoint bridge with BestOf2 Security Shield`);
  } else if (fs.existsSync(path.join(absServerDir, 'dist/server/entry.mjs'))) {
    // Astro (Node Standalone Adapter) entrypoint bridge
    const astroShieldCode = `
// =========================================================================
// BestOf2 Security Shield: Strict Edge Token Enforcement
// Direct requests to raw Lambda Web Function URL without valid handshake
// are strictly blocked with 403 Forbidden.
// =========================================================================
import http from 'node:http';
const EXPECTED_SECRET = ${secretToken ? `process.env.BESTOF2_SECRET || ${JSON.stringify(secretToken)}` : `""`};

if (EXPECTED_SECRET) {
  const origEmit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (type, req, res) {
    if (type === 'request') {
      const clientSecret = req.headers['x-bestof2-secret'];
      if (!clientSecret || clientSecret !== EXPECTED_SECRET) {
        res.writeHead(403, {
          'Content-Type': 'application/json',
          'X-BestOf2-Shield': 'Blocked'
        });
        res.end(JSON.stringify({
          error: '403 Forbidden',
          reason: 'Direct access to raw Lambda Web Function is blocked by BestOf2 Shield',
          message: 'Direct requests without the x-bestof2-secret handshake header are forbidden. Traffic must pass through Cloudflare Pages Edge Router.'
        }));
        return true;
      }
    }
    return origEmit.apply(this, arguments);
  };
}
`;
    const astroBridgeContent = `// Auto-generated entrypoint bridge for AWS Lambda Web Functions by bestof2 (Astro SSR)
${astroShieldCode}
if (process.env.AWS_LAMBDA_HTTP_ENDPOINT) {
  const [host, port] = process.env.AWS_LAMBDA_HTTP_ENDPOINT.split(':');
  if (host) process.env.HOST = host;
  if (port) process.env.PORT = port;
}
import('./dist/server/entry.mjs');
`;
    fs.writeFileSync(indexJsPath, astroBridgeContent, 'utf8');
    console.log(`🛡️ Generated Astro SSR Lambda Web entrypoint bridge with BestOf2 Security Shield`);
  }

  // 3. Ensure package.json has "main": "index.js"
  const pkgPath = path.join(absServerDir, 'package.json');
  try {
    let pkg = {};
    if (fs.existsSync(pkgPath)) {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    }
    pkg.main = 'index.js';
    const isEsmProject = fs.existsSync(path.join(absServerDir, 'build/server/index.js')) ||
      fs.existsSync(indexMjsPath) ||
      fs.existsSync(path.join(absServerDir, 'dist/server/entry.mjs')) ||
      fs.existsSync(path.join(absServerDir, 'server/adapter-index.js'));
    if (isEsmProject && !pkg.type) {
      pkg.type = 'module';
    }
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf8');
    console.log(`✔ Configured package.json entrypoint: "main": "index.js"`);
  } catch (e) {
    // Non-critical
  }

  const zipDir = path.dirname(absOutputZip);
  fs.mkdirSync(zipDir, { recursive: true });
  if (fs.existsSync(absOutputZip)) {
    fs.unlinkSync(absOutputZip);
  }

  let zipExcludes = '';
  if (fs.existsSync(path.join(absServerDir, 'build/server/index.js'))) {
    zipExcludes = [
      '-x "build/client/*"',
      '-x ".bestof2/*"',
      '-x ".git/*"',
      '-x "node_modules/.vite/*"',
      '-x "node_modules/vite/*"',
      '-x "node_modules/typescript/*"',
      '-x "node_modules/@tailwindcss/*"',
      '-x "node_modules/tailwindcss/*"',
      '-x "node_modules/@react-router/dev/*"',
      '-x "node_modules/.cache/*"'
    ].join(' ');
  } else if (fs.existsSync(path.join(absServerDir, 'dist/server/entry.mjs'))) {
    zipExcludes = [
      '-x "dist/client/*"',
      '-x ".bestof2/*"',
      '-x ".git/*"',
      '-x "node_modules/.cache/*"',
      '-x "node_modules/.vite/*"',
      '-x "node_modules/vite/*"',
      '-x "node_modules/@astrojs/compiler/*"',
      '-x "node_modules/typescript/*"'
    ].join(' ');
  } else if (fs.existsSync(path.join(absServerDir, 'server/adapter-index.js'))) {
    zipExcludes = '-x "client/*" -x ".bestof2/*" -x ".git/*" -x "node_modules/.cache/*"';
  } else {
    zipExcludes = '-x ".bestof2/*" -x ".git/*" -x "node_modules/.cache/*"';
  }

  console.log(`📦 Packaging server bundle into zip archive: ${path.basename(absOutputZip)}...`);
  execSync(`cd "${absServerDir}" && zip -rq "${absOutputZip}" . ${zipExcludes}`, { stdio: 'pipe' });
  const stat = fs.statSync(absOutputZip);
  console.log(`✔ Zip bundle created: ${(stat.size / (1024 * 1024)).toFixed(2)} MB`);

  return absOutputZip;
}

/**
 * Deploys an HTTP server directly to AWS Lambda Web Functions via @aws-sdk/client-lambda-web.
 * Native HTTP serverless with multi-concurrency (128 conns/instance) and active-CPU billing.
 * Zero event adapters or Lambda triggers required!
 *
 * @param {object} options
 * @param {string} options.functionName - Name of the Web Function
 * @param {string} [options.zipPath] - Path to .zip bundle
 * @param {string} [options.serverDir] - Path to server directory to auto-zip
 * @param {string} [options.secretToken] - BestOf2 shared secret token
 * @param {string} [options.bucketName] - S3 deployment bucket
 * @param {string} [options.roleArn] - IAM Execution Role ARN
 * @param {string} [options.runtime] - Web Function runtime (default: nodejs24.x)
 * @param {string} [options.region] - AWS region (default: us-east-1)
 * @returns {Promise<string>} Web Function endpoint URL
 */
async function deployToLambda({
  functionName = 'bestof2-backend',
  zipPath,
  serverDir,
  secretToken = process.env.BESTOF2_SECRET,
  bucketName = process.env.AWS_DEPLOYMENT_BUCKET || process.env.BESTOF2_BUCKET || 'bestof2',
  roleArn = process.env.AWS_ROLE_ARN,
  runtime = process.env.AWS_LAMBDA_RUNTIME || 'nodejs24.x',
  region = process.env.AWS_DEFAULT_REGION || process.env.AWS_REGION || 'us-east-1',
  timeoutSeconds = 60,
  maxConcurrency = 100,
  envVars = {}
} = {}) {
  // Auto-zip if serverDir is passed and no zipPath specified
  if (!zipPath && serverDir && fs.existsSync(serverDir)) {
    const tempZip = path.join(serverDir, '../bestof2-bundle.zip');
    zipPath = createServerZip(serverDir, tempZip, secretToken);
  }

  if (!zipPath || !fs.existsSync(zipPath)) {
    throw new Error(`Deployment zip not found at: ${zipPath}`);
  }

  console.log(`\n⚡ Deploying AWS Lambda Web Function '${functionName}' via JS SDK (@aws-sdk/client-lambda-web)...`);

  // Credentials are automatically loaded from process.env, .env, or ~/.aws/credentials
  const clientConfig = { region };
  const s3 = new S3Client(clientConfig);
  const lambdaWeb = new LambdaWebClient(clientConfig);

  // 1. Ensure S3 Bucket exists
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucketName }));
  } catch (err) {
    console.log(`📦 S3 bucket '${bucketName}' not found, attempting auto-creation...`);
    try {
      await s3.send(new CreateBucketCommand({ Bucket: bucketName }));
      console.log(`✔ Created S3 deployment bucket: ${bucketName}`);
    } catch (createErr) {
      throw new Error(`S3 deployment bucket '${bucketName}' does not exist and could not be created: ${createErr.message}. Please create the bucket in AWS S3 Console.`);
    }
  }

  // Ensure bucket policy allows lambda.amazonaws.com to pull the zip
  try {
    const { PutBucketPolicyCommand } = require('@aws-sdk/client-s3');
    await s3.send(new PutBucketPolicyCommand({
      Bucket: bucketName,
      Policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{
          Sid: 'LambdaWebFunctionS3Read',
          Effect: 'Allow',
          Principal: { Service: 'lambda.amazonaws.com' },
          Action: ['s3:GetObject', 's3:GetObjectVersion'],
          Resource: `arn:aws:s3:::${bucketName}/*`
        }]
      })
    }));
  } catch (policyErr) {
    // Ignore if already set
  }

  // 2. Upload deployment zip to S3
  const s3Key = `builds/${functionName}-${Date.now()}.zip`;
  console.log(`🚀 Uploading server bundle to s3://${bucketName}/${s3Key}...`);
  const zipBuffer = fs.readFileSync(zipPath);
  const uploadRes = await s3.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: s3Key,
    Body: zipBuffer
  }));
  const versionId = uploadRes.VersionId;
  console.log(`✔ Artifact uploaded to S3 successfully${versionId ? ` (Version: ${versionId})` : ''}.`);

  // 3. Resolve Execution Role ARN
  let resolvedRoleArn = roleArn;
  if (!resolvedRoleArn) {
    try {
      const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');
      const sts = new STSClient(clientConfig);
      const identity = await sts.send(new GetCallerIdentityCommand({}));
      resolvedRoleArn = `arn:aws:iam::${identity.Account}:role/bestof2-lambda-role`;
    } catch (e) {
      resolvedRoleArn = 'arn:aws:iam::618042350291:role/bestof2-lambda-role';
    }
  }

  // 4. Create or Update Web Function
  let webFunctionExists = false;
  try {
    await lambdaWeb.send(new GetWebFunctionCommand({ functionName }));
    webFunctionExists = true;
  } catch (err) {
    if (err.name !== 'ResourceNotFoundException') {
      // Ignore not found, rethrow others
    }
  }

  const s3ObjectConfig = {
    bucket: bucketName,
    key: s3Key
  };
  if (versionId) s3ObjectConfig.versionId = versionId;

  let endpointDomain = null;

  const resolvedEnv = {
    NODE_ENV: 'production',
    ...(envVars || {})
  };
  if (secretToken) {
    resolvedEnv.BESTOF2_SECRET = secretToken;
  }

  if (!webFunctionExists) {
    console.log(`🌐 Creating new Lambda Web Function '${functionName}' (${runtime}, ${maxConcurrency} max concurrency, ${timeoutSeconds}s timeout)...`);
    const createRes = await lambdaWeb.send(new CreateWebFunctionCommand({
      functionName: functionName,
      revisionConfig: {
        buildConfig: {
          codeConfig: {
            s3Object: s3ObjectConfig
          },
          runtimeConfig: {
            runtime: runtime
          }
        },
        serviceConfig: {
          executionRoleArn: resolvedRoleArn,
          maxConcurrencyPerEnvironment: Number.isInteger(maxConcurrency) ? maxConcurrency : 100,
          timeoutSeconds: Number.isInteger(timeoutSeconds) ? timeoutSeconds : 60,
          environmentVariables: resolvedEnv
        }
      },
      endpointConfig: {
        endpointName: 'default',
        endpointType: 'HomeRegion',
        authType: 'ApplicationManaged', // Native HTTP traffic (Zero 403 on public / Cloudflare routing)
        autoDeploymentMode: 'LatestRevision'
      }
    }));

    if (createRes.endpoint && createRes.endpoint.domainName) {
      endpointDomain = createRes.endpoint.domainName;
    }
    console.log(`✔ Created AWS Lambda Web Function: ${functionName}`);
  } else {
    console.log(`🔄 Deploying new revision to Web Function '${functionName}'...`);
    const revRes = await lambdaWeb.send(new CreateWebFunctionRevisionCommand({
      functionName: functionName,
      buildConfig: {
        codeConfig: {
          s3Object: s3ObjectConfig
        },
        runtimeConfig: {
          runtime: runtime
        }
      },
      serviceConfig: {
        executionRoleArn: resolvedRoleArn,
        maxConcurrencyPerEnvironment: Number.isInteger(maxConcurrency) ? maxConcurrency : 100,
        timeoutSeconds: Number.isInteger(timeoutSeconds) ? timeoutSeconds : 60,
        environmentVariables: resolvedEnv
      }
    }));
    const newRevId = revRes.revisionId;
    console.log(`✔ Created revision ${newRevId || ''}, waiting for activation...`);

    if (newRevId) {
      const { GetWebFunctionRevisionCommand } = require('@aws-sdk/client-lambda-web');
      let attempts = 0;
      while (attempts < 30) {
        await new Promise(r => setTimeout(r, 2000));
        attempts++;
        try {
          const revCheck = await lambdaWeb.send(new GetWebFunctionRevisionCommand({
            functionName,
            revisionId: newRevId
          }));
          if (revCheck.state === 'Active') {
            console.log(`✔ Revision ${newRevId} is Active!`);
            break;
          } else if (revCheck.state === 'Failed') {
            throw new Error(`Revision ${newRevId} failed: ${revCheck.stateReason || 'Unknown error'}`);
          }
        } catch (pollErr) {
          if (pollErr.name !== 'ResourceNotFoundException') throw pollErr;
        }
      }
    }
    console.log(`✔ Deployed new revision to: ${functionName}`);
  }

  // 5. Retrieve Web Function Endpoint URL
  if (!endpointDomain) {
    const endpointRes = await lambdaWeb.send(new GetWebFunctionEndpointCommand({
      functionName: functionName,
      endpointName: 'default'
    }));
    endpointDomain = endpointRes.domainName;
  }

  if (!endpointDomain) {
    throw new Error('Failed to retrieve Web Function endpoint domain name');
  }

  const endpointUrl = `https://${endpointDomain}`.replace(/\/$/, '');
  console.log(`✔ Lambda Web Function active at: ${endpointUrl}`);

  return endpointUrl;
}

module.exports = { deployToLambda, createServerZip };
