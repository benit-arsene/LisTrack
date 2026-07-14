// LisTrack Background Service Worker
// Handles forwarding tracking payloads to bypass HTTPS -> HTTP mixed content blocking
// AND checks daily goals against screen time usage and sends Chrome notifications.

// ─── Configuration ──────────────────────────────────────────────────────────

const SERVER_URL = "https://listrack-2.onrender.com";

// Domains to block from being forwarded to the server (defense-in-depth).
// Should stay in sync with the IGNORED_DOMAIN_PATTERNS in tracker.js.
// LisTrack dashboard domains are blocked to avoid self-tracking.
// Other render.com subdomains are NOT blocked.
const BLOCKED_DOMAINS = [
  "localhost",
  "listrack.onrender.com",
  "listrack-2.onrender.com",
];

const GOAL_CHECK_INTERVAL_MINUTES = 5;
const NOTIFICATION_COOLDOWN_MS = 30 * 60 * 1000; // 30 min before re-notifying
const BADGE_UPDATE_INTERVAL_MINUTES = 1; // Update toolbar badge every minute

const USER_TOKEN_KEY = "lisTrackTrackerToken";
const PAUSE_KEY = "lisTrackPaused";

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

/**
 * Reset notification cooldowns at midnight (new day = new chance to warn).
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

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'checkGoals') {
    checkGoals();
  } else if (alarm.name === 'resetDaily') {
    resetDailyNotifications();
  } else if (alarm.name === 'updateBadge') {
    updateBadge();
  }
});

// ─── On Install / Update ────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener((details) => {
  console.log('[background] Extension installed/updated:', details.reason);

  // Setup context menus
  setupContextMenus();

  // Run initial goal check shortly after install
  setTimeout(checkGoals, 10_000);

  // Update badge immediately on install
  setTimeout(updateBadge, 2_000);
});

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
      sendResponse({ received: true, status: response.status });
    })
    .catch((err) => {
      console.error('[background] Failed to connect to server:', err);
      sendResponse({ received: false, error: err.message });
    });

  return true; // Keep service worker alive until sendResponse is called
});
