/**
 * LisTrack Popup — Daily Limit card (isolated module).
 * ---------------------------------------------------
 * Injects a small "Daily Limit" section into the rendered popup so the user
 * can define a daily screen-time limit for the current tab's domain. It is
 * fully self-contained: it does not modify any of the existing popup.js
 * rendering logic — it only reads the finished DOM and appends a card.
 *
 * Requires the blocker module (public/js/blocker.js) loaded first.
 */
(function () {
  "use strict";

  const app = document.getElementById("app");
  if (!app || typeof LisTrackBlocker === "undefined") return;

  const MINUTES = { min: 1, max: 1440 }; // 1 min .. 24 h

  function getDisplayName(domain) {
    if (!domain) return "";
    const parts = domain.split(".");
    const mainName = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    return mainName.charAt(0).toUpperCase() + mainName.slice(1);
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

  /** Extract a trackable http(s) hostname from the active tab, or null. */
  async function getActiveTabDomain() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url) return null;
      const url = new URL(tab.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      return url.hostname.replace(/^www\./, "").toLowerCase();
    } catch (_) {
      return null;
    }
  }

  async function buildCard(domain) {
    const displayName = getDisplayName(domain);
    const limit = await LisTrackBlocker.getDomainLimit(domain);
    const usedSeconds = await LisTrackBlocker.getDailyUsage(domain);
    const limitMinutes = limit ? Math.round(limit.limitSeconds / 60) : 0;

    const card = document.createElement("div");
    card.className = "limit-card";
    card.innerHTML = `
      <div class="limit-header">
        <span class="limit-title">Daily Limit</span>
        <span class="limit-domain" title="${domain}">${displayName}</span>
      </div>
      <div class="limit-row">
        <input class="limit-input" type="number" min="${MINUTES.min}" max="${MINUTES.max}"
               placeholder="Minutes" value="${limitMinutes || ""}" inputmode="numeric" />
        <button class="limit-set" id="limitSetBtn">Set</button>
      </div>
      <div class="limit-status" id="limitStatus"></div>
    `;

    const input = card.querySelector(".limit-input");
    const setBtn = card.querySelector("#limitSetBtn");
    const status = card.querySelector("#limitStatus");

    function renderStatus() {
      if (limit) {
        const usedText = formatTime(usedSeconds);
        status.innerHTML =
          `Blocking <strong>${displayName}</strong> after <strong>${limitMinutes}m</strong> today. ` +
          `Used so far: <strong>${usedText}</strong>. ` +
          `<a href="#" class="limit-remove" id="limitRemoveBtn">Remove</a>`;
        card.querySelector("#limitRemoveBtn").addEventListener("click", (e) => {
          e.preventDefault();
          LisTrackBlocker.removeDomainLimit(domain).then(() => {
            status.textContent = "Limit removed for " + displayName + ".";
            input.value = "";
          });
        });
      } else {
        status.textContent = `No limit set for ${displayName}.`;
      }
    }

    setBtn.addEventListener("click", async () => {
      const minutes = parseInt(input.value, 10);
      if (!minutes || isNaN(minutes) || minutes < MINUTES.min) {
        status.textContent = "Enter a limit in minutes (min " + MINUTES.min + ").";
        return;
      }
      if (minutes > MINUTES.max) {
        status.textContent = "Limit is capped at " + MINUTES.max + " minutes (24 h).";
        return;
      }
      const ok = await LisTrackBlocker.setDomainLimit(domain, minutes * 60);
      if (ok) {
        status.innerHTML =
          `Limit set — <strong>${displayName}</strong> will be blocked after ` +
          `<strong>${minutes}m</strong> today. 🌿`;
        setBtn.disabled = true;
        setTimeout(() => { setBtn.disabled = false; }, 1200);
      } else {
        status.textContent = "Could not save the limit. Try again.";
      }
    });

    renderStatus();
    return card;
  }

  /** Wait for popup.js to finish rendering, then inject the card. */
  async function inject() {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      // Signed-in render contains .actions; the locked render contains .auth-lock.
      if (app.querySelector(".auth-lock")) return; // not signed in — skip
      const anchor = app.querySelector(".actions");
      if (anchor && app.querySelector(".time-section")) {
        const domain = await getActiveTabDomain();
        if (!domain) return; // not a trackable site (chrome://, etc.)
        const card = await buildCard(domain);
        anchor.parentNode.insertBefore(card, anchor);
        return;
      }
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  inject();
})();
