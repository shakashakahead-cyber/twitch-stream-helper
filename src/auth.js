// ==============================
// Twitch Stream Helper - auth.js
// ==============================

import { CLIENT_ID } from "./config.js";
import { readLocal, writeLocal, removeLocal, updateStreamState } from "./storage.js";
// Circular dependency note: api.js needs auth token, but auth needs api to get user?
// Actually auth needs api only to fetch user info AFTER login.
// We might need to inject api function or handle it carefully.
// To avoid circular dependency issues in simple ES modules structure without bundler:
// We can define getUser inside api.js, and here we might just export helper to set user info,
// OR pass the api function as dependency.
// However, standard ES module imports are hoisted and bindings are live.
// Let's implement api.js separately. If `getUser` uses `twitchApi` which uses `accessToken` from here...
// We can expose `getAccessToken` from here.

let accessToken = null;
let refreshToken = null;
let accessTokenExpiresAt = 0;
let refreshingTokenPromise = null;

// ---- Token Management ----

export function getAccessToken() {
    return accessToken;
}

export function getRefreshToken() {
    return refreshToken;
}

export async function loadTokens() {
    const data = await readLocal(["accessToken", "refreshToken", "accessTokenExpiresAt"]);
    accessToken = data.accessToken || accessToken || null;
    refreshToken = data.refreshToken || refreshToken || null;
    accessTokenExpiresAt = data.accessTokenExpiresAt || accessTokenExpiresAt || 0;
    console.log("Auth: Tokens loaded.", { hasAccess: !!accessToken, hasRefresh: !!refreshToken });
}

export async function saveTokens(tokenResponse) {
    accessToken = tokenResponse.access_token || null;
    if (tokenResponse.refresh_token) {
        refreshToken = tokenResponse.refresh_token;
    }
    const expiresIn = Number(tokenResponse.expires_in || 0);
    accessTokenExpiresAt = expiresIn ? Date.now() + (expiresIn * 1000) : 0;
    await writeLocal({ accessToken, refreshToken, accessTokenExpiresAt });
    console.log("Auth: Tokens saved.", { hasAccess: !!accessToken });
}

export async function clearTokens() {
    accessToken = null;
    refreshToken = null;
    accessTokenExpiresAt = 0;
    await removeLocal(["accessToken", "refreshToken", "accessTokenExpiresAt"]);
}

export function isTokenExpiringSoon() {
    if (!accessTokenExpiresAt) return false;
    return Date.now() > (accessTokenExpiresAt - 60 * 1000);
}

// In implicit flow, we don't have a refresh token usually.
// But keeping logic in case we switch or if some flow provides it.
export async function refreshAccessToken() {
    await loadTokens();
    if (!refreshToken) return false;
    if (refreshingTokenPromise) return refreshingTokenPromise;

    refreshingTokenPromise = (async () => {
        const body = new URLSearchParams({
            client_id: CLIENT_ID,
            grant_type: "refresh_token",
            refresh_token: refreshToken,
        });
        const res = await fetch("https://id.twitch.tv/oauth2/token", {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: body.toString(),
        });
        if (!res.ok) {
            await clearTokens();
            return false;
        }
        const json = await res.json();
        await saveTokens(json);
        return true;
    })();

    try {
        return await refreshingTokenPromise;
    } finally {
        refreshingTokenPromise = null;
    }
}

export async function ensureAccessToken() {
    await loadTokens();
    if (!accessToken && refreshToken) {
        const refreshed = await refreshAccessToken();
        if (!refreshed) throw new Error(chrome.i18n.getMessage("errorLoginRequired"));
    }
    if (!accessToken) throw new Error(chrome.i18n.getMessage("errorLoginRequired"));
    if (isTokenExpiringSoon() && refreshToken) {
        const refreshed = await refreshAccessToken();
        if (!refreshed) throw new Error(chrome.i18n.getMessage("errorLoginRequired"));
    }
}

// ---- Auth Logic ----

export async function authenticate() {
    const redirectUri = chrome.identity.getRedirectURL();

    if (CLIENT_ID === "YOUR_TWITCH_CLIENT_ID") {
        return { success: false, error: "src/config.js の Client ID が設定されていません。" };
    }

    const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
    await writeLocal({ oauth_state: state });

    const authUrl =
        `https://id.twitch.tv/oauth2/authorize` +
        `?client_id=${encodeURIComponent(CLIENT_ID)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&response_type=token` +
        `&scope=${encodeURIComponent("channel:manage:broadcast")}` +
        `&state=${encodeURIComponent(state)}`;

    return new Promise((resolve) => {
        chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, async (redirectUrl) => {
            if (chrome.runtime.lastError) {
                resolve({ success: false, error: chrome.runtime.lastError.message });
                return;
            }
            if (!redirectUrl) {
                resolve({ success: false, error: chrome.i18n.getMessage("errorTokenFetch") });
                return;
            }

            const url = new URL(redirectUrl);
            const hashParams = new URLSearchParams(url.hash.substring(1));

            const returnedState = hashParams.get("state");
            const accessTokenFromUrl = hashParams.get("access_token");
            const error = hashParams.get("error");
            const errorDescription = hashParams.get("error_description");

            if (error) {
                console.error("❌ Auth Flow Error (Implicit):", error, errorDescription);
                resolve({ success: false, error: errorDescription || error });
                return;
            }

            const store = await readLocal(["oauth_state"]);
            if (!returnedState || returnedState !== store.oauth_state) {
                resolve({ success: false, error: chrome.i18n.getMessage("errorCsrf") });
                return;
            }
            await removeLocal(["oauth_state"]);

            if (!accessTokenFromUrl) {
                resolve({ success: false, error: chrome.i18n.getMessage("errorTokenFetch") });
                return;
            }

            try {
                const tokenData = {
                    access_token: accessTokenFromUrl,
                    refresh_token: null,
                    expires_in: 86400 * 60
                };
                await saveTokens(tokenData);
                resolve({ success: true });
            } catch (e) {
                console.error("❌ Token Save Exception:", e);
                resolve({ success: false, error: chrome.i18n.getMessage("errorTokenFetch") });
            }
        });
    });
}

export async function logout() {
    await clearTokens();
    await removeLocal(["oauth_state"]);
}
