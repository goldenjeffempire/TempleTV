import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { transformSync } from "esbuild";

// Execute the real route module with infrastructure isolated from the live DB.
const require = createRequire(import.meta.url);
const engine = Object.assign(new EventEmitter(), {
  channelId: "temple-tv-live",
  count: 3,
  getViewerCount() { return this.count; },
  snapshot() { return { current: null, next: null, upcoming: [], failoverHlsUrl: null }; },
  reload: async () => {},
});
const overrideBus = Object.assign(new EventEmitter(), {
  active: null as null | { id: string; title: string; youtubeVideoId: string; startedAt: string; endsAt: null },
});
const adminEventBus = new EventEmitter();
const signalBus = new EventEmitter();
const code = transformSync(readFileSync(
  new URL("../../src/modules/playback/playback.routes.ts", import.meta.url), "utf8",
), { loader: "ts", format: "cjs" }).code;
const mod = { exports: {} as { playbackRoutes: (app: unknown) => Promise<void> } };
new Function("require", "module", "exports", code)((id: string) => {
  if (id.includes("queue.engine")) return { broadcastEngine: engine };
  if (id.includes("override-bus")) return { overrideBus };
  if (id.includes("signal-bus")) return { signalBus };
  if (id.includes("admin-event-bus")) return { adminEventBus };
  if (id.includes("logger")) return { logger: { warn() {} } };
  if (id.includes("config/env")) return { env: { BROADCAST_PRELOAD_LEAD_MS: 120_000 } };
  return require(id);
}, mod, mod.exports);

describe("playback viewer count server contract", async () => {
  const routes = new Map<string, { options: any; handler: (...args: any[]) => any }>();
  const app = {
    withTypeProvider() { return this; },
    get(path: string, options: unknown, handler: (...args: any[]) => any) {
      routes.set(path, { options, handler });
    },
  };
  await mod.exports.playbackRoutes(app);

  it("includes current counts in HTTP snapshots, including overrides", async () => {
    const route = routes.get("/state")!;
    for (const active of [null, {
      id: "live", title: "Live", youtubeVideoId: "video",
      startedAt: new Date().toISOString(), endsAt: null,
    }]) {
      overrideBus.active = active;
      engine.count = 8;
      const state = await route.handler({}, { header() {} });
      const parsed = route.options.schema.response[200].parse(state);
      assert.equal(parsed.viewerCount, 8);
    }
    overrideBus.active = null;
  });

  it("pushes changes and zero over WS and removes the listener on close", () => {
    const socket = Object.assign(new EventEmitter(), {
      sent: [] as Array<any>,
      send(text: string) { this.sent.push(JSON.parse(text)); },
      ping() {},
    });
    engine.count = 3;
    const previousListeners = engine.listenerCount("event");
    routes.get("/ws")!.handler(socket, {});
    try {
      assert.equal(socket.sent[0].state.viewerCount, 3);
      engine.emit("event", { type: "viewer-count", data: { count: 9 } });
      engine.emit("event", { type: "viewer-count", data: { count: 0 } });
      assert.deepEqual(socket.sent.slice(-2), [
        { type: "viewer-count", count: 9 },
        { type: "viewer-count", count: 0 },
      ]);
    } finally {
      socket.emit("close");
    }
    assert.equal(engine.listenerCount("event"), previousListeners);
  });
});
