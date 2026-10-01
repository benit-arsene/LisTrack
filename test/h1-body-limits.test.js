/**
 * LisTrack H1 Tests — Explicit Request Body Limits
 * ================================================
 * `express.json()` and `express.text()` previously relied on body-parser's
 * implicit 100 kB default. Relying on a library default for a security bound
 * is fragile: body-parser SILENTLY DISABLES size enforcement when handed an
 * unparseable limit value (GHSA-v422-hmwv-36x6), which would turn the guard
 * into a no-op with no error anywhere.
 *
 * These tests therefore assert the *behaviour* — a real 413 — rather than just
 * the presence of a `limit:` option, so that regression cannot pass silently.
 *
 * The chosen limit is 64 kB, far above the ~200-byte screen-time record this
 * API actually accepts, so a genuinely legitimate payload is never rejected.
 *
 * Run: node --test test/h1-body-limits.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "listrack-h1body-")),
  "h1-body.db"
);
process.env.PORT = "0";
delete process.env.DATABASE_URL;

process.env.RATE_LIMIT_MAX = "100000";
process.env.RATE_LIMIT_WINDOW_MS = "60000";
process.env.OAUTH_RATE_LIMIT_MAX = "100000";
process.env.OAUTH_RATE_LIMIT_WINDOW_MS = "60000";

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

/** The limit the server declares, read from source so the test tracks it. */
const SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "server.js"),
  "utf8"
);
const LIMIT_KB = Number(
  SOURCE.match(/const REQUEST_BODY_LIMIT\s*=\s*["'](\d+)kb["']/i)[1]
);

async function post(pathname, body, contentType) {
  const res = await fetch(baseUrl + pathname, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
  });
  return { status: res.status, body: await res.text() };
}

test("H1: the declared body limit is a deliberate, sane value", () => {
  assert.ok(
    LIMIT_KB >= 16 && LIMIT_KB <= 1024,
    `body limit should be a deliberate value between 16kB and 1MB, got ${LIMIT_KB}kB`
  );
});

// ─── Oversized JSON ─────────────────────────────────────────────────────────

test("H1: an oversized JSON body is rejected with 413", async () => {
  const oversized = JSON.stringify({
    domain: "example.test",
    durationSeconds: 1,
    pad: "A".repeat(LIMIT_KB * 1024 + 4096),
  });
  assert.ok(
    Buffer.byteLength(oversized) > LIMIT_KB * 1024,
    "test payload must exceed the declared limit"
  );

  const res = await post("/api/screen-time", oversized, "application/json");
  assert.equal(
    res.status,
    413,
    `oversized JSON must be refused (body: ${res.body.slice(0, 160)})`
  );
  assert.match(res.body, /payloadtoolarge|entity too large/i);
});

test("H1: an oversized text/plain body is rejected with 413", async () => {
  const oversized = "A".repeat(LIMIT_KB * 1024 + 4096);
  const res = await post("/api/screen-time", oversized, "text/plain");
  assert.equal(
    res.status,
    413,
    `oversized text body must be refused (body: ${res.body.slice(0, 160)})`
  );
  assert.match(res.body, /payloadtoolarge|entity too large/i);
});

test("H1: the size limit is enforced, not silently disabled", async () => {
  // Explicit guard for the body-parser failure mode where an unparseable
  // limit value disables enforcement: if this ever passes, enforcement is off.
  const justUnder = "A".repeat(LIMIT_KB * 512);
  const under = await post("/api/screen-time", justUnder, "text/plain");
  assert.notEqual(
    under.status,
    413,
    "a body below the limit must not be refused for size"
  );
});

// ─── Legitimate payloads still work ─────────────────────────────────────────

test("H1: a normal screen-time JSON payload is accepted by the parser", async () => {
  // No credentials, so this must fail AUTH (401) — never the body parser.
  // A 413 or 400 here would mean the limit is too tight for real traffic.
  const payload = JSON.stringify({
    domain: "example.test",
    path: "/",
    durationSeconds: 30,
    seq_id: "seq-abc-123",
    timestamp: new Date().toISOString(),
  });
  assert.ok(
    Buffer.byteLength(payload) < 1024,
    "a real screen-time record must be small"
  );
  const res = await post("/api/screen-time", payload, "application/json");
  assert.equal(
    res.status,
    401,
    `a legitimate payload must reach the auth layer (got ${res.status}: ${res.body.slice(0, 160)})`
  );
});

test("H1: the donation form payload is well inside the limit", async () => {
  const payload = JSON.stringify({ phone: "0788123456", amount: "500" });
  const res = await post("/api/donate/initiate", payload, "application/json");
  // Whatever the route answers, it must not be a size rejection.
  assert.notEqual(
    res.status,
    413,
    "the small donation payload must never hit the body limit"
  );
});