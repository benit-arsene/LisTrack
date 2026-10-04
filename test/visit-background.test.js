/**
 * LisTrack Visit Background Boundary Tests
 * =========================================
 * Boundary tests for the content-script → service-worker message path of the
 * "Most Visited Sites" feature.
 *
 * The REAL public/js/background.js is loaded into Node behind a small chrome
 * mock, so these are behavioural, not grep-based: they can prove that a visit
 * message never reaches /api/screen-time and never creates an offline queue
 * entry, which a source inspection could not.
 *
 * What is asserted here:
 *   - lisTrack:siteVisit is routed by its dedicated type
 *   - it cannot fall through into the screen-time forwarder
 *   - identity comes from the existing chrome.storage.sync user_id gate
 *   - a client-supplied identity in the body is ignored by construction
 *   - an ordinary screen-time message behaves exactly as it always has
 *
 * Nothing is sent to any backend: the mock fetch only records calls.
 *
 * Run: node --test test/visit-background.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const BACKGROUND_PATH = path.join(ROOT, "public", "js", "background.js");
const VISIT_TRACKER_PATH = path.join(ROOT, "public", "js", "visit-tracker.js");

const VISIT_MESSAGE_TYPE = "lisTrack:siteVisit";
const SIGNED_IN_USER = "owner@example.com";

// ─── Harness ──────────────────────────────────────────────────────────────

/** Read a subset (or everything) out of a flat storage bag. */
function pick(store, keys) {
  if (keys === null || keys === undefined) return { ...store };
  const list = Array.isArray(keys) ? keys : [keys];
  const out = {};
  for (const key of list) if (key in store) out[key] = store[key];
  return out;
}

function createArea(store, calls, label) {
  return {
    get(keys, callback) {
      calls.storageGet.push({ area: label, keys });
      const out = pick(store, keys);
      if (typeof callback === "function") setImmediate(() => callback(out));
      return Promise.resolve(out);
    },
    set(items, callback) {
      calls.storageSet.push({ area: label, items });
      Object.assign(store, items);
      if (typeof callback === "function") setImmediate(callback);
      return Promise.resolve();
    },
    remove(keys, callback) {
      calls.storageRemove.push({ area: label, keys });
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
      if (typeof callback === "function") setImmediate(callback);
      return Promise.resolve();
    },
  };
}

/**
 * Build the chrome mock, install it, and load the real background.js once.
 * Returns the surfaces the tests assert on.
 */
function loadBackground() {
  const listeners = { message: [], alarm: [], installed: [], startup: [] };
  const calls = { fetch: [], storageGet: [], storageSet: [], storageRemove: [] };
  const localStore = {};
  const syncStore = { user_id: SIGNED_IN_USER };

  const on = (bucket) => (listener) => listeners[bucket].push(listener);
  const noop = () => {};

  const chromeMock = {
    runtime: {
      onMessage: { addListener: on("message") },
      onInstalled: { addListener: on("installed") },
      onStartup: { addListener: on("startup") },
      getURL: (p) => `chrome-extension://listrack-mock/${p}`,
      sendMessage: () => Promise.resolve({}),
      lastError: null,
    },
    alarms: { create: noop, onAlarm: { addListener: on("alarm") } },
    notifications: { create: noop, onClicked: { addListener: noop } },
    contextMenus: { create: noop, onClicked: { addListener: noop } },
    webNavigation: { onBeforeNavigate: { addListener: noop } },
    identity: {
      getAuthToken(options, callback) {
        callback("mock-google-access-token");
      },
      clearAllCachedAuthTokens(callback) {
        if (callback) callback();
      },
    },
    action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
    storage: {
      local: createArea(localStore, calls, "local"),
      sync: createArea(syncStore, calls, "sync"),
      onChanged: { addListener: noop },
    },
  };

  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  const previousImportScripts = globalThis.importScripts;

  globalThis.chrome = chromeMock;
  globalThis.importScripts = (rel) => {
    // Load the real blocker module so normalizeDomain is the genuine one.
    globalThis.LisTrackBlocker = require(path.join(ROOT, "public", "js", rel));
  };
  globalThis.fetch = async (url, options) => {
    calls.fetch.push({ url: String(url), options });
    return { ok: true, status: 200, json: async () => ({}) };
  };

  delete require.cache[require.resolve(BACKGROUND_PATH)];
  require(BACKGROUND_PATH);

  // The worker resolves `chrome` and `fetch` as free variables at CALL time,
  // so the mocks must stay installed for the whole file. They are restored
  // once, in test.after.
  return {
    chromeMock,
    listeners,
    calls,
    localStore,
    syncStore,
    restore() {
      globalThis.chrome = previousChrome;
      globalThis.fetch = previousFetch;
      globalThis.importScripts = previousImportScripts;
    },
  };
}

const harness = loadBackground();

test.after(() => harness.restore());

/** Reset per-test state. */
function reset() {
  harness.calls.fetch.length = 0;
  harness.calls.storageGet.length = 0;
  harness.calls.storageSet.length = 0;
  harness.calls.storageRemove.length = 0;
  harness.localStore.lisTrackOfflineQueue = undefined;
  delete harness.localStore.lisTrackOfflineQueue;
  harness.syncStore.user_id = SIGNED_IN_USER;
}

/** A screen-time payload exactly as the existing tracker sends it. */
function screenTimePayload(overrides) {
  return {
    domain: "example.com",
    path: "/watch",
    durationSeconds: 30,
    timestamp: "2026-10-04T12:00:00.000Z",
    seq_id: "seq-under-test-1",
    recovered: false,
    ...overrides,
  };
}

function visitMessage(overrides) {
  return { type: VISIT_MESSAGE_TYPE, domain: "example.com", ...overrides };
}

/** Dispatch a message to every registered onMessage listener, as Chrome does. */
async function dispatch(message) {
  const responses = [];
  const sender = {
    id: "listrack-mock",
    url: "https://example.com/watch",
    tab: { id: 42, url: "https://example.com/watch" },
  };
  for (const listener of harness.listeners.message) {
    listener(message, sender, (response) => responses.push(response));
  }
  // Let the handler's promise chain settle.
  await new Promise((resolve) => setTimeout(resolve, 30));
  return responses;
}

test.beforeEach(reset);

// ─── 1. The message is recognised by its dedicated type ───────────────────

test("a visit message is recognised by its dedicated type", async () => {
  const responses = await dispatch(visitMessage());
  assert.equal(responses.length, 1, "exactly one listener answers");
  assert.deepEqual(responses[0], { received: true, visitCounted: true });
});

test("the worker recognises the exact namespaced type constant", () => {
  const src = fs.readFileSync(BACKGROUND_PATH, "utf8");
  assert.match(
    src,
    /const TYPE_NAMESPACE = "lisTrack:";/,
    "a namespaced-type guard must exist",
  );
  assert.match(
    src,
    /const VISIT_MESSAGE_TYPE = "lisTrack:siteVisit";/,
    "the visit type must be declared once, in the worker",
  );
});

// ─── 2 & 3. No fallthrough into the screen-time path ─────────────────────

test("a visit message does NOT enter the screen-time path", async () => {
  const responses = await dispatch(visitMessage());
  assert.deepEqual(responses[0], { received: true, visitCounted: true });
  // The screen-time forwarder would have answered { received, status } after
  // a fetch; nothing may have been fetched at all.
  assert.deepEqual(harness.calls.fetch, [], "no request may be made");
});

test("a visit message containing a domain is never POSTed to /api/screen-time", async () => {
  await dispatch(visitMessage());
  await dispatch(visitMessage({ domain: "www.example.com" }));
  const urls = harness.calls.fetch.map((call) => call.url);
  assert.deepEqual(urls, [], "no request of any kind may be made");
  assert.ok(
    !urls.some((url) => url.includes("/api/screen-time")),
    "/api/screen-time must never be hit by a visit message",
  );
});

test("a visit message repeated many times never produces a screen-time request", async () => {
  for (let i = 0; i < 5; i++) await dispatch(visitMessage());
  assert.deepEqual(harness.calls.fetch, [], "duplicate visits stay local");
  assert.equal(
    harness.localStore.lisTrackOfflineQueue,
    undefined,
    "duplicates must not queue anything",
  );
});

// ─── 4. No offline queue entry ───────────────────────────────────────────

test("a visit message does not create an offline screen-time queue entry", async () => {
  await dispatch(visitMessage());
  assert.equal(harness.localStore.lisTrackOfflineQueue, undefined);
  for (const write of harness.calls.storageSet) {
    assert.ok(
      !("lisTrackOfflineQueue" in write.items),
      "the visit path must never write the screen-time offline queue",
    );
  }
});

// ─── 5. Identity via the existing mechanism ──────────────────────────────

test("the signed-in user is resolved through the existing getUserId() gate", async () => {
  const responses = await dispatch(visitMessage());
  assert.equal(responses[0].received, true);

  const userIdReads = harness.calls.storageGet.filter(
    (call) =>
      call.area === "sync" &&
      Array.isArray(call.keys) &&
      call.keys.includes("user_id"),
  );
  assert.ok(
    userIdReads.length > 0,
    "the worker must read the existing chrome.storage.sync user_id",
  );
});

test("signing out mid-session changes the outcome for subsequent visits", async () => {
  assert.equal((await dispatch(visitMessage()))[0].received, true);
  harness.syncStore.user_id = undefined;
  const after = await dispatch(visitMessage());
  assert.deepEqual(after[0], { received: false, requiresAuth: true });
});

// ─── 6. Missing signed-in user ───────────────────────────────────────────

test("a missing signed-in user causes the visit to be ignored", async () => {
  harness.syncStore.user_id = undefined;
  const responses = await dispatch(visitMessage());

  assert.deepEqual(responses[0], { received: false, requiresAuth: true });
  assert.deepEqual(harness.calls.fetch, [], "nothing is recorded or sent");
  assert.equal(harness.localStore.lisTrackOfflineQueue, undefined);
});

test("an empty or blank signed-in user is ignored too", async () => {
  for (const value of ["", "   "]) {
    reset();
    harness.syncStore.user_id = value;
    const responses = await dispatch(visitMessage());
    assert.deepEqual(responses[0], { received: false, requiresAuth: true });
  }
});

// ─── 7. Client identity is never trusted ────────────────────────────────

test("a client-supplied identity is ignored and cannot be trusted", async () => {
  const responses = await dispatch(
    visitMessage({
      user: "victim@example.com",
      email: "victim@example.com",
      user_id: "victim@example.com",
      userId: "victim@example.com",
      userToken: "forged-token",
    }),
  );

  // The visit is accepted on the strength of the WORKER's own sign-in state,
  // not the body — and nothing forged leaves the worker.
  assert.equal(responses[0].received, true);
  assert.deepEqual(harness.calls.fetch, []);
  for (const write of harness.calls.storageSet) {
    assert.ok(
      !JSON.stringify(write.items).includes("victim@example.com"),
      "no client-supplied identity may be persisted anywhere",
    );
  }
});

test("the visit handler never reads an identity field from the message", () => {
  const src = fs.readFileSync(BACKGROUND_PATH, "utf8");
  const start = src.indexOf("async function handleSiteVisitMessage");
  const end = src.indexOf("// ─── Message Handler", start);
  assert.ok(start !== -1 && end > start, "the handler must exist");
  const body = codeOnly(src.slice(start, end));

  for (const pattern of [
    /message\.user/,
    /message\.email/,
    /message\.userId/,
    /message\.user_id/,
    /message\.token/,
    /message\.userToken/,
  ]) {
    assert.ok(
      !pattern.test(body),
      `handleSiteVisitMessage must not read ${pattern} — identity comes from getUserId()`,
    );
  }
  assert.match(
    body,
    /await getUserId\(\)/,
    "the handler must resolve the account itself",
  );
});

// ─── 8. Minimal information only ─────────────────────────────────────────

/** Only the screen-time forwarder's own requests. */
function screenTimeCalls() {
  return harness.calls.fetch.filter((call) => call.url.endsWith("/api/screen-time"));
}

/** Strip line and block comments so prose cannot be mistaken for code. */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

/** The body of handleSiteVisitMessage, comments removed. */
function visitHandlerBody() {
  const src = fs.readFileSync(BACKGROUND_PATH, "utf8");
  const start = src.indexOf("async function handleSiteVisitMessage");
  const end = src.indexOf("// ─── Message Handler", start);
  assert.ok(start !== -1 && end > start, "the handler must exist");
  return codeOnly(src.slice(start, end));
}

test("the visit handler reads only the type and the domain from the message", async () => {
  const responses = await dispatch(
    visitMessage({ path: "/secret", search: "?token=abc", hash: "#x", title: "Secret Page" }),
  );
  assert.equal(responses[0].received, true);

  const body = visitHandlerBody();
  // Only property reads off the message object itself count.
  const reads = [
    ...new Set(
      [...body.matchAll(/message\s*\??\s*\.\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
    ),
  ];
  assert.deepEqual(reads, ["domain"], "only `domain` may be read");
});

test("the content script builds a two-field message and nothing more", () => {
  const src = fs.readFileSync(VISIT_TRACKER_PATH, "utf8");
  const match = src.match(
    /sendMessage\(\s*\{([^}]*)\}/,
  );
  assert.ok(match, "the content script must send an inline object literal");
  const fields = [...match[1].matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map((m) => m[1]);
  assert.deepEqual(fields.sort(), ["domain", "type"]);

  for (const forbidden of ["user", "email", "user_id", "path", "url", "search", "hash"]) {
    assert.ok(
      !new RegExp(`\\b${forbidden}\\s*:`).test(match[1]),
      `the message literal must not include "${forbidden}"`,
    );
  }
});

test("the content script reports the bare hostname, never a full URL", () => {
  const src = fs.readFileSync(VISIT_TRACKER_PATH, "utf8");
  assert.match(src, /window\.location\.hostname/, "the hostname is the source");
  for (const forbidden of [/\.pathname/, /\.search/, /\.hash/, /\.href/]) {
    assert.ok(
      !forbidden.test(src),
      `the content script must not read location${forbidden}`,
    );
  }
});

// ─── 9. Existing screen-time behaviour is untouched ──────────────────────

test("an ordinary screen-time message still forwards to /api/screen-time", async () => {
  const payload = screenTimePayload();
  const responses = await dispatch(payload);

  // Only the forwarder's own request is asserted; the pre-existing blocker
  // hook separately syncs server goals on a ping, which is unrelated here.
  const calls = screenTimeCalls();
  assert.equal(calls.length, 1, "exactly one screen-time request, as before");
  const call = calls[0];
  assert.ok(call.url.endsWith("/api/screen-time"));
  assert.equal(call.options.method, "POST");
  assert.deepEqual(JSON.parse(call.options.body), payload, "payload forwarded as-is");

  assert.equal(responses.length, 1);
  assert.deepEqual(responses[0], { received: true, status: 200 });
});

test("a screen-time failure still buffers into the offline queue", async () => {
  // Proves the queue path the visit branch must never touch is still intact.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  try {
    await dispatch(screenTimePayload());
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(
    Array.isArray(harness.localStore.lisTrackOfflineQueue),
    "the existing screen-time retry queue must still be written",
  );
});

test("an untyped, domain-bearing message still uses the existing path", async () => {
  // Messages without a lisTrack: type keep their original routing.
  const responses = await dispatch(screenTimePayload());
  assert.equal(responses[0].received, true);
  assert.equal(screenTimeCalls().length, 1);
});

test("an unknown lisTrack: message type is dropped without falling through", async () => {
  const responses = await dispatch({
    type: "lisTrack:somethingElse",
    domain: "example.com",
    durationSeconds: 30,
  });

  assert.deepEqual(responses, [], "no listener answers an unknown namespaced type");
  assert.deepEqual(harness.calls.fetch, [], "and it never reaches the forwarder");
});

test("excluded domains are still filtered by the existing guard", async () => {
  const responses = await dispatch(
    screenTimePayload({ domain: "listrack.onrender.com" }),
  );
  assert.deepEqual(responses, []);
  assert.deepEqual(harness.calls.fetch, [], "excluded domains never forward");
});

// ─── Static guards on the worker ─────────────────────────────────────────

test("the worker adds no network call or credential use to the visit path", () => {
  const body = visitHandlerBody();
  for (const pattern of [
    /fetch\s*\(/,
    /sendBeacon/,
    /XMLHttpRequest/,
    /OFFLINE_QUEUE_KEY/,
    /pushToOfflineQueue/,
    /getGoogleAccessToken/,
    /authedFetchHeaders/,
  ]) {
    assert.ok(
      !pattern.test(body),
      `handleSiteVisitMessage must not reference ${pattern}`,
    );
  }
});

test("the worker keeps the existing screen-time forwarder untouched", () => {
  const src = fs.readFileSync(BACKGROUND_PATH, "utf8");
  // The forwarder must still exist, still be reached by untyped messages, and
  // still be the only place a screen-time request is issued.
  assert.match(src, /api\/screen-time/);
  assert.match(src, /if \(!message \|\| !message\.domain\) return;/);
  assert.match(src, /const payload = \{ \.\.\.message \};/);
  assert.match(src, /sendResponse\(\{ received: true, status: response\.status \}\);/);
});

test("the server accepts visits but exposes no visit aggregation yet", () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

  // Ingestion exists…
  assert.match(
    serverSrc,
    /app\.post\("\/api\/site-visits", requireAuth/,
    "the authenticated visit endpoint must exist",
  );

  // …but nothing beyond ingestion: no read route, no ranking, no aggregation.
  // Comments are stripped so prose (e.g. this feature's own section header)
  // cannot satisfy or trip the guard.
  const serverCode = codeOnly(serverSrc);
  assert.ok(
    !/app\.get\("\/api\/site-visits"/.test(serverCode),
    "there must be no visit READ route yet",
  );
  assert.ok(
    !/most[_ ]?visited/i.test(serverCode),
    "no Most Visited ranking may exist yet",
  );
  assert.ok(
    !/GROUP BY[\s\S]{0,120}site_visits/.test(serverCode),
    "site_visits must not be aggregated yet",
  );

  const dashboardSrc = fs.readFileSync(
    path.join(ROOT, "public", "js", "dashboard.js"),
    "utf8",
  );
  assert.ok(
    !/site-visits|lisTrack:siteVisit/.test(dashboardSrc),
    "the dashboard must not consume visits yet",
  );
});