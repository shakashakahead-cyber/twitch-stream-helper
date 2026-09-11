// Each broadcaster has an independent database; account switches never mix profiles.
export const DB_VERSION = 3;
export const SCHEMA = {
    streams: { keyPath: "streamId", indexes: { startedAt: "startedAt", status: "status", source: "source" } },
    viewerSamples: { keyPath: ["streamId", "timestamp"], indexes: { streamId: "streamId", timestamp: "timestamp" } },
    titleHistory: { keyPath: ["streamId", "timestamp"], indexes: { streamId: "streamId" } },
    categoryHistory: { keyPath: ["streamId", "timestamp"], indexes: { streamId: "streamId" } },
    chatterProfiles: { keyPath: "userId", indexes: { firstChatAt: "firstChatAt" } },
    streamChatters: { keyPath: ["streamId", "userId"], indexes: { streamId: "streamId", userId: "userId" } },
    followEvents: { keyPath: "id", indexes: { streamId: "streamId", followedAt: "followedAt" } },
    followerSnapshots: { keyPath: "id", indexes: { timestamp: "timestamp", day: "day" } },
    raidEvents: { keyPath: "id", indexes: { streamId: "streamId", timestamp: "timestamp" } },
    metadata: { keyPath: "key", indexes: {} },
    currentFollowers: { keyPath: ["generation", "userId"], indexes: { generation: "generation" } },
    eventIntervals: { keyPath: "id", indexes: { startedAt: "startedAt", lastSeenAt: "lastSeenAt" } },
    pendingEvents: { keyPath: "id", indexes: { timestamp: "timestamp" } },
    pendingSnapshots: { keyPath: "id", indexes: {} },
};

export function migrateDatabase(db, transaction, oldVersion) {
    // Additive migrations. Never clear historical stores during an upgrade.
    for (const [name, definition] of Object.entries(SCHEMA)) {
        const store = db.objectStoreNames.contains(name)
            ? transaction.objectStore(name)
            : db.createObjectStore(name, { keyPath: definition.keyPath });
        for (const [index, keyPath] of Object.entries(definition.indexes)) {
            if (!store.indexNames.contains(index)) store.createIndex(index, keyPath, { unique: false });
        }
    }
    transaction.objectStore("metadata").put({ key: "schemaVersion", value: DB_VERSION });
    if (oldVersion === 0) transaction.objectStore("metadata").put({ key: "createdAt", value: new Date().toISOString() });
    if (oldVersion > 0 && oldVersion < 3) {
        // v2 treated VOD duration as the exact live duration. Recover observed bounds;
        // never delete measurements or try to guess the origin of legacy chatters.
        const request = transaction.objectStore("streams").openCursor();
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return;
            const stream = cursor.value;
            stream.startedAtSource ||= stream.lastSeenLiveAt ? "live"
                : stream.source === "twitch_backfill" || stream.endedAtSource === "twitch_backfill" ? "vod" : "unknown";
            if (stream.source === "stream_helper" && stream.lastSeenLiveAt && stream.status === "ended" && stream.endedAtSource === "twitch_backfill") {
                const gap = Date.parse(stream.endUpperBound) - Date.parse(stream.lastSeenLiveAt);
                const bounded = gap >= 0 && gap <= 150000;
                stream.endedAt = bounded ? stream.endUpperBound : null;
                stream.duration = bounded ? Date.parse(stream.endedAt) - Date.parse(stream.startedAt) : null;
                stream.endedAtSource = bounded ? "poll_observation" : "unknown";
                stream.viewerCoverage = stream.duration && typeof stream.viewerSampleCount === "number"
                    ? Math.min(100, stream.viewerSampleCount / Math.ceil(stream.duration / 60000) * 100) : null;
                stream.eventCoverage = null; // Recomputed from persisted intervals by the collector.
            }
            cursor.update(stream);
            cursor.continue();
        };
        transaction.objectStore("metadata").put({ key: "reconcileAllEvents", value: true });
    }
}

export function requestResult(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export class AnalyticsDB {
    constructor(db) { this.db = db; this.timelineRevision = 0; }
    async transaction(names, mode, callback) {
        const tx = this.db.transaction(names, mode);
        const done = new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onabort = () => reject(tx.error || new Error("Analytics transaction aborted"));
            tx.onerror = () => {}; // onabort reports the failure once.
        });
        const stores = Object.fromEntries(names.map(name => [name, tx.objectStore(name)]));
        try {
            // Only IndexedDB requests may be awaited inside this callback.
            const result = await callback(stores);
            await done;
            if (mode === "readwrite" && names.includes("streams")) this.timelineRevision++;
            return result;
        } catch (error) {
            try { tx.abort(); } catch (_) { /* Already completed/aborted. */ }
            await done.catch(() => {});
            throw error;
        }
    }
    get(name, key) { return this.transaction([name], "readonly", s => requestResult(s[name].get(key))); }
    all(name, index, key) {
        return this.transaction([name], "readonly", s => requestResult(index
            ? s[name].index(index).getAll(key) : s[name].getAll()));
    }
    put(name, value) { return this.transaction([name], "readwrite", s => requestResult(s[name].put(value))); }
    async meta(key) { return (await this.get("metadata", key))?.value; }
    setMeta(key, value) { return this.put("metadata", { key, value }); }
    async timeline() {
        if (!this.timelineCache || this.timelineCache.revision !== this.timelineRevision) {
            const revision = this.timelineRevision;
            this.timelineCache = { revision, rows: await this.all("streams") };
        }
        return this.timelineCache.rows;
    }
    update(name, key, callback) {
        return this.transaction([name], "readwrite", async s => {
            const value = callback(await requestResult(s[name].get(key)));
            if (value) await requestResult(s[name].put(value));
            return value;
        });
    }
    close() { this.db.close(); }
}

const connections = new Map();
export function openAnalyticsDB(ownerId) {
    if (!/^\d+$/.test(ownerId)) return Promise.reject(new Error("Invalid analytics owner"));
    if (!connections.has(ownerId)) {
        const pending = new Promise((resolve, reject) => {
            const request = indexedDB.open(`twitch-stream-helper-analytics-${ownerId}`, DB_VERSION);
            let blocked = false;
            request.onupgradeneeded = event => migrateDatabase(request.result, request.transaction, event.oldVersion);
            request.onerror = () => reject(request.error);
            request.onblocked = () => { blocked = true; reject(new Error(chrome.i18n.getMessage("analyticsDbBlocked"))); };
            request.onsuccess = () => {
                const db = request.result;
                if (blocked) { db.close(); return; }
                db.onversionchange = () => { db.close(); connections.delete(ownerId); };
                resolve(new AnalyticsDB(db));
            };
        });
        connections.set(ownerId, pending);
        pending.catch(() => connections.delete(ownerId));
    }
    return connections.get(ownerId);
}
