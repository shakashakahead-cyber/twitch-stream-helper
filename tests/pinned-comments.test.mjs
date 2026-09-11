import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SourceTextModule, createContext } from "node:vm";
import { webcrypto } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const en = JSON.parse(await readFile(resolve(root, "_locales/en/messages.json"), "utf8"));
const allScopes = ["channel:manage:broadcast", "user:write:chat", "moderator:manage:chat_messages"];
const live = { id: "stream-1", started_at: "2026-09-07T01:00:00Z", game_id: "123" };
const recordKey = `42:${live.id}:${live.started_at}`;
const settings = {
  message: "Welcome!", autoPost: true, pin: true, durationSeconds: 0,
  categoryMessages: {}, ownerId: "42",
};

function fixture(overrides = {}) {
  return {
    storage: { accessToken: "test-token", pinnedCommentSettings: structuredClone(settings) },
    stream: null, scopes: [...allScopes], userId: "42", now: Date.now(),
    calls: [], alarms: new Map(), ...overrides,
  };
}

async function worker(state = fixture()) {
  const listeners = {};
  const event = name => ({ addListener: callback => {
    const previous = listeners[name];
    listeners[name] = previous ? (...args) => { previous(...args); return callback(...args); } : callback;
  } });
  const chrome = {
    runtime: { onMessage: event("message"), onInstalled: event("installed"), onStartup: event("startup") },
    storage: { local: {
      get(keys, callback) {
        const result = Object.fromEntries(keys.filter(key => key in state.storage).map(key => [key, state.storage[key]]));
        queueMicrotask(() => callback(structuredClone(result)));
      },
      set(value, callback) {
        queueMicrotask(() => {
          if (state.failDeliveryWrite && value.pinnedCommentDeliveries) {
            chrome.runtime.lastError = { message: "Storage unavailable" };
            callback();
            delete chrome.runtime.lastError;
          } else {
            Object.assign(state.storage, structuredClone(value));
            callback();
          }
        });
      },
      remove(keys, callback) {
        keys.forEach(key => delete state.storage[key]);
        queueMicrotask(callback);
      },
    } },
    alarms: {
      onAlarm: event("alarm"),
      async get(name) { return state.alarms.get(name); },
      async create(name, value) { state.alarms.set(name, value); },
      async clear(name) { return state.alarms.delete(name); },
    },
    identity: {
      getRedirectURL: () => "https://test-extension.chromiumapp.org/",
      launchWebAuthFlow({ url }, callback) {
        if (state.authRedirect !== undefined) {
          queueMicrotask(() => callback(state.authRedirect));
          return;
        }
        state.authUrl = new URL(url);
        state.scopes = state.grantedScopes || state.authUrl.searchParams.get("scope").split(" ");
        const hash = new URLSearchParams({ state: state.authUrl.searchParams.get("state"), access_token: "test-new-token", expires_in: "3600" });
        queueMicrotask(() => callback(`https://test-extension.chromiumapp.org/#${hash}`));
      },
    },
    i18n: { getMessage(key, replacements = []) {
      let message = en[key]?.message || key;
      for (const [name, placeholder] of Object.entries(en[key]?.placeholders || {})) {
        message = message.replaceAll(`$${name}$`, String(replacements[Number(placeholder.content.slice(1)) - 1] || ""));
      }
      return message;
    } },
  };
  class TestDate extends Date { static now() { return state.now; } }
  const context = createContext({
    chrome, URL, URLSearchParams, Date: TestDate, crypto: webcrypto,
    console: { log() {}, warn() {}, error() {} },
    fetch: async (url, options = {}) => {
      const parsed = new URL(url);
      const request = { path: parsed.pathname, query: parsed.searchParams, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null };
      state.calls.push(request);
      if (state.respond) {
        const response = await state.respond(request);
        if (response) return response;
      }
      if (request.path === "/oauth2/validate") {
        return Response.json({ client_id: state.clientId, user_id: state.userId, scopes: state.scopes });
      }
      if (request.path === "/helix/streams") return Response.json({ data: state.stream ? [state.stream] : [] });
      if (request.path === "/helix/chat/messages") return Response.json({ data: [{ is_sent: true, message_id: "message-1" }] });
      if (request.path === "/helix/chat/pins") return new Response(null, { status: 204 });
      if (request.path === "/helix/users") return Response.json({ data: [{ id: state.userId, login: "example" }] });
      if (request.path === "/helix/channels") return Response.json({ data: [{ title: "Stream", game_id: "", tags: [] }] });
      throw new Error(`Unexpected endpoint: ${request.path}`);
    },
  });
  const names = ["background.js", ...(await readdir(resolve(root, "src"), { recursive: true })).filter(name => name.endsWith(".js")).map(name => `src/${name}`)];
  const modules = new Map();
  for (const name of names) {
    let code = await readFile(resolve(root, name), "utf8");
    // Observe completion of the real worker's event queue without exporting test APIs in production.
    if (name === "background.js") code += "\nexport { commentQueue as testQueue };";
    modules.set(resolve(root, name), new SourceTextModule(code, { context, identifier: resolve(root, name) }));
  }
  const entry = modules.get(resolve(root, "background.js"));
  await entry.link((specifier, parent) => modules.get(resolve(dirname(parent.identifier), specifier)));
  await entry.evaluate();
  state.clientId = modules.get(resolve(root, "src/config.js")).namespace.CLIENT_ID;
  await entry.namespace.testQueue;
  return {
    state,
    auth: modules.get(resolve(root, "src/auth.js")).namespace,
    async tick() {
      listeners.alarm({ name: "pinned-comment-stream-check" });
      await entry.namespace.testQueue;
    },
    async startup() {
      listeners.startup();
      await entry.namespace.testQueue;
    },
    async message(action, extra = {}) {
      let responses = 0;
      const response = await new Promise(resolveResponse => {
        assert.equal(listeners.message({ action, ...extra }, {}, value => {
          responses++;
          resolveResponse(structuredClone(value));
        }), true);
      });
      await new Promise(resolveTurn => setImmediate(resolveTurn));
      assert.equal(responses, 1, "Every message must respond exactly once");
      return response;
    },
  };
}

const posts = state => state.calls.filter(call => call.path === "/helix/chat/messages");
const pins = state => state.calls.filter(call => call.path === "/helix/chat/pins");
const delivery = state => state.storage.pinnedCommentDeliveries?.[recordKey];

test("Analytics authorization is opt-in and preserves all existing scopes", async () => {
  const state = fixture();
  const w = await worker(state);
  assert.equal((await w.auth.authenticate({ analytics: true })).success, true);
  assert.deepEqual([...state.scopes].sort(), [...allScopes, "moderator:read:followers", "user:read:chat"].sort());
  assert.equal(state.storage.analyticsSettings?.enabled, undefined, "auth alone must not silently enable collection");
});

test("denied Analytics scopes and disabled refresh respond once without enabling", async () => {
  const state = fixture({ grantedScopes: [...allScopes] });
  const w = await worker(state);
  const result = await w.message("analyticsEnable");
  assert.equal(result.success, false); assert.equal(result.requiresReauth, true);
  assert.equal(state.storage.analyticsSettings?.enabled, undefined);
  assert.equal((await w.message("analyticsRefresh")).success, false);
  assert.equal((await w.message("analyticsDisable")).success, true);
});

test("validation uses actual expiry, is cached hourly and invalidation clears the token", async () => {
  const state = fixture(); const w = await worker(state);
  let validations = 0;
  state.respond = request => {
    if (request.path === "/oauth2/validate") {
      validations++;
      return validations < 3 ? Response.json({ client_id: state.clientId, user_id: state.userId, scopes: allScopes, expires_in: 7200 }) : new Response(null, { status: 401 });
    }
  };
  await w.auth.getTokenAuthorization(); await w.auth.getTokenAuthorization();
  assert.equal(validations, 1); assert.equal(state.storage.accessTokenExpiresAt, state.now + 7200000);
  state.now += 3600001; await w.auth.getTokenAuthorization(); assert.equal(validations, 2);
  state.now += 3600001; await assert.rejects(w.auth.getTokenAuthorization());
  assert.equal(validations, 3); assert.equal(state.storage.accessToken, undefined);
});

test("offline → live posts and pins once; restart, concurrent checks, and manual click do not duplicate", async () => {
  const state = fixture();
  let w = await worker(state);
  assert.equal(state.alarms.size, 1);
  await w.tick();
  assert.equal(posts(state).length, 0);
  state.stream = live;
  await Promise.all([w.tick(), w.tick(), w.message("sendPinnedComment")]);
  assert.equal(posts(state).length, 1);
  assert.deepEqual(posts(state)[0].body, { broadcaster_id: "42", sender_id: "42", message: "Welcome!" });
  assert.equal(pins(state)[0].method, "PUT");
  assert.equal(pins(state)[0].body, null);
  assert.equal(pins(state)[0].query.has("duration_seconds"), false);
  assert.equal(pins(state)[0].query.get("message_id"), "message-1");
  assert.equal(delivery(state).state, "pinned");
  state.alarms.clear();
  w = await worker(state);
  await w.startup();
  await w.tick();
  assert.equal(state.alarms.size, 1);
  assert.equal(posts(state).length, 1);
  assert.equal(pins(state).length, 1);
  state.stream = { ...live, id: "stream-2", started_at: "2026-09-08T01:00:00Z" };
  await w.tick();
  assert.equal(posts(state).length, 2);
});

test("category overrides use the live Twitch category and fixed durations are query parameters", async () => {
  for (const duration of [600, 1800]) {
    const state = fixture({ stream: live });
    state.storage.pinnedCommentSettings.durationSeconds = duration;
    state.storage.pinnedCommentSettings.categoryMessages = { "123": "Category comment" };
    state.storage.streamState = { categoryId: "999" };
    const w = await worker(state);
    await w.tick();
    assert.equal(posts(state)[0].body.message, "Category comment");
    assert.equal(pins(state)[0].query.get("duration_seconds"), String(duration));
    state.stream = { ...live, game_id: "456" };
    await w.tick();
    assert.equal(posts(state).length, 1);
  }
});

test("ordinary comments need only chat write scope and perform no pin", async () => {
  const state = fixture({ stream: live, scopes: allScopes.slice(0, 2) });
  state.storage.pinnedCommentSettings.pin = false;
  const w = await worker(state);
  await w.tick();
  assert.equal(delivery(state).state, "sent");
  assert.equal(pins(state).length, 0);
});

test("disabled automation, logout, missing permissions, and another account cannot post automatically", async () => {
  const disabled = fixture({ stream: live });
  disabled.storage.pinnedCommentSettings.autoPost = false;
  let w = await worker(disabled);
  await w.tick();
  assert.equal(disabled.alarms.size, 0);
  assert.equal(posts(disabled).length, 0);
  for (const changes of [{ scopes: [allScopes[0]] }, { userId: "99" }]) {
    const state = fixture({ stream: live, ...changes });
    w = await worker(state);
    await w.tick();
    assert.equal(posts(state).length, 0);
    assert.equal(state.storage.pinnedCommentStatus.state, "error");
  }
  const state = fixture({ stream: live });
  w = await worker(state);
  assert.equal((await w.message("logout")).success, true);
  await w.tick();
  assert.equal(posts(state).length, 0);
  assert.equal(state.alarms.size, 0);
  assert.equal(state.storage.pinnedCommentSettings.autoPost, false);
  assert.equal((await w.message("sendPinnedComment")).success, false);
});

test("a pin failure retries only the original message, including after restart", async () => {
  const state = fixture({ stream: live });
  state.respond = request => request.path === "/helix/chat/pins" ? new Response("Forbidden", { status: 403 }) : null;
  let w = await worker(state);
  await w.tick();
  assert.equal(delivery(state).state, "pinFailed");
  await w.tick();
  assert.equal(pins(state).length, 1);
  state.respond = null;
  w = await worker(state);
  await w.message("sendPinnedComment");
  assert.equal(posts(state).length, 1);
  assert.equal(pins(state).length, 2);
  assert.equal(delivery(state).state, "pinned");
});

test("429 writes are not automatically resent and a manual retry honors the reset time", async () => {
  const state = fixture({ stream: live });
  const retryAt = Math.ceil(state.now / 1000) * 1000 + 120000;
  state.respond = request => request.path === "/helix/chat/messages"
    ? new Response("Rate limited", { status: 429, headers: { "Ratelimit-Reset": String(retryAt / 1000) } }) : null;
  const w = await worker(state);
  await w.tick();
  assert.equal(delivery(state).state, "sendFailed");
  await w.tick();
  await w.message("sendPinnedComment");
  assert.equal(posts(state).length, 1);
  state.now = retryAt + 1;
  await w.tick();
  assert.equal(posts(state).length, 1);
  state.respond = null;
  await w.message("sendPinnedComment");
  assert.equal(posts(state).length, 2);
});

test("dropped messages never pin, and network ambiguity never resends", async () => {
  for (const dropped of [true, false]) {
    const state = fixture({ stream: live });
    state.respond = request => {
      if (request.path !== "/helix/chat/messages") return null;
      if (!dropped) throw new Error("Disconnected after sending");
      return Response.json({ data: [{ is_sent: false, drop_reason: { message: "Rejected by moderation" } }] });
    };
    let w = await worker(state);
    await w.tick();
    assert.equal(delivery(state).state, dropped ? "sendFailed" : "unknown");
    assert.equal(pins(state).length, 0);
    w = await worker(state);
    await w.tick();
    if (!dropped) await w.message("sendPinnedComment");
    assert.equal(posts(state).length, 1);
  }
});

test("a rate-limited pin waits before manual retry and never reposts the comment", async () => {
  const state = fixture({ stream: live });
  state.respond = request => request.path === "/helix/chat/pins" ? new Response("Rate limited", { status: 429 }) : null;
  const w = await worker(state);
  await w.tick();
  await w.message("sendPinnedComment");
  assert.equal(pins(state).length, 1);
  state.now += 61000;
  await w.tick();
  assert.equal(pins(state).length, 1);
  state.respond = null;
  await w.message("sendPinnedComment");
  assert.equal(posts(state).length, 1);
  assert.equal(pins(state).length, 2);
  assert.equal(delivery(state).state, "pinned");
});

test("expired tokens stop the alarm without attempting to post", async () => {
  const state = fixture({ stream: live });
  state.respond = request => request.path === "/oauth2/validate" ? new Response("Unauthorized", { status: 401 }) : null;
  const w = await worker(state);
  await w.tick();
  assert.equal(posts(state).length, 0);
  assert.equal(state.alarms.size, 0);
  assert.equal(state.storage.accessToken, undefined);
  assert.equal((await w.message("getPinnedCommentSettings")).canSend, false);
});

test("durable intent prevents duplicates after interrupted sends and storage failure prevents a POST", async () => {
  const state = fixture({ stream: live });
  state.storage.pinnedCommentDeliveries = { [recordKey]: { state: "sending", attemptedAt: state.now } };
  let w = await worker(state);
  await w.tick();
  await w.message("sendPinnedComment");
  assert.equal(delivery(state).state, "unknown");
  assert.equal(posts(state).length, 0);
  const failedStorage = fixture({ stream: live, failDeliveryWrite: true });
  w = await worker(failedStorage);
  await w.tick();
  assert.equal(posts(failedStorage).length, 0);
});

test("interrupted pin stages retain the message ID and treat already-pinned as success", async () => {
  for (const stage of ["sent", "pinning"]) {
    const state = fixture({ stream: live });
    state.storage.pinnedCommentDeliveries = { [recordKey]: {
      state: stage, attemptedAt: state.now, pin: true, durationSeconds: 600, messageId: "original-message",
    } };
    state.respond = request => request.path === "/helix/chat/pins" ? new Response("Already pinned", { status: 409 }) : null;
    const w = await worker(state);
    await w.tick();
    await w.message("sendPinnedComment");
    assert.equal(posts(state).length, 0);
    assert.equal(pins(state)[0].query.get("message_id"), "original-message");
    assert.equal(delivery(state).state, "pinned");
  }
});

test("settings validate length, normalize category fallback, and require scopes only when enabled", async () => {
  const state = fixture({ scopes: [allScopes[0]] });
  const w = await worker(state);
  assert.equal((await w.message("savePinnedCommentSettings", { settings: { ...settings, message: "x".repeat(501) } })).success, false);
  assert.equal((await w.message("savePinnedCommentSettings", { settings })).success, false);
  const result = await w.message("savePinnedCommentSettings", { settings: {
    ...settings, autoPost: false, durationSeconds: -1, categoryMessages: { "123": "   " },
  } });
  assert.equal(result.success, true);
  assert.deepEqual(result.settings.categoryMessages, {});
  assert.equal(result.settings.durationSeconds, 0);
  assert.equal(state.alarms.size, 0);
});

test("normal login obtains stream management, chat posting, and pinning in one authorization", async () => {
  for (const pin of [false, true]) {
    const state = fixture();
    state.storage.pinnedCommentSettings.autoPost = false;
    state.storage.pinnedCommentSettings.pin = pin;
    delete state.storage.accessToken;
    const w = await worker(state);
    const response = await w.message("authenticate");
    assert.equal(response.success, true);
    assert.equal(state.authUrl.searchParams.get("force_verify"), "true");
    assert.deepEqual(state.scopes, allScopes);
    assert.equal(state.storage.accessTokenExpiresAt, state.now + 3600000);
    assert.equal((await w.message("getStreamInfo")).success, true);
    assert.equal(state.storage.pinnedCommentSettings.autoPost, false);
    assert.equal(posts(state).length, 0);
  }
});

test("legacy tokens return to normal login without losing settings or delivery records", async () => {
  const state = fixture({ scopes: [allScopes[0]] });
  state.storage.pinnedCommentDeliveries = { [recordKey]: { state: "pinned", messageId: "original-message" } };
  const saved = structuredClone(state.storage);
  const w = await worker(state);
  const before = await w.message("getStreamInfo");
  assert.equal(before.success, false);
  assert.equal(before.requiresReauth, true);
  assert.equal((await w.message("getPinnedCommentSettings")).requiresReauth, true);
  assert.deepEqual(state.storage.pinnedCommentSettings, saved.pinnedCommentSettings);
  assert.deepEqual(state.storage.pinnedCommentDeliveries, saved.pinnedCommentDeliveries);
  assert.equal(state.storage.accessToken, saved.accessToken);
  assert.equal((await w.message("authenticate")).success, true);
  assert.deepEqual(state.scopes, allScopes);
  assert.equal((await w.message("getStreamInfo")).success, true);
  assert.deepEqual(state.storage.pinnedCommentSettings, saved.pinnedCommentSettings);
  assert.deepEqual(state.storage.pinnedCommentDeliveries, saved.pinnedCommentDeliveries);
  assert.equal(posts(state).length, 0);
});

test("a login with incomplete granted scopes never reports authentication success", async () => {
  const state = fixture({ grantedScopes: [allScopes[0]] });
  const w = await worker(state);
  const result = await w.message("authenticate");
  assert.equal(result.success, false);
  assert.equal(result.requiresReauth, true);
  assert.equal((await w.message("getStreamInfo")).requiresReauth, true);
});

test("cancelled or malformed OAuth responses finish with one failure response", async () => {
  for (const authRedirect of [null, "invalid-url", "https://test-extension.chromiumapp.org/#state=wrong&access_token=test-denied-token"]) {
    const state = fixture({ authRedirect });
    const w = await worker(state);
    assert.equal((await w.message("authenticate")).success, false);
    assert.equal(state.storage.accessToken, "test-token");
    assert.equal(posts(state).length, 0);
  }
});

test("locales and popup message keys are complete with matching placeholder definitions", async () => {
  const ja = JSON.parse(await readFile(resolve(root, "_locales/ja/messages.json"), "utf8"));
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ja).sort());
  for (const key of Object.keys(en)) {
    const signature = locale => Object.entries(locale[key].placeholders || {})
      .map(([name, value]) => [name.toLowerCase(), value.content]).sort();
    assert.deepEqual(signature(en), signature(ja), key);
  }
  const html = await readFile(resolve(root, "popup.html"), "utf8");
  for (const [, key] of html.matchAll(/__MSG_(\w+)__/g)) assert.ok(en[key], key);
});
