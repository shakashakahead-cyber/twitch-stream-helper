// ==============================
// Twitch Stream Helper - api.js
// ==============================

import { CLIENT_ID } from "./config.js";
import { ensureAccessToken, getAccessToken, refreshAccessToken, clearTokens, getRefreshToken } from "./auth.js";
import { cleanBody } from "./utils.js";

async function twitchApi(endpoint, method = "GET", body = null) {
    await ensureAccessToken();

    const doFetch = () => fetch(`https://api.twitch.tv/helix/${endpoint}`, {
        method,
        headers: {
            "Authorization": `Bearer ${getAccessToken()}`,
            "Client-Id": CLIENT_ID,
            "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(cleanBody(body)) : null,
    });

    let res = await doFetch();

    // Token expiration -> try refresh
    if (res.status === 401 && getRefreshToken()) {
        const refreshed = await refreshAccessToken();
        if (refreshed) {
            res = await doFetch();
        }
    }

    if (res.status === 401) {
        await clearTokens();
        throw new Error(chrome.i18n.getMessage("errorLoginRequired"));
    }

    if (res.status === 204) return {};

    const text = await res.text().catch(() => "");
    if (!res.ok) {
        throw new Error(chrome.i18n.getMessage("errorTwitchApi", [res.status, text]));
    }
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch (_) {
        return {};
    }
}

export async function getUser() {
    const j = await twitchApi("users");
    return j.data[0];
}

export async function getGameById(id) {
    if (!id) return null;
    const j = await twitchApi(`games?id=${encodeURIComponent(id)}`);
    return (j.data && j.data[0]) || null;
}

export async function getChannelInfo(broadcasterId) {
    const ch = await twitchApi(`channels?broadcaster_id=${broadcasterId}`);
    return (ch.data && ch.data[0]) ? ch.data[0] : {};
}

export async function updateChannelInfo(broadcasterId, data) {
    await twitchApi(`channels?broadcaster_id=${broadcasterId}`, "PATCH", data);
}

export async function searchCategoriesApi(query) {
    return await twitchApi(`search/categories?query=${encodeURIComponent(query)}`);
}

export async function getTopGames(limit = 100) {
    return await twitchApi(`games/top?first=${limit}`);
}

// ---- Helper for caching top games rank ----
let topGameRankCache = null;
let topGameRankFetchedAt = 0;

export async function getTopGameRankMap() {
    const now = Date.now();
    if (topGameRankCache && (now - topGameRankFetchedAt) < 10 * 60 * 1000) {
        return topGameRankCache;
    }
    const res = await getTopGames();
    const list = res.data || [];
    const map = {};
    list.forEach((g, i) => { map[g.id] = i + 1; });
    topGameRankCache = map;
    topGameRankFetchedAt = now;
    return map;
}

export async function getCurrentChannelTagsFromTwitch(broadcasterId) {
    try {
        const info = await getChannelInfo(broadcasterId);
        if (info && Array.isArray(info.tags)) {
            return info.tags.map((tagStr) => ({ id: tagStr, name: tagStr }));
        }
    } catch (_) { }
    return [];
}

export async function applyTagsToTwitch(broadcasterId, tags) {
    try {
        // tags array is expected to be list of strings (names) or objects with ids/names
        // Twitch API v2 (helix) expects 'tags' as array of strings
        const tagIds = tags.map((tag) => {
            if (typeof tag === "string") return tag;
            return tag.name || tag.id;
        }).filter(Boolean);

        await updateChannelInfo(broadcasterId, { tags: tagIds });
        return true;
    } catch (e) {
        console.warn("Tag application failed:", e?.message || e);
        return false;
    }
}
