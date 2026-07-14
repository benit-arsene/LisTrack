/**
 * LisTrack Rich Popup
 * Shows today's screen time stats, top domains, goals status,
 * and provides pause/resume control directly from the extension popup.
 */
(async function () {
  "use strict";

  const app = document.getElementById("app");

  // ─── Helpers ────────────────────────────────────────────────────────────

  function formatTime(totalMinutes) {
    if (totalMinutes == null || totalMinutes <= 0) return "0m";
    if (totalMinutes < 1) return "<1m";
    const hours = Math.floor(totalMinutes / 60);
    const mins = Math.round(totalMinutes % 60);
    if (hours > 0 && mins >= 60) return `${hours + 1}h`;
    if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
    return `${mins}m`;
  }

  function getFaviconUrl(domain) {
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
  }

  function getDisplayName(domain) {
    if (!domain) return "";
    const parts = domain.split(".");
    const mainName = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    return mainName.charAt(0).toUpperCase() + mainName.slice(1);
  }

  // ─── Render Error ──────────────────────────────────────────────────────

  function showError(message) {
    app.innerHTML = `
      <div class="error">
        <p>${message}</p>
        <button class="error-retry" id="retryBtn">Try Again</button>
      </div>
    `;
    document.getElementById("retryBtn")?.addEventListener("click", () => {
      window.location.reload();
    });
  }

  // ─── Render Popup ──────────────────────────────────────────────────────

  function renderPopup(data, isPaused) {
    const dashboard = data.dashboard;
    const goals = data.goals || [];
    const token = data.token || "";
    const dashboardUrl = `https://listrack-2.onrender.com/dashboard?user=${encodeURIComponent(token)}`;

    const totalMinutes = dashboard ? dashboard.totalMinutes || 0 : 0;
    const domains = dashboard ? dashboard.domains || [] : [];
    const topDomains = domains.slice(0, 3);
    const totalDomains = dashboard ? dashboard.totalDomains || 0 : 0;
    const topDomain = dashboard ? dashboard.topDomain : null;

    // Goal stats
    const totalGoals = goals.length;
    const exceededGoals = goals.filter((g) => g.exceeded).length;
    const approachingGoals = goals.filter((g) => g.approaching && !g.exceeded).length;
    const okGoals = goals.filter((g) => g.enabled && !g.exceeded && !g.approaching).length;

    // Determine paused state
    const paused = isPaused;

    // Generate goal item HTML
    function getGoalItemHtml(goal) {
      const dotClass = !goal.enabled ? "disabled" : goal.exceeded ? "exceeded" : goal.approaching ? "approaching" : "ok";
      const statusClass = goal.exceeded ? "exceeded" : goal.approaching ? "approaching" : "";
      const statusText = goal.exceeded
        ? "Exceeded"
        : goal.approaching
          ? `${goal.percentage}%`
          : goal.enabled
            ? `${goal.todayMinutes.toFixed(0)}/${goal.maxMinutes}m`
            : "Off";
      return `
        <div class="goal-item">
          <span class="goal-dot ${dotClass}"></span>
          <span class="goal-name">${getDisplayName(goal.domain)}</span>
          <span class="goal-status ${statusClass}">${statusText}</span>
        </div>
      `;
    }

    // Generate site row HTML
    function getSiteRowHtml(item, index) {
      return `
        <div class="site-row">
          <span class="site-rank">${index + 1}</span>
          <img class="site-favicon" src="${getFaviconUrl(item.domain)}" alt="" onerror="this.style.display='none'" />
          <span class="site-name">${getDisplayName(item.domain)}</span>
          <span class="site-time">${formatTime(item.totalMinutes)}</span>
        </div>
      `;
    }

    const topSitesHtml =
      topDomains.length > 0
        ? topDomains.map((item, i) => getSiteRowHtml(item, i)).join("")
        : '<div class="site-empty">No data yet — start browsing!</div>';

    const goalsHtml =
      totalGoals > 0
        ? goals
            .slice(0, 4)
            .map((g) => getGoalItemHtml(g))
            .join("")
        : '<div class="goals-empty">No goals set</div>';

    const goalCountText =
      totalGoals > 0
        ? `${okGoals}/${totalGoals} within limit`
        : "";

    app.innerHTML = `
      <!-- Header -->
      <div class="header">
        <div class="header-left">
          <div class="header-logo">L</div>
          <span class="header-title">LisTrack</span>
          <span class="live-dot ${paused ? "paused" : ""}" id="liveDot" title="${paused ? "Paused" : "Tracking"}"></span>
        </div>
        <div class="header-right">
          <button class="header-btn" id="refreshBtn" title="Refresh">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </div>

      <!-- Today's Time -->
      <div class="time-section">
        <div class="time-label">Screen Time Today</div>
        <div class="time-value ${paused ? "paused-text" : ""}" id="timeValue">${paused ? "Paused" : formatTime(totalMinutes)}</div>
        <div class="time-sub">${paused ? "Tracking is paused" : totalDomains > 0 ? `Across ${totalDomains} site${totalDomains !== 1 ? "s" : ""}` : "No activity recorded"}</div>
      </div>

      <!-- Stats Row -->
      <div class="stats-row">
        <div class="stat-item">
          <div class="stat-value">${totalDomains}</div>
          <div class="stat-label">Sites</div>
        </div>
        <div class="stat-item">
          <div class="stat-value">${topDomain ? getDisplayName(topDomain).substring(0, 6) : "—"}</div>
          <div class="stat-label">Top Site</div>
        </div>
        <div class="stat-item">
          <div class="stat-value">${totalGoals}</div>
          <div class="stat-label">Goals</div>
        </div>
      </div>

      <!-- Top Sites -->
      <div class="section-title">Top Sites Today</div>
      <div class="site-list" id="siteList">
        ${topSitesHtml}
      </div>

      <!-- Goals -->
      <div class="goals-summary">
        <div class="goals-header">
          <span class="goals-title">Daily Goals</span>
          <span class="goals-count">${goalCountText}</span>
        </div>
        <div class="goals-grid">
          ${goalsHtml}
        </div>
      </div>

      <!-- Pause Banner -->
      <div class="pause-banner ${paused ? "visible" : ""}" id="pauseBanner">
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
        </svg>
        <span>Tracking is paused. No data is being collected.</span>
      </div>

      <!-- Actions -->
      <div class="actions">
        <a href="${dashboardUrl}" target="_blank" class="btn-primary">
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
          </svg>
          Open Dashboard
        </a>
        <button class="btn-secondary ${paused ? "" : "danger"}" id="pauseBtn">
          ${paused
            ? `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z" /></svg> Resume Tracking`
            : `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25v13.5m-7.5-13.5v13.5" /></svg> Pause Tracking`
          }
        </button>
      </div>

      <!-- Token -->
      <div class="token-bar">
        <span class="token-text" id="tokenText" title="Your user token">${token.substring(0, 16)}…</span>
        <button class="token-copy" id="copyBtn">${navigator.clipboard ? "Copy" : ""}</button>
      </div>

      <!-- Footer -->
      <div class="footer">LisTrack v1.0</div>
    `;

    // ─── Bind Events ────────────────────────────────────────────────────

    // Pause/Resume toggle
    document.getElementById("pauseBtn").addEventListener("click", () => {
      const newPaused = !paused;
      chrome.runtime.sendMessage(
        { type: "setTrackingState", paused: newPaused },
        (response) => {
          if (response && response.paused !== undefined) {
            // Re-render with new state
            renderPopup(data, response.paused);
          }
        }
      );
    });

    // Copy token
    document.getElementById("copyBtn").addEventListener("click", () => {
      if (!navigator.clipboard) return;
      navigator.clipboard.writeText(token).then(() => {
        const btn = document.getElementById("copyBtn");
        btn.textContent = "✅";
        setTimeout(() => { btn.textContent = "Copy"; }, 2000);
      });
    });

    // Refresh
    document.getElementById("refreshBtn").addEventListener("click", () => {
      window.location.reload();
    });
  }

  // ─── Main ──────────────────────────────────────────────────────────────

  try {
    // Get token + tracking state + dashboard data in one go
    const [tokenResult, stateResult] = await Promise.all([
      // Get data from background
      new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { type: "getDashboardSummary" },
          (response) => {
            if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
            else resolve(response);
          }
        );
      }),
      // Get pause state
      new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { type: "getTrackingState" },
          (response) => {
            if (chrome.runtime.lastError) resolve({ paused: false });
            else resolve(response || { paused: false });
          }
        );
      }),
    ]);

    if (!tokenResult || !tokenResult.token) {
      showError("Could not retrieve your user token. Try reinstalling the extension.");
      return;
    }

    renderPopup(tokenResult, stateResult ? stateResult.paused : false);
  } catch (err) {
    // Fallback: try chrome.storage directly
    try {
      const result = await chrome.storage.local.get(["lisTrackTrackerToken", "lisTrackPaused"]);
      const token = result.lisTrackTrackerToken;
      const paused = !!result.lisTrackPaused;

      if (!token) {
        showError("Could not retrieve your user token. Try reinstalling the extension.");
        return;
      }

      // Fetch dashboard data directly from server
      const resp = await fetch(
        `https://listrack-2.onrender.com/api/dashboard?user=${encodeURIComponent(token)}`
      );

      const goalsResp = await fetch(
        `https://listrack-2.onrender.com/api/goals/status?user=${encodeURIComponent(token)}`
      );

      const dashboard = resp.ok ? await resp.json() : null;
      const goalsData = goalsResp.ok ? await goalsResp.json() : null;

      renderPopup({ dashboard, goals: goalsData ? goalsData.goals : null, token }, paused);
    } catch (fallbackErr) {
      showError("Could not connect to the server. Make sure the server is running.");
    }
  }
})();
