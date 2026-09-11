export const EVENTSUB_URL = "wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=10";
export const HEARTBEAT_GRACE_MS = 1500;
export function subscriptions(ownerId) {
    return [
        ["channel.chat.message", "1", { broadcaster_user_id: ownerId, user_id: ownerId }],
        ["channel.follow", "2", { broadcaster_user_id: ownerId, moderator_user_id: ownerId }],
        ["channel.raid", "1", { to_broadcaster_user_id: ownerId }],
        ["channel.update", "2", { broadcaster_user_id: ownerId }],
    ];
}
export function isReconnectUrl(value) {
    try { const url = new URL(value); return url.protocol === "wss:" && url.hostname === "eventsub.wss.twitch.tv" && !url.username && !url.password && !url.port; }
    catch (_) { return false; }
}

// Sanitize at the transport boundary. Chat bodies and user names never enter the queue/DB.
export function analyticsEvent(message) {
    const type = message.payload?.subscription?.type;
    const event = message.payload?.event;
    const id = message.metadata?.message_id, timestamp = message.metadata?.message_timestamp;
    if (!id || !event || !Number.isFinite(Date.parse(timestamp))) return null;
    const base = { id, type, timestamp: new Date(timestamp).toISOString(), broadcasterId: event.broadcaster_user_id };
    if (type === "channel.chat.message") return { ...base, userId: event.chatter_user_id,
        sourceBroadcasterId: event.source_broadcaster_user_id || event.broadcaster_user_id };
    if (type === "channel.follow") return Number.isFinite(Date.parse(event.followed_at))
        ? { ...base, userId: event.user_id, followedAt: new Date(event.followed_at).toISOString() } : null;
    if (type === "channel.raid") return { ...base, broadcasterId: event.to_broadcaster_user_id,
        fromBroadcasterId: event.from_broadcaster_user_id, fromBroadcasterName: event.from_broadcaster_user_name, viewers: event.viewers };
    if (type === "channel.update") return { ...base, title: event.title, categoryId: event.category_id, categoryName: event.category_name };
    return null;
}

export class EventSubClient {
    constructor({ ownerId, subscribe, onEvent, onInterval, onStatus, Socket = WebSocket, now = () => Date.now() }) {
        Object.assign(this, { ownerId, subscribe, onEvent, onInterval, onStatus, Socket, now });
        this.sockets = new Set();
        this.stopped = true;
        this.retryAt = 0;
        this.failures = 0;
        this.interval = null;
    }
    start() { this.stopped = false; this.ensure(); }
    ensure() {
        if (!this.stopped && !this.sockets.size && this.now() >= this.retryAt) this.connect(EVENTSUB_URL);
    }
    report(value) { Promise.resolve(this.onStatus(value)).catch(() => {}); }
    backoff(error) {
        this.retryAt = Math.max(this.retryAt, this.now() + Math.min(300_000, 60_000 * 2 ** Math.min(this.failures++, 3)), error?.retryAt || 0);
        this.report({ state: error?.status === 429 ? "rate_limited" : error?.status === 401 || error?.status === 403 ? "auth_error" : "disconnected", retryAt: this.retryAt });
    }
    retire(context) {
        clearTimeout(context.watchdog);
        if (!this.sockets.delete(context)) return;
        if (!this.sockets.size) {
            this.interval = null;
            if (!this.stopped) {
                this.retryAt = Math.max(this.retryAt, this.now() + 60_000);
                if (!context.failureReported) this.report({ state: "disconnected", retryAt: this.retryAt });
            }
        }
    }
    beat(context) {
        if (!context.ready) return;
        const now = this.now();
        // A suspended browser may resume with an apparently open socket. Split coverage.
        if (!this.interval || now - Date.parse(this.interval.lastSeenAt) > context.timeout + HEARTBEAT_GRACE_MS) {
            this.interval = { id: crypto.randomUUID(), startedAt: new Date(now).toISOString(), types: [...context.types] };
            this.lastPersistedAt = -Infinity;
        }
        this.interval.lastSeenAt = new Date(now).toISOString();
        // Busy chat must not write the same interval for every message.
        if (now - this.lastPersistedAt >= 1000) {
            this.lastPersistedAt = now;
            Promise.resolve(this.onInterval({ ...this.interval })).catch(() => this.report({ state: "storage_error" }));
        }
    }
    connect(url, previous = null) {
        if (this.stopped) return;
        let socket;
        try { socket = new this.Socket(url); }
        catch (error) { this.backoff(error); return; }
        const context = { socket, timeout: previous?.timeout || 15_000, ready: false, types: previous?.types || [] };
        this.sockets.add(context);
        const watch = () => {
            clearTimeout(context.watchdog);
            context.watchdog = setTimeout(() => {
                // close() can remain pending on a broken network. Stop accepting
                // this socket's messages and allow the next alarm to reconnect.
                this.retire(context);
                socket.close();
            }, context.timeout + HEARTBEAT_GRACE_MS);
        };
        const fail = error => {
            if (!this.sockets.has(context) || this.stopped) return;
            context.failureReported = true;
            this.backoff(error);
            this.retire(context);
            socket.close();
        };
        watch();
        socket.onmessage = async ({ data }) => {
            if (this.stopped || !this.sockets.has(context)) return;
            try {
                const message = JSON.parse(data);
                const kind = message.metadata?.message_type;
                watch();
                if (kind === "session_welcome") {
                    if (context.ready) return;
                    const session = message.payload.session;
                    context.timeout = (session.keepalive_timeout_seconds || 10) * 1000;
                    watch();
                    if (!previous) {
                        context.types = [];
                        for (const [type, version, condition] of subscriptions(this.ownerId)) {
                            if (this.stopped || !this.sockets.has(context)) return;
                            const response = await this.subscribe(type, version, condition, session.id);
                            if (!response.data?.[0]?.id) throw new Error("Missing subscription response");
                            context.types.push(type);
                        }
                    }
                    if (this.stopped || !this.sockets.has(context)) return;
                    context.ready = true;
                    this.failures = 0;
                    this.beat(context);
                    this.report({ state: "connected" });
                    // Subscriptions transfer with the reconnect URL; do not subscribe twice.
                    if (previous) { this.retire(previous); previous.socket.close(); }
                } else if (kind === "session_reconnect") {
                    const reconnect = message.payload?.session?.reconnect_url;
                    if (!isReconnectUrl(reconnect)) { fail(); return; }
                    this.beat(context);
                    if (this.sockets.size === 1) this.connect(reconnect, context);
                } else if (kind === "revocation") {
                    this.interval = null;
                    fail({ status: 403 });
                } else {
                    this.beat(context);
                    if (kind === "notification") {
                        const event = analyticsEvent(message);
                        if (event) await this.onEvent(event);
                    }
                }
            } catch (error) { fail(error); }
        };
        socket.onerror = () => {}; // close handles retry scheduling.
        socket.onclose = () => this.retire(context);
    }
    stop() {
        this.stopped = true;
        this.interval = null;
        for (const context of this.sockets) { this.retire(context); context.socket.close(); }
    }
}
