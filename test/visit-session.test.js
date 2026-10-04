/**
 * LisTrack Visit Session Tests — "Most Visited Sites"
 * =================================================
 * Contract tests for the pure visit-session state machine
 * (public/js/visit-session.js): ONE engaged visit per browsing session,
 * never one per click or scroll.
 *
 * These are deliberately STATIC in scope — the module is dependency-free
 * and has no Chrome/network/database coupling, so it can be exercised
 * directly under Node with no mocks. Everything outside the module
 * (reporting, persistence, transport) is deliberately out of scope here.
 *
 * Run: node --test test/visit-session.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  QUALIFYING_EVENTS,
  NON_QUALIFYING_EVENTS,
  isQualifyingEvent,
  createVisitSession,
} = require(path.join(__dirname, "..", "public", "js", "visit-session.js"));

// ─── Qualifying vs non-qualifying event classification ─────────────────────

test("the qualifying event set is exactly the engaged interactions", () => {
  assert.deepEqual(
    [...QUALIFYING_EVENTS].sort(),
    ["click", "keydown", "mousedown", "scroll", "touchstart", "wheel"]
  );
});

test("each qualifying event can trigger the first visit", () => {
  for (const eventType of QUALIFYING_EVENTS) {
    const session = createVisitSession();
    assert.equal(
      session.shouldCountVisit(eventType),
      true,
      `${eventType} must open a visit`
    );
    assert.equal(session.hasCounted(), false, `${eventType}: nothing counted yet`);
    session.markVisit();
    assert.equal(session.hasCounted(), true, `${eventType}: visit counted`);
  }
});

test("non-qualifying events do not count", () => {
  const nonQualifying = [
    ...NON_QUALIFYING_EVENTS,
    "pointermove",
    "mousemove ",
    "mousedownx",
    "focus",
    "blur",
    "visibilitychange",
    "resize",
    "load",
    "",
  ];
  for (const eventType of nonQualifying) {
    const session = createVisitSession();
    assert.equal(
      session.shouldCountVisit(eventType),
      false,
      `${JSON.stringify(eventType)} must not open a visit`
    );
    // Repeating the event never advances the session on its own — the
    // module never counts by itself, only shouldCountVisit() + markVisit().
    for (let i = 0; i < 10; i++) session.shouldCountVisit(eventType);
    assert.equal(
      session.hasCounted(),
      false,
      `${JSON.stringify(eventType)} must not flip the session state`
    );
  }
});

test("mousemove and touchmove specifically remain non-qualifying", () => {
  for (const eventType of ["mousemove", "touchmove"]) {
    assert.equal(
      isQualifyingEvent(eventType),
      false,
      `${eventType} must be explicitly non-qualifying`
    );

    // Movement alone, repeated many times, never opens a visit.
    const session = createVisitSession();
    for (let i = 0; i < 100; i++) {
      assert.equal(session.shouldCountVisit(eventType), false);
    }
    assert.equal(session.hasCounted(), false, `${eventType} alone stays at 0 visits`);

    // And they stay non-qualifying once a visit already exists.
    session.markVisit();
    assert.equal(session.shouldCountVisit(eventType), false);
  }
});

test("unknown and non-string event types never qualify", () => {
  for (const value of [undefined, null, 0, 42, {}, [], true, Symbol("scroll")]) {
    assert.equal(isQualifyingEvent(value), false);
    const session = createVisitSession();
    assert.equal(session.shouldCountVisit(value), false);
    assert.equal(session.hasCounted(), false);
  }
});

// ─── One visit per session ─────────────────────────────────────────────────

test("before any qualifying interaction hasCounted() is false", () => {
  const session = createVisitSession();
  assert.equal(session.hasCounted(), false);
});

test("only the first qualifying interaction counts", () => {
  const session = createVisitSession();

  assert.equal(session.shouldCountVisit("scroll"), true);
  session.markVisit();

  // Every later interaction in the same session is a no-op.
  let visits = 1;
  const repeatInteractions = ["scroll", "click", "mousedown", "keydown", "wheel", "touchstart"];
  for (let i = 0; i < 50; i++) {
    for (const eventType of repeatInteractions) {
      if (session.shouldCountVisit(eventType)) {
        session.markVisit();
        visits++;
      }
    }
  }

  assert.equal(visits, 1, "repeat interactions must not open a second visit");
  assert.equal(session.hasCounted(), true);
});

test("markVisit changes state correctly and reports the transition once", () => {
  const session = createVisitSession();

  assert.equal(session.markVisit(), true, "the first markVisit performs the transition");
  assert.equal(session.hasCounted(), true);

  assert.equal(session.markVisit(), false, "a second markVisit is a no-op");
  assert.equal(session.markVisit(), false);
  assert.equal(session.hasCounted(), true, "state stays counted");
});

test("reset allows another visit", () => {
  const session = createVisitSession();

  session.markVisit();
  assert.equal(session.hasCounted(), true);

  session.reset();
  assert.equal(session.hasCounted(), false, "reset starts a fresh session");
  assert.equal(session.shouldCountVisit("scroll"), true, "the next interaction counts again");
  assert.equal(session.markVisit(), true);
  assert.equal(session.hasCounted(), true);
});

// ─── Isolation ────────────────────────────────────────────────────────────

test("sessions are independent of each other", () => {
  const a = createVisitSession();
  const b = createVisitSession();

  a.markVisit();

  assert.equal(a.hasCounted(), true);
  assert.equal(b.hasCounted(), false, "one session must not count for another");
  assert.equal(b.shouldCountVisit("scroll"), true);

  b.reset();
  assert.equal(a.hasCounted(), true, "reset is per-session");
});

test("reset on an untouched session is a harmless no-op", () => {
  const session = createVisitSession();
  session.reset();
  session.reset();
  assert.equal(session.hasCounted(), false);
  assert.equal(session.shouldCountVisit("click"), true);
});

test("the exported event lists are frozen", () => {
  assert.ok(Object.isFrozen(QUALIFYING_EVENTS));
  assert.ok(Object.isFrozen(NON_QUALIFYING_EVENTS));
});