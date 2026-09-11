import { readLocal, writeLocal } from "../storage.js";
import { getTokenAuthorization, hasAnalyticsScopes } from "../auth.js";
import { getLiveStream, getChannelFollowers, createEventSubscription } from "../api.js";
import { openAnalyticsDB, requestResult } from "./db.js";
import { requestBackfill, scheduleBackfill, runBackfill } from "./backfill.js";
import { EventSubClient } from "./eventsub.js";
import { iso, localDay, chatterKind, classifyFollow, finalizeStream, summarizeStream, SAMPLE_INTERVAL_MS, DAY_MS } from "./aggregator.js";

export const ANALYTICS_ALARM = "analytics-collect";
let queue = Promise.resolve();
let client = null;
export function withAnalyticsLock(task) {
    const pending = queue.then(task);
    queue = pending.catch(() => {});
    return pending;
}
export async function analyticsSettings() {
    return (await readLocal(["analyticsSettings"])).analyticsSettings || { enabled: false, ownerId: "" };
}
export async function stopAnalytics() {
    client?.stop(); client = null;
    const settings = await analyticsSettings();
    await writeLocal({ analyticsSettings: { ...settings, enabled: false } });
    await chrome.alarms.clear(ANALYTICS_ALARM);
}
export async function enableAnalytics(authorization) {
    if (!hasAnalyticsScopes(authorization)) throw new Error(chrome.i18n.getMessage("analyticsPermissions"));
    client?.stop(); client = null;
    const ownerId = authorization.userId;
    const db = await openAnalyticsDB(ownerId);
    if (!await db.meta("analyticsEnabledAt")) await db.setMeta("analyticsEnabledAt", iso(Date.now()));
    await writeLocal({ analyticsSettings: { enabled: true, ownerId } });
    await syncAnalyticsAlarm();
}
export async function syncAnalyticsAlarm() {
    const settings = await analyticsSettings();
    if (!settings.enabled) { client?.stop(); client = null; await chrome.alarms.clear(ANALYTICS_ALARM); return; }
    if (!await chrome.alarms.get(ANALYTICS_ALARM)) {
        await chrome.alarms.create(ANALYTICS_ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
    }
}
async function problem(db, part, error) {
    const state = error?.status === 429 ? "rate_limited" : error?.status === 401 || error?.status === 403 ? "auth_error" : "error";
    const previous = await db.meta(`health:${part}`);
    await db.setMeta(`health:${part}`, { ...previous, state, at: iso(Date.now()),
        lastSuccessAt: previous?.lastSuccessAt || (previous?.state === "ok" ? previous.at : null) });
    if (error?.status === 429) await db.setMeta("retryAt", Math.max(Date.now() + 60_000, error.retryAt || 0));
}
async function healthy(db, part, details = {}) {
    const at = iso(Date.now());
    await db.setMeta(`health:${part}`, { state: "ok", at, lastSuccessAt: at, ...details });
}

export async function recordChat(db, streamId, userId, timestamp, ownerId, sourceBroadcasterId = ownerId) {
    if (!userId || userId === ownerId) return [];
    timestamp = iso(Date.parse(timestamp));
    return db.transaction(["chatterProfiles", "streamChatters"], "readwrite", async stores => {
        const changed = new Set([streamId]);
        const key = [streamId, userId];
        const chatter = await requestResult(stores.streamChatters.get(key));
        let profile = await requestResult(stores.chatterProfiles.get(userId));
        if (!chatter || timestamp < chatter.firstChatAt) {
            const kind = chatterKind(profile, streamId);
            await requestResult(stores.streamChatters.put({ streamId, userId, kind, firstChatAt: timestamp, sourceBroadcasterId }));
            const visits = await requestResult(stores.streamChatters.index("userId").getAll(userId));
            visits.sort((a, b) => a.firstChatAt.localeCompare(b.firstChatAt));
            const first = visits[0];
            // Delayed notifications may arrive after a later stream. Correct both sides atomically.
            for (const visit of visits) {
                const expected = visit.streamId === first.streamId ? "first" : "returning";
                if (visit.kind !== expected) {
                    await requestResult(stores.streamChatters.put({ ...visit, kind: expected }));
                    changed.add(visit.streamId);
                }
            }
            profile = { userId, firstChatAt: first.firstChatAt, lastChatAt: profile?.lastChatAt || timestamp,
                firstStreamId: first.streamId, streamCount: visits.length };
        }
        if (profile) {
            profile.lastChatAt = profile.lastChatAt > timestamp ? profile.lastChatAt : timestamp;
            await requestResult(stores.chatterProfiles.put(profile));
        }
        return [...changed];
    });
}
export async function reconcilePendingEvents(db, ownerId, now = Date.now()) {
    const streams = await db.timeline(), pending = await db.all("pendingEvents");
    const affected = new Set();
    for (const event of pending.sort((a, b) => a.timestamp.localeCompare(b.timestamp))) {
        const classification = classifyFollow(event.timestamp, streams);
        if (classification.streamId) {
            if (event.type === "channel.update") {
                await recordHistory(db, { streamId: classification.streamId }, event, event.timestamp, "eventsub");
            } else {
                const changed = await recordChat(db, classification.streamId, event.userId, event.timestamp, ownerId, event.sourceBroadcasterId || null);
                changed.forEach(id => affected.add(id));
            }
        }
        // No matching stream is not evidence of offline chat: polling/backfill may
        // still be catching up. Keep the minimal event until matched or expired.
        if (classification.streamId || now - Date.parse(event.timestamp) > 7 * DAY_MS) {
            await db.transaction(["pendingEvents"], "readwrite", s => requestResult(s.pendingEvents.delete(event.id)));
        }
    }
    for (const id of affected) await refreshSummary(db, id, now);
}
export async function recordHistory(db, stream, value, timestamp, observedBy = "poll") {
    await db.transaction(["streams", "titleHistory", "categoryHistory"], "readwrite", async stores => {
        const current = await requestResult(stores.streams.get(stream.streamId));
        if (!current) return;
        if (typeof value.title === "string") {
            const latest = !current.titleObservedAt || Date.parse(timestamp) >= Date.parse(current.titleObservedAt);
            const changed = current.finalTitle !== value.title;
            if (changed || !current.historyRecorded || observedBy === "eventsub") {
                const previous = await requestResult(stores.titleHistory.get([stream.streamId, timestamp]));
                await requestResult(stores.titleHistory.put({ streamId: stream.streamId, timestamp, title: value.title,
                    source: "stream_helper", observedBy, rating: previous?.rating || null }));
                if (latest && changed) current.titleRating = previous?.rating || null;
                if (!latest && changed) {
                    await requestResult(stores.titleHistory.put({ streamId: stream.streamId, timestamp: current.titleObservedAt,
                        title: current.finalTitle, source: "stream_helper", observedBy: "poll", rating: current.titleRating || null }));
                }
            }
            if (latest) { current.finalTitle = value.title; current.titleObservedAt = timestamp; }
        }
        if (typeof value.categoryId === "string") {
            const latest = !current.categoryObservedAt || Date.parse(timestamp) >= Date.parse(current.categoryObservedAt);
            const changed = current.finalCategoryId !== value.categoryId;
            if (changed || !current.historyRecorded || observedBy === "eventsub") {
                await requestResult(stores.categoryHistory.put({ streamId: stream.streamId, timestamp,
                    categoryId: value.categoryId, categoryName: value.categoryName, source: "stream_helper", observedBy }));
                if (!latest && changed) {
                    await requestResult(stores.categoryHistory.put({ streamId: stream.streamId, timestamp: current.categoryObservedAt,
                        categoryId: current.finalCategoryId, categoryName: current.finalCategoryName, source: "stream_helper", observedBy: "poll" }));
                }
            }
            if (latest) { current.finalCategoryId = value.categoryId; current.finalCategoryName = value.categoryName; current.categoryObservedAt = timestamp; }
        }
        current.historyRecorded = true;
        await requestResult(stores.streams.put(current));
    });
}
export async function refreshSummary(db, streamId, now = Date.now()) {
    const stream = await db.get("streams", streamId);
    if (!stream) return stream;
    const [samples, chatters, follows, raids, intervals] = await Promise.all([
        db.all("viewerSamples", "streamId", streamId), db.all("streamChatters", "streamId", streamId),
        db.all("followEvents", "streamId", streamId), db.all("raidEvents", "streamId", streamId),
        db.all("eventIntervals", "lastSeenAt", IDBKeyRange.lowerBound(stream.startedAt)),
    ]);
    if (stream.source !== "stream_helper" && !samples.length && !chatters.length && !follows.length && !raids.length) return stream;
    const summary = summarizeStream({ ...stream, source: "stream_helper" }, { samples, chatters, follows, raids, intervals }, now);
    if (chatters.length && chatters.every(row => row.sourceBroadcasterId)) summary.chatOriginVersion = 1;
    // Keep page edits made while the reads above were in progress.
    return db.update("streams", streamId, current => ({ ...summary, note: current.note, labels: current.labels, titleRating: current.titleRating }));
}
export async function reconcileEvents(db, changedIds = null) {
    const streams = await db.timeline();
    const changed = changedIds === null ? null : streams.filter(s => changedIds.includes(s.streamId));
    if (changed && !changed.length) return;
    const affected = new Set();
    await db.transaction(["followEvents", "raidEvents"], "readwrite", async stores => {
        for (const name of ["followEvents", "raidEvents"]) {
            let rows;
            if (changed === null) rows = await requestResult(stores[name].getAll());
            else {
                const matches = new Map(), timeIndex = name === "followEvents" ? "followedAt" : "timestamp";
                for (const stream of changed) {
                    const ends = [stream.endUpperBound, stream.endedAt, stream.lastSeenLiveAt, ...(stream.vods || []).map(v => v.endedAt)].filter(Boolean).sort();
                    const range = IDBKeyRange.bound(stream.startedAt, ends.at(-1) || stream.startedAt);
                    for (const row of await requestResult(stores[name].index(timeIndex).getAll(range))) matches.set(row.id, row);
                    // Also revisit old associations when a boundary becomes narrower.
                    for (const row of await requestResult(stores[name].index("streamId").getAll(stream.streamId))) matches.set(row.id, row);
                }
                rows = [...matches.values()];
            }
            for (const event of rows) {
                const classification = classifyFollow(event.followedAt || event.timestamp, streams);
                if (event.streamId !== classification.streamId || event.duringStream !== classification.duringStream) {
                    if (event.streamId) affected.add(event.streamId);
                    if (classification.streamId) affected.add(classification.streamId);
                    await requestResult(stores[name].put({ ...event, ...classification }));
                }
            }
        }
    });
    for (const id of affected) await refreshSummary(db, id);
}
async function followerSnapshot(db, ownerId, timestamp, reason, streamId = null, readTotal = () => getChannelFollowers(ownerId, "", 1), deadline = Infinity) {
    const { total, observedAt } = await readTotal();
    timestamp = observedAt || timestamp;
    if (Date.parse(timestamp) > deadline) return null;
    const day = localDay(timestamp);
    await db.put("followerSnapshots", { id: `${reason}:${streamId || day}`, timestamp, total, day, reason, streamId });
    if (reason === "daily") await db.setMeta("lastFollowerDay", day);
    if (streamId) {
        const field = reason === "start" ? "followerCountStart" : "followerCountEnd";
        await db.update("streams", streamId, stream => ({ ...stream, [field]: total, [`${field}At`]: timestamp }));
    }
    await healthy(db, "followers");
    return total;
}
async function retryBoundarySnapshots(db, ownerId, now, readTotal) {
    for (const snapshot of await db.all("pendingSnapshots")) {
        if (now <= snapshot.deadline) {
            try { await followerSnapshot(db, ownerId, iso(now), snapshot.reason, snapshot.streamId, readTotal, snapshot.deadline); }
            catch (error) { await problem(db, "followers", error); break; }
        }
        await db.transaction(["pendingSnapshots"], "readwrite", s => requestResult(s.pendingSnapshots.delete(snapshot.id)));
    }
}
export async function collectStream(db, ownerId, live, now = Date.now(), readTotal) {
    let pendingTotal;
    const referenceTime = Date.now();
    readTotal ||= () => pendingTotal ||= getChannelFollowers(ownerId, "", 1)
        .then(page => ({ ...page, observedAt: iso(now + Date.now() - referenceTime) }));
    const timestamp = iso(now);
    if (live && (!live.id || !Number.isFinite(Date.parse(live.started_at)) || !Number.isFinite(live.viewer_count))) {
        throw new Error(chrome.i18n.getMessage("analyticsFetchError"));
    }
    const active = await db.all("streams", "status", "live");
    const changedIds = active.map(s => s.streamId);
    for (const old of active) {
        if (old.streamId === live?.id) continue;
        await db.update("streams", old.streamId, current => finalizeStream(current, timestamp));
        // A total fetched hours after the end is not an end-of-stream snapshot.
        if (now - Date.parse(old.lastSeenLiveAt) <= SAMPLE_INTERVAL_MS * 2.5) {
            await db.put("pendingSnapshots", { id: `end:${old.streamId}`, reason: "end", streamId: old.streamId,
                deadline: Date.parse(old.lastSeenLiveAt) + SAMPLE_INTERVAL_MS * 2.5 });
        }
        await refreshSummary(db, old.streamId, now);
        await db.setMeta("latestEndedStreamId", old.streamId);
        await requestBackfill(db, { now });
    }
    if (!live) {
        await retryBoundarySnapshots(db, ownerId, now, readTotal);
        await reconcileEvents(db, changedIds); await reconcilePendingEvents(db, ownerId, now); return null;
    }
    changedIds.push(live.id);
    const previous = await db.get("streams", live.id);
    const isNew = !previous?.lastSeenLiveAt;
    await db.update("streams", live.id, existing => ({
        labels: [], note: "", titleRating: null, followerCountStart: null, followerCountEnd: null,
        ...existing, streamId: live.id, source: "stream_helper", startedAt: iso(Date.parse(live.started_at)), startedAtSource: "live",
        status: "live", endedAt: null, endedAtSource: null, endUpperBound: null,
        firstObservedAt: existing?.firstObservedAt || timestamp, lastSeenLiveAt: timestamp,
        chatOriginVersion: !existing || existing.source !== "stream_helper" ? 1 : existing.chatOriginVersion,
        initialTitle: isNew ? live.title : existing.initialTitle,
        initialCategoryId: isNew ? live.game_id : existing.initialCategoryId,
        initialCategoryName: isNew ? live.game_name : existing.initialCategoryName,
    }));
    const stream = await db.get("streams", live.id);
    await recordHistory(db, stream, { title: live.title, categoryId: live.game_id, categoryName: live.game_name }, timestamp);
    // Enforce at most one sample in each minute of the stream, across worker restarts.
    const bucket = Math.floor((now - Date.parse(live.started_at)) / SAMPLE_INTERVAL_MS);
    await db.transaction(["streams", "viewerSamples"], "readwrite", async stores => {
        const current = await requestResult(stores.streams.get(live.id));
        if (current.lastSampleBucket !== bucket) {
            await requestResult(stores.viewerSamples.put({ streamId: live.id, timestamp, viewerCount: live.viewer_count }));
            await requestResult(stores.streams.put({ ...current, lastSampleBucket: bucket }));
        }
    });
    if (isNew && now - Date.parse(live.started_at) <= SAMPLE_INTERVAL_MS * 2.5) {
        await db.put("pendingSnapshots", { id: `start:${live.id}`, reason: "start", streamId: live.id,
            deadline: Date.parse(live.started_at) + SAMPLE_INTERVAL_MS * 2.5 });
    }
    await retryBoundarySnapshots(db, ownerId, now, readTotal);
    await reconcileEvents(db, changedIds);
    await reconcilePendingEvents(db, ownerId, now);
    return refreshSummary(db, live.id, now);
}
export async function receiveEvent(db, ownerId, event) {
    const settings = await analyticsSettings();
    if (!settings.enabled || settings.ownerId !== ownerId || event.broadcasterId !== ownerId) return;
    if (event.type === "channel.chat.message" && event.sourceBroadcasterId && event.sourceBroadcasterId !== ownerId) return;
    const streams = await db.timeline();
    const classification = classifyFollow(event.followedAt || event.timestamp, streams);
    if (event.type === "channel.chat.message") {
        if (event.userId === ownerId || !event.userId) return;
        if (classification.streamId) {
            const changed = await recordChat(db, classification.streamId, event.userId, event.timestamp, ownerId);
            for (const id of changed) if (streams.find(s => s.streamId === id)?.status === "ended") await refreshSummary(db, id);
        } else await db.put("pendingEvents", { id: event.id, type: event.type, userId: event.userId, timestamp: event.timestamp,
            sourceBroadcasterId: event.sourceBroadcasterId || ownerId });
    } else if (event.type === "channel.follow") {
        if (!Number.isFinite(Date.parse(event.followedAt))) return;
        // message id dedupes retransmissions; user+time also dedupes session replays.
        await db.put("followEvents", { id: `${event.userId}:${event.followedAt}`, userId: event.userId,
            followedAt: event.followedAt, ...classification, source: "stream_helper" });
    } else if (event.type === "channel.raid") {
        await db.put("raidEvents", { id: event.id, timestamp: event.timestamp, ...classification,
            fromBroadcasterId: event.fromBroadcasterId, fromBroadcasterName: event.fromBroadcasterName, viewers: event.viewers });
    } else if (event.type === "channel.update") {
        if (classification.streamId) await recordHistory(db, { streamId: classification.streamId }, event, event.timestamp, "eventsub");
        else await db.put("pendingEvents", { id: event.id, type: event.type, timestamp: event.timestamp,
            title: event.title, categoryId: event.categoryId, categoryName: event.categoryName });
    }
    if (classification.streamId && event.type !== "channel.chat.message" && streams.find(s => s.streamId === classification.streamId)?.status === "ended") {
        await refreshSummary(db, classification.streamId);
    }
}
function connectEvents(db, ownerId) {
    if (client?.ownerId !== ownerId) { client?.stop(); client = null; }
    if (!client) {
        client = new EventSubClient({ ownerId, subscribe: createEventSubscription,
            onEvent: event => withAnalyticsLock(() => receiveEvent(db, ownerId, event)),
            onInterval: interval => withAnalyticsLock(async () => {
                const settings = await analyticsSettings();
                if (settings.enabled && settings.ownerId === ownerId) await db.put("eventIntervals", interval);
            }),
            onStatus: async status => {
                if (status.state === "rate_limited") await db.setMeta("retryAt", status.retryAt);
                await db.setMeta("health:events", { ...status, at: iso(Date.now()) });
            },
        });
        client.start();
    } else client.ensure();
}
export async function collectAnalytics() {
    const settings = await analyticsSettings();
    if (!settings.enabled || !settings.ownerId) return;
    const db = await openAnalyticsDB(settings.ownerId);
    try {
        await collectEnabled(db, settings.ownerId);
        await healthy(db, "collector");
    } catch (error) {
        // Surface unexpected failures instead of leaving only an old EventSub warning.
        await problem(db, "collector", error);
        throw error;
    }
}
async function collectEnabled(db, ownerId) {
    if ((await db.meta("retryAt") || 0) > Date.now()) return;
    let authorization;
    try {
        authorization = await getTokenAuthorization();
        if (authorization.userId !== ownerId || !hasAnalyticsScopes(authorization)) throw Object.assign(new Error(), { status: 403 });
    } catch (error) {
        client?.stop(); client = null;
        await db.setMeta("health:auth", { state: "auth_error", at: iso(Date.now()) });
        return;
    }
    await healthy(db, "auth");
    // Event transport failures must not prevent Get Streams from recording a broadcast.
    try { connectEvents(db, ownerId); }
    catch (error) { await problem(db, "events", error); }
    let pendingTotal;
    const readTotal = () => pendingTotal ||= getChannelFollowers(ownerId, "", 1)
        .then(page => ({ ...page, observedAt: iso(Date.now()) }));
    try {
        const live = await getLiveStream(ownerId);
        await collectStream(db, ownerId, live, Date.now(), readTotal);
        await healthy(db, "poll", { lastResult: live ? "live" : "offline" });
    } catch (error) { await problem(db, "poll", error); }
    if ((await db.meta("retryAt") || 0) > Date.now()) return;
    if (await db.meta("lastFollowerDay") !== localDay(Date.now())) {
        try { await followerSnapshot(db, ownerId, iso(Date.now()), "daily", null, readTotal); await healthy(db, "followers"); }
        catch (error) { await problem(db, "followers", error); }
    }
    if ((await db.meta("retryAt") || 0) > Date.now()) return;
    try {
        if (await db.meta("reconcileAllEvents")) {
            await reconcileEvents(db);
            await db.setMeta("summaryRepairs", (await db.timeline()).filter(s => s.source === "stream_helper").map(s => s.streamId));
            await db.setMeta("reconcileAllEvents", false);
        }
        const repairs = await db.meta("summaryRepairs") || [];
        if (repairs.length) {
            for (const id of repairs.slice(0, 10)) await refreshSummary(db, id);
            await db.setMeta("summaryRepairs", repairs.slice(10));
        }
        await scheduleBackfill(db);
        await runBackfill(db, ownerId, { onVideos: async changedIds => {
            await reconcileEvents(db, changedIds);
            await reconcilePendingEvents(db, ownerId);
            for (const id of changedIds) await refreshSummary(db, id);
        } });
        await healthy(db, "backfill");
    } catch (error) {
        await problem(db, "backfill", error);
    }
}
export function initializeAnalytics() {
    withAnalyticsLock(async () => { await syncAnalyticsAlarm(); await collectAnalytics(); }).catch(() => {});
}
