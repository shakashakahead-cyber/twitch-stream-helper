// ==============================
// Twitch Stream Helper - config.js
// ==============================

export const CLIENT_ID = "YOUR_TWITCH_CLIENT_ID";
// Redirect URI is dynamically retrieved in background, but if needed here:
// export const REDIRECT_URI = chrome.identity.getRedirectURL();
// Note: chrome API usage in modules imported by popup might need care if not available,
// but config usually just holds static constants.
// For this extension, getting redirectURL in background.js or auth.js is fine.
