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
