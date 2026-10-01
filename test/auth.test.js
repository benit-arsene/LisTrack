/**
 * LisTrack Authentication & Authorization Tests (C1 + H4)
 * ======================================================
 * Focused regression tests for the two remediated findings:
 *
 *   C1 — the session cookie must not be forgeable from an email address.
 *   H4 — routes must authorize against req.authenticatedUser, never a
 *        client-supplied `user` / `userToken` / `x-user-token`.
 *
 * Uses Node's built-in `node:test` runner (no new dependency):
 *     node --test test/auth.test.js
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
  fs.mkdtempSync(path.join(os.tmpdir(), "listrack-authtest-")),
  "auth-test.db"
);
process.env.DATABASE_PATH = TMP_DB;
process.env.PORT = "0";
delete process.env.DATABASE_URL; // force the SQLite driver

const sessionStore = require("../session");

let server;
let baseUrl;

const USER_A = "alice@example.com";
const USER_B = "bob@example.com";

/** Boot the real server once for the whole file. */
test.before(async () => {
  const { start } = require("../server");
  server = await start();
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Mint a real session for a user and return its id. */
function sessionFor(user) {
  return sessionStore.createSession(user).id;
}

/** Force a session to be expired by back-dating its record. */
function expireSession(id) {
  const record = sessionStore.getSession(id);
  assert.ok(record, "session must exist before expiring");
  record.expiresAt = Date.now() - 1000;
}

/** GET/POST/PUT/DELETE a path with an optional cookie and bearer token. */
async function call(method, urlPath, { cookie, bearer, body, json } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (json) headers["Content-Type"] = "application/json";
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers,
    body: json ? JSON.stringify(body) : undefined,
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
  return { status: res.status, data, headers: res.headers };
}

const cookieHeader = (id) => `lisTrackSession=${id}`;

// ═══════════════════════════════════════════════════════════════════════════
// C1 — Session store unit properties
// ═══════════════════════════════════════════════════════════════════════════

test("C1: session ids are 64 hex chars from 32 CSPRNG bytes", () => {
  const id = sessionStore.createSession(USER_A).id;
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.equal(sessionStore.SESSION_ID_BYTES, 32);
});

test("C1: session ids are unique across many calls", () => {
  const ids = new Set();
  for (let i = 0; i < 2000; i++) {
    ids.add(sessionStore.createSession(USER_A).id);
  }
  assert.equal(ids.size, 2000, "no session id collisions in 2000 draws");
});

test("C1: session id does not contain the user's email", () => {
  const id = sessionStore.createSession(USER_A).id;
  assert.ok(!id.includes(USER_A));
  assert.ok(!id.includes("alice"));
  assert.ok(!id.includes("@"));
});

test("C1: getSession returns null for an unknown id", () => {
  assert.equal(sessionStore.getSession("does-not-exist"), null);
  assert.equal(sessionStore.getSession(""), null);
  assert.equal(sessionStore.getSession(null), null);
});

test("C1: an expired session is rejected and reaped", () => {
  const id = sessionFor(USER_A);
  assert.ok(sessionStore.getSession(id), "live session resolves");
  expireSession(id);
  assert.equal(sessionStore.getSession(id), null, "expired session rejected");
  assert.equal(sessionStore.getSession(id), null, "and stays rejected");
});

test("C1: deleteSession invalidates immediately", () => {
  const id = sessionFor(USER_A);
  assert.equal(sessionStore.deleteSession(id), true);
  assert.equal(sessionStore.getSession(id), null);
});

test("C1: createSession rejects an empty identity", () => {
  assert.throws(() => sessionStore.createSession(""), /requires a verified user/);
  assert.throws(() => sessionStore.createSession(null), /requires a verified user/);
});

// ═══════════════════════════════════════════════════════════════════════════
// C1 — The six required tests, against the live HTTP server
// ═══════════════════════════════════════════════════════════════════════════

test("C1 Test 1: a cookie containing an email does NOT authenticate", async () => {
  // The exact C1 attack: forge the cookie with a victim's address.
  const forged = await call("GET", "/api/logs", {
    cookie: cookieHeader(USER_A),
  });
  assert.equal(forged.status, 401, "email cookie must not authenticate");

  // And it must not work on any other authenticated route either.
  for (const p of [
    "/api/dashboard",
    "/api/summary",
    "/api/goals",
    "/api/goals/status",
    "/api/today",
    "/api/logs",
    "/api/trends",
  ]) {
    const r = await call("GET", p, { cookie: cookieHeader(USER_B) });
    assert.equal(r.status, 401, `${p} must reject an email cookie`);
  }
});

test("C1 Test 2: a random/unknown session id returns 401", async () => {
  const r = await call("GET", "/api/logs", {
    cookie: cookieHeader("f".repeat(64)),
  });
  assert.equal(r.status, 401);
});

test("C1 Test 3: an expired session returns 401", async () => {
  const id = sessionFor(USER_A);
  const before = await call("GET", "/api/logs", { cookie: cookieHeader(id) });
  assert.equal(before.status, 200, "live session works first");

  expireSession(id);
  const after = await call("GET", "/api/logs", { cookie: cookieHeader(id) });
  assert.equal(after.status, 401, "expired session rejected");
});

test("C1 Test 4: a valid session authenticates the correct user", async () => {
  const id = sessionFor(USER_A);

  // Ingest a record as A, then read it back as A.
  const ingest = await call("POST", "/api/screen-time", {
    cookie: cookieHeader(id),
    json: true,
    body: { domain: "example.com", durationSeconds: 42, path: "/a" },
  });
  assert.equal(ingest.status, 201);

  const logs = await call("GET", "/api/logs", { cookie: cookieHeader(id) });
  assert.equal(logs.status, 200);
  assert.ok(logs.data.logs.length > 0);

  // The dashboard page itself must render for a valid session.
  const page = await call("GET", "/dashboard", { cookie: cookieHeader(id) });
  assert.equal(page.status, 200);
  assert.ok(
    String(page.data).includes(`content="${USER_A}"`),
    "dashboard injects the session user's identity"
  );
});

test("C1 Test 5: the session cookie value is not the email", async () => {
  // Simulate the token-exchange shape by inspecting what createSession
  // hands to res.cookie — the cookie must carry only the id.
  const s = sessionStore.createSession(USER_A);
  const cookieValue = s.id; // this is exactly what res.cookie() receives
  assert.notEqual(cookieValue, USER_A);
  assert.ok(!cookieValue.includes("@"));
});

test("C1 Test 6: the session record never holds the OAuth token", async () => {
  const s = sessionStore.createSession(USER_A);
  const serialized = JSON.stringify(s);
  assert.ok(!serialized.includes("ya29."), "no Google access token in record");
  assert.ok(!/access[_-]?token/i.test(serialized));
  // The record holds only the four documented fields plus the id.
  assert.deepEqual(Object.keys(s).sort(), [
    "createdAt",
    "expiresAt",
    "id",
    "user",
  ]);
});

// ═══════════════════════════════════════════════════════════════════════════
// H4 — Client-supplied identity must never select the data owner
// ═══════════════════════════════════════════════════════════════════════════

test("H4: User A asking for User B's logs gets only User A's data", async () => {
  const a = sessionFor(USER_A);
  const b = sessionFor(USER_B);

  // Seed distinct data for each user.
  await call("POST", "/api/screen-time", {
    cookie: cookieHeader(a),
    json: true,
    body: { domain: "aaa-private.com", durationSeconds: 11, path: "/a" },
  });
  await call("POST", "/api/screen-time", {
    cookie: cookieHeader(b),
    json: true,
    body: { domain: "bbb-private.com", durationSeconds: 22, path: "/b" },
  });

  // A authenticates, then explicitly claims to be B.
  const r = await call("GET", `/api/logs?user=${encodeURIComponent(USER_B)}`, {
    cookie: cookieHeader(a),
  });

  assert.equal(r.status, 200);
  const domains = r.data.logs.map((l) => l.domain);
  assert.ok(
    !domains.includes("bbb-private.com"),
    "must NOT return User B's data"
  );
  assert.ok(
    domains.includes("aaa-private.com"),
    "must return User A's own data"
  );
});

test("H4: User A asking for User B's dashboard gets only User A's data", async () => {
  const a = sessionFor(USER_A);
  const b = sessionFor(USER_B);

  await call("POST", "/api/screen-time", {
    cookie: cookieHeader(b),
    json: true,
    body: { domain: "bbb-private.com", durationSeconds: 33, path: "/b" },
  });

  const r = await call("GET", `/api/dashboard?user=${encodeURIComponent(USER_B)}`, {
    cookie: cookieHeader(a),
  });

  assert.equal(r.status, 200);
  const domains = r.data.domains.map((d) => d.domain);
  assert.ok(!domains.includes("bbb-private.com"), "no B's domains in A's view");
});

test("H4: x-user-token header cannot select another user", async () => {
  const a = sessionFor(USER_A);
  const b = sessionFor(USER_B);

  await call("POST", "/api/screen-time", {
    cookie: cookieHeader(b),
    json: true,
    body: { domain: "bbb-private.com", durationSeconds: 44, path: "/b" },
  });

  const r = await fetch(`${baseUrl}/api/logs`, {
    headers: { Cookie: cookieHeader(a), "x-user-token": USER_B },
  });
  const data = await r.json();

  assert.equal(r.status, 200);
  assert.ok(
    !data.logs.map((l) => l.domain).includes("bbb-private.com"),
    "x-user-token must not switch the acting user"
  );
});

test("H4: a userToken body field cannot attribute data to another user", async () => {
  const a = sessionFor(USER_A);
  const b = sessionFor(USER_B);

  // A posts tracking data but claims to be B in the body.
  const r = await call("POST", "/api/screen-time", {
    cookie: cookieHeader(a),
    json: true,
    body: {
      domain: "spoofed.com",
      durationSeconds: 5,
      path: "/x",
      userToken: USER_B,
    },
  });
  assert.equal(r.status, 201);

  // The record must land under A, not B.
  const aLogs = await call("GET", "/api/logs", { cookie: cookieHeader(a) });
  assert.ok(
    aLogs.data.logs.some((l) => l.domain === "spoofed.com"),
    "record attributed to the authenticated user"
  );

  const bLogs = await call("GET", "/api/logs", { cookie: cookieHeader(b) });
  assert.ok(
    !bLogs.data.logs.some((l) => l.domain === "spoofed.com"),
    "record must NOT appear under the impersonated user"
  );
});

test("H4: every read route ignores ?user= across the board", async () => {
  const a = sessionFor(USER_A);

  const routes = [
    "/api/dashboard",
    "/api/summary",
    "/api/goals",
    "/api/goals/status",
    "/api/today",
    "/api/logs",
    "/api/trends",
    "/api/domain-breakdown?domain=bbb-private.com",
    "/api/summary?period=custom&startDate=2020-01-01&endDate=2030-01-01",
  ];

  for (const route of routes) {
    // Append with "&" when the route already carries a query string, so the
    // extra param is parsed as its own key rather than absorbed by another.
    const sep = route.includes("?") ? "&" : "?";
    const withClaim = await call(
      "GET",
      `${route}${sep}user=${encodeURIComponent(USER_B)}`,
      { cookie: cookieHeader(a) }
    );
    const withoutClaim = await call("GET", route, { cookie: cookieHeader(a) });
    assert.equal(withClaim.status, withoutClaim.status, `${route} status differs`);
    assert.deepEqual(
      withClaim.data,
      withoutClaim.data,
      `${route} must return identical data with and without ?user=`
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Goal creation + ownership (must not be weakened by the redesign)
// ═══════════════════════════════════════════════════════════════════════════

test("goals: created without any userToken field, owned by the session", async () => {
  const a = sessionFor(USER_A);

  const create = await call("POST", "/api/goals", {
    cookie: cookieHeader(a),
    json: true,
    body: { domain: "reddit.com", max_minutes: 30 },
  });
  assert.equal(create.status, 201, "userToken is no longer required");

  const goals = await call("GET", "/api/goals", { cookie: cookieHeader(a) });
  const mine = goals.data.goals.filter((g) => g.domain === "reddit.com");
  assert.ok(mine.length > 0);
  assert.equal(mine[0].user_id, USER_A, "owned by the authenticated user");
});

test("goals: a userToken body field cannot create a goal for another user", async () => {
  const a = sessionFor(USER_A);
  const b = sessionFor(USER_B);

  const create = await call("POST", "/api/goals", {
    cookie: cookieHeader(a),
    json: true,
    body: { domain: "evil.example", max_minutes: 5, userToken: USER_B },
  });
  assert.equal(create.status, 201);

  const bGoals = await call("GET", "/api/goals", { cookie: cookieHeader(b) });
  assert.ok(
    !bGoals.data.goals.some((g) => g.domain === "evil.example"),
    "goal must NOT be created under the impersonated user"
  );

  const aGoals = await call("GET", "/api/goals", { cookie: cookieHeader(a) });
  assert.ok(aGoals.data.goals.some((g) => g.domain === "evil.example"));
});

test("goals: ownership checks still block cross-user update", async () => {
  const a = sessionFor(USER_A);
  const b = sessionFor(USER_B);

  const create = await call("POST", "/api/goals", {
    cookie: cookieHeader(b),
    json: true,
    body: { domain: "owned-by-b.com", max_minutes: 20 },
  });
  const goalId = create.data.id;

  // A tries to update B's goal — even while claiming to be B via ?user=
  const upd = await call(
    "PUT",
    `/api/goals/${goalId}?user=${encodeURIComponent(USER_B)}`,
    {
      cookie: cookieHeader(a),
      json: true,
      body: { max_minutes: 999 },
    }
  );
  assert.equal(upd.status, 404, "cross-user update must 404");

  const bGoals = await call("GET", "/api/goals", { cookie: cookieHeader(b) });
  const still = bGoals.data.goals.find((g) => g.id === goalId);
  assert.equal(still.max_minutes, 20, "B's goal unchanged");
});

test("goals: ownership checks still block cross-user delete", async () => {
  const a = sessionFor(USER_A);
  const b = sessionFor(USER_B);

  const create = await call("POST", "/api/goals", {
    cookie: cookieHeader(b),
    json: true,
    body: { domain: "delete-me.com", max_minutes: 15 },
  });
  const goalId = create.data.id;

  const del = await call(
    "DELETE",
    `/api/goals/${goalId}?user=${encodeURIComponent(USER_B)}`,
    { cookie: cookieHeader(a) }
  );
  assert.equal(del.status, 404, "cross-user delete must 404");

  const bGoals = await call("GET", "/api/goals", { cookie: cookieHeader(b) });
  assert.ok(
    bGoals.data.goals.some((g) => g.id === goalId),
    "B's goal still exists"
  );

  // Sanity: B can delete their own.
  const okDel = await call("DELETE", `/api/goals/${goalId}`, {
    cookie: cookieHeader(b),
  });
  assert.equal(okDel.status, 200, "owner can still delete");
});

// ═══════════════════════════════════════════════════════════════════════════
// Unauthenticated access
// ═══════════════════════════════════════════════════════════════════════════

test("unauthenticated requests to every protected route return 401", async () => {
  const routes = [
    ["GET", "/api/dashboard"],
    ["GET", "/api/summary"],
    ["GET", "/api/goals"],
    ["GET", "/api/goals/status"],
    ["GET", "/api/today"],
    ["GET", "/api/logs"],
    ["GET", "/api/trends"],
    ["GET", "/api/domain-breakdown?domain=example.com"],
    ["POST", "/api/goals"],
    ["POST", "/api/screen-time"],
    ["POST", "/api/seed"],
  ];
  for (const [method, route] of routes) {
    const r = await call(method, route, { json: method === "POST", body: {} });
    assert.equal(r.status, 401, `${method} ${route} must require auth`);
  }
});

test("a garbage bearer token is rejected", async () => {
  const r = await call("GET", "/api/logs", { bearer: "not-a-real-token" });
  assert.equal(r.status, 401);
});

test("/dashboard without a session redirects to the landing page", async () => {
  const res = await fetch(`${baseUrl}/dashboard`, { redirect: "manual" });
  assert.ok([302, 301].includes(res.status));
  const location = res.headers.get("location") || "";
  assert.ok(location.includes("listrack"), `unexpected redirect: ${location}`);
});

test("/dashboard rejects a legacy ?user= link", async () => {
  const res = await fetch(`${baseUrl}/dashboard?user=${encodeURIComponent(USER_B)}`, {
    redirect: "manual",
  });
  assert.ok([302, 301].includes(res.status));
});

// ═══════════════════════════════════════════════════════════════════════════
// Static guard: no route may source identity from client input
// ═══════════════════════════════════════════════════════════════════════════

test("no route reads identity from query, body or headers", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "server.js"),
    "utf8"
  );

  // Strip comments so explanatory prose doesn't trip the check.
  const code = src
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");

  const forbidden = [
    "req.query.user",
    "req.body.userToken",
    'req.headers["x-user-token"]',
    "req.headers['x-user-token']",
  ];
  for (const token of forbidden) {
    assert.ok(
      !code.includes(token),
      `server.js must not reference ${token} — authorization must use req.authenticatedUser`
    );
  }

  // Every authenticated route must derive its user from the principal.
  const principalAssignments = code.match(
    /const userId = req\.authenticatedUser;/g
  ) || [];
  assert.ok(
    principalAssignments.length >= 12,
    `expected all authenticated routes to use req.authenticatedUser, found ${principalAssignments.length}`
  );
});

test("no client code sends identity to the API", () => {
  const files = [
    "public/js/dashboard.js",
    "public/js/background.js",
    "public/js/popup.js",
    "public/js/tracker.js",
  ];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    const code = src
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");

    assert.ok(
      !/user=\$\{encodeURIComponent\(/.test(code),
      `${rel} must not append ?user= to API requests`
    );
    assert.ok(
      !/params\.set\(\s*['"]user['"]/.test(code),
      `${rel} must not set a 'user' query param`
    );
    assert.ok(
      !/userToken\s*:/.test(code),
      `${rel} must not send a userToken field`
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Regression: tracking ingestion still works (extension compatibility)
// ═══════════════════════════════════════════════════════════════════════════

test("ingestion: a valid session stores screen time", async () => {
  const a = sessionFor(USER_A);
  const r = await call("POST", "/api/screen-time", {
    cookie: cookieHeader(a),
    json: true,
    body: {
      domain: "ingest-check.com",
      path: "/p",
      durationSeconds: 30,
      seq_id: "regression-seq-001",
    },
  });
  assert.equal(r.status, 201);
  assert.ok(r.data.badgeMaxHours > 0, "ping config still returned");
});

test("ingestion: duplicate seq_id is still deduped", async () => {
  const a = sessionFor(USER_A);
  const payload = {
    domain: "dedup-check.com",
    durationSeconds: 12,
    seq_id: "regression-seq-dedup-001",
  };
  const first = await call("POST", "/api/screen-time", {
    cookie: cookieHeader(a),
    json: true,
    body: payload,
  });
  const second = await call("POST", "/api/screen-time", {
    cookie: cookieHeader(a),
    json: true,
    body: payload,
  });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);

  const logs = await call("GET", "/api/logs", { cookie: cookieHeader(a) });
  const matches = logs.data.logs.filter((l) => l.domain === "dedup-check.com");
  assert.equal(matches.length, 1, "duplicate seq_id must not double-count");
});

test("ingestion: text/plain body (legacy beacon path) still works", async () => {
  const a = sessionFor(USER_A);
  const res = await fetch(`${baseUrl}/api/screen-time`, {
    method: "POST",
    headers: {
      Cookie: cookieHeader(a),
      "Content-Type": "text/plain",
    },
    body: JSON.stringify({
      domain: "beacon-check.com",
      durationSeconds: 9,
      seq_id: "regression-beacon-001",
    }),
  });
  assert.equal(res.status, 201);
});