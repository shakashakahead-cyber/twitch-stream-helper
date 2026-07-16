// ==============================
// Twitch Stream Helper - popup.js
// ==============================

import {
  applyTemplate, composeXPost, createTemplateVariables,
  normalizeTagEntry, normalizeTagList,
  POST_TEMPLATE_VARIABLES, TITLE_TEMPLATE_VARIABLES
} from "./src/utils.js";

// ---- i18n replace for __MSG_...__ in HTML ----
document.addEventListener("DOMContentLoaded", () => {
  const re = /__MSG_([A-Za-z0-9_@]+)__/g;

  // テキストノードを置換
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
  let node;
  while (node = walker.nextNode()) {
    if (re.test(node.nodeValue)) {
      node.nodeValue = node.nodeValue.replace(re, (_, key) => chrome.i18n.getMessage(key) || "");
    }
  }

  // 属性 (placeholder, title, aria-label) を置換
  ["placeholder", "title", "aria-label"].forEach(attr => {
    document.querySelectorAll(`[${attr}]`).forEach(el => {
      const val = el.getAttribute(attr);
      if (val && re.test(val)) {
        el.setAttribute(attr, val.replace(re, (_, key) => chrome.i18n.getMessage(key) || ""));
      }
    });
  });
});

const loginBtn = document.getElementById("loginTwitch");
const logoutBtn = document.getElementById("logoutTwitch");
const mainUI = document.getElementById("mainUI");
const loggedOutState = document.getElementById("loggedOutState");
const connectedBadge = document.getElementById("connectedBadge");

const titleInput = document.getElementById("streamTitle");
const titleCount = document.getElementById("titleCount");
const titlePreview = document.getElementById("titlePreview");
const titleTemplateVariables = document.getElementById("titleTemplateVariables");
const titleSyncStatus = document.getElementById("titleSyncStatus");
const currentTwitchTitle = document.getElementById("currentTwitchTitle");

const gameInput = document.getElementById("game");
const gameThumbnail = document.getElementById("gameThumbnail");
const gameSuggestions = document.getElementById("gameSuggestions");
const selectedCategory = document.getElementById("selectedCategory");

const tagSection = document.getElementById("tagSection");
const tagList = document.getElementById("tagList");
const newTagInput = document.getElementById("newTag");
const addTagBtn = document.getElementById("addTag");
const tagSuggestions = document.getElementById("tagSuggestions");

const customHashtags = document.getElementById("customHashtags");
const includeCategoryTag = document.getElementById("includeCategoryTag");
const excludeStreamUrl = document.getElementById("excludeStreamUrl");
const postToXBtn = document.getElementById("postToX");
const xPostPreview = document.getElementById("xPostPreview");
const postTemplateVariables = document.getElementById("postTemplateVariables");

const toast = document.getElementById("toast");

let currentGameId = "";
let currentGameName = "";
let currentGameBoxArtUrl = "";
let currentTags = [];
let currentStreamTitle = "";
let currentUserLogin = "";
let titleSyncState = "idle";
let titleUpdateInFlight = null;
let titleUpdateQueued = false;
let categoryUpdateInFlight = false;

const SEARCH_DEBOUNCE_MS = 250;
let searchTimer = null;
let searchSeq = 0;
let tagSearchTimer = null; // Unused but kept for structure if needed
let tagSearchSeq = 0;

// ---- toast ----
function showToast(message, type = "success") {
  toast.textContent = message;

  toast.classList.remove("success", "error", "show");
  toast.classList.add(type, "show");

  setTimeout(() => {
    toast.classList.remove("show");
  }, 2500);
}

function setAuthenticatedUI(isAuthenticated) {
  loggedOutState.style.display = isAuthenticated ? "none" : "flex";
  connectedBadge.style.display = isAuthenticated ? "inline-flex" : "none";
  logoutBtn.style.display = isAuthenticated ? "inline-flex" : "none";
  mainUI.style.display = isAuthenticated ? "flex" : "none";
}

// ---- template variables ----
function getPopupTemplateVariables() {
  return createTemplateVariables({
    title: currentStreamTitle,
    categoryName: currentGameName,
    userLogin: currentUserLogin,
    tags: currentTags,
  });
}

function renderTitleSyncStatus(expandedTitle) {
  currentTwitchTitle.textContent = currentStreamTitle || "—";

  let state = titleSyncState;
  if (state === "idle") {
    state = expandedTitle === currentStreamTitle ? "synced" : "pending";
  }

  const messageKeys = {
    pending: "titleSyncPending",
    syncing: "titleSyncing",
    synced: "titleSyncSynced",
    failed: "titleSyncFailed",
  };
  titleSyncStatus.className = `sync-status ${state}`;
  titleSyncStatus.textContent = chrome.i18n.getMessage(messageKeys[state]);
}

function updateTemplatePreviews() {
  const variables = getPopupTemplateVariables();
  const expandedTitle = applyTemplate(titleInput.value, variables);
  titleCount.textContent = `${expandedTitle.length}/140`;
  titleCount.classList.toggle("over-limit", expandedTitle.length > 140);
  titlePreview.textContent = expandedTitle || "—";
  renderTitleSyncStatus(expandedTitle);

  const postText = composeXPost({
    template: customHashtags.value,
    variables,
    includeCategory: includeCategoryTag.checked,
    includeStreamUrl: !excludeStreamUrl.checked,
  });
  xPostPreview.textContent = postText || "—";
}

function insertTemplateVariable(input, variableName) {
  const token = `{${variableName}}`;
  const start = Number.isInteger(input.selectionStart) ? input.selectionStart : input.value.length;
  const end = Number.isInteger(input.selectionEnd) ? input.selectionEnd : input.value.length;
  input.setRangeText(token, start, end, "end");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
}

function renderTemplateVariableButtons(container, input, variableNames) {
  variableNames.forEach((variableName) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "template-variable";
    button.textContent = `{${variableName}}`;
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => insertTemplateVariable(input, variableName));
    container.appendChild(button);
  });
}

function loadTitleTemplate(fallbackTitle) {
  chrome.storage.local.get(["titleTemplate"], (result) => {
    titleInput.value = typeof result.titleTemplate === "string"
      ? result.titleTemplate
      : fallbackTitle;
    titleSyncState = "idle";
    updateTemplatePreviews();
  });
}

function titleTemplateUses(variableNames) {
  return variableNames.some((name) => titleInput.value.includes(`{${name}}`));
}

function applyTitleTemplate({ showSuccess = true } = {}) {
  if (titleUpdateInFlight) {
    titleUpdateQueued = true;
    return titleUpdateInFlight;
  }

  const template = titleInput.value;
  const expandedTitle = applyTemplate(template, getPopupTemplateVariables());
  if (expandedTitle === currentStreamTitle) {
    titleSyncState = "idle";
    updateTemplatePreviews();
    return Promise.resolve({ success: true, title: currentStreamTitle, skipped: true });
  }

  chrome.storage.local.set({ titleTemplate: template });
  titleSyncState = "syncing";
  updateTemplatePreviews();

  const request = new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "updateTitle", title: template }, (res) => {
      if (res && res.success) {
        currentStreamTitle = res.title || "";
        titleSyncState = "idle";
        updateTemplatePreviews();
        if (showSuccess) showToast(chrome.i18n.getMessage("toastTitleUpdated"));
      } else {
        titleSyncState = titleInput.value === template ? "failed" : "idle";
        updateTemplatePreviews();
        showToast((res && res.error) || chrome.i18n.getMessage("toastTitleUpdateFailed"), "error");
      }
      resolve(res || { success: false });
    });
  });

  titleUpdateInFlight = request;
  request.finally(() => {
    if (titleUpdateInFlight !== request) return;
    titleUpdateInFlight = null;
    if (titleUpdateQueued) {
      titleUpdateQueued = false;
      applyTitleTemplate({ showSuccess });
    }
  });
  return request;
}

renderTemplateVariableButtons(titleTemplateVariables, titleInput, TITLE_TEMPLATE_VARIABLES);
renderTemplateVariableButtons(postTemplateVariables, customHashtags, POST_TEMPLATE_VARIABLES);

// ---- title ----
titleInput.addEventListener("input", () => {
  chrome.storage.local.set({ titleTemplate: titleInput.value });
  if (!titleUpdateInFlight) titleSyncState = "idle";
  updateTemplatePreviews();
});
titleInput.addEventListener("change", () => {
  applyTitleTemplate();
});
titleInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    applyTitleTemplate();
  }
});

// ---- category ----
function setCategory(name, boxArtUrlTemplate, id = "") {
  currentGameName = name;
  currentGameId = id || "";
  currentGameBoxArtUrl = boxArtUrlTemplate || "";

  gameInput.style.display = "none";
  gameThumbnail.style.display = "none";

  selectedCategory.style.display = "flex";
  const thumbUrl = boxArtUrlTemplate
    ? boxArtUrlTemplate.replace("{width}", "64").replace("{height}", "64")
    : "";

  selectedCategory.className = name ? "" : "no-category-card";
  selectedCategory.textContent = "";

  if (!name) {
    const label = document.createElement("span");
    label.textContent = chrome.i18n.getMessage("toastCategoryNotSet");
    selectedCategory.appendChild(label);
  } else {
    if (thumbUrl) {
      const img = document.createElement("img");
      img.className = "selected-thumb";
      img.src = thumbUrl;
      img.alt = "";
      selectedCategory.appendChild(img);
    }

    const label = document.createElement("span");
    label.className = "selected-name";
    label.textContent = name;
    selectedCategory.appendChild(label);
  }

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "remove-btn";
  removeBtn.textContent = "×";
  removeBtn.setAttribute("aria-label", chrome.i18n.getMessage("removeCategoryButtonLabel"));
  selectedCategory.appendChild(removeBtn);

  removeBtn.addEventListener("click", () => {
    if (categoryUpdateInFlight) return;
    selectedCategory.style.display = "none";
    gameInput.style.display = "block";
    gameInput.value = "";
    gameThumbnail.style.display = "none";
    gameInput.focus();
  });

  tagSection.style.display = "block";
  updateTemplatePreviews();
}

function renderGameSuggestions(games) {
  gameSuggestions.innerHTML = "";
  if (!Array.isArray(games) || games.length === 0) {
    const li = document.createElement("li");
    li.className = "suggestion-item";
    li.textContent = chrome.i18n.getMessage("toastHistoryEmpty");
    gameSuggestions.appendChild(li);
    gameSuggestions.style.display = "block";
    return;
  }

  games.forEach((g) => {
    const li = document.createElement("li");
    li.className = "suggestion-item";

    const img = document.createElement("img");
    img.className = "suggestion-thumb";
    img.src = g.box_art_url.replace("{width}", "40").replace("{height}", "50");

    const span = document.createElement("span");
    span.textContent = g.name;

    li.appendChild(img);
    li.appendChild(span);

    li.addEventListener("click", () => {
      if (categoryUpdateInFlight) return;
      categoryUpdateInFlight = true;
      gameInput.disabled = true;
      gameSuggestions.style.display = "none";
      const titleTemplate = titleTemplateUses([
        "category", "category_hashtag", "tags", "tag_hashtags"
      ]) ? titleInput.value : null;
      chrome.runtime.sendMessage(
        { action: "updateCategory", game: g.name, gameId: g.id, titleTemplate },
        (res) => {
          categoryUpdateInFlight = false;
          gameInput.disabled = false;
          if (res && res.success) {
            setCategory(res.game_name || g.name, g.box_art_url, res.game_id || g.id);
            renderTags(res.tags || []);

            if (typeof res.title === "string") {
              currentStreamTitle = res.title;
              titleSyncState = "idle";
              updateTemplatePreviews();
            }

            if (res.tagSyncFailed) {
              showToast(chrome.i18n.getMessage("toastTagsUpdateFailed"), "error");
            } else if (res.isNew) {
              showToast(chrome.i18n.getMessage("toastNewCategoryAdded", g.name));
            } else {
              showToast(chrome.i18n.getMessage("toastCategorySwitched", g.name));
            }
          } else {
            if (currentGameName) {
              setCategory(currentGameName, currentGameBoxArtUrl, currentGameId);
            } else {
              gameInput.style.display = "block";
              gameInput.focus();
            }
            showToast(res?.error || chrome.i18n.getMessage("toastCategoryUpdateFailed"), "error");
          }
        }
      );
    });

    gameSuggestions.appendChild(li);
  });

  gameSuggestions.style.display = "block";
}
function closeSuggestions() {
  gameSuggestions.style.display = "none";
}

function requestSavedCategories() {
  const seq = ++searchSeq;
  chrome.runtime.sendMessage({ action: "getSavedCategories" }, (res) => {
    if (seq !== searchSeq) return;
    if (res && res.success) renderGameSuggestions(res.categories || []);
    else renderGameSuggestions([]);
  });
}

function requestCategorySearch(query) {
  const seq = ++searchSeq;
  chrome.runtime.sendMessage({ action: "searchCategories", query }, (res) => {
    if (seq !== searchSeq) return;
    if (res && res.success) renderGameSuggestions(res.games || []);
    else renderGameSuggestions([]);
  });
}

gameInput.addEventListener("input", () => {
  const q = gameInput.value.trim();
  if (searchTimer) {
    clearTimeout(searchTimer);
    searchTimer = null;
  }
  if (!q) {
    requestSavedCategories();
    return;
  }
  searchTimer = setTimeout(() => {
    requestCategorySearch(q);
  }, SEARCH_DEBOUNCE_MS);
});
gameInput.addEventListener("focus", () => {
  if (!gameInput.value.trim()) {
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }
    requestSavedCategories();
  }
});

function renderTagSuggestions(tags) {
  tagSuggestions.innerHTML = "";
  if (!Array.isArray(tags) || tags.length === 0) {
    closeTagSuggestions();
    return;
  }

  tags.forEach((tag) => {
    if (!tag || !tag.name) return;
    const li = document.createElement("li");
    li.className = "suggestion-item";
    li.textContent = tag.name || "";
    li.addEventListener("click", () => addTag(tag.name));
    tagSuggestions.appendChild(li);
  });

  tagSuggestions.style.display = "block";
}

function closeTagSuggestions() {
  tagSuggestions.style.display = "none";
}

function requestTagSearch(query) {
  const seq = ++tagSearchSeq;
  chrome.runtime.sendMessage({ action: "searchTags", query }, (res) => {
    if (seq !== tagSearchSeq) return;
    if (res && res.success) renderTagSuggestions(res.tags || []);
    else closeTagSuggestions();
  });
}

// ---- tags ----
function renderTags(tags) {
  currentTags = normalizeTagList(tags); // Use imported utility
  tagList.innerHTML = "";
  tagSection.style.display = "block";
  updateTemplatePreviews();
  if (currentTags.length === 0) return;

  currentTags.forEach((tag) => {
    const chip = document.createElement("span");
    chip.className = "tag-item";
    chip.textContent = tag.name;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "tag-remove";
    remove.textContent = "×";
    remove.setAttribute("aria-label", chrome.i18n.getMessage("removeTagButtonLabel", tag.name));
    remove.addEventListener("click", () => removeTag(tag));

    chip.appendChild(remove);
    tagList.appendChild(chip);
  });
}

function removeTag(tag) {
  const targetId = tag.id;
  const targetName = tag.name;
  const tags = currentTags.filter((t) => (targetId ? t.id !== targetId : t.name !== targetName));
  updateTags(tags);
}
function addTag(tag) {
  const entry = normalizeTagEntry(tag); // Use imported utility
  if (!entry || !entry.name) return;
  const exists = currentTags.some((t) =>
    (entry.id && t.id === entry.id) || t.name.toLowerCase() === entry.name.toLowerCase()
  );
  if (!exists) {
    const tags = currentTags.concat([{ id: entry.id || "", name: entry.name }]);
    updateTags(tags);
  }
  newTagInput.value = "";
  closeTagSuggestions();
}

addTagBtn.addEventListener("click", () => addTag(newTagInput.value));
newTagInput.addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addTag(newTagInput.value);
  }
});
function updateTags(tags) {
  const gameId = currentGameId || "__NO_CATEGORY__";
  const titleTemplate = titleTemplateUses(["tags", "tag_hashtags"])
    ? titleInput.value
    : null;
  chrome.runtime.sendMessage(
    { action: "updateTags", gameId, tags, titleTemplate },
    (res) => {
      if (res && res.success) {
        const resolved = Array.isArray(res.tags) ? res.tags : tags;
        renderTags(resolved);
        if (typeof res.title === "string") {
          currentStreamTitle = res.title;
          titleSyncState = "idle";
          updateTemplatePreviews();
        }
        if (res.syncFailed) {
          showToast(res.syncError || chrome.i18n.getMessage("toastTagsUpdateFailed"), "error");
        } else if (res.titleTemplateError) {
          showToast(res.titleTemplateError, "error");
        } else {
          showToast(chrome.i18n.getMessage("toastTagsUpdated"));
        }
      } else {
        showToast((res && res.error) || chrome.i18n.getMessage("toastTagsUpdateFailed"), "error");
      }
    }
  );
}

// ---- X投稿 ----
postToXBtn.addEventListener("click", () => {
  postToXBtn.disabled = true;
  chrome.runtime.sendMessage(
    {
      action: "postToX",
      text: customHashtags.value || "",
      includeCategory: includeCategoryTag.checked,
      excludeStreamUrl: excludeStreamUrl.checked,
    },
    (res) => {
      postToXBtn.disabled = false;
      if (res && res.success) showToast(chrome.i18n.getMessage("toastXPostOpened"), "success");
      else showToast(chrome.i18n.getMessage("toastXPostFailed"), "error");
    }
  );
});

// ---- 永続化 ----
customHashtags.addEventListener("input", () => {
  chrome.storage.local.set({ customHashtags: customHashtags.value });
  updateTemplatePreviews();
});
chrome.storage.local.get(["customHashtags"], (r) => {
  if (r && typeof r.customHashtags === "string") {
    customHashtags.value = r.customHashtags;
  }
  updateTemplatePreviews();
});

includeCategoryTag.addEventListener("change", () => {
  chrome.storage.local.set({ includeCategory: includeCategoryTag.checked });
  updateTemplatePreviews();
});
chrome.storage.local.get(["includeCategory"], (r) => {
  if (typeof r.includeCategory === "boolean") {
    includeCategoryTag.checked = r.includeCategory;
  }
  updateTemplatePreviews();
});

excludeStreamUrl.addEventListener("change", () => {
  chrome.storage.local.set({ excludeStreamUrl: excludeStreamUrl.checked });
  updateTemplatePreviews();
});
chrome.storage.local.get(["excludeStreamUrl"], (r) => {
  if (typeof r.excludeStreamUrl === "boolean") {
    excludeStreamUrl.checked = r.excludeStreamUrl;
  }
  updateTemplatePreviews();
});

// ---- login/logout ----
loginBtn.addEventListener("click", () => {
  loginBtn.disabled = true;
  chrome.runtime.sendMessage({ action: "authenticate" }, (res) => {
    loginBtn.disabled = false;
    if (res && res.success) {
      setAuthenticatedUI(true);
      showToast(chrome.i18n.getMessage("toastLoginSuccess"));

      chrome.runtime.sendMessage({ action: "getStreamInfo" }, (r) => {
        if (r && r.success) {
          currentStreamTitle = r.title || "";
          currentUserLogin = r.user_login || "";
          loadTitleTemplate(currentStreamTitle);

          if (r.game_name) {
            setCategory(r.game_name, r.game_thumbnail, r.game_id);
            currentGameId = r.game_id || "";
            currentGameName = r.game_name || "";
          }
          renderTags(r.tags || []);

          // ✅ 保存済みタグをTwitchに反映
          if (r.game_id) {
            chrome.storage.local.get(["savedTags"], (res2) => {
              const saved = res2.savedTags || {};
              if (saved[r.game_id]) {
                chrome.runtime.sendMessage(
                  { action: "updateTags", gameId: r.game_id, tags: saved[r.game_id] },
                  (updateRes) => {
                    if (updateRes && updateRes.success) {
                      const resolved = Array.isArray(updateRes.tags) ? updateRes.tags : saved[r.game_id];
                      renderTags(resolved);
                      if (updateRes.syncFailed) {
                        showToast(chrome.i18n.getMessage("toastTagsUpdateFailed"), "error");
                      } else {
                        showToast(chrome.i18n.getMessage("toastSavedTagsApplied"));
                      }
                    } else {
                      showToast(chrome.i18n.getMessage("toastTagsUpdateFailed"), "error");
                    }
                  }
                );
              }
            });
          }
          if (r.isNew) {
            showToast(chrome.i18n.getMessage("toastCurrentCategorySaved", r.game_name));
          }
        }
      });
    } else {
      showToast((res && res.error) || chrome.i18n.getMessage("toastLoginFailed"), "error");
    }
  });
});
logoutBtn.addEventListener("click", () => {
  logoutBtn.disabled = true;
  chrome.runtime.sendMessage({ action: "logout" }, () => {
    logoutBtn.disabled = false;
    setAuthenticatedUI(false);
    showToast(chrome.i18n.getMessage("toastLogoutSuccess"));

    closeSuggestions();
    closeTagSuggestions();
    titleInput.value = "";
    titleCount.textContent = "0/140";
    gameInput.value = "";
    selectedCategory.style.display = "none";
    gameThumbnail.style.display = "none";
    currentGameId = "";
    currentGameName = "";
    currentGameBoxArtUrl = "";
    currentStreamTitle = "";
    currentUserLogin = "";
    titleSyncState = "idle";
    renderTags([]);
    updateTemplatePreviews();
  });
});

// ---- initial ----
chrome.runtime.sendMessage({ action: "getStreamInfo" }, (r) => {
  if (r && r.success) {
    setAuthenticatedUI(true);

    currentStreamTitle = r.title || "";
    currentUserLogin = r.user_login || "";
    loadTitleTemplate(currentStreamTitle);

    if (r.game_name) {
      setCategory(r.game_name, r.game_thumbnail, r.game_id);
      currentGameId = r.game_id || "";
      currentGameName = r.game_name || "";
    }
    renderTags(r.tags || []);

    // ✅ 保存済みタグをTwitchに反映
    if (r.game_id) {
      chrome.storage.local.get(["savedTags"], (res2) => {
        const saved = res2.savedTags || {};
        if (saved[r.game_id]) {
          chrome.runtime.sendMessage(
            { action: "updateTags", gameId: r.game_id, tags: saved[r.game_id] },
            (updateRes) => {
              if (updateRes && updateRes.success) {
                const resolved = Array.isArray(updateRes.tags) ? updateRes.tags : saved[r.game_id];
                renderTags(resolved);
                if (updateRes.syncFailed) {
                  showToast(chrome.i18n.getMessage("toastTagsUpdateFailed"), "error");
                } else {
                  showToast(chrome.i18n.getMessage("toastSavedTagsApplied"));
                }
              } else {
                showToast(chrome.i18n.getMessage("toastTagsUpdateFailed"), "error");
              }
            }
          );
        }
      });
    }
    if (r.isNew) {
      showToast(chrome.i18n.getMessage("toastCurrentCategorySaved", r.game_name));
    }
  } else {
    setAuthenticatedUI(false);
  }
});

// ---- close suggestions ----
document.addEventListener("click", (e) => {
  if (!gameInput.contains(e.target) && gameSuggestions.style.display === "block") {
    closeSuggestions();
  }
  if (!newTagInput.contains(e.target) && !tagSuggestions.contains(e.target) && tagSuggestions.style.display === "block") {
    closeTagSuggestions();
  }
});
