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
        signal: globalThis.AbortSignal?.timeout(20000),
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
        const error = new Error(chrome.i18n.getMessage("errorLoginRequired"));
        error.status = 401;
        throw error;
    }

    if (res.status === 204) return {};

    const text = await res.text().catch(() => "");
    if (!res.ok) {
        const isRateLimited = res.status === 429;
        const error = new Error(isRateLimited
            ? chrome.i18n.getMessage("errorTwitchRateLimited")
            : chrome.i18n.getMessage("errorTwitchApi", [res.status, text]));
        error.status = res.status;
        error.responseText = text;

        const resetAt = Number(res.headers.get("Ratelimit-Reset"));
        if (Number.isFinite(resetAt) && resetAt > 0) {
            error.retryAt = resetAt * 1000;
        }
        throw error;
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

const pendingStreamReads = new Map();
export async function getLiveStream(broadcasterId) {
    if (!pendingStreamReads.has(broadcasterId)) {
        const pending = twitchApi(`streams?user_id=${encodeURIComponent(broadcasterId)}`).then(result => {
            if (!Array.isArray(result.data)) throw new Error(chrome.i18n.getMessage("errorCommentStreamCheck"));
            return result.data[0] || null;
        });
        pendingStreamReads.set(broadcasterId, pending);
    }
    try { return await pendingStreamReads.get(broadcasterId); }
    finally { pendingStreamReads.delete(broadcasterId); }
}

export async function getArchiveVideos(broadcasterId, after = "") {
    const query = new URLSearchParams({ user_id: broadcasterId, type: "archive", first: "100" });
    if (after) query.set("after", after);
    const result = await twitchApi(`videos?${query}`);
    if (!Array.isArray(result.data)) throw new Error(chrome.i18n.getMessage("analyticsFetchError"));
    return result;
}

export async function getChannelFollowers(broadcasterId, after = "", first = 100) {
    const query = new URLSearchParams({ broadcaster_id: broadcasterId, first: String(first) });
    if (after) query.set("after", after);
    const result = await twitchApi(`channels/followers?${query}`);
    if (!Array.isArray(result.data) || !Number.isFinite(result.total)) {
        throw new Error(chrome.i18n.getMessage("analyticsFetchError"));
    }
    return result;
}

export function createEventSubscription(type, version, condition, sessionId) {
    return twitchApi("eventsub/subscriptions", "POST", {
        type, version, condition, transport: { method: "websocket", session_id: sessionId },
    });
}

export async function sendChatMessage(broadcasterId, message) {
    const result = await twitchApi("chat/messages", "POST", {
        broadcaster_id: broadcasterId,
        sender_id: broadcasterId,
        message,
    });
    const sent = result.data?.[0];
    if (sent?.is_sent === false) {
        const error = new Error(chrome.i18n.getMessage("errorCommentDropped", [
            sent.drop_reason?.message || sent.drop_reason?.code || "—",
        ]));
        error.definitelyNotSent = true;
        throw error;
    }
    if (!sent?.is_sent || !sent.message_id) throw new Error(chrome.i18n.getMessage("commentDeliveryUnknown"));
    return sent.message_id;
}

export async function pinChatMessage(broadcasterId, messageId, durationSeconds) {
    const query = new URLSearchParams({
        broadcaster_id: broadcasterId,
        moderator_id: broadcasterId,
        message_id: messageId,
    });
    if (durationSeconds) query.set("duration_seconds", String(durationSeconds));
    await twitchApi(`chat/pins?${query}`, "PUT");
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
