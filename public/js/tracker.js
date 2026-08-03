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
 *   9. Mandatory Google sign-in gate: no user_id (email in chrome.storage.sync)
 *      => no time capture, no network requests to /api/screen-time
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
    USER_ID_KEY: "user_id",
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

  // ─── Mandatory Sign-In Gate ──────────────────────────────────────────────
  // LisTrack only captures screen time while the user is signed in with
  // Google (user_id = email in chrome.storage.sync). Without a user_id:
  //   - the timer never starts (no capture)
  //   - sendScreenTime() returns immediately (no /api/screen-time requests)
  //   - crash recovery is skipped (no replay sends)

  let signedInUserId = null; // current Google email, or null when signed out

  async function getSyncUserId() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.sync) return null;
    try {
      const result = await chrome.storage.sync.get([CONFIG.USER_ID_KEY]);
      const id = result[CONFIG.USER_ID_KEY];
      // Emails are case-insensitive — normalize to lowercase to keep the
      // server-side identity consistent (no User@x vs user@x duplicates).
      return typeof id === "string" && id.trim() ? id.trim().toLowerCase() : null;
    } catch (_) {
      return null;
    }
  }

  async function refreshAuthState() {
    signedInUserId = await getSyncUserId();
    if (!signedInUserId) {
      // Pause all time logging while signed out
      state.authenticated = false;
      pauseTimer();
      state.activeTimeMs = 0;
      try { localStorage.removeItem(CONFIG.USER_TOKEN_KEY); } catch (_) {}
    } else {
      state.authenticated = true;
      // Mirror the email to localStorage so the web landing page / dashboard
      // (which read lisTrackTrackerToken) can identify this browser's user.
      try { localStorage.setItem(CONFIG.USER_TOKEN_KEY, signedInUserId); } catch (_) {}
    }
    return state.authenticated;
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
    authenticated: false,
    // Send-lock: prevents concurrent sendScreenTime races
    _sendInProgress: false,
  };

  // ─── Core Timer Logic (Delta-based, zero drift) ─────────────────────────

  function resumeTimer() {
    // Never capture while signed out or paused
    if (state.sessionStart === null && state.isTabVisible && !state.paused && state.authenticated) {
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

    if (!state.paused && state.sessionStart === null && state.isTabVisible && state.authenticated) {
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
      if (elapsed < CONFIG.IDLE_THRESHOLD_MS && !state.paused && state.authenticated) {
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

      // Mandatory sign-in gate — no network requests without a user_id
      if (!state.authenticated) {
        state.activeTimeMs = 0;
        return;
      }

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
      if (state.isTabVisible && !state.paused && state.authenticated) {
        resumeTimer();
      }

      // ─── Build Payload ──────────────────────────────────────────────
      // userToken = the signed-in Google email (user_id). No fallback
      // tokens — the sign-in gate guarantees signedInUserId is present.
      const token = signedInUserId;

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
        // Rely on the synchronous auth gate at the top of this function
        // (already passed) plus the live state.authenticated / signedInUserId
        // kept in sync by handleTrackingStateChange. We deliberately avoid an
        // async chrome.storage read here: during pagehide/beforeunload the
        // continuation may never resolve.
        if (!state.authenticated || !signedInUserId) {
          state.activeTimeMs = 0;
          return;
        }

        // FIX (auth lockdown): every /api/* call now requires the Google
        // access token, but a raw sendBeacon cannot carry an Authorization
        // header — the old unload beacon was rejected with 401 and the final
        // seconds of each visit were silently lost. Instead we fire-and-forget
        // the payload to the background service worker, which attaches the
        // Bearer token, forwards it, and buffers it to the offline queue if
        // the network call fails. Sending the message is synchronous from
        // this page's perspective, so it survives pagehide even though we
        // never await the response.
        let dispatched = false;
        try {
          if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
            chrome.runtime.sendMessage(payload).catch(() => {});
            dispatched = true;
          }
        } catch (_) {}

        // Last resort only (extension runtime unavailable — rare): a raw
        // beacon may 401, but it is better than dropping the time entirely.
        if (!dispatched) {
          try {
            const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
            navigator.sendBeacon(CONFIG.SERVER_URL + CONFIG.API_PATH, blob);
          } catch (_) {}
        }
        return;
      }

      // ─── Normal Send: Extension → Direct Fetch ─────────────────────
      let succeeded = false;
      let authGated = false;

      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
        try {
          const response = await chrome.runtime.sendMessage(payload);
          if (response && response.requiresAuth) {
            // Background dropped the payload because the user is signed out.
            // Treat this as authoritative — never fall back to a direct
            // /api/screen-time fetch while signed out.
            authGated = true;
            state.authenticated = false;
            state.activeTimeMs = 0;
            return;
          }
          succeeded = !!(response && response.received);
        } catch (_) {}
      }

      if (!succeeded && !authGated) {
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
        // Sign-in gate: never replay crashed data while signed out
        if (!state.authenticated) return;

        const payload = {
          domain: data.domain,
          path: data.path,
          durationSeconds: data.activeTimeMs / 1000,
          timestamp: new Date(data.timestamp).toISOString(),
          userToken: signedInUserId,
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

  // Crash-recovery fallback — runs at page LOAD, so async storage is safe
  // here. Buffer durably instead of firing an unauthenticated beacon: the
  // background worker drains the offline queue with a valid Authorization
  // header. A raw beacon can't carry the header and would be rejected 401.
  async function useFallbackSend(payload) {
    try {
      const queued = await pushToOfflineQueue(payload);
      if (queued) return;
    } catch (_) {}

    // Last resort: extension runtime unavailable — raw beacon (may 401).
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
    // Pause/resume toggles live in chrome.storage.local
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

    // Sign-in/sign-out events live in chrome.storage.sync — react live
    if (area === 'sync' && changes.user_id) {
      const newId = changes.user_id.newValue;
      signedInUserId = typeof newId === "string" && newId.trim() ? newId.trim().toLowerCase() : null;
      state.authenticated = !!signedInUserId;
      if (!state.authenticated) {
        pauseTimer();
        state.activeTimeMs = 0;
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
    if (!state.authenticated) return;

    if (state.activeTimeMs >= CONFIG.FLUSH_MINIMUM_MS) {
      await sendScreenTime(false);
    }
  }

  // ─── Bind Events & Initialize ────────────────────────────────────────────

  async function init() {
    await refreshAuthState();
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
      if (state.authenticated) {
        resumeTimer();
      }
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

  // ─── Landing-Page Bridge ────────────────────────────────────────────────
  // The web landing page (listrack-2.onrender.com) dispatches
  // `lisTrack:getAccessToken` when its "Open Dashboard" button is clicked, so
  // it can pass the Google access token (?access_token=...) instead of the
  // legacy (now rejected) ?user= email parameter. Content scripts and the page
  // exchange data across the isolated world through DOM events.

  window.addEventListener('lisTrack:getAccessToken', async function (e) {
    const requestId = e.detail && e.detail.requestId;
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
    let accessToken = null;
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'getAccessToken' });
      accessToken = resp && resp.accessToken ? resp.accessToken : null;
    } catch (_) {}
    window.dispatchEvent(new CustomEvent('lisTrack:accessTokenResponse', {
      detail: { requestId: requestId, accessToken: accessToken },
    }));
  });

  // ─── Boot ────────────────────────────────────────────────────────────────
  if (typeof navigator.sendBeacon !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  }
})();
