const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { transformSync } = require("esbuild");

const root = path.join(__dirname, "../src");
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function compile(file, dependencies = {}, globals = {}) {
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(root, file), "utf8");
  const { code } = transformSync(source, { loader: "tsx", format: "cjs", jsx: "automatic" });
  vm.runInNewContext(code, {
    module, exports: module.exports, DOMException, AbortController, URL,
    require(name) {
      if (!(name in dependencies)) throw Error(`Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    ...globals,
  }, { filename: file });
  return module.exports;
}
const budgets = compile("lib/upload-request-budget.ts");

test("ten simultaneous files cannot start more than three buffered chunk transfers", async () => {
  let active = 0;
  let peak = 0;
  let completed = 0;
  const files = Array.from({ length: 10 }, () => new AbortController());
  await Promise.all(Array.from({ length: 40 }, (_, index) =>
    budgets.chunkUploadBudget.run(files[Math.floor(index / 4)].signal, async () => {
      peak = Math.max(peak, ++active);
      await flush();
      active--;
      completed++;
    })));
  assert.equal(peak, 3);
  assert.equal(active, 0);
  assert.equal(completed, 40);
});

test("cancelled queued work never reads a file, and remaining work preserves FIFO order", async () => {
  const budget = new budgets.UploadRequestBudget(1);
  const first = deferred();
  const order = [];
  const a = new AbortController();
  const b = new AbortController();
  const c = new AbortController();
  const one = budget.run(a.signal, () => first.promise);
  const two = budget.run(b.signal, async () => { order.push("cancelled"); });
  const rejected = assert.rejects(two, { name: "AbortError" });
  const three = budget.run(c.signal, async () => { order.push("third"); });
  b.abort();
  first.resolve();
  await Promise.all([one, rejected, three]);
  assert.deepEqual(order, ["third"]);
});

test("abort after a slot is granted and thrown work both release their slots", async () => {
  const budget = new budgets.UploadRequestBudget(1);
  const aborted = new AbortController();
  let started = false;
  const pending = budget.run(aborted.signal, async () => { started = true; });
  aborted.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(started, false);
  const signal = new AbortController().signal;
  await assert.rejects(budget.run(signal, async () => { throw Error("network failure"); }), /network failure/);
  assert.equal(await budget.run(signal, async () => "recovered"), "recovered");
});

test("whole-file hashing is serialized independently of chunk transfers", async () => {
  let active = 0;
  let peak = 0;
  const signal = new AbortController().signal;
  await Promise.all(Array.from({ length: 10 }, () =>
    budgets.fileHashBudget.run(signal, async () => {
      peak = Math.max(peak, ++active);
      await flush();
      active--;
    })));
  assert.equal(peak, 1);
});

test("real upload integration acquires before allocation and removes XHR abort listeners", () => {
  const source = fs.readFileSync(path.join(root, "lib/upload-queue.ts"), "utf8");
  assert.match(source, /const uploadChunk = [\s\S]*?chunkUploadBudget\.run\(signal, async \(\) => \{[\s\S]*?file\.slice/);
  assert.match(source, /xhr\.addEventListener\("loadend", \(\) => \{\s*signal\.removeEventListener\("abort", abortHandler\)/);
  assert.match(source, /fileHashBudget\.run\(signal, async \(\) => \{\s*const fileBuffer = await file\.arrayBuffer/);
});

function harness(options = {}) {
  const timers = new Map();
  const intervals = new Map();
  const effects = [];
  const listeners = new Map();
  const states = [];
  let serial = 0;
  let fetches = 0;
  let healthCalls = 0;
  const eventTarget = {
    addEventListener: (event, handler) => listeners.set(event, handler),
    removeEventListener: (event, handler) => {
      if (listeners.get(event) === handler) listeners.delete(event);
    },
  };
  class FakeEventSource {
    static instances = [];
    handlers = new Map();
    closed = false;
    constructor(url) { this.url = url; FakeEventSource.instances.push(this); }
    addEventListener(event, handler) { this.handlers.set(event, handler); }
    close() { this.closed = true; }
    fire(event, data = "{}") { this.handlers.get(event)?.({ data }); }
  }
  const react = {
    createContext: () => ({ Provider: "Provider" }),
    useCallback: fn => fn,
    useMemo: fn => fn(),
    useRef: value => ({ current: value }),
    useState: value => [value, next => { if (typeof next === "string") states.push(next); }],
    useEffect: fn => effects.push(fn),
  };
  const queryClient = { invalidateQueries() {} };
  const module = compile("contexts/sse-context.tsx", {
    react,
    "react/jsx-runtime": { jsx: (_type, props) => props },
    "@tanstack/react-query": { useQueryClient: () => queryClient },
    "@/lib/api": {
      tokenStore: { getAccess: () => "fixture", getRefresh: () => null, clear() {} },
      forceRefreshToken: async () => {},
    },
    "@/lib/api-base": { apiBase: () => "/api" },
    "@/lib/admin-api-health": {
      checkAdminApiHealth: async () => {
        healthCalls++;
        return options.health ? options.health() : true;
      },
    },
  }, {
    EventSource: FakeEventSource,
    document: { ...eventTarget, visibilityState: "visible" },
    window: { ...eventTarget, location: { origin: "http://localhost:5000" } },
    setTimeout: (fn, ms) => { const id = ++serial; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => { const id = ++serial; intervals.set(id, { fn, ms }); return id; },
    clearInterval: id => intervals.delete(id),
    fetch: async () => {
      const call = ++fetches;
      return options.fetch ? options.fetch(call) : {
        ok: true, status: 201, json: async () => ({ token: "fixture-subtoken" }),
      };
    },
  });
  const provider = module.SSEProvider({ children: null });
  const cleanup = effects[0]();
  return {
    provider, cleanup, effects, states, timers, intervals, listeners,
    sockets: FakeEventSource.instances,
    get fetches() { return fetches; },
    get healthCalls() { return healthCalls; },
    interval(ms) { return [...intervals.values()].find(timer => timer.ms === ms).fn(); },
    timeout(ms) {
      const [id, timer] = [...timers].find(([, timer]) => timer.ms === ms);
      timers.delete(id);
      timer.fn();
    },
  };
}

test("health polling and Retry cannot cancel a slow EventSource handshake", async () => {
  const h = harness();
  await flush();
  assert.equal(h.sockets.length, 1);
  await h.interval(30_000);
  h.provider.value.forceReconnect();
  h.listeners.get("online")();
  await flush();
  assert.equal(h.healthCalls, 0);
  assert.equal(h.fetches, 1);
  assert.equal(h.sockets[0].closed, false);
  h.sockets[0].fire("open");
  assert.equal(h.states.at(-1), "connected");
  h.cleanup();
});

test("handshake deadline releases ownership and schedules one retry", async () => {
  const h = harness();
  await flush();
  h.timeout(45_000);
  assert.equal(h.sockets[0].closed, true);
  const retries = [...h.timers].filter(([, timer]) => timer.ms < 1_000);
  assert.equal(retries.length, 1);
  const [id, timer] = retries[0];
  h.timers.delete(id);
  timer.fn();
  await flush();
  assert.equal(h.sockets.length, 2);
  h.sockets[1].fire("open");
  assert.equal(h.states.at(-1), "connected");
  h.cleanup();
});

test("a pending replacement socket does not falsely retain the Connected label", async () => {
  const h = harness();
  await flush();
  h.sockets[0].fire("open");
  h.sockets[0].onerror();
  const [id, retry] = [...h.timers].find(([, timer]) => timer.ms < 1_000);
  h.timers.delete(id);
  retry.fn();
  await flush();
  assert.equal(h.sockets.length, 2);
  h.timeout(2_000);
  assert.equal(h.states.at(-1), "reconnecting");
  h.sockets[1].fire("open");
  assert.equal(h.states.at(-1), "connected");
  h.cleanup();
});

test("late health failure cannot overwrite a newer reconnect handshake", async () => {
  const health = deferred();
  const h = harness({ health: () => health.promise });
  await flush();
  h.sockets[0].fire("open");
  h.sockets[0].onerror();
  h.timeout(2_000);
  const probe = h.interval(30_000);
  h.provider.value.forceReconnect();
  await flush();
  health.resolve(false);
  await probe;
  assert.equal(h.states.at(-1), "reconnecting");
  assert.equal(h.sockets.length, 2);
  assert.equal(h.sockets[1].closed, false);
  h.cleanup();
});

test("effect remount discards the old pending token without unlocking the new handshake", async () => {
  const oldToken = deferred();
  const h = harness({
    fetch: call => call === 1 ? oldToken.promise : {
      ok: true, status: 201, json: async () => ({ token: "new-fixture" }),
    },
  });
  h.cleanup();
  const cleanup = h.effects[0]();
  await flush();
  oldToken.resolve({ ok: true, status: 201, json: async () => ({ token: "old-fixture" }) });
  await flush();
  h.provider.value.forceReconnect();
  await h.interval(30_000);
  assert.equal(h.fetches, 2);
  assert.equal(h.sockets.length, 1);
  assert.equal(h.sockets[0].closed, false);
  assert.match(h.sockets[0].url, /new-fixture/);
  cleanup();
});

test("offline invalidates pending token work, and online starts a fresh handshake", async () => {
  const token = deferred();
  const h = harness({
    fetch: call => call === 1 ? token.promise : {
      ok: true, status: 201, json: async () => ({ token: "online-fixture" }),
    },
  });
  h.listeners.get("offline")();
  assert.equal(h.states.at(-1), "offline");
  token.resolve({ ok: true, status: 201, json: async () => ({ token: "stale-fixture" }) });
  await flush();
  assert.equal(h.sockets.length, 0);
  h.listeners.get("online")();
  await flush();
  assert.equal(h.sockets.length, 1);
  h.sockets[0].fire("open");
  assert.equal(h.states.at(-1), "connected");
  h.cleanup();
});
