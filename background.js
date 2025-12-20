// ==============================
// Twitch Stream Helper - background.js (MV3)
// ==============================

let accessToken = null;
let refreshToken = null;
let accessTokenExpiresAt = 0;
let refreshingTokenPromise = null;

let currentTitle = "";
let currentCategoryName = "";
let currentCategoryId = "";
let currentUserLogin = "";
let currentUserId = "";

const clientId = "vrl905kkccezbxe6ds281wk4md9qj0";
const redirectUri = chrome.identity.getRedirectURL();

// ---- Utilities ----
function cleanBody(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([_, v]) => v !== undefined && v !== null && v !== "")
  );
}

function readLocal(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

function writeLocal(obj) {
  return new Promise(resolve => chrome.storage.local.set(obj, resolve));
}

async function hydrateStreamState() {
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

async function updateStreamState(partial) {
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

async function refreshStreamState() {
  const user = await getUser();
  const ch = await twitchApi(`channels?broadcaster_id=${user.id}`);
  const channel = ch.data && ch.data[0] ? ch.data[0] : {};

  const state = {
    title: channel.title || "",
    categoryName: channel.game_name || "",
    categoryId: channel.game_id || "",
    userLogin: user.login || "",
    userId: user.id || "",
  };
  await updateStreamState(state);
  return { user, channel };
}

// ✅ ハッシュタグ変換（スペース詰め＋記号除去、Unicode対応）
function toHashtag(categoryName) {
  if (!categoryName) return "";
  return categoryName
    .trim()
    .replace(/\s+/g, "")              // 空白を削除（詰める）
    .replace(/[^\p{L}\p{N}]/gu, "");  // 文字・数字以外を削除
}

function base64UrlEncodeBytes(bytes) {
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function generateCodeVerifier() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncodeBytes(bytes);
}

async function createCodeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncodeBytes(new Uint8Array(digest));
}

async function loadTokens() {
  const data = await readLocal(["accessToken", "refreshToken", "accessTokenExpiresAt"]);
  accessToken = data.accessToken || accessToken || null;
  refreshToken = data.refreshToken || refreshToken || null;
  accessTokenExpiresAt = data.accessTokenExpiresAt || accessTokenExpiresAt || 0;
}

async function saveTokens(tokenResponse) {
  accessToken = tokenResponse.access_token || null;
  if (tokenResponse.refresh_token) {
    refreshToken = tokenResponse.refresh_token;
  }
  const expiresIn = Number(tokenResponse.expires_in || 0);
  accessTokenExpiresAt = expiresIn ? Date.now() + (expiresIn * 1000) : 0;
  await writeLocal({ accessToken, refreshToken, accessTokenExpiresAt });
}

async function clearTokens() {
  accessToken = null;
  refreshToken = null;
  accessTokenExpiresAt = 0;
  await new Promise(resolve => chrome.storage.local.remove(["accessToken", "refreshToken", "accessTokenExpiresAt"], resolve));
}

function isTokenExpiringSoon() {
  if (!accessTokenExpiresAt) return false;
  return Date.now() > (accessTokenExpiresAt - 60 * 1000);
}

async function exchangeCodeForToken(code, codeVerifier) {
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || "token_exchange_failed");
  }
  return res.json();
}

async function refreshAccessToken() {
  await loadTokens();
  if (!refreshToken) return false;
  if (refreshingTokenPromise) return refreshingTokenPromise;

  refreshingTokenPromise = (async () => {
    const body = new URLSearchParams({
      client_id: clientId,
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

const TAG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
let tagCatalog = null;
let tagCatalogFetchedAt = 0;

function getUiLocale() {
  const locale = chrome.i18n && chrome.i18n.getUILanguage ? chrome.i18n.getUILanguage() : "en-us";
  return String(locale || "en-us").toLowerCase();
}

function normalizeTagName(name) {
  return String(name || "").trim().toLowerCase();
}

function pickLocalizedTagName(namesByLocale, locale) {
  if (!namesByLocale) return "";
  const normalized = String(locale || "").toLowerCase();
  const candidates = [];
  if (normalized) {
    candidates.push(normalized);
    if (normalized.includes("_")) candidates.push(normalized.replace("_", "-"));
    if (normalized.includes("-")) candidates.push(normalized.replace("-", "_"));
  }
  candidates.push("en-us");
  for (const loc of candidates) {
    if (namesByLocale[loc]) return namesByLocale[loc];
  }
  const values = Object.values(namesByLocale);
  return values.length ? values[0] : "";
}

function buildTagCatalog(rawTags) {
  const locale = getUiLocale();
  const byId = new Map();
  const nameIndex = new Map();
  const list = rawTags.map((tag) => {
    const namesByLocale = tag.names || {};
    const allNames = Object.values(namesByLocale).filter(Boolean);
    const displayName = pickLocalizedTagName(namesByLocale, locale) || allNames[0] || "";
    const entry = { id: tag.id, name: displayName, names: allNames, isAuto: Boolean(tag.isAuto) };
    if (entry.id) byId.set(entry.id, entry);
    for (const n of allNames) {
      nameIndex.set(normalizeTagName(n), entry);
    }
    if (entry.name) {
      nameIndex.set(normalizeTagName(entry.name), entry);
    }
    return entry;
  });
  return { list, byId, nameIndex };
}

async function fetchAllStreamTags() {
  let after = "";
  const tags = [];
  do {
    const params = new URLSearchParams({ first: "100" });
    if (after) params.set("after", after);
    const res = await twitchApi(`tags/streams?${params.toString()}`);
    const data = res.data || [];
    for (const tag of data) {
      const id = tag.tag_id || tag.id;
      const names = tag.localization_names || {};
      const isAuto = Boolean(tag.is_auto);
      if (id) tags.push({ id, names, isAuto });
    }
    after = res.pagination && res.pagination.cursor ? res.pagination.cursor : "";
  } while (after);
  return tags;
}

async function getTagCatalog() {
  const now = Date.now();
  if (tagCatalog && (now - tagCatalogFetchedAt) < TAG_CACHE_TTL_MS) {
    return tagCatalog;
  }
  const cached = await readLocal(["tagCatalogCache"]);
  if (cached.tagCatalogCache && (now - cached.tagCatalogCache.fetchedAt) < TAG_CACHE_TTL_MS) {
    tagCatalog = buildTagCatalog(cached.tagCatalogCache.tags || []);
    tagCatalogFetchedAt = cached.tagCatalogCache.fetchedAt;
    return tagCatalog;
  }
  const tags = await fetchAllStreamTags();
  tagCatalog = buildTagCatalog(tags);
  tagCatalogFetchedAt = now;
  await writeLocal({ tagCatalogCache: { fetchedAt: now, tags } });
  return tagCatalog;
}

function normalizeTagEntry(tag) {
  if (!tag) return null;
  if (typeof tag === "string") {
    const name = tag.trim();
    return name ? { id: "", name } : null;
  }
  if (typeof tag === "object") {
    const id = String(tag.id || tag.tag_id || "").trim();
    const name = String(tag.name || tag.label || tag.tag || "").trim();
    if (!id && !name) return null;
    return { id, name };
  }
  return null;
}

function normalizeTagEntries(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.map(normalizeTagEntry).filter(Boolean);
}

async function mapTags(tagEntries) {
  if (!tagEntries.length) return { resolved: [], missing: [] };
  const catalog = await getTagCatalog();
  const resolved = [];
  const missing = [];
  for (const entry of tagEntries) {
    if (!entry) continue;
    if (entry.id) {
      const found = catalog.byId.get(entry.id);
      if (found) resolved.push({ id: found.id, name: found.name });
      else resolved.push({ id: entry.id, name: entry.name || entry.id });
      continue;
    }
    if (entry.name) {
      const byId = catalog.byId.get(entry.name);
      if (byId && !byId.isAuto) {
        resolved.push({ id: byId.id, name: byId.name });
        continue;
      }
      const found = catalog.nameIndex.get(normalizeTagName(entry.name));
      if (found && !found.isAuto) resolved.push({ id: found.id, name: found.name });
      else missing.push(entry.name);
    }
  }
  return { resolved, missing };
}

function toTagIds(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.map((tag) => (typeof tag === "string" ? tag : tag.id)).filter(Boolean);
}

async function ensureAccessToken() {
  await loadTokens();
  if (!accessToken && refreshToken) {
    const refreshed = await refreshAccessToken();
    if (!refreshed) throw new Error(chrome.i18n.getMessage("errorLoginRequired"));
  }
  if (!accessToken) throw new Error(chrome.i18n.getMessage("errorLoginRequired"));
  if (isTokenExpiringSoon()) {
    const refreshed = await refreshAccessToken();
    if (!refreshed) throw new Error(chrome.i18n.getMessage("errorLoginRequired"));
  }
}

// storage から token を都度復元 + 401 で再取得
async function twitchApi(endpoint, method = "GET", body = null) {
  await ensureAccessToken();

  const doFetch = () => fetch(`https://api.twitch.tv/helix/${endpoint}`, {
    method,
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Client-Id": clientId,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(cleanBody(body)) : null,
  });

  let res = await doFetch();

  // トークン失効 → リフレッシュ試行
  if (res.status === 401 && refreshToken) {
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

  // JSON以外や空レス対策
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

async function getUser() {
  const j = await twitchApi("users");
  return j.data[0];
}

async function getGameById(id) {
  if (!id) return null;
  const j = await twitchApi(`games?id=${encodeURIComponent(id)}`);
  return (j.data && j.data[0]) || null;
}

// ---- Popular games cache ----
let topGameRankCache = null;
let topGameRankFetchedAt = 0;

async function getTopGameRankMap() {
  const now = Date.now();
  if (topGameRankCache && (now - topGameRankFetchedAt) < 10 * 60 * 1000) {
    return topGameRankCache;
  }
  const res = await twitchApi("games/top?first=100");
  const list = res.data || [];
  const map = {};
  list.forEach((g, i) => { map[g.id] = i + 1; });
  topGameRankCache = map;
  topGameRankFetchedAt = now;
  return map;
}

// ---- Local storage helpers ----
async function updateCategoryHistory(gameId) {
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
async function cacheCategoryInfo(game) {
  if (!game || !game.id) return;
  return new Promise(resolve => {
    chrome.storage.local.get(["categoryCache"], (r) => {
      const cache = r.categoryCache || {};
      cache[game.id] = { id: game.id, name: game.name, box_art_url: game.box_art_url };
      chrome.storage.local.set({ categoryCache: cache }, resolve);
    });
  });
}
async function getSavedCategories() {
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
async function getSavedTags(gameId) {
  if (!gameId) return []; // 空カテゴリは扱わない方針
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
async function updateSavedTags(gameId, tags) {
  if (!gameId) return; // 空カテゴリは扱わない方針
  const data = await readLocal(["savedTags"]);
  const map = data.savedTags || {};
  map[gameId] = Array.isArray(tags) ? tags : [];
  await writeLocal({ savedTags: map });
}

// ---- Tag helpers ----
async function getCurrentChannelTagsFromTwitch(broadcasterId) {
  try {
    // Get Channel Information
    const ch = await twitchApi(`channels?broadcaster_id=${broadcasterId}`);
    const info = ch.data && ch.data[0];
    if (info && Array.isArray(info.tags)) {
      const entries = info.tags.map((id) => ({ id }));
      const { resolved } = await mapTags(entries);
      return resolved;
    }
  } catch (_) {}
  return [];
}
async function applyTagsToTwitch(broadcasterId, tags) {
  try {
    // Set Channel Information (tags)
    const tagIds = toTagIds(tags);
    await twitchApi(`channels?broadcaster_id=${broadcasterId}`, "PATCH", { tags: tagIds });
    return true;
  } catch (e) {
    console.warn("タグ適用に失敗:", e?.message || e);
    return false;
  }
}

// ---- Message Router ----
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      // ------ 認証 ------
      if (message.action === "authenticate") {
        const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = await createCodeChallenge(codeVerifier);
        await writeLocal({ oauth_state: state, oauth_code_verifier: codeVerifier });

        const authUrl =
          `https://id.twitch.tv/oauth2/authorize` +
          `?client_id=${encodeURIComponent(clientId)}` +
          `&redirect_uri=${encodeURIComponent(redirectUri)}` +
          `&response_type=code` +
          `&scope=${encodeURIComponent("channel:manage:broadcast")}` +
          `&code_challenge=${encodeURIComponent(codeChallenge)}` +
          `&code_challenge_method=S256` +
          `&state=${encodeURIComponent(state)}`;

        chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, async (redirectUrl) => {
          if (chrome.runtime.lastError) {
            sendResponse({ success: false, error: chrome.runtime.lastError.message });
            return;
          }
          if (!redirectUrl) {
            sendResponse({ success: false, error: chrome.i18n.getMessage("errorTokenFetch") });
            return;
          }

          const url = new URL(redirectUrl);
          const returnedState = url.searchParams.get("state");
          const code = url.searchParams.get("code");
          const error = url.searchParams.get("error");
          const errorDescription = url.searchParams.get("error_description");

          if (error) {
            sendResponse({ success: false, error: errorDescription || error });
            return;
          }

          const store = await readLocal(["oauth_state", "oauth_code_verifier"]);
          if (!returnedState || returnedState !== store.oauth_state) {
            // i18n
            sendResponse({ success: false, error: chrome.i18n.getMessage("errorCsrf") });
            return;
          }
          await new Promise(r => chrome.storage.local.remove(["oauth_state", "oauth_code_verifier"], r));

          if (!code || !store.oauth_code_verifier) {
            // i18n
            sendResponse({ success: false, error: chrome.i18n.getMessage("errorTokenFetch") });
            return;
          }

          try {
            const tokenData = await exchangeCodeForToken(code, store.oauth_code_verifier);
            await saveTokens(tokenData);
            const user = await getUser();
            currentUserLogin = user.login;
            currentUserId = user.id || "";
            await updateStreamState({ userLogin: currentUserLogin, userId: currentUserId });
            sendResponse({ success: true });
          } catch (e) {
            sendResponse({ success: false, error: chrome.i18n.getMessage("errorTokenFetch") });
          }
        });
        return;
      }

      // ------ ログアウト ------
      else if (message.action === "logout") {
        await clearTokens();
        chrome.storage.local.remove(["oauth_state", "oauth_code_verifier"], () => sendResponse({ success: true }));
        return;
      }

      // ------ 初期情報取得 ------
      else if (message.action === "getStreamInfo") {
        const { user } = await refreshStreamState();
        const userId = user.id;

        let boxArtUrl = "";
        if (currentCategoryId) {
          const game = await getGameById(currentCategoryId);
          if (game && game.box_art_url) {
            boxArtUrl = game.box_art_url;
            await cacheCategoryInfo(game);
          }
        }

        // タグは保存済み → それが無ければTwitchから取得して保存
        let tags = await getSavedTags(currentCategoryId);
        let isNew = false;
        if ((!tags || tags.length === 0) && currentCategoryId) {
          tags = await getCurrentChannelTagsFromTwitch(userId);
          await updateSavedTags(currentCategoryId, tags);
          isNew = true;
        }
        if (currentCategoryId) {
          await updateCategoryHistory(currentCategoryId);
        }

        sendResponse({
          success: true,
          title: currentTitle,
          game_name: currentCategoryName,
          game_id: currentCategoryId,
          game_thumbnail: boxArtUrl,
          tags,
          stream_url: `https://www.twitch.tv/${currentUserLogin}`,
          isNew
        });
        return;
      }

      // ------ タイトル更新 ------
      else if (message.action === "updateTitle") {
        const user = await getUser();
        await twitchApi(`channels?broadcaster_id=${user.id}`, "PATCH", { title: message.title || "" });
        currentTitle = message.title || "";
        await updateStreamState({ title: currentTitle });
        sendResponse({ success: true });
        return;
      }

      // ------ カテゴリ検索（先頭一致優先＋人気順セカンダリ） ------
      else if (message.action === "searchCategories") {
        const q = String(message.query || "");
        const j = await twitchApi(`search/categories?query=${encodeURIComponent(q)}`);
        let games = (j.data || []).map(g => ({ id: g.id, name: g.name, box_art_url: g.box_art_url }));

        const rankMap = await getTopGameRankMap();
        const qLower = q.toLowerCase();
        games.sort((a, b) => {
          const aStarts = a.name.toLowerCase().startsWith(qLower);
          const bStarts = b.name.toLowerCase().startsWith(qLower);
          if (aStarts !== bStarts) return aStarts ? -1 : 1;
          const ar = rankMap[a.id] || Number.MAX_SAFE_INTEGER;
          const br = rankMap[b.id] || Number.MAX_SAFE_INTEGER;
          if (ar !== br) return ar - br;
          return a.name.localeCompare(b.name);
        });

        for (const g of games.slice(0, 10)) cacheCategoryInfo(g);
        sendResponse({ success: true, games });
        return;
      }

      // ------ タグ検索 ------
      else if (message.action === "searchTags") {
        const q = String(message.query || "").trim();
        if (!q) { sendResponse({ success: true, tags: [] }); return; }

        const catalog = await getTagCatalog();
        const qLower = q.toLowerCase();
        const results = [];
        for (const tag of catalog.list) {
          if (tag.isAuto) continue;
          if (!tag.name) continue;
          const names = tag.names && tag.names.length ? tag.names : [tag.name];
          let matched = false;
          let starts = false;
          for (const n of names) {
            const nLower = n.toLowerCase();
            if (nLower.startsWith(qLower)) { matched = true; starts = true; break; }
            if (nLower.includes(qLower)) matched = true;
          }
          if (matched) results.push({ tag, starts });
        }
        results.sort((a, b) => {
          if (a.starts !== b.starts) return a.starts ? -1 : 1;
          return a.tag.name.localeCompare(b.tag.name);
        });

        const tags = results.slice(0, 20).map((r) => ({ id: r.tag.id, name: r.tag.name }));
        sendResponse({ success: true, tags });
        return;
      }

      // ------ 保存済みカテゴリ履歴 ------
      else if (message.action === "getSavedCategories") {
        const arr = await getSavedCategories();
        sendResponse({ success: true, categories: arr });
        return;
      }

      // ------ カテゴリ更新 ------
      else if (message.action === "updateCategory") {
        const user = await getUser();
        const userId = user.id;

        let gameId = message.gameId || "";
        let gameName = message.game || "";

        if (!gameId && gameName) {
          const j = await twitchApi(`search/categories?query=${encodeURIComponent(gameName)}`);
          const m = (j.data || []).find(g => g.name.toLowerCase() === gameName.toLowerCase());
          if (m) { gameId = m.id; gameName = m.name; }
        }
        // i18n
        if (!gameId) throw new Error(chrome.i18n.getMessage("errorGameIdRequired"));

        await twitchApi(`channels?broadcaster_id=${userId}`, "PATCH", { game_id: gameId });
        currentCategoryId = gameId;
        currentCategoryName = gameName;
        await updateStreamState({ categoryId: gameId, categoryName: gameName });

        await updateCategoryHistory(gameId);
        const game = await getGameById(gameId);
        if (game) await cacheCategoryInfo(game);

        // そのカテゴリの保存タグがあれば適用、なければ取得して保存
        let tags = await getSavedTags(gameId);
        let isNew = false;
        let tagSyncFailed = false;
        if (tags && tags.length > 0) {
          const applied = await applyTagsToTwitch(userId, tags);
          if (!applied) tagSyncFailed = true;
        } else {
          tags = await getCurrentChannelTagsFromTwitch(userId);
          await updateSavedTags(gameId, tags);
          isNew = true;
        }

        sendResponse({ success: true, game_name: gameName, game_id: gameId, tags, isNew, tagSyncFailed });
        return;
      }

      // ------ タグ更新（選択中カテゴリのみ即時Twitch反映） ------
      else if (message.action === "updateTags") {
        const rawTags = Array.isArray(message.tags) ? message.tags : [];
        const gameId = message.gameId;
        // i18n
        if (!gameId) { sendResponse({ success: false, error: chrome.i18n.getMessage("errorCategoryUnset") }); return; }

        const entries = normalizeTagEntries(rawTags);
        const { resolved, missing } = await mapTags(entries);
        if (missing.length > 0) {
          const sample = missing.slice(0, 3).join(", ");
          sendResponse({ success: false, error: chrome.i18n.getMessage("errorTagNotFound", [sample]) });
          return;
        }

        await updateSavedTags(gameId, resolved);

        await hydrateStreamState();
        let userIdForSync = currentUserId;
        let syncFailed = false;
        if (!currentCategoryId) {
          const refreshed = await refreshStreamState();
          userIdForSync = refreshed.user?.id || userIdForSync;
        }

        if (gameId === currentCategoryId) {
          if (!userIdForSync) {
            const user = await getUser();
            userIdForSync = user.id || "";
            await updateStreamState({ userId: userIdForSync, userLogin: user.login || currentUserLogin });
          }
          const applied = await applyTagsToTwitch(userIdForSync, resolved);
          if (!applied) syncFailed = true;
        }
        sendResponse({ success: true, syncFailed, tags: resolved });
        return;
      }

      // ------ X投稿 ------
      else if (message.action === "postToX") {
        await refreshStreamState();
        let textParts = [];

        // タイトル
        if (currentTitle) {
          textParts.push(currentTitle);
        }

        // 追加テキスト（必要ならカテゴリハッシュタグを末尾に付加）
        let custom = String(message.text || "").trim();
        if (message.includeCategory && message.currentCategory) {
          const catHash = toHashtag(message.currentCategory);
          if (catHash) {
            custom = (custom ? custom + "\n" : "") + `#${catHash}`;
          }
        }
        if (custom) {
          textParts.push(custom);
        }

        // Twitch URL
        if (currentUserLogin) {
          textParts.push(`https://www.twitch.tv/${currentUserLogin}`);
        }

        // 改行結合
        let text = textParts.join("\n");
        if (text.length > 280) {
          text = text.slice(0, 279) + "…";
        }

        const url = "https://x.com/intent/post?text=" + encodeURIComponent(text);
        chrome.tabs.create({ url }, () => sendResponse({ success: true }));
        return;
      }
      // i18n
      sendResponse({ success: false, error: chrome.i18n.getMessage("errorUnknownAction") });
    } catch (e) {
      console.error("background error:", e);
      sendResponse({ success: false, error: e?.message || String(e) });
    }
  })();
  return true;
});
