import { openAnalyticsDB } from "./db.js";
import { chart } from "./charts.js";
import { streamsCSV, samplesCSV, downloadCSV } from "./export.js";
import { finite, mean, maximum, localDay, inPeriod, periodBounds, kpis, comparisons, changePercent,
    coverageLevel, categoryStats, coveredMilliseconds, DAY_MS } from "./aggregator.js";

const t = (key, substitutions) => chrome.i18n.getMessage(key, substitutions);
const app = document.getElementById("analyticsApp");
const locale = chrome.i18n.getUILanguage();
document.documentElement.lang = locale;
document.title = `Stream Helper · ${t("analyticsOverview")}`;
const num = (value, digits = 1) => finite(value) ? new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value) : t("analyticsNoData");
const date = (value, time = false) => value ? new Date(value).toLocaleString(locale, time
    ? { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
    : { month: "short", day: "numeric" }) : t("analyticsNoData");
const duration = value => finite(value) ? `${num(value / 3600000)} ${t("analyticsHours")}` : t("analyticsNoData");
const percent = value => finite(value) ? `${num(value)}%` : t("analyticsNoData");
const sourceName = value => t(value === "stream_helper" ? "analyticsSourceMeasured" : "analyticsSourceBackfill");
const metricKeys = ["avgViewers", "peakViewers", "firstChatters", "returningChatters", "newFollows"];
const metricLabels = ["analyticsAvg", "analyticsPeak", "analyticsFirst", "analyticsReturning", "analyticsFollows"];
let db, dataset, settings = { enabled: false }, days = "30", loading = false;
let followerCache = {};
let reviewOwnerId = null, selectedStreamId = null;

function el(tag, className = "", text = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== "") node.textContent = text;
    return node;
}
function button(label, callback, className = "button") {
    const node = el("button", className, t(label)); node.type = "button";
    node.addEventListener("click", () => Promise.resolve(callback()).catch(showError));
    return node;
}
const notice = el("div", "notice"); notice.setAttribute("role", "status"); notice.hidden = true;
function showError(error) { notice.textContent = error?.userMessage || t("analyticsLocalError"); notice.hidden = false; }
async function action(name) {
    controls.querySelectorAll("button").forEach(node => { node.disabled = true; });
    notice.textContent = t("analyticsWorking"); notice.hidden = false;
    try {
        const response = await chrome.runtime.sendMessage({ action: name });
        if (!response?.success) throw { userMessage: response?.error || t("analyticsLocalError") };
        notice.hidden = true; await load();
    } finally { controls.querySelectorAll("button").forEach(node => { node.disabled = false; }); sync.disabled = !settings.enabled; }
}
const header = el("header", "page-header"), brand = el("div", "brand");
brand.append(el("span", "eyebrow", "TWITCH STREAM HELPER / ANALYTICS"), el("h1", "", t("analyticsTitle")), el("p", "subtitle", t("analyticsSubtitle")));
const controls = el("div", "controls");
const enable = button("analyticsEnable", () => action("analyticsEnable"), "button primary");
const disable = button("analyticsDisable", () => action("analyticsDisable"));
const sync = button("analyticsRefresh", () => action("analyticsRefresh"));
controls.append(enable, disable, sync, button("analyticsReload", load));
header.append(brand, controls);
const status = el("section", "collection-status");
const review = el("section", "panel stream-review");
review.setAttribute("aria-labelledby", "stream-review-heading");
const reviewHeader = el("div", "stream-review-header"), reviewHeading = el("h2", "", t("analyticsRecord"));
reviewHeading.id = "stream-review-heading";
const reviewNavigation = el("nav", "stream-navigation");
reviewNavigation.setAttribute("aria-label", t("analyticsRecordNavigation"));
function navigationButton(label, direction) {
    const node = button(label, () => moveReview(direction));
    const arrow = el("span", "", direction > 0 ? "←" : "→"); arrow.setAttribute("aria-hidden", "true");
    if (direction > 0) node.prepend(arrow, " "); else node.append(" ", arrow);
    return node;
}
const olderStream = navigationButton("analyticsOlderStream", 1);
const newerStream = navigationButton("analyticsNewerStream", -1);
const latestStream = button("analyticsLatestStream", () => { selectedStreamId = null; renderReview(); });
olderStream.disabled = newerStream.disabled = latestStream.disabled = true;
const reviewPosition = el("span", "muted stream-position");
reviewPosition.setAttribute("role", "status"); reviewPosition.setAttribute("aria-atomic", "true");
reviewNavigation.append(olderStream, latestStream, newerStream);
reviewHeader.append(reviewHeading, reviewNavigation);
const reviewBody = el("div", "stream-review-body");
review.append(reviewHeader, reviewPosition, reviewBody);
const privacy = el("details", "privacy"), privacySummary = el("summary", "", t("analyticsAccount"));
privacy.append(privacySummary, el("p", "", t("analyticsPrivacy")));
const toolbar = el("div", "toolbar"), filter = el("div", "period-filter");
filter.setAttribute("role", "group"); filter.setAttribute("aria-label", t("analyticsPeriod"));
for (const value of ["7", "30", "90", "365", "all"]) {
    const node = button(`analytics${value === "all" ? "All" : value}`, async () => {
        days = value; await chrome.storage.local.set({ analyticsPeriod: days }); render();
    }, "period-button");
    node.dataset.days = value; filter.append(node);
}
toolbar.append(el("h2", "", t("analyticsOverview")), filter);
const dashboard = el("div", "dashboard");
app.append(header, notice, review, status, privacy, toolbar, dashboard);

async function load() {
    if (loading) return;
    loading = true;
    try {
        const saved = await chrome.storage.local.get(["analyticsSettings", "analyticsPeriod"]);
        settings = saved.analyticsSettings || { enabled: false };
        if (["7", "30", "90", "365", "all"].includes(saved.analyticsPeriod)) days = saved.analyticsPeriod;
        if (settings.ownerId) {
            db = await openAnalyticsDB(settings.ownerId);
            const names = ["streams", "followEvents", "followerSnapshots", "metadata", "eventIntervals", "chatterProfiles"];
            const values = await Promise.all(names.map(name => db.all(name)));
            dataset = Object.fromEntries(names.map((name, i) => [name, values[i]]));
            dataset.meta = Object.fromEntries(dataset.metadata.map(row => [row.key, row.value]));
            const generation = dataset.meta.followerGeneration;
            if (followerCache.ownerId !== settings.ownerId || followerCache.generation !== generation) {
                followerCache = { ownerId: settings.ownerId, generation,
                    rows: generation ? await db.all("currentFollowers", "generation", generation) : [] };
            }
            dataset.currentFollowers = followerCache.rows;
        } else {
            db = null;
            dataset = { streams: [], followEvents: [], followerSnapshots: [], eventIntervals: [], chatterProfiles: [], currentFollowers: [], meta: {} };
        }
        render();
    } catch (error) { showError(error); }
    finally { loading = false; }
}
function renderStatus() {
    status.replaceChildren();
    const badge = el("span", settings.enabled ? "badge connected" : "badge", t(settings.enabled ? "analyticsEnabled" : "analyticsDisabled"));
    status.append(badge);
    if (settings.ownerId) status.append(el("span", "muted", `${t("analyticsAccount")}: ${settings.ownerId}`));
    const phase = dataset.meta.backfill?.phase;
    status.append(el("span", "sync-status", t(phase === "complete" ? "analyticsBackfillComplete" : phase === "videos" ? "analyticsBackfillVideos"
        : phase === "followers" ? "analyticsBackfillFollowers" : "analyticsBackfillPending")));
    const progress = dataset.meta.backfill;
    if (progress && phase !== "complete") {
        status.append(el("span", "muted", t("analyticsSyncProgress", [num(progress.processed, 0), num(progress.total, 0)])));
        if (progress.startedAt) status.append(el("span", "muted", `${t("analyticsSyncStarted")}: ${date(progress.startedAt, true)}`));
    }
    if (progress?.videosCompletedAt) status.append(el("span", "muted", `${t("analyticsVideosSynced")}: ${date(progress.videosCompletedAt, true)}`));
    if (dataset.meta.followersAsOf) status.append(el("span", "muted", `${t("analyticsFollowersSynced")}: ${date(dataset.meta.followersAsOf, true)}`));
    const poll = dataset.meta["health:poll"];
    const lastPoll = poll?.lastSuccessAt || (poll?.state === "ok" ? poll.at : null);
    const resultLabel = poll?.lastResult === "live" ? "analyticsPollLive" : poll?.lastResult === "offline" ? "analyticsPollOffline" : null;
    status.append(el("span", "muted", lastPoll
        ? `${t("analyticsLastPoll")}: ${date(lastPoll, true)}${resultLabel ? ` (${t(resultLabel)})` : ""}`
        : t("analyticsPollPending")));
    const health = Object.entries(dataset.meta).filter(([key]) => key.startsWith("health:")).map(([, value]) => value.state);
    const warnings = new Set(health.map(state => state === "auth_error" ? "analyticsStatusAuth" : state === "rate_limited" ? "analyticsStatusRate"
        : state === "error" || state === "storage_error" ? "analyticsStatusError" : state === "disconnected" ? "analyticsStatusDisconnected" : null).filter(Boolean));
    if (settings.enabled) {
        const lastCheck = Date.parse(lastPoll || dataset.meta.analyticsEnabledAt);
        if (!Number.isFinite(lastCheck) || Date.now() - lastCheck > 180000) warnings.add("analyticsPollStale");
        const eventsConnected = health.includes("connected") && dataset.eventIntervals.some(interval => Date.now() - Date.parse(interval.lastSeenAt) < 20000);
        if (health.includes("connected") && !eventsConnected) warnings.add("analyticsStatusDisconnected");
        for (const key of warnings) status.append(el("p", "warning", t(key)));
        if (eventsConnected) status.append(el("span", "muted", t("analyticsStatusConnected")));
    }
    disable.hidden = !settings.enabled; sync.disabled = !settings.enabled;
    enable.hidden = settings.enabled && !health.includes("auth_error");
}
function section(title, note, wide = false) {
    const panel = el("section", `panel${wide ? " full-width" : ""}`);
    panel.append(el("h2", "", t(title)));
    if (note) panel.append(el("p", "section-note", t(note)));
    return panel;
}
function plotPanel(title, options, note, wide = false) {
    const panel = section(title, note, wide), container = el("div", "chart");
    panel.append(container);
    chart(container, { empty: t("analyticsEmptyChart"), label: t(title), ...options });
    return panel;
}
function tooltip(stream) {
    return [date(stream.startedAt, true), stream.finalCategoryName || t("analyticsUnknownCategory"), stream.finalTitle || "",
        sourceName(stream.source), ...metricKeys.map((key, index) => `${t(metricLabels[index])}: ${num(stream[key])}`),
        `${t("analyticsCoverage")}: ${percent(stream.viewerCoverage)}`].join("\n");
}
function streamPoints(streams) { return streams.map(s => ({ ...s, time: Date.parse(s.startedAt), label: date(s.startedAt), tooltip: tooltip(s) })); }
function table(headers, rows) {
    const wrap = el("div", "table-scroll"), node = el("table"), head = el("thead"), row = el("tr"), body = el("tbody");
    for (const header of headers) { const cell = el("th", "", t(header)); cell.scope = "col"; row.append(cell); }
    head.append(row);
    for (const values of rows) {
        const tr = el("tr");
        values.forEach(value => { const cell = el("td"); if (value instanceof Node) cell.append(value); else cell.textContent = value; tr.append(cell); });
        body.append(tr);
    }
    node.append(head, body); wrap.append(node); return wrap;
}
function followDaily(bounds) {
    const daysMap = new Map();
    // A partially observed day may have known events; zero is shown only for fully covered days.
    const earliest = Math.min(Date.now(), ...dataset.eventIntervals.map(i => Date.parse(i.startedAt)), ...dataset.followEvents.map(e => Date.parse(e.followedAt)));
    const start = new Date(Math.max(earliest, bounds.start)); start.setHours(0, 0, 0, 0);
    for (let day = new Date(start); day.getTime() < bounds.end; day.setDate(day.getDate() + 1)) {
        const end = new Date(day); end.setDate(end.getDate() + 1);
        const from = Math.max(day.getTime(), bounds.start), to = Math.min(end.getTime(), bounds.end);
        const coverage = coveredMilliseconds(dataset.eventIntervals, new Date(from).toISOString(), new Date(to).toISOString(), "channel.follow");
        const complete = coverage >= to - from - 1000;
        daysMap.set(localDay(day), { label: date(day), time: day.getTime(), during: complete ? 0 : null, outside: complete ? 0 : null, uncertain: complete ? 0 : null });
    }
    for (const event of dataset.followEvents.filter(e => inPeriod(e.followedAt, bounds))) {
        const key = localDay(event.followedAt);
        if (!daysMap.has(key)) daysMap.set(key, { label: date(event.followedAt), time: Date.parse(event.followedAt), during: null, outside: null, uncertain: null });
        const point = daysMap.get(key), field = event.duringStream === true ? "during" : event.duringStream === false ? "outside" : "uncertain";
        point[field] = (point[field] || 0) + 1;
    }
    return [...daysMap.values()].sort((a, b) => a.time - b.time).map(point => ({ ...point,
        tooltip: `${point.label}\n${t("analyticsDuring")}: ${num(point.during)}\n${t("analyticsOutside")}: ${num(point.outside)}\n${t("analyticsUncertain")}: ${num(point.uncertain)}` }));
}
function monthly(streams) {
    const groups = new Map();
    for (const stream of streams) {
        const key = localDay(stream.startedAt).slice(0, 7);
        if (!groups.has(key)) groups.set(key, { label: key, hours: null, count: 0 });
        const item = groups.get(key); item.count++;
        if (finite(stream.duration)) item.hours = (item.hours || 0) + stream.duration / 3600000;
    }
    return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}
function render() {
    if (!dataset) return;
    renderStatus();
    renderReview();
    filter.querySelectorAll("button").forEach(node => node.setAttribute("aria-pressed", node.dataset.days === days));
    dashboard.replaceChildren();
    const bounds = periodBounds(days);
    const streams = dataset.streams.filter(s => inPeriod(s.startedAt, bounds)).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const previous = days === "all" ? [] : dataset.streams.filter(s => inPeriod(s.startedAt, { start: bounds.start - (bounds.end - bounds.start), end: bounds.start }));
    const currentKpis = kpis(streams), previousKpis = kpis(previous);
    const observedFollowTotal = range => {
        const events = dataset.followEvents.filter(e => inPeriod(e.followedAt, range));
        return events.length || dataset.eventIntervals.some(i => i.types.includes("channel.follow") && Date.parse(i.lastSeenAt) >= range.start && Date.parse(i.startedAt) < range.end) ? events.length : null;
    };
    currentKpis.newFollows = observedFollowTotal(bounds);
    previousKpis.newFollows = days === "all" ? null : observedFollowTotal({ start: bounds.start - Number(days) * DAY_MS, end: bounds.start });
    const cards = el("div", "kpi-grid full-width");
    metricKeys.forEach((key, index) => {
        const card = el("article", "kpi-card");
        card.append(el("h3", "", t(metricLabels[index])), el("strong", "kpi-value", num(currentKpis[key])));
        const delta = changePercent(currentKpis[key], previousKpis[key]);
        card.append(el("span", finite(delta) && delta >= 0 ? "delta positive" : "delta", finite(delta) ? `${delta >= 0 ? "↑" : "↓"} ${num(Math.abs(delta))}%` : "—"));
        if (key === "firstChatters") card.title = t("analyticsFirstInfo");
        cards.append(card);
    });
    dashboard.append(cards, el("p", "comparison-note full-width", t(days === "all" ? "analyticsNoComparison" : "analyticsComparison")));
    const measuredStreams = streams.filter(stream => stream.source === "stream_helper");
    if (measuredStreams.some(stream => coverageLevel(stream.viewerCoverage) !== "normal")) dashboard.append(el("p", "warning full-width", t("analyticsReference")));
    if (measuredStreams.some(stream => ["chat", "follow", "raid"].some(key => !finite(stream.eventCoverage?.[key]) || stream.eventCoverage[key] < 99.9))) {
        dashboard.append(el("p", "warning full-width", t("analyticsEventWarning")));
    }
    if (!streams.length) dashboard.append(el("p", "empty-state full-width", t("analyticsNoHistory")));
    dashboard.append(plotPanel("analyticsViewersChart", { points: streamPoints(streams), series: [{ key: "avgViewers", label: t("analyticsAvg") }, { key: "peakViewers", label: t("analyticsPeak") }], onSelect: openDetail }, "analyticsNextStream", true));
    const dailySnapshots = new Map();
    for (const snapshot of dataset.followerSnapshots.filter(s => inPeriod(s.timestamp, bounds)).sort((a, b) => a.timestamp.localeCompare(b.timestamp))) {
        dailySnapshots.set(localDay(snapshot.timestamp), { label: date(snapshot.timestamp), time: Date.parse(snapshot.timestamp), total: snapshot.total,
            tooltip: `${date(snapshot.timestamp, true)}\n${t("analyticsFollowersChart")}: ${num(snapshot.total)}` });
    }
    dashboard.append(plotPanel("analyticsFollowersChart", { points: [...dailySnapshots.values()], series: [{ key: "total", label: t("analyticsFollowersChart") }], gapMs: DAY_MS * 1.6 }));
    dashboard.append(plotPanel("analyticsFollowsChart", { points: followDaily(bounds), series: [{ key: "during", label: t("analyticsDuring") }, { key: "outside", label: t("analyticsOutside") }, { key: "uncertain", label: t("analyticsUncertain") }], kind: "bar", stacked: true }, "analyticsFollowNote"));
    dashboard.append(plotPanel("analyticsChattersChart", { points: streamPoints(streams), series: [{ key: "firstChatters", label: t("analyticsFirst") }, { key: "returningChatters", label: t("analyticsReturning") }], kind: "bar", stacked: true, onSelect: openDetail }, "analyticsFirstInfo"));
    const acquisition = new Map();
    for (const follower of dataset.currentFollowers.filter(f => inPeriod(f.followedAt, bounds))) {
        const key = localDay(follower.followedAt).slice(0, 7); acquisition.set(key, (acquisition.get(key) || 0) + 1);
    }
    const acquisitionPanel = plotPanel("analyticsAcquisitionChart", { points: [...acquisition].sort().map(([label, count]) => ({ label, count })), series: [{ key: "count", label: t("analyticsAcquisitionChart") }], kind: "bar" }, "analyticsAcquisitionNote");
    if (dataset.meta.followersAsOf) acquisitionPanel.append(el("p", "muted", `${t("analyticsAsOf")}: ${date(dataset.meta.followersAsOf, true)}`));
    dashboard.append(acquisitionPanel);
    const months = monthly(streams);
    dashboard.append(plotPanel("analyticsActivityChart", { points: months, series: [{ key: "hours", label: t("analyticsHours") }], kind: "bar" }));
    dashboard.append(plotPanel("analyticsCountChart", { points: months, series: [{ key: "count", label: t("analyticsStreams") }], kind: "bar" }));
    const categories = section("analyticsCategorySection", "analyticsCategoryNote", true);
    categories.append(table(["analyticsCategory", "analyticsStreams", "analyticsAvg", "analyticsPeakMean", "analyticsFirstPerStream", "analyticsFollowPerStream"], categoryStats(streams)
        .map(row => [row.category || t("analyticsUnknownCategory"), num(row.count), num(row.avgViewers), num(row.peakViewers), num(row.firstChatters), num(row.newFollows)])));
    dashboard.append(categories);
    const retention = section("analyticsRetention", "analyticsRetentionNote");
    const cohort = dataset.chatterProfiles.filter(p => inPeriod(p.firstChatAt, bounds));
    retention.append(el("strong", "kpi-value", cohort.length ? `${cohort.filter(p => p.streamCount > 1).length} / ${cohort.length}` : t("analyticsNoData")));
    dashboard.append(retention);
    const best = section("analyticsBest");
    best.append(table(["analyticsOverview", "analyticsThisStream"], [0, 1, 2, 4].map(i => [t(metricLabels[i]), num(maximum(streams.map(s => s[metricKeys[i]])))])));
    dashboard.append(best);
    const history = section("analyticsList", null, true);
    history.append(table(["analyticsDate", "analyticsStreamTitle", "analyticsCategory", "analyticsDuration", "analyticsAvg", "analyticsPeak", "analyticsFirst", "analyticsReturning", "analyticsFollows", "analyticsCoverage"], [...streams].reverse().map(stream => {
        const title = button("analyticsDetail", () => openDetail(stream.streamId), "text-button"); title.textContent = stream.finalTitle || stream.initialTitle || stream.streamId;
        title.title = sourceName(stream.source);
        return [date(stream.startedAt, true), title, stream.finalCategoryName || t("analyticsUnknownCategory"), duration(stream.duration), num(stream.avgViewers), num(stream.peakViewers), num(stream.firstChatters), num(stream.returningChatters), num(stream.newFollows), percent(stream.viewerCoverage)];
    })));
    const exports = el("div", "export-actions");
    exports.append(button("analyticsExportStreams", () => downloadCSV("streams.csv", streamsCSV(dataset.streams, bounds))), button("analyticsExportSamples", async () => {
        const samples = db ? await db.all("viewerSamples", "timestamp", IDBKeyRange.bound(new Date(Number.isFinite(bounds.start) ? bounds.start : 0).toISOString(), new Date(bounds.end).toISOString(), false, true)) : [];
        downloadCSV("viewer_samples.csv", samplesCSV(samples, bounds));
    }));
    history.append(exports, el("p", "section-note", t("analyticsExportNote")));
    dashboard.append(history);
}
function reviewStreams() {
    return [...dataset.streams].sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || "")
        || String(b.streamId).localeCompare(String(a.streamId)));
}
function moveReview(direction) {
    const streams = reviewStreams(), index = streams.findIndex(stream => stream.streamId === selectedStreamId);
    const target = streams[index + direction];
    if (index < 0 || !target) return;
    selectedStreamId = target.streamId;
    renderReview();
}
function renderReview() {
    if (!dataset) return;
    if (reviewOwnerId !== settings.ownerId) {
        reviewOwnerId = settings.ownerId; selectedStreamId = null;
    }
    // The period filter belongs to the overview. Browse all saved broadcasts here,
    // keeping the chosen ID stable when a refresh imports or updates other streams.
    const streams = reviewStreams();
    const index = Math.max(0, streams.findIndex(stream => stream.streamId === selectedStreamId));
    const stream = streams[index];
    selectedStreamId = stream?.streamId || null;
    olderStream.disabled = !stream || index === streams.length - 1;
    newerStream.disabled = !stream || index === 0;
    latestStream.disabled = !stream || index === 0;
    reviewPosition.hidden = !stream;
    reviewPosition.textContent = t("analyticsRecordPosition", [num(stream ? streams.length - index : 0, 0), num(streams.length, 0)]);
    reviewBody.replaceChildren();
    delete reviewBody.dataset.streamId;
    if (!stream) {
        reviewBody.append(el("p", "muted", t("analyticsNoSavedStreams")));
        return;
    }
    reviewBody.dataset.streamId = stream.streamId;
    const metadata = el("div", "detail-meta");
    metadata.append(el("span", stream.status === "live" ? "badge connected" : "badge",
        t(stream.status === "live" ? "analyticsLive" : stream.source === "stream_helper" ? "analyticsSourceMeasured" : "analyticsSourceBackfill")),
        el("span", "", date(stream.startedAt, true)),
        el("span", "", stream.finalCategoryName || stream.initialCategoryName || t("analyticsUnknownCategory")),
        el("span", "", `${t("analyticsDuration")}: ${duration(stream.duration)}`),
        el("span", "", `${t("analyticsCoverage")}: ${percent(stream.viewerCoverage)}`));
    const title = el("h3", "stream-review-title", stream.finalTitle || stream.initialTitle || stream.streamId);
    reviewBody.append(title, metadata, compactMetrics(stream));
    if (stream.source === "twitch_backfill") reviewBody.append(el("p", "section-note", t("analyticsBackfillMetrics")));
    else reviewBody.append(recapNotes(stream));
    if (stream.labels?.length) {
        const labels = el("div", "stream-labels");
        for (const label of stream.labels) labels.append(el("span", "badge", label));
        reviewBody.append(labels);
    }
    reviewBody.append(button("analyticsDetail", () => openDetail(stream.streamId), "button primary"));
}
function compactMetrics(stream) {
    const row = el("div", "compact-metrics");
    metricKeys.forEach((key, i) => { const item = el("div"); item.append(el("span", "muted", t(metricLabels[i])), el("strong", "", num(stream[key]))); row.append(item); });
    return row;
}
function recapNotes(stream) {
    const list = el("ul", "recap-notes"), previous = comparisons(stream, dataset.streams);
    for (const [key, label] of [["avgViewers", "analyticsGoodAvg"], ["firstChatters", "analyticsGoodFirst"], ["newFollows", "analyticsGoodFollow"]]) {
        if (finite(stream[key]) && finite(previous.values[key]) && stream[key] > previous.values[key]) list.append(el("li", "positive", t(label)));
    }
    if (coverageLevel(stream.viewerCoverage) !== "normal") list.append(el("li", "warning", t("analyticsReference")));
    if (["chat", "follow", "raid"].some(key => !finite(stream.eventCoverage?.[key]) || stream.eventCoverage[key] < 99.9)) list.append(el("li", "warning", t("analyticsEventWarning")));
    return list;
}
function ratingSelect(value, onChange) {
    const select = el("select", "control"); select.setAttribute("aria-label", t("analyticsRating"));
    for (const [key, label] of [["", "analyticsUnrated"], ["favorite", "analyticsFavorite"], ["neutral", "analyticsNeutral"], ["weak", "analyticsWeak"]]) {
        const option = el("option", "", t(label)); option.value = key; select.append(option);
    }
    select.value = value || "";
    select.addEventListener("change", () => Promise.resolve(onChange(select.value || null)).catch(showError));
    return select;
}
async function openDetail(streamId) {
    if (!db) return;
    const detailDB = db;
    const stream = await detailDB.get("streams", streamId);
    if (!stream) return;
    const [samples, titles, categories, raids] = await Promise.all(["viewerSamples", "titleHistory", "categoryHistory", "raidEvents"].map(name => detailDB.all(name, "streamId", streamId)));
    const dialog = el("dialog", "detail-dialog"), content = el("div", "detail-content"), heading = el("div", "detail-heading");
    heading.append(el("h2", "", stream.finalTitle || stream.initialTitle || t("analyticsDetail")), button("analyticsClose", () => dialog.close()));
    const metadata = el("div", "detail-meta");
    metadata.append(el("span", "badge", sourceName(stream.source)), el("span", "", `${t("analyticsStart")}: ${date(stream.startedAt, true)}`),
        el("span", "", `${t("analyticsEnd")}: ${stream.status === "live" ? t("analyticsLive") : date(stream.endedAt, true)}`),
        el("span", "", `${t("analyticsDuration")}: ${duration(stream.duration)}`));
    content.append(heading, metadata, compactMetrics(stream));
    if (stream.source === "twitch_backfill") content.append(el("p", "section-note", t("analyticsBackfillMetrics")));
    else content.append(recapNotes(stream));
    if (stream.endedAtSource === "poll_observation" || stream.endedAtSource === "unknown") {
        content.append(el("p", "warning", t(stream.endedAtSource === "unknown" ? "analyticsEndUnknown" : "analyticsEndObserved")),
            el("p", "muted", `${t("analyticsBounds")}: ${date(stream.endLowerBound, true)} → ${date(stream.endUpperBound, true)}`));
    }
    if (stream.vodDuration !== null && stream.vodDuration !== undefined) {
        content.append(el("p", "section-note", `${t("analyticsVodDuration")}: ${duration(stream.vodDuration)}`),
            el("p", "section-note", t("analyticsVodTimingNote")));
    }
    if (stream.source === "stream_helper" && !stream.chatOriginVersion && stream.uniqueChatters > 0) {
        content.append(el("p", "warning", t("analyticsLegacyChatOrigin")));
    }
    const coverage = el("section", "panel");
    const level = coverageLevel(stream.viewerCoverage), coverageLabel = { normal: "analyticsCoverageNormal", partial: "analyticsCoveragePartial", reference: "analyticsCoverageReference", unknown: "analyticsCoverageUnknown" }[level];
    coverage.append(el("h3", "", `${t("analyticsCoverage")}: ${percent(stream.viewerCoverage)} · ${t(coverageLabel)}`),
        el("p", "", `${t("analyticsSamples")}: ${num(stream.viewerSampleCount)} · ${t("analyticsUnique")}: ${num(stream.uniqueChatters)}`));
    coverage.append(table(["analyticsEventCoverage", "analyticsCoverage"], [["chat", "analyticsChatCoverage"], ["follow", "analyticsFollowCoverage"], ["raid", "analyticsRaidCoverage"], ["update", "analyticsUpdateCoverage"]].map(([key, label]) => [t(label), percent(stream.eventCoverage?.[key])])));
    content.append(coverage, plotPanel("analyticsViewerDetail", { points: samples.map(s => ({ ...s, time: Date.parse(s.timestamp), label: new Date(s.timestamp).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }), tooltip: `${date(s.timestamp, true)}\n${t("analyticsAvg")}: ${num(s.viewerCount)}` })), series: [{ key: "viewerCount", label: t("analyticsAvg") }], gapMs: 90_000 }));
    const comparison = section("analyticsCompareTen");
    const prior = comparisons(stream, dataset.streams);
    comparison.append(el("p", "muted", `${t("analyticsStreams")}: ${prior.count}`), table(["analyticsOverview", "analyticsThisStream", "analyticsPrevious", "analyticsChange"], metricKeys.map((key, i) => [t(metricLabels[i]), num(stream[key]), num(prior.values[key]), percent(changePercent(stream[key], prior.values[key]))])));
    content.append(comparison);
    const titlesPanel = section("analyticsTitleHistory", "analyticsHistoryNote");
    titles.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const ratingStatus = el("span", "muted"); ratingStatus.setAttribute("role", "status");
    titlesPanel.append(table(["analyticsDate", "analyticsStreamTitle", "analyticsSource", "analyticsRating"], titles.map(row => [date(row.timestamp, true), row.title, sourceName(row.source), ratingSelect(row.rating, async rating => {
        try {
            await detailDB.update("titleHistory", [streamId, row.timestamp], current => ({ ...current, rating }));
            if (row === titles.at(-1)) await detailDB.update("streams", streamId, current => ({ ...current, titleRating: rating }));
            ratingStatus.textContent = t("analyticsSaved"); await load();
        } catch (_) { ratingStatus.textContent = t("analyticsLocalError"); }
    })])), ratingStatus);
    content.append(titlesPanel);
    const categoryPanel = section("analyticsCategoryHistory");
    categoryPanel.append(table(["analyticsDate", "analyticsCategory"], categories.sort((a, b) => a.timestamp.localeCompare(b.timestamp)).map(row => [date(row.timestamp, true), row.categoryName || t("analyticsUnknownCategory")])));
    content.append(categoryPanel);
    const raidPanel = section("analyticsRaid");
    raidPanel.append(el("p", "", `${t("analyticsRaid")}: ${num(stream.raidCount)} · ${t("analyticsRaidViewers")}: ${num(stream.raidViewers)}`),
        table(["analyticsDate", "analyticsRaidFrom", "analyticsRaidViewers"], raids.map(row => [date(row.timestamp, true), row.fromBroadcasterName, num(row.viewers)])),
        el("p", "", `${t("analyticsFollowerStart")}: ${num(stream.followerCountStart)} · ${t("analyticsFollowerEnd")}: ${num(stream.followerCountEnd)}`),
        el("p", "muted", `${t("analyticsSnapshotTimes")}: ${date(stream.followerCountStartAt, true)} → ${date(stream.followerCountEndAt, true)}`));
    content.append(raidPanel);
    const form = el("form", "annotation-form panel");
    const noteLabel = el("label", "", t("analyticsNote")), note = el("textarea", "control");
    note.value = stream.note || ""; note.maxLength = 10000; note.rows = 4; note.id = "stream-note"; noteLabel.htmlFor = note.id;
    const labelLabel = el("label", "", t("analyticsLabels")), labels = el("input", "control");
    labels.value = (stream.labels || []).join(", "); labels.maxLength = 2000; labels.id = "stream-labels"; labelLabel.htmlFor = labels.id;
    const saved = el("span", "positive"); saved.setAttribute("role", "status");
    const save = el("button", "button primary", t("analyticsSave")); save.type = "submit";
    form.append(noteLabel, note, labelLabel, labels, el("p", "section-note", t("analyticsLabelsInfo")), save, saved);
    form.addEventListener("submit", async event => {
        event.preventDefault(); save.disabled = true;
        try {
            await detailDB.update("streams", streamId, current => ({ ...current, note: note.value,
                labels: [...new Set(labels.value.split(/[,、]/).map(value => value.trim()).filter(Boolean))] }));
            saved.textContent = t("analyticsSaved"); await load();
        } catch (_) { saved.textContent = t("analyticsLocalError"); }
        finally { save.disabled = false; }
    });
    content.append(form); dialog.append(content); document.body.append(dialog);
    dialog.addEventListener("close", () => dialog.remove()); dialog.showModal();
}
await load();
// Read local summaries only. This timer never polls Twitch and never enables collection.
setInterval(() => { if (!document.hidden && !document.querySelector("dialog[open]")) load(); }, 30_000);
