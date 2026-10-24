const fs = require('fs');
const path = require('path');

/**
 * Generates the Cloudflare Pages Edge Router (_worker.js) dynamically
 * with the detected server routes and secret token handshake.
 */
function generateEdgeWorker({ backendUrl, dynamicPatterns, secretToken, framework = 'fullstack' }) {
  const patternsJson = JSON.stringify(dynamicPatterns || []);

  const workerCode = `// Auto-generated BestOf2 Cloudflare Pages Edge Router (_worker.js)
// Framework: ${framework}
// Target Backend: ${backendUrl}

const DYNAMIC_PATTERNS = ${patternsJson}.map(p => new RegExp(p));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Rule 1: Always route mutations (POST, PUT, DELETE, PATCH) or Server Action headers to Backend
    const isMutation = request.method !== "GET" && request.method !== "HEAD";
    const isServerAction = request.headers.has("next-action") || request.headers.has("x-tanstack-start-server-fn");
    const isExplicitServerRoute = DYNAMIC_PATTERNS.some(regex => regex.test(url.pathname));

    if (isMutation || isServerAction || isExplicitServerRoute) {
      return proxyToBackend(request, url, env);
    }

    // Rule 2: Static Asset Probe - Served directly from Cloudflare Pages 330+ Edge Locations ($0 bandwidth)
    const asset = await env.ASSETS.fetch(request);
    if (asset.status < 400) {
      return asset;
    }

    // Rule 3: Dynamic SSR / Uncached Fallback -> Proxy to Backend
    return proxyToBackend(request, url, env);
  }
};

async function proxyToBackend(request, url, env) {
  const backendBase = (env && env.BACKEND_URL) || "${backendUrl}";
  if (!backendBase) {
    return new Response(
      JSON.stringify({
        error: "503 Service Unavailable",
        reason: "Backend Target Not Configured",
        message: "No backend service is wired to this edge router. Set BACKEND_URL environment variable."
      }),
      { status: 503, headers: { "content-type": "application/json", "x-bestof2-routed-by": "cloudflare-pages-edge" } }
    );
  }
  const targetUrl = new URL(url.pathname + url.search, backendBase);

  const headers = new Headers(request.headers);
  headers.delete("host"); // Allow standard fetch to set Host header to targetUrl host
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));

  const secretToken = (env && env.BESTOF2_SECRET) || "${secretToken}";
  headers.set("x-bestof2-secret", secretToken);

  try {
    const response = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: headers,
      body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
      redirect: "manual"
    });

    const responseHeaders = new Headers(response.headers);
    responseHeaders.set("x-bestof2-routed-by", "cloudflare-pages-edge");
    responseHeaders.set("x-backend-framework", "${framework}");

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: "502 Bad Gateway",
        reason: "Backend Server Route Unreachable",
        message: "Backend server is currently stopped or unavailable. Cloudflare Pages edge is operational.",
        target: backendBase,
        details: err.message
      }),
      {
        status: 502,
        headers: {
          "content-type": "application/json",
          "x-bestof2-routed-by": "cloudflare-pages-edge"
        }
      }
    );
  }
}
`;

  return workerCode;
}

module.exports = { generateEdgeWorker };
