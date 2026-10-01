/**
 * LisTrack H1 Tests — Rate-Limiting Foundation
 * ===========================================
 * Proves the H1 request-throttling layer:
 *
 *   1. A global limiter is mounted ahead of body parsers, routes, and any
 *      authentication work.
 *   2. Requests below the threshold are unaffected (no false positives against
 *      normal extension/dashboard traffic).
 *   3. Repeated requests are eventually rejected with 429.
 *   4. Standard RateLimit-* headers are emitted, and Retry-After accompanies a
 *      rejection.
 *   5. The window actually slides, so a client is not locked out forever.
 *   6. Proxy trust is configured, without trusting an unbounded chain.
 *
 * Limits are shrunk via the documented environment knobs so this file never
 * has to issue hundreds of requests to observe a 429, and so it never touches
 * production. node --test runs each test file in its own process, so these
 * environment values cannot leak into any other suite.
 *
 * Run: node --test test/h1-rate-limit.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Configure BEFORE requiring the server: the limiters read these once at
// module load. A short window keeps the "window slides" test fast.
process.env.DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "listrack-h1rate-")),
  "h1-rate.db"
);
process.env.PORT = "0";
delete process.env.DATABASE_URL; // force the SQLite driver

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 1_000;
process.env.RATE_LIMIT_MAX = String(RATE_LIMIT_MAX);
process.env.RATE_LIMIT_WINDOW_MS = String(RATE_LIMIT_WINDOW_MS);
// The OAuth limiter is exercised in h1-oauth-amplification.test.js; keep it
// out of the way here so these assertions isolate the GLOBAL limiter.
process.env.OAUTH_RATE_LIMIT_MAX = "10000";

const ROOT = path.join(__dirname, "..");
const SOURCE = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

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

async function get(urlPath, headers = {}) {
  const res = await fetch(baseUrl + urlPath, { headers });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The limiter's store is process-wide and keyed by client IP, and every test
 * in this file shares one 127.0.0.1 client. Tests that count requests must
 * therefore start from a full budget, so wait out the window first.
 */
async function resetBudget() {
  await sleep(RATE_LIMIT_WINDOW_MS + 250);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Configuration is present and correctly ordered (static)
// ═══════════════════════════════════════════════════════════════════════════

test("H1: proxy trust is configured as a fixed hop count, not unbounded", () => {
  assert.match(
    SOURCE,
    /app\.set\(\s*["']trust proxy["']\s*,\s*1\s*\)/,
    "server must set trust proxy to a single hop for the Render proxy"
  );
  // `true` would let a client spoof X-Forwarded-For and escape the limiter.
  assert.doesNotMatch(
    SOURCE,
    /app\.set\(\s*["']trust proxy["']\s*,\s*true\s*\)/,
    "trust proxy must not be enabled for the entire X-Forwarded-For chain"
  );
});

test("H1: the global limiter is mounted before body parsers, static and routes", () => {
  const at = (re) => {
    const m = SOURCE.search(re);
    assert.notEqual(m, -1, `missing expected middleware: ${re}`);
    return m;
  };
  const trustProxy = at(/app\.set\(\s*["']trust proxy["']/);
  const limiter = at(/app\.use\(globalLimiter\)/);
  const jsonParser = at(/express\.json\(/);
  const staticMount = at(/express\.static\(/);
  const dashboard = at(/app\.get\(\s*["']\/dashboard["']/);

  assert.ok(
    trustProxy < limiter,
    "trust proxy must be set before the limiter is created/mounted"
  );
  assert.ok(
    limiter < jsonParser,
    "the global limiter must run before body parsers buffer request bodies"
  );
  assert.ok(limiter < staticMount, "the global limiter must cover static assets");
  assert.ok(
    limiter < dashboard,
    "the global limiter must run before any route handler"
  );
});

test("H1: every limiter uses standard headers, not the legacy form", () => {
  const limiters = [...SOURCE.matchAll(/rateLimit\(\s*\{[\s\S]*?\}\s*\)/g)].map(
    (m) => m[0]
  );
  assert.ok(limiters.length >= 2, "expected a global and an OAuth limiter");
  for (const cfg of limiters) {
    assert.match(
      cfg,
      /standardHeaders:\s*true/,
      "each limiter must emit standard RateLimit-* headers"
    );
    assert.match(
      cfg,
      /legacyHeaders:\s*false/,
      "each limiter must suppress the deprecated X-RateLimit-* headers"
    );
    assert.match(cfg, /limit:/, "each limiter must set an explicit limit");
    assert.match(cfg, /windowMs:/, "each limiter must set an explicit window");
  }
});

test("H1: body parsers declare an explicit, non-empty size limit", () => {
  // Guards GHSA-v422-hmwv-36x6: body-parser silently DISABLES enforcement
  // when handed an unparseable limit value, turning this into a no-op.
  const parsers = [...SOURCE.matchAll(/express\.(json|text)\(([^)]*)\)/g)];
  assert.equal(parsers.length, 2, "expected json and text parsers");
  for (const [, kind, args] of parsers) {
    assert.match(
      args,
      /limit:\s*[A-Za-z_][A-Za-z0-9_]*|\d+/,
      `express.${kind} must declare an explicit limit`
    );
  }
  // The constant itself must be a real size string, not an empty/garbage value.
  assert.match(
    SOURCE,
    /const REQUEST_BODY_LIMIT\s*=\s*["']\d+(kb|mb|b)["']/i,
    "REQUEST_BODY_LIMIT must be a parseable body-parser size string"
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Behaviour — requests below the threshold keep working
// ═══════════════════════════════════════════════════════════════════════════

test("H1: requests below the limit are served normally", async () => {
  // Landing page + a static asset + a protected route (401 is the *auth*
  // answer, not a throttle answer — both prove the request got through).
  const root = await get("/");
  assert.equal(root.status, 200, "landing page must be served normally");

  const asset = await get("/js/tracker.js");
  assert.equal(asset.status, 200, "static asset must be served normally");

  const api = await get("/api/dashboard");
  assert.equal(api.status, 401, "protected route must still answer 401, not 429");
});

test("H1: responses below the limit carry standard RateLimit headers", async () => {
  const res = await get("/");
  assert.equal(res.status, 200);
  // express-rate-limit emits the RFC-draft RateLimit-* family.
  const limit = res.headers.get("ratelimit-limit");
  assert.ok(limit, "RateLimit-Limit header must be present");
  assert.ok(
    res.headers.get("ratelimit-remaining") !== null,
    "RateLimit-Remaining header must be present"
  );
  assert.ok(
    res.headers.get("ratelimit-reset") !== null,
    "RateLimit-Reset header must be present"
  );
  assert.equal(
    res.headers.get("x-ratelimit-limit"),
    null,
    "legacy X-RateLimit-* headers must be suppressed"
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Behaviour — the limit is enforced, then released
// ═══════════════════════════════════════════════════════════════════════════

test("H1: repeated requests are eventually rejected with 429 + Retry-After", async () => {
  await resetBudget();

  let sawThrottle = false;
  let retryAfter = null;
  let limitedAt = -1;

  // Drive well past the configured ceiling.
  for (let i = 0; i < RATE_LIMIT_MAX + 4; i++) {
    const res = await get("/");
    if (res.status === 429) {
      sawThrottle = true;
      retryAfter = res.headers.get("retry-after");
      limitedAt = i;
      break;
    }
  }

  assert.ok(sawThrottle, "repeated requests must eventually be throttled");
  assert.ok(
    limitedAt >= RATE_LIMIT_MAX - 1,
    `throttling began at request ${limitedAt + 1}, before the ${RATE_LIMIT_MAX} limit was exhausted`
  );

  assert.ok(
    retryAfter !== null && /^\d+$/.test(retryAfter),
    `429 must include a numeric Retry-After header, got ${retryAfter}`
  );
  const retrySeconds = Number(retryAfter);
  assert.ok(
    retrySeconds > 0 && retrySeconds <= Math.ceil(RATE_LIMIT_WINDOW_MS / 1000),
    `Retry-After (${retrySeconds}s) must fall inside the ${RATE_LIMIT_WINDOW_MS}ms window`
  );

  // A throttled response is a clean rejection, not an application payload.
  const throttled = await get("/");
  assert.equal(throttled.status, 429);
  assert.match(
    throttled.headers.get("content-type") || "",
    /application\/json/
  );
  assert.match(throttled.body, /too many requests/i);
});

test("H1: the window slides — a client is not locked out permanently", async () => {
  await resetBudget();

  // Exhaust the budget.
  for (let i = 0; i < RATE_LIMIT_MAX + 2; i++) await get("/");
  const blocked = await get("/");
  assert.equal(blocked.status, 429, "budget should be exhausted");

  // Wait out the window, then confirm normal service resumes.
  await sleep(RATE_LIMIT_WINDOW_MS + 250);
  const after = await get("/");
  assert.equal(
    after.status,
    200,
    "requests must be served again once the window has elapsed"
  );
});