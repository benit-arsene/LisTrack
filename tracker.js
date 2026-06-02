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
    API_URL: "http://localhost:3000/api/screen-time",
    IDLE_THRESHOLD_MS: 60_000,
    CHECKPOINT_INTERVAL_MS: 5_000,
    STORAGE_KEY: "web_screen_time_tracker",
  };

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

    const durationSeconds = Math.round(state.activeTimeMs / 1000);
    if (durationSeconds <= 0) return; 

    const payload = {
      domain: window.location.hostname,
      path: window.location.pathname,
      durationSeconds: durationSeconds,
      timestamp: new Date().toISOString(),
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

    // Reset local tracker cache for standard mid-session intervals
    state.activeTimeMs = 0;
  }

  function onCheckpoint() {
    checkIdle();
    if (state.activeTimeMs <= 0) return;

    try {
      const data = {
        activeTimeMs: state.activeTimeMs,
        lastActivity: state.lastActivity,
        domain: window.location.hostname,
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
      
      if (data.domain === window.location.hostname && Date.now() - data.timestamp < 3_600_000) {
        const payload = {
          domain: data.domain,
          path: data.path,
          durationSeconds: Math.round(data.activeTimeMs / 1000),
          timestamp: new Date(data.timestamp).toISOString(),
          recovered: true,
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

    // Handles rolling 30-second intervals cleanly
    setInterval(function () {
      if (state.activeTimeMs >= 30_000) {
        sendScreenTime(false);
      }
      if (state.isTabVisible) {
        resumeTimer();
      }
    }, 30_000);
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