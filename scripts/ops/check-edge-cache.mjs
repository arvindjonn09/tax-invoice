#!/usr/bin/env node
// #213: checks that Cloudflare never caches app pages or API responses, and
// that HSTS is on. Usage:
//   node scripts/ops/check-edge-cache.mjs https://jobflow.shivomsangha.com
// Optional signed-in check: JOBFLOW_EDGE_COOKIE_A and JOBFLOW_EDGE_COOKIE_B,
// each the Cookie header of a different synthetic or demo user. Cookies are
// read from the environment and never printed. Exits 1 on any failure.

const base = (process.argv[2] ?? "").replace(/\/+$/, "");
if (!/^https:\/\/[^/]+$/.test(base)) {
  console.error("Usage: node scripts/ops/check-edge-cache.mjs https://<host>");
  process.exit(2);
}

/** App pages and API routes that must never be cached at the edge. */
const PUBLIC_PATHS = [
  "/",
  "/signin",
  "/signup",
  "/forgot-password",
  "/terms",
  "/privacy",
  "/api/health",
  "/api/health/ready",
];
// Better Auth's session endpoint, and a signed-in page.
const SIGNED_IN_PATHS = ["/dashboard", "/api/auth/get-session"];

const failures = [];
const rows = [];

async function get(path, cookie) {
  const response = await fetch(base + path, {
    redirect: "manual",
    headers: cookie ? { cookie } : {},
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.text();
  return {
    status: response.status,
    cacheControl: response.headers.get("cache-control") ?? "",
    cfCache: response.headers.get("cf-cache-status") ?? "-",
    hsts: response.headers.get("strict-transport-security") ?? "",
    body,
  };
}

function checkPrivate(label, path, result) {
  const cc = result.cacheControl.toLowerCase();
  const ok =
    cc.includes("no-store") &&
    (cc.includes("private") || path.startsWith("/api/")) &&
    result.cfCache.toUpperCase() !== "HIT";
  rows.push(
    `${ok ? "ok  " : "FAIL"} ${label} ${path} ${result.status} cf=${result.cfCache} cache-control="${result.cacheControl}"`,
  );
  if (!ok) failures.push(`${label} ${path}: cacheable or served from the edge`);
  if (!result.hsts)
    failures.push(`${label} ${path}: no Strict-Transport-Security`);
}

// Twice each: a second request is where an edge cache would answer HIT.
for (const path of PUBLIC_PATHS) {
  await get(path);
  checkPrivate("anon", path, await get(path));
}

// A static asset should be cacheable: proves the cache rule isn't over-broad.
const page = await get("/signup");
const asset = page.body.match(/\/_next\/static\/[^"'\s\\]+\.(?:js|css)/)?.[0];
if (asset) {
  await get(asset);
  const result = await get(asset);
  const ok = /public/.test(result.cacheControl) && result.status === 200;
  rows.push(
    `${ok ? "ok  " : "WARN"} static ${asset.slice(0, 60)} ${result.status} cf=${result.cfCache} cache-control="${result.cacheControl}"`,
  );
} else {
  rows.push("WARN static: no /_next/static asset found on /signup");
}

const cookieA = process.env.JOBFLOW_EDGE_COOKIE_A;
const cookieB = process.env.JOBFLOW_EDGE_COOKIE_B;
if (cookieA && cookieB) {
  for (const path of SIGNED_IN_PATHS) {
    const a = await get(path, cookieA);
    const b = await get(path, cookieB);
    checkPrivate("user-a", path, a);
    checkPrivate("user-b", path, b);
    // B must never be handed A's response. Only compare real, signed-in pages.
    if (a.status === 200 && b.status === 200 && a.body === b.body) {
      failures.push(`${path}: user B received the same response as user A`);
      rows.push(`FAIL user-b ${path}: same body as user A`);
    }
  }
} else {
  rows.push(
    "skip signed-in checks: set JOBFLOW_EDGE_COOKIE_A and JOBFLOW_EDGE_COOKIE_B",
  );
}

console.log(`Edge cache check: ${base}  (${new Date().toISOString()})`);
for (const row of rows) console.log(row);
if (failures.length) {
  console.error(`\n${failures.length} failure(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("\nAll checks passed.");
