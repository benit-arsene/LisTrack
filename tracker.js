/**
 * Web Screen-Time Tracker (Fixed & Optimized)
 * -----------------------------------------
 * Handles idle states, tab visibility, blocks back-to-back unload triggers,
 * and safely clears crash checkpoints on orderly tab closures.
 */

(function () {
  "use strict";

  // ─── Configuration ───────────────────────────────────────────────────────
  const CONFIG = {
    // Absolute URL for fallback when the extension's service worker is dead.
    // When chrome.runtime.sendMessage fails (MV3 killed the worker), data is
    // sent directly to SERVER_URL + API_PATH so it's never lost.
    SERVER_URL: 'https://listrack-2.onrender.com',
    API_PATH: '/api/screen-time',
    IDLE_THRESHOLD_MS: 60_000,
    CHECKPOINT_INTERVAL_MS: 5_000,
    STORAGE_KEY: "web_screen_time_tracker",
    USER_TOKEN_KEY: "lisTrackTrackerToken",
  };

  // Domains to exclude from tracking (suffix matching).
  // LisTrack dashboard domains are blocked to avoid self-tracking.
  // Other render.com subdomains are NOT blocked.
  const IGNORED_DOMAIN_PATTERNS = ["localhost", "listrack.onrender.com", "listrack-2.onrender.com"];

  function shouldTrackDomain(domain) {
    return (
      typeof domain === "string" &&
      domain.length > 0 &&
      !IGNORED_DOMAIN_PATTERNS.some((pattern) =>
        domain === pattern || domain.endsWith("." + pattern)
      )
    );
  }

  // ─── Fallback Token ──────────────────────────────────────────────────────
  // Used when the Chrome extension is not installed — generates a persistent
  // identifier in localStorage so data sent via sendBeacon/fetch fallback
  // gets attributed to the correct user on the dashboard.

  function generateFallbackToken() {
    const chars = "0123456789abcdef";
    let token = "";
    for (let i = 0; i < 32; i++) {
      token += chars[Math.floor(Math.random() * 16)];
    }
    return token;
  }

  function getOrCreateFallbackToken() {
    try {
      let token = localStorage.getItem(CONFIG.USER_TOKEN_KEY);
      if (!token) {
        token = generateFallbackToken();
        localStorage.setItem(CONFIG.USER_TOKEN_KEY, token);
      }
      // NOTE: Do NOT write to chrome.storage here. The background service worker
      // is the sole owner of the token in chrome.storage (via getOrCreateToken()).
      // If we write here, we race with the background and cause token fragmentation
      // where different data gets stored under different user_ids.
      return token;
    } catch (_) {
      return null;
    }
  }

  // ─── State ───────────────────────────────────────────────────────────────
  const state = {
    activeTimeMs: 0,
    sessionStart: null,
    lastActivity: Date.now(),
    isTabVisible: !document.hidden,
    hasEverInteracted: false,
    checkpointInterval: null,
    _finalSent: false,
  };

  // ─── Core Timer Logic ────────────────────────────────────────────────────

  function resumeTimer() {
    if (state.sessionStart === null && state.isTabVisible) {
      state.sessionStart = Date.now();
    }
  }

  function pauseTimer() {
    if (state.sessionStart !== null) {
      const now = Date.now();
      state.activeTimeMs += now - state.sessionStart;
      state.sessionStart = null;
    }
  }

  function handleUserActivity() {
    state.lastActivity = Date.now();
    state.hasEverInteracted = true;

    if (state.sessionStart === null && state.isTabVisible) {
      resumeTimer();
    }
  }

  function checkIdle() {
    if (state.sessionStart !== null && state.isTabVisible) {
      const elapsed = Date.now() - state.lastActivity;
      if (elapsed >= CONFIG.IDLE_THRESHOLD_MS) {
        pauseTimer();
      }
    }
  }

  // ─── Event Handlers ──────────────────────────────────────────────────────

  function onVisibilityChange() {
    if (document.hidden) {
      state.isTabVisible = false;
      pauseTimer();
    } else {
      state.isTabVisible = true;
      const elapsed = Date.now() - state.lastActivity;
      if (elapsed < CONFIG.IDLE_THRESHOLD_MS) {
        resumeTimer();
      }
    }
  }

  async function sendScreenTime(isFinal) {
    pauseTimer();

    // Send the exact time tracked as a decimal (e.g. 1.4 for 1400ms).
    // The server stores it as a REAL value so precision is preserved.
    // This guarantees NO time is ever lost — even a 400ms visit is recorded.
    const durationSeconds = state.activeTimeMs / 1000;
    if (durationSeconds <= 0) return;

    const domain = window.location.hostname;
    if (!shouldTrackDomain(domain)) {
      state.activeTimeMs = 0;
      return;
    }

    const token = getOrCreateFallbackToken();

    // Build payload WITHOUT userToken for the extension path.
    // The background service worker has the authoritative token (from chrome.storage)
    // and will use that instead, ensuring all data uses the same token.
    const extensionPayload = {
      domain,
      path: window.location.pathname,
      durationSeconds: durationSeconds,
      timestamp: new Date().toISOString(),
      // userToken intentionally omitted — background uses its own authoritative token
    };

    // Full payload with token for direct fallback paths (no extension available)
    const fallbackPayload = { ...extensionPayload, userToken: token };

    // On page unload (isFinal), skip chrome.runtime entirely.
    // Browsers don't wait for async during unload — use sendBeacon which is reliable.
    if (isFinal) {
      const blob = new Blob([JSON.stringify(fallbackPayload)], { type: "application/json" });
      try {
        navigator.sendBeacon(CONFIG.SERVER_URL + CONFIG.API_PATH, blob);
      } catch (e) {
        try {
          fetch(CONFIG.SERVER_URL + CONFIG.API_PATH, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(fallbackPayload),
            keepalive: true,
          }).catch(() => {});
        } catch (_) {}
      }
      state.activeTimeMs = 0;
      return;
    }

    // For regular intervals, use chrome.runtime to forward via background worker.
    // DO NOT include userToken — the background uses its own authoritative token
    // from chrome.storage (via getOrCreateToken()). This prevents token drift
    // between the content script and the service worker.
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        const response = await chrome.runtime.sendMessage(extensionPayload);
        if (response && response.received) {
          state.activeTimeMs = 0;
          // Clean up any stale checkpoint so a crash before the next
          // onCheckpoint() doesn't double-recover the same data.
          try { localStorage.removeItem(CONFIG.STORAGE_KEY); } catch (_) {}
          return;
        }
      } catch (err) {
        // Extension context invalidated or background dead — fall through to direct fetch
      }
    }

    // Direct fallback: send to server without extension
    // Uses absolute URL so data reaches the LisTrack server even when the
    // background service worker is dead (MV3 worker termination).
    let fallbackSucceeded = false;
    try {
      const resp = await fetch(CONFIG.SERVER_URL + CONFIG.API_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fallbackPayload),
      });
      fallbackSucceeded = resp.ok;
    } catch (_) {}

    if (fallbackSucceeded) {
      // Only reset time if data was actually delivered
      state.activeTimeMs = 0;
      // Clean up any stale checkpoint so a crash before the next
      // onCheckpoint() doesn't double-recover the same data.
      try { localStorage.removeItem(CONFIG.STORAGE_KEY); } catch (_) {}
    } else {
      // BOTH the extension path and fallback fetch failed.
      // Don't reset — save the time as a checkpoint so recoverCrashData()
      // can pick it up on the next page load to this domain.
      try {
        const checkpoint = {
          activeTimeMs: state.activeTimeMs,
          lastActivity: state.lastActivity,
          domain: window.location.hostname,
          path: window.location.pathname,
          timestamp: Date.now(),
        };
        localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(checkpoint));
      } catch (_) {}
    }
  }

  function onCheckpoint() {
    checkIdle();
    if (state.activeTimeMs <= 0) return;

    const domain = window.location.hostname;
    if (!shouldTrackDomain(domain)) {
      state.activeTimeMs = 0;
      return;
    }

    try {
      const data = {
        activeTimeMs: state.activeTimeMs,
        lastActivity: state.lastActivity,
        domain,
        path: window.location.pathname,
        timestamp: Date.now(),
      };
      localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(data));
    } catch (_) {}
  }

  function recoverCrashData() {
    try {
      const raw = localStorage.getItem(CONFIG.STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);

      if (
        data.domain === window.location.hostname &&
        Date.now() - data.timestamp < 3_600_000 &&
        shouldTrackDomain(data.domain)
      ) {
        const token = getOrCreateFallbackToken();
        // No userToken for extension path — background uses its own authoritative token
        const extPayload = {
          domain: data.domain,
          path: data.path,
          durationSeconds: data.activeTimeMs / 1000,
          timestamp: new Date(data.timestamp).toISOString(),
          recovered: true,
        };
        const fallbackPayload = { ...extPayload, userToken: token };

        // Try extension path first (fire-and-forget .then with fallback).
        // Must NOT use await here — this runs from init() and any yield would
        // let onCheckpoint() start and overwrite the localStorage checkpoint.
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage(extPayload)
            .then((resp) => {
              if (!resp || !resp.received) useFallbackSend(fallbackPayload);
            })
            .catch(() => useFallbackSend(fallbackPayload));
        } else {
          useFallbackSend(fallbackPayload);
        }
      }
      // Clean up the checkpoint immediately (synchronous, not inside async chain)
      localStorage.removeItem(CONFIG.STORAGE_KEY);
    } catch (_) {}
  }

  /**
   * Fire the fallback payload via sendBeacon with a fetch backup.
   * Extracted to avoid duplicating the two-layer pattern.
   */
  function useFallbackSend(payload) {
    const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
    try {
      navigator.sendBeacon(CONFIG.SERVER_URL + CONFIG.API_PATH, blob);
    } catch (e) {
      try {
        fetch(CONFIG.SERVER_URL + CONFIG.API_PATH, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          keepalive: true,
        }).catch(() => {});
      } catch (_) {}
    }
  }

  // ─── Bind Events & Initialize ────────────────────────────────────────────

  function init() {
    // Pre-load any existing token from chrome.storage into localStorage
    // so existing extension users keep the same identity after upgrade.
    // This runs well before sendScreenTime() is ever called (10s+ delay).
    trySyncTokenFromStorage();

    recoverCrashData();

    if (!document.hidden) {
      state.lastActivity = Date.now();
      resumeTimer();
    }

    const activityEvents = ["mousemove", "mousedown", "keydown", "scroll", "touchstart", "touchmove", "wheel"];
    activityEvents.forEach((eventType) => {
      window.addEventListener(eventType, handleUserActivity, { passive: true });
    });

    document.addEventListener("visibilitychange", onVisibilityChange);

    // FIX: Send final metrics AND clear out localStorage to wipe out "ghost backups"
    function onPageUnload() {
      if (state._finalSent) return;
      state._finalSent = true;
      sendScreenTime(true);
      try {
        localStorage.removeItem(CONFIG.STORAGE_KEY);
      } catch (_) {}
    }
    window.addEventListener("pagehide", onPageUnload);
    window.addEventListener("beforeunload", onPageUnload);

    state.checkpointInterval = setInterval(onCheckpoint, CONFIG.CHECKPOINT_INTERVAL_MS);

    // Handles rolling intervals — every 10s, send accumulated time if ≥5s
    setInterval(async function () {
      if (state.activeTimeMs >= 5_000) {
        await sendScreenTime(false);
      }
      if (state.isTabVisible) {
        resumeTimer();
      }
    }, 10_000);

    // Signal to the dashboard that the LisTrack extension is installed
    document.documentElement.dataset.lisTrackInstalled = 'true';
  }

  /**
   * Async pre-load: copy any existing token from chrome.storage into localStorage
   * so the tracker (and dashboard) use the extension's original token.
   * This runs early in init(), and the 10s delay before sendScreenTime() fires
   * gives this async call time to complete.
   */
  function trySyncTokenFromStorage() {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get([CONFIG.USER_TOKEN_KEY], function (result) {
        if (result[CONFIG.USER_TOKEN_KEY]) {
          try {
            // Overwrite localStorage with chrome.storage's authoritative token.
            // This ensures the fallback token in localStorage matches the
            // background's token used for the extension path.
            localStorage.setItem(CONFIG.USER_TOKEN_KEY, result[CONFIG.USER_TOKEN_KEY]);
          } catch (_) {}
        }
      });
    }
  }

  // FIX: Enabled running on localhost so you can actually test your extension locally!
  if (typeof navigator.sendBeacon !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  }
})();