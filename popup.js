const SERVER_URL = "https://listrack.onrender.com";

(async function () {
  const app = document.getElementById("app");

  try {
    const result = await chrome.storage.local.get(["lisTrackTrackerToken"]);
    let token = result.lisTrackTrackerToken;

    if (!token) {
      // No token yet — generate one via the background script
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage("getUserToken", (res) => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve(res);
        });
      });
      token = response.token;
    }

    if (!token) {
      app.innerHTML = `<div class="error">Could not retrieve your user token. Try reinstalling the extension.</div>`;
      return;
    }

    const dashboardUrl = `${SERVER_URL}/dashboard?user=${encodeURIComponent(token)}`;

    app.innerHTML = `
      <div class="logo">
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" />
        </svg>
        <h1>LisTrack</h1>
      </div>
      <p class="desc">Your screen time is being tracked. Open the dashboard to view your activity.</p>
      <a href="${dashboardUrl}" target="_blank" class="btn">
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
        </svg>
        Open Dashboard
      </a>
      <div class="token-section">
        <div class="token-label">Your User Token</div>
        <div class="token-display" id="tokenText">${token}</div>
        <button class="copy-btn" id="copyBtn">📋 Copy to clipboard</button>
      </div>
      <div class="footer">LisTrack v1.0 — Token-based multi-user</div>
    `;

    document.getElementById("copyBtn").addEventListener("click", () => {
      navigator.clipboard.writeText(token).then(() => {
        const btn = document.getElementById("copyBtn");
        btn.textContent = "✅ Copied!";
        setTimeout(() => { btn.textContent = "📋 Copy to clipboard"; }, 2000);
      });
    });

  } catch (err) {
    app.innerHTML = `<div class="error">Error: ${err.message}</div>`;
  }
})();
