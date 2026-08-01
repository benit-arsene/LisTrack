/**
 * LisTrack Onboarding
 * Mandatory Google sign-in welcome screen.
 * - Fetches the Google identity token via chrome.identity
 * - Resolves the user's email from the userinfo endpoint
 * - Stores `user_id` (email) in chrome.storage.sync
 */
(function () {
  "use strict";

  const USER_ID_KEY = "user_id";

  const signInBtn = document.getElementById("signInBtn");
  const statusEl = document.getElementById("status");
  const authSection = document.getElementById("authSection");
  const successSection = document.getElementById("successSection");
  const userEmailEl = document.getElementById("userEmail");
  const closeBtn = document.getElementById("closeBtn");

  function setStatus(message, isError) {
    statusEl.textContent = message;
    statusEl.classList.toggle("error", !!isError);
  }

  function showSuccess(email) {
    userEmailEl.textContent = email;
    authSection.classList.add("hidden");
    successSection.classList.remove("hidden");
  }

  /**
   * Exchange the identity token for the user's profile email.
   */
  async function fetchUserEmail(token) {
    const resp = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      throw new Error(`Could not fetch your Google profile (HTTP ${resp.status})`);
    }
    const profile = await resp.json();
    if (!profile || !profile.email) {
      throw new Error("Google did not return an email address for this account.");
    }
    return profile.email;
  }

  async function handleSignIn() {
    signInBtn.disabled = true;
    setStatus("Opening Google sign-in…");

    try {
      // 1. Request the identity token (interactive — shows Google's consent screen)
      const token = await new Promise((resolve, reject) => {
        chrome.identity.getAuthToken({ interactive: true }, (value) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(value);
          }
        });
      });

      // 2. Resolve the signed-in email
      setStatus("Verifying your account…");
      const email = await fetchUserEmail(token);

      // 3. Persist user_id (email) in chrome.storage.sync — this unlocks tracking.
      //    Emails are case-insensitive, so store lowercase for a stable identity.
      await new Promise((resolve, reject) => {
        chrome.storage.sync.set({ [USER_ID_KEY]: email.toLowerCase() }, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve();
          }
        });
      });

      setStatus("");
      showSuccess(email);
    } catch (err) {
      console.error("[onboarding] Sign-in failed:", err);
      setStatus(
        err && err.message && /cancelled|did not connect|User did not approve/i.test(err.message)
          ? "Sign-in was cancelled."
          : (err && err.message) || "Sign-in failed. Please try again.",
        true
      );
      signInBtn.disabled = false;
    }
  }

  // Allow closing the tab once onboarding is complete.
  function closeTab() {
    window.close();
    // Fallback for environments where window.close() is restricted:
    // close the tab this page runs in — never an arbitrary active tab.
    setTimeout(() => {
      try {
        chrome.tabs.getCurrent((tab) => {
          if (tab && tab.id != null) {
            chrome.tabs.remove(tab.id);
          }
        });
      } catch (_) {}
    }, 200);
  }

  signInBtn.addEventListener("click", handleSignIn);
  closeBtn.addEventListener("click", closeTab);

  // If the user is already signed in (e.g. re-opened the page), show success.
  chrome.storage.sync.get([USER_ID_KEY], (result) => {
    if (result[USER_ID_KEY]) {
      showSuccess(result[USER_ID_KEY]);
    }
  });
})();
