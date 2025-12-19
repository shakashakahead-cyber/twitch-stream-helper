// ==============================
// Twitch Stream Helper - popup.js
// ==============================

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
  ["placeholder","title","aria-label"].forEach(attr => {
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

const titleInput = document.getElementById("streamTitle");
const titleCount = document.getElementById("titleCount");

const gameInput = document.getElementById("game");
const gameThumbnail = document.getElementById("gameThumbnail");
const gameSuggestions = document.getElementById("gameSuggestions");
const selectedCategory = document.getElementById("selectedCategory");

const tagSection = document.getElementById("tagSection");
const tagList = document.getElementById("tagList");
const newTagInput = document.getElementById("newTag");
const addTagBtn = document.getElementById("addTag");

const customHashtags = document.getElementById("customHashtags");
const includeCategoryTag = document.getElementById("includeCategoryTag");
const postToXBtn = document.getElementById("postToX");

const toast = document.getElementById("toast");

let currentGameId = "";
let currentGameName = "";

const SEARCH_DEBOUNCE_MS = 250;
let searchTimer = null;
let searchSeq = 0;

// ---- toast ----
function showToast(message, type = "success") {
  toast.textContent = message;

  toast.classList.remove("success", "error", "show");
  toast.classList.add(type, "show");

  setTimeout(() => {
    toast.classList.remove("show");
  }, 2500);
}

// ---- title ----
titleInput.addEventListener("input", () => {
  titleCount.textContent = `${titleInput.value.length}/140`;
});
titleInput.addEventListener("change", () => {
  chrome.runtime.sendMessage({ action: "updateTitle", title: titleInput.value }, (res) => {
    // i18n
    if (res && res.success) showToast(chrome.i18n.getMessage("toastTitleUpdated"));
    else showToast(chrome.i18n.getMessage("toastTitleUpdateFailed"), "error");
  });
});

// ---- category ----
function setCategory(name, boxArtUrlTemplate, id = "") {
  currentGameName = name;
  currentGameId = id || "";

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
    // i18n
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

  const removeBtn = document.createElement("span");
  removeBtn.className = "remove-btn";
  removeBtn.textContent = "×";
  selectedCategory.appendChild(removeBtn);

  removeBtn.addEventListener("click", () => {
    selectedCategory.style.display = "none";
    gameInput.style.display = "block";
    gameInput.value = "";
    gameThumbnail.style.display = "none";
    currentGameName = "";
    currentGameId = "";
    renderTags([]);
  });

  tagSection.style.display = "block";
}

function renderGameSuggestions(games) {
  gameSuggestions.innerHTML = "";
  if (!Array.isArray(games) || games.length === 0) {
    const li = document.createElement("li");
    li.className = "suggestion-item";
    // i18n
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
      setCategory(g.name, g.box_art_url, g.id);
      gameSuggestions.style.display = "none";
      chrome.runtime.sendMessage(
        { action: "updateCategory", game: g.name, gameId: g.id },
        (res) => {
          if (res && res.success) {
            currentGameId = res.game_id || g.id;
            currentGameName = res.game_name || g.name;
            renderTags(res.tags || []);
            // i18n
            if (res.tagSyncFailed) {
              showToast(chrome.i18n.getMessage("toastTagsUpdateFailed"), "error");
            } else if (res.isNew) {
              showToast(chrome.i18n.getMessage("toastNewCategoryAdded", g.name));
            } else {
              showToast(chrome.i18n.getMessage("toastCategorySwitched", g.name));
            }
          } else {
            // i18n
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

// ---- tags ----
function renderTags(tags) {
  tagList.innerHTML = "";
  tagSection.style.display = "block";
  if (!Array.isArray(tags) || tags.length === 0) return;

  tags.forEach((tag) => {
    const chip = document.createElement("span");
    chip.className = "tag-item";
    chip.textContent = tag;

    const remove = document.createElement("span");
    remove.className = "tag-remove";
    remove.textContent = "×";
    remove.addEventListener("click", () => removeTag(tag));

    chip.appendChild(remove);
    tagList.appendChild(chip);
  });
}

function removeTag(tag) {
  const tags = Array.from(tagList.querySelectorAll(".tag-item"))
    .map((el) => el.textContent.replace("×", "").trim())
    .filter((t) => t !== tag);
  updateTags(tags);
}
function addTag(tag) {
  const t = String(tag || "").trim();
  if (!t) return;
  const tags = Array.from(tagList.querySelectorAll(".tag-item"))
    .map((el) => el.textContent.replace("×", "").trim());
  if (!tags.includes(t)) {
    tags.push(t);
    updateTags(tags);
  }
  newTagInput.value = "";
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
  chrome.runtime.sendMessage(
    { action: "updateTags", gameId, tags },
    (res) => {
      // i18n
      if (res && res.success) {
        renderTags(tags);
        if (res.syncFailed) {
          showToast(chrome.i18n.getMessage("toastTagsUpdateFailed"), "error");
        } else {
          showToast(chrome.i18n.getMessage("toastTagsUpdated"));
        }
      } else {
        showToast(chrome.i18n.getMessage("toastTagsUpdateFailed"), "error");
      }
    }
  );
}

// ---- X投稿 ----
postToXBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage(
    {
      action: "postToX",
      text: customHashtags.value || "",
      includeCategory: includeCategoryTag.checked,
      currentCategory: currentGameName,
    },
    (res) => {
      // i18n
      if (res && res.success) showToast(chrome.i18n.getMessage("toastXPostOpened"), "success");
      else showToast(chrome.i18n.getMessage("toastXPostFailed"), "error");
    }
  );
});

// ---- 永続化 ----
customHashtags.addEventListener("input", () => {
  chrome.storage.local.set({ customHashtags: customHashtags.value });
});
chrome.storage.local.get(["customHashtags"], (r) => {
  if (r && typeof r.customHashtags === "string") {
    customHashtags.value = r.customHashtags;
  }
});

includeCategoryTag.addEventListener("change", () => {
  chrome.storage.local.set({ includeCategory: includeCategoryTag.checked });
});
chrome.storage.local.get(["includeCategory"], (r) => {
  if (typeof r.includeCategory === "boolean") {
    includeCategoryTag.checked = r.includeCategory;
  }
});

// ---- login/logout ----
loginBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "authenticate" }, (res) => {
    if (res && res.success) {
      loginBtn.style.display = "none";
      logoutBtn.style.display = "inline-block";
      mainUI.style.display = "block";
      // i18n
      showToast(chrome.i18n.getMessage("toastLoginSuccess"));

      chrome.runtime.sendMessage({ action: "getStreamInfo" }, (r) => {
        if (r && r.success) {
          titleInput.value = r.title || "";
          titleCount.textContent = `${titleInput.value.length}/140`;

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
                      renderTags(saved[r.game_id]);
                      // i18n
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
          // i18n
          if (r.isNew) {
            showToast(chrome.i18n.getMessage("toastCurrentCategorySaved", r.game_name));
          }
        }
      });
    } else {
      // i18n
      showToast((res && res.error) || chrome.i18n.getMessage("toastLoginFailed"), "error");
    }
  });
});
logoutBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "logout" }, () => {
    loginBtn.style.display = "inline-block";
    logoutBtn.style.display = "none";
    mainUI.style.display = "none";
    // i18n
    showToast(chrome.i18n.getMessage("toastLogoutSuccess"));

    closeSuggestions();
    titleInput.value = "";
    titleCount.textContent = "0/140";
    gameInput.value = "";
    selectedCategory.style.display = "none";
    gameThumbnail.style.display = "none";
    currentGameId = "";
    currentGameName = "";
    renderTags([]);
  });
});

// ---- initial ----
chrome.runtime.sendMessage({ action: "getStreamInfo" }, (r) => {
  if (r && r.success) {
    loginBtn.style.display = "none";
    logoutBtn.style.display = "inline-block";
    mainUI.style.display = "block";

    titleInput.value = r.title || "";
    titleCount.textContent = `${titleInput.value.length}/140`;

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
              renderTags(saved[r.game_id]);
              // i18n
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
    // i18n
    if (r.isNew) {
      showToast(chrome.i18n.getMessage("toastCurrentCategorySaved", r.game_name));
    }
  } else {
    loginBtn.style.display = "inline-block";
    logoutBtn.style.display = "none";
    mainUI.style.display = "none";
  }
});

// ---- close suggestions ----
document.addEventListener("click", (e) => {
  if (!gameInput.contains(e.target) && gameSuggestions.style.display === "block") {
    closeSuggestions();
  }
});
