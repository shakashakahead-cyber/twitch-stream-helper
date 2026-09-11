export const SAMPLE_INTERVAL_MS = 60_000;
export const COVERAGE_THRESHOLDS = Object.freeze({ normal: 95, partial: 80 });
export const DAY_MS = 86_400_000;
export const finite = value => typeof value === "number" && Number.isFinite(value);
export const mean = values => { const valid = values.filter(finite); return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null; };
export const sum = values => { const valid = values.filter(finite); return valid.length ? valid.reduce((a, b) => a + b, 0) : null; };
export const maximum = values => values.filter(finite).reduce((best, value) => best === null ? value : Math.max(best, value), null);
export const iso = time => new Date(time).toISOString();
export function localDay(time) {
    const date = new Date(time);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function parseDuration(value) {
    const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value || "");
    return match && match.slice(1).some(Boolean) ? (Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0)) * 1000 : null;
}
export function viewerStats(samples, startedAt, endedAt) {
    const values = samples.map(s => s.viewerCount).filter(finite);
    const duration = endedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) : null;
    const expected = finite(duration) ? Math.max(1, Math.ceil(duration / SAMPLE_INTERVAL_MS)) : null;
    return {
        avgViewers: mean(values), peakViewers: maximum(values), viewerSampleCount: values.length,
        viewerCoverage: expected === null ? null : Math.min(100, values.length / expected * 100), duration,
    };
}
export function coverageLevel(value) {
    if (!finite(value)) return "unknown";
    return value >= COVERAGE_THRESHOLDS.normal ? "normal" : value >= COVERAGE_THRESHOLDS.partial ? "partial" : "reference";
}
export function coveredMilliseconds(intervals, startedAt, endedAt, type) {
    const start = Date.parse(startedAt), end = Date.parse(endedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
    const ranges = intervals.filter(i => !type || i.types.includes(type)).map(i => [
        Math.max(start, Date.parse(i.startedAt)), Math.min(end, Date.parse(i.lastSeenAt)),
    ]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
    let total = 0, right = start;
    for (const [a, b] of ranges) { total += Math.max(0, b - Math.max(a, right)); right = Math.max(right, b); }
    return total;
}
export function eventCoverage(intervals, startedAt, endedAt, type) {
    const duration = Date.parse(endedAt) - Date.parse(startedAt);
    return duration > 0 ? Math.min(100, coveredMilliseconds(intervals, startedAt, endedAt, type) / duration * 100) : null;
}
export function classifyFollow(timestamp, streams) {
    const time = Date.parse(timestamp);
    let uncertain = false;
    for (const stream of streams) {
        const start = Date.parse(stream.startedAt);
        if (time < start) continue;
        // Polling only bounds the end. Never assign a boundary event as certain.
        const certainEnd = (stream.source === "twitch_backfill" || stream.startedAtSource === "vod") && !stream.vods?.length ? Date.parse(stream.endedAt)
            : Date.parse(stream.lastSeenLiveAt || stream.startedAt);
        if (time <= certainEnd) return { streamId: stream.streamId, duringStream: true };
        // A recording confirms only its own range, not gaps between VOD fragments
        // or the exact end of the broadcast. Ignore ranges contradicting live bounds.
        const recordings = (stream.vods || []).filter(v => Date.parse(v.startedAt) >= start
            && Number.isFinite(Date.parse(v.endedAt)) && (!stream.endUpperBound || Date.parse(v.endedAt) <= Date.parse(stream.endUpperBound)));
        if (recordings.some(v => time >= Date.parse(v.startedAt) && time <= Date.parse(v.endedAt))) {
            return { streamId: stream.streamId, duringStream: true };
        }
        if (recordings.some(v => time < Date.parse(v.endedAt))) uncertain = true;
        const upper = Date.parse(stream.endUpperBound || stream.endedAt || stream.lastSeenLiveAt);
        if (time <= upper || (stream.status === "live" && time >= start)) uncertain = true;
    }
    return { streamId: null, duringStream: uncertain ? null : false };
}
export function chatterKind(profile, streamId) {
    return !profile || profile.firstStreamId === streamId ? "first" : "returning";
}
export function finalizeStream(stream, detectedAt) {
    const gap = Date.parse(detectedAt) - Date.parse(stream.lastSeenLiveAt);
    const closeObservation = gap >= 0 && gap <= SAMPLE_INTERVAL_MS * 2.5;
    return { ...stream, status: "ended", endedAt: closeObservation ? detectedAt : null,
        endedAtSource: closeObservation ? "poll_observation" : "unknown",
        endLowerBound: stream.lastSeenLiveAt, endUpperBound: detectedAt,
        duration: closeObservation ? Date.parse(detectedAt) - Date.parse(stream.startedAt) : null,
    };
}
export function summarizeStream(stream, data, now = Date.now()) {
    if (stream.source !== "stream_helper") return stream;
    const end = stream.status === "live" ? iso(now) : stream.endedAt;
    const sampleStats = viewerStats(data.samples, stream.startedAt, end);
    const types = { chat: "channel.chat.message", follow: "channel.follow", raid: "channel.raid", update: "channel.update" };
    const coverage = Object.fromEntries(Object.entries(types).map(([key, type]) => [key,
        end ? eventCoverage(data.intervals, stream.startedAt, end, type) : null,
    ]));
    const observed = type => data.intervals.some(i => i.types.includes(type) &&
        Date.parse(i.lastSeenAt) > Date.parse(stream.startedAt) && Date.parse(i.startedAt) < Date.parse(end || stream.endUpperBound || iso(now)));
    const chatMeasured = observed(types.chat) || data.chatters.length > 0;
    const follows = data.follows.filter(e => e.streamId === stream.streamId);
    const raids = data.raids.filter(e => e.streamId === stream.streamId);
    return { ...stream, ...sampleStats, eventCoverage: coverage,
        uniqueChatters: chatMeasured ? data.chatters.length : null,
        firstChatters: chatMeasured ? data.chatters.filter(c => c.kind === "first").length : null,
        returningChatters: chatMeasured ? data.chatters.filter(c => c.kind === "returning").length : null,
        newFollows: observed(types.follow) || follows.length ? follows.length : null,
        raidCount: observed(types.raid) || raids.length ? raids.length : null,
        raidViewers: observed(types.raid) || raids.length ? raids.reduce((n, r) => n + r.viewers, 0) : null,
    };
}
export function periodBounds(days, now = Date.now()) {
    const end = now + 1;
    return { start: days === "all" ? -Infinity : now - Number(days) * DAY_MS, end };
}
export const inPeriod = (time, bounds) => Date.parse(time) >= bounds.start && Date.parse(time) < bounds.end;
export function kpis(streams) {
    return { avgViewers: mean(streams.map(s => s.avgViewers)), peakViewers: maximum(streams.map(s => s.peakViewers)),
        firstChatters: sum(streams.map(s => s.firstChatters)), returningChatters: sum(streams.map(s => s.returningChatters)),
        newFollows: sum(streams.map(s => s.newFollows)) };
}
export function comparisons(stream, streams) {
    const prior = streams.filter(s => s.source === "stream_helper" && s.status === "ended" && s.startedAt < stream.startedAt)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 10);
    return { count: prior.length, values: Object.fromEntries(["avgViewers", "peakViewers", "firstChatters", "returningChatters", "newFollows"]
        .map(key => [key, mean(prior.map(s => s[key]))])) };
}
export function changePercent(current, previous) {
    return finite(current) && finite(previous) && previous !== 0 ? (current - previous) / Math.abs(previous) * 100 : null;
}
export function categoryStats(streams) {
    const groups = new Map();
    for (const stream of streams.filter(s => s.source === "stream_helper")) {
        const category = stream.initialCategoryName || "";
        if (!groups.has(category)) groups.set(category, []);
        groups.get(category).push(stream);
    }
    return [...groups].map(([category, rows]) => ({ category, count: rows.length,
        avgViewers: mean(rows.map(s => s.avgViewers)), peakViewers: mean(rows.map(s => s.peakViewers)),
        firstChatters: mean(rows.map(s => s.firstChatters)), newFollows: mean(rows.map(s => s.newFollows)),
    }));
}
