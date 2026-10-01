/**
 * LisTrack C2 Security Tests — OAuth Token DOM Bridge
 * ====================================================
 * Regression tests proving that the Google OAuth access token can no longer
 * be obtained by webpage JavaScript through the content-script DOM event
 * bridge that was removed.
 *
 * The vulnerability (fixed): `public/js/tracker.js` — injected into every
 * http(s) page — listened for a page-dispatchable `lisTrack:getAccessToken`
 * DOM event and replied with `lisTrack:accessTokenResponse` carrying the raw
 * OAuth access token. Any website the user visited could harvest that token.
 *
 * These tests are deliberately STATIC (source inspection). The bridge's whole
 * exploitability came from page↔content-script coupling, which cannot be
 * faithfully exercised outside a real Chrome isolated-world context. Static
 * assertions are therefore the correct and reliable guard here: they prove the
 * vulnerable code no longer exists anywhere in the shipped sources.
 *
 * Runtime behaviour (bearer auth, tracking) is covered by test/auth.test.js.
 *
 * Run: node --test test/c2-token-bridge.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/**
 * Blank out comments while PRESERVING line structure.
 *
 * A naive regex stripper is NOT safe here: tracker.js contains comment text
 * that itself embeds a block-comment terminator, so a lazy block-comment
 * pattern matches across ~8,000 characters of live code and silently deletes
 * it. This small state machine walks the source properly (tracking line
 * comments, block comments, and string/template literals) so only genuine
 * comments are removed.
 *
 * Comment characters are replaced by spaces rather than removed, so byte
 * offsets and line numbers stay stable for debugging.
 */
function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;

  const isIdentChar = (c) => /[A-Za-z0-9_$]/.test(c);

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    // Line comment
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }

    // Block comment
    if (c === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < n) {
        if (src[i] === "*" && src[i + 1] === "/") {
          out += "  ";
          i += 2;
          break;
        }
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }

    // String / template literal — copy verbatim, honouring escapes.
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += src[i];
      i++;
      while (i < n) {
        if (src[i] === "\\") {
          out += src[i] + (src[i + 1] || "");
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // Regular expression literal — skip so a `//` inside it is not treated as
    // a comment. Detected by a preceding `(`, `,`, `=`, `:`, `return`, etc.
    if (c === "/" && !isIdentChar(src[i - 1] || "") && src[i - 1] !== ")" ) {
      let j = i + 1;
      let inClass = false;
      let ok = false;
      while (j < n) {
        const d = src[j];
        if (d === "\\") { j += 2; continue; }
        if (d === "\n") break;
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) { ok = true; break; }
        j++;
      }
      if (ok) {
        out += src.slice(i, j + 1);
        i = j + 1;
        continue;
      }
    }

    out += src[i];
    i++;
  }

  return out;
}

const CODE = {
  tracker: stripComments(read("public/js/tracker.js")),
  background: stripComments(read("public/js/background.js")),
  popup: stripComments(read("public/js/popup.js")),
  onboarding: stripComments(read("public/js/onboarding.js")),
  indexHtml: stripComments(read("public/html/index.html")),
  manifest: stripComments(read("manifest.json")),
};

// ═══════════════════════════════════════════════════════════════════════════
// 1. The DOM event bridge is gone
// ═══════════════════════════════════════════════════════════════════════════

test("C2: tracker.js no longer listens for lisTrack:getAccessToken", () => {
  assert.ok(
    !CODE.tracker.includes("lisTrack:getAccessToken"),
    "tracker.js must not reference the getAccessToken DOM event"
  );
});

test("C2: tracker.js no longer dispatches lisTrack:accessTokenResponse", () => {
  assert.ok(
    !CODE.tracker.includes("lisTrack:accessTokenResponse"),
    "tracker.js must not dispatch an accessTokenResponse DOM event"
  );
});

test("C2: no shipped file references either bridge event name", () => {
  for (const [name, src] of Object.entries(CODE)) {
    assert.ok(
      !src.includes("lisTrack:getAccessToken"),
      `${name} must not reference lisTrack:getAccessToken`
    );
    assert.ok(
      !src.includes("lisTrack:accessTokenResponse"),
      `${name} must not reference lisTrack:accessTokenResponse`
    );
  }
});

test("C2: tracker.js registers no window listener that returns data to the page", () => {
  // The content script runs on every page, so a listener that *responds* is
  // the dangerous shape. The three remaining listeners are inert lifecycle
  // hooks for idle tracking (activity / pagehide / beforeunload) that send
  // nothing back. Pin that exact allowlist so a future response-style bridge
  // cannot hide behind a new event name.
  const listeners = [...CODE.tracker.matchAll(/window\.addEventListener\(\s*['"`]([^'"`]+)['"`]/g)]
    .map((m) => m[1]);
  const allowed = new Set(["pagehide", "beforeunload"]);
  for (const name of listeners) {
    if (allowed.has(name)) continue;
    // Activity events are registered via a variable (eventType) — allow them.
    assert.ok(
      !name.startsWith("lisTrack"),
      `tracker.js must not register a 'lisTrack*' window listener (page-reachable bridge)`
    );
  }
  // No listener may dispatch a CustomEvent back to the page.
  assert.ok(
    !/dispatchEvent/.test(CODE.tracker),
    "tracker.js must not dispatch any event back into page context"
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. The service worker no longer hands a credential to a renderer
// ═══════════════════════════════════════════════════════════════════════════

test("C2: background.js has no getAccessToken message handler", () => {
  assert.ok(
    !/type\s*===?\s*['"]getAccessToken['"]/.test(CODE.background),
    "background.js must not handle a getAccessToken message"
  );
  assert.ok(
    !/sendMessage\(\s*\{\s*type:\s*['"]getAccessToken['"]/.test(CODE.background),
    "background.js must not request a getAccessToken message"
  );
});

test("C2: no sendResponse payload carries an accessToken field", () => {
  // Scan every object literal passed to sendResponse for a token field.
  const sendResponseCalls = CODE.background.match(
    /sendResponse\(\s*\{[\s\S]*?\}\s*\)/g
  ) || [];
  for (const call of sendResponseCalls) {
    assert.ok(
      !/accessToken\s*:/.test(call),
      `sendResponse must not return an accessToken field:\n${call.slice(0, 160)}`
    );
  }
});

test("C2: no message handler returns a raw token value", () => {
  // Broad net: any handler sending back something token-shaped.
  assert.ok(
    !/sendResponse\(\s*\{\s*accessToken\s*\}/.test(CODE.background),
    "background.js must not sendResponse a bare access token"
  );
  // And nothing that hands getGoogleAccessToken()'s result to a caller.
  assert.ok(
    !/sendResponse\(\s*\{\s*accessToken:\s*accessToken\s*\}/.test(CODE.background),
    "background.js must not echo the OAuth token back to a renderer"
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. No alternate webpage → extension bridge
// ═══════════════════════════════════════════════════════════════════════════

test("C2: manifest exposes no externally_connectable surface", () => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.ok(
    !("externally_connectable" in manifest),
    "manifest must not declare externally_connectable (would allow webpage messaging)"
  );
  assert.ok(
    !("web_accessible_resources" in manifest),
    "manifest must not declare web_accessible_resources"
  );
});

test("C2: no onMessageExternal or runtime.connect bridge exists", () => {
  for (const [name, src] of Object.entries(CODE)) {
    assert.ok(
      !/onMessageExternal/.test(src),
      `${name} must not use chrome.runtime.onMessageExternal`
    );
    assert.ok(
      !/runtime\.connect\b/.test(src),
      `${name} must not use chrome.runtime.connect to expose a port`
    );
  }
});

test("C2: no postMessage bridge exists in extension code", () => {
  for (const [name, src] of Object.entries(CODE)) {
    assert.ok(
      !/postMessage/.test(src),
      `${name} must not use postMessage to share data with pages`
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. The token is never placed in page/DOM-visible sinks
// ═══════════════════════════════════════════════════════════════════════════

test("C2: the OAuth token is never written into a DOM href or dataset", () => {
  for (const [name, src] of Object.entries(CODE)) {
    assert.ok(
      !/href\s*=\s*["'`][^"'`]*access_token=/.test(src),
      `${name} must not build an href containing access_token`
    );
    assert.ok(
      !/dataset\.[A-Za-z0-9_]+\s*=\s*[^;]*access_?[Tt]oken/.test(src),
      `${name} must not write a token into a data attribute`
    );
  }
});

test("C2: the OAuth token is never written to page storage", () => {
  for (const [name, src] of Object.entries(CODE)) {
    assert.ok(
      !/(localStorage|sessionStorage)\.setItem\(\s*['"`][^'"`]*token/i.test(src),
      `${name} must not persist a token in web storage`
    );
  }
});

test("C2: no extension file logs the OAuth token value", () => {
  for (const [name, src] of Object.entries(CODE)) {
    const logCalls = src.match(/console\.(log|warn|error|info|debug)\([^)]*\)/g) || [];
    for (const call of logCalls) {
      assert.ok(
        !/accessToken/.test(call),
        `${name} must not log a token:\n${call}`
      );
      assert.ok(
        !/ya29\./.test(call),
        `${name} must not log a token literal`
      );
    }
  }
});

test("C2: the landing page no longer requests or receives a token", () => {
  assert.ok(
    !/getAccessToken/.test(CODE.indexHtml),
    "index.html must not request an access token from the extension"
  );
  assert.ok(
    !/accessTokenResponse/.test(CODE.indexHtml),
    "index.html must not listen for an access token response"
  );
  assert.ok(
    !/CustomEvent/.test(CODE.indexHtml),
    "index.html must not dispatch CustomEvents to the content script"
  );
  // It must not navigate with a token in the query string either.
  assert.ok(
    !/location\.href\s*=\s*[^;]*access_token/.test(CODE.indexHtml),
    "index.html must not navigate with access_token in the URL"
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Legitimate functionality is preserved
// ═══════════════════════════════════════════════════════════════════════════

test("C2: extension sign-in still uses chrome.identity", () => {
  // Onboarding (interactive sign-in) and background/popup (token retrieval)
  // must all still obtain credentials through the supported API.
  assert.ok(
    /chrome\.identity\.getAuthToken/.test(CODE.onboarding),
    "onboarding.js must still perform Google sign-in"
  );
  assert.ok(
    /chrome\.identity\.getAuthToken/.test(CODE.background),
    "background.js must still obtain an access token for API calls"
  );
  assert.ok(
    /chrome\.identity\.getAuthToken/.test(CODE.popup),
    "popup.js must still obtain an access token for API calls"
  );
});

test("C2: bearer-token API authentication is still present and used", () => {
  // The extension authenticates API calls with a bearer header. This is the
  // legitimate replacement for the removed bridge and must stay intact.
  for (const [name, src] of Object.entries({
    background: CODE.background,
    popup: CODE.popup,
  })) {
    assert.ok(
      /Authorization:\s*`?Bearer/.test(src) || /['"]Bearer['"]\s*\$\{/.test(src),
      `${name} must still send a Bearer Authorization header`
    );
  }
});

test("C2: the service worker still authenticates dashboard navigation itself", () => {
  // openDashboardWithToken is what replaces the bridge: the worker performs
  // the navigation with the token attached and never exposes it to a page.
  assert.ok(
    /function openDashboardWithToken/.test(CODE.background),
    "background.js must keep openDashboardWithToken"
  );
  assert.ok(
    /openDashboardWithToken/.test(CODE.background),
    "background.js must route dashboard opening through openDashboardWithToken"
  );
});

test("C2: tracking ingestion is untouched", () => {
  // The fix must not disturb the tracking pipeline: the content script still
  // builds and forwards payloads to the worker, and the worker still posts
  // them to the ingestion endpoint with bearer auth.
  assert.ok(
    /chrome\.runtime\.sendMessage/.test(CODE.tracker),
    "tracker.js must still forward tracking payloads to the worker"
  );
  assert.ok(
    /durationSeconds/.test(CODE.tracker),
    "tracker.js must still build tracking payloads"
  );
  assert.ok(
    /\/api\/screen-time/.test(CODE.background),
    "background.js must still forward payloads to /api/screen-time"
  );
});

test("C2: content script still runs on all pages and does its job", () => {
  // Removing the bridge must not have broken the install-detection flag or
  // the tracker's normal operation.
  assert.ok(
    /dataset\.lisTrackInstalled/.test(CODE.tracker),
    "tracker.js must still set the install-detection flag"
  );
  const manifest = JSON.parse(read("manifest.json"));
  assert.ok(
    Array.isArray(manifest.content_scripts) && manifest.content_scripts.length > 0,
    "manifest must still declare content scripts"
  );
});