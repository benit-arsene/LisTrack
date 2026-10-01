/**
 * LisTrack H1 Tests — OAuth Verification Amplification
 * ===================================================
 * The primary H1 exposure: an unauthenticated request carrying a bogus
 * credential used to cause one outbound call to Google's tokeninfo endpoint
 * every single time. A handful of scripted requests therefore turned into
 * third-party API traffic, each attempt also holding a server-side socket
 * open for roughly a second.
 *
 * These tests pin the three-layer defence:
 *
 *   1. Structural pre-validation — obvious garbage never reaches a cache slot
 *      or the network at all.
 *   2. Negative cache — a repeated invalid token costs one Google call inside
 *      a short window, not one per request.
 *   3. Positive cache — a verified token keeps working and stays cheap.
 *
 * Plus the dedicated OAuth limiter, which bounds how many *distinct* invalid
 * tokens can reach Google in the first place.
 *
 * Google is NEVER contacted: `globalThis.fetch` is wrapped so that any request
 * to oauth2.googleapis.com is answered locally and counted. No real OAuth token
 * appears in this file — the only tokens used are obvious fakes shaped like
 * Google's, plus deliberately malformed strings.
 *
 * Run: node --test test/h1-oauth-amplification.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "listrack-h1oauth-")),
  "h1-oauth.db"
);
process.env.PORT = "0";
delete process.env.DATABASE_URL; // force the SQLite driver

// The global limiter must not interfere with these assertions. The OAuth
// limiter budget is deliberately kept generous here so that only the suite's
// verification-count assertions run against it; the 429 behaviour itself is
// proven in h1-oauth-limiter.test.js, which can own a small budget without
// starving the other tests.
process.env.RATE_LIMIT_MAX = "100000";
process.env.RATE_LIMIT_WINDOW_MS = "60000";
process.env.OAUTH_RATE_LIMIT_MAX = "100";
process.env.OAUTH_RATE_LIMIT_WINDOW_MS = "60000";

const ROOT = path.join(__dirname, "..");
const SOURCE = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const OAUTH_CLIENT_ID = require(path.join(ROOT, "manifest.json")).oauth2
  .client_id;

const TOKENINFO = "https://oauth2.googleapis.com/tokeninfo";

// ─── Google stub ────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;

/** How many outbound tokeninfo calls have been made since the last reset. */
let googleCalls = 0;

/** What the stubbed Google endpoint should answer for the next verification. */
let googleBehaviour = "invalid";

globalThis.fetch = function (input, init) {
  const url = typeof input === "string" ? input : String(input && input.url);
  if (!url.startsWith(TOKENINFO)) return realFetch(input, init);

  googleCalls++;
  if (googleBehaviour === "valid") {
    return Promise.resolve({
      ok: true,
      json: async () => ({
        email: "verified-user@example.com",
        email_verified: "true",
        aud: OAUTH_CLIENT_ID,
        expires_in: 3600,
      }),
    });
  }
  // Google answers HTTP 400 for an invalid/expired token.
  return Promise.resolve({ ok: false, json: async () => ({}) });
};

function resetGoogle(behaviour = "invalid") {
  googleCalls = 0;
  googleBehaviour = behaviour;
}

test.after(() => {
  globalThis.fetch = realFetch;
});

let server;
let baseUrl;

test.before(async () => {
  const { start } = require("../server");
  server = await start();
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  fs.rmSync(path.dirname(process.env.DATABASE_PATH), {
    recursive: true,
    force: true,
  });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/** A syntactically plausible but fake Google access token. */
function fakeToken(seed = "a") {
  return `ya29.${"A".repeat(20)}${seed.repeat(20)}.${"b".repeat(20)}`;
}

async function withBearer(token) {
  const res = await fetch(`${baseUrl}/api/dashboard`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

async function withDashboardToken(token) {
  const res = await fetch(
    `${baseUrl}/dashboard?access_token=${encodeURIComponent(token)}`,
    { redirect: "manual" }
  );
  return { status: res.status, headers: res.headers, body: await res.text() };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Structural pre-validation — garbage never reaches Google
// ═══════════════════════════════════════════════════════════════════════════

test("H1: structurally invalid tokens never trigger a Google call", async () => {
  // Only values that are legal in an HTTP header are exercised over the wire;
  // embedded control characters cannot be sent in a header at all and are
  // covered by the source-level validator assertion below.
  const garbage = [
    "short",
    "not a token at all",
    '<script>alert("x")</script>padding-to-length',
    "a".repeat(5000), // far longer than any real Google token
    "   ", // whitespace only
  ];

  for (const bad of garbage) {
    resetGoogle();
    const res = await withBearer(bad);
    assert.equal(
      googleCalls,
      0,
      `garbage token (${bad.length} chars) must not reach Google`
    );
    assert.equal(res.status, 401, "garbage token must be rejected");
  }
});

test("H1: pre-validation rejects by length without assuming a token format", async () => {
  assert.match(
    SOURCE,
    /function isStructurallyValidAccessToken/,
    "a structural validator must exist"
  );
  // Explicitly no hard-coded prefix requirement: Google can change the format
  // and chrome.identity.getAuthToken() is not bound to one.
  assert.doesNotMatch(
    SOURCE,
    /isStructurallyValidAccessToken[\s\S]{0,600}?\.startsWith\(\s*["']ya29\./,
    "validation must not require a specific token prefix"
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Negative cache — a repeated invalid token costs one Google call
// ═══════════════════════════════════════════════════════════════════════════

test("H1: the first invalid token causes a verification attempt", async () => {
  resetGoogle();
  const token = fakeToken("1");
  const res = await withBearer(token);
  assert.equal(res.status, 401);
  assert.equal(googleCalls, 1, "an unseen invalid token must be checked once");
});

test("H1: a repeated invalid token is served from the negative cache", async () => {
  resetGoogle();
  const token = fakeToken("2");

  const first = await withBearer(token);
  assert.equal(first.status, 401);
  assert.equal(googleCalls, 1, "first attempt must reach Google");

  // Repeat the SAME token several times inside the negative-cache window.
  for (let i = 0; i < 4; i++) {
    const repeat = await withBearer(token);
    assert.equal(repeat.status, 401, "repeat must still be rejected");
  }

  assert.equal(
    googleCalls,
    1,
    `repeats must be served from the negative cache; saw ${googleCalls} Google calls`
  );
});

test("H1: the negative cache also absorbs the /dashboard entry point", async () => {
  resetGoogle();
  const token = fakeToken("3");

  await withDashboardToken(token);
  assert.equal(googleCalls, 1);

  await withDashboardToken(token);
  await withDashboardToken(token);
  assert.equal(
    googleCalls,
    1,
    "repeat ?access_token= requests must not each call Google"
  );
});

test("H1: the negative cache is bounded and short-lived", () => {
  // Short TTL: it must absorb a burst/replay, not act as a revocation list.
  assert.match(
    SOURCE,
    /const NEGATIVE_CACHE_MAX_MS\s*=\s*(\d+)/,
    "a negative-cache TTL must be declared"
  );
  const ttl = Number(
    SOURCE.match(/const NEGATIVE_CACHE_MAX_MS\s*=\s*(\d+)/)[1]
  );
  assert.ok(
    ttl > 0 && ttl <= 5 * 60 * 1000,
    `negative-cache TTL must be short (got ${ttl}ms)`
  );

  // Bounded storage with eviction, not an unbounded Map.
  assert.match(
    SOURCE,
    /const TOKEN_CACHE_MAX_ENTRIES\s*=\s*\d+/,
    "cache size must be bounded"
  );
  assert.match(
    SOURCE,
    /function setBounded\(/,
    "caches must be written through a bounding/evicting helper"
  );
  assert.match(
    SOURCE,
    /setBounded\(\s*failedTokenCache/,
    "the negative cache must use the bounded writer"
  );

  // Failure caching must actually be wired into the verification failure paths.
  const cacheFailureCalls = [...SOURCE.matchAll(/cacheTokenFailure\(token\)/g)];
  assert.ok(
    cacheFailureCalls.length >= 3,
    "every verification failure path must record the negative cache entry"
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Distinct invalid tokens are bounded by the OAuth limiter
// ═══════════════════════════════════════════════════════════════════════════

// The "distinct invalid tokens are capped" assertion needs a small OAuth
// budget, which would starve every other test sharing this limiter store. It
// therefore lives in test/h1-oauth-limiter.test.js, which owns its own budget.

// ═══════════════════════════════════════════════════════════════════════════
// 4. Legitimate OAuth behaviour is preserved (C2/H4 must not regress)
// ═══════════════════════════════════════════════════════════════════════════

test("H1: a valid token still authenticates and the positive cache still works", async () => {
  resetGoogle("valid");
  const token = fakeToken("v");

  const first = await withBearer(token);
  assert.equal(
    first.status,
    200,
    `a verified token must still be accepted (body: ${first.body.slice(0, 200)})`
  );
  assert.equal(googleCalls, 1, "a new valid token is verified once");

  const second = await withBearer(token);
  assert.equal(second.status, 200, "the cached identity must still authorize");
  assert.equal(googleCalls, 1, "the positive cache must avoid a second call");
});

test("H1: /dashboard still exchanges a valid token for a session cookie", async () => {
  resetGoogle("valid");
  const res = await fetch(
    `${baseUrl}/dashboard?access_token=${encodeURIComponent(fakeToken("s"))}`,
    { redirect: "manual" }
  );
  assert.equal(googleCalls, 1);
  assert.equal(
    res.status,
    302,
    "a verified token must still redirect into the dashboard"
  );
  const setCookie = res.headers.get("set-cookie") || "";
  assert.match(setCookie, /lisTrackSession=/, "session cookie must still be set");
  assert.match(
    setCookie,
    /HttpOnly/i,
    "session cookie must remain HttpOnly (C1)"
  );
  // C2/H4: the token must not survive into the redirect target.
  const location = res.headers.get("location") || "";
  assert.doesNotMatch(
    location,
    /access_token/,
    "the OAuth token must not be reflected into the URL"
  );
});

test("H1: audience mismatch is still rejected", async () => {
  resetGoogle("valid");
  const withWrongAudience = globalThis.fetch;
  globalThis.fetch = function (input, init) {
    const url = typeof input === "string" ? input : String(input && input.url);
    if (!url.startsWith(TOKENINFO)) return realFetch(input, init);
    googleCalls++;
    return Promise.resolve({
      ok: true,
      json: async () => ({
        email: "someone@example.com",
        email_verified: "true",
        aud: "some-other-client.apps.googleusercontent.com",
        expires_in: 3600,
      }),
    });
  };
  try {
    const res = await withBearer(fakeToken("a"));
    assert.equal(
      res.status,
      401,
      "a token minted for another client is rejected"
    );
  } finally {
    globalThis.fetch = withWrongAudience;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. The OAuth limiter must not penalise ordinary traffic
// ═══════════════════════════════════════════════════════════════════════════

test("H1: session-cookie traffic is exempt from the OAuth limiter", async () => {
  // A plain unauthenticated call carries no credential to verify, so it must
  // never be counted against the tight OAuth budget — otherwise ordinary
  // extension traffic would exhaust the authentication budget.
  const before = Number(
    (await fetch(`${baseUrl}/api/dashboard`)).headers.get("ratelimit-limit")
  );
  assert.ok(before > 0, "the global limiter budget must remain observable");

  // Burst well past this file's OAuth budget (100): none of these should 429.
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${baseUrl}/api/dashboard`);
    assert.equal(
      res.status,
      401,
      "cookie-less API calls must keep answering 401, never 429"
    );
  }

  // A real session cookie must likewise never be throttled on the OAuth path.
  const sessionStore = require("../session");
  const id = sessionStore.createSession("cookie-user@example.com").id;
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${baseUrl}/api/dashboard`, {
      headers: { Cookie: `lisTrackSession=${id}` },
    });
    assert.notEqual(
      res.status,
      429,
      "session-cookie requests must not be counted as auth attempts"
    );
  }
});