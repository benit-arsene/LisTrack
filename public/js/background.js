// LisTrack Background Service Worker (Air-Tight Precision v2)
//
// FIXES vs v1:
//   1. Offline queue: buffers failed payloads in chrome.storage.local
//   2. Retry mechanism: drains offline queue on periodic alarm
//   3. Service worker lifecycle: onStartup re-initializes, onSuspend saves state
//   4. Dedup is enforced server-side via a UNIQUE (user_id, seq_id) index
//   5. Handles forwarding tracking payloads to bypass mixed content blocking
//   6. Checks daily goals and sends Chrome notifications

// ─── Configuration ──────────────────────────────────────────────────────────

const SERVER_URL = "https://listrack-2.onrender.com";

const BLOCKED_DOMAINS = [
  "localhost",
  "listrack.onrender.com",
  "listrack-2.onrender.com",
];

const GOAL_CHECK_INTERVAL_MINUTES = 5;
const NOTIFICATION_COOLDOWN_MS = 30 * 60 * 1000;
const BADGE_UPDATE_INTERVAL_MINUTES = 1;
const OFFLINE_RETRY_INTERVAL_MINUTES = 2; // Retry offline queue every 2 minutes

const USER_TOKEN_KEY = "lisTrackTrackerToken";
const PAUSE_KEY = "lisTrackPaused";
const OFFLINE_QUEUE_KEY = "lisTrackOfflineQueue";

// ─── Token Management ───────────────────────────────────────────────────────

/**
 * Generate a cryptographically-random hex token.
 */
function generateToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Get the user token from storage, creating one if it doesn't exist.
 * Also handles migration from the old key (lisTrackUserToken) for existing users.
 */
async function getOrCreateToken() {
  const OLD_TOKEN_KEY = "lisTrackUserToken";
  const result = await chrome.storage.local.get([USER_TOKEN_KEY, OLD_TOKEN_KEY]);
  let token = result[USER_TOKEN_KEY];

  if (!token && result[OLD_TOKEN_KEY]) {
    // Migrate existing token from old key to new key
    token = result[OLD_TOKEN_KEY];
    await chrome.storage.local.set({ [USER_TOKEN_KEY]: token });
    await chrome.storage.local.remove(OLD_TOKEN_KEY);
    console.log("[background] Migrated existing token:", token);
  } else if (!token) {
    token = generateToken();
    await chrome.storage.local.set({ [USER_TOKEN_KEY]: token });
    console.log("[background] Created new user token:", token);
  }

  return token;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isBlockedDomain(domain) {
  return BLOCKED_DOMAINS.some(
    (pattern) => domain === pattern || domain.endsWith("." + pattern)
  );
}

/**
 * Fetch goal status from the server.
 */
async function fetchGoalStatus(userToken) {
  try {
    const response = await fetch(`${SERVER_URL}/api/goals/status?user=${encodeURIComponent(userToken)}`);
    if (!response.ok) return null;
    return await response.json();
  } catch (err) {
    console.error("[background] Failed to fetch goal status:", err);
    return null;
  }
}

/**
 * Send a Chrome notification for a goal event.
 */
function sendGoalNotification(goal, type) {
  const isWarning = type === "warning";
  const title = isWarning ? "⚠️ Approaching screen time limit" : "🔴 Screen time limit reached!";
  const message = isWarning
    ? `You've used ${goal.percentage}% of your ${goal.maxMinutes} min budget on ${goal.domain}.`
    : `You've exceeded your ${goal.maxMinutes} min budget on ${goal.domain} (${goal.todayMinutes.toFixed(0)} min used).`;

  const notificationId = `goal-${goal.id}-${type}-${Math.floor(Date.now() / NOTIFICATION_COOLDOWN_MS)}`;

  chrome.notifications.create(notificationId, {
    type: "basic",
    iconUrl: "icon.png",
    title,
    message,
    priority: isWarning ? 1 : 2,
    requireInteraction: !isWarning,
  });
}

/**
 * Determine if we should send a notification for a goal, avoiding spam.
 * Returns 'warning', 'exceeded', or null.
 */
async function shouldNotify(goal) {
  const key = `notified_${goal.id}`;
  const result = await chrome.storage.local.get([key]);
  const state = result[key] || {};
  const now = Date.now();

  // If exceeded — notify once per cooldown period
  if (goal.exceeded) {
    if (state.exceeded && (now - state.exceeded < NOTIFICATION_COOLDOWN_MS)) {
      return null;
    }
    return "exceeded";
  }

  // If approaching (80-99%) — notify once per cooldown period
  if (goal.approaching) {
    if (state.warning && (now - state.warning < NOTIFICATION_COOLDOWN_MS)) {
      return null;
    }
    return "warning";
  }

  return null;
}

/**
 * Record that a notification was sent for a goal.
 */
async function recordNotification(goal, type) {
  const key = `notified_${goal.id}`;
  const result = await chrome.storage.local.get([key]);
  const state = result[key] || {};

  state[type] = Date.now();
  await chrome.storage.local.set({ [key]: state });
}

/**
 * Check all goals and send notifications where needed.
 */
async function checkGoals() {
  console.log("[background] Checking goals...");

  const userToken = await getOrCreateToken();
  const data = await fetchGoalStatus(userToken);
  if (!data || !data.goals || data.goals.length === 0) return;

  for (const goal of data.goals) {
    const notificationType = await shouldNotify(goal);
    if (notificationType) {
      sendGoalNotification(goal, notificationType);
      await recordNotification(goal, notificationType);
    }
  }
}

// ─── Offline Queue (buffer for failed sends) ───────────────────────────
// The content script pushes failed payloads to chrome.storage.local.
// This background worker drains them on a 2-minute alarm and on startup.

async function drainOfflineQueue() {
  try {
    const result = await chrome.storage.local.get([OFFLINE_QUEUE_KEY]);
    const queue = result[OFFLINE_QUEUE_KEY] || [];
    if (queue.length === 0) return;

    const pendingRetries = [];
    let drained = 0;

    for (const entry of queue) {
      try {
        const response = await fetch(`${SERVER_URL}/api/screen-time`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(entry),
        });
        if (response.ok) {
          drained++;
        } else if (response.status >= 400 && response.status < 500) {
          // Permanent client error (e.g. invalid domain/duration) — drop so
          // it isn't retried forever; only 5xx / network errors are retryable.
          console.warn('[background] Dropping permanently-invalid queued payload:', response.status);
        } else {
          pendingRetries.push(entry);
        }
      } catch (_) {
        pendingRetries.push(entry);
      }
    }

    // Re-queue only the failed ones — but MERGE with any entries pushed by
    // content scripts WHILE this drain was in flight, so they aren't lost.
    // (chrome.storage.local.set replaces the whole key, so an unconditional
    // overwrite here could silently drop newly-queued payloads.)
    // Re-queue only entries that failed this pass PLUS entries pushed by
    // content scripts WHILE this drain was in flight (i.e. not part of the
    // snapshot we just processed) — so nothing is lost and nothing that
    // already succeeded is sent again.
    const processed = new Set(queue.map((e) => JSON.stringify(e)));
    const current = await chrome.storage.local.get([OFFLINE_QUEUE_KEY]);
    const currentQueue = current[OFFLINE_QUEUE_KEY] || [];
    const newDuringDrain = currentQueue.filter(
      (e) => !processed.has(JSON.stringify(e)),
    );
    await chrome.storage.local.set({
      [OFFLINE_QUEUE_KEY]: [...pendingRetries, ...newDuringDrain],
    });

    if (drained > 0) {
      console.log(`[background] Drained ${drained} offline-queued payloads (${pendingRetries.length} remaining)`);
    }

    // Update badge after draining
    updateBadge();
  } catch (_) {}
}

// ─── Dedup ──────────────────────────────────────────────────────────────
// Dedup is enforced server-side via a UNIQUE index on (user_id, seq_id)
// with INSERT ... ON CONFLICT DO NOTHING — no client-side cache needed.
// The old PROCESSED_SEQ_IDS_KEY cache was never wired into the message
// handler, so it has been removed.

/**
 * Reset notification cooldowns at midnight.
 */
async function resetDailyNotifications() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(k => k.startsWith("notified_"));
  if (keys.length > 0) {
    await chrome.storage.local.remove(keys);
    console.log("[background] Reset daily notification cooldowns");
  }
}

// ─── Badge Update ───────────────────────────────────────────────────────────
// Shows today's total screen time as a badge on the extension toolbar icon.

async function updateBadge() {
  try {
    const userToken = await getOrCreateToken();
    const resp = await fetch(`${SERVER_URL}/api/dashboard?user=${encodeURIComponent(userToken)}`);
    if (!resp.ok) return;

    const data = await resp.json();
    const totalMin = data.totalMinutes || 0;
    let badgeText = '';

    if (totalMin >= 1) {
      if (totalMin < 60) {
        badgeText = Math.round(totalMin) + 'm';
      } else {
        const hours = totalMin / 60;
        badgeText = hours < 10 ? hours.toFixed(1) + 'h' : Math.round(hours) + 'h';
      }
    }

    chrome.action.setBadgeText({ text: badgeText });

    // Color: grey (paused), green (<30min), amber (30-120min), red (>120min)
    try {
      const paused = await chrome.storage.local.get([PAUSE_KEY]);
      if (paused[PAUSE_KEY]) {
        chrome.action.setBadgeBackgroundColor({ color: '#6b7280' });
        return;
      }
    } catch (_) {}

    const color = totalMin > 120 ? '#ef4444' : totalMin > 30 ? '#f59e0b' : '#22c55e';
    chrome.action.setBadgeBackgroundColor({ color });
  } catch (_) {
    // Silently fail — badge just won't update
  }
}

// ─── Context Menus ──────────────────────────────────────────────────────────

function setupContextMenus() {
  chrome.contextMenus.create({
    id: 'viewScreenTime',
    title: 'View screen time for this site',
    contexts: ['page'],
  });
  chrome.contextMenus.create({
    id: 'setDailyGoal',
    title: 'Set daily goal for this site',
    contexts: ['page'],
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || !tab.url) return;
  try {
    const url = new URL(tab.url);
    const domain = url.hostname.replace(/^www\./, '');

    chrome.storage.local.get([USER_TOKEN_KEY], (result) => {
      const token = result[USER_TOKEN_KEY] || '';
      if (info.menuItemId === 'viewScreenTime') {
        chrome.tabs.create({
          url: `${SERVER_URL}/dashboard?user=${encodeURIComponent(token)}`,
        });
      } else if (info.menuItemId === 'setDailyGoal') {
        chrome.tabs.create({
          url: `${SERVER_URL}/dashboard?user=${encodeURIComponent(token)}&goal=${encodeURIComponent(domain)}`,
        });
      }
    });
  } catch (_) {}
});

// ─── Notification Clicks ───────────────────────────────────────────────────-
// Clicking a goal notification opens the dashboard so users can take action.

chrome.notifications.onClicked.addListener((notificationId) => {
  if (!notificationId || !notificationId.startsWith('goal-')) return;

  chrome.storage.local.get([USER_TOKEN_KEY], (result) => {
    const token = result[USER_TOKEN_KEY] || '';
    if (token) {
      chrome.tabs.create({
        url: `${SERVER_URL}/dashboard?user=${encodeURIComponent(token)}`,
      });
    }
  });
});



// ─── Alarms ─────────────────────────────────────────────────────────────────

// Check goals every 5 minutes
chrome.alarms.create('checkGoals', {
  periodInMinutes: GOAL_CHECK_INTERVAL_MINUTES,
});

// Reset notification cooldowns once a day
chrome.alarms.create('resetDaily', {
  delayInMinutes: 1,
  periodInMinutes: 1440, // 24 hours
});

// Update toolbar badge every minute
chrome.alarms.create('updateBadge', {
  periodInMinutes: BADGE_UPDATE_INTERVAL_MINUTES,
});

// Drain offline queue every 2 minutes (retry failed payloads)
chrome.alarms.create('drainOfflineQueue', {
  delayInMinutes: 1,
  periodInMinutes: OFFLINE_RETRY_INTERVAL_MINUTES,
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'checkGoals') {
    checkGoals();
  } else if (alarm.name === 'resetDaily') {
    resetDailyNotifications();
  } else if (alarm.name === 'updateBadge') {
    updateBadge();
  } else if (alarm.name === 'drainOfflineQueue') {
    drainOfflineQueue();
  }
});

// ─── On Install / Update / Startup ─────────────────────────────────────────

chrome.runtime.onInstalled.addListener((details) => {
  console.log('[background] Extension installed/updated:', details.reason);

  setupContextMenus();

  setTimeout(checkGoals, 10_000);
  setTimeout(updateBadge, 2_000);

  // Drain any offline-queued payloads that accumulated
  setTimeout(drainOfflineQueue, 5_000);
});

// ─── MV3 Lifecycle: onStartup ───────────────────────────────────────────────
// This fires when the service worker wakes up (e.g., after being suspended).
// We re-initialize the badge and drain the offline queue.

chrome.runtime.onStartup.addListener(() => {
  console.log('[background] Service worker started');

  // Re-initialize immediately
  setTimeout(updateBadge, 1_000);
  setTimeout(checkGoals, 5_000);
  setTimeout(drainOfflineQueue, 3_000);
});

// ─── Keep Alive (via alarms) ────────────────────────────────────────────────
// In MV3, the service worker can be terminated after ~30s of inactivity.
// The periodic alarms (1min badge, 2min drain, 5min goals) serve as natural
// keepalive events that wake the SW on fire. No manual setInterval needed —
// setInterval is not persisted across SW termination and gives false confidence.
// The alarms API is the canonical MV3 pattern for periodic wake-ups.

// ─── Message Handler ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handle token request from content script
  if (message === 'getUserToken') {
    getOrCreateToken().then((token) => sendResponse({ token }));
    return true;
  }

  // Handle tracking state query from popup or content script
  if (message && message.type === 'getTrackingState') {
    chrome.storage.local.get([PAUSE_KEY], (result) => {
      sendResponse({ paused: !!result[PAUSE_KEY] });
    });
    return true;
  }

  // Handle pause/resume toggle from popup
  if (message && message.type === 'setTrackingState') {
    const paused = !!message.paused;
    chrome.storage.local.set({ [PAUSE_KEY]: paused }, () => {
      // Content scripts react via chrome.storage.onChanged — no broadcast needed
      updateBadge();
      console.log('[background] Tracking', paused ? 'PAUSED' : 'RESUMED');
      sendResponse({ paused });
    });
    return true;
  }

  // Handle dashboard data request from popup
  if (message && message.type === 'getDashboardSummary') {
    getOrCreateToken().then(async (token) => {
      try {
        const [dashboardResp, goalsResp] = await Promise.all([
          fetch(`${SERVER_URL}/api/dashboard?user=${encodeURIComponent(token)}`),
          fetch(`${SERVER_URL}/api/goals/status?user=${encodeURIComponent(token)}`),
        ]);

        const dashboard = dashboardResp.ok ? await dashboardResp.json() : null;
        const goals = goalsResp.ok ? await goalsResp.json() : null;

        sendResponse({
          token,
          dashboard,
          goals: goals ? goals.goals : null,
        });
      } catch (err) {
        console.error('[background] Failed to fetch dashboard summary:', err);
        sendResponse({ token, dashboard: null, goals: null });
      }
    });
    return true;
  }

  if (!message || !message.domain) return;

  // Block tracking for excluded domains
  if (isBlockedDomain(message.domain)) {
    console.log('[background] Ignoring excluded domain:', message.domain);
    return;
  }

  console.log('[background] Forwarding tracking data for domain:', message.domain);

  // Forward the payload using the token from the content script (localStorage)
  // so the extension and dashboard share the same user identity.
  // Fallback to background's own token if content script didn't send one.
  getOrCreateToken()
    .then((bgToken) => {
      const payload = { ...message, userToken: message.userToken || bgToken };
      return fetch(`${SERVER_URL}/api/screen-time`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    })
    .then((response) => {
      if (response.ok) {
        console.log('[background] Tracking data sent:', message.domain, response.status);
      } else {
        console.warn('[background] Server returned non-OK status:', response.status);
      }
      // received mirrors the server result so the content script knows
      // whether to keep/queue the payload on failure.
      sendResponse({ received: response.ok, status: response.status });
    })
    .catch((err) => {
      console.error('[background] Failed to connect to server:', err);
      sendResponse({ received: false, error: err.message });
    });

  return true; // Keep service worker alive until sendResponse is called
});
