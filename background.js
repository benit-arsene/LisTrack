// LisTrack Background Service Worker
// Handles forwarding tracking payloads to bypass HTTPS -> HTTP mixed content blocking

// Domains to block from being forwarded to the server (defense-in-depth).
// Should stay in sync with the IGNORED_DOMAIN_PATTERNS in tracker.js.
const BLOCKED_DOMAINS = ["localhost", "listrack.onrender.com", "render.com"];

function isBlockedDomain(domain) {
  return BLOCKED_DOMAINS.some(
    (pattern) => domain === pattern || domain.endsWith("." + pattern)
  );
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.domain) return;

  // Block tracking for excluded domains
  if (isBlockedDomain(message.domain)) {
    console.log("[background] Ignoring excluded domain:", message.domain);
    return;
  }

  console.log("[background] Forwarding tracking data for domain:", message.domain);

  fetch("https://listrack.onrender.com/api/screen-time", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(message)
  })
  .then(response => {
    if (!response.ok) {
      console.warn("[background] Server returned non-OK status:", response.status);
    }
  })
  .catch(err => {
    console.error("[background] Failed to connect to server:", err);
  });

  return true;
});
