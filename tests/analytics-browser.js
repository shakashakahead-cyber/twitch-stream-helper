import { openAnalyticsDB, AnalyticsDB, requestResult } from "../src/analytics/db.js";
import { mergeVideos, backfillStep, requestBackfill, scheduleBackfill, runBackfill, BACKFILL_MAX_PAGES } from "../src/analytics/backfill.js";
import { recordChat, recordHistory, refreshSummary, collectStream, receiveEvent, reconcileEvents, collectAnalytics,
    enableAnalytics, stopAnalytics, withAnalyticsLock, reconcilePendingEvents } from "../src/analytics/collector.js";
import { iso, DAY_MS, classifyFollow } from "../src/analytics/aggregator.js";
import { CLIENT_ID } from "../src/config.js";

const parameters = new URLSearchParams(location.search), mode = parameters.get("mode") || "tests";
const language = parameters.get("lang") === "ja" ? "ja" : "en";
const realFetch = globalThis.fetch.bind(globalThis);
const messages = await (await realFetch(`../_locales/${language}/messages.json`)).json();
const storage = {}, calls = [], alarms = new Map();
let apiHandler;
globalThis.chrome = {
    i18n: { getUILanguage: () => language, getMessage: (key, substitutions = []) => {
        let value = messages[key]?.message || key;
        for (const [name, definition] of Object.entries(messages[key]?.placeholders || {})) {
            value = value.replaceAll(`$${name.toUpperCase()}$`, String(substitutions[Number(definition.content.slice(1)) - 1] ?? ""));
        }
        return value;
    } },
    runtime: { async sendMessage({ action }) {
        if (action === "analyticsDisable") storage.analyticsSettings.enabled = false;
        if (action === "analyticsEnable") storage.analyticsSettings.enabled = true;
        return { success: true };
    } },
    storage: { local: {
        get(keys, callback) { const data = Object.fromEntries(keys.filter(key => key in storage).map(key => [key, structuredClone(storage[key])])); if (callback) queueMicrotask(() => callback(data)); else return Promise.resolve(data); },
        set(value, callback) { Object.assign(storage, structuredClone(value)); if (callback) queueMicrotask(callback); else return Promise.resolve(); },
        remove(keys, callback) { keys.forEach(key => delete storage[key]); if (callback) queueMicrotask(callback); else return Promise.resolve(); },
    } },
    alarms: { async get(name) { return alarms.get(name); }, async create(name, config) { alarms.set(name, config); }, async clear(name) { alarms.delete(name); } },
};
globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith("https://")) return realFetch(url, options);
    const parsed = new URL(url); calls.push({ path: parsed.pathname, query: parsed.searchParams, method: options?.method || "GET" });
    if (apiHandler) { const result = await apiHandler(parsed, options); if (result) return result; }
    if (parsed.pathname === "/oauth2/validate") return Response.json({ client_id: CLIENT_ID, user_id: storage.analyticsSettings?.ownerId || "999001", scopes: ["moderator:read:followers", "user:read:chat"], expires_in: 3600 });
    if (parsed.pathname === "/helix/channels/followers") return Response.json({ data: [], total: 27, pagination: {} });
    if (parsed.pathname === "/helix/videos") return Response.json({ data: [], pagination: {} });
    if (parsed.pathname === "/helix/streams") return Response.json({ data: [] });
    throw new Error(`Unexpected test request: ${parsed.pathname}`);
};
storage.accessToken = "synthetic-test-token";
// No test can open a real Twitch socket.
globalThis.WebSocket = class {
    close() { this.onclose?.(); }
};
const owner = String(Math.floor(Date.now() / 10));
const db = await openAnalyticsDB(owner);
storage.analyticsSettings = { enabled: true, ownerId: owner };
const start = "2026-09-01T23:00:00.000Z", at = minutes => iso(Date.parse(start) + minutes * 60000);
const assert = (value, message) => { if (!value) throw new Error(message); };
const tests = [];
const test = (name, callback) => tests.push([name, callback]);
test("Real IndexedDB migration preserves legacy notes and adds stores/indexes", async () => {
    const migrationOwner = `${owner}7`;
    const request = indexedDB.open(`twitch-stream-helper-analytics-${migrationOwner}`, 1);
    request.onupgradeneeded = () => { const store = request.result.createObjectStore("streams", { keyPath: "streamId" }); store.put({ streamId: "legacy", note: "keep me", labels: ["existing"] }); };
    const legacy = await requestResult(request); legacy.close();
    const upgraded = await openAnalyticsDB(migrationOwner);
    assert((await upgraded.get("streams", "legacy")).note === "keep me", "migration lost note");
    assert((await upgraded.all("streams", "status", "live")).length === 0, "missing status index");
    assert(upgraded.db.objectStoreNames.contains("eventIntervals"), "missing new store");
    assert(await upgraded.meta("schemaVersion") === 3, "schema version");
});
test("IndexedDB abort rolls back both stores", async () => {
    try {
        await db.transaction(["streams", "metadata"], "readwrite", async stores => {
            await requestResult(stores.streams.put({ streamId: "rollback" }));
            await requestResult(stores.metadata.put({ key: "rollback", value: 1 }));
            throw new Error("intentional rollback");
        });
    } catch (_) { /* Expected. */ }
    assert(!await db.get("streams", "rollback") && !await db.meta("rollback"), "transaction did not roll back");
});
test("VOD deduplication, annotations and measured data survive repeated import", async () => {
    const video = { id: "v1", stream_id: "archive", created_at: start, duration: "1h", title: "VOD", view_count: 5 };
    await mergeVideos(db, [video, { ...video, id: "v2", duration: "2h" }]);
    assert((await db.all("streams")).length === 1, "duplicate stream");
    assert((await db.get("streams", "archive")).duration === 7200000, "longest archive duration");
    await db.update("streams", "archive", row => ({ ...row, source: "stream_helper", avgViewers: 12, note: "keep", labels: ["コラボ"] }));
    await mergeVideos(db, [video]);
    const result = await db.get("streams", "archive");
    assert(result.avgViewers === 12 && result.note === "keep" && result.labels[0] === "コラボ", "backfill replaced measurements/notes");
});
test("VOD and follower pagination resume across DB connections; histories stay separate", async () => {
    await db.setMeta("syncJobs", null);
    await db.setMeta("backfill", { phase: "videos", cursor: "", generation: "snapshot-one" });
    apiHandler = parsed => {
        if (parsed.pathname === "/helix/videos") return Response.json({ data: [{ id: "v3", stream_id: "paged", created_at: start, duration: "5m", title: "Paged" }], pagination: parsed.searchParams.get("after") ? {} : { cursor: "v-next" } });
        if (parsed.pathname === "/helix/channels/followers") return Response.json({ total: 2, data: [{ user_id: parsed.searchParams.get("after") ? "u2" : "u1", followed_at: start }], pagination: parsed.searchParams.get("after") ? {} : { cursor: "f-next" } });
    };
    await backfillStep(db, owner); assert((await db.meta("backfill")).cursor === "v-next", "video checkpoint");
    const restarted = new AnalyticsDB(db.db);
    await backfillStep(restarted, owner); assert((await db.meta("backfill")).phase === "followers", "next phase");
    await backfillStep(restarted, owner); assert(!await db.meta("followerGeneration"), "partial snapshot became current");
    await backfillStep(restarted, owner);
    assert((await db.all("currentFollowers", "generation", "snapshot-one")).length === 2, "missing follower pages");
    assert((await db.all("followEvents")).length === 0, "backfill counted as live follows");
    assert((await db.meta("backfill")).phase === "complete", "not complete");
    apiHandler = null;
});
test("Chat deduplication is atomic, excludes broadcaster and survives worker-like restart", async () => {
    await Promise.all([recordChat(db, "s1", "user1", at(1), owner), recordChat(db, "s1", "user1", at(2), owner)]);
    await recordChat(db, "s1", owner, at(2), owner);
    assert((await db.all("streamChatters", "streamId", "s1")).length === 1, "duplicate or broadcaster counted");
    await recordChat(new AnalyticsDB(db.db), "s2", "user1", at(130), owner);
    const profile = await db.get("chatterProfiles", "user1");
    assert(profile.streamCount === 2 && profile.firstStreamId === "s1", "restart lost profile");
    assert((await db.get("streamChatters", ["s2", "user1"])).kind === "returning", "wrong return classification");
    await recordChat(db, "earlier", "user1", at(-10), owner);
    assert((await db.get("streamChatters", ["s1", "user1"])).kind === "returning", "out-of-order earlier visit not corrected");
    assert(!("message" in profile) && !("userName" in profile), "personal content stored");
});
test("Sampling, metadata events, pending chat, follow and raid dedupe, finalization", async () => {
    const live = { id: "live-test", started_at: at(200), title: "Title A", game_id: "1", game_name: "Category A", viewer_count: 2 };
    await collectStream(db, owner, live, Date.parse(at(201)));
    await collectStream(db, owner, { ...live, viewer_count: 100 }, Date.parse(at(201.2)));
    await db.put("eventIntervals", { id: "events", startedAt: at(201), lastSeenAt: at(204), types: ["channel.chat.message", "channel.follow", "channel.raid", "channel.update"] });
    await receiveEvent(db, owner, { type: "channel.chat.message", id: "chat", broadcasterId: owner, userId: "new-user", timestamp: at(201.5) });
    assert((await db.all("pendingEvents")).length === 1, "unconfirmed live chat not deferred");
    await collectStream(db, owner, { ...live, viewer_count: 6 }, Date.parse(at(202)));
    assert((await db.all("viewerSamples", "streamId", live.id)).length === 2, "duplicate minute sample");
    assert((await db.all("streamChatters", "streamId", live.id)).length === 1, "pending chat not counted");
    const follow = { type: "channel.follow", id: "follow", broadcasterId: owner, userId: "follower", timestamp: at(201.8), followedAt: at(201.8) };
    await receiveEvent(db, owner, follow); await receiveEvent(db, owner, { ...follow, id: "redelivery" });
    const raid = { type: "channel.raid", id: "raid", broadcasterId: owner, timestamp: at(201.8), fromBroadcasterId: "123", fromBroadcasterName: "Raider", viewers: 9 };
    await receiveEvent(db, owner, raid); await receiveEvent(db, owner, raid);
    await receiveEvent(db, owner, { type: "channel.update", id: "title", broadcasterId: owner, timestamp: at(201.9), title: "Title B", categoryId: "2", categoryName: "Category B" });
    await collectStream(db, owner, null, Date.parse(at(203)));
    const ended = await db.get("streams", live.id);
    assert(ended.status === "ended" && ended.avgViewers === 4 && ended.peakViewers === 6, "bad stream summary");
    assert(ended.firstChatters === 1 && ended.uniqueChatters === 1, "bad chatter summary");
    assert(ended.newFollows === 1 && ended.raidCount === 1 && ended.raidViewers === 9, "duplicate events counted");
    assert(ended.finalTitle === "Title A" && ended.finalCategoryId === "1", "late update overrode a newer poll");
    const titles = await db.all("titleHistory", "streamId", live.id);
    assert(titles.some(row => row.title === "Title B" && row.timestamp === at(201.9)), "late update missing from history");
    assert(titles.some(row => row.title === "Title A" && row.timestamp === at(202)), "newer poll observation missing from history");
    assert(ended.followerCountStart === 27 && ended.followerCountEnd === 27, "missing follower snapshots");
    assert(Math.abs(ended.viewerCoverage - 200 / 3) < 0.01, "incorrect sample coverage");
    assert(await db.meta("latestEndedStreamId") === live.id, "missing recap pointer");
});
test("Sleep gap leaves end metrics unknown", async () => {
    const live = { id: "sleep-test", started_at: at(400), title: "Sleep", game_id: "1", game_name: "A", viewer_count: 3 };
    await collectStream(db, owner, live, Date.parse(at(401)));
    await collectStream(db, owner, null, Date.parse(at(600)));
    const result = await db.get("streams", live.id);
    assert(result.endedAt === null && result.duration === null && result.viewerCoverage === null, "fabricated sleep end/duration");
    assert(result.avgViewers === 3 && result.followerCountEnd === null, "lost sample or fabricated end follower count");
});
test("Network error never finalizes a live stream; 429 waits without another request", async () => {
    const now = Date.now();
    await collectStream(db, owner, { id: "network", started_at: iso(now - 60000), title: "Network", game_id: "1", game_name: "A", viewer_count: 2 }, now);
    apiHandler = parsed => { if (parsed.pathname === "/helix/streams") throw new Error("offline network"); };
    await collectAnalytics();
    assert((await db.get("streams", "network")).status === "live", "network failure finalized stream");
    apiHandler = parsed => parsed.pathname === "/helix/streams" ? new Response("slow down", { status: 429, headers: { "Ratelimit-Reset": String(Math.ceil((Date.now() + 120000) / 1000)) } }) : undefined;
    await collectAnalytics(); const afterLimit = calls.length;
    await collectAnalytics(); assert(calls.length === afterLimit, "429 retried immediately");
    assert((await db.meta("health:poll")).state === "rate_limited", "no rate-limit status");
    apiHandler = null;
});
test("EventSub startup failure cannot suppress a stream, and poll errors preserve the last success", async () => {
    await stopAnalytics();
    storage.analyticsSettings = { enabled: true, ownerId: owner };
    await db.setMeta("retryAt", 0);
    const originalSocket = globalThis.WebSocket;
    globalThis.WebSocket = class { constructor() { throw new Error("socket unavailable"); } };
    const now = Date.now();
    apiHandler = parsed => parsed.pathname === "/helix/streams" ? Response.json({ data: [
        { id: "socket-failure", started_at: iso(now - 60000), title: "Still recording", game_id: "1", game_name: "A", viewer_count: 7 },
    ] }) : undefined;
    try {
        await collectAnalytics();
        const stream = await db.get("streams", "socket-failure"), poll = await db.meta("health:poll");
        assert(stream?.status === "live" && stream.avgViewers === 7, "socket failure prevented recording");
        assert(poll.state === "ok" && poll.lastResult === "live" && poll.lastSuccessAt, "missing successful poll diagnostics");
        assert((await db.meta("health:events")).state === "disconnected", "missing event warning");
        apiHandler = parsed => { if (parsed.pathname === "/helix/streams") throw new Error("network failure"); };
        await collectAnalytics();
        const failed = await db.meta("health:poll");
        assert(failed.state === "error" && failed.lastSuccessAt === poll.lastSuccessAt && failed.lastResult === "live", "failure erased last successful observation");
        assert((await db.get("streams", "socket-failure")).status === "live", "failure fabricated an offline observation");
        apiHandler = null; await collectAnalytics();
        assert((await db.meta("health:poll")).lastResult === "offline", "offline observation not recorded");
    } finally {
        await stopAnalytics(); globalThis.WebSocket = originalSocket; apiHandler = null;
        storage.analyticsSettings = { enabled: true, ownerId: owner };
    }
});

test("Expired auth and account mismatch cannot collect into the wrong database", async () => {
    await db.setMeta("retryAt", 0);
    delete storage.accessToken;
    const before = calls.length;
    await collectAnalytics();
    assert(calls.length === before && (await db.meta("health:auth")).state === "auth_error", "missing token still made requests");
    storage.accessToken = "different-synthetic-token";
    apiHandler = parsed => parsed.pathname === "/oauth2/validate" ? Response.json({ client_id: CLIENT_ID, user_id: "999999999", scopes: ["moderator:read:followers", "user:read:chat"], expires_in: 3600 }) : undefined;
    await collectAnalytics();
    assert(calls.length === before + 1 && (await db.meta("health:auth")).state === "auth_error", "account mismatch collected data");
    apiHandler = null;
});

test("Unexpected collector failures remain visible and clear after recovery", async () => {
    const originalMeta = db.meta;
    db.meta = async function (key) {
        if (key === "retryAt") throw new Error("metadata read failed");
        return originalMeta.call(this, key);
    };
    let rejected = false;
    try { await collectAnalytics(); } catch (_) { rejected = true; }
    finally { db.meta = originalMeta; }
    assert(rejected && (await db.meta("health:collector")).state === "error", "unexpected failure was hidden");
    storage.accessToken = "recovered-synthetic-token";
    await collectAnalytics();
    assert((await db.meta("health:collector")).state === "ok", "collector error did not clear");
});
test("A VOD confirms its recorded range without fabricating a sleep-gap end", async () => {
    await db.put("followEvents", { id: "uncertain", followedAt: at(430), userId: "u9", streamId: null, duringStream: null });
    await mergeVideos(db, [{ id: "sleep-vod", stream_id: "sleep-test", created_at: at(400), duration: "1h", title: "Archive title" }]);
    await reconcileEvents(db); await refreshSummary(db, "sleep-test");
    const stream = await db.get("streams", "sleep-test"), follow = await db.get("followEvents", "uncertain");
    assert(stream.duration === null && stream.endedAtSource === "unknown" && stream.vodDuration === 3600000, "VOD overwrote unknown live duration");
    assert(follow.duringStream === true && follow.streamId === "sleep-test", "follow not reclassified");
    assert(stream.finalTitle === "Sleep", "archive replaced measured title");
});
test("Account data is isolated; stop preserves history and clears collection alarm", async () => {
    const other = await openAnalyticsDB(`${owner}8`);
    assert((await other.all("streams")).length === 0 && (await other.all("chatterProfiles")).length === 0, "account leak");
    await enableAnalytics({ userId: owner, scopes: ["moderator:read:followers", "user:read:chat"] });
    assert(alarms.get("analytics-collect").periodInMinutes === 1, "missing one-minute alarm");
    await stopAnalytics();
    assert(!storage.analyticsSettings.enabled && !alarms.has("analytics-collect"), "stop did not disable");
    assert((await db.all("streams")).length > 0, "stop erased history");
});


test("VOD fragments cannot shorten a measured broadcast or erase other recordings", async () => {
    const local = await openAnalyticsDB(`${owner}20`);
    await local.put("streams", { streamId: "measured", source: "stream_helper", status: "ended", startedAt: at(0),
        lastSeenLiveAt: at(119), endLowerBound: at(119), endUpperBound: at(120), endedAt: at(120),
        endedAtSource: "poll_observation", duration: 7200000, note: "keep", labels: ["keep"] });
    await mergeVideos(local, [{ id: "short", stream_id: "measured", created_at: at(0), duration: "1h", title: "short" },
        { id: "fragment", stream_id: "measured", created_at: at(90), duration: "20m", title: "later" }]);
    const result = await local.get("streams", "measured");
    assert(result.duration === 7200000 && result.endedAt === at(120) && result.endedAtSource === "poll_observation", "VOD replaced live bounds");
    assert(result.vods.length === 2 && result.note === "keep", "lost fragment or annotation");
});

test("Pending chat/update survive missing stream information and recover from a later VOD", async () => {
    const local = await openAnalyticsDB(`${owner}21`);
    await local.put("pendingEvents", { id: "chat", type: "channel.chat.message", timestamp: at(1), userId: "late-user" });
    await local.put("pendingEvents", { id: "update", type: "channel.update", timestamp: at(2), title: "Changed", categoryId: "g", categoryName: "Game" });
    await reconcilePendingEvents(local, owner, Date.parse(at(3)));
    assert((await local.all("pendingEvents")).length === 2, "unmatched events discarded");
    await mergeVideos(local, [{ id: "later", stream_id: "later", created_at: at(0), duration: "5m", title: "VOD" }]);
    await reconcilePendingEvents(local, owner, Date.parse(at(6)));
    assert((await local.all("pendingEvents")).length === 0 && (await local.all("streamChatters")).length === 1, "pending chat not recovered");
    assert((await local.all("titleHistory")).some(row => row.title === "Changed"), "pending title not recovered");
    await local.put("pendingEvents", { id: "offline", type: "channel.chat.message", timestamp: at(20), userId: "offline" });
    await reconcilePendingEvents(local, owner, Date.parse(at(20)) + 7 * DAY_MS + 1);
    assert((await local.all("pendingEvents")).length === 0, "expired event retained");
});

test("Other Shared Chat channels are excluded and busy chat reuses the stream timeline", async () => {
    const local = await openAnalyticsDB(`${owner}22`);
    storage.analyticsSettings = { enabled: true, ownerId: owner };
    await local.put("streams", { streamId: "chat", source: "stream_helper", status: "live", startedAt: at(0), lastSeenLiveAt: at(10) });
    let streamReads = 0; const all = local.all.bind(local);
    local.all = (...args) => { if (args[0] === "streams") streamReads++; return all(...args); };
    const event = { type: "channel.chat.message", id: "message", timestamp: at(1), broadcasterId: owner, userId: "visitor" };
    await receiveEvent(local, owner, { ...event, sourceBroadcasterId: "other-channel" });
    assert((await local.all("streamChatters")).length === 0 && (await local.all("pendingEvents")).length === 0, "foreign chat counted or queued");
    for (let i = 0; i < 30; i++) await receiveEvent(local, owner, { ...event, id: `own-${i}`, sourceBroadcasterId: owner });
    assert((await local.all("streamChatters")).length === 1 && streamReads === 1, "chat duplicated or rescanned full timeline");
});

test("Boundary follower snapshots retry once per tick within the window and preserve actual observation time", async () => {
    const local = await openAnalyticsDB(`${owner}23`);
    const live = { id: "boundary", started_at: at(0), title: "Boundary", game_id: "g", game_name: "Game", viewer_count: 4 };
    let calls = 0;
    await collectStream(local, owner, live, Date.parse(at(1)), async () => { calls++; throw new Error("temporary failure"); });
    await collectStream(local, owner, live, Date.parse(at(2)), async () => { calls++; return { total: 12, observedAt: at(2.1) }; });
    assert(calls === 2, "start was not retried exactly once");
    let stream = await local.get("streams", live.id);
    assert(stream.followerCountStart === 12 && stream.followerCountStartAt === at(2.1), "start count backdated");
    await collectStream(local, owner, null, Date.parse(at(3)), async () => { throw new Error("end failure"); });
    await collectStream(local, owner, null, Date.parse(at(4)), async () => ({ total: 13, observedAt: at(4.1) }));
    stream = await local.get("streams", live.id);
    assert(stream.followerCountEnd === 13 && stream.followerCountEndAt === at(4.1), "end snapshot not retried");
    const missed = { ...live, id: "expired", started_at: at(20) };
    await collectStream(local, owner, missed, Date.parse(at(21)), async () => { throw new Error("failure"); });
    await collectStream(local, owner, missed, Date.parse(at(23)), async () => { throw new Error("must not fetch after deadline"); });
    assert((await local.all("pendingSnapshots")).length === 0 && (await local.get("streams", missed.id)).followerCountStart === null, "expired boundary retried or fabricated");
});

test("Video refresh preserves follower cursor; automatic full snapshots run weekly", async () => {
    const local = await openAnalyticsDB(`${owner}24`), now = Date.parse(at(0));
    let followerCalls = 0;
    apiHandler = parsed => {
        if (parsed.pathname === "/helix/videos") return Response.json({ data: [], pagination: {} });
        if (parsed.pathname === "/helix/channels/followers") {
            followerCalls++;
            return Response.json({ data: [{ user_id: `u${followerCalls}`, followed_at: at(0) }], total: 2,
                pagination: followerCalls === 1 ? { cursor: "f-next" } : {} });
        }
    };
    try {
        await backfillStep(local, owner, now); await backfillStep(local, owner, now);
        await requestBackfill(local, { now: now + 60000 });
        assert((await local.meta("syncJobs")).followers.cursor === "f-next", "VOD refresh reset follower checkpoint");
        await backfillStep(local, owner, now + 60000); await backfillStep(local, owner, now + 60000);
        assert((await local.all("currentFollowers", "generation", await local.meta("followerGeneration"))).length === 2, "lost follower page");
        await scheduleBackfill(local, now + DAY_MS + 60000);
        let jobs = await local.meta("syncJobs");
        assert(jobs.videos.state === "running" && jobs.followers.state === "complete", "daily sync restarted full followers");
        await scheduleBackfill(local, now + 7 * DAY_MS + 60000);
        jobs = await local.meta("syncJobs");
        assert(jobs.followers.state === "running", "weekly refresh not scheduled");
    } finally { apiHandler = null; }
});

test("History batches commit each page, obey request/time budgets and stop immediately on 429", async () => {
    const local = await openAnalyticsDB(`${owner}25`); let requests = 0, limit = false;
    apiHandler = parsed => {
        if (parsed.pathname !== "/helix/videos") return;
        requests++;
        if (limit) return new Response("wait", { status: 429, headers: { "Ratelimit-Reset": String(Math.ceil(Date.now() / 1000) + 60) } });
        return Response.json({ data: [], pagination: { cursor: `page-${requests}` } });
    };
    try {
        await runBackfill(local, owner);
        assert(requests === BACKFILL_MAX_PAGES, "unbounded batch or still one page per tick");
        const checkpoint = (await local.meta("syncJobs")).videos.cursor;
        limit = true; let failed = false;
        try { await runBackfill(local, owner); } catch (error) { failed = error.status === 429; }
        assert(failed && requests === BACKFILL_MAX_PAGES + 1 && (await local.meta("syncJobs")).videos.cursor === checkpoint, "429 retried or checkpoint lost");
        limit = false; let clock = Date.now(); const before = requests;
        await runBackfill(local, owner, { now: () => { const value = clock; clock += 3000; return value; } });
        assert(requests === before + 1, "elapsed-time budget ignored");
    } finally { apiHandler = null; }
});

test("Version 2 migration repairs VOD-overwritten bounds without deleting notes or samples", async () => {
    const id = `${owner}26`, request = indexedDB.open(`twitch-stream-helper-analytics-${id}`, 2);
    request.onupgradeneeded = () => {
        const store = request.result.createObjectStore("streams", { keyPath: "streamId" });
        store.put({ streamId: "legacy", source: "stream_helper", status: "ended", startedAt: at(0),
            lastSeenLiveAt: at(119), endUpperBound: at(120), endedAt: at(60), endedAtSource: "twitch_backfill", duration: 3600000,
            viewerSampleCount: 100, viewerCoverage: 100, note: "preserve", labels: ["preserve"], vodDuration: 3600000 });
    };
    const legacy = await requestResult(request); legacy.close();
    const local = await openAnalyticsDB(id), stream = await local.get("streams", "legacy");
    assert(stream.endedAt === at(120) && stream.duration === 7200000 && stream.endedAtSource === "poll_observation", "legacy VOD bounds not repaired");
    assert(stream.note === "preserve" && stream.viewerSampleCount === 100 && Math.abs(stream.viewerCoverage - 100 / 120 * 100) < .001, "migration lost data or coverage");
    assert(await local.meta("reconcileAllEvents") && local.db.objectStoreNames.contains("pendingSnapshots"), "migration repair checkpoint/store missing");
});


test("Archive fragments preserve their own ranges without inventing coverage across gaps", async () => {
    const local = await openAnalyticsDB(`${owner}27`);
    await mergeVideos(local, [{ id: "part-one", stream_id: "fragments", created_at: at(0), duration: "20m", title: "One" },
        { id: "part-two", stream_id: "fragments", created_at: at(40), duration: "30m", title: "Two" }]);
    const stream = await local.get("streams", "fragments");
    assert(stream.startedAt === at(0) && stream.duration === null && stream.endedAt === null, "fragment gap became airtime");
    assert(classifyFollow(at(10), [stream]).streamId === "fragments" && classifyFollow(at(50), [stream]).streamId === "fragments", "recorded fragment lost");
    assert(classifyFollow(at(30), [stream]).duringStream === null, "gap classified as known live");
});

test("A history refresh requested during pagination schedules a fresh video pass", async () => {
    const local = await openAnalyticsDB(`${owner}28`), now = Date.parse(at(0)); let requests = 0;
    apiHandler = parsed => parsed.pathname === "/helix/videos"
        ? Response.json({ data: [], pagination: ++requests === 1 ? { cursor: "old-page" } : {} }) : undefined;
    try {
        await backfillStep(local, owner, now);
        await requestBackfill(local, { now: now + 60000 });
        await backfillStep(local, owner, now + 60000);
        assert((await local.meta("syncJobs")).videos.cursor === "" && (await local.meta("syncJobs")).videos.state === "running", "new archive refresh lost while paging");
        await backfillStep(local, owner, now + 60000);
        assert((await local.meta("syncJobs")).videos.state === "complete" && requests === 3, "fresh pass looped or missing");
    } finally { apiHandler = null; }
});


test("Expired follower cursor restarts its generation and cleanup resumes after publication", async () => {
    const local = await openAnalyticsDB(`${owner}29`), now = Date.parse(at(0)); let stage = 0;
    await local.put("currentFollowers", { generation: "published", userId: "old", followedAt: at(0) });
    await local.setMeta("followerGeneration", "published");
    apiHandler = parsed => {
        if (parsed.pathname === "/helix/videos") return Response.json({ data: [], pagination: {} });
        if (parsed.pathname !== "/helix/channels/followers") return;
        if (stage === 1) return new Response("expired cursor", { status: 400 });
        return Response.json({ data: [{ user_id: stage === 0 ? "partial-old" : "fresh", followed_at: at(0) }], total: 1,
            pagination: stage === 0 ? { cursor: "expired" } : {} });
    };
    try {
        await backfillStep(local, owner, now); await backfillStep(local, owner, now);
        const generation = (await local.meta("syncJobs")).followers.generation;
        stage = 1; let failed = false;
        try { await backfillStep(local, owner, now); } catch (error) { failed = error.status === 400; }
        const jobs = await local.meta("syncJobs");
        assert(failed && jobs.videos.state === "complete" && jobs.followers.cursor === "" && jobs.followers.generation !== generation, "cursor reset mixed generations or restarted VODs");
        assert(await local.meta("followerGeneration") === "published", "partial snapshot became visible");
        stage = 2; await backfillStep(local, owner, now);
        const visible = await local.all("currentFollowers", "generation", await local.meta("followerGeneration"));
        assert(visible.length === 1 && visible[0].userId === "fresh", "old partial page leaked into fresh snapshot");
        const restarted = new AnalyticsDB(local.db); await backfillStep(restarted, owner, now);
        assert((await restarted.all("currentFollowers")).length === 1 && !await restarted.meta("followersCleanupPending"), "cleanup did not resume after restart");
    } finally { apiHandler = null; }
});


test("First live poll still captures a start snapshot after event-based VOD promotion", async () => {
    const local = await openAnalyticsDB(`${owner}30`);
    await mergeVideos(local, [{ id: "early", stream_id: "early", created_at: at(0), duration: "1m", title: "Archive" }]);
    await local.put("followEvents", { id: "early-follow", followedAt: at(.5), streamId: "early", duringStream: true });
    await refreshSummary(local, "early", Date.parse(at(1)));
    assert((await local.get("streams", "early")).source === "stream_helper", "fixture not promoted");
    await collectStream(local, owner, { id: "early", started_at: at(0), title: "Live", game_id: "g", game_name: "Game", viewer_count: 4 },
        Date.parse(at(2)), async () => ({ total: 15, observedAt: at(2) }));
    const stream = await local.get("streams", "early");
    assert(stream.startedAtSource === "live" && stream.followerCountStart === 15 && stream.initialTitle === "Live", "VOD promotion suppressed first live observation");
});

async function seedDemo() {
    const now = Date.now();
    for (let i = parameters.has("single") ? 14 : 0; i < 15; i++) {
        const startedAt = iso(now - (29 - i * 2) * DAY_MS), duration = (90 + i * 7) * 60000;
        const streamId = `demo-${i}`, measured = i > 3;
        const sample = { streamId, source: measured ? "stream_helper" : "twitch_backfill", status: "ended", startedAt,
            endedAt: iso(Date.parse(startedAt) + duration), endedAtSource: "twitch_backfill", duration,
            initialTitle: i % 2 ? "今日はチームで、少し先へ。" : "勝つまでランク！初コメント歓迎", finalTitle: i % 2 ? "今日はチームで、少し先へ。" : "勝つまでランク！初コメント歓迎",
            initialCategoryId: measured ? "1" : null, initialCategoryName: measured ? (i % 3 ? "VALORANT" : "Just Chatting") : null,
            finalCategoryName: measured ? (i % 3 ? "VALORANT" : "Just Chatting") : null,
            avgViewers: measured ? 2 + i * .7 : null, peakViewers: measured ? 5 + i * 1.3 : null,
            viewerSampleCount: measured ? 86 + i * 7 : null, viewerCoverage: measured ? (i === 13 ? 82 : 98) : null,
            firstChatters: measured ? 1 + i % 5 : null, returningChatters: measured ? 1 + i % 8 : null, uniqueChatters: measured ? 2 + i % 5 + i % 8 : null,
            newFollows: measured ? i % 4 : null, followerCountStart: measured ? 40 + i : null, followerCountEnd: measured ? 40 + i + i % 4 : null,
            raidCount: measured ? 1 : null, raidViewers: measured ? 9 : null,
            eventCoverage: measured ? { chat: 96, follow: 96, raid: 96, update: 96 } : null,
            vodDuration: duration, followerCountStartAt: startedAt, followerCountEndAt: iso(Date.parse(startedAt) + duration),
            chatOriginVersion: i === 12 ? undefined : 1, note: "後半のコラボで会話が増えた。", labels: ["コラボ", "X告知あり"], titleRating: "favorite",
        };
        if (parameters.has("live") && i === 14) {
            sample.status = "live"; sample.endedAt = null; sample.duration = null;
        }
        await db.put("streams", sample);
        await db.put("titleHistory", { streamId, timestamp: startedAt, title: sample.initialTitle, source: sample.source, rating: null });
        if (measured) {
            await db.put("categoryHistory", { streamId, timestamp: startedAt, categoryId: "1", categoryName: sample.initialCategoryName });
            for (let n = 0; n < duration / 60000; n++) {
                if (n >= 40 && n <= 48) continue;
                await db.put("viewerSamples", { streamId, timestamp: iso(Date.parse(startedAt) + n * 60000), viewerCount: Math.max(0, Math.round(sample.avgViewers + Math.sin(n / 7) * 3)) });
            }
            for (let n = 0; n < i % 4; n++) await db.put("followEvents", { id: `${i}-${n}`, followedAt: startedAt, streamId, duringStream: true });
            await db.put("eventIntervals", { id: streamId, startedAt, lastSeenAt: sample.endedAt, types: ["channel.follow"] });
        }
        await db.put("followerSnapshots", { id: `daily-${i}`, timestamp: startedAt, day: startedAt.slice(0, 10), total: 40 + i * 2 });
    }
    await db.setMeta("backfill", { phase: parameters.has("sync") ? "followers" : "complete", processed: 2800, total: 10000, startedAt: iso(now - 10 * 60000), videosCompletedAt: iso(now - 60000) }); await db.setMeta("followersAsOf", iso(now - DAY_MS));
    await db.setMeta("followerGeneration", "demo"); await db.setMeta("health:events", { state: "connected" });
    const pollAt = iso(now - (parameters.get("health") === "stale" ? 10 * 60000 : 30000));
    await db.setMeta("analyticsEnabledAt", iso(now - DAY_MS));
    await db.setMeta("health:poll", { state: parameters.get("health") === "failed" ? "error" : "ok", at: pollAt,
        lastSuccessAt: pollAt, lastResult: "offline" });
    if (parameters.get("health") !== "stale") await db.put("eventIntervals", { id: "current-connection", startedAt: iso(now - 60000), lastSeenAt: iso(now), types: [] });
    for (let i = 0; i < 60; i++) await db.put("currentFollowers", { generation: "demo", userId: `f${i}`, followedAt: iso(now - i * DAY_MS) });
    for (let i = 0; i < 15; i++) await db.put("chatterProfiles", { userId: `c${i}`, firstChatAt: iso(now - i * DAY_MS), streamCount: i % 2 ? 2 : 1 });
}
if (mode === "tests") {
    const output = document.getElementById("testResults"); let passed = 0;
    for (const [name, callback] of tests) {
        try { await callback(); passed++; output.textContent += `PASS ${name}\n`; }
        catch (error) { output.textContent += `FAIL ${name}\n${error.stack}\n`; }
    }
    output.textContent += `\n${passed}/${tests.length} passed`;
    document.title = `Analytics QA: ${passed}/${tests.length} passed`;
} else if (mode === "mobile") {
    const frame = document.createElement("iframe"); frame.src = "?mode=demo&lang=ja";
    frame.style.cssText = "width:390px;height:850px;border:1px solid #777;display:block;margin:20px auto";
    document.body.append(frame);
} else {
    if (mode === "demo") await seedDemo();
    else { storage.analyticsSettings = { enabled: false }; delete storage.accessToken; }
    await import("../src/analytics/view.js");
}
