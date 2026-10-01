/**
 * LisTrack C3 Security Tests — Repository-Root Static Exposure
 * ===========================================================
 * Regression tests proving that the application directory is NOT served over
 * HTTP, while genuine public assets remain reachable.
 *
 * The vulnerability (fixed): server.js mounted the whole application
 * directory as a static root:
 *
 *     app.use(express.static(path.join(__dirname, "public")));
 *     app.use(express.static(__dirname));        // <-- published everything
 *
 * That second line served /server.js, /donation.js, /session.js,
 * /package.json, /manifest.json, /data.db (+ -wal/-shm), /server.log, and
 * any *.pem private key present in the deployment.
 *
 * These tests exercise the REAL Express app over HTTP rather than grepping
 * source, because the defect being guarded is runtime reachability: a 404 is
 * proof only if it comes from an actual request. The core assertion is not a
 * specific status code but a content check — no response may contain source,
 * secrets, or database bytes.
 *
 * Run: node --test test/c3-static-exposure.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Use a throwaway SQLite file so the project's own data/ is never touched.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "listrack-c3test-"));
const TMP_DB = path.join(TMP_DIR, "c3-test.db");
process.env.DATABASE_PATH = TMP_DB;
process.env.PORT = "0";
delete process.env.DATABASE_URL; // force the SQLite driver

let server;
let baseUrl;

test.before(async () => {
  const { start } = require("../server");
  server = await start();
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

/** GET a path and return { status, type, text }. */
async function get(p, init) {
  const res = await fetch(baseUrl + p, { redirect: "manual", ...init });
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    type: res.headers.get("content-type") || "",
    text: buf.toString("utf8"),
    buf,
  };
}

/**
 * Fail if a response leaks any known-sensitive marker.
 * Asserting on CONTENT (not just status) is the point of this suite:
 * "404 because it is not public" is fine; "200 with the file body" is C3.
 */
function assertNoLeak(res, label, markers = []) {
  const body = res.text;
  if (res.status === 200 && markers.length === 0) {
    // For binary/asset cases callers pass explicit markers; without any we
    // only require that the body is not source/secret-shaped.
    assert.ok(
      !/BEGIN (RSA )?PRIVATE KEY/.test(body),
      `${label} leaked a private key`
    );
    assert.ok(
      !/createPostgresDriver|requireAuth\s*\(|module\.exports\s*=/.test(body),
      `${label} leaked server source code`
    );
    return;
  }
  for (const marker of markers) {
    assert.ok(
      !body.includes(marker),
      `${label} leaked sensitive content (matched ${JSON.stringify(marker)})`
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Application source files must not be served
// ═══════════════════════════════════════════════════════════════════════════

test("C3: server-side source files are not publicly served", async () => {
  const targets = ["/server.js", "/donation.js", "/session.js"];
  for (const p of targets) {
    const res = await get(p);
    assert.notEqual(res.status, 200, `${p} must not be served (got 200)`);
    assertNoLeak(res, p, ["createPostgresDriver", "BEGIN", "module.exports"]);
  }
});

test("C3: /server.js does not return server source", async () => {
  const res = await get("/server.js");
  assert.notEqual(res.status, 200);
  // Even if some future middleware returns a body, it must not be the source.
  assert.ok(
    !res.text.includes("app.use(express.static"),
    "/server.js must not disclose server source"
  );
});

test("C3: package metadata is not publicly served", async () => {
  for (const p of ["/package.json", "/package-lock.json"]) {
    const res = await get(p);
    assert.notEqual(res.status, 200, `${p} must not be served`);
    assert.ok(
      !res.text.includes('"dependencies"'),
      `${p} must not disclose the dependency manifest`
    );
  }
});

test("C3: /manifest.json is not publicly served", async () => {
  const res = await get("/manifest.json");
  assert.notEqual(res.status, 200, "/manifest.json must not be served");
  // The extension manifest contains the OAuth client id and RSA public key.
  assert.ok(
    !res.text.includes("oauth2") && !res.text.includes('"key"'),
    "/manifest.json must not disclose extension manifest contents"
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Secrets must not be served
// ═══════════════════════════════════════════════════════════════════════════

test("C3: private key files are not publicly served", async () => {
  for (const p of ["/lisTrack-key.pem", "/server.pem", "/key.pem"]) {
    const res = await get(p);
    assert.notEqual(res.status, 200, `${p} must not be served`);
    assert.ok(
      !res.text.includes("PRIVATE KEY"),
      `${p} must not disclose a private key`
    );
  }
});

test("C3: dotfiles and env files are not publicly served", async () => {
  for (const p of ["/.env", "/.env.local", "/.gitignore", "/.git/config"]) {
    const res = await get(p);
    assert.notEqual(res.status, 200, `${p} must not be served`);
  }
});

test("C3: database files are not publicly served", async () => {
  for (const p of ["/data.db", "/data.db-wal", "/data.db-shm", "/data/screen-time.db"]) {
    const res = await get(p);
    assert.notEqual(res.status, 200, `${p} must not be served`);
    // A SQLite header would prove raw database bytes leaked.
    assert.ok(
      !res.text.includes("SQLite format 3"),
      `${p} must not disclose database bytes`
    );
  }
});

test("C3: log files are not publicly served", async () => {
  for (const p of ["/server.log", "/logs/server.log", "/npm-debug.log"]) {
    const res = await get(p);
    assert.notEqual(res.status, 200, `${p} must not be served`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Archives and other artifacts
// ═══════════════════════════════════════════════════════════════════════════

test("C3: source archives are not served, but the extension ZIP still downloads", async () => {
  // The extension bundle is intentionally public (the site offers it for
  // download), and it is now served via an explicit route.
  const zip = await get("/lisTrack-extension.zip");
  assert.equal(zip.status, 200, "the extension ZIP must remain downloadable");

  // Any OTHER archive in the app root must not be reachable.
  for (const p of ["/source.zip", "/backup.zip", "/app.tar.gz"]) {
    const res = await get(p);
    assert.notEqual(res.status, 200, `${p} must not be served`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Path traversal cannot escape public/
// ═══════════════════════════════════════════════════════════════════════════

test("C3: path traversal cannot escape the public directory", async () => {
  const traversals = [
    "/../server.js",
    "/../../server.js",
    "/../package.json",
    "/../lisTrack-key.pem",
    "/../data.db",
    "/..%2fserver.js",
    "/..%2F..%2Fserver.js",
    "/%2e%2e/server.js",
    "/%2e%2e%2fserver.js",
    "/html/../../server.js",
    "/js/../../package.json",
    "/./../server.js",
  ];
  for (const p of traversals) {
    const res = await get(p);
    assert.notEqual(res.status, 200, `traversal ${p} must not be served`);
    assert.ok(
      !res.text.includes("createPostgresDriver"),
      `traversal ${p} leaked server source`
    );
    assert.ok(
      !res.text.includes("PRIVATE KEY"),
      `traversal ${p} leaked a private key`
    );
  }
});

test("C3: traversal via absolute filesystem paths is not served", async () => {
  for (const p of ["/C:/Windows/win.ini", "//server.js", "/./package.json"]) {
    const res = await get(p);
    assert.notEqual(res.status, 200, `${p} must not be served`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Legitimate public assets remain accessible
// ═══════════════════════════════════════════════════════════════════════════

test("C3: legitimate public assets remain accessible", async () => {
  const publicAssets = [
    "/icon.png",
    "/html/index.html",
    "/html/dashboard.html",
    "/js/dashboard.js",
    "/js/background.js",
    "/js/tracker.js",
    "/css/dashboard.css",
  ];
  for (const p of publicAssets) {
    const exists = fs.existsSync(
      path.join(__dirname, "..", "public", p.replace(/^\//, ""))
    );
    if (!exists) continue; // only assert for files that actually ship
    const res = await get(p);
    assert.equal(res.status, 200, `${p} must still be served from public/`);
    assert.ok(res.buf.length > 0, `${p} must not be empty`);
  }
});

test("C3: the root route still serves the landing page", async () => {
  const res = await get("/");
  assert.equal(res.status, 200);
  assert.ok(
    /LisTrack/i.test(res.text),
    "/ must still serve the LisTrack landing page"
  );
});

test("C3: the extension ZIP is served by an explicit route, not a directory mount", async () => {
  const res = await get("/lisTrack-extension.zip");
  assert.equal(res.status, 200);
  // A real ZIP starts with the PK magic bytes.
  assert.ok(
    res.buf.length > 4 && res.buf[0] === 0x50 && res.buf[1] === 0x4b,
    "extension ZIP must be a real zip archive"
  );
  // Neighbouring files in the same directory must still be unreachable.
  const neighbour = await get("/package.json");
  assert.notEqual(neighbour.status, 200, "siblings of the ZIP must not be served");
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Static regression guard on the source
// ═══════════════════════════════════════════════════════════════════════════

test("C3: server.js does not mount the application directory as a static root", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const code = src
    .split("\n")
    .map((line) => (/^\s*\/\//.test(line) ? "" : line))
    .join("\n");

  assert.ok(
    !/express\.static\(\s*__dirname\s*\)/.test(code),
    "server.js must never call express.static(__dirname)"
  );
  assert.ok(
    !/express\.static\(\s*['"]\.['"]\s*\)/.test(code),
    "server.js must never mount '.' as a static root"
  );
  // The only static mount must be scoped to public/.
  const mounts = code.match(/express\.static\([^)]*\)/g) || [];
  for (const m of mounts) {
    assert.ok(
      /public/.test(m),
      `unexpected static mount (must be scoped to public/): ${m}`
    );
  }
});

test("C3: every sendFile target is a fixed constant, never user input", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const code = src
    .split("\n")
    .map((line) => (/^\s*\/\//.test(line) ? "" : line))
    .join("\n");

  const sendFiles = code.match(/res\.sendFile\([^)]*\)/g) || [];
  assert.ok(sendFiles.length > 0, "expected the landing page to be sent via sendFile");
  for (const call of sendFiles) {
    // Reject anything that interpolates a request property.
    assert.ok(
      !/req\.(params|query|body|path|url|headers)/.test(call),
      `res.sendFile must not use request input: ${call}`
    );
    assert.ok(
      !/\$\{/.test(call),
      `res.sendFile must not interpolate a variable: ${call}`
    );
  }
});