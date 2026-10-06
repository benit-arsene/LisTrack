/**
 * LisTrack Visit Tracker (content script)
 * --------------------------------------
 * Browser-side detection for the "Most Visited Sites" feature.
 *
 * This script answers one question per document: did the user engage with
 * this page? It registers the six qualifying interaction events and, on the
 * first one, sends a message to the background service worker. The background
 * owns visitId generation, 30-minute visit windows, cross-tab deduplication,
 * and persistence. The tracker does NOT create or persist a visit_id.
 *
 *     page load        -> 0 visits
 *     idle on the page -> 0 visits
 *     first scroll etc -> 1 message sent to background
 *     anything after   -> no further messages (background is authoritative)
 *     page reload      -> a new document, so a new message may be sent
 *
 * SCOPE: one outbound message, and nothing else. On the first engagement it
 * sends a single namespaced runtime message ({ type, domain }) to
 * the service worker. There is no network call, no persistence and no offline
 * queue here — the service worker owns identity and anything further.
 *
 * PRIVACY: the handler reads ONLY the event type. It never inspects the
 * event target, key values, coordinates, page contents, form values or any
 * other interaction detail, and nothing about the page or the person is
 * retained. Pointer movement (mousemove / touchmove) is not an interaction
 * and is never listened for, so passive mouse drift cannot open a visit.
 * The reported domain is the bare hostname — no URL, path, query or hash.
 *
 * ISOLATION: this file holds its own minimal state and shares nothing with
 * the existing timing content script. It does not read or call any timing,
 * idle, pause, visibility or sign-in state, and it does not send anything
 * to the network. Listeners are passive and capture-phase so that site
 * scripts cannot suppress detection by stopping propagation, and they never
 * cancel or alter page behaviour.
 */
(function () {
  "use strict";

  // Only the six engaged interactions. Pointer/touch movement is excluded.
  const QUALIFYING_EVENTS = [
    "scroll",
    "mousedown",
    "click",
    "keydown",
    "touchstart",
    "wheel",
  ];
  const LISTENER_OPTIONS = { passive: true, capture: true };

  // The one dedicated message type this script is allowed to send.
  const VISIT_MESSAGE_TYPE = "lisTrack:siteVisit";

  /**
   * Create an independent visit tracker bound to one document.
   *
   * @param {Object} [options]
   * @param {EventTarget} [options.target] listener host (defaults to window)
   * @param {string} [options.hostname] bare hostname to report (defaults to
   *   the document's own hostname)
   * @returns {Object} tracker handle — see the methods below. Listeners are
   *   attached before this returns; call stop() to detach them.
   */
  function createVisitTracker(options) {
    const opts = options || {};
    const target = opts.target || (typeof window !== "undefined" ? window : null);
    if (!target || typeof target.addEventListener !== "function") {
      throw new Error("[visit-tracker] an event target is required");
    }

    // The bare hostname — never the full URL, path, query or hash.
    const hostname =
      opts.hostname !== undefined
        ? opts.hostname
        : typeof window !== "undefined" && window.location
        ? window.location.hostname
        : "";

    // Local latch: has this document already sent its message?
    // The background remains the authority on whether it counts as a visit.
    let hasSent = false;
    let listening = false;

    /**
     * Report the engaged visit to the service worker. Called once per
     * document, from the single place a visit becomes true.
     *
     * Carries only the fact and the bare hostname. NO visit_id, no identity.
     * The background resolves the authenticated account and generates the visitId.
     */
    function reportVisit() {
      if (hasSent) return;
      if (!hostname) return;
      if (
        typeof chrome === "undefined" ||
        !chrome.runtime ||
        !chrome.runtime.sendMessage
      ) {
        return;
      }
      try {
        chrome.runtime.sendMessage(
          { type: VISIT_MESSAGE_TYPE, domain: hostname },
          () => {
            // Reading lastError is how a dropped message stays silent.
            void chrome.runtime.lastError;
          },
        );
        hasSent = true;
      } catch (_) {}
    }

    /**
     * The single listener for every qualifying event.
     * @param {Event} event
     */
    function handleInteraction(event) {
      // PRIVACY: `event.type` is the only property read here, by design.
      if (!QUALIFYING_EVENTS.includes(event.type)) return;
      if (hasSent) return;

      // The single place a visit message is sent for this document.
      console.log("[visit-tracker] engaged visit recorded");

      reportVisit();
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

      /** Has this document sent its visit message? */
      hasEngaged() {
        return hasSent;
      },

      /** Messages sent for this document: 0 or 1. */
      getVisitCount() {
        return hasSent ? 1 : 0;
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
       * Reset the local latch so the next qualifying interaction sends again.
       * A page reload achieves this implicitly, because a new document gets
       * a brand new tracker. The background remains authoritative on whether
       * the new message counts as a new visit (30-minute window logic).
       */
      reset() {
        hasSent = false;
      },
    };
  }

  // The tracker installed on this document, if any.
  let activeTracker = null;

  const api = {
    QUALIFYING_EVENTS,
    LISTENER_OPTIONS,
    VISIT_MESSAGE_TYPE,
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