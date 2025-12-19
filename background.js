// ==============================
// Twitch Stream Helper - background.js (MV3)
// ==============================

let accessToken = null;

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

// storage から token を都度復元 + 401 で破棄
async function twitchApi(endpoint, method = "GET", body = null) {
  if (!accessToken) {
    const data = await new Promise(resolve => chrome.storage.local.get(["accessToken"], resolve));
    accessToken = data.accessToken || null;
  }
  // i18n
  if (!accessToken) throw new Error(chrome.i18n.getMessage("errorLoginRequired"));

  const res = await fetch(`https://api.twitch.tv/helix/${endpoint}`, {
    method,
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Client-Id": clientId,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(cleanBody(body)) : null,
  });

  // トークン失効
  if (res.status === 401) {
    await new Promise(r => chrome.storage.local.remove(["accessToken"], r));
    accessToken = null;
    // i18n
    throw new Error(chrome.i18n.getMessage("errorLoginRequired"));
  }

  if (res.status === 204) return {};

  // JSON以外や空レス対策
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    // i18n
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
  return new Promise(resolve => {
    chrome.storage.local.get(["savedTags"], (r) => {
      const map = r.savedTags || {};
      resolve(map[gameId] || []);
    });
  });
}
async function updateSavedTags(gameId, tags) {
  if (!gameId) return; // 空カテゴリは扱わない方針
  return new Promise(resolve => {
    chrome.storage.local.get(["savedTags"], (r) => {
      const map = r.savedTags || {};
      map[gameId] = Array.isArray(tags) ? tags : [];
      chrome.storage.local.set({ savedTags: map }, resolve);
    });
  });
}

// ---- Tag helpers ----
async function getCurrentChannelTagsFromTwitch(broadcasterId) {
  try {
    // Get Channel Information
    const ch = await twitchApi(`channels?broadcaster_id=${broadcasterId}`);
    const info = ch.data && ch.data[0];
    if (info && Array.isArray(info.tags)) return info.tags;
  } catch (_) {}
  return [];
}
async function applyTagsToTwitch(broadcasterId, tags) {
  try {
    // Set Channel Information (tags)
    await twitchApi(`channels?broadcaster_id=${broadcasterId}`, "PATCH", { tags });
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
        await new Promise(r => chrome.storage.local.set({ oauth_state: state }, r));

        const authUrl =
          `https://id.twitch.tv/oauth2/authorize` +
          `?client_id=${encodeURIComponent(clientId)}` +
          `&redirect_uri=${encodeURIComponent(redirectUri)}` +
          `&response_type=token` +
          `&scope=${encodeURIComponent("channel:manage:broadcast")}` +
          `&state=${encodeURIComponent(state)}`;

        chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, async (redirectUrl) => {
          if (chrome.runtime.lastError) {
            sendResponse({ success: false, error: chrome.runtime.lastError.message });
            return;
          }
          const hash = (redirectUrl && redirectUrl.split("#")[1]) || "";
          const params = new URLSearchParams(hash);
          const returnedState = params.get("state");
          const token = params.get("access_token");

          const store = await new Promise(r => chrome.storage.local.get(["oauth_state"], r));
          if (!returnedState || returnedState !== store.oauth_state) {
            // i18n
            sendResponse({ success: false, error: chrome.i18n.getMessage("errorCsrf") });
            return;
          }
          await new Promise(r => chrome.storage.local.remove(["oauth_state"], r));

          if (!token) {
            // i18n
            sendResponse({ success: false, error: chrome.i18n.getMessage("errorTokenFetch") });
            return;
          }

          accessToken = token;
          chrome.storage.local.set({ accessToken }, async () => {
            try {
              const user = await getUser();
              currentUserLogin = user.login;
              currentUserId = user.id || "";
              await updateStreamState({ userLogin: currentUserLogin, userId: currentUserId });
              sendResponse({ success: true });
            } catch (e) {
              // i18n
              sendResponse({ success: false, error: chrome.i18n.getMessage("errorUserInfo") });
            }
          });
        });
        return;
      }

      // ------ ログアウト ------
      else if (message.action === "logout") {
        accessToken = null;
        chrome.storage.local.remove(["accessToken"], () => sendResponse({ success: true }));
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
        const tags = Array.isArray(message.tags) ? message.tags : [];
        const gameId = message.gameId;
        // i18n
        if (!gameId) { sendResponse({ success: false, error: chrome.i18n.getMessage("errorCategoryUnset") }); return; }

        await updateSavedTags(gameId, tags);

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
          const applied = await applyTagsToTwitch(userIdForSync, tags);
          if (!applied) syncFailed = true;
        }
        sendResponse({ success: true, syncFailed });
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
