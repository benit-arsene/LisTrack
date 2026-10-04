/**
 * LisTrack Visit Session State (isolated module)
 * ------------------------------------------------
 * Pure state machine backing the "Most Visited Sites" feature: it answers
 * one question only — has the user engaged with this page since it loaded?
 *
 * A "visit" is ONE engaged visit per browsing session (one top-level
 * document), not one per click or scroll:
 *
 *     open site -> 0        (no interaction yet)
 *     sit idle -> 0         (idle time is not engagement)
 *     scroll once -> 1
 *     scroll/click again -> still 1
 *     leave, return later   -> a fresh session, so +1
 *
 * Deliberately knows NOTHING about domains, users, authentication, the
 * network, Chrome APIs, screen time, idle state or storage. It is a pure
 * in-memory latch so it can never be coupled to the screen-time pipeline:
 * reporting, persistence and transport all live outside this file.
 *
 * Sessions are per document — the caller owns the lifetime and calls
 * reset() when it wants a new one (a new document is a new session).
 *
 * Exposed API (globalThis.LisTrackVisitSession / window / module.exports):
 *   QUALIFYING_EVENTS     — event types that can open a visit
 *   NON_QUALIFYING_EVENTS — event types that explicitly never qualify
 *   isQualifyingEvent(t)  — pure predicate: does this event type engage?
 *   createVisitSession()  — new independent session state
 *
 * A session exposes:
 *   hasCounted()            — has a visit already been counted?
 *   shouldCountVisit(event) — qualifying event AND no visit counted yet
 *   markVisit()             — count the visit; true only on the transition
 *   reset()                 — start a fresh session
 */
(function () {
  "use strict";

  // Engagement requires intent. Pointer/touch MOVEMENT is deliberately
  // absent: a drifting mouse or a finger resting on the glass while
  // reading is not an interaction, so it must never open a visit.
  const QUALIFYING_EVENTS = Object.freeze([
    "scroll",
    "mousedown",
    "click",
    "keydown",
    "touchstart",
    "wheel",
  ]);

  // Named so the exclusion is an explicit, testable decision rather than
  // an omission from the list above.
  const NON_QUALIFYING_EVENTS = Object.freeze(["mousemove", "touchmove"]);

  /**
   * Does this event type qualify as engagement?
   * Unknown, empty and non-string types never qualify.
   */
  function isQualifyingEvent(eventType) {
    return (
      typeof eventType === "string" && QUALIFYING_EVENTS.indexOf(eventType) !== -1
    );
  }

  /**
   * Create an independent visit-session state.
   * @returns {{hasCounted: () => boolean, shouldCountVisit: (eventType: string) => boolean, markVisit: () => boolean, reset: () => void}}
   */
  function createVisitSession() {
    let counted = false;

    return {
      /** Has a visit already been counted in this session? */
      hasCounted() {
        return counted;
      },

      /**
       * Should this event open a visit right now? True only for a
       * qualifying event in a session that has not counted yet — so
       * repeat interactions after the first can never produce a second
       * visit.
       */
      shouldCountVisit(eventType) {
        return !counted && isQualifyingEvent(eventType);
      },

      /**
       * Count the visit. Returns true only when this call performed the
       * transition (first visit), false when one was already counted, so
       * a caller that ignores the return value still cannot double count.
       */
      markVisit() {
        if (counted) return false;
        counted = true;
        return true;
      },

      /** Start a fresh session: the next qualifying interaction counts again. */
      reset() {
        counted = false;
      },
    };
  }

  const api = {
    QUALIFYING_EVENTS,
    NON_QUALIFYING_EVENTS,
    isQualifyingEvent,
    createVisitSession,
  };

  // Expose globally — works as a classic script (content script) and via
  // require() from tests. Same convention as public/js/blocker.js.
  if (typeof globalThis !== "undefined") globalThis.LisTrackVisitSession = api;
  if (typeof window !== "undefined") window.LisTrackVisitSession = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();