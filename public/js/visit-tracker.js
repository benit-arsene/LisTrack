/**
 * LisTrack Visit Tracker (content script)
 * --------------------------------------
 * Browser-side detection for the "Most Visited Sites" feature.
 *
 * This script answers one question per document: did the user engage with
 * this page? It registers the six qualifying interaction events and, on the
 * first one, asks the visit-session state machine whether a visit should be
 * counted. After that first interaction every later interaction is ignored
 * for the lifetime of the document, so one browsing session yields exactly
 * one engaged visit.
 *
 *     page load        -> 0 visits
 *     idle on the page -> 0 visits
 *     first scroll etc -> 1 visit
 *     anything after   -> still 1 visit
 *     page reload      -> a new document, so a new session
 *
 * SCOPE: purely local. It records the FACT that an engagement happened, in
 * memory, and nothing else — no reporting, no persistence and no messaging
 * are implemented here. Reporting is a separate concern and is deliberately
 * not present in this file.
 *
 * PRIVACY: the handler reads ONLY the event type. It never inspects the
 * event target, key values, coordinates, page contents, form values or any
 * other interaction detail, and nothing about the page or the person is
 * retained. Pointer movement (mousemove / touchmove) is not an interaction
 * and is never listened for, so passive mouse drift cannot open a visit.
 *
 * ISOLATION: this file holds its own session state via visit-session.js and
 * shares nothing with the existing timing content script. It does not read
 * or call any timing, idle, pause, visibility or sign-in state, and it does
 * not send anything to the service worker or the network. Listeners are
 * passive and capture-phase so that site scripts cannot suppress detection
 * by stopping propagation, and they never cancel or alter page behaviour.
 *
 * Depends on: public/js/visit-session.js (loaded immediately before this
 * file in the same content-script world — see manifest.json).
 */
(function () {
  "use strict";

  // The state machine. In the browser it is already on globalThis because
  // visit-session.js runs first in this same isolated world; under Node
  // (tests) it is pulled in as a CommonJS module.
  const visitSession =
    typeof module !== "undefined" && module.exports
      ? require("./visit-session.js")
      : globalThis.LisTrackVisitSession;

  if (!visitSession || typeof visitSession.createVisitSession !== "function") {
    throw new Error(
      "[visit-tracker] visit-session.js must be loaded before visit-tracker.js",
    );
  }

  // Only the six engaged interactions. Pointer/touch movement is excluded.
  const QUALIFYING_EVENTS = visitSession.QUALIFYING_EVENTS;
  const LISTENER_OPTIONS = { passive: true, capture: true };

  /**
   * Create an independent visit tracker bound to one document.
   *
   * @param {Object} [options]
   * @param {EventTarget} [options.target] listener host (defaults to window)
   * @returns {Object} tracker handle — see the methods below. Listeners are
   *   attached before this returns; call stop() to detach them.
   */
  function createVisitTracker(options) {
    const opts = options || {};
    const target = opts.target || (typeof window !== "undefined" ? window : null);
    if (!target || typeof target.addEventListener !== "function") {
      throw new Error("[visit-tracker] an event target is required");
    }

    // One tracker owns one visit-session. This is the ONLY state here.
    const session = visitSession.createVisitSession();
    let listening = false;

    /**
     * The single listener for every qualifying event.
     * @param {Event} event
     */
    function handleInteraction(event) {
      // PRIVACY: `event.type` is the only property read here, by design.
      if (!session.shouldCountVisit(event.type)) return;
      if (!session.markVisit()) return;

      // The single place a visit becomes true for this document. Constant
      // message only — no domain, identity or interaction detail is logged.
      console.log("[visit-tracker] engaged visit recorded");
    }

    function start() {
      if (listening) return;
      for (const eventType of QUALIFYING_EVENTS) {
        target.addEventListener(eventType, handleInteraction, LISTENER_OPTIONS);
      }
      listening = true;
    }

    function stop() {
      if (!listening) return;
      for (const eventType of QUALIFYING_EVENTS) {
        target.removeEventListener(eventType, handleInteraction, LISTENER_OPTIONS);
      }
      listening = false;
    }

    // Attach on creation so a freshly loaded document is live immediately.
    // start() is idempotent, so this cannot double-register.
    start();

    return {
      /** The listener itself (exposed so it can be driven directly). */
      handleInteraction,

      /** Has this document recorded an engaged visit? */
      hasEngaged() {
        return session.hasCounted();
      },

      /** Visits recorded for this document: 0 or 1. */
      getVisitCount() {
        return session.hasCounted() ? 1 : 0;
      },

      /** Are the qualifying listeners currently attached? */
      isListening() {
        return listening;
      },

      /** Attach the qualifying listeners. */
      start,

      /** Detach the qualifying listeners. */
      stop,

      /**
       * Start a fresh visit-session without reloading: the next qualifying
       * interaction counts again. A page reload achieves this implicitly,
       * because a new document gets a brand new tracker.
       */
      reset() {
        session.reset();
      },
    };
  }

  // The tracker installed on this document, if any.
  let activeTracker = null;

  const api = {
    QUALIFYING_EVENTS,
    LISTENER_OPTIONS,
    createVisitTracker,
    getActiveTracker: () => activeTracker,
  };

  // Auto-install in the extension content-script world only. `chrome` exists
  // there and not under Node, so requiring it keeps this file inert in tests
  // and in any non-extension context.
  if (
    typeof window !== "undefined" &&
    typeof window.addEventListener === "function" &&
    typeof chrome !== "undefined"
  ) {
    activeTracker = createVisitTracker({ target: window });
  }

  if (typeof globalThis !== "undefined") globalThis.LisTrackVisitTracker = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();