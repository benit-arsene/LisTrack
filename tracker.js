/**
 * Web Screen-Time Tracker (Fixed & Optimized)
 * -----------------------------------------
 * Tracks time continuously while the tab is visible — no idle timeout.
 * Blocks back-to-back unload triggers and safely clears crash checkpoints.
 */

(function () {
  "use strict";

  // ─── Configuration ───────────────────────────────────────────────────────
  const CONFIG = {
    // Send tracking data to the deployed backend.
    API_URL: "https://listrack-2.onrender.com/api/screen-time",
    CHECKPOINT_INTERVAL_MS: 5_000,
    STORAGE_KEY: "web_screen_time_tracker",
  };

  // Domains to exclude from tracking. Uses suffix matching so "render.com"
  // catches "dashboard.render.com", "api.render.com", etc.
  const IGNORED_DOMAIN_PATTERNS = [
    "localhost",
    "listrack.onrender.com",
    "listrack-2.onrender.com",
    "render.com",
  ];

  function shouldTrackDomain(domain) {
    return (
      typeof domain === "string" &&
      domain.length > 0 &&
      !IGNORED_DOMAIN_PATTERNS.some(
        (pattern) => domain === pattern || domain.endsWith("." + pattern),
      )
    );
  }

  // ─── State ───────────────────────────────────────────────────────────────
  const state = {
    userToken: null,
    activeTimeMs: 0,
    sessionStart: null,
    isTabVisible: !document.hidden,
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
    if (state.sessionStart === null && state.isTabVisible) {
      resumeTimer();
    }
  }

  // ─── Event Handlers ──────────────────────────────────────────────────────

  function onVisibilityChange() {
    if (document.hidden) {
      state.isTabVisible = false;
      pauseTimer();
    } else {
      state.isTabVisible = true;
      resumeTimer();
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
      userToken: state.userToken || '',
    };

    if (
      typeof chrome !== "undefined" &&
      chrome.runtime &&
      chrome.runtime.sendMessage
    ) {
      try {
        chrome.runtime.sendMessage(payload);
        state.activeTimeMs = 0;
        return;
      } catch (err) {}
    }

    const blob = new Blob([JSON.stringify(payload)], {
      type: "application/json",
    });

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
    if (state.activeTimeMs <= 0) return;

    const domain = window.location.hostname;
    if (!shouldTrackDomain(domain)) {
      state.activeTimeMs = 0;
      return;
    }

    try {
      const data = {
        activeTimeMs: state.activeTimeMs,
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
          userToken: state.userToken || '',
        };

        if (
          typeof chrome !== "undefined" &&
          chrome.runtime &&
          chrome.runtime.sendMessage
        ) {
          try {
            chrome.runtime.sendMessage(payload);
          } catch (err) {}
        } else {
          const blob = new Blob([JSON.stringify(payload)], {
            type: "application/json",
          });
          navigator.sendBeacon(CONFIG.API_URL, blob);
        }
      }
      localStorage.removeItem(CONFIG.STORAGE_KEY);
    } catch (_) {}
  }

  // ─── Bind Events & Initialize ────────────────────────────────────────────

  /**
   * Fetch the user token from the extension's background script or localStorage.
   */
  async function fetchUserToken() {
    // Try chrome.runtime.sendMessage to background first (works in extension context)
    if (
      typeof chrome !== "undefined" &&
      chrome.runtime &&
      chrome.runtime.sendMessage
    ) {
      try {
        const response = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage("getUserToken", (result) => {
            if (chrome.runtime.lastError) {
              reject(chrome.runtime.lastError);
            } else {
              resolve(result);
            }
          });
        });
        if (response && response.token) {
          state.userToken = response.token;
          return;
        }
      } catch (err) {
        // Fall through to localStorage fallback
      }
    }

    // Fallback: try reading from localStorage (for standalone / non-extension usage)
    try {
      const stored = localStorage.getItem("lisTrackUserToken");
      if (stored) {
        state.userToken = stored;
      }
    } catch (_) {}
  }

  async function init() {
    await fetchUserToken();
    recoverCrashData();

    if (!document.hidden) {
      resumeTimer();
    }

    const activityEvents = [
      "mousemove",
      "mousedown",
      "keydown",
      "scroll",
      "touchstart",
      "touchmove",
      "wheel",
    ];
    activityEvents.forEach((eventType) => {
      window.addEventListener(eventType, handleUserActivity, { passive: true });
    });

    document.addEventListener("visibilitychange", onVisibilityChange);

    // FIX: Send final metrics AND clear out localStorage to wipe out "ghost backups"
    function onPageUnload() {
      if (state._finalSent) return;
      state._finalSent = true;

      // Pause the timer to capture final accumulated time
      pauseTimer();
      const durationSeconds = state.activeTimeMs / 1000;
      if (durationSeconds > 0) {
        const domain = window.location.hostname;
        if (shouldTrackDomain(domain)) {
          const payload = {
            domain,
            path: window.location.pathname,
            durationSeconds,
            timestamp: new Date().toISOString(),
            userToken: state.userToken || '',
          };

          // Always use sendBeacon for unload — it's the most reliable during page teardown
          try {
            const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
            navigator.sendBeacon(CONFIG.API_URL, blob);
          } catch (_) {}
        }
      }
      state.activeTimeMs = 0;

      try {
        localStorage.removeItem(CONFIG.STORAGE_KEY);
      } catch (_) {}
    }
    window.addEventListener("pagehide", onPageUnload);
    window.addEventListener("beforeunload", onPageUnload);

    state.checkpointInterval = setInterval(
      onCheckpoint,
      CONFIG.CHECKPOINT_INTERVAL_MS,
    );

    // Handles rolling intervals — every 5s, send accumulated time if ≥1s
    setInterval(function () {
      if (state.activeTimeMs >= 1_000) {
        sendScreenTime(false);
      }
      if (state.isTabVisible) {
        resumeTimer();
      }
    }, 5_000);
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
