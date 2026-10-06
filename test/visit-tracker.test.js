/**
 * LisTrack Visit Tracker Tests — browser interaction detection
 * ============================================================
 * Behaviour tests for public/js/visit-tracker.js: the content script that
 * turns real DOM interactions into exactly ONE engaged visit per document.
 *
 * The browser APIs are stubbed with a minimal fake event target — no
 * automation framework and no new dependency.
 *
 * Run: node --test test/visit-tracker.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const VISIT_TRACKER_PATH = path.join(
  __dirname,
  "..",
  "public",
  "js",
  "visit-tracker.js",
);

const {
  QUALIFYING_EVENTS,
  VISIT_MESSAGE_TYPE,
  createVisitTracker,
} = require(VISIT_TRACKER_PATH);

// ─── Stubs ─────────────────────────────────────────────────────────────────

/**
 * Minimal EventTarget stand-in. Records registrations so tests can assert
 * WHICH events are listened for and with which options.
 */
function createFakeTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, handler, options) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push({ handler, options });
    },
    removeEventListener(type, handler) {
      const entries = listeners.get(type) || [];
      const kept = entries.filter((entry) => entry.handler !== handler);
      if (kept.length) listeners.set(type, kept);
      else listeners.delete(type);
    },
    /** Fire an event at the target; returns the event object. */
    dispatch(event) {
      for (const entry of listeners.get(event.type) || []) entry.handler(event);
      return event;
    },
    optionsFor(type) {
      const entries = listeners.get(type) || [];
      return entries.length ? entries[0].options : null;
    },
    registeredTypes() {
      return [...listeners.keys()].sort();
    },
    listenerCount() {
      let total = 0;
      for (const entries of listeners.values()) total += entries.length;
      return total;
    },
  };
}

/**
 * An event that may only have its `type` read. Any other property access
 * throws — this is the executable form of the privacy requirement: the
 * handler must never look at the target, key, coordinates or anything else.
 */
function strictEvent(type) {
  return new Proxy(
    { type },
    {
      get(target, prop) {
        if (typeof prop === "symbol") return Reflect.get(target, prop);
        if (prop !== "type") {
          throw new Error(
            `visit-tracker must not read event.${String(prop)} — only the event type may be inspected`,
          );
        }
        return target.type;
      },
    },
  );
}

/** A tracker wired to a fresh fake target. */
function setup(options) {
  const target = createFakeTarget();
  const tracker = createVisitTracker({ target, hostname: "example.com", ...options });
  return { target, tracker };
}

/**
 * A fake chrome.runtime.sendMessage recorder. Installed on globalThis for the
 * duration of a test and removed afterwards, so the content script sees the
 * extension runtime exactly as it would in a browser.
 */
function withFakeChrome(run) {
  const sent = [];
  const previous = globalThis.chrome;
  globalThis.chrome = {
    runtime: {
      sendMessage(message, callback) {
        sent.push(message);
        if (typeof callback === "function") callback({ received: true });
      },
      lastError: null,
    },
  };
  try {
    return run(sent);
  } finally {
    if (previous === undefined) delete globalThis.chrome;
    else globalThis.chrome = previous;
  }
}

/**
 * Strip comments so prose about a forbidden API cannot satisfy or trip a
 * static guard. Without this, merely documenting "never touches chrome.storage"
 * would fail the check that forbids referencing it.
 */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

/** A plain, unguarded event for tests that only care about the type. */
function event(type) {
  return { type };
}

// ─── Listener registration ────────────────────────────────────────────────

test("exactly the six qualifying events are listened for", () => {
  const { target } = setup();
  assert.deepEqual(target.registeredTypes(), [
    "click",
    "keydown",
    "mousedown",
    "scroll",
    "touchstart",
    "wheel",
  ]);
});

test("mousemove and touchmove are never listened for", () => {
  const { target, tracker } = setup();
  assert.ok(!target.registeredTypes().includes("mousemove"));
  assert.ok(!target.registeredTypes().includes("touchmove"));
  // And firing them reaches no listener at all.
  target.dispatch(event("mousemove"));
  target.dispatch(event("touchmove"));
  assert.equal(tracker.getVisitCount(), 0);
});

test("listeners are passive and capture-phase so pages cannot suppress them", () => {
  const { target } = setup();
  for (const eventType of QUALIFYING_EVENTS) {
    const options = target.optionsFor(eventType);
    assert.ok(options, `${eventType} must have an options object`);
    assert.equal(options.passive, true, `${eventType} must be passive`);
    assert.equal(options.capture, true, `${eventType} must be capture-phase`);
  }
});

// ─── Detection behaviour ──────────────────────────────────────────────────

test("a page with no interaction records no visit", () => {
  withFakeChrome((sent) => {
    const { target, tracker } = setup();
    assert.equal(tracker.hasEngaged(), false);
    assert.equal(tracker.getVisitCount(), 0);
    // Time passing and unrelated events change nothing.
    for (const other of ["focus", "blur", "load", "resize", "visibilitychange"]) {
      target.dispatch(event(other));
    }
    assert.equal(tracker.getVisitCount(), 0);
    assert.equal(tracker.hasEngaged(), false);
  });
});

test("scroll records exactly one visit", () => {
  withFakeChrome((sent) => {
    const { target, tracker } = setup();
    target.dispatch(strictEvent("scroll"));
    assert.equal(tracker.getVisitCount(), 1);
    assert.equal(tracker.hasEngaged(), true);
  });
});

test("click records exactly one visit", () => {
  withFakeChrome((sent) => {
    const { target, tracker } = setup();
    target.dispatch(strictEvent("click"));
    assert.equal(tracker.getVisitCount(), 1);
  });
});

test("keydown records exactly one visit", () => {
  withFakeChrome((sent) => {
    const { target, tracker } = setup();
    // strictEvent proves no key value is read — only the event type.
    target.dispatch(strictEvent("keydown"));
    assert.equal(tracker.getVisitCount(), 1);
  });
});

test("touchstart records exactly one visit", () => {
  withFakeChrome((sent) => {
    const { target, tracker } = setup();
    target.dispatch(strictEvent("touchstart"));
    assert.equal(tracker.getVisitCount(), 1);
  });
});

test("wheel records exactly one visit", () => {
  withFakeChrome((sent) => {
    const { target, tracker } = setup();
    target.dispatch(strictEvent("wheel"));
    assert.equal(tracker.getVisitCount(), 1);
  });
});

test("mousedown records exactly one visit", () => {
  withFakeChrome((sent) => {
    const { target, tracker } = setup();
    target.dispatch(strictEvent("mousedown"));
    assert.equal(tracker.getVisitCount(), 1);
  });
});

test("mousemove does not record a visit", () => {
  withFakeChrome((sent) => {
    const { target, tracker } = setup();
    for (let i = 0; i < 200; i++) target.dispatch(strictEvent("mousemove"));
    assert.equal(tracker.hasEngaged(), false);
    assert.equal(tracker.getVisitCount(), 0);
  });
});

test("touchmove does not record a visit", () => {
  withFakeChrome((sent) => {
    const { target, tracker } = setup();
    for (let i = 0; i < 200; i++) target.dispatch(strictEvent("touchmove"));
    assert.equal(tracker.hasEngaged(), false);
    assert.equal(tracker.getVisitCount(), 0);
  });
});

test("multiple qualifying events still produce exactly one visit", () => {
  withFakeChrome((sent) => {
    const { target, tracker } = setup();
    for (let round = 0; round < 20; round++) {
      for (const eventType of QUALIFYING_EVENTS) {
        target.dispatch(strictEvent(eventType));
      }
    }
    assert.equal(tracker.getVisitCount(), 1);
  });
});

test("movement mixed with real interaction still yields exactly one visit", () => {
  withFakeChrome((sent) => {
    const { target, tracker } = setup();
    target.dispatch(strictEvent("mousemove"));
    target.dispatch(strictEvent("touchmove"));
    assert.equal(tracker.getVisitCount(), 0);
    target.dispatch(strictEvent("scroll"));
    for (let i = 0; i < 50; i++) {
      target.dispatch(strictEvent("mousemove"));
      target.dispatch(strictEvent("scroll"));
    }
    assert.equal(tracker.getVisitCount(), 1);
  });
});

// ─── Session semantics ────────────────────────────────────────────────────

test("reset starts a fresh session so another visit can be recorded", () => {
  withFakeChrome((sent) => {
    const { target, tracker } = setup();
    target.dispatch(strictEvent("scroll"));
    assert.equal(tracker.getVisitCount(), 1);

    tracker.reset();
    assert.equal(tracker.getVisitCount(), 0, "reset clears the recorded visit");
    assert.equal(tracker.hasEngaged(), false);

    target.dispatch(strictEvent("click"));
    assert.equal(tracker.getVisitCount(), 1, "the new session records its own visit");
  });
});

test("a new tracker for a new document/session is independent", () => {
  withFakeChrome((sent) => {
    const first = setup();
    first.target.dispatch(strictEvent("scroll"));
    assert.equal(first.tracker.getVisitCount(), 1);

    // A page reload produces a brand new tracker with fresh state.
    const second = setup();
    assert.equal(second.tracker.getVisitCount(), 0, "a new document starts at 0 visits");
    assert.equal(second.tracker.hasEngaged(), false);
    second.target.dispatch(strictEvent("wheel"));
    assert.equal(second.tracker.getVisitCount(), 1);

    // Resetting one document must not disturb the other.
    first.tracker.reset();
    assert.equal(second.tracker.getVisitCount(), 1);
  });
});

test("stop detaches the listeners and re-start re-attaches them", () => {
  withFakeChrome((sent) => {
    const { target, tracker } = setup();
    assert.equal(tracker.isListening(), true);
    assert.equal(target.listenerCount(), 6);

    tracker.stop();
    assert.equal(tracker.isListening(), false);
    assert.equal(target.listenerCount(), 0);
    target.dispatch(strictEvent("scroll"));
    assert.equal(tracker.getVisitCount(), 0, "no listeners, no detection");

    tracker.start();
    target.dispatch(strictEvent("scroll"));
    assert.equal(tracker.getVisitCount(), 1);

    // Starting twice must not double-register the listeners.
    tracker.start();
    assert.equal(target.listenerCount(), 6);
    tracker.stop();
    assert.equal(target.listenerCount(), 0);
  });
});

// ─── The outbound visit message ──────────────────────────────────────────

test("no visit message is sent before an interaction", () => {
  withFakeChrome((sent) => {
    const { target } = setup();
    for (const other of ["focus", "blur", "load", "resize"]) {
      target.dispatch(event(other));
    }
    assert.deepEqual(sent, [], "nothing is reported for an idle page");
  });
});

test("the first qualifying interaction sends exactly one namespaced visit message", () => {
  withFakeChrome((sent) => {
    const { target } = setup();
    target.dispatch(strictEvent("scroll"));

    assert.equal(sent.length, 1, "one message per document session");
    assert.deepEqual(Object.keys(sent[0]).sort(), [
      "domain",
      "type",
    ]);
    assert.equal(sent[0].type, "lisTrack:siteVisit");
    assert.equal(sent[0].type, VISIT_MESSAGE_TYPE);
    assert.equal(sent[0].domain, "example.com");
  });
});

// ─── Privacy and isolation (static guards) ────────────────────────────────

test("the handler needs nothing but the event type", () => {
  withFakeChrome((sent) => {
    const { tracker } = setup();

    // Unknown / non-qualifying types are ignored outright.
    for (const unknown of ["mousemove", "touchmove", "focus", "", undefined]) {
      tracker.handleInteraction({ type: unknown });
    }
    assert.equal(tracker.getVisitCount(), 0, "no detail beyond the type is required");

    // A bare { type } object is sufficient to record the visit.
    tracker.handleInteraction({ type: "scroll" });
    assert.equal(tracker.getVisitCount(), 1);
  });
});

test("the tracker exposes no captured interaction data", () => {
  const { tracker } = setup();
  const surface = Object.keys(tracker).sort();
  assert.deepEqual(surface, [
    "getVisitCount",
    "handleInteraction",
    "hasEngaged",
    "isListening",
    "reset",
    "start",
    "stop",
  ]);
  for (const value of Object.values(tracker)) {
    assert.equal(typeof value, "function", "only behaviour is exposed, never data");
  }
  // Explicitly confirm getVisitId is absent
  assert.ok(!("getVisitId" in tracker), "getVisitId must not be exposed");
});

test("the content script performs no network, storage or credential access", () => {
  const src = codeOnly(fs.readFileSync(VISIT_TRACKER_PATH, "utf8"));
  const forbidden = [
    /\bfetch\s*\(/,
    /XMLHttpRequest/,
    /sendBeacon/,
    /navigator\.send/,
    /chrome\.storage/,
    /chrome\.identity/,
    /getAuthToken/,
    /clearAllCachedAuthTokens/,
    /localStorage/,
    /sessionStorage/,
    /chrome\.tabs/,
    /chrome\.alarms/,
  ];
  for (const pattern of forbidden) {
    assert.ok(
      !pattern.test(src),
      `visit-tracker.js must not reference ${pattern} (no network, storage or credentials)`,
    );
  }
});

test("the visit message is the single outbound call in the file", () => {
  const src = codeOnly(fs.readFileSync(VISIT_TRACKER_PATH, "utf8"));
  // One availability guard + exactly one call site.
  const calls = src.match(/chrome\.runtime\.sendMessage\(/g) || [];
  assert.equal(calls.length, 1, "exactly one sendMessage call site");
  assert.ok(
    !/\.sendMessage\s*\(/.test(src.replace(/chrome\.runtime\.sendMessage\(/g, "")),
    "no other messaging entry point may exist",
  );
});

test("the content script is independent of the screen-time tracker", () => {
  const src = codeOnly(fs.readFileSync(VISIT_TRACKER_PATH, "utf8"));
  const forbidden = [
    /activeTimeMs/,
    /sessionStart/,
    /pauseTimer/,
    /resumeTimer/,
    /handleUserActivity/,
    /checkIdle/,
    /IDLE_THRESHOLD/,
    /durationSeconds/,
    /screen-time/,
    /screen_time/,
    /public\/js\/tracker\.js/,
    /document\.hidden/,
    /visibilitychange/,
    /user_id/,
  ];
  for (const pattern of forbidden) {
    assert.ok(
      !pattern.test(src),
      `visit-tracker.js must not reference ${pattern} (screen-time state stays separate)`,
    );
  }
});

test("the tracker requires an event target it can listen on", () => {
  // No target is supplied and there is no window under Node.
  assert.throws(() => createVisitTracker({}), /an event target is required/);
  assert.throws(() => createVisitTracker({ target: null }), /an event target is required/);
  assert.throws(() => createVisitTracker({ target: {} }), /an event target is required/);
});

test("the visit message carries only the type and hostname", () => {
  withFakeChrome((sent) => {
    const { target } = setup();
    target.dispatch(strictEvent("click"));

    assert.deepEqual(
      Object.keys(sent[0]).sort(),
      ["domain", "type"],
      "nothing else may travel — no identity, path, query or detail",
    );
    for (const forbidden of [
      "user",
      "userId",
      "user_id",
      "email",
      "token",
      "path",
      "url",
      "href",
      "search",
      "hash",
      "title",
      "event",
      "timestamp",
      "visited_at",
      "time",
      "x",
      "y",
      "visit_id",
    ]) {
      assert.ok(
        !(forbidden in sent[0]),
        `the visit message must not carry "${forbidden}"`,
      );
    }
  });
});

test("further interactions send no further messages", () => {
  withFakeChrome((sent) => {
    const { target } = setup();
    target.dispatch(strictEvent("scroll"));
    for (let round = 0; round < 20; round++) {
      for (const eventType of QUALIFYING_EVENTS) {
        target.dispatch(strictEvent(eventType));
      }
      target.dispatch(strictEvent("mousemove"));
      target.dispatch(strictEvent("touchmove"));
    }
    assert.equal(sent.length, 1, "still exactly one message for the document");
  });
});

test("the latch is the single sender: a reset session reports its own visit", () => {
  withFakeChrome((sent) => {
    const { target, tracker } = setup();
    target.dispatch(strictEvent("wheel"));
    assert.equal(sent.length, 1);

    tracker.reset();
    target.dispatch(strictEvent("wheel"));
    assert.equal(sent.length, 2, "a fresh session sends its own single message");
  });
});

test("movement alone never sends a visit message", () => {
  withFakeChrome((sent) => {
    const { target } = setup();
    for (let i = 0; i < 200; i++) {
      target.dispatch(strictEvent("mousemove"));
      target.dispatch(strictEvent("touchmove"));
    }
    assert.deepEqual(sent, []);
  });
});

test("no visit message is sent when the hostname is unknown", () => {
  withFakeChrome((sent) => {
    const { target } = setup({ hostname: "" });
    target.dispatch(strictEvent("scroll"));
    assert.deepEqual(sent, [], "without a hostname there is nothing to report");
  });
});

test("no visit message is sent when the extension runtime is unavailable", () => {
  // No globalThis.chrome installed — the reporter must stay silent.
  const { target } = setup();
  assert.doesNotThrow(() => target.dispatch(strictEvent("scroll")));
});