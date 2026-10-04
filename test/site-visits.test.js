/**
 * LisTrack Site Visits Tests — server-side storage for engaged visits
 * ===================================================================
 * Focused tests for POST /api/site-visits and the site_visits table:
 *
 *   - an authenticated valid visit is stored
 *   - identity comes ONLY from req.authenticatedUser (never the body)
 *   - the domain is normalized and nothing else about the page is kept
 *   - an invalid domain or visit_id is rejected
 *   - (user_id, visit_id) is unique, and two users may share a visit_id
 *   - /api/screen-time is unchanged
 *
 * Uses Node's built-in node:test runner (no new dependency):
 *     node --test test/site-visits.test.js
 *
 * Runs against a real Express instance backed by a throwaway SQLite file in
 * os.tmpdir(), so nothing in the project's data/ directory is touched.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Point the SQLite driver at a scratch file before server.js is required.
const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "listrack-visittest-")),
  "visits-test.db",
);
process.env.DATABASE_PATH = TMP_DB;
process.env.PORT = "0";
delete process.env.DATABASE_URL; // force the SQLite driver

const sessionStore = require("../session");

let server;
let baseUrl;
let getSiteVisitsForUser;

const USER_A = "alice@example.com";
const USER_B = "bob@example.com";

/** Boot the real server once for the whole file. */
test.before(async () => {
  const mod = require("../server");
  server = await mod.start();
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  getSiteVisitsForUser = mod.getSiteVisitsForUser;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true });
});

// ─── Helpers ───────────────────────────────────────────────────────────────

const cookieHeader = (id) => `lisTrackSession=${id}`;

/** POST /api/site-visits as the given user. */
async function postVisit(user, body) {
  const id = sessionStore.createSession(user).id;
  const res = await fetch(`${baseUrl}/api/site-visits`, {
    method: "POST",
    headers: { Cookie: cookieHeader(id), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = text;
    }
  }
  return { status: res.status, data };
}

/** POST /api/site-visits with an explicit header set (for auth tests). */
async function rawVisit(body, headers) {
  const res = await fetch(`${baseUrl}/api/site-visits`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = text;
    }
  }
  return { status: res.status, data };
}

const asUser = (user, extra) => ({
  Cookie: cookieHeader(sessionStore.createSession(user).id),
  "Content-Type": "application/json",
  ...extra,
});

let visitCounter = 0;
const nextVisitId = () => `visit-${Date.now()}-${++visitCounter}`;

// ─── Happy path ─────────────────────────────────────────────────────────────

test("an authenticated valid visit is inserted successfully", async () => {
  const visitId = nextVisitId();
  const before = Date.now();
  const res = await postVisit(USER_A, { domain: "youtube.com", visit_id: visitId });

  assert.equal(res.status, 201);
  assert.equal(res.data.status, "ok");
  assert.ok(res.data.id, "the response carries the new row id");

  const rows = await getSiteVisitsForUser(USER_A);
  const row = rows.find((r) => r.visit_id === visitId);
  assert.ok(row, "the visit must be stored");
  assert.equal(row.user_id, USER_A, "owned by the authenticated user");
  assert.equal(row.domain, "youtube.com");
  assert.ok(row.visited_at, "a server-generated timestamp is stored");

  // The timestamp is the server's, not the client's.
  const stored = new Date(row.visited_at).getTime();
  assert.ok(
    stored >= before - 1000 && stored <= Date.now() + 1000,
    `visited_at must be server-generated (got ${row.visited_at})`,
  );
});

test("several visits accumulate as separate rows", async () => {
  const ids = [nextVisitId(), nextVisitId(), nextVisitId()];
  for (const visitId of ids) {
    const res = await postVisit(USER_A, { domain: "example.com", visit_id: visitId });
    assert.equal(res.status, 201);
  }
  const rows = await getSiteVisitsForUser(USER_A);
  for (const visitId of ids) {
    assert.ok(
      rows.some((r) => r.visit_id === visitId),
      `${visitId} must be stored`,
    );
  }
});

// ─── Authentication ─────────────────────────────────────────────────────────

test("an unauthenticated visit request is rejected", async () => {
  const res = await rawVisit(
    { domain: "youtube.com", visit_id: nextVisitId() },
    { "Content-Type": "application/json" },
  );
  assert.equal(res.status, 401);

  const garbage = await rawVisit(
    { domain: "youtube.com", visit_id: nextVisitId() },
    { Cookie: "lisTrackSession=" + "f".repeat(64), "Content-Type": "application/json" },
  );
  assert.equal(garbage.status, 401);
});

test("a forged user id in the body cannot change ownership", async () => {
  const visitId = nextVisitId();
  const res = await postVisit(USER_A, {
    domain: "youtube.com",
    visit_id: visitId,
    user_id: "victim@example.com",
    user: "victim@example.com",
    email: "victim@example.com",
    userToken: "forged",
  });

  assert.equal(res.status, 201, "the visit is still accepted — on OUR identity");
  const mine = (await getSiteVisitsForUser(USER_A)).filter((r) => r.visit_id === visitId);
  assert.equal(mine.length, 1, "stored under the authenticated user");
  assert.equal(mine[0].user_id, USER_A);

  const theirs = await getSiteVisitsForUser("victim@example.com");
  assert.equal(theirs.length, 0, "nothing was attributed to the forged identity");
});

test("no route reads identity from the visit request body", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = src.indexOf('app.post("/api/site-visits"');
  const end = src.indexOf('app.get("/api/dashboard"', start);
  assert.ok(start !== -1 && end > start, "the visit route must exist");
  const code = src
    .slice(start, end)
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");

  for (const forbidden of [
    /payload\.user\b/,
    /payload\.user_id\b/,
    /payload\.email\b/,
    /payload\.userToken\b/,
    /body\.user\b/,
    /body\.user_id\b/,
    /body\.email\b/,
  ]) {
    assert.ok(!forbidden.test(code), `the visit route must not read ${forbidden}`);
  }
  assert.match(code, /req\.authenticatedUser/, "identity must come from requireAuth");
});

// ─── Domain validation and normalization ───────────────────────────────────

test("an invalid or empty domain is rejected", async () => {
  const cases = [
    {},
    { domain: "" },
    { domain: "   " },
    { domain: "!!!" },
    { domain: "not a domain" },
    { domain: "..." },
    { domain: 42 },
    { domain: null },
    { domain: { host: "youtube.com" } },
  ];

  for (const body of cases) {
    const res = await postVisit(USER_A, { ...body, visit_id: nextVisitId() });
    assert.equal(res.status, 400, `${JSON.stringify(body.domain)} must be rejected`);
    assert.equal(res.data.status, "error");
  }
});

test("URL, path, query and hash input is not stored as the domain", async () => {
  const cases = [
    ["https://www.YouTube.com/watch?v=abc&t=30#frag", "youtube.com"],
    ["http://example.com/", "example.com"],
    ["https://news.example.co.uk/a/b/c?q=1", "news.example.co.uk"],
    ["https://example.com:8443/deep/path", "example.com"],
    ["  WWW.Example.com  ", "example.com"],
    ["gemini.google.com", "gemini.google.com"],
  ];

  for (const [input, expected] of cases) {
    const visitId = nextVisitId();
    const res = await postVisit(USER_A, { domain: input, visit_id: visitId });
    assert.equal(res.status, 201, `${input} must be accepted`);

    const row = (await getSiteVisitsForUser(USER_A)).find((r) => r.visit_id === visitId);
    assert.ok(row, `${input} must be stored`);
    assert.equal(row.domain, expected, `${input} must normalize to ${expected}`);
    assert.ok(!row.domain.includes("/"), "no path may be stored");
    assert.ok(!row.domain.includes("?"), "no query may be stored");
    assert.ok(!row.domain.includes("#"), "no hash may be stored");
  }
});

test("only the normalized domain is persisted — no page data", async () => {
  const visitId = nextVisitId();
  const res = await postVisit(USER_A, {
    domain: "https://www.youtube.com/watch?v=secret",
    visit_id: visitId,
    path: "/watch",
    url: "https://www.youtube.com/watch?v=secret",
    search: "?v=secret",
    hash: "#secret",
    title: "Secret Video Title",
    referrer: "https://facebook.com/feed",
  });
  assert.equal(res.status, 201);

  const row = (await getSiteVisitsForUser(USER_A)).find((r) => r.visit_id === visitId);
  assert.equal(row.domain, "youtube.com");

  // The stored row carries nothing beyond id/user/domain/visit_id/visited_at.
  assert.deepEqual(
    Object.keys(row).sort(),
    ["domain", "id", "user_id", "visit_id", "visited_at"],
    "no extra page data may be stored",
  );
  const serialized = JSON.stringify(row);
  for (const secret of ["secret", "Secret Video Title", "facebook", "/watch"]) {
    assert.ok(!serialized.includes(secret), `"${secret}" must not be stored`);
  }
});

test("localhost visits are ignored, mirroring the screen-time collector", async () => {
  const res = await postVisit(USER_A, {
    domain: "http://localhost:3000/dashboard",
    visit_id: nextVisitId(),
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.status, "ignored");
});

// ─── visit_id validation ───────────────────────────────────────────────────

test("an invalid visit_id is rejected", async () => {
  const cases = [
    undefined,
    null,
    "",
    "   ",
    42,
    {},
    [],
    "has space",
    "semi;colon",
    "quote'and\"quote",
    "a".repeat(129),
  ];

  for (const visitId of cases) {
    const res = await postVisit(USER_A, { domain: "youtube.com", visit_id: visitId });
    assert.equal(
      res.status,
      400,
      `visit_id ${JSON.stringify(visitId)} must be rejected`,
    );
  }
});

test("a missing domain or visit_id is a 400, not a 500", async () => {
  assert.equal((await postVisit(USER_A, { visit_id: nextVisitId() })).status, 400);
  assert.equal((await postVisit(USER_A, { domain: "youtube.com" })).status, 400);
});

test("malformed JSON is rejected with a 400, not a 500", async () => {
  // With Content-Type: application/json the body parser rejects the payload
  // before the route runs — the same behaviour /api/screen-time has.
  const res = await rawVisit("{not json", asUser(USER_A));
  assert.equal(res.status, 400);
});

test("a text/plain body carrying JSON is accepted, like the screen-time beacon path", async () => {
  const visitId = nextVisitId();
  const res = await rawVisit(
    JSON.stringify({ domain: "beacon.example.com", visit_id: visitId }),
    {
      Cookie: cookieHeader(sessionStore.createSession(USER_A).id),
      "Content-Type": "text/plain",
    },
  );
  assert.equal(res.status, 201);
  assert.equal(res.data.status, "ok");

  const row = (await getSiteVisitsForUser(USER_A)).find((r) => r.visit_id === visitId);
  assert.ok(row, "the string-body path must store the visit");
  assert.equal(row.domain, "beacon.example.com");
});

// ─── Idempotency ────────────────────────────────────────────────────────────

test("a duplicate (user_id, visit_id) does not create a second row", async () => {
  const visitId = nextVisitId();
  const first = await postVisit(USER_A, { domain: "youtube.com", visit_id: visitId });
  const second = await postVisit(USER_A, { domain: "youtube.com", visit_id: visitId });

  assert.equal(first.status, 201);
  assert.equal(first.data.status, "ok");
  assert.equal(second.status, 200);
  assert.equal(second.data.status, "duplicate");

  const rows = (await getSiteVisitsForUser(USER_A)).filter((r) => r.visit_id === visitId);
  assert.equal(rows.length, 1, "exactly one row per (user, visit_id)");
});

test("replaying a visit many times still stores exactly one row", async () => {
  const visitId = nextVisitId();
  for (let i = 0; i < 6; i++) {
    await postVisit(USER_A, { domain: "youtube.com", visit_id: visitId });
  }
  const rows = (await getSiteVisitsForUser(USER_A)).filter((r) => r.visit_id === visitId);
  assert.equal(rows.length, 1);
});

test("a duplicate with a different domain keeps the first stored row", async () => {
  const visitId = nextVisitId();
  await postVisit(USER_A, { domain: "youtube.com", visit_id: visitId });
  const second = await postVisit(USER_A, {
    domain: "different.example.com",
    visit_id: visitId,
  });
  assert.equal(second.data.status, "duplicate");

  const row = (await getSiteVisitsForUser(USER_A)).find((r) => r.visit_id === visitId);
  assert.equal(row.domain, "youtube.com", "a duplicate must not overwrite anything");
});

test("two different users can use the same visit_id without conflicting", async () => {
  const sharedId = nextVisitId();

  const a = await postVisit(USER_A, { domain: "youtube.com", visit_id: sharedId });
  const b = await postVisit(USER_B, { domain: "youtube.com", visit_id: sharedId });

  assert.equal(a.status, 201);
  assert.equal(b.status, 201, "the same visit_id must be free for another user");
  assert.equal(b.data.status, "ok");

  const rowsA = (await getSiteVisitsForUser(USER_A)).filter((r) => r.visit_id === sharedId);
  const rowsB = (await getSiteVisitsForUser(USER_B)).filter((r) => r.visit_id === sharedId);
  assert.equal(rowsA.length, 1);
  assert.equal(rowsB.length, 1);
  assert.equal(rowsA[0].user_id, USER_A);
  assert.equal(rowsB[0].user_id, USER_B);
});

test("visits are scoped per user — one user never sees another's rows", async () => {
  const rowsB = await getSiteVisitsForUser(USER_B);
  assert.ok(
    rowsB.every((r) => r.user_id === USER_B),
    "the helper must only ever return the requested user's rows",
  );
  assert.ok(
    !rowsB.some((r) => r.user_id === USER_A),
    "no cross-user leakage",
  );
});

// ─── Regression: screen-time is unchanged ──────────────────────────────────

test("/api/screen-time still ingests and returns its ping config", async () => {
  const id = sessionStore.createSession(USER_A).id;
  const res = await fetch(`${baseUrl}/api/screen-time`, {
    method: "POST",
    headers: { Cookie: cookieHeader(id), "Content-Type": "application/json" },
    body: JSON.stringify({
      domain: "example.com",
      path: "/watch",
      durationSeconds: 30,
      timestamp: new Date().toISOString(),
      seq_id: `screen-seq-${nextVisitId()}`,
    }),
  });
  assert.equal(res.status, 201);
  const data = await res.json();
  assert.equal(data.status, "ok");
  assert.ok(data.badgeMaxHours > 0, "ping config is still returned");
  assert.ok(data.flushIntervalSeconds > 0, "flush interval is still returned");
});

test("/api/screen-time still deduplicates a repeated seq_id", async () => {
  const seqId = `screen-seq-${nextVisitId()}`;
  const payload = {
    domain: "dedup-site.example.com",
    path: "/",
    durationSeconds: 12,
    timestamp: new Date().toISOString(),
    seq_id: seqId,
  };
  const id = sessionStore.createSession(USER_A).id;
  const headers = { Cookie: cookieHeader(id), "Content-Type": "application/json" };

  const first = await fetch(`${baseUrl}/api/screen-time`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const second = await fetch(`${baseUrl}/api/screen-time`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201, "a duplicate seq_id is still accepted, not rejected");

  const logs = await fetch(`${baseUrl}/api/logs`, {
    headers: { Cookie: cookieHeader(id) },
  }).then((r) => r.json());
  const matches = logs.logs.filter((l) => l.domain === "dedup-site.example.com");
  assert.equal(matches.length, 1, "screen-time dedup must be unchanged");
});

test("/api/screen-time still rejects a forged userToken body field", async () => {
  const id = sessionStore.createSession(USER_A).id;
  const res = await fetch(`${baseUrl}/api/screen-time`, {
    method: "POST",
    headers: { Cookie: cookieHeader(id), "Content-Type": "application/json" },
    body: JSON.stringify({
      domain: "ownership-check.example.com",
      durationSeconds: 5,
      userToken: USER_B,
    }),
  });
  assert.equal(res.status, 201);

  const mine = await fetch(`${baseUrl}/api/logs`, {
    headers: { Cookie: cookieHeader(id) },
  }).then((r) => r.json());
  assert.ok(
    mine.logs.some((l) => l.domain === "ownership-check.example.com"),
    "still attributed to the session owner",
  );
});

test("the visit route does not appear on any existing dashboard response", async () => {
  const id = sessionStore.createSession(USER_A).id;
  const res = await fetch(`${baseUrl}/api/dashboard`, {
    headers: { Cookie: cookieHeader(id) },
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  // No aggregation was in scope, so no visit data may leak into the dashboard.
  assert.equal(data.visits, undefined);
  assert.equal(data.siteVisits, undefined);
  assert.equal(data.mostVisited, undefined);
});