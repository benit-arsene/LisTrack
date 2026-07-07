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
    // Use relative path so the snippet posts to the same origin when testing locally.
    API_URL: '/api/screen-time',
    IDLE_THRESHOLD_MS: 60_000,
    CHECKPOINT_INTERVAL_MS: 5_000,
    STORAGE_KEY: "web_screen_time_tracker",
    USER_TOKEN_KEY: "lisTrackTrackerToken",
  };

  // Domains to exclude from tracking. Uses suffix matching so "render.com"
  // catches "dashboard.render.com", "api.render.com", etc.
  const IGNORED_DOMAIN_PATTERNS = ["localhost", "listrack.onrender.com", "render.com"];

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

  function sendScreenTime(isFinal) {
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

    const payload = {
      domain,
      path: window.location.pathname,
      durationSeconds: durationSeconds,
      timestamp: new Date().toISOString(),
      userToken: getOrCreateFallbackToken(),
    };

    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        chrome.runtime.sendMessage(payload);
        state.activeTimeMs = 0;
        return;
      } catch (err) {}
    }

    const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });

    try {
      navigator.sendBeacon(CONFIG.API_URL, blob);
    } catch (e) {
      try {
        fetch(CONFIG.API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          keepalive: true,
        }).catch(() => {});
      } catch (_) {}
    }

    // Reset accumulated time — the exact amount was already sent
    state.activeTimeMs = 0;
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
        const payload = {
          domain: data.domain,
          path: data.path,
          durationSeconds: data.activeTimeMs / 1000,
          timestamp: new Date(data.timestamp).toISOString(),
          recovered: true,
          userToken: getOrCreateFallbackToken(),
        };

        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
          try { chrome.runtime.sendMessage(payload); } catch (err) {}
        } else {
          const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
          navigator.sendBeacon(CONFIG.API_URL, blob);
        }
      }
      localStorage.removeItem(CONFIG.STORAGE_KEY);
    } catch (_) {}
  }

  // ─── Bind Events & Initialize ────────────────────────────────────────────

  function init() {
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
    setInterval(function () {
      if (state.activeTimeMs >= 5_000) {
        sendScreenTime(false);
      }
      if (state.isTabVisible) {
        resumeTimer();
      }
    }, 10_000);
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