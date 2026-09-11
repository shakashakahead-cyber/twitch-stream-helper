import { inPeriod } from "./aggregator.js";

export function csvCell(value) {
    if (value === null || value === undefined) return "";
    let text = String(value);
    // Treat user-provided titles/notes as text in Excel, including leading whitespace.
    if (typeof value === "string" && /^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
export function makeCSV(headers, rows) {
    return "\uFEFF" + [headers, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
export const STREAM_COLUMNS = [
    ["stream_id", "streamId"], ["source", "source"], ["started_at", "startedAt"], ["ended_at", "endedAt"],
    ["duration_minutes", s => s.duration === null || s.duration === undefined ? null : s.duration / 60000],
    ["title", "finalTitle"], ["category", "finalCategoryName"], ["avg_viewers", "avgViewers"], ["peak_viewers", "peakViewers"],
    ["viewer_sample_count", "viewerSampleCount"], ["viewer_coverage_percent", "viewerCoverage"],
    ["unique_chatters", "uniqueChatters"], ["first_chatters", "firstChatters"], ["returning_chatters", "returningChatters"],
    ["new_follows", "newFollows"], ["follower_count_start", "followerCountStart"], ["follower_count_end", "followerCountEnd"],
    ["raid_count", "raidCount"], ["raid_viewers", "raidViewers"], ["labels", s => (s.labels || []).join(" | ")],
    ["note", "note"], ["title_rating", "titleRating"], ["end_time_source", "endedAtSource"],
    ["end_lower_bound", "endLowerBound"], ["end_upper_bound", "endUpperBound"],
    ["chat_coverage_percent", s => s.eventCoverage?.chat], ["follow_coverage_percent", s => s.eventCoverage?.follow],
    ["raid_coverage_percent", s => s.eventCoverage?.raid],
    ["follower_count_start_observed_at", "followerCountStartAt"], ["follower_count_end_observed_at", "followerCountEndAt"],
    ["vod_duration_minutes", s => s.vodDuration === null || s.vodDuration === undefined ? null : s.vodDuration / 60000],
    ["chat_origin_filter_version", "chatOriginVersion"],
    ["start_time_source", "startedAtSource"],
];
export function streamsCSV(streams, bounds) {
    return makeCSV(STREAM_COLUMNS.map(([header]) => header), streams.filter(s => inPeriod(s.startedAt, bounds))
        .map(stream => STREAM_COLUMNS.map(([, key]) => typeof key === "function" ? key(stream) : stream[key])));
}
export function samplesCSV(samples, bounds) {
    return makeCSV(["stream_id", "timestamp", "viewer_count"], samples.filter(s => inPeriod(s.timestamp, bounds))
        .map(s => [s.streamId, s.timestamp, s.viewerCount]));
}
export function downloadCSV(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = name;
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
