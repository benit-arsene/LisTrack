// LisTrack Background Service Worker
// Handles forwarding tracking payloads to bypass HTTPS -> HTTP mixed content blocking

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.domain) return;

  console.log("[background] Forwarding tracking data for domain:", message.domain);

  fetch("http://localhost:3000/api/screen-time", {
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
