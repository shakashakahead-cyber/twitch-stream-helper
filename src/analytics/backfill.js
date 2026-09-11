import { getArchiveVideos, getChannelFollowers } from "../api.js";
import { requestResult } from "./db.js";
import { iso, parseDuration, DAY_MS } from "./aggregator.js";

export function vodRecord(video) {
    if (!video.stream_id || !Number.isFinite(Date.parse(video.created_at))) return null;
    const duration = parseDuration(video.duration);
    return { streamId: video.stream_id, source: "twitch_backfill", status: "ended",
        startedAt: iso(Date.parse(video.created_at)), startedAtSource: "vod",
        endedAt: duration === null ? null : iso(Date.parse(video.created_at) + duration),
        endedAtSource: "twitch_backfill", duration, initialTitle: video.title, finalTitle: video.title,
        initialCategoryId: null, initialCategoryName: null, finalCategoryId: null, finalCategoryName: null,
        avgViewers: null, peakViewers: null, viewerSampleCount: null, viewerCoverage: null, eventCoverage: null,
        uniqueChatters: null, firstChatters: null, returningChatters: null, newFollows: null,
        followerCountStart: null, followerCountEnd: null, raidCount: null, raidViewers: null,
        videoId: video.id, vodViewCount: video.view_count, vodDuration: duration,
        vods: [{ videoId: video.id, startedAt: iso(Date.parse(video.created_at)),
            endedAt: duration === null ? null : iso(Date.parse(video.created_at) + duration), duration, title: video.title, viewCount: video.view_count }],
        labels: [], note: "", titleRating: null,
    };
}
export async function mergeVideos(db, videos) {
    const changedIds = new Set();
    await db.transaction(["streams", "titleHistory"], "readwrite", async stores => {
        for (const video of videos) {
            const record = vodRecord(video);
            if (!record) continue;
            changedIds.add(record.streamId);
            const existing = await requestResult(stores.streams.get(record.streamId));
            if (existing) {
                // A VOD must never replace measured values, annotations or live status.
                const merged = { ...existing };
                const vods = new Map((existing.vods || []).map(v => [v.videoId, v]));
                vods.set(video.id, record.vods[0]);
                merged.vods = [...vods.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
                const representative = [...merged.vods].sort((a, b) => (b.duration || 0) - (a.duration || 0))[0];
                Object.assign(merged, { videoId: representative.videoId, vodViewCount: representative.viewCount, vodDuration: representative.duration });
                if (existing.source === "twitch_backfill" || existing.startedAtSource === "vod") {
                    merged.startedAt = merged.vods[0].startedAt;
                    const oneStart = merged.vods.every(v => v.startedAt === merged.startedAt);
                    // Different recording start times may be separate fragments. Do not
                    // turn the gaps between them into a fabricated broadcast duration.
                    merged.duration = oneStart ? representative.duration : null;
                    merged.endedAt = oneStart ? representative.endedAt : null;
                }
                await requestResult(stores.streams.put(merged));
            } else {
                await requestResult(stores.streams.put(record));
                await requestResult(stores.titleHistory.put({ streamId: record.streamId, timestamp: record.startedAt,
                    title: record.initialTitle, source: "twitch_backfill", rating: null }));
            }
        }
    });
    return [...changedIds];
}

// Video refreshes and full current-follower snapshots have independent checkpoints.
export const FOLLOWER_SYNC_INTERVAL_MS = 7 * DAY_MS;
export const BACKFILL_MAX_PAGES = 10;
export const BACKFILL_BUDGET_MS = 5000;
const newJob = (now, previous = {}) => ({ state: "running", cursor: "", startedAt: iso(now), pages: 0, processed: 0,
    completedAt: previous.completedAt });
const newFollowerJob = (now, previous = {}) => ({ ...newJob(now, previous),
    generation: iso(Math.max(now, (Date.parse(previous.generation) || 0) + 1)) });
async function jobsFor(db, now) {
    let jobs = await db.meta("syncJobs");
    if (jobs) return jobs;
    const legacy = await db.meta("backfill"), complete = await db.meta("twitchBackfillCompletedAt");
    jobs = { videos: newJob(now), followers: newFollowerJob(now) };
    if (legacy?.phase === "complete") {
        jobs.videos = { state: "complete", completedAt: complete };
        jobs.followers = { state: "complete", completedAt: complete };
    } else if (legacy) {
        jobs.followers.generation = legacy.generation || iso(now);
        if (legacy.phase === "followers") {
            jobs.videos = { state: "complete", completedAt: iso(now) };
            jobs.followers.cursor = legacy.cursor || "";
            jobs.followers.startedAt = Number.isFinite(Date.parse(legacy.generation)) ? legacy.generation : null;
            if (jobs.followers.cursor) jobs.followers.processed = null;
        } else {
            jobs.videos.cursor = legacy.cursor || "";
            if (jobs.videos.cursor) jobs.videos.processed = null;
        }
    }
    await saveJobs(db, jobs);
    return jobs;
}
async function saveJobs(db, jobs, extra = {}) {
    const phase = jobs.videos.state === "running" ? "videos" : jobs.followers.state === "running" ? "followers" : "complete";
    const job = jobs[phase] || {};
    const progress = { phase, cursor: job.cursor || "", generation: jobs.followers.generation,
        processed: job.processed ?? null, total: job.total ?? null,
        startedAt: job.startedAt, videosCompletedAt: jobs.videos.completedAt, followersCompletedAt: jobs.followers.completedAt };
    await db.transaction(["metadata"], "readwrite", async stores => {
        for (const [key, value] of Object.entries({ syncJobs: jobs, backfill: progress, ...extra })) {
            await requestResult(stores.metadata.put({ key, value }));
        }
    });
    return progress;
}
export async function requestBackfill(db, { followers = false, now = Date.now() } = {}) {
    const jobs = await jobsFor(db, now);
    if (jobs.videos.state !== "running") jobs.videos = newJob(now, jobs.videos);
    else if (Date.parse(jobs.videos.startedAt) < now) jobs.videos.rerunRequested = true;
    if (followers && jobs.followers.state !== "running") jobs.followers = newFollowerJob(now, jobs.followers);
    return saveJobs(db, jobs);
}
export async function scheduleBackfill(db, now = Date.now()) {
    const jobs = await jobsFor(db, now);
    if (jobs.videos.state !== "running" && (!jobs.videos.completedAt || now - Date.parse(jobs.videos.completedAt) >= DAY_MS)) jobs.videos = newJob(now, jobs.videos);
    if (jobs.followers.state !== "running" && (!jobs.followers.completedAt || now - Date.parse(jobs.followers.completedAt) >= FOLLOWER_SYNC_INTERVAL_MS)) {
        jobs.followers = newFollowerJob(now, jobs.followers);
    }
    return saveJobs(db, jobs);
}
async function cleanOldFollowers(db) {
    if (!await db.meta("followersCleanupPending")) return;
    const generation = await db.meta("followerGeneration");
    const finished = await db.transaction(["currentFollowers"], "readwrite", stores => new Promise((resolve, reject) => {
        const request = stores.currentFollowers.openCursor(); let deleted = 0;
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) { resolve(true); return; }
            if (cursor.value.generation !== generation) { cursor.delete(); deleted++; }
            if (deleted >= 1000) { resolve(false); return; }
            cursor.continue();
        };
    }));
    if (finished) await db.setMeta("followersCleanupPending", false);
}
export async function backfillStep(db, ownerId, now = Date.now()) {
    const jobs = await jobsFor(db, now);
    const phase = jobs.videos.state === "running" ? "videos" : jobs.followers.state === "running" ? "followers" : "complete";
    if (phase === "complete") { await cleanOldFollowers(db); return db.meta("backfill"); }
    const job = jobs[phase];
    let page;
    try { page = phase === "videos" ? await getArchiveVideos(ownerId, job.cursor) : await getChannelFollowers(ownerId, job.cursor); }
    catch (error) {
        if (error?.status === 400) {
            // Restart only the failed cursor; leave the other job and published snapshot intact.
            jobs[phase] = phase === "videos" ? newJob(now, job) : newFollowerJob(now, job);
            await saveJobs(db, jobs);
        }
        throw error;
    }
    const cursor = page.pagination?.cursor || "";
    if (cursor && cursor === job.cursor) throw new Error("Repeated Twitch pagination cursor");
    const changedIds = phase === "videos" ? await mergeVideos(db, page.data) : [];
    const extra = {};
    if (phase === "followers") {
        await db.transaction(["currentFollowers"], "readwrite", async stores => {
            for (const follower of page.data) await requestResult(stores.currentFollowers.put({ generation: job.generation,
                userId: follower.user_id, followedAt: follower.followed_at }));
        });
        job.total = page.total;
        if (!cursor) Object.assign(extra, { followerGeneration: job.generation, followersAsOf: iso(now),
            followersSnapshotStartedAt: job.startedAt, followersCleanupPending: true });
    }
    Object.assign(job, { cursor, pages: job.pages + 1,
        processed: typeof job.processed === "number" ? job.processed + page.data.length : null });
    if (!cursor) Object.assign(job, { state: "complete", completedAt: iso(now) });
    if (!cursor && phase === "videos" && job.rerunRequested) jobs.videos = newJob(now, job);
    if (jobs.videos.state === "complete" && jobs.followers.state === "complete") extra.twitchBackfillCompletedAt = iso(now);
    const progress = await saveJobs(db, jobs, extra);
    return { ...progress, changedIds };
}
export async function runBackfill(db, ownerId, { now = () => Date.now(), onVideos = async () => {} } = {}) {
    const started = now(); let progress;
    // A bounded batch speeds up history without starving live polling. Each page commits
    // before the next request; any error (including 429) stops the batch immediately.
    for (let page = 0; page < BACKFILL_MAX_PAGES; page++) {
        if (page && now() - started >= BACKFILL_BUDGET_MS) break;
        if ((await db.meta("retryAt") || 0) > now()) break;
        progress = await backfillStep(db, ownerId, now());
        if (progress.changedIds?.length) await onVideos(progress.changedIds);
        if (progress.phase === "complete") break;
    }
    return progress;
}
