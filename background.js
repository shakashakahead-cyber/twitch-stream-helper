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
  getSavedTags, updateSavedTags, readLocal, writeLocal,
  getPinnedCommentSettings, normalizePinnedCommentSettings
} from "./src/storage.js";
import {
  authenticate, logout, loadTokens, getAccessToken,
  getTokenAuthorization, hasRequiredScopes, CHAT_SCOPE, PIN_SCOPE
} from "./src/auth.js";
import {
  getUser, getGameById, searchCategoriesApi, getTopGameRankMap,
  getCurrentChannelTagsFromTwitch, getChannelInfo, updateChannelInfo,
  getLiveStream, sendChatMessage, pinChatMessage
} from "./src/api.js";
import { hasAnalyticsScopes } from "./src/auth.js";
import { requestBackfill } from "./src/analytics/backfill.js";
import {
  ANALYTICS_ALARM, initializeAnalytics, withAnalyticsLock, collectAnalytics,
  analyticsSettings, enableAnalytics, stopAnalytics
} from "./src/analytics/collector.js";
import { openAnalyticsDB } from "./src/analytics/db.js";
// Saved comments: polling, durable delivery records, and serialized writes.
const COMMENT_ALARM = "pinned-comment-stream-check";
let commentQueue = Promise.resolve();

function withCommentLock(task) {
  const pending = commentQueue.then(task);
  commentQueue = pending.catch(() => {});
  return pending;
}

function requireCommentScopes(authorization, pin) {
  if (!authorization.scopes.includes(CHAT_SCOPE) || (pin && !authorization.scopes.includes(PIN_SCOPE))) {
    throw new Error(chrome.i18n.getMessage("errorCommentPermissions"));
  }
}

async function syncCommentAlarm() {
  const settings = await getPinnedCommentSettings();
  await loadTokens();
  if (!settings.autoPost || !getAccessToken()) {
    await chrome.alarms.clear(COMMENT_ALARM);
    return;
  }
  if (!await chrome.alarms.get(COMMENT_ALARM)) {
    await chrome.alarms.create(COMMENT_ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
  }
}

async function saveCommentStatus(status, userId = "") {
  await writeLocal({ pinnedCommentStatus: { ...status, userId, updatedAt: Date.now() } });
}

async function getCommentPanel() {
  const settings = await getPinnedCommentSettings();
  const { pinnedCommentStatus } = await readLocal(["pinnedCommentStatus"]);
  let authorization;
  let authError = "";
  try {
    authorization = await getTokenAuthorization();
  } catch (error) {
    authError = error.message;
  }
  return {
    settings,
    canSend: authorization?.scopes.includes(CHAT_SCOPE) || false,
    canPin: authorization?.scopes.includes(PIN_SCOPE) || false,
    authError,
    requiresReauth: Boolean(authorization && !hasRequiredScopes(authorization)),
    accountMismatch: Boolean(settings.ownerId && authorization && settings.ownerId !== authorization.userId),
    status: pinnedCommentStatus?.userId === authorization?.userId ? pinnedCommentStatus : null,
  };
}

async function saveCommentSettings(value) {
  const settings = normalizePinnedCommentSettings(value);
  const texts = [settings.message, ...Object.values(settings.categoryMessages)];
  if (texts.some(text => [...text].length > 500)) {
    throw new Error(chrome.i18n.getMessage("errorCommentLength"));
  }
  if (settings.autoPost && !texts.some(text => text.trim())) {
    throw new Error(chrome.i18n.getMessage("errorCommentEmpty"));
  }
  const authorization = await getTokenAuthorization();
  if (settings.autoPost) requireCommentScopes(authorization, settings.pin);
  settings.ownerId = authorization.userId;
  await writeLocal({ pinnedCommentSettings: settings });
  await syncCommentAlarm();
  return getCommentPanel();
}

async function runPinnedComment(manual = false) {
  const settings = await getPinnedCommentSettings();
  if (!manual && !settings.autoPost) return;
  const authorization = await getTokenAuthorization();
  const userId = authorization.userId;
  try {
    requireCommentScopes(authorization, settings.pin);
    if (settings.ownerId !== userId) throw new Error(chrome.i18n.getMessage("errorCommentAccount"));
    const stream = await getLiveStream(userId);
    if (!stream) {
      await saveCommentStatus({ state: "offline" }, userId);
      return;
    }
    if (!stream.id || !stream.started_at) throw new Error(chrome.i18n.getMessage("errorCommentStreamCheck"));
    const key = `${userId}:${stream.id}:${stream.started_at}`;
    const stored = await readLocal(["pinnedCommentDeliveries"]);
    const deliveries = stored.pinnedCommentDeliveries || {};
    let delivery = deliveries[key];
    const persist = async () => {
      deliveries[key] = delivery;
      // Keep recent streams per account without evicting records for other accounts.
      const oldKeys = Object.keys(deliveries).filter(id => id.startsWith(`${userId}:`))
        .sort((a, b) => (deliveries[b].attemptedAt || 0) - (deliveries[a].attemptedAt || 0)).slice(100);
      oldKeys.forEach(id => delete deliveries[id]);
      await writeLocal({ pinnedCommentDeliveries: deliveries });
      await saveCommentStatus(delivery, userId);
    };

    if (delivery) {
      if (["sending", "pinning"].includes(delivery.state) || (delivery.state === "sent" && delivery.pin)) {
        // The worker may have stopped after Twitch accepted the write.
        delivery.state = delivery.messageId ? "pinFailed" : "unknown";
        delivery.error = chrome.i18n.getMessage(delivery.messageId ? "commentPinInterrupted" : "commentDeliveryUnknown");
        await persist();
      }
      const canRetry = manual && ["sendFailed", "pinFailed"].includes(delivery.state);
      if (!canRetry || (delivery.retryAt && Date.now() < delivery.retryAt)) {
        await saveCommentStatus(delivery, userId);
        return;
      }
    }

    if (!delivery?.messageId) {
      const text = settings.categoryMessages[stream.game_id] || settings.message;
      if (!text.trim()) {
        await saveCommentStatus({ state: "empty" }, userId);
        return;
      }
      if ([...text].length > 500) throw new Error(chrome.i18n.getMessage("errorCommentLength"));
      delivery = {
        state: "sending", streamId: stream.id, startedAt: stream.started_at,
        attemptedAt: Date.now(), pin: settings.pin, durationSeconds: settings.durationSeconds,
      };
      // Persist BEFORE the POST: a restart or an ambiguous response must never resend.
      await persist();
      try {
        delivery.messageId = await sendChatMessage(userId, text);
      } catch (error) {
        delivery.state = error.definitelyNotSent || [400, 401, 403, 422, 429].includes(error.status)
          ? "sendFailed" : "unknown";
        delivery.error = delivery.state === "unknown"
          ? chrome.i18n.getMessage("commentDeliveryUnknown") : error.message;
        delivery.retryAt = error.status === 429 ? Math.max(error.retryAt || 0, Date.now() + 60000) : 0;
        await persist();
        return;
      }
      delivery.state = "sent";
      await persist();
    }

    if (delivery.pin) {
      requireCommentScopes(authorization, true);
      delivery.state = "pinning";
      delivery.error = "";
      await persist();
      try {
        await pinChatMessage(userId, delivery.messageId, delivery.durationSeconds);
        delivery.state = "pinned";
      } catch (error) {
        // A previous pin may have succeeded just before worker suspension.
        delivery.state = error.status === 409 ? "pinned" : "pinFailed";
        delivery.error = error.status === 409 ? "" : error.message;
        delivery.retryAt = error.status === 429 ? Math.max(error.retryAt || 0, Date.now() + 60000) : 0;
      }
      await persist();
    }
  } catch (error) {
    await saveCommentStatus({ state: "error", error: error.message }, userId);
    throw error;
  }
}

function initializeCommentAlarm() {
  withCommentLock(syncCommentAlarm).catch(() => {});
}
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ANALYTICS_ALARM) {
    withAnalyticsLock(collectAnalytics).catch(() => {});
    return;
  }
  if (alarm.name !== COMMENT_ALARM) return;
  withCommentLock(async () => {
    try {
      await runPinnedComment();
    } catch (_) {
      // Errors are shown in the popup. Never retry a chat write here.
    }
    await syncCommentAlarm();
  }).catch(() => {});
});
chrome.runtime.onInstalled.addListener(initializeCommentAlarm);
chrome.runtime.onStartup.addListener(initializeCommentAlarm);
initializeCommentAlarm();
chrome.runtime.onInstalled.addListener(initializeAnalytics);
chrome.runtime.onStartup.addListener(initializeAnalytics);
initializeAnalytics();

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
      if (message.action === "analyticsEnable") {
        const result = await withCommentLock(() => withAnalyticsLock(async () => {
          let authorization;
          try { authorization = await getTokenAuthorization(); } catch (_) { /* Offer interactive login below. */ }
          if (!authorization || !hasAnalyticsScopes(authorization) || !hasRequiredScopes(authorization)) {
            const result = await authenticate({ analytics: true });
            if (!result.success) return result;
            authorization = await getTokenAuthorization();
          }
          await enableAnalytics(authorization);
          await syncCommentAlarm();
          return { success: true };
        }));
        if (result.success) initializeAnalytics();
        sendResponse(result);
        return;
      }
      if (message.action === "analyticsDisable") {
        await withAnalyticsLock(stopAnalytics);
        sendResponse({ success: true });
        return;
      }
      if (message.action === "analyticsRefresh") {
        await withAnalyticsLock(async () => {
          const settings = await analyticsSettings();
          if (!settings.enabled || !settings.ownerId) throw new Error(chrome.i18n.getMessage("analyticsEnableFirst"));
          const db = await openAnalyticsDB(settings.ownerId);
          await requestBackfill(db, { followers: true });
        });
        initializeAnalytics();
        sendResponse({ success: true });
        return;
      }
      // ------ 認証 ------
      if (message.action === "authenticate") {
        const result = await withCommentLock(async () => {
          const settings = await analyticsSettings();
          const result = await authenticate({ analytics: settings.enabled });
          await syncCommentAlarm();
          initializeAnalytics();
          return result;
        });
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
        await withCommentLock(async () => {
          await withAnalyticsLock(stopAnalytics);
          await logout();
          const settings = await getPinnedCommentSettings();
          await writeLocal({ pinnedCommentSettings: { ...settings, autoPost: false } });
          await syncCommentAlarm();
        });
        sendResponse({ success: true });
        return;
      }

      else if (message.action === "getPinnedCommentSettings") {
        sendResponse({ success: true, ...await getCommentPanel() });
        return;
      }
      else if (message.action === "savePinnedCommentSettings") {
        const panel = await withCommentLock(() => saveCommentSettings(message.settings));
        sendResponse({ success: true, ...panel });
        return;
      }
      else if (message.action === "sendPinnedComment") {
        const panel = await withCommentLock(async () => {
          await runPinnedComment(true);
          return getCommentPanel();
        });
        sendResponse({ success: true, ...panel });
        return;
      }

      // ------ 初期情報取得 ------
      else if (message.action === "getStreamInfo") {
        const authorization = await getTokenAuthorization();
        if (!hasRequiredScopes(authorization)) {
          sendResponse({ success: false, requiresReauth: true, error: chrome.i18n.getMessage("errorCommentPermissions") });
          return;
        }
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
