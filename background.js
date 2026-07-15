// ==============================
// Twitch Stream Helper - background.js (MV3)
// ==============================

import {
  applyTemplate, composeXPost, createTemplateVariables,
  mapTags, normalizeTagEntries, toTagIds
} from "./src/utils.js";
import {
  hydrateStreamState, updateStreamState, getStreamState,
  cacheCategoryInfo, getSavedCategories, updateCategoryHistory,
  getSavedTags, updateSavedTags
} from "./src/storage.js";
import {
  authenticate, logout, loadTokens, getAccessToken
} from "./src/auth.js";
import {
  getUser, getGameById, searchCategoriesApi, getTopGameRankMap,
  getCurrentChannelTagsFromTwitch, getChannelInfo, updateChannelInfo
} from "./src/api.js";
// Initialize tokens
loadTokens();

async function refreshStreamState() {
  const user = await getUser();
  const ch = await getChannelInfo(user.id);
  // ch is the channel object directly now (data[0])

  const state = {
    title: ch.title || "",
    categoryName: ch.game_name || "",
    categoryId: ch.game_id || "",
    userLogin: user.login || "",
    userId: user.id || "",
  };
  await updateStreamState(state);
  return { user, channel: ch };
}

async function getCurrentTemplateVariables(partialState = {}) {
  await hydrateStreamState();
  const state = { ...getStreamState(), ...partialState };
  const tags = Array.isArray(partialState.tags)
    ? partialState.tags
    : state.categoryId ? await getSavedTags(state.categoryId) : [];
  return createTemplateVariables({ ...state, tags });
}

async function expandTitleTemplate(template, partialState = {}) {
  if (typeof template !== "string") {
    return { hasTemplate: false, title: "", error: "" };
  }

  const variables = await getCurrentTemplateVariables(partialState);
  const title = applyTemplate(template, variables);
  const error = title.length > 140
    ? chrome.i18n.getMessage("errorTitleTooLong", [String(title.length), "140"])
    : "";
  return { hasTemplate: true, title, error };
}


// ---- Message Router ----
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      // ------ 認証 ------
      if (message.action === "authenticate") {
        const result = await authenticate();
        if (result.success) {
          // Fetch user info to populate state
          try {
            const user = await getUser();
            await updateStreamState({ userLogin: user.login, userId: user.id });
            sendResponse({ success: true });
          } catch (e) {
            console.error("❌ User Fetch Exception:", e);
            sendResponse({ success: false, error: chrome.i18n.getMessage("errorTokenFetch") });
          }
        } else {
          sendResponse(result);
        }
        return;
      }

      // ------ ログアウト ------
      else if (message.action === "logout") {
        await logout();
        sendResponse({ success: true });
        return;
      }

      // ------ 初期情報取得 ------
      else if (message.action === "getStreamInfo") {
        const { user } = await refreshStreamState();
        const userId = user.id;
        const currentStreamState = getStreamState();

        let boxArtUrl = "";
        if (currentStreamState.categoryId) {
          const game = await getGameById(currentStreamState.categoryId);
          if (game && game.box_art_url) {
            boxArtUrl = game.box_art_url;
            await cacheCategoryInfo(game);
          }
        }

        // Tags logic
        let tags = await getSavedTags(currentStreamState.categoryId);
        let isNew = false;
        if ((!tags || tags.length === 0) && currentStreamState.categoryId) {
          tags = await getCurrentChannelTagsFromTwitch(userId);
          await updateSavedTags(currentStreamState.categoryId, tags);
          isNew = true;
        }
        if (currentStreamState.categoryId) {
          await updateCategoryHistory(currentStreamState.categoryId);
        }

        sendResponse({
          success: true,
          title: currentStreamState.title,
          game_name: currentStreamState.categoryName,
          game_id: currentStreamState.categoryId,
          game_thumbnail: boxArtUrl,
          tags,
          stream_url: `https://www.twitch.tv/${currentStreamState.userLogin}`,
          user_login: currentStreamState.userLogin,
          isNew
        });
        return;
      }

      // ------ タイトル更新 ------
      else if (message.action === "updateTitle") {
        const user = await getUser();
        const expanded = await expandTitleTemplate(message.title || "", {
          userLogin: user.login || "",
          userId: user.id || "",
        });

        if (expanded.error) {
          sendResponse({ success: false, error: expanded.error });
          return;
        }

        await updateChannelInfo(user.id, { title: expanded.title });

        await updateStreamState({
          title: expanded.title,
          userLogin: user.login || "",
          userId: user.id || "",
        });
        sendResponse({ success: true, title: expanded.title });
        return;
      }

      // ------ カテゴリ検索 ------
      else if (message.action === "searchCategories") {
        const q = String(message.query || "");
        const res = await searchCategoriesApi(q);
        let games = (res.data || []).map(g => ({ id: g.id, name: g.name, box_art_url: g.box_art_url }));

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

      // ------ タグ検索 (Legacy API removed) ------
      else if (message.action === "searchTags") {
        sendResponse({ success: true, tags: [] });
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
          const res = await searchCategoriesApi(gameName);
          const m = (res.data || []).find(g => g.name.toLowerCase() === gameName.toLowerCase());
          if (m) { gameId = m.id; gameName = m.name; }
        }

        if (!gameId) throw new Error(chrome.i18n.getMessage("errorGameIdRequired"));

        let tags = await getSavedTags(gameId);
        let isNew = false;
        const hasSavedTags = tags.length > 0;
        if (!hasSavedTags) {
          tags = await getCurrentChannelTagsFromTwitch(userId);
          await updateSavedTags(gameId, tags);
          isNew = true;
        }

        const expanded = await expandTitleTemplate(message.titleTemplate, {
          categoryId: gameId,
          categoryName: gameName,
          userLogin: user.login || "",
          userId,
          tags,
        });
        if (expanded.error) {
          sendResponse({ success: false, error: expanded.error });
          return;
        }

        const channelUpdate = { game_id: gameId };
        if (hasSavedTags) channelUpdate.tags = toTagIds(tags);
        if (expanded.hasTemplate) channelUpdate.title = expanded.title;

        // Twitch accepts game_id, tags, and title in one request. Keeping this
        // atomic avoids the endpoint-specific "updating too fast" response.
        await updateChannelInfo(userId, channelUpdate);

        const nextState = {
          categoryId: gameId,
          categoryName: gameName,
          userLogin: user.login || "",
          userId,
        };
        if (expanded.hasTemplate) nextState.title = expanded.title;
        await updateStreamState(nextState);
        await updateCategoryHistory(gameId);

        const game = await getGameById(gameId);
        if (game) await cacheCategoryInfo(game);

        sendResponse({
          success: true,
          game_name: gameName,
          game_id: gameId,
          tags,
          isNew,
          tagSyncFailed: false,
          title: expanded.hasTemplate ? expanded.title : undefined,
        });
        return;
      }

      // ------ タグ更新 ------
      else if (message.action === "updateTags") {
        const rawTags = Array.isArray(message.tags) ? message.tags : [];
        const gameId = message.gameId;

        if (!gameId) { sendResponse({ success: false, error: chrome.i18n.getMessage("errorCategoryUnset") }); return; }

        const entries = normalizeTagEntries(rawTags);
        const { resolved, missing } = await mapTags(entries);
        if (missing.length > 0) {
          const sample = missing.slice(0, 3).join(", ");
          sendResponse({ success: false, error: chrome.i18n.getMessage("errorTagNotFound", [sample]) });
          return;
        }

        if (resolved.length > 10) {
          sendResponse({ success: false, error: chrome.i18n.getMessage("errorTagLimit") });
          return;
        }

        await updateSavedTags(gameId, resolved);

        await hydrateStreamState();
        let currentStreamState = getStreamState();
        let syncFailed = false;
        let syncError = "";
        let titleTemplateError = "";
        let updatedTitle;

        if (!currentStreamState.categoryId) {
          await refreshStreamState();
          currentStreamState = getStreamState();
        }

        if (gameId === currentStreamState.categoryId) {
          let userIdForSync = currentStreamState.userId;
          if (!userIdForSync) {
            const user = await getUser();
            userIdForSync = user.id;
            currentStreamState = {
              ...currentStreamState,
              userId: user.id,
              userLogin: user.login || "",
            };
            await updateStreamState({ userId: user.id, userLogin: user.login || "" });
          }

          const expanded = await expandTitleTemplate(message.titleTemplate, {
            ...currentStreamState,
            tags: resolved,
          });
          titleTemplateError = expanded.error;

          const channelUpdate = { tags: toTagIds(resolved) };
          if (expanded.hasTemplate && !expanded.error) {
            channelUpdate.title = expanded.title;
          }

          try {
            await updateChannelInfo(userIdForSync, channelUpdate);
            if (expanded.hasTemplate && !expanded.error) {
              updatedTitle = expanded.title;
              await updateStreamState({ title: expanded.title });
            }
          } catch (e) {
            syncFailed = true;
            syncError = e?.message || String(e);
            console.warn("Channel update failed:", syncError);
          }
        }
        sendResponse({
          success: true,
          syncFailed,
          syncError,
          tags: resolved,
          title: updatedTitle,
          titleTemplateError,
        });
        return;
      }

      // ------ X投稿 ------
      else if (message.action === "postToX") {
        await refreshStreamState();
        const state = getStreamState();
        const variables = await getCurrentTemplateVariables(state);
        const text = composeXPost({
          template: message.text || "",
          variables,
          includeCategory: Boolean(message.includeCategory),
          includeStreamUrl: !Boolean(message.excludeStreamUrl),
        });

        const url = "https://x.com/intent/post?text=" + encodeURIComponent(text);
        chrome.tabs.create({ url }, () => sendResponse({ success: true }));
        return;
      }

      sendResponse({ success: false, error: chrome.i18n.getMessage("errorUnknownAction") });
    } catch (e) {
      // ログイン必須エラーは想定内のため console.error しない (または warn に留める)
      const loginReqMsg = chrome.i18n.getMessage("errorLoginRequired");
      if (e.message === loginReqMsg || e.message === "Login required") {
        // Expected behavior when not logged in
        // console.warn("Login required (suppressed error)");
      } else if (e?.status === 429) {
        console.warn("Twitch rate limit:", e.message);
      } else {
        console.error("background error:", e);
      }
      sendResponse({ success: false, error: e?.message || String(e) });
    }
  })();
  return true;
});
