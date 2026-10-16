import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";

const code = transformSync(readFileSync(new URL("./admin-api-health.ts", import.meta.url), "utf8"),
  { loader: "ts", format: "cjs" }).code;

function createProbe(fetcher: typeof fetch) {
  const timers = new Set<object>();
  let abort: (() => void) | undefined;
  const mod = { exports: {} as { checkAdminApiHealth(): Promise<boolean> } };
  new Function("require", "module", "exports", "fetch", "setTimeout", "clearTimeout", code)(
    (id: string) => {
      assert.equal(id, "@/lib/api-base");
      return { apiBase: () => "/api" };
    }, mod, mod.exports, fetcher,
    (fn: () => void, delay: number) => {
      assert.equal(delay, 5_000);
      abort = fn;
      const timer = {};
      timers.add(timer);
      return timer;
    },
    (timer: object) => timers.delete(timer),
  );
  return { run: mod.exports.checkAdminApiHealth, timers, expire: () => abort!() };
}

describe("admin API reachability", () => {
  it("uses lightweight API liveness rather than broadcast daemon readiness", async () => {
    const probe = createProbe(async (url, options) => {
      assert.equal(url, "/api/healthz");
      assert.equal(options?.credentials, "omit");
      assert.equal(options?.cache, "no-store");
      assert.ok(options?.signal);
      return new Response('{"status":"ok"}');
    });
    assert.equal(await probe.run(), true);
    assert.equal(probe.timers.size, 0);
  });

  it("reports non-2xx responses as unreachable and releases the timer", async () => {
    const probe = createProbe(async () => new Response("", { status: 503 }));
    assert.equal(await probe.run(), false);
    assert.equal(probe.timers.size, 0);
  });

  it("releases timers after network failures", async () => {
    const probe = createProbe(async () => { throw new TypeError("Network unavailable"); });
    assert.equal(await probe.run(), false);
    assert.equal(probe.timers.size, 0);
  });

  it("aborts a stalled request and permits a later recovery probe", async () => {
    let requests = 0;
    const probe = createProbe(async (_url, options) => {
      if (++requests > 1) return new Response("{}");
      return new Promise<Response>((_resolve, reject) => {
        options!.signal!.addEventListener("abort", () =>
          reject(new DOMException("Timed out", "AbortError")), { once: true });
      });
    });
    const pending = probe.run();
    probe.expire();
    assert.equal(await pending, false);
    assert.equal(probe.timers.size, 0);
    assert.equal(await probe.run(), true);
    assert.equal(probe.timers.size, 0);
  });
});
