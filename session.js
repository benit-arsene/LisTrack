/**
 * LisTrack Session Store
 * ======================
 * Server-side session records for the dashboard's HTTP-only session cookie.
 *
 * SECURITY MODEL
 * --------------
 * A session id is 64 hex characters of `crypto.randomBytes(32)` output — 256
 * bits from the platform CSPRNG, never `Math.random()`. The id is the ONLY
 * value placed in the cookie; the user's email address is never transmitted
 * to the client as proof of identity. Possession of a valid, unexpired id is
 * the proof, and it is only ever issued after a Google OAuth access token has
 * been verified server-side.
 *
 * Because the id is compared by exact string lookup against a Map, a forged
 * cookie such as `lisTrackSession=victim@example.com` matches no record and is
 * rejected. There is no code path where an email-shaped string becomes an
 * authenticated identity.
 *
 * STORAGE — IN-MEMORY, AND THE LIMITATION THAT IMPLIES
 * ----------------------------------------------------
 * Sessions are held in a process-local `Map`. This is the simplest mechanism
 * compatible with the existing architecture (the verified-token cache is
 * already an in-process `Map`), and it keeps the code small enough to audit in
 * one sitting.
 *
 * The trade-off, stated plainly: **sessions do not survive a server restart.**
 * On Render, a deploy, a crash, or a scale-out will drop every live session and
 * affected users must re-authenticate by opening the dashboard from the
 * extension (which performs a fresh Google token exchange and mints a new
 * session). This is a fail-closed outcome — users are logged out, never logged
 * in as someone else — but it is a real usability cost and should be revisited
 * if the service is ever run on more than one instance, at which point
 * round-robin routing would send users to instances that have never seen their
 * session id and reject valid logins intermittently.
 *
 * Migrating to a database-backed store means adding a `sessions` table and
 * swapping `createSession` / `getSession` / `deleteSession` for queries; the
 * rest of the authentication flow is unaffected. That was left out of this
 * change to keep the remediation scoped to the C1/H4 fix.
 *
 * RECORD SHAPE
 * ------------
 *   session_id  — the random id (Map key; the cookie value)
 *   user        — verified Google email, lowercased
 *   created_at  — epoch ms
 *   expires_at  — epoch ms
 *
 * No OAuth token and no other credential is ever stored here.
 */

const crypto = require("crypto");

/** Session lifetime. Google access tokens live ~1h; the session outlives them. */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

/** Bytes of CSPRNG entropy per session id (32 bytes → 64 hex chars → 256 bits). */
const SESSION_ID_BYTES = 32;

/**
 * Cap on live sessions, to bound memory if ids are minted faster than they
 * expire. When exceeded the oldest entries are evicted first. Eviction logs
 * users out; it never authenticates anyone.
 */
const MAX_SESSIONS = 10_000;

/** sessionId → { user, createdAt, expiresAt } */
const sessions = new Map();

/**
 * Generate a session id from the platform CSPRNG.
 * @returns {string} 64 lowercase hex characters
 */
function generateSessionId() {
  return crypto.randomBytes(SESSION_ID_BYTES).toString("hex");
}

/**
 * Create and store a session for a verified identity.
 *
 * @param {string} user Verified Google email (already lowercased by the caller).
 * @returns {{ id: string, user: string, createdAt: number, expiresAt: number }}
 */
function createSession(user) {
  if (typeof user !== "string" || !user.trim()) {
    throw new Error("createSession requires a verified user identity");
  }

  const now = Date.now();
  const record = {
    user: user.trim().toLowerCase(),
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };

  const id = generateSessionId();
  evictIfNeeded();
  sessions.set(id, record);

  // Return the id alongside the record. Callers must treat `id` as secret —
  // it is the bearer credential held in the cookie.
  return { id, ...record };
}

/**
 * Look up a session id and return its record if it is still valid.
 *
 * Unknown ids and expired ids are both indistinguishable from the caller's
 * perspective: they return `null`. Expired records are deleted on access so
 * the Map does not accumulate dead entries.
 *
 * @param {string} sessionId
 * @returns {{ user: string, createdAt: number, expiresAt: number } | null}
 */
function getSession(sessionId) {
  if (typeof sessionId !== "string" || !sessionId) return null;

  const record = sessions.get(sessionId);
  if (!record) return null;

  if (record.expiresAt <= Date.now()) {
    sessions.delete(sessionId);
    return null;
  }

  return record;
}

/**
 * Invalidate a single session (used on sign-out).
 * @param {string} sessionId
 * @returns {boolean} true if a session was removed
 */
function deleteSession(sessionId) {
  if (typeof sessionId !== "string" || !sessionId) return false;
  return sessions.delete(sessionId);
}

/**
 * Remove every session belonging to a user. Used when an identity must be
 * logged out everywhere.
 * @param {string} user
 * @returns {number} count of removed sessions
 */
function deleteSessionsForUser(user) {
  if (typeof user !== "string" || !user) return 0;
  const target = user.trim().toLowerCase();
  let removed = 0;
  for (const [id, record] of sessions) {
    if (record.user === target) {
      sessions.delete(id);
      removed++;
    }
  }
  return removed;
}

/**
 * Drop expired sessions. Called opportunistically on create; exposed for tests
 * and for a future scheduled sweep.
 * @returns {number} count of removed sessions
 */
function pruneExpired() {
  const now = Date.now();
  let removed = 0;
  for (const [id, record] of sessions) {
    if (record.expiresAt <= now) {
      sessions.delete(id);
      removed++;
    }
  }
  return removed;
}

/**
 * Keep the Map bounded. Expired entries go first; if that is not enough, the
 * oldest live entries are evicted (Map preserves insertion order).
 */
function evictIfNeeded() {
  if (sessions.size < MAX_SESSIONS) return;
  pruneExpired();
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.keys().next();
    if (oldest.done) break;
    sessions.delete(oldest.value);
  }
}

/** Current number of live sessions. Exposed for tests and diagnostics. */
function sessionCount() {
  return sessions.size;
}

module.exports = {
  SESSION_TTL_MS,
  SESSION_ID_BYTES,
  MAX_SESSIONS,
  createSession,
  getSession,
  deleteSession,
  deleteSessionsForUser,
  pruneExpired,
  sessionCount,
};