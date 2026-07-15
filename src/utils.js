// ==============================
// Twitch Stream Helper - utils.js
// ==============================

/**
 * Remove properties with undefined, null, or empty string values from an object.
 * @param {Object} obj 
 * @returns {Object}
 */
export function cleanBody(obj) {
    return Object.fromEntries(
        Object.entries(obj).filter(([_, v]) => v !== undefined && v !== null && v !== "")
    );
}

/**
 * Convert a category name to a hashtag (remove spaces, symbols).
 * @param {string} categoryName 
 * @returns {string}
 */
export function toHashtag(categoryName) {
    if (!categoryName) return "";
    return categoryName
        .trim()
        .replace(/\s+/g, "")              // Remove spaces
        .replace(/[^\p{L}\p{N}]/gu, "");  // Remove non-alphanumeric chars (Unicode aware)
}

export const TITLE_TEMPLATE_VARIABLES = Object.freeze([
    "category",
    "category_hashtag",
    "channel",
    "stream_url",
    "tags",
    "tag_hashtags",
    "date",
    "time",
]);

export const POST_TEMPLATE_VARIABLES = Object.freeze([
    "title",
    ...TITLE_TEMPLATE_VARIABLES,
]);

/**
 * Build the values available to title and X post templates.
 * @param {{title?: string, categoryName?: string, userLogin?: string, tags?: Array}} state
 * @param {Date} now
 * @returns {Object<string, string>}
 */
export function createTemplateVariables(state = {}, now = new Date()) {
    const category = String(state.categoryName || "");
    const channel = String(state.userLogin || "");
    const validNow = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
    const pad = (value) => String(value).padStart(2, "0");

    const tagNames = Array.isArray(state.tags)
        ? state.tags
            .map((tag) => typeof tag === "string" ? tag : tag?.name || tag?.label || tag?.tag || "")
            .map((name) => String(name).trim())
            .filter(Boolean)
        : [];
    const tagHashtags = tagNames
        .map(toHashtag)
        .filter(Boolean)
        .map((tag) => `#${tag}`);
    const categoryHashtag = toHashtag(category);

    return {
        title: String(state.title || ""),
        category,
        category_hashtag: categoryHashtag ? `#${categoryHashtag}` : "",
        channel,
        stream_url: channel ? `https://www.twitch.tv/${channel}` : "",
        tags: tagNames.join(", "),
        tag_hashtags: tagHashtags.join(" "),
        date: `${validNow.getFullYear()}-${pad(validNow.getMonth() + 1)}-${pad(validNow.getDate())}`,
        time: `${pad(validNow.getHours())}:${pad(validNow.getMinutes())}`,
    };
}

/**
 * Replace known {variable_name} placeholders. Unknown placeholders are kept.
 * @param {string} template
 * @param {Object<string, string>} variables
 * @returns {string}
 */
export function applyTemplate(template, variables = {}) {
    return String(template || "").replace(/\{([a-z][a-z0-9_]*)\}/g, (match, name) => {
        if (!Object.prototype.hasOwnProperty.call(variables, name)) return match;
        return String(variables[name] ?? "");
    });
}

/**
 * Compose the final X post while preserving the legacy automatic title/URL behavior.
 * Explicit {title}, {stream_url}, or {category_hashtag} placeholders prevent duplicates.
 * @param {{template?: string, variables?: Object<string, string>, includeCategory?: boolean, includeStreamUrl?: boolean, maxLength?: number}} options
 * @returns {string}
 */
export function composeXPost({
    template = "",
    variables = {},
    includeCategory = false,
    includeStreamUrl = true,
    maxLength = 280,
} = {}) {
    const source = String(template || "");
    const effectiveVariables = includeStreamUrl
        ? variables
        : { ...variables, stream_url: "" };
    const parts = [];

    if (!source.includes("{title}") && effectiveVariables.title) {
        parts.push(String(effectiveVariables.title));
    }

    let custom = applyTemplate(source, effectiveVariables).trim();
    if (includeCategory && !source.includes("{category_hashtag}") && effectiveVariables.category_hashtag) {
        custom = `${custom ? `${custom}\n` : ""}${effectiveVariables.category_hashtag}`;
    }
    if (custom) parts.push(custom);

    if (includeStreamUrl && !source.includes("{stream_url}") && effectiveVariables.stream_url) {
        parts.push(String(effectiveVariables.stream_url));
    }

    let text = parts.join("\n");
    if (maxLength > 0 && text.length > maxLength) {
        text = `${text.slice(0, maxLength - 1)}…`;
    }
    return text;
}

/**
 * Base64 URL encode a byte array.
 * @param {Uint8Array|number[]} bytes 
 * @returns {string}
 */
export function base64UrlEncodeBytes(bytes) {
    let binary = "";
    for (const b of bytes) {
        binary += String.fromCharCode(b);
    }
    return btoa(binary)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

/**
 * Normalize a single tag entry.
 * @param {string|Object} tag 
 * @returns {{id: string, name: string}|null}
 */
export function normalizeTagEntry(tag) {
    if (!tag) return null;
    if (typeof tag === "string") {
        const name = tag.trim();
        return name ? { id: "", name } : null; // Name is primary for Search/Input
    }
    if (typeof tag === "object") {
        const id = String(tag.id || tag.tag_id || "").trim();
        let name = String(tag.name || tag.label || tag.tag || "").trim();
        if (!name && id) name = id;
        if (!id && !name) return null;
        return { id, name };
    }
    return null;
}

/**
 * Normalize a list of tags.
 * @param {Array} tags 
 * @returns {Array<{id: string, name: string}>}
 */
export function normalizeTagList(tags) {
    if (!Array.isArray(tags)) return [];
    return tags.map(normalizeTagEntry).filter((t) => t && t.name);
}

/**
 * Normalize tag entries (alias for normalizeTagList basically, ensuring array).
 * @param {Array} tags 
 * @returns {Array}
 */
export function normalizeTagEntries(tags) {
    return normalizeTagList(tags);
}

/**
 * Map tags to resolved format (mainly to match background.js logic).
 * Since we don't have a global catalog, we basically pass them through.
 * @param {Array} tagEntries 
 * @returns {Promise<{resolved: Array, missing: Array}>}
 */
export async function mapTags(tagEntries) {
    const resolved = [];
    for (const entry of tagEntries) {
        if (entry && entry.name) {
            resolved.push({ id: entry.name, name: entry.name });
        }
    }
    return { resolved, missing: [] };
}

/**
 * Extract tag IDs (or names) for Twitch API.
 * @param {Array} tags 
 * @returns {Array<string>}
 */
export function toTagIds(tags) {
    if (!Array.isArray(tags)) return [];
    return tags.map((tag) => {
        if (typeof tag === "string") return tag;
        return tag.name || tag.id;
    }).filter(Boolean);
}
