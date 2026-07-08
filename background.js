// LisTrack Background Service Worker
// Handles forwarding tracking payloads to bypass HTTPS -> HTTP mixed content blocking
// AND checks daily goals against screen time usage and sends Chrome notifications.

// ─── Configuration ──────────────────────────────────────────────────────────

const SERVER_URL = "https://listrack-2.onrender.com";

// Domains to block from being forwarded to the server (defense-in-depth).
// Should stay in sync with the IGNORED_DOMAIN_PATTERNS in tracker.js.
const BLOCKED_DOMAINS = [
  "localhost",
  "listrack.onrender.com",
  "listrack-2.onrender.com",
  "render.com",
];

const GOAL_CHECK_INTERVAL_MINUTES = 5;
const NOTIFICATION_COOLDOWN_MS = 30 * 60 * 1000; // 30 min before re-notifying

const USER_TOKEN_KEY = "lisTrackTrackerToken";

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

// ─── Alarms ─────────────────────────────────────────────────────────────────

// Check goals every 5 minutes
chrome.alarms.create("checkGoals", {
  periodInMinutes: GOAL_CHECK_INTERVAL_MINUTES,
});

// Reset notification cooldowns once a day (at a reasonable hour)
chrome.alarms.create("resetDaily", {
  delayInMinutes: 1,
  periodInMinutes: 1440, // 24 hours
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "checkGoals") {
    checkGoals();
  } else if (alarm.name === "resetDaily") {
    resetDailyNotifications();
  }
});

// ─── On Install / Update ────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener((details) => {
  console.log("[background] Extension installed/updated:", details.reason);
  // Run initial goal check shortly after install
  setTimeout(checkGoals, 10_000);
});

// ─── Message Handler ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handle token request from content script
  if (message === "getUserToken") {
    getOrCreateToken().then((token) => sendResponse({ token }));
    return true; // keep channel open for async response
  }

  if (!message || !message.domain) return;

  // Block tracking for excluded domains
  if (isBlockedDomain(message.domain)) {
    console.log("[background] Ignoring excluded domain:", message.domain);
    return;
  }

  console.log("[background] Forwarding tracking data for domain:", message.domain);

  // Forward the payload using the token from the content script (localStorage)
  // so the extension and dashboard share the same user identity.
  // Fallback to background's own token if content script didn't send one.
  getOrCreateToken().then((bgToken) => {
    const payload = { ...message, userToken: message.userToken || bgToken };

    fetch(`${SERVER_URL}/api/screen-time`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    })
      .then((response) => {
        if (!response.ok) {
          console.warn("[background] Server returned non-OK status:", response.status);
        }
      })
      .catch((err) => {
        console.error("[background] Failed to connect to server:", err);
      });
  });

  return true;
});
