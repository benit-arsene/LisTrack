/**
 * LisTrack Rich Popup
 * Shows today's screen time stats, top domains, goals status,
 * and provides pause/resume control directly from the extension popup.
 *
 * Mandatory Google sign-in:
 *   - With user_id (email in chrome.storage.sync): full stats + email badge
 *     + Sign Out button.
 *   - Without user_id: the UI is locked with a "Login Required to Activate
 *     LisTrack" prompt and a Sign-In button.
 */
(async function () {
  "use strict";

  const app = document.getElementById("app");
  const ONBOARDING_URL = chrome.runtime.getURL("public/html/onboarding.html");

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

  // ─── Login Required (locked) State ──────────────────────────────────────

  function renderLoginRequired() {
    app.innerHTML = `
      <div class="auth-lock">
        <div class="auth-lock-icon">
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
          </svg>
        </div>
        <div class="auth-lock-title">Login Required to Activate LisTrack</div>
        <div class="auth-lock-sub">Sign in with your Google account to start tracking your screen time.</div>
        <button class="auth-signin" id="authSignInBtn">
          <svg class="g-logo" viewBox="0 0 48 48" width="16" height="16" aria-hidden="true">
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
          </svg>
          <span>Sign in with Google</span>
        </button>
      </div>
      <div class="footer">LisTrack v1.0</div>
    `;

    document.getElementById("authSignInBtn").addEventListener("click", () => {
      chrome.tabs.create({ url: ONBOARDING_URL });
    });
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

  function renderPopup(data, isPaused, email) {
    const dashboard = data.dashboard;
    const goals = data.goals || [];
    const token = data.token || "";
    const userEmail = email || "";
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

      <!-- User Email Badge -->
      <div class="user-badge">
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M17.982 18.725A7.488 7.488 0 0012 15.75a7.488 7.488 0 00-5.982 2.975m11.963 0a9 9 0 10-11.963 0m11.963 0A8.966 8.966 0 0112 21a8.966 8.966 0 01-5.982-2.275M15 9.75a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        <span class="user-badge-email" id="userEmail" title="Signed in as ${userEmail}">${userEmail}</span>
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
        <button class="btn-secondary signout" id="signOutBtn">
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
          </svg>
          Sign Out
        </button>
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
            renderPopup(data, response.paused, userEmail);
          }
        }
      );
    });

    // Sign out
    document.getElementById("signOutBtn").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "signOut" }, () => {
        renderLoginRequired();
      });
    });

    // Refresh
    document.getElementById("refreshBtn").addEventListener("click", () => {
      window.location.reload();
    });
  }

  // ─── Main ──────────────────────────────────────────────────────────────

  try {
    // Mandatory sign-in gate: without a user_id, lock the dashboard UI
    const syncResult = await chrome.storage.sync.get(["user_id"]);
    const userId = syncResult.user_id;

    if (!userId) {
      renderLoginRequired();
      return;
    }

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

    if (!tokenResult || tokenResult.requiresAuth || !tokenResult.token) {
      renderLoginRequired();
      return;
    }

    renderPopup(tokenResult, stateResult ? stateResult.paused : false, userId);
  } catch (err) {
    // Fallback: try chrome.storage directly
    try {
      const syncResult = await chrome.storage.sync.get(["user_id"]);
      const userId = syncResult.user_id;

      if (!userId) {
        renderLoginRequired();
        return;
      }

      // Fetch dashboard data directly from server
      const resp = await fetch(
        `https://listrack-2.onrender.com/api/dashboard?user=${encodeURIComponent(userId)}`
      );

      const goalsResp = await fetch(
        `https://listrack-2.onrender.com/api/goals/status?user=${encodeURIComponent(userId)}`
      );

      const dashboard = resp.ok ? await resp.json() : null;
      const goalsData = goalsResp.ok ? await goalsResp.json() : null;

      renderPopup({ dashboard, goals: goalsData ? goalsData.goals : null, token: userId }, false, userId);
    } catch (fallbackErr) {
      showError("Could not connect to the server. Make sure the server is running.");
    }
  }
})();
