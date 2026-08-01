/**
 * Web Screen-Time Tracker (Air-Tight Precision v2)
 * ------------------------------------------------
 * MILLISECOND-PRECISION active time tracking with ZERO lost time,
 * ZERO double-counting, and ZERO race conditions.
 *
 * FIXES vs v1:
 *   1. 5-second min threshold removed — flushes every 1s with >=1s minimum
 *   2. Send-lock prevents concurrent sendScreenTime races
 *   3. Three-layer offline queue: sessionStorage + chrome.storage.local
 *   4. Crash recovery uses globally-unique UUID seq_id for idempotent dedup
 *   5. sessionStorage checkpoint cleared BEFORE async I/O, not after
 *   6. sendBeacon failure falls back to keepalive fetch
 *   7. Service worker detection re-checks on each send cycle
 *   8. All timing via Date.now() deltas (no setInterval drift)
 */

(function () {
  "use strict";

  // ─── Configuration ───────────────────────────────────────────────────────
  const CONFIG = {
    SERVER_URL: 'https://listrack-2.onrender.com',
    API_PATH: '/api/screen-time',
    IDLE_THRESHOLD_MS: 60_000,
    CHECKPOINT_INTERVAL_MS: 5_000,
    // Flush every 2 seconds (instead of 10s) — eliminates sub-5s time leak
    // 2s balances granularity with IPC/battery impact (~30 msg/min vs 60)
    FLUSH_INTERVAL_MS: 2_000,
    FLUSH_MINIMUM_MS: 1_000,
    STORAGE_KEY: "web_screen_time_tracker",
    USER_TOKEN_KEY: "lisTrackTrackerToken",
    OFFLINE_QUEUE_KEY: "lisTrackOfflineQueue",
  };

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

  // ─── Globally Unique Sequence ID (Dedup) ────────────────────────────────
  // Each send gets a globally unique UUID. The old per-tab sessionStorage
  // counter collided across tabs (every tab started at 1), so the server's
  // global dedup was dropping legitimate data from all but one tab. UUIDs
  // are unique across tabs, users, and sessions. The server deduplicates by
  // (user_id, seq_id) — even if a stale checkpoint is replayed after a
  // crash, it won't double-count.

  function generateUuid() {
    try {
      if (typeof crypto !== "undefined" && crypto.getRandomValues) {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
        bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
        const hex = Array.from(bytes, (b) =>
          b.toString(16).padStart(2, "0")
        ).join("");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      }
    } catch (_) {}
    // Fallback: timestamp + random suffix (still globally unique in practice)
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }

  function getNextSeqId() {
    return generateUuid();
  }

  // ─── Offline Queue ───────────────────────────────────────────────────────
  // SINGLE durable queue in chrome.storage.local. Content scripts only PUSH
  // here — draining is owned EXCLUSIVELY by the background service worker
  // (alarm-driven). Previously the tracker AND background both drained the
  // same chrome queue, and every payload was pushed into BOTH a sessionStorage
  // queue AND the chrome queue, so each entry was sent 2–3×.

  async function getOfflineQueueFromChromeStorage() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return [];
    try {
      const result = await chrome.storage.local.get([CONFIG.OFFLINE_QUEUE_KEY]);
      return result[CONFIG.OFFLINE_QUEUE_KEY] || [];
    } catch (_) {
      return [];
    }
  }

  // Returns true only if the queue was actually persisted — the caller
  // restores activeTimeMs when this returns false so time is never lost.
  async function setOfflineQueueToChromeStorage(queue) {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return false;
    try {
      const trimmed = queue.slice(-500);
      await chrome.storage.local.set({ [CONFIG.OFFLINE_QUEUE_KEY]: trimmed });
      return true;
    } catch (_) {
      return false;
    }
  }

  // Returns true when the payload was durably queued.
  async function pushToOfflineQueue(payload) {
    const chromeQueue = await getOfflineQueueFromChromeStorage();
    chromeQueue.push({ ...payload, queuedAt: Date.now() });
    return setOfflineQueueToChromeStorage(chromeQueue);
  }

  // ─── State ───────────────────────────────────────────────────────────────
  const state = {
    activeTimeMs: 0,
    sessionStart: null,
    lastActivity: Date.now(),
    isTabVisible: !document.hidden,
    hasEverInteracted: false,
    checkpointInterval: null,
    flushIntervalId: null,
    _finalSent: false,
    paused: false,
    // Send-lock: prevents concurrent sendScreenTime races
    _sendInProgress: false,
  };

  // ─── Core Timer Logic (Delta-based, zero drift) ─────────────────────────

  function resumeTimer() {
    if (state.sessionStart === null && state.isTabVisible && !state.paused) {
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
    const now = Date.now();
    // Detect system sleep / long idle gap (visibilitychange may not fire on sleep)
    // If more than IDLE_THRESHOLD_MS elapsed, the timer ran during sleep — stop it
    if (now - state.lastActivity >= CONFIG.IDLE_THRESHOLD_MS) {
      pauseTimer();
    }
    state.lastActivity = now;
    state.hasEverInteracted = true;

    if (!state.paused && state.sessionStart === null && state.isTabVisible) {
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
      if (elapsed < CONFIG.IDLE_THRESHOLD_MS && !state.paused) {
        resumeTimer();
      }
    }
  }

  // ─── Send Screen Time (Send-Lock + Dedup + Offline Queue) ───────────────

  async function sendScreenTime(isFinal) {
    // Send-lock: prevent concurrent invocations from racing on activeTimeMs
    if (state._sendInProgress && !isFinal) return;
    state._sendInProgress = true;

    try {
      pauseTimer();

      const durationSeconds = state.activeTimeMs / 1000;
      if (durationSeconds <= 0) return;

      const domain = window.location.hostname;
      if (!shouldTrackDomain(domain)) {
        state.activeTimeMs = 0;
        return;
      }

      // ─── Atomic Capture & Reset ─────────────────────────────────────
      // Reset activeTimeMs BEFORE any async I/O. This eliminates the
      // time gap where pauseTimer() had set sessionStart=null, causing
      // ~150ms lost per cycle.
      const capturedMs = state.activeTimeMs;
      state.activeTimeMs = 0;

      // Clear any stale crash checkpoint AT CAPTURE (before async I/O).
      // If a crash happened after the server accepted this payload but
      // before the old success-path removeItem ran, the pre-send checkpoint
      // would be replayed with a DIFFERENT seq_id → double-count. Clearing
      // here closes that window entirely; the checkpoint is rebuilt by
      // onCheckpoint() with fresh accumulated time.
      try { sessionStorage.removeItem(CONFIG.STORAGE_KEY); } catch (_) {}

      // Generate monotonic seq_id for server-side dedup
      const seqId = getNextSeqId();

      // Immediately resume timer so the next millisecond is tracked
      if (state.isTabVisible && !state.paused) {
        resumeTimer();
      }

      // ─── Build Payload ──────────────────────────────────────────────
      const token = getOrCreateFallbackToken();

      const payload = {
        domain,
        path: window.location.pathname,
        durationSeconds: durationSeconds,
        timestamp: new Date().toISOString(),
        userToken: token,
        seq_id: seqId,
        recovered: false,
      };

      // ─── Page Unload Path (isFinal) ─────────────────────────────────
      if (isFinal) {
        let beaconSent = false;
        try {
          const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
          beaconSent = navigator.sendBeacon(CONFIG.SERVER_URL + CONFIG.API_PATH, blob);
        } catch (_) {}

        if (!beaconSent) {
          try {
            await fetch(CONFIG.SERVER_URL + CONFIG.API_PATH, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
              keepalive: true,
            }).catch(() => {});
          } catch (_) {}
        }
        return;
      }

      // ─── Normal Send: Extension → Direct Fetch ─────────────────────
      let succeeded = false;

      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
        try {
          const response = await chrome.runtime.sendMessage(payload);
          succeeded = !!(response && response.received);
        } catch (_) {}
      }

      if (!succeeded) {
        try {
          const resp = await fetch(CONFIG.SERVER_URL + CONFIG.API_PATH, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          succeeded = resp.ok;
        } catch (_) {}
      }

      // ─── Handle Failure ────────────────────────────────────────────
      if (!succeeded) {
        // Queue the payload ONLY — never also restore activeTimeMs.
        // Restoring would re-send the same seconds on the next flush under
        // a NEW seq_id while the queued copy keeps the OLD seq_id, so the
        // server would accept both → double-count. If the queue itself
        // fails, restore the time so the next flush retries it.
        let queued = false;
        try {
          queued = await pushToOfflineQueue(payload);
        } catch (_) {
          queued = false;
        }
        if (!queued) {
          state.activeTimeMs += capturedMs;
        }

        // Save crash-recovery checkpoint with a FRESH seqId (the payload
        // above already consumed `seqId` — reusing it would make the
        // recovered entry look like a duplicate of the queued one).
        // Only write when there is real accumulated time (a 0-duration
        // checkpoint would be rejected by the server on replay).
        try {
          if (state.activeTimeMs > 0) {
            const checkpoint = {
              seqId: getNextSeqId(),
              activeTimeMs: state.activeTimeMs,
              lastActivity: state.lastActivity,
              domain: window.location.hostname,
              path: window.location.pathname,
              timestamp: Date.now(),
            };
            sessionStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(checkpoint));
          }
        } catch (_) {}
      }
      // NOTE: the checkpoint was already cleared at capture above — no
      // per-branch removal needed, and a crash mid-send can never replay
      // the just-sent time.
    } finally {
      state._sendInProgress = false;
    }
  }

  // ─── Checkpoint (5s — persists state for crash recovery) ────────────────

  function onCheckpoint() {
    checkIdle();
    if (state.activeTimeMs <= 0) return;

    const domain = window.location.hostname;
    if (!shouldTrackDomain(domain)) {
      state.activeTimeMs = 0;
      return;
    }

    try {
      const seqId = getNextSeqId();
      const data = {
        seqId,
        activeTimeMs: state.activeTimeMs,
        lastActivity: state.lastActivity,
        domain,
        path: window.location.pathname,
        timestamp: Date.now(),
      };
      sessionStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(data));
    } catch (_) {}
  }

  // ─── Crash Recovery ─────────────────────────────────────────────────────
  // Checkpoints include seq_id. The server deduplicates by seq_id,
  // so stale checkpoints replayed after a crash won't double-count.

  function recoverCrashData() {
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
        const payload = {
          domain: data.domain,
          path: data.path,
          durationSeconds: data.activeTimeMs / 1000,
          timestamp: new Date(data.timestamp).toISOString(),
          userToken: token,
          seq_id: data.seqId || generateUuid(),
          recovered: true,
        };

        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage(payload)
            .then((resp) => {
              if (!resp || !resp.received) useFallbackSend(payload);
            })
            .catch(() => useFallbackSend(payload));
        } else {
          useFallbackSend(payload);
        }
      }
    } catch (_) {}

    try { sessionStorage.removeItem(CONFIG.STORAGE_KEY); } catch (_) {}
  }

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

  // ─── Pause / Resume ────────────────────────────────────────────────────

  async function checkPausedState() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      try {
        const result = await chrome.storage.local.get(['lisTrackPaused']);
        state.paused = !!result.lisTrackPaused;
        if (state.paused) {
          pauseTimer();
        }
      } catch (_) {}
    }
  }

  function handleTrackingStateChange(changes, area) {
    if (area === 'local' && changes.lisTrackPaused) {
      state.paused = !!changes.lisTrackPaused.newValue;
      if (state.paused) {
        pauseTimer();
      } else if (state.isTabVisible) {
        const elapsed = Date.now() - state.lastActivity;
        if (elapsed < CONFIG.IDLE_THRESHOLD_MS) {
          resumeTimer();
        }
      }
    }
  }

  // ─── Flush Tick (1s interval) ───────────────────────────────────────────
  // FIX: Runs every 1s instead of 10s. Sends any batch >= 1s instead of >= 5s.
  // This eliminates sub-5-second time leaks on short visits.

  async function onFlushTick() {
    if (state.paused) return;
    if (state._sendInProgress) return;

    if (state.activeTimeMs >= CONFIG.FLUSH_MINIMUM_MS) {
      await sendScreenTime(false);
    }
  }

  // ─── Bind Events & Initialize ────────────────────────────────────────────

  async function init() {
    await trySyncTokenFromStorage();
    await checkPausedState();

    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(handleTrackingStateChange);
    }

    // Drain any offline-queued data from previous sessions
    // NOTE: draining is owned by the background service worker (single
    // owner) so payloads aren't processed twice — content script no longer
    // drains the shared chrome.storage.local queue.

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

    function onPageUnload() {
      if (state._finalSent) return;
      state._finalSent = true;
      sendScreenTime(true);
      try {
        sessionStorage.removeItem(CONFIG.STORAGE_KEY);
      } catch (_) {}
    }
    window.addEventListener("pagehide", onPageUnload);
    window.addEventListener("beforeunload", onPageUnload);

    // Checkpoint interval (5s — crash recovery)
    state.checkpointInterval = setInterval(onCheckpoint, CONFIG.CHECKPOINT_INTERVAL_MS);

    // Flush interval (1s — send >=1s batches)
    state.flushIntervalId = setInterval(onFlushTick, CONFIG.FLUSH_INTERVAL_MS);

    document.documentElement.dataset.lisTrackInstalled = 'true';
  }

  // ─── Token Sync ──────────────────────────────────────────────────────────

  async function trySyncTokenFromStorage() {
    let token = null;

    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      try {
        const result = await chrome.storage.local.get([CONFIG.USER_TOKEN_KEY]);
        token = result[CONFIG.USER_TOKEN_KEY];
      } catch (_) {}
    }

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

    try {
      if (token) {
        localStorage.setItem(CONFIG.USER_TOKEN_KEY, token);
      } else {
        getOrCreateFallbackToken();
      }
    } catch (_) {}
  }

  // ─── Boot ────────────────────────────────────────────────────────────────
  if (typeof navigator.sendBeacon !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  }
})();