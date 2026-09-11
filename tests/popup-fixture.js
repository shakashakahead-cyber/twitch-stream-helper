// Run the actual popup DOM/script with local, synthetic responses for visual regression checks.
const query = new URLSearchParams(location.search), lang = query.get("lang") || "ja";
const messages = await (await fetch(`/_locales/${lang}/messages.json`)).json();
const storage = { titleTemplate: "{category} | 今夜ものんびり配信", customHashtags: "{title} {stream_url}" };
let loggedIn = query.get("fixture") === "in";
const commentSettings = { message: "", autoPost: false, pin: true, durationSeconds: 0, categoryMessages: {}, ownerId: "42" };
globalThis.chrome = {
    i18n: { getMessage(key, values = []) {
        let message = messages[key]?.message || key;
        const replacements = Array.isArray(values) ? values : [values];
        for (const [name, value] of Object.entries(messages[key]?.placeholders || {})) message = message.replaceAll(`$${name}$`, replacements[Number(value.content.slice(1)) - 1] || "");
        return message;
    } },
    runtime: { getURL: file => `${location.origin}/${file}`, sendMessage({ action }, callback) {
        let response = { success: true };
        if (action === "authenticate") loggedIn = true;
        if (action === "logout") loggedIn = false;
        if (action === "getStreamInfo") response = loggedIn ? { success: true, title: "Test stream", user_login: "synthetic", game_id: "1", game_name: "VALORANT", tags: [] } : { success: false };
        if (action === "getPinnedCommentSettings") response = { success: true, settings: commentSettings, canSend: true, canPin: true, status: null };
        if (action === "getSavedCategories") response = { success: true, categories: [{ id: "1", name: "VALORANT" }] };
        queueMicrotask(() => callback?.(response));
    } },
    tabs: { create() {
        const result = document.createElement("p"); result.textContent = "QA: Analytics tab request received"; document.body.append(result);
    } },
    storage: { onChanged: { addListener() {} }, local: {
        get(keys, callback) { queueMicrotask(() => callback(Object.fromEntries(keys.filter(key => key in storage).map(key => [key, storage[key]])))); },
        set(value, callback) { Object.assign(storage, value); callback?.(); },
    } },
};
await import("../popup.js");
document.dispatchEvent(new Event("DOMContentLoaded"));
