// LisTrack Background Service Worker (Air-Tight Precision v2)
//
// FIXES vs v1:
//   1. Offline queue: buffers failed payloads in chrome.storage.local
//   2. Retry mechanism: drains offline queue on periodic alarm
//   3. Service worker lifecycle: onStartup re-initializes, onSuspend saves state
//   4. Dedup is enforced server-side via a UNIQUE (user_id, seq_id) index
//   5. Handles forwarding tracking payloads to bypass mixed content blocking
//   6. Checks daily goals and sends Chrome notifications
//   7. Mandatory Google sign-in: all server traffic is gated on user_id
//      (the signed-in Google email in chrome.storage.sync). Without it,
//      tracking is paused and no data is sent.

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

// Badge color scale — the toolbar badge turns fully red at this many hours of
// daily screen time. The server can push a different value at runtime via the
// `badgeMaxHours` field on /api/screen-time ping responses (see
// applyBadgeConfig), so installed extensions pick up threshold updates on
// their next ping without a manual reinstall.
const BADGE_MAX_HOURS_DEFAULT = 10;
const BADGE_MAX_HOURS_KEY = "lisTrackBadgeMaxHours";
let _badgeMaxHours = BADGE_MAX_HOURS_DEFAULT;

// Client flush interval — how often the content script sends accumulated
// screen-time to the server. Server-pushed via flushIntervalSeconds on
// /api/screen-time responses (same pattern as badgeMaxHours).
const FLUSH_INTERVAL_KEY = "lisTrackFlushIntervalSeconds";
const FLUSH_INTERVAL_DEFAULT_SECONDS = 30;
let _flushIntervalSeconds = FLUSH_INTERVAL_DEFAULT_SECONDS;

const USER_ID_KEY = "user_id";
const PAUSE_KEY = "lisTrackPaused";
const OFFLINE_QUEUE_KEY = "lisTrackOfflineQueue";
// The site-visit retry queue is deliberately a SEPARATE key: the
// screen-time queue is drained exclusively to /api/screen-time, so a visit
// parked in it would be replayed to the wrong endpoint.
const SITE_VISIT_QUEUE_KEY = "lisTrackSiteVisitQueue";
const SITE_VISIT_WINDOW_KEY = "lisTrackSiteVisitWindow";
const SITE_VISIT_WINDOW_MS = 3 * 60 * 1000; // 3 minutes

// ─── Namespaced Message Types ─────────────────────────────────────────────
// Every message this extension sends carries an explicit `type`. Messages
// whose type starts with this namespace are claimed and routed BY TYPE in
// the message handler, and can never fall through into the screen-time
// forwarder — which dispatches on the mere presence of `domain`, so a
// domain-bearing feature message would otherwise be mistaken for screen time
// and POSTed to /api/screen-time.
const TYPE_NAMESPACE = "lisTrack:";
const VISIT_MESSAGE_TYPE = "lisTrack:siteVisit";

// ─── User Identity (Mandatory Google Sign-In) ──────────────────────────────
// The signed-in Google email is stored in chrome.storage.sync under
// `user_id`. Every network request to the server is gated on its presence.

/**
 * Get the signed-in user's Google email, or null when not signed in.
 */
async function getUserId() {
  try {
    const result = await chrome.storage.sync.get([USER_ID_KEY]);
    const id = result[USER_ID_KEY];
    // Emails are case-insensitive — normalize to lowercase so the
    // server-side identity stays consistent across all callers.
    return typeof id === "string" && id.trim() ? id.trim().toLowerCase() : null;
  } catch (err) {
    console.error("[background] Failed to read user_id:", err);
    return null;
  }
}

/**
 * Open the mandatory onboarding (Google sign-in) page.
 */
function openOnboarding() {
  chrome.tabs.create({ url: chrome.runtime.getURL("public/html/onboarding.html") });
}

// In-memory cache for the Google access token — the /api/* endpoints are now
// authenticated, so every server call needs the token. Chrome's identity API
// is cheap but async IPC; caching avoids the churn on per-flush screen-time
// posts (every ~2s per tab). Tokens live ~1 hour; we refresh ours every 10 min.
let _cachedAccessToken = null;
let _cachedAccessTokenAt = 0;
const ACCESS_TOKEN_CACHE_MS = 10 * 60 * 1000;

/**
 * Get the cached Google OAuth access token (no consent UI — the user already
 * authorized during onboarding). Returns null when not signed in / revoked.
 */
function getGoogleAccessToken() {
  if (
    _cachedAccessToken &&
    Date.now() - _cachedAccessTokenAt < ACCESS_TOKEN_CACHE_MS
  ) {
    return Promise.resolve(_cachedAccessToken);
  }
  return new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (chrome.runtime.lastError) {
        console.warn('[background] No cached Google token:', chrome.runtime.lastError.message);
        _cachedAccessToken = null;
        resolve(null);
      } else {
        _cachedAccessToken = token || null;
        _cachedAccessTokenAt = Date.now();
        resolve(_cachedAccessToken);
      }
    });
  });
}

/**
 * Merge an `Authorization: Bearer <Google token>` header into a header set.
 * The server's requireAuth middleware verifies the token (cached server-side)
 * before serving any /api/* data.
 */
async function authedFetchHeaders(extra = {}) {
  const token = await getGoogleAccessToken();
  if (!token) return extra;
  return { ...extra, Authorization: `Bearer ${token}` };
}

/**
 * Open the dashboard passing the Google access token (?access_token=...).
 * The server verifies the token, mints an HTTP-only session cookie, and then
 * redirects to a clean /dashboard URL. Falls back to onboarding when no
 * token is available.
 *
 * @param {Object} extraParams Optional benign params (e.g. { goal: domain }).
 */
async function openDashboardWithToken(extraParams = {}) {
  const accessToken = await getGoogleAccessToken();
  if (!accessToken) {
    openOnboarding();
    return;
  }
  const params = new URLSearchParams({ access_token: accessToken });
  for (const [key, value] of Object.entries(extraParams)) {
    if (value) params.set(key, value);
  }
  chrome.tabs.create({ url: `${SERVER_URL}/dashboard?${params.toString()}` });
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
async function fetchGoalStatus(userId) {
  try {
    // No `?user=` — the server derives identity from the verified bearer
    // token. `userId` is still used locally to gate on sign-in.
    const response = await fetch(`${SERVER_URL}/api/goals/status`, {
      headers: await authedFetchHeaders(),
    });
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
  const title = isWarning ? "Approaching screen time limit" : "Screen time limit reached!";
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
 * Gated on sign-in — never runs without a user_id.
 */
async function checkGoals() {
  console.log("[background] Checking goals...");

  const userId = await getUserId();
  if (!userId) {
    console.log("[background] Skipping goal check — user not signed in");
    return;
  }

  const data = await fetchGoalStatus(userId);
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
// The content script pushes failed payloads to chrome.storage.local, and
// this worker ALSO buffers its own failed forwards (e.g. page-unload
// fire-and-forget sends, where the content script context is already gone
// and cannot queue itself). Draining is owned EXCLUSIVELY by this worker
// (2-minute alarm + startup).

/**
 * Append a payload to the durable offline queue (bounded to latest 500).
 */
async function pushToOfflineQueue(payload) {
  try {
    const result = await chrome.storage.local.get([OFFLINE_QUEUE_KEY]);
    const queue = result[OFFLINE_QUEUE_KEY] || [];
    queue.push({ ...payload, queuedAt: Date.now() });
    await chrome.storage.local.set({ [OFFLINE_QUEUE_KEY]: queue.slice(-500) });
    return true;
  } catch (_) {
    return false;
  }
}

async function drainOfflineQueue() {
  try {
    // Gated on sign-in — never send to the server without a user_id
    const userId = await getUserId();
    if (!userId) return;

    const result = await chrome.storage.local.get([OFFLINE_QUEUE_KEY]);
    const queue = result[OFFLINE_QUEUE_KEY] || [];
    if (queue.length === 0) return;

    const pendingRetries = [];
    let drained = 0;
    const drainHeaders = await authedFetchHeaders({ 'Content-Type': 'application/json' });

    // Parallel batch: send up to 5 concurrent requests instead of serial.
    // This keeps the SW alive for less time while draining the same queue.
    const BATCH_SIZE = 5;
    for (let i = 0; i < queue.length; i += BATCH_SIZE) {
      const batch = queue.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((entry) =>
          fetch(`${SERVER_URL}/api/screen-time`, {
            method: 'POST',
            headers: drainHeaders,
            body: JSON.stringify(entry),
          }).then((response) => {
            if (response.ok) return { entry, ok: true };
            if (response.status >= 400 && response.status < 500) {
              return { entry, ok: false, drop: true, status: response.status };
            }
            return { entry, ok: false, status: response.status };
          })
        )
      );
      results.forEach((r, idx) => {
        const entry = batch[idx];
        if (r.status !== 'fulfilled') {
          // Network-level failure — the Error has no .entry, use batch[idx]
          pendingRetries.push(entry);
          return;
        }
        const { ok, drop } = r.value;
        if (ok) {
          drained++;
        } else if (drop) {
          console.warn('[background] Dropping permanently-invalid queued payload:', r.value.status);
        } else {
          pendingRetries.push(entry);
        }
      });
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

// Color ramp for the badge background — linearly interpolated between stops,
// expressed as a fraction of the badge max (10h by default). At the default
// 10h scale this maps to:
//   0h – 3.5h   solid fresh green (#22c55e)
//   3.5h – 7h   smooth green → yellow (#eab308) → soft orange (#fb923c)
//   8h – 10h+   deepens through orange to full red (#ef4444)
const BADGE_COLOR_STOPS = [
  { frac: 0.0, color: "#22c55e" },  // fresh green
  { frac: 0.35, color: "#22c55e" }, // solid green until 3.5h (of 10h)
  { frac: 0.525, color: "#eab308" },// yellow
  { frac: 0.7, color: "#fb923c" },  // soft orange
  { frac: 0.8, color: "#fb923c" },  // soft orange through the 8h band
  { frac: 0.9, color: "#f97316" },  // deeper orange
  { frac: 1.0, color: "#ef4444" },  // red at max
];

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }) {
  const ch = (v) =>
    Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");
  return `#${ch(r)}${ch(g)}${ch(b)}`;
}

/**
 * Smoothly interpolate the badge color for a given daily screen time.
 * @param {number} hours Current daily screen time in hours.
 * @param {number} maxHours Hours at which the badge turns fully red.
 */
function badgeColorForHours(hours, maxHours) {
  const frac = maxHours > 0 ? hours / maxHours : 0;
  const stops = BADGE_COLOR_STOPS;
  if (frac <= stops[0].frac) return stops[0].color;
  if (frac >= stops[stops.length - 1].frac) {
    return stops[stops.length - 1].color;
  }
  for (let i = 1; i < stops.length; i++) {
    const prev = stops[i - 1];
    const next = stops[i];
    if (frac <= next.frac) {
      const t = (frac - prev.frac) / (next.frac - prev.frac);
      const a = hexToRgb(prev.color);
      const b = hexToRgb(next.color);
      return rgbToHex({
        r: a.r + (b.r - a.r) * t,
        g: a.g + (b.g - a.g) * t,
        b: a.b + (b.b - a.b) * t,
      });
    }
  }
  return stops[stops.length - 1].color;
}

/**
 * Load the server-provided badge threshold (badgeMaxHours) persisted in
 * chrome.storage.local, falling back to the compiled-in default (10h).
 */
async function loadBadgeConfig() {
  try {
    const result = await chrome.storage.local.get([BADGE_MAX_HOURS_KEY]);
    const stored = result[BADGE_MAX_HOURS_KEY];
    if (typeof stored === "number" && stored > 0 && isFinite(stored)) {
      _badgeMaxHours = stored;
    }
  } catch (_) {}
}

/**
 * Apply badge config returned by a server ping response (if present). Updates
 * the in-memory threshold AND persists it so it survives service-worker
 * restarts. Fully additive — a response without badgeMaxHours is a no-op.
 */
async function applyBadgeConfig(data) {
  if (!data || typeof data.badgeMaxHours !== "number") return;
  if (!(data.badgeMaxHours > 0) || !isFinite(data.badgeMaxHours)) return;
  _badgeMaxHours = data.badgeMaxHours;
  try {
    await chrome.storage.local.set({ [BADGE_MAX_HOURS_KEY]: data.badgeMaxHours });
  } catch (_) {}
}

// Restore the persisted threshold on service-worker start (defaults to 10h).
void loadBadgeConfig();

/**
 * Load the server-provided flush interval persisted in chrome.storage.local,
 * falling back to the compiled-in default (30s).
 */
async function loadFlushConfig() {
  try {
    const result = await chrome.storage.local.get([FLUSH_INTERVAL_KEY]);
    const stored = result[FLUSH_INTERVAL_KEY];
    if (typeof stored === "number" && stored > 0 && isFinite(stored)) {
      _flushIntervalSeconds = stored;
    }
  } catch (_) {}
}

/**
 * Apply flush config returned by a server ping response (if present).
 * Updates in-memory value AND persists it so it survives SW restarts.
 * Fully additive — a response without flushIntervalSeconds is a no-op.
 */
async function applyFlushConfig(data) {
  if (!data || typeof data.flushIntervalSeconds !== "number") return;
  if (!(data.flushIntervalSeconds > 0) || !isFinite(data.flushIntervalSeconds)) return;
  _flushIntervalSeconds = data.flushIntervalSeconds;
  try {
    await chrome.storage.local.set({ [FLUSH_INTERVAL_KEY]: data.flushIntervalSeconds });
  } catch (_) {}
}

// Restore the persisted flush interval on service-worker start.
void loadFlushConfig();

async function updateBadge() {
  try {
    const userId = await getUserId();
    if (!userId) {
      // Not signed in — no badge to show (reset both text and color)
      chrome.action.setBadgeText({ text: '' });
      chrome.action.setBadgeBackgroundColor({ color: '#6b7280' });
      return;
    }
    // Use the lightweight /api/today endpoint instead of the full dashboard.
    // This avoids fetching the entire per-domain breakdown just for the
    // total minutes needed to render the badge.
    const resp = await fetch(`${SERVER_URL}/api/today`, {
      headers: await authedFetchHeaders(),
    });
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

    // Color: grey when paused; otherwise ramp green → yellow → orange → red
    // across 0h to BADGE_MAX_HOURS_DEFAULT (adjustable server-side via
    // badgeMaxHours on ping responses).
    try {
      const paused = await chrome.storage.local.get([PAUSE_KEY]);
      if (paused[PAUSE_KEY]) {
        chrome.action.setBadgeBackgroundColor({ color: '#6b7280' });
        return;
      }
    } catch (_) {}

    const color = badgeColorForHours(totalMin / 60, _badgeMaxHours);
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

    getUserId().then((userId) => {
      if (!userId) {
        // Not signed in — route to onboarding first
        openOnboarding();
        return;
      }
      if (info.menuItemId === 'viewScreenTime') {
        openDashboardWithToken();
      } else if (info.menuItemId === 'setDailyGoal') {
        openDashboardWithToken({ goal: domain });
      }
    });
  } catch (_) {}
});

// ─── Notification Clicks ────────────────────────────────────────────────────
// Clicking a goal notification opens the dashboard so users can take action.

chrome.notifications.onClicked.addListener((notificationId) => {
  if (!notificationId || !notificationId.startsWith('goal-')) return;

  getUserId().then((userId) => {
    if (!userId) {
      openOnboarding();
      return;
    }
    openDashboardWithToken();
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
    // Reuse the SAME wake-up (no new alarm, no polling) to retry any
    // buffered site visits. It is a no-op when the queue is empty.
    void drainSiteVisitQueue();
  }
});

// ─── On Install / Update / Startup ─────────────────────────────────────────

chrome.runtime.onInstalled.addListener((details) => {
  console.log('[background] Extension installed/updated:', details.reason);

  setupContextMenus();

  // Mandatory onboarding: on first install, open the Google sign-in page
  if (details.reason === 'install') {
    openOnboarding();
  }

  setTimeout(checkGoals, 10_000);
  setTimeout(updateBadge, 2_000);

  // Drain any offline-queued payloads that accumulated
  setTimeout(drainOfflineQueue, 5_000);
  // Buffered site visits retry immediately — no timer, no extra wake-up.
  void drainSiteVisitQueue();
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
  void drainSiteVisitQueue();
});

// ─── Keep Alive (via alarms) ────────────────────────────────────────────────
// In MV3, the service worker can be terminated after ~30s of inactivity.
// The periodic alarms (1min badge, 2min drain, 5min goals) serve as natural
// keepalive events that wake the SW on fire. No manual setInterval needed —
// setInterval is not persisted across SW termination and gives false confidence.
// The alarms API is the canonical MV3 pattern for periodic wake-ups.

// ─── Site Visit Handling (Most Visited Sites) ───────────────────────────
// The content script (public/js/visit-tracker.js) sends exactly one message
// per engaged document: { type: "lisTrack:siteVisit", domain, visit_id }.
//
// IDENTITY: the sender never learns who is signed in and never names a user.
// The account is resolved HERE, from the existing chrome.storage.sync
// user_id, and the request is authenticated with the existing Google access
// token via authedFetchHeaders(). Ownership itself is decided by the server
// from the verified bearer token (req.authenticatedUser → user_id).
//
// SUBMISSION: one POST per received visit message. No polling, no timers, no
// retry loop — the visit-session latch in the content script already limits
// this to one message per document session.
//
// OFFLINE: a failed visit is NOT pushed into lisTrackOfflineQueue. That queue
// is drained exclusively to /api/screen-time, so queueing a visit there would
// replay it to the wrong endpoint. A failed visit is dropped; a dedicated
// durable visit queue is a separate concern.

const VISIT_MEMORY_LIMIT = 50;
const _recentVisits = [];

// ─── Per-(user, domain) visit-window lock ───────────────────────────────────
// In MV3 the service worker is single-threaded but async, so two messages for
// the same user + domain can interleave their getSiteVisitWindows →
// decide → setSiteVisitWindows → POST sequence. Without serialization both can
// observe an empty/expired window and both POST a new visit (one per page
// navigation). This map holds an in-flight promise per key; the next waiter
// chains onto it, so the read-decide-write-POST block runs to completion
// before the next same-key message proceeds. Different (user, domain) pairs
// are independent and never block each other. Entries are resolved promises
// retained by the map for the lifetime of the worker; they are tiny and
// bounded by the number of distinct (user, domain) pairs seen.
const _visitWindowLocks = new Map();

/**
 * Acquire a per (userId, domain) lock. The returned `wait` promise resolves
 * once every prior same-key holder has released. `release()` must be called
 * (in a `finally`) when the holder is done — it frees the next waiter.
 */
function acquireVisitWindowLock(userId, domain) {
  const key = `${userId}:${domain}`;
  const prev = _visitWindowLocks.get(key);
  let release;
  const tail = new Promise((res) => { release = res; });
  _visitWindowLocks.set(key, prev ? prev.then(() => tail, () => tail) : tail);
  return {
    wait: prev ? prev.then(() => undefined, () => undefined) : Promise.resolve(),
    release() {
      if (typeof release === "function") {
        release();
        release = null;
      }
    },
  };
}

/** A conservative hostname shape check — the server normalizes for real. */
function isValidHostname(domain) {
  return typeof domain === "string" && /^[a-z0-9][a-z0-9.-]*$/.test(domain);
}

/**
 * Get the persisted visit-window state for a user.
 * @param {string} userId
 * @returns {Promise<Object>} map of domain -> { visitId, lastInteractionAt }
 */
async function getSiteVisitWindows(userId) {
  try {
    const result = await chrome.storage.local.get([SITE_VISIT_WINDOW_KEY]);
    const allWindows = result[SITE_VISIT_WINDOW_KEY] || {};
    return allWindows[userId] || {};
  } catch (_) {
    return {};
  }
}

/**
 * Save the visit-window state for a user.
 * @param {string} userId
 * @param {Object} windows map of domain -> { visitId, lastInteractionAt }
 */
async function setSiteVisitWindows(userId, windows) {
  try {
    const result = await chrome.storage.local.get([SITE_VISIT_WINDOW_KEY]);
    const allWindows = result[SITE_VISIT_WINDOW_KEY] || {};
    allWindows[userId] = windows;
    await chrome.storage.local.set({ [SITE_VISIT_WINDOW_KEY]: allWindows });
  } catch (_) {
    // Ignore storage errors
  }
}

/**
 * Clear visit-window state for a user (e.g., on sign-out).
 * @param {string} userId
 */
async function clearSiteVisitWindows(userId) {
  try {
    const result = await chrome.storage.local.get([SITE_VISIT_WINDOW_KEY]);
    const allWindows = result[SITE_VISIT_WINDOW_KEY] || {};
    if (allWindows[userId]) {
      delete allWindows[userId];
      await chrome.storage.local.set({ [SITE_VISIT_WINDOW_KEY]: allWindows });
    }
  } catch (_) {
    // Ignore storage errors
  }
}

/**
 * Generate a visit ID. Uses crypto.randomUUID() when available, falls back to
 * a hand-built v4 UUID via crypto.getRandomValues(), and finally to a
 * timestamp+random string. Must work on insecure origins (content script
 * also runs on plain HTTP pages).
 */
function generateVisitId() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch (_) {}

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

  // Last resort: timestamp + random suffix (same convention as tracker.js).
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Handle one engaged-visit message: record it and submit once.
 * Uses a 3-minute domain visit window to disambiguate visits: an interaction
 * at or past the 3-minute mark starts a NEW visit, while one inside it reuses
 * the existing visit and only advances lastInteractionAt.
 * Never throws.
 * @returns {Promise<{received: boolean, requiresAuth?: boolean, isNewVisit?: boolean, visitId?: string, visitStatus?: string, status?: number, reason?: string}>}
 */
async function handleSiteVisitMessage(message) {
  console.log("[DEBUG handleSiteVisitMessage] called with:", message);
  // Resolve the authenticated account ourselves. Anything identity-shaped in
  // the message body is ignored by construction — it is never read.
  const userId = await getUserId();
  console.log("[DEBUG handleSiteVisitMessage] userId:", userId);
  if (!userId) {
    console.log("[background] Ignoring site visit — user not signed in");
    return { received: false, requiresAuth: true };
  }

  // Bare hostname only; normalizeDomain lowercases and strips a leading www.
  const domain = LisTrackBlocker.normalizeDomain(message && message.domain);
  console.log("[DEBUG handleSiteVisitMessage] domain:", domain);
  if (!isValidHostname(domain)) {
    console.warn(
      "[background] Ignoring site visit with invalid domain:",
      message && message.domain,
    );
    return { received: false, reason: "invalid domain" };
  }

  // Excluded domains are filtered by the EXISTING screen-time rule: the same
  // BLOCKED_DOMAINS list and the same isBlockedDomain() helper the screen-time
  // forwarder applies. No second exclusion system is defined here. The check
  // runs on the already-normalized domain, exactly as the blocker paths do, so
  // LisTrack's own hosts can never become a Most Visited Site.
  //
  // Placement: at the background boundary, BEFORE the POST and before any
  // buffering — an excluded visit is neither submitted to /api/site-visits nor
  // written to lisTrackSiteVisitQueue.
  if (isBlockedDomain(domain)) {
    console.log("[background] Ignoring excluded domain site visit:", domain);
    return { received: false, reason: "excluded domain" };
  }

  // Serialize the read-decide-write-POST sequence per (user, domain) so that
  // concurrent engagement messages for the same user + domain (e.g. rapid
  // navigations or two tabs) cannot both observe an empty/expired window and
  // both POST a new visit. Different domains are independent.
  const visitWindowLock = acquireVisitWindowLock(userId, domain);
  await visitWindowLock.wait;
  try {
    // Look up the current user's visit window for this domain
    const windows = await getSiteVisitWindows(userId);
    console.log("[DEBUG handleSiteVisitMessage] windows:", windows);
    const window = windows[domain];
    const now = Date.now();

    let visitId;
    let isNewVisit = false;

    if (!window) {
      // No active window — create a new visit
      visitId = generateVisitId();
      windows[domain] = { visitId, lastInteractionAt: now };
      isNewVisit = true;
    } else if (now - window.lastInteractionAt >= SITE_VISIT_WINDOW_MS) {
      // At or past the 3-minute boundary — the window has expired; start a new visit
      visitId = generateVisitId();
      windows[domain] = { visitId, lastInteractionAt: now };
      isNewVisit = true;
    } else {
      // Active window — reuse existing visitId, update timestamp
      visitId = window.visitId;
      window.lastInteractionAt = now;
      isNewVisit = false;
    }

    console.log("[DEBUG handleSiteVisitMessage] visitId:", visitId, "isNewVisit:", isNewVisit);

    // Persist the updated window
    await setSiteVisitWindows(userId, windows);

    _recentVisits.push({ userId, domain, at: now });
    if (_recentVisits.length > VISIT_MEMORY_LIMIT) _recentVisits.shift();

    // If not a new visit, we're done — no POST needed
    if (!isNewVisit) {
      console.log(`[background] Site visit for ${domain}: existing visit (window active)`);
      return { received: true, isNewVisit: false, visitId };
    }

    // New visit — POST to server
    const payload = { domain, visit_id: visitId };

    let response;
    try {
      response = await fetch(`${SERVER_URL}/api/site-visits`, {
        method: "POST",
        headers: await authedFetchHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.warn("[background] Site visit not submitted:", err && err.message);
      _siteVisitQueueOwnerId = userId;
      const queued = await pushSiteVisitToQueue(domain, visitId);
      return { received: false, error: "visit-not-sent", queued, isNewVisit: true, visitId };
    }

    if (response.ok) {
      let visitStatus = "ok";
      try {
        const data = await response.json();
        if (data && (data.status === "ok" || data.status === "duplicate" || data.status === "ignored")) {
          visitStatus = data.status;
        }
      } catch (_) {}
      console.log(`[background] Site visit handled for ${domain}: ${visitStatus}`);
      const result = { received: true, isNewVisit: true, visitId, visitStatus };
      console.log("[DEBUG handleSiteVisitMessage] returning:", result);
      return result;
    }

    // Non-OK. Only a server-side/transient failure is worth retrying; a
    // permanent client error (4xx, including 401 and 400) is dropped rather
    // than retried forever — the same conservative policy the screen-time
    // drain applies to its queue.
    if (response.status >= 500) {
      _siteVisitQueueOwnerId = userId;
      const queued = await pushSiteVisitToQueue(domain, visitId);
      console.warn(
        `[background] Site visit failed with ${response.status} — ${queued ? "queued for retry" : "could not be queued"}`,
      );
      return { received: false, status: response.status, queued, isNewVisit: true, visitId };
    }

    console.warn(
      "[background] Site visit rejected permanently:",
      response.status,
    );
    return { received: false, status: response.status, queued: false, isNewVisit: true, visitId };
  } finally {
    visitWindowLock.release();
  }
}

// ─── Site Visit Queue (durable retry) ───────────────────────────────────
// A visit whose request failed is buffered here and retried later. This queue
// is completely independent of lisTrackOfflineQueue: different storage key,
// different endpoint, different record shape, and the two never merge.
//
// RECORDS hold ONLY what the retry request needs — { domain, visit_id }.
// Never an account, a token, a header, a URL, a path or any page data. The
// account is resolved from the existing sign-in mechanism at drain time.

/**
 * Bound on stored visits. Visits are far rarer than screen-time pings (one
 * per ENGAGED document, not one per flush), so this is smaller than the
 * screen-time queue's 500 while still ample. Overflow policy: DROP OLDEST,
 * keeping the most recent activity. Storage never grows unbounded.
 */
const SITE_VISIT_QUEUE_MAX = 100;

// Single-flight guard so two drains cannot submit the same record twice.
let _siteVisitDrainInFlight = false;

// The account the queue belongs to. HELD IN MEMORY ONLY — never persisted,
// never written into a record. It exists solely so a drain can notice that
// the signed-in account changed and refuse to mis-attribute buffered visits.
let _siteVisitQueueOwnerId = null;

/**
 * Buffer one failed visit for a later retry.
 * @returns {Promise<boolean>} whether the record is now queued
 */
async function pushSiteVisitToQueue(domain, visitId) {
  try {
    const record = { domain, visit_id: visitId };
    const result = await chrome.storage.local.get([SITE_VISIT_QUEUE_KEY]);
    const stored = result[SITE_VISIT_QUEUE_KEY];
    const queue = Array.isArray(stored) ? stored : [];

    // The same visit may already be waiting (e.g. two failed attempts). Do
    // not let the queue grow with duplicates of a single logical visit.
    if (queue.some((e) => e && e.domain === domain && e.visit_id === visitId)) {
      return true;
    }

    const next = queue.concat([record]);
    const overflow = next.length - SITE_VISIT_QUEUE_MAX;
    if (overflow > 0) {
      console.warn(
        `[background] Site visit queue full (${SITE_VISIT_QUEUE_MAX}) — dropping ${overflow} oldest record(s)`,
      );
    }
    await chrome.storage.local.set({
      [SITE_VISIT_QUEUE_KEY]: next.slice(-SITE_VISIT_QUEUE_MAX),
    });
    return true;
  } catch (_) {
    return false;
  }
}

/** Read the queue as a plain array (tolerates a missing or corrupt value). */
async function readSiteVisitQueue() {
  try {
    const result = await chrome.storage.local.get([SITE_VISIT_QUEUE_KEY]);
    const stored = result[SITE_VISIT_QUEUE_KEY];
    return Array.isArray(stored) ? stored : [];
  } catch (_) {
    return [];
  }
}

/**
 * Retry buffered visits, oldest first.
 *
 * Triggered from the extension lifecycle (install/update and browser start)
 * and from the existing 2-minute alarm that already drains the screen-time
 * queue — no new alarm, no polling loop, no timer is introduced here.
 *
 * Removal rules:
 *   ok / duplicate / ignored  → removed (all are terminal successes; a
 *                               duplicate is the server's uniqueness guard
 *                               working, so it is never retried)
 *   4xx                       → removed (permanent; retrying cannot help)
 *   5xx / network failure     → kept for the next drain
 */
async function drainSiteVisitQueue() {
  if (_siteVisitDrainInFlight) return;
  _siteVisitDrainInFlight = true;
  try {
    const queue = await readSiteVisitQueue();
    if (queue.length === 0) return;

    // Ownership is resolved HERE, from the existing sign-in gate — never from
    // a stored record.
    const userId = await getUserId();
    if (!userId) {
      // Signed out: leave the queue untouched so it can be retried for its
      // own account once that account is back.
      return;
    }

    if (_siteVisitQueueOwnerId === null) {
      // First drain since this worker started. We cannot verify which account
      // queued these records without persisting identity, so adopt the
      // current one and say so loudly.
      _siteVisitQueueOwnerId = userId;
      console.warn(
        `[background] Adopting ${queue.length} queued site visit(s) for the signed-in account (owner unknown after restart)`,
      );
    } else if (_siteVisitQueueOwnerId !== userId) {
      // The signed-in account changed after these records were buffered.
      // We do NOT discard: visit_id is a UUID and the server enforces a
      // UNIQUE(user_id, visit_id) index, so replaying a previously buffered
      // visit for the new account is harmless (the server deduplicates by
      // (user_id, visit_id) and a duplicate is a no-op). Discarding was the
      // wrong policy here — it silently dropped today's visits whenever the
      // in-memory owner failed to match (e.g. worker restart + re-sign-in),
      // producing "Today = EMPTY" in Most Visited Sites while earlier days
      // still showed data. Re-tag the queue to the current account and drain.
      console.warn(
        "[background] Account changed — replaying queued site visits under the new owner (visit_id dedup is server-side)",
      );
      _siteVisitQueueOwnerId = userId;
    }

    const headers = await authedFetchHeaders({ "Content-Type": "application/json" });
    const snapshot = new Set(queue.map((e) => JSON.stringify(e)));
    const remaining = [];

    for (const record of queue) {
      if (!record || typeof record.domain !== "string" || !record.visit_id) {
        continue; // Unusable record — drop rather than resend forever.
      }
      if (isBlockedDomain(record.domain)) {
        // Same existing exclusion rule as the live path. An excluded domain can
        // no longer be queued; this only stops a record buffered by an earlier
        // build from ever being sent.
        console.warn(
          "[background] Dropping queued site visit for excluded domain:",
          record.domain,
        );
        continue;
      }
      try {
        const response = await fetch(`${SERVER_URL}/api/site-visits`, {
          method: "POST",
          headers,
          body: JSON.stringify({ domain: record.domain, visit_id: record.visit_id }),
        });
        if (response.ok) continue; // ok / duplicate / ignored → delivered
        if (response.status >= 400 && response.status < 500) {
          console.warn(
            "[background] Dropping permanently-invalid queued site visit:",
            response.status,
          );
          continue;
        }
        remaining.push(record); // 5xx — try again later
      } catch (_) {
        remaining.push(record); // transport failure — try again later
      }
    }

    // Merge with anything buffered WHILE this drain was in flight, because
    // chrome.storage.local.set replaces the whole key.
    const current = await readSiteVisitQueue();
    const addedDuringDrain = current.filter((e) => !snapshot.has(JSON.stringify(e)));
    await chrome.storage.local.set({
      [SITE_VISIT_QUEUE_KEY]: remaining
        .concat(addedDuringDrain)
        .slice(-SITE_VISIT_QUEUE_MAX),
    });

    const delivered = queue.length - remaining.length;
    if (delivered > 0) {
      console.log(
        `[background] Drained site visit queue: ${delivered} delivered, ${remaining.length} still queued`,
      );
    }
  } catch (err) {
    // A failure here (e.g. no access token) leaves the queue untouched.
    console.warn("[background] Site visit queue drain failed:", err && err.message);
  } finally {
    _siteVisitDrainInFlight = false;
  }
}

// ─── Message Handler ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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

  // Handle sign-out: clear cached Google auth tokens + user_id
  if (message && message.type === 'signOut') {
    (async () => {
      // Get the current user_id BEFORE removing it, so we can clear their visit windows.
      const result = await chrome.storage.sync.get([USER_ID_KEY]);
      const signingOutUserId = result[USER_ID_KEY];

      // Drop the in-memory token cache so the revoked token isn't reused.
      _cachedAccessToken = null;
      _cachedAccessTokenAt = 0;
      try {
        await chrome.identity.clearAllCachedAuthTokens();
      } catch (_) {}
      try {
        await chrome.storage.sync.remove([USER_ID_KEY]);
      } catch (_) {}
      // Buffered site visits belong to the account signing out. They are
      // dropped here rather than left behind, because the next account to
      // sign in would otherwise inherit them as its own activity. (The
      // screen-time queue is deliberately left untouched by this handler.)
      try {
        await chrome.storage.local.set({ [SITE_VISIT_QUEUE_KEY]: [] });
      } catch (_) {}
      // Clear the user's visit-window state so the next account doesn't inherit it
      try {
        if (signingOutUserId) {
          await clearSiteVisitWindows(signingOutUserId);
        }
      } catch (_) {}
      _siteVisitQueueOwnerId = null;
      chrome.action.setBadgeText({ text: '' });
      console.log('[background] User signed out — tracking paused');
      sendResponse({ signedOut: true });
    })();
    return true;
  }

  // Handle dashboard data request from popup
  if (message && message.type === 'getDashboardSummary') {
    getUserId().then(async (userId) => {
      if (!userId) {
        sendResponse({ token: null, dashboard: null, goals: null, requiresAuth: true });
        return;
      }
      try {
        const accessToken = await getGoogleAccessToken();
        const headers = accessToken
          ? { Authorization: `Bearer ${accessToken}` }
          : {};
        const [dashboardResp, goalsResp] = await Promise.all([
          fetch(`${SERVER_URL}/api/dashboard`, { headers }),
          fetch(`${SERVER_URL}/api/goals/status`, { headers }),
        ]);

        const dashboard = dashboardResp.ok ? await dashboardResp.json() : null;
        const goals = goalsResp.ok ? await goalsResp.json() : null;

        sendResponse({
          token: userId,
          // Never return the Google access token to a renderer (C2). The
          // popup opens the dashboard by asking for 'openDashboard', and
          // this worker performs the authenticated navigation itself.
          dashboard,
          goals: goals ? goals.goals : null,
        });
      } catch (err) {
        console.error('[background] Failed to fetch dashboard summary:', err);
        sendResponse({ token: userId, dashboard: null, goals: null });
      }
    });
    return true;
  }

  // Open the dashboard on behalf of an extension page (the popup).
  // The token is attached HERE and used by openDashboardWithToken to build the
  // navigation URL; it is never returned to the caller. This is the secure
  // replacement for handing a token back to a renderer (C2).
  if (message && message.type === 'openDashboard') {
    openDashboardWithToken().then(() => sendResponse({ opened: true }));
    return true;
  }

  // NOTE (C2): the former `getAccessToken` message handler was removed.
  // It existed only to serve the tracker.js content-script bridge, and it
  // returned the raw Google OAuth access token. Because tracker.js runs on
  // every http(s) page, any website could message the extension and receive
  // that token. No caller remains: dashboard navigation is handled entirely
  // inside this worker by openDashboardWithToken(), which never discloses the
  // token to page content. Do not reintroduce a handler that returns a
  // credential to a content script.

  // ── Namespaced typed messages (routed by type, never by domain) ────────
  // The screen-time forwarder below dispatches on the mere presence of
  // `domain`, so without this guard a domain-bearing feature message (e.g. a
  // site visit) would be swallowed by it and could even be POSTed to
  // /api/screen-time. Every lisTrack: message is therefore claimed here by
  // its exact type; unknown namespaced types are dropped explicitly instead
  // of falling through.
  if (
    message &&
    typeof message.type === "string" &&
    message.type.startsWith(TYPE_NAMESPACE)
  ) {
    if (message.type === VISIT_MESSAGE_TYPE) {
      handleSiteVisitMessage(message).then(
        (result) => {
          try {
            sendResponse(result);
          } catch (_) {}
        },
        (err) => {
          console.error("[DEBUG handleSiteVisitMessage ERROR]", err);
          try {
            sendResponse({ received: false });
          } catch (_) {}
        },
      );
      return true; // Keep the worker alive until sendResponse resolves
    }

    console.warn(
      "[background] Ignoring unknown namespaced message type:",
      message.type,
    );
    return;
  }

  if (!message || !message.domain) return;

  // Block tracking for excluded domains
  if (isBlockedDomain(message.domain)) {
    console.log('[background] Ignoring excluded domain:', message.domain);
    return;
  }

  console.log('[background] Forwarding tracking data for domain:', message.domain);

  // Mandatory sign-in gate: only forward screen-time when the user has a
  // Google user_id in chrome.storage.sync. Without it, drop the payload.
  getUserId()
    .then(async (userId) => {
      if (!userId) {
        console.log('[background] Ignoring tracking payload — user not signed in');
        sendResponse({ received: false, requiresAuth: true });
        return;
      }
      // Forward the payload as-is. No identity field is attached: the server
      // attributes the data to the account behind the verified bearer token
      // in the Authorization header.
      const payload = { ...message };
      let response;
      try {
        response = await fetch(`${SERVER_URL}/api/screen-time`, {
          method: 'POST',
          headers: await authedFetchHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(payload),
        });
      } catch (err) {
        // Network failure — buffer durably so the offline-queue drain
        // (which attaches a fresh Authorization header) retries it. This is
        // the safety net for page-unload fire-and-forget sends where the
        // content script is already gone and cannot queue itself.
        console.error('[background] Failed to connect to server:', err);
        try { await pushToOfflineQueue(payload); } catch (_) {}
        sendResponse({ received: false, error: err.message });
        return;
      }
      if (response.ok) {
        // The ping response may carry server config (e.g. badgeMaxHours,
        // flushIntervalSeconds) — apply it so threshold changes reach
        // installed extensions on the next ping without a manual reinstall.
        try {
          const pingData = await response.json();
          await applyBadgeConfig(pingData);
          await applyFlushConfig(pingData);
        } catch (_) {}
        console.log('[background] Tracking data sent:', message.domain, response.status);
        sendResponse({ received: true, status: response.status });
      } else {
        console.warn('[background] Server returned non-OK status:', response.status);
        // Buffer for retry — the drain drops permanent 4xx client errors.
        try { await pushToOfflineQueue(payload); } catch (_) {}
        // received mirrors the server result so the content script knows
        // whether to keep/queue the payload on failure.
        sendResponse({ received: false, status: response.status });
      }
    })
    .catch((err) => {
      // Async safety net (e.g. chrome.storage read failures)
      console.error('[background] Tracking forward error:', err);
      sendResponse({ received: false, error: err.message });
    });

  return true; // Keep service worker alive until sendResponse is called
});

// ─── Daily Site-Limit Blocker (isolated feature) ───────────────────────────
// This entire section is a SEPARATE, self-contained feature. It loads the
// dedicated blocker module (public/js/blocker.js) and only ADDS listeners —
// every existing event handler above is left completely untouched.
//
// importScripts is synchronous and safe here: this top-level code runs during
// the service worker's initial synchronous execution. The path is relative to
// this file (public/js/), so "blocker.js" resolves to public/js/blocker.js.

importScripts("blocker.js");

/** True when a tab URL belongs to the given (normalized) domain. */
function blockerTabMatches(tabUrl, domain) {
  try {
    const host = new URL(tabUrl).hostname.replace(/^www\./, "").toLowerCase();
    return host === domain || host.endsWith("." + domain);
  } catch (_) {
    return false;
  }
}

/** Redirect every active tab on the domain to the block screen. */
async function blockerRedirectTabsTo(domain) {
  const blockedUrl =
    chrome.runtime.getURL("public/blocked.html?domain=" + encodeURIComponent(domain));
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab || !tab.url) continue;
      // Never redirect extension pages (incl. the block screen itself).
      if (tab.url.startsWith(chrome.runtime.getURL(""))) continue;
      if (blockerTabMatches(tab.url, domain)) {
        chrome.tabs.update(tab.id, { url: blockedUrl });
      }
    }
  } catch (_) {}
}

// 1) Ping hook: every screen-time ping (domain + durationSeconds) also flows
//    to this listener. It accumulates the domain's daily usage and, once the
//    total reaches the limit, redirects open tabs to the block screen. It
//    never calls sendResponse, so the existing forward handler is unaffected.
chrome.runtime.onMessage.addListener((message) => {
  if (!message || !message.domain) return;
  if (typeof message.durationSeconds !== "number") return;
  if (isBlockedDomain(message.domain)) return;

  void (async () => {
    try {
      await LisTrackBlocker.addUsage(message.domain, message.durationSeconds);
      // While pings flow, opportunistically pull down the user's server daily
      // goals (throttled) so dashboard-created goals start blocking locally.
      maybeSyncServerGoals();
      if (await LisTrackBlocker.isBlockedToday(message.domain)) {
        await blockerRedirectTabsTo(message.domain);
      }
    } catch (_) {}
  })();
});

// 2) Navigation hook: instantly block NEW attempts to navigate to a domain
//    whose daily usage already exceeds its limit (during the same day).
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  // Top-frame navigations only.
  if (details.frameId !== 0) return;

  let domain;
  try {
    domain = new URL(details.url).hostname.replace(/^www\./, "").toLowerCase();
  } catch (_) {
    return;
  }
  if (!domain || isBlockedDomain(domain)) return;

  void (async () => {
    try {
      if (await LisTrackBlocker.isBlockedToday(domain)) {
        chrome.tabs.update(details.tabId, {
          url: chrome.runtime.getURL("public/blocked.html?domain=" + encodeURIComponent(domain)),
        });
      }
    } catch (_) {}
  })();
});

// ─── Server Goal ↔ Local Limit Sync (connects dashboard Daily Goals) ───────
// The web dashboard stores Daily Goals in the server DB. This section pulls
// those goals down and mirrors the enabled ones into the local blocker limits
// (lisTrack_domain_limits), so dashboard goals enforce the same block screen
// as popup-set limits. It is fully additive — no existing handler is touched.
//
// Sync cadence:
//   - throttled trigger on each tracking ping (see maybeSyncServerGoals)
//   - a dedicated 5-minute alarm
//   - on service-worker startup / extension install
//
// Enforcement:
//   - every synced goal becomes a local limit → the existing ping & navigation
//     hooks block at the limit via local usage
//   - server-reported `exceeded` flags also redirect open tabs immediately

const SERVER_GOALS_SYNC_INTERVAL_MS = 5 * 60 * 1000;
let _lastServerGoalsSyncAt = 0;

/**
 * Pull the user's daily goals from the server, mirror enabled ones into the
 * local blocker limits, and redirect any open tabs on exceeded domains.
 * Throttled to once per SERVER_GOALS_SYNC_INTERVAL_MS.
 */
async function syncServerGoalsToLimits() {
  const userId = await getUserId();
  if (!userId) return;

  const now = Date.now();
  if (now - _lastServerGoalsSyncAt < SERVER_GOALS_SYNC_INTERVAL_MS) return;
  _lastServerGoalsSyncAt = now;

  try {
    const headers = await authedFetchHeaders();
    const [goalsResp, statusResp] = await Promise.all([
      fetch(`${SERVER_URL}/api/goals`, { headers }),
      fetch(`${SERVER_URL}/api/goals/status`, { headers }),
    ]);

    // 1) Mirror enabled server goals into local blocker limits.
    const enabledGoals = [];
    if (goalsResp.ok) {
      const data = await goalsResp.json();
      for (const goal of data.goals || []) {
        if (!goal || !goal.enabled) continue;
        if (isBlockedDomain(goal.domain)) continue;
        enabledGoals.push({ domain: goal.domain, maxMinutes: goal.max_minutes });
      }
      await LisTrackBlocker.syncServerLimits(enabledGoals);

      // Fast path: a synced goal may already be exceeded by LOCAL usage —
      // redirect matching tabs right away.
      for (const goal of enabledGoals) {
        if (await LisTrackBlocker.isBlockedToday(goal.domain)) {
          await blockerRedirectTabsTo(goal.domain);
        }
      }
    }

    // 2) Server-reported exceeded flags (authoritative daily totals) —
    //    redirect matching tabs so blocking also works when the extension
    //    missed pings (e.g. browser was closed earlier in the day).
    if (statusResp.ok) {
      const statusData = await statusResp.json();
      for (const s of statusData.goals || []) {
        if (!s || !s.exceeded) continue;
        if (isBlockedDomain(s.domain)) continue;
        await blockerRedirectTabsTo(s.domain);
      }
    }
  } catch (_) {
    // Reset so the next ping/alarm retries the sync.
    _lastServerGoalsSyncAt = 0;
  }
}

/** Fire-and-forget throttled sync trigger (safe to call on every ping). */
function maybeSyncServerGoals() {
  if (Date.now() - _lastServerGoalsSyncAt >= SERVER_GOALS_SYNC_INTERVAL_MS) {
    void syncServerGoalsToLimits();
  }
}

// Dedicated alarm — runs alongside the existing alarms (all listeners receive
// every alarm event; this one only reacts to its own name).
chrome.alarms.create('syncServerLimits', {
  delayInMinutes: 1,
  periodInMinutes: 5,
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'syncServerLimits') {
    void syncServerGoalsToLimits();
  }
});

// Sync shortly after the service worker wakes and after install/update, so
// limits exist before the first alarm fires. (Additive listeners.)
chrome.runtime.onStartup.addListener(() => {
  _lastServerGoalsSyncAt = 0;
  void syncServerGoalsToLimits();
});

chrome.runtime.onInstalled.addListener(() => {
  _lastServerGoalsSyncAt = 0;
  void syncServerGoalsToLimits();
});

// Popup "Remove" for a dashboard-synced limit — deletes the matching server
// goal (with the OAuth token attached) so the next sync does not re-add it.
// Pure addition: the existing message handler above is left untouched.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "deleteServerGoal" || !message.domain) return;

  (async () => {
    try {
      const userId = await getUserId();
      if (!userId) {
        sendResponse({ deleted: false });
        return;
      }
      const headers = await authedFetchHeaders();
      const listResp = await fetch(
        `${SERVER_URL}/api/goals`,
        { headers }
      );
      if (!listResp.ok) {
        sendResponse({ deleted: false });
        return;
      }
      const data = await listResp.json();
      const normalized = LisTrackBlocker.normalizeDomain(message.domain);
      const goal = (data.goals || []).find(
        (g) => g && LisTrackBlocker.normalizeDomain(g.domain) === normalized
      );
      if (!goal) {
        sendResponse({ deleted: false });
        return;
      }
      const delResp = await fetch(
        `${SERVER_URL}/api/goals/${goal.id}`,
        { method: "DELETE", headers }
      );
      sendResponse({ deleted: delResp.ok });
    } catch (_) {
      sendResponse({ deleted: false });
    }
  })();

  return true; // Keep the service worker alive until sendResponse resolves
});
