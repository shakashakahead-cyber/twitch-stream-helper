import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { viewerStats, coverageLevel, coveredMilliseconds, eventCoverage, classifyFollow, chatterKind,
    finalizeStream, summarizeStream, periodBounds, changePercent, kpis, parseDuration, DAY_MS } from "../src/analytics/aggregator.js";
import { csvCell, streamsCSV, samplesCSV, makeCSV } from "../src/analytics/export.js";
import { vodRecord } from "../src/analytics/backfill.js";
import { EventSubClient, analyticsEvent, subscriptions, isReconnectUrl } from "../src/analytics/eventsub.js";

const start = "2026-09-01T23:00:00.000Z", end = "2026-09-02T01:00:00.000Z";
const at = minutes => new Date(Date.parse(start) + minutes * 60000).toISOString();
const stream = { streamId: "s1", source: "stream_helper", status: "ended", startedAt: start, endedAt: end,
    endedAtSource: "twitch_backfill", lastSeenLiveAt: at(119) };
test("viewer average, peak, sample counts and 118/120 coverage never fill gaps", () => {
    const samples = Array.from({ length: 118 }, (_, n) => ({ timestamp: at(n), viewerCount: n % 2 ? 4 : 2 }));
    const stats = viewerStats(samples, start, end);
    assert.equal(stats.avgViewers, 3); assert.equal(stats.peakViewers, 4);
    assert.equal(stats.viewerSampleCount, 118); assert.equal(stats.viewerCoverage, 118 / 120 * 100);
    assert.equal(stats.duration, 7200000);
    assert.equal(viewerStats([], start, end).avgViewers, null);
    assert.equal(viewerStats([{ viewerCount: 0 }], start, end).avgViewers, 0);
    assert.equal(viewerStats(samples, start, null).viewerCoverage, null);
    assert.equal(coverageLevel(95), "normal"); assert.equal(coverageLevel(80), "partial");
    assert.equal(coverageLevel(79), "reference"); assert.equal(coverageLevel(null), "unknown");
});
test("coverage unions overlaps, clips intervals and excludes disconnected time and other types", () => {
    const intervals = [
        { startedAt: at(-10), lastSeenAt: at(20), types: ["chat"] },
        { startedAt: at(10), lastSeenAt: at(50), types: ["chat"] },
        { startedAt: at(100), lastSeenAt: at(130), types: ["chat"] },
        { startedAt: start, lastSeenAt: end, types: ["follow"] },
    ];
    assert.equal(coveredMilliseconds(intervals, start, end, "chat"), 70 * 60000);
    assert.equal(eventCoverage(intervals, start, end, "chat"), 70 / 120 * 100);
    assert.equal(eventCoverage([], start, end, "chat"), 0);
});
test("first/returning refers to different streams, not repeated messages", () => {
    assert.equal(chatterKind(null, "s1"), "first");
    assert.equal(chatterKind({ firstStreamId: "s1" }, "s1"), "first");
    assert.equal(chatterKind({ firstStreamId: "s1" }, "s2"), "returning");
});
test("follows across midnight, end boundaries and long browser gaps", () => {
    assert.deepEqual(classifyFollow(at(90), [stream]), { streamId: "s1", duringStream: true });
    assert.deepEqual(classifyFollow(at(550), [stream]), { streamId: null, duringStream: false });
    assert.equal(classifyFollow(at(-1), [stream]).duringStream, false);
    const polled = { ...stream, endedAtSource: "poll_observation", endUpperBound: end };
    assert.equal(classifyFollow(at(119.5), [polled]).duringStream, null);
    assert.equal(classifyFollow(at(118), [polled]).duringStream, true);
    const gap = finalizeStream({ ...stream, status: "live" }, at(600));
    assert.equal(classifyFollow(at(300), [gap]).duringStream, null);
});
test("stream finalization distinguishes observed ends from unknowable sleep gaps", () => {
    const result = finalizeStream({ ...stream, status: "live" }, end);
    assert.equal(result.status, "ended"); assert.equal(result.duration, 7200000);
    assert.equal(result.endedAtSource, "poll_observation");
    const missed = finalizeStream(stream, at(240));
    assert.equal(missed.endedAt, null); assert.equal(missed.duration, null);
    assert.equal(missed.endUpperBound, at(240)); assert.equal(missed.endLowerBound, at(119));
});
test("unobserved events remain null, observed zero and partial counts retain coverage", () => {
    const data = { samples: [], chatters: [], follows: [], raids: [], intervals: [] };
    const result = summarizeStream(stream, data);
    for (const key of ["avgViewers", "peakViewers", "uniqueChatters", "firstChatters", "returningChatters", "newFollows", "raidCount"]) assert.equal(result[key], null);
    const measured = summarizeStream(stream, { ...data, intervals: [{ startedAt: start, lastSeenAt: at(60), types: ["channel.chat.message", "channel.follow", "channel.raid"] }], chatters: [{ kind: "first" }, { kind: "returning" }] });
    assert.equal(measured.uniqueChatters, 2); assert.equal(measured.firstChatters, 1); assert.equal(measured.returningChatters, 1);
    assert.equal(measured.newFollows, 0); assert.equal(measured.eventCoverage.follow, 50);
});
test("VOD duration and unavailable fields, no fabricated historical viewers/categories", () => {
    assert.equal(parseDuration("2h34m5s"), 9245000); assert.equal(parseDuration("14m"), 840000);
    assert.equal(parseDuration("invalid"), null); assert.equal(parseDuration(""), null);
    const record = vodRecord({ id: "v1", stream_id: "s1", created_at: start, duration: "2h", title: "Archive", view_count: 55 });
    assert.equal(record.source, "twitch_backfill"); assert.equal(record.endedAt, end);
    assert.equal(record.avgViewers, null); assert.equal(record.initialCategoryName, null);
    assert.equal(vodRecord({ id: "clip", created_at: start }), null);
});
test("CSV quoting, BOM, Unicode, formula safety, period filters and nulls", () => {
    assert.equal(csvCell('A,"B"\r\nC'), '"A,""B""\r\nC"');
    assert.equal(csvCell("=1+1"), "'=1+1"); assert.equal(csvCell(" \t+CMD"), "' \t+CMD");
    assert.equal(csvCell(-2), "-2"); assert.equal(csvCell(null), "");
    const csv = makeCSV(["title", "count"], [["日本語🎮", null]]);
    assert.equal(csv.charCodeAt(0), 0xfeff); assert.ok(csv.includes("日本語🎮,\r\n"));
    const bounds = { start: Date.parse(start), end: Date.parse(end) };
    const streams = streamsCSV([stream, { ...stream, streamId: "excluded", startedAt: at(-1) }], bounds);
    assert.ok(streams.includes("s1,stream_helper")); assert.ok(!streams.includes("excluded"));
    const rows = samplesCSV([{ streamId: "s1", timestamp: start, viewerCount: 0 }, { streamId: "s1", timestamp: end, viewerCount: 9 }], bounds);
    assert.equal(rows.split("\r\n").length, 3); assert.ok(rows.includes(",0\r\n"));
});
test("period comparison excludes missing measures and zero baselines", () => {
    assert.equal(periodBounds(7, 10 * DAY_MS).start, 3 * DAY_MS);
    assert.equal(periodBounds("all").start, -Infinity);
    assert.equal(changePercent(3, 2), 50); assert.equal(changePercent(3, 0), null);
    assert.equal(kpis([{ avgViewers: null }, { avgViewers: 2 }, { avgViewers: 4 }]).avgViewers, 3);
});
test("EventSub uses minimal conditions and strips chat text/user names", () => {
    assert.deepEqual(subscriptions("42").map(s => s[0]), ["channel.chat.message", "channel.follow", "channel.raid", "channel.update"]);
    assert.equal(subscriptions("42")[2][2].to_broadcaster_user_id, "42");
    const clean = analyticsEvent({ metadata: { message_id: "e1", message_timestamp: start }, payload: { subscription: { type: "channel.chat.message" }, event: { broadcaster_user_id: "42", chatter_user_id: "99", chatter_user_name: "Private", message: { text: "not saved" } } } });
    assert.deepEqual(Object.keys(clean).sort(), ["broadcasterId", "id", "timestamp", "type", "userId", "sourceBroadcasterId"].sort());
    assert.ok(isReconnectUrl("wss://eventsub.wss.twitch.tv/ws?reconnect=abc"));
    assert.ok(!isReconnectUrl("wss://eventsub.wss.twitch.tv.evil.test/ws"));
    assert.ok(!isReconnectUrl("https://eventsub.wss.twitch.tv/ws"));
});

class MockSocket {
    static all = [];
    constructor(url) { this.url = url; MockSocket.all.push(this); }
    close() { if (!this.closed) { this.closed = true; this.onclose?.(); } }
    sendMessage(message) { return this.onmessage({ data: JSON.stringify(message) }); }
}
const welcome = id => ({ metadata: { message_type: "session_welcome" }, payload: { session: { id, keepalive_timeout_seconds: 10 } } });
test("WebSocket welcome subscribes once; reconnect handoff transfers; sleep splits coverage", async () => {
    MockSocket.all = []; let now = Date.parse(start);
    const calls = [], intervals = [], states = [];
    const client = new EventSubClient({ ownerId: "42", Socket: MockSocket, now: () => now,
        subscribe: async (...args) => { calls.push(args); return { data: [{ id: "subscription" }] }; },
        onEvent() {}, onInterval: value => intervals.push(value), onStatus: state => states.push(state),
    });
    try {
        client.start(); const first = MockSocket.all[0]; await first.sendMessage(welcome("first"));
        assert.equal(calls.length, 4); assert.equal(states.at(-1).state, "connected");
        now += 9000; await first.sendMessage({ metadata: { message_type: "session_keepalive" } });
        const initialId = intervals[0].id; assert.equal(intervals.at(-1).id, initialId);
        now += 120000; await first.sendMessage({ metadata: { message_type: "session_keepalive" } });
        assert.notEqual(intervals.at(-1).id, initialId);
        await first.sendMessage({ metadata: { message_type: "session_reconnect" }, payload: { session: { reconnect_url: "wss://eventsub.wss.twitch.tv/ws?reconnect=ok" } } });
        assert.equal(MockSocket.all.length, 2); assert.ok(!first.closed);
        const second = MockSocket.all[1]; await second.sendMessage(welcome("second"));
        assert.ok(first.closed); assert.equal(calls.length, 4);
        second.close(); client.ensure(); assert.equal(MockSocket.all.length, 2);
        now += 60000; client.ensure(); assert.equal(MockSocket.all.length, 3);
        await MockSocket.all[2].sendMessage(welcome("third")); assert.equal(calls.length, 8);
    } finally { client.stop(); }
});
test("subscription 429 does not loop; auth revocation drops coverage", async () => {
    MockSocket.all = []; let now = Date.parse(start), calls = 0;
    const states = [];
    const client = new EventSubClient({ ownerId: "42", Socket: MockSocket, now: () => now,
        subscribe: async () => { calls++; throw { status: 429, retryAt: now + 120000 }; },
        onEvent() {}, onInterval() {}, onStatus: state => states.push(state) });
    try {
        client.start(); await MockSocket.all[0].sendMessage(welcome("one"));
        client.ensure(); now += 60000; client.ensure(); assert.equal(calls, 1);
        assert.ok(states.some(s => s.state === "rate_limited"));
        assert.equal(MockSocket.all.length, 1);
    } finally { client.stop(); }
});

test("WebSocket construction errors back off without escaping into stream polling", () => {
    let now = Date.parse(start), attempts = 0;
    const states = [];
    const client = new EventSubClient({ ownerId: "42", now: () => now,
        Socket: class { constructor() { attempts++; throw new Error("socket unavailable"); } },
        subscribe() {}, onEvent() {}, onInterval() {}, onStatus: value => states.push(value) });
    try {
        assert.doesNotThrow(() => client.start());
        assert.equal(states.at(-1).state, "disconnected");
        client.ensure(); assert.equal(attempts, 1);
        now += 60000; client.ensure(); assert.equal(attempts, 2);
        now += 60000; client.ensure(); assert.equal(attempts, 2);
    } finally { client.stop(); }
});

test("Heartbeat timeout releases a stuck closing socket and ignores late messages", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let now = Date.parse(start), received = 0;
    const sockets = [], states = [];
    const client = new EventSubClient({ ownerId: "42", now: () => now,
        Socket: class extends MockSocket { constructor(url) { super(url); sockets.push(this); } close() { this.closing = true; } },
        subscribe: async () => ({ data: [{ id: "sub" }] }), onEvent: () => received++,
        onInterval() {}, onStatus: value => states.push(value) });
    try {
        client.start(); await sockets[0].sendMessage(welcome("stuck"));
        now += 11500; t.mock.timers.tick(11500);
        assert.equal(states.at(-1).state, "disconnected");
        assert.equal(client.sockets.size, 0);
        await sockets[0].sendMessage({ metadata: { message_type: "notification", message_id: "late", message_timestamp: start },
            payload: { subscription: { type: "channel.chat.message" }, event: { broadcaster_user_id: "42", chatter_user_id: "99" } } });
        assert.equal(received, 0);
        now += 60000; client.ensure(); assert.equal(sockets.length, 2);
        await sockets[1].sendMessage(welcome("recovered"));
        sockets[0].onclose();
        assert.equal(client.sockets.size, 1);
        assert.equal(states.at(-1).state, "connected");
    } finally { client.stop(); }
});
test("all JSON and analytics locale keys/placeholder definitions match", async () => {
    const root = new URL("../", import.meta.url);
    const en = JSON.parse(await readFile(new URL("_locales/en/messages.json", root), "utf8"));
    const ja = JSON.parse(await readFile(new URL("_locales/ja/messages.json", root), "utf8"));
    const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
    assert.equal(manifest.minimum_chrome_version, "116");
    assert.deepEqual(Object.keys(en).sort(), Object.keys(ja).sort());
    const placeholders = entry => Object.fromEntries(Object.entries(entry.placeholders || {}).map(([key, value]) => [key, value.content]));
    for (const key of Object.keys(en)) assert.deepEqual(placeholders(en[key]), placeholders(ja[key]));
    for (const name of await readdir(new URL("src/analytics/", root))) {
        if (!name.endsWith(".js")) continue;
        const code = await readFile(new URL(`src/analytics/${name}`, root), "utf8");
        for (const [, key] of code.matchAll(/"(analytics[A-Z][a-zA-Z0-9]*)"/g)) {
            // Storage keys/action names are intentionally not user-visible messages.
            if (["analyticsSettings", "analyticsPeriod", "analyticsApp", "analyticsEnable", "analyticsDisable", "analyticsRefresh", "analyticsEnabledAt"].includes(key)) continue;
            assert.ok(en[key], `Missing locale key: ${key}`);
        }
    }
});


test("Heartbeat jitter retains coverage, real gaps split it, and terminal errors stay visible", async () => {
    MockSocket.all = []; let now = Date.parse(start);
    const intervals = new Map(), states = [];
    const client = new EventSubClient({ ownerId: "42", Socket: MockSocket, now: () => now,
        subscribe: async () => ({ data: [{ id: "sub" }] }), onEvent() {},
        onInterval: value => intervals.set(value.id, { ...value }), onStatus: value => states.push(value) });
    try {
        client.start(); const socket = MockSocket.all[0]; await socket.sendMessage(welcome("jitter"));
        for (let i = 0; i < 12; i++) { now += 10050; await socket.sendMessage({ metadata: { message_type: "session_keepalive" } }); }
        assert.equal(intervals.size, 1);
        assert.equal(eventCoverage([...intervals.values()], start, new Date(now).toISOString(), "channel.chat.message"), 100);
        const beforeGap = now; now += 120000;
        await socket.sendMessage({ metadata: { message_type: "session_keepalive" } });
        assert.equal(intervals.size, 2);
        assert.equal(coveredMilliseconds([...intervals.values()], start, new Date(now).toISOString(), "channel.chat.message"), beforeGap - Date.parse(start));
        await socket.sendMessage({ metadata: { message_type: "revocation" } });
        assert.equal(states.at(-1).state, "auth_error");
    } finally { client.stop(); }
});

test("Shared Chat source is preserved without retaining message bodies or names", () => {
    const clean = analyticsEvent({ metadata: { message_id: "shared", message_timestamp: start },
        payload: { subscription: { type: "channel.chat.message" }, event: { broadcaster_user_id: "42", chatter_user_id: "99",
            source_broadcaster_user_id: "other", source_broadcaster_user_name: "Private", message: { text: "Private" } } } });
    assert.equal(clean.sourceBroadcasterId, "other");
    assert.ok(!JSON.stringify(clean).includes("Private"));
});
