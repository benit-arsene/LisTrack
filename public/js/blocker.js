/**
 * LisTrack Daily Site-Limit Blocker (isolated module)
 * ---------------------------------------------------
 * Self-contained module that stores per-domain daily time limits and
 * tracks today's accumulated usage for each domain. It is loaded as a
 * classic script by the popup (public/js/popup-blocker.js) and via
 * importScripts() by the background service worker (see the appended
 * section at the end of background.js).
 *
 * Storage (chrome.storage.local, dedicated keys — no existing keys touched):
 *   lisTrack_domain_limits → { [domain]: { limitSeconds, setAt, source? } }
 *   lisTrack_domain_usage  → { [domain]: { day: 'YYYY-MM-DD', seconds } }
 *
 * Exposed API (window.LisTrackBlocker / globalThis.LisTrackBlocker):
 *   setDomainLimit(domain, limitInSeconds, opts?)  → opts stored on the entry
 *   removeDomainLimit(domain)
 *   getDomainLimit(domain)          → { limitSeconds, setAt, source? } | null
 *   addUsage(domain, seconds)       → accumulate today's seconds
 *   getDailyUsage(domain)           → seconds used today (resets at midnight)
 *   checkIfExceeded(domain, totalSeconds) → totalSeconds >= limit ?
 *   isBlockedToday(domain)          → today's usage >= limit ?
 *   syncServerLimits(enabledGoals)  → reconcile server-synced limits
 *     enabledGoals: [{ domain, maxMinutes }]. Entries previously written with
 *     opts.source === 'server' are dropped first (covers disabled/deleted
 *     dashboard goals), then every enabled goal is (re)written as a
 *     source-tagged limit. Popup-set limits (no source) are never touched.
 */
(function () {
  "use strict";

  const LIMITS_KEY = "lisTrack_domain_limits";
  const USAGE_KEY = "lisTrack_domain_usage";

  /** Normalize a hostname: lowercase, strip leading "www.". */
  function normalizeDomain(domain) {
    if (!domain) return "";
    return String(domain).trim().toLowerCase().replace(/^www\./, "");
  }

  /** Local-timezone day key, e.g. "2026-08-04". */
  function getDayKey(date) {
    const d = date || new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  async function readAll(key) {
    try {
      const result = await chrome.storage.local.get([key]);
      return result[key] || {};
    } catch (_) {
      return {};
    }
  }

  async function writeAll(key, obj) {
    try {
      await chrome.storage.local.set({ [key]: obj });
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Set (or update) the daily time limit for a domain, in seconds.
   * Extra opts (e.g. { source: 'server' }) are stored verbatim on the entry.
   * Returns true on success.
   */
  async function setDomainLimit(domain, limitInSeconds, opts = {}) {
    const normalized = normalizeDomain(domain);
    if (!normalized || !(limitInSeconds > 0)) return false;
    const limits = await readAll(LIMITS_KEY);
    limits[normalized] = {
      limitSeconds: Math.round(limitInSeconds),
      setAt: Date.now(),
      ...opts,
    };
    return writeAll(LIMITS_KEY, limits);
  }

  /**
   * Reconcile limits with the server's enabled daily goals.
   *
   * - Every entry tagged `source: 'server'` is dropped first, so goals that
   *   were disabled or deleted on the dashboard stop blocking immediately.
   * - Each enabled goal is then (re)written as a server-tagged limit.
   * - Popup-set limits (entries without a source) are left untouched.
   *
   * @param {Array<{domain: string, maxMinutes: number}>} enabledGoals
   * @returns {Promise<boolean>} true when the write succeeded
   */
  async function syncServerLimits(enabledGoals) {
    const limits = await readAll(LIMITS_KEY);
    // Drop previously server-synced entries (disabled/deleted dashboard goals).
    for (const key of Object.keys(limits)) {
      if (limits[key] && limits[key].source === 'server') delete limits[key];
    }
    const list = Array.isArray(enabledGoals) ? enabledGoals : [];
    for (const goal of list) {
      const normalized = normalizeDomain(goal && goal.domain);
      if (!normalized) continue;
      const maxMinutes = Number(goal.maxMinutes);
      if (!(maxMinutes > 0)) continue;
      limits[normalized] = {
        limitSeconds: Math.round(maxMinutes * 60),
        setAt: Date.now(),
        source: 'server',
      };
    }
    return writeAll(LIMITS_KEY, limits);
  }

  /** Remove the limit for a domain. Returns true if one existed. */
  async function removeDomainLimit(domain) {
    const normalized = normalizeDomain(domain);
    if (!normalized) return false;
    const limits = await readAll(LIMITS_KEY);
    if (!(normalized in limits)) return false;
    delete limits[normalized];
    await writeAll(LIMITS_KEY, limits);
    return true;
  }

  /** Get the limit for a domain, or null when none is set. */
  async function getDomainLimit(domain) {
    const normalized = normalizeDomain(domain);
    if (!normalized) return null;
    const limits = await readAll(LIMITS_KEY);
    return limits[normalized] || null;
  }

  /** Accumulate `seconds` of usage for a domain under today's day key. */
  async function addUsage(domain, seconds) {
    const normalized = normalizeDomain(domain);
    if (!normalized || !(seconds > 0)) return false;
    const usage = await readAll(USAGE_KEY);
    const today = getDayKey();
    const entry = usage[normalized];
    if (entry && entry.day === today) {
      entry.seconds += seconds;
    } else {
      usage[normalized] = { day: today, seconds: seconds };
    }
    return writeAll(USAGE_KEY, usage);
  }

  /** Seconds used on a domain today (0 when none / day rolled over). */
  async function getDailyUsage(domain) {
    const normalized = normalizeDomain(domain);
    if (!normalized) return 0;
    const usage = await readAll(USAGE_KEY);
    const entry = usage[normalized];
    if (!entry || entry.day !== getDayKey()) return 0;
    return entry.seconds || 0;
  }

  /**
   * Pure limit check: does `totalSeconds` meet or exceed the domain's
   * configured daily limit? Returns false when no limit is set.
   */
  async function checkIfExceeded(domain, totalSeconds) {
    const normalized = normalizeDomain(domain);
    if (!normalized) return false;
    const limit = await getDomainLimit(normalized);
    if (!limit || !(limit.limitSeconds > 0)) return false;
    return totalSeconds >= limit.limitSeconds;
  }

  /** Convenience: is today's accumulated usage past the limit? */
  async function isBlockedToday(domain) {
    const normalized = normalizeDomain(domain);
    if (!normalized) return false;
    const usage = await getDailyUsage(normalized);
    return checkIfExceeded(normalized, usage);
  }

  const api = {
    LIMITS_KEY,
    USAGE_KEY,
    normalizeDomain,
    getDayKey,
    setDomainLimit,
    removeDomainLimit,
    getDomainLimit,
    addUsage,
    getDailyUsage,
    checkIfExceeded,
    isBlockedToday,
    syncServerLimits,
  };

  // Expose globally — works as a classic script (popup) and via
  // importScripts (background service worker).
  if (typeof globalThis !== "undefined") globalThis.LisTrackBlocker = api;
  if (typeof window !== "undefined") window.LisTrackBlocker = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
