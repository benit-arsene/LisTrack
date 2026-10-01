/**
 * LisTrack H1 Tests — OAuth Attempt Limiter
 * =========================================
 * The negative cache only helps when the SAME invalid token is replayed. An
 * attacker with a token generator instead presents a DIFFERENT invalid
 * credential on every request, which defeats any per-token cache. This suite
 * proves the second line of defence: a dedicated, much tighter limiter in
 * front of Google tokeninfo verification caps how many distinct credentials
 * can be verified per window.
 *
 * It owns a deliberately small budget, so it lives in its own file —
 * node --test runs each test file in a separate process, and therefore with a
 * separate limiter store. That keeps the budget from starving other suites.
 *
 * Google is NEVER contacted: globalThis.fetch is stubbed and every tokeninfo
 * call is counted locally.
 *
 * Run: node --test test/h1-oauth-limiter.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "listrack-h1limit-")),
  "h1-limit.db"
);
process.env.PORT = "0";
delete process.env.DATABASE_URL;

process.env.RATE_LIMIT_MAX = "100000";
process.env.RATE_LIMIT_WINDOW_MS = "60000";
const OAUTH_MAX = 4;
process.env.OAUTH_RATE_LIMIT_MAX = String(OAUTH_MAX);
process.env.OAUTH_RATE_LIMIT_WINDOW_MS = "60000";

const TOKENINFO = "https://oauth2.googleapis.com/tokeninfo";
const realFetch = globalThis.fetch;
let googleCalls = 0;

globalThis.fetch = function (input, init) {
  const url = typeof input === "string" ? input : String(input && input.url);
  if (!url.startsWith(TOKENINFO)) return realFetch(input, init);
  googleCalls++;
  return Promise.resolve({ ok: false, json: async () => ({}) });
};

let server;
let baseUrl;

test.before(async () => {
  const { start } = require("../server");
  server = await start();
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  globalThis.fetch = realFetch;
  if (server) await new Promise((r) => server.close(r));
  fs.rmSync(path.dirname(process.env.DATABASE_PATH), {
    recursive: true,
    force: true,
  });
});

/** A distinct, syntactically plausible but fake token each call. */
const fakeToken = (seed) =>
  `ya29.${"A".repeat(20)}${String(seed).repeat(20)}.${"b".repeat(20)}`;

async function withBearer(token) {
  const res = await fetch(`${baseUrl}/api/dashboard`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

test("H1: distinct invalid tokens are capped by the OAuth attempt limiter", async () => {
  googleCalls = 0;
  const statuses = [];

  for (let i = 0; i < OAUTH_MAX + 5; i++) {
    const res = await withBearer(fakeToken(`d${i}`));
    statuses.push(res.status);
    if (res.status === 429) {
      assert.match(
        res.headers.get("content-type") || "",
        /application\/json/,
        "throttle response must be JSON"
      );
      assert.match(
        res.body,
        /too many authentication attempts/i,
        "throttle body must explain itself"
      );
      assert.ok(
        res.headers.get("retry-after"),
        "throttle response must include Retry-After"
      );
      break;
    }
  }

  const throttledAt = statuses.indexOf(429);
  assert.notEqual(throttledAt, -1, "distinct invalid tokens must be throttled");
  assert.ok(
    throttledAt >= OAUTH_MAX - 1,
    `throttling began at attempt ${throttledAt + 1}, before the budget of ${OAUTH_MAX} was exhausted`
  );

  // The decisive property: the limiter stops attempts BEFORE they all reach
  // Google. Without it, N attempts would mean N tokeninfo calls.
  assert.ok(
    googleCalls <= OAUTH_MAX,
    `Google must be called at most ${OAUTH_MAX} times; saw ${googleCalls}`
  );
});

test("H1: the OAuth limiter is mounted ahead of token verification", async () => {
  const fsx = require("node:fs");
  const source = fsx.readFileSync(
    path.join(__dirname, "..", "server.js"),
    "utf8"
  );

  // /dashboard must be wrapped, not merely documented.
  assert.match(
    source,
    /app\.get\(\s*["']\/dashboard["']\s*,\s*oauthVerificationLimiter\s*,/,
    "/dashboard must run the OAuth limiter before its handler"
  );

  // requireAuth must delegate through the limiter before authenticating.
  assert.match(
    source,
    /function requireAuth[\s\S]{0,400}?oauthVerificationLimiter\(req,\s*res/,
    "requireAuth must run the OAuth limiter before authenticating"
  );

  // And the skip predicate must keep credential-free traffic out of the bucket.
  assert.match(
    source,
    /skip:\s*\(req\)\s*=>\s*!isGoogleVerificationCandidate\(req\)/,
    "the OAuth limiter must skip requests that present no credential"
  );
});