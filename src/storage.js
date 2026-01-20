// ==============================
// Twitch Stream Helper - storage.js
// ==============================

import { normalizeTagEntries, mapTags } from "./utils.js";

// ---- Base Storage Wrappers ----

export function readLocal(keys) {
    return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

export function writeLocal(obj) {
    return new Promise(resolve => chrome.storage.local.set(obj, resolve));
}

export async function removeLocal(keys) {
    return new Promise(resolve => chrome.storage.local.remove(keys, resolve));
}

// ---- Stream State Management ----

let currentTitle = "";
let currentCategoryName = "";
let currentCategoryId = "";
let currentUserLogin = "";
let currentUserId = "";

export function getStreamState() {
    return {
        title: currentTitle,
        categoryName: currentCategoryName,
        categoryId: currentCategoryId,
        userLogin: currentUserLogin,
        userId: currentUserId
    };
}

export async function hydrateStreamState() {
    if (currentTitle && currentCategoryId && currentUserLogin && currentUserId) return;
    const data = await readLocal(["streamState"]);
    const state = data.streamState;
    if (!state) return;

    if (!currentTitle && typeof state.title === "string") currentTitle = state.title;
    if (!currentCategoryName && typeof state.categoryName === "string") currentCategoryName = state.categoryName;
    if (!currentCategoryId && typeof state.categoryId === "string") currentCategoryId = state.categoryId;
    if (!currentUserLogin && typeof state.userLogin === "string") currentUserLogin = state.userLogin;
    if (!currentUserId && typeof state.userId === "string") currentUserId = state.userId;
}

export async function updateStreamState(partial) {
    await hydrateStreamState();
    if (partial.title !== undefined) currentTitle = partial.title;
    if (partial.categoryName !== undefined) currentCategoryName = partial.categoryName;
    if (partial.categoryId !== undefined) currentCategoryId = partial.categoryId;
    if (partial.userLogin !== undefined) currentUserLogin = partial.userLogin;
    if (partial.userId !== undefined) currentUserId = partial.userId;

    const state = {
        title: currentTitle || "",
        categoryName: currentCategoryName || "",
        categoryId: currentCategoryId || "",
        userLogin: currentUserLogin || "",
        userId: currentUserId || "",
    };
    await writeLocal({ streamState: state });
}

// ---- Category History & Cache ----

export async function updateCategoryHistory(gameId) {
    if (!gameId) return;
    return new Promise(resolve => {
        chrome.storage.local.get(["categoryHistory"], (r) => {
            let hist = r.categoryHistory || [];
            hist = hist.filter(id => id !== gameId);
            hist.unshift(gameId);
            if (hist.length > 30) hist = hist.slice(0, 30);
            chrome.storage.local.set({ categoryHistory: hist }, resolve);
        });
    });
}

export async function cacheCategoryInfo(game) {
    if (!game || !game.id) return;
    return new Promise(resolve => {
        chrome.storage.local.get(["categoryCache"], (r) => {
            const cache = r.categoryCache || {};
            cache[game.id] = { id: game.id, name: game.name, box_art_url: game.box_art_url };
            chrome.storage.local.set({ categoryCache: cache }, resolve);
        });
    });
}

export async function getSavedCategories() {
    return new Promise(resolve => {
        chrome.storage.local.get(["categoryHistory", "categoryCache"], (r) => {
            const history = r.categoryHistory || [];
            if (history.length === 0) { resolve([]); return; }
            const cache = r.categoryCache || {};
            const arr = history.map(id => cache[id]).filter(Boolean);
            resolve(arr);
        });
    });
}

// ---- Saved Tags ----

export async function getSavedTags(gameId) {
    if (!gameId) return [];
    const data = await readLocal(["savedTags"]);
    const map = data.savedTags || {};
    const raw = Array.isArray(map[gameId]) ? map[gameId] : [];
    const entries = normalizeTagEntries(raw);
    const { resolved } = await mapTags(entries);

    if (resolved.length !== raw.length || raw.some((t) => typeof t === "string")) {
        await updateSavedTags(gameId, resolved);
    }
    return resolved;
}

export async function updateSavedTags(gameId, tags) {
    if (!gameId) return;
    const data = await readLocal(["savedTags"]);
    const map = data.savedTags || {};
    map[gameId] = Array.isArray(tags) ? tags : [];
    await writeLocal({ savedTags: map });
}
