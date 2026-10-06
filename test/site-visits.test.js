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
let getSiteVisitCountsForUser;
let insertSiteVisit;

const USER_A = "alice@example.com";
const USER_B = "bob@example.com";

/** Boot the real server once for the whole file. */
test.before(async () => {
  const mod = require("../server");
  server = await mod.start();
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  getSiteVisitsForUser = mod.getSiteVisitsForUser;
  getSiteVisitCountsForUser = mod.getSiteVisitCountsForUser;
  insertSiteVisit = mod.insertSiteVisit;
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

// ─── GET /api/site-visits (aggregation) ──────────────────────────────────────

/** GET /api/site-visits as the given user. */
async function getVisits(user) {
  const id = sessionStore.createSession(user).id;
  const res = await fetch(`${baseUrl}/api/site-visits`, {
    headers: { Cookie: cookieHeader(id) },
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

/** GET /api/site-visits with a range parameter. */
async function getVisitsWithRange(user, range) {
  const id = sessionStore.createSession(user).id;
  const url = new URL(`${baseUrl}/api/site-visits`);
  if (range) url.searchParams.set("range", range);
  const res = await fetch(url, {
    headers: { Cookie: cookieHeader(id) },
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

/** GET /api/site-visits without auth (for 401 test). */
async function getVisitsUnauth() {
  const res = await fetch(`${baseUrl}/api/site-visits`, {
    headers: { "Content-Type": "application/json" },
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

test("GET /api/site-visits requires authentication", async () => {
  const res = await getVisitsUnauth();
  assert.equal(res.status, 401);
});

test("authenticated user gets their own grouped visit counts", async () => {
  // Fresh user to avoid test pollution from earlier tests
  const USER_FRESH = "fresh@example.com";
  const visits = [
    { domain: "youtube.com", visit_id: nextVisitId() },
    { domain: "youtube.com", visit_id: nextVisitId() },
    { domain: "youtube.com", visit_id: nextVisitId() },
    { domain: "github.com", visit_id: nextVisitId() },
    { domain: "github.com", visit_id: nextVisitId() },
    { domain: "example.com", visit_id: nextVisitId() },
  ];
  for (const v of visits) {
    const res = await postVisit(USER_FRESH, v);
    assert.equal(res.status, 201);
  }

  const res = await getVisits(USER_FRESH);
  assert.equal(res.status, 200);
  assert.ok(res.data.domains, "response must have domains array");
  assert.equal(res.data.domains.length, 3, "three distinct domains");

  // Ordered by count descending
  assert.equal(res.data.domains[0].domain, "youtube.com");
  assert.equal(res.data.domains[0].visitCount, 3);
  assert.equal(res.data.domains[1].domain, "github.com");
  assert.equal(res.data.domains[1].visitCount, 2);
  assert.equal(res.data.domains[2].domain, "example.com");
  assert.equal(res.data.domains[2].visitCount, 1);
});

test("multiple visits to same domain aggregate correctly", async () => {
  // Fresh user to avoid test pollution
  const USER_C = "carol@example.com";
  const visitIds = [];
  for (let i = 0; i < 5; i++) {
    visitIds.push(nextVisitId());
  }
  for (const visitId of visitIds) {
    const res = await postVisit(USER_C, { domain: "repeated.example.com", visit_id: visitId });
    assert.equal(res.status, 201);
  }

  const res = await getVisits(USER_C);
  assert.equal(res.status, 200);
  assert.equal(res.data.domains.length, 1);
  assert.equal(res.data.domains[0].domain, "repeated.example.com");
  assert.equal(res.data.domains[0].visitCount, 5);
});

test("domains are ordered by visit count descending", async () => {
  const USER_D = "dave@example.com";
  await postVisit(USER_D, { domain: "low.example.com", visit_id: nextVisitId() }); // 1
  await postVisit(USER_D, { domain: "mid.example.com", visit_id: nextVisitId() }); // 1
  await postVisit(USER_D, { domain: "mid.example.com", visit_id: nextVisitId() }); // 2
  await postVisit(USER_D, { domain: "high.example.com", visit_id: nextVisitId() }); // 1
  await postVisit(USER_D, { domain: "high.example.com", visit_id: nextVisitId() }); // 2
  await postVisit(USER_D, { domain: "high.example.com", visit_id: nextVisitId() }); // 3

  const res = await getVisits(USER_D);
  assert.equal(res.status, 200);
  assert.equal(res.data.domains[0].domain, "high.example.com");
  assert.equal(res.data.domains[0].visitCount, 3);
  assert.equal(res.data.domains[1].domain, "mid.example.com");
  assert.equal(res.data.domains[1].visitCount, 2);
  assert.equal(res.data.domains[2].domain, "low.example.com");
  assert.equal(res.data.domains[2].visitCount, 1);
});

test("zero visits returns an empty result", async () => {
  const USER_E = "eve@example.com";
  // USER_E has no visits yet
  const res = await getVisits(USER_E);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.data.domains));
  assert.equal(res.data.domains.length, 0);
});

test("another user's visits are not included in the response", async () => {
  // USER_A already has visits from earlier tests
  // Create visits for USER_B
  await postVisit(USER_B, { domain: "private.example.com", visit_id: nextVisitId() });
  await postVisit(USER_B, { domain: "private.example.com", visit_id: nextVisitId() });

  // USER_A should not see USER_B's visits
  const res = await getVisits(USER_A);
  assert.equal(res.status, 200);
  for (const domain of res.data.domains) {
    assert.notEqual(domain.domain, "private.example.com", "no cross-user leakage");
  }

  // USER_B should see only their own
  const resB = await getVisits(USER_B);
  assert.equal(resB.status, 200);
  const privateDomain = resB.data.domains.find((d) => d.domain === "private.example.com");
  assert.ok(privateDomain, "USER_B must see their own domain");
  assert.equal(privateDomain.visitCount, 2);
});

test("visit IDs are not exposed in the aggregation response", async () => {
  const USER_F = "frank@example.com";
  await postVisit(USER_F, { domain: "exposed.example.com", visit_id: nextVisitId() });
  await postVisit(USER_F, { domain: "exposed.example.com", visit_id: nextVisitId() });

  const res = await getVisits(USER_F);
  assert.equal(res.status, 200);
  const serialized = JSON.stringify(res.data);
  assert.ok(!serialized.includes("visit_id"), "visit_id must not appear in response");
  assert.ok(!serialized.includes("id"), "internal id must not appear in response");
  // Only domain and visitCount should be present
  for (const d of res.data.domains) {
    assert.deepEqual(
      Object.keys(d).sort(),
      ["domain", "visitCount"],
      "each entry must only have domain and visitCount",
    );
  }
});

test("POST /api/site-visits behavior remains intact after adding GET", async () => {
  const USER_G = "grace@example.com";
  const visitId = nextVisitId();
  const res = await postVisit(USER_G, { domain: "post-still-works.example.com", visit_id: visitId });
  assert.equal(res.status, 201);
  assert.equal(res.data.status, "ok");

  const rows = await getSiteVisitsForUser(USER_G);
  const row = rows.find((r) => r.visit_id === visitId);
  assert.ok(row, "POST must still store the visit");
  assert.equal(row.domain, "post-still-works.example.com");
  assert.equal(row.user_id, USER_G);

  // Duplicate still returns 200 with duplicate status
  const dup = await postVisit(USER_G, { domain: "post-still-works.example.com", visit_id: visitId });
  assert.equal(dup.status, 200);
  assert.equal(dup.data.status, "duplicate");
});

test("getSiteVisitCountsForUser helper works directly", async () => {
  const USER_H = "helen@example.com";
  await postVisit(USER_H, { domain: "helper.example.com", visit_id: nextVisitId() });
  await postVisit(USER_H, { domain: "helper.example.com", visit_id: nextVisitId() });
  await postVisit(USER_H, { domain: "other.example.com", visit_id: nextVisitId() });

  const counts = await getSiteVisitCountsForUser(USER_H);
  assert.equal(counts.length, 2);
  assert.equal(counts[0].domain, "helper.example.com");
  assert.equal(counts[0].visitCount, 2);
  assert.equal(counts[1].domain, "other.example.com");
  assert.equal(counts[1].visitCount, 1);
});

test("getSiteVisitCountsForUser returns empty for user with no visits", async () => {
  const counts = await getSiteVisitCountsForUser("nobody@example.com");
  assert.ok(Array.isArray(counts));
  assert.equal(counts.length, 0);
});

test("getSiteVisitCountsForUser does not leak across users", async () => {
  await postVisit(USER_A, { domain: "leak-check.example.com", visit_id: nextVisitId() });
  await postVisit(USER_B, { domain: "leak-check.example.com", visit_id: nextVisitId() });
  await postVisit(USER_B, { domain: "leak-check.example.com", visit_id: nextVisitId() });

  const countsA = await getSiteVisitCountsForUser(USER_A);
  const countsB = await getSiteVisitCountsForUser(USER_B);

  const aDomain = countsA.find((d) => d.domain === "leak-check.example.com");
  const bDomain = countsB.find((d) => d.domain === "leak-check.example.com");

  assert.equal(aDomain?.visitCount, 1);
  assert.equal(bDomain?.visitCount, 2);
});

// ─── Time-range filtering tests ────────────────────────────────────────────────

/** Insert a visit with a specific date for testing. */
async function insertVisitWithDate(userId, domain, visitId, visitedAt) {
  return insertSiteVisit({ userId, domain, visitId, visitedAt });
}

test("range=today includes today's visits but excludes older visits", async () => {
  const USER_TODAY = "today@example.com";
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  // Insert visits with specific dates using the helper
  await insertVisitWithDate(USER_TODAY, "today-site.example.com", nextVisitId(), today + "T12:00:00Z");
  await insertVisitWithDate(USER_TODAY, "today-site.example.com", nextVisitId(), today + "T14:00:00Z");
  await insertVisitWithDate(USER_TODAY, "yesterday-site.example.com", nextVisitId(), yesterday + "T12:00:00Z");

  // range=today should only include today's visits
  const res = await getVisitsWithRange(USER_TODAY, "today");
  assert.equal(res.status, 200);
  assert.equal(res.data.domains.length, 1);
  assert.equal(res.data.domains[0].domain, "today-site.example.com");
  assert.equal(res.data.domains[0].visitCount, 2);
});

test("range=week includes visits in current week but excludes older visits", async () => {
  const USER_WEEK = "week@example.com";
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  // Calculate Monday of this week (UTC)
  const day = today.getUTCDay(); // 0 = Sunday
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(today);
  monday.setUTCDate(today.getUTCDate() + diff);
  const mondayStr = monday.toISOString().slice(0, 10);

  // Calculate last week's Monday
  const lastMonday = new Date(monday);
  lastMonday.setUTCDate(monday.getUTCDate() - 7);
  const lastMondayStr = lastMonday.toISOString().slice(0, 10);

  // This week's visits
  await insertVisitWithDate(USER_WEEK, "this-week.example.com", nextVisitId(), mondayStr + "T12:00:00Z");
  await insertVisitWithDate(USER_WEEK, "this-week.example.com", nextVisitId(), todayStr + "T12:00:00Z");

  // Last week's visit (should be excluded)
  await insertVisitWithDate(USER_WEEK, "last-week.example.com", nextVisitId(), lastMondayStr + "T12:00:00Z");

  const res = await getVisitsWithRange(USER_WEEK, "week");
  assert.equal(res.status, 200);
  // Should only have this-week.example.com (2 visits)
  assert.equal(res.data.domains.length, 1);
  assert.equal(res.data.domains[0].domain, "this-week.example.com");
  assert.equal(res.data.domains[0].visitCount, 2);
});

test("range=month includes visits in current month but excludes older visits", async () => {
  const USER_MONTH = "month@example.com";
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  // First day of current month (UTC)
  const firstOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const firstOfMonthStr = firstOfMonth.toISOString().slice(0, 10);

  // First day of last month (UTC)
  const firstOfLastMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  const firstOfLastMonthStr = firstOfLastMonth.toISOString().slice(0, 10);

  // This month's visits
  await insertVisitWithDate(USER_MONTH, "this-month.example.com", nextVisitId(), firstOfMonthStr + "T12:00:00Z");
  await insertVisitWithDate(USER_MONTH, "this-month.example.com", nextVisitId(), todayStr + "T12:00:00Z");

  // Last month's visit (should be excluded)
  await insertVisitWithDate(USER_MONTH, "last-month.example.com", nextVisitId(), firstOfLastMonthStr + "T12:00:00Z");

  const res = await getVisitsWithRange(USER_MONTH, "month");
  assert.equal(res.status, 200);
  // Should only have this-month.example.com (2 visits)
  assert.equal(res.data.domains.length, 1);
  assert.equal(res.data.domains[0].domain, "this-month.example.com");
  assert.equal(res.data.domains[0].visitCount, 2);
});

test("range=all includes all visits", async () => {
  const USER_ALL = "all@example.com";
  const today = new Date().toISOString().slice(0, 10);
  const lastMonth = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  await insertVisitWithDate(USER_ALL, "recent.example.com", nextVisitId(), today + "T12:00:00Z");
  await insertVisitWithDate(USER_ALL, "old.example.com", nextVisitId(), lastMonth + "T12:00:00Z");

  const res = await getVisitsWithRange(USER_ALL, "all");
  assert.equal(res.status, 200);
  assert.equal(res.data.domains.length, 2);
});

test("omitted range behaves like all (backward compatibility)", async () => {
  const USER_COMPAT = "compat@example.com";
  const today = new Date().toISOString().slice(0, 10);
  const lastMonth = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  await insertVisitWithDate(USER_COMPAT, "recent.example.com", nextVisitId(), today + "T12:00:00Z");
  await insertVisitWithDate(USER_COMPAT, "old.example.com", nextVisitId(), lastMonth + "T12:00:00Z");

  // No range parameter - should return all
  const res = await getVisits(USER_COMPAT);
  assert.equal(res.status, 200);
  assert.equal(res.data.domains.length, 2);
});

test("invalid range returns 400", async () => {
  const USER_INVALID = "invalid@example.com";
  await postVisit(USER_INVALID, { domain: "test.example.com", visit_id: nextVisitId() });

  const res = await getVisitsWithRange(USER_INVALID, "invalid-range");
  assert.equal(res.status, 400);
  assert.equal(res.data.status, "error");
  assert.ok(res.data.message.includes("Invalid range"));
});

test("boundary timestamps are handled correctly (start of day)", async () => {
  const USER_BOUNDARY = "boundary@example.com";
  const today = new Date().toISOString().slice(0, 10);

  // Visit at exactly 00:00:00 UTC today
  await insertVisitWithDate(USER_BOUNDARY, "boundary.example.com", nextVisitId(), today + "T00:00:00Z");
  // Visit at 23:59:59 UTC today
  await insertVisitWithDate(USER_BOUNDARY, "boundary.example.com", nextVisitId(), today + "T23:59:59Z");

  const res = await getVisitsWithRange(USER_BOUNDARY, "today");
  assert.equal(res.status, 200);
  assert.equal(res.data.domains.length, 1);
  assert.equal(res.data.domains[0].visitCount, 2);
});

test("different users remain isolated with range filtering", async () => {
  const USER_X = "userx@example.com";
  const USER_Y = "usery@example.com";
  const today = new Date().toISOString().slice(0, 10);

  await insertVisitWithDate(USER_X, "shared.example.com", nextVisitId(), today + "T12:00:00Z");
  await insertVisitWithDate(USER_Y, "shared.example.com", nextVisitId(), today + "T12:00:00Z");
  await insertVisitWithDate(USER_Y, "shared.example.com", nextVisitId(), today + "T14:00:00Z");

  const resX = await getVisitsWithRange(USER_X, "today");
  const resY = await getVisitsWithRange(USER_Y, "today");

  assert.equal(resX.status, 200);
  assert.equal(resY.status, 200);
  assert.equal(resX.data.domains[0].visitCount, 1);
  assert.equal(resY.data.domains[0].visitCount, 2);
});

test("domains remain ordered by count descending with range filtering", async () => {
  const USER_ORDER = "order@example.com";
  const today = new Date().toISOString().slice(0, 10);

  await insertVisitWithDate(USER_ORDER, "low.example.com", nextVisitId(), today + "T12:00:00Z");
  await insertVisitWithDate(USER_ORDER, "mid.example.com", nextVisitId(), today + "T12:00:00Z");
  await insertVisitWithDate(USER_ORDER, "mid.example.com", nextVisitId(), today + "T14:00:00Z");
  await insertVisitWithDate(USER_ORDER, "high.example.com", nextVisitId(), today + "T12:00:00Z");
  await insertVisitWithDate(USER_ORDER, "high.example.com", nextVisitId(), today + "T14:00:00Z");
  await insertVisitWithDate(USER_ORDER, "high.example.com", nextVisitId(), today + "T16:00:00Z");

  const res = await getVisitsWithRange(USER_ORDER, "today");
  assert.equal(res.status, 200);
  assert.equal(res.data.domains[0].domain, "high.example.com");
  assert.equal(res.data.domains[0].visitCount, 3);
  assert.equal(res.data.domains[1].domain, "mid.example.com");
  assert.equal(res.data.domains[1].visitCount, 2);
  assert.equal(res.data.domains[2].domain, "low.example.com");
  assert.equal(res.data.domains[2].visitCount, 1);
});

test("existing POST /api/site-visits behavior still passes with range feature", async () => {
  const USER_POST = "posttest@example.com";
  const visitId = nextVisitId();
  const res = await postVisit(USER_POST, { domain: "post-works.example.com", visit_id: visitId });
  assert.equal(res.status, 201);
  assert.equal(res.data.status, "ok");

  const rows = await getSiteVisitsForUser(USER_POST);
  const row = rows.find((r) => r.visit_id === visitId);
  assert.ok(row, "POST must still store the visit");
  assert.equal(row.domain, "post-works.example.com");

  // Duplicate still returns 200 with duplicate status
  const dup = await postVisit(USER_POST, { domain: "post-works.example.com", visit_id: visitId });
  assert.equal(dup.status, 200);
  assert.equal(dup.data.status, "duplicate");
});