/**
 * Web Screen-Time Tracker
 * -------------------------
 * A lightweight, self-executing script that tracks true "active time"
 * on any webpage. It handles idle states (60s of inactivity) and tab
 * visibility changes to avoid counting "phantom time".
 *
 * Usage: Drop this script into any webpage. It will automatically
 *        begin tracking and send data to the backend on tab close.
 *
 * Payload: { domain, path, durationSeconds, timestamp }
 * Endpoint: POST /api/screen-time
 */

(function () {
  "use strict";

  // ─── Configuration ───────────────────────────────────────────────────────
  const CONFIG = {
    // Backend endpoint where beacon data is sent
    API_URL: "http://localhost:3000/api/screen-time",

    // Idle threshold in milliseconds (60 seconds)
    IDLE_THRESHOLD_MS: 60_000,

    // How often (in ms) to checkpoint accumulated time to localStorage
    // so we don't lose data if the browser crashes.
    CHECKPOINT_INTERVAL_MS: 5_000,

    // Local storage key for persisting accumulated time
    STORAGE_KEY: "web_screen_time_tracker",
  };

  // ─── State ───────────────────────────────────────────────────────────────
  const state = {
    // Accumulated tracked time (ms) for this page visit
    activeTimeMs: 0,

    // Timestamp (ms) when the current active session began, or null if paused
    sessionStart: null,

    // Timestamp (ms) of the last user interaction (mouse, keyboard, scroll)
    lastActivity: Date.now(),

    // Is the tab currently visible / focused?
    isTabVisible: !document.hidden,

    // Has the user ever interacted with the page?
    hasEverInteracted: false,

    // Interval handle for the checkpoint timer
    checkpointInterval: null,
  };

  // ─── Core Timer Logic ────────────────────────────────────────────────────

  /** Resume the active timer (called when user interacts or tab becomes visible). */
  function resumeTimer() {
    // Only resume if we're NOT already in an active session AND tab is visible
    if (state.sessionStart === null && state.isTabVisible) {
      state.sessionStart = Date.now();
    }
  }

  /** Pause the active timer and flush the accumulated delta (called on idle, tab hidden, etc.). */
  function pauseTimer() {
    if (state.sessionStart !== null) {
      const now = Date.now();
      state.activeTimeMs += now - state.sessionStart;
      state.sessionStart = null;
    }
  }

  /** Reset the idle timer: called on any user interaction. */
  function handleUserActivity() {
    const now = Date.now();
    state.lastActivity = now;

    if (!state.hasEverInteracted) {
      state.hasEverInteracted = true;
    }

    // If we were previously idle (timer paused) but tab is visible, resume
    if (state.sessionStart === null && state.isTabVisible) {
      resumeTimer();
    }
  }

  /** Check if the user has been idle too long; pause if so. */
  function checkIdle() {
    if (state.sessionStart !== null && state.isTabVisible) {
      const elapsed = Date.now() - state.lastActivity;
      if (elapsed >= CONFIG.IDLE_THRESHOLD_MS) {
        pauseTimer();
      }
    }
  }

  // ─── Event Handlers ──────────────────────────────────────────────────────

  /** Handle Page Visibility API changes. */
  function onVisibilityChange() {
    if (document.hidden) {
      // Tab hidden → pause immediately (no phantom time)
      state.isTabVisible = false;
      pauseTimer();
    } else {
      // Tab visible again → resume if user is active
      state.isTabVisible = true;
      const elapsed = Date.now() - state.lastActivity;
      if (elapsed < CONFIG.IDLE_THRESHOLD_MS) {
        resumeTimer();
      }
    }
  }

  /** Send accumulated time to the backend via sendBeacon, then reset local state. */
  function sendScreenTime(isFinal) {
    // Flush any active session time first
    pauseTimer();

    const durationSeconds = Math.round(state.activeTimeMs / 1000);
    if (durationSeconds <= 0) return; // Nothing to report

    const payload = {
      domain: window.location.hostname,
      path: window.location.pathname,
      durationSeconds: durationSeconds,
      timestamp: new Date().toISOString(),
    };

    // If running in extension context, send via background worker to bypass mixed-content blocking
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        chrome.runtime.sendMessage(payload);
        if (!isFinal) {
          state.activeTimeMs = 0;
        }
        return;
      } catch (err) {
        // Fall back if extension context is invalidated
      }
    }

    const blob = new Blob([JSON.stringify(payload)], {
      type: "application/json",
    });

    try {
      navigator.sendBeacon(CONFIG.API_URL, blob);
    } catch (e) {
      // Fallback: if sendBeacon fails, try fetch (best-effort)
      try {
        fetch(CONFIG.API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          keepalive: true,
        }).catch(() => {}); // Silently ignore network errors on unload
      } catch (_) {
        // Both failed — data is lost, but we tried our best
      }
    }

    // If this is a final send (page unload), don't clear state because
    // the page is going away anyway. For checkpoint sends, reset so we
    // don't double-send the same time.
    if (!isFinal) {
      state.activeTimeMs = 0;
    }
  }

  /** Periodically checkpoint active time to localStorage and optionally send to server. */
  function onCheckpoint() {
    // Check for idle state every checkpoint cycle
    checkIdle();

    // Persist current accumulated time to localStorage (crash recovery)
    try {
      const data = {
        activeTimeMs: state.activeTimeMs,
        lastActivity: state.lastActivity,
        domain: window.location.hostname,
        path: window.location.pathname,
        timestamp: Date.now(),
      };
      localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(data));
    } catch (_) {
      // localStorage might be full or unavailable; silently ignore
    }
  }

  // ─── Attempt to Recover Crashed Session Data ─────────────────────────────
  function recoverCrashData() {
    try {
      const raw = localStorage.getItem(CONFIG.STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      // Only recover if it's from the same domain and recent (< 1 hour old)
      if (
        data.domain === window.location.hostname &&
        Date.now() - data.timestamp < 3_600_000
      ) {
        // Send the lost data
        const payload = {
          domain: data.domain,
          path: data.path,
          durationSeconds: Math.round(data.activeTimeMs / 1000),
          timestamp: new Date(data.timestamp).toISOString(),
          recovered: true,
        };

        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
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
    } catch (_) {
      // Ignore recover errors
    }
  }

  // ─── Bind Events & Initialize ────────────────────────────────────────────

  function init() {
    // Recover any data from a previous crashed session
    recoverCrashData();

    // Start the timer if the tab is already visible
    if (!document.hidden) {
      state.lastActivity = Date.now();
      resumeTimer();
    }

    // ── User-interaction events ──
    const activityEvents = ["mousemove", "mousedown", "keydown", "scroll", "touchstart", "touchmove", "wheel"];
    activityEvents.forEach((eventType) => {
      window.addEventListener(eventType, handleUserActivity, { passive: true });
    });

    // ── Page Visibility API ──
    document.addEventListener("visibilitychange", onVisibilityChange);

    // ── Send final data on page unload ──
    window.addEventListener("pagehide", function () {
      // pagehide is more reliable than beforeunload on mobile
      sendScreenTime(true);
    });
    window.addEventListener("beforeunload", function () {
      sendScreenTime(true);
    });

    // ── Set up periodic checkpoint ──
    state.checkpointInterval = setInterval(onCheckpoint, CONFIG.CHECKPOINT_INTERVAL_MS);

    // ── Optional: periodically send data to server (every 30s of tracked time) ──
    // This makes data available in near-real-time on the dashboard.
    setInterval(function () {
      pauseTimer();
      if (state.activeTimeMs >= 30_000) {
        // Send checkpoint but reset so we don't double-count
        const durationSeconds = Math.round(state.activeTimeMs / 1000);
        if (durationSeconds > 0) {
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
            } catch (err) {
              // Fall back if extension context is invalidated
            }
          } else {
            const blob = new Blob([JSON.stringify(payload)], {
              type: "application/json",
            });
            navigator.sendBeacon(CONFIG.API_URL, blob);
            state.activeTimeMs = 0;
          }
        }
      }
      // Re-resume timer after sending
      if (state.isTabVisible) {
        resumeTimer();
      }
    }, 30_000);
  }

  // ─── Kick off only if sendBeacon is available ────────────────────────────
  if (typeof navigator.sendBeacon !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  }
})();
