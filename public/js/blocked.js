/**
 * LisTrack Block Screen logic (isolated page script).
 * Reads the ?domain= query, shows the domain + today's usage, and wires
 * the "Take me back" / "Unblock for today" actions.
 */
(function () {
  "use strict";

  function getDomainFromQuery() {
    try {
      return new URLSearchParams(window.location.search).get("domain") || "";
    } catch (_) {
      return "";
    }
  }

  function formatTime(totalSeconds) {
    if (!totalSeconds || totalSeconds <= 0) return "0m";
    const totalMinutes = totalSeconds / 60;
    if (totalMinutes < 1) return "<1m";
    const hours = Math.floor(totalMinutes / 60);
    const mins = Math.round(totalMinutes % 60);
    if (hours > 0 && mins >= 60) return `${hours + 1}h`;
    if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
    return `${mins}m`;
  }

  const domain = getDomainFromQuery();
  const domainEl = document.getElementById("siteDomain");
  const faviconEl = document.getElementById("siteFavicon");
  const timeEl = document.getElementById("timeSpent");
  const goBackBtn = document.getElementById("goBackBtn");
  const unblockBtn = document.getElementById("unblockBtn");

  if (domain) {
    domainEl.textContent = domain;
    domainEl.title = domain;
    faviconEl.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
  }

  // Show today's accumulated usage for this domain (from the local module).
  if (typeof LisTrackBlocker !== "undefined") {
    LisTrackBlocker.getDailyUsage(domain).then((seconds) => {
      timeEl.textContent = formatTime(seconds);
    }).catch(() => {});
  }

  goBackBtn.addEventListener("click", () => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.close();
    }
  });

  // "Unblock for today" — clear today's usage record so navigation to the
  // domain is allowed again. The webNavigation listener re-checks live.
  unblockBtn.addEventListener("click", async () => {
    try {
      const usageKey = LisTrackBlocker.USAGE_KEY;
      const result = await chrome.storage.local.get([usageKey]);
      const usage = result[usageKey] || {};
      // Usage keys are normalized (lowercase, www. stripped) — delete the
      // matching key so hand-typed URLs (?domain=WWW.Example.com) also work.
      delete usage[LisTrackBlocker.normalizeDomain(domain)];
      await chrome.storage.local.set({ [usageKey]: usage });
    } catch (_) {}

    if (window.history.length > 1) {
      window.history.back();
    } else {
      // No usable history — send the user to the site they were blocked from.
      window.location.href = `https://${domain}`;
    }
  });
})();
