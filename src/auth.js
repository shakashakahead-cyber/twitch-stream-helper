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
let tokenValidation = null;
export const CHAT_SCOPE = "user:write:chat";
export const PIN_SCOPE = "moderator:manage:chat_messages";
const REQUIRED_SCOPES = Object.freeze(["channel:manage:broadcast", CHAT_SCOPE, PIN_SCOPE]);

export function hasRequiredScopes(authorization) {
    return REQUIRED_SCOPES.every(scope => authorization.scopes.includes(scope));
}

// ---- Token Management ----

export function getAccessToken() {
    return accessToken;
}

export function getRefreshToken() {
    return refreshToken;
}

export async function loadTokens() {
    const data = await readLocal(["accessToken", "refreshToken", "accessTokenExpiresAt"]);
    accessToken = data.accessToken || null;
    refreshToken = data.refreshToken || null;
    accessTokenExpiresAt = data.accessTokenExpiresAt || 0;
}

export async function saveTokens(tokenResponse) {
    tokenValidation = null;
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
    tokenValidation = null;
    accessToken = null;
    refreshToken = null;
    accessTokenExpiresAt = 0;
    await removeLocal(["accessToken", "refreshToken", "accessTokenExpiresAt"]);
}

// Validate on each worker session and at least hourly while it remains active.
// This also discovers scopes granted to tokens from older extension versions.
export async function getTokenAuthorization() {
    await ensureAccessToken();
    const token = accessToken;
    if (tokenValidation?.token === token && Date.now() - tokenValidation.checkedAt < 3600000) {
        return tokenValidation.info;
    }
    const response = await fetch("https://id.twitch.tv/oauth2/validate", {
        headers: { Authorization: `OAuth ${token}` },
    });
    if (response.status === 401) {
        await clearTokens();
        throw new Error(chrome.i18n.getMessage("errorLoginRequired"));
    }
    if (!response.ok) throw new Error(chrome.i18n.getMessage("errorCommentAuthCheck"));
    const data = await response.json();
    if (data.client_id !== CLIENT_ID || !data.user_id) {
        await clearTokens();
        throw new Error(chrome.i18n.getMessage("errorLoginRequired"));
    }
    const info = { userId: data.user_id, scopes: Array.isArray(data.scopes) ? data.scopes : [] };
    tokenValidation = { token, info, checkedAt: Date.now() };
    return info;
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

    const state = crypto.randomUUID();
    await writeLocal({ oauth_state: state });

    const authUrl =
        `https://id.twitch.tv/oauth2/authorize` +
        `?client_id=${encodeURIComponent(CLIENT_ID)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&response_type=token` +
        `&scope=${encodeURIComponent(REQUIRED_SCOPES.join(" "))}` +
        `&force_verify=true` +
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

            try {
                const url = new URL(redirectUrl);
                const hashParams = new URLSearchParams(url.hash.substring(1));
                const returnedState = hashParams.get("state");
                const accessTokenFromUrl = hashParams.get("access_token");
                const error = hashParams.get("error");
                if (error) {
                    resolve({ success: false, error: hashParams.get("error_description") || error });
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
                const tokenData = {
                    access_token: accessTokenFromUrl,
                    refresh_token: null,
                    expires_in: Number(hashParams.get("expires_in")) || 0
                };
                // A new implicit login must not retain another account's refresh token.
                refreshToken = null;
                await saveTokens(tokenData);
                const authorization = await getTokenAuthorization();
                if (!hasRequiredScopes(authorization)) {
                    resolve({ success: false, requiresReauth: true, error: chrome.i18n.getMessage("errorCommentPermissions") });
                    return;
                }
                resolve({ success: true });
            } catch (_) {
                resolve({ success: false, error: chrome.i18n.getMessage("errorTokenFetch") });
            }
        });
    });
}

export async function logout() {
    await clearTokens();
    await removeLocal(["oauth_state"]);
}
