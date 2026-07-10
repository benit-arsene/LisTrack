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

    const durationSeconds = state.activeTimeMs / 1000;
    if (durationSeconds <= 0) return;

    const domain = window.location.hostname;
    if (!shouldTrackDomain(domain)) {
      state.activeTimeMs = 0;
      return;
    }

    // ─── CRITICAL FIX: Eliminate the time gap ────────────────────────────
    //
    // BUG: Previously, state.activeTimeMs was reset AFTER the async send
    // (server round-trip ~50-300ms). During that gap, pauseTimer() had
    // set sessionStart = null, so NO time was tracked. Every 10-second
    // cycle lost ~150ms → ~7 minutes per 8-hour day.
    //
    // FIX: Reset activeTimeMs and resume the timer IMMEDIATELY after
    // capturing the time, before any async operations. Now the timer
    // never stops — the async send happens while tracking continues.
    // If the send fails, we add the sent time back + new time.
    // ─────────────────────────────────────────────────────────────────────
    const sentMs = state.activeTimeMs;
    state.activeTimeMs = 0;
    if (state.isTabVisible) {
      resumeTimer();
    }

    const token = getOrCreateFallbackToken();

    const extensionPayload = {
      domain,
      path: window.location.pathname,
      durationSeconds: durationSeconds,
      timestamp: new Date().toISOString(),
    };

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
      return;
    }

    // For regular intervals, use chrome.runtime to forward via background worker.
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        const response = await chrome.runtime.sendMessage(extensionPayload);
        if (response && response.received) {
          // Send succeeded — sentMs was already subtracted, timer is running
          try { sessionStorage.removeItem(CONFIG.STORAGE_KEY); } catch (_) {}
          return;
        }
      } catch (err) {
        // Extension context invalidated or background dead — fall through to direct fetch
      }
    }

    // Direct fallback: send to server without extension
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
      // Send succeeded — sentMs was already subtracted, timer is running
      try { sessionStorage.removeItem(CONFIG.STORAGE_KEY); } catch (_) {}
    } else {
      // BOTH paths failed — restore the sent time plus any new time that
      // accumulated during the async send (timer was running the whole time)
      state.activeTimeMs += sentMs;
      try {
        const checkpoint = {
          activeTimeMs: state.activeTimeMs,
          lastActivity: state.lastActivity,
          domain: window.location.hostname,
          path: window.location.pathname,
          timestamp: Date.now(),
        };
        sessionStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(checkpoint));
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
      // Use sessionStorage (per-tab) to prevent cross-tab checkpoint theft.
      // Two tabs on the same domain (e.g. youtube.com) each get their own
      // sessionStorage, so they can't steal and re-send each other's data.
      sessionStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(data));
    } catch (_) {}
  }

  function recoverCrashData() {
    // Only check sessionStorage (per-tab). This prevents cross-tab
    // checkpoint theft that was happening with shared localStorage.
    let raw = null;
    try {
      raw = sessionStorage.getItem(CONFIG.STORAGE_KEY);
    } catch (_) {}

    try {
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
        // let onCheckpoint() start and overwrite the sessionStorage checkpoint.
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
    } catch (_) {}

    // Clean up BOTH storages
    try { sessionStorage.removeItem(CONFIG.STORAGE_KEY); } catch (_) {}
    try { localStorage.removeItem(CONFIG.STORAGE_KEY); } catch (_) {}
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

  async function init() {
    // Sync the token BEFORE anything else. This ensures the content script
    // uses the SAME token as the background (chrome.storage), preventing
    // data from being split across two different user_ids.
    await trySyncTokenFromStorage();

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

    // FIX: Send final metrics AND clear out storage to wipe out "ghost backups"
    function onPageUnload() {
      if (state._finalSent) return;
      state._finalSent = true;
      sendScreenTime(true);
      try {
        sessionStorage.removeItem(CONFIG.STORAGE_KEY);
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
   * Sync the user token from the background (chrome.storage) into localStorage
   * so the content script, background, and dashboard all use the SAME token.
   *
   * Strategy (tried in order):
   *   1. Read existing token from chrome.storage (if already set)
   *   2. If not found, request one from the background via getUserToken message
   *   3. If both fail, generate a random fallback token
   *
   * This fixes token fragmentation where data was stored under two different
   * user_ids — one from chrome.storage (extension path) and one from a
   * random localStorage fallback generated before the background had created
   * its token.
   */
  async function trySyncTokenFromStorage() {
    let token = null;

    // 1. Try chrome.storage first (background may have already created a token)
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      try {
        const result = await chrome.storage.local.get([CONFIG.USER_TOKEN_KEY]);
        token = result[CONFIG.USER_TOKEN_KEY];
      } catch (_) {}
    }

    // 2. If no token yet, explicitly request one from the background
    //    This forces the background to create its token (via getOrCreateToken())
    //    and returns it to us, keeping both in sync.
    //    Uses a 2-second timeout so a dead service worker doesn't block init().
    if (!token && typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        const timeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 2000)
        );
        const response = await Promise.race([
          chrome.runtime.sendMessage("getUserToken"),
          timeout
        ]);
        if (response && response.token) {
          token = response.token;
        }
      } catch (_) {}
    }

    // 3. Store the token in localStorage (or generate a fallback if all failed)
    try {
      if (token) {
        localStorage.setItem(CONFIG.USER_TOKEN_KEY, token);
      } else {
        // Ensure a fallback exists as last resort
        getOrCreateFallbackToken();
      }
    } catch (_) {}
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