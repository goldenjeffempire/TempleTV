import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDaemonOrigin } from "../../src/config/daemon-origin.js";
import { createDaemonStartupGuard, withDaemonDeadline } from "../../src/infrastructure/daemon-startup-guard.js";
import { statScratchFilesystem } from "../../src/infrastructure/scratch-filesystem.js";
import Fastify from "fastify";
import { installDaemonRuntimeGate } from "../../src/modules/broadcast-v2/io/daemon-runtime-gate.js";

test("Render host:port and explicit HTTP(S) origins normalize identically", () => {
  assert.equal(parseDaemonOrigin(" daemon-62uf:9000/ "), "http://daemon-62uf:9000");
  assert.equal(parseDaemonOrigin("http://daemon-62uf:9000/"), "http://daemon-62uf:9000");
  assert.equal(parseDaemonOrigin("https://daemon.example"), "https://daemon.example");
  assert.equal(parseDaemonOrigin("http://127.0.0.1:9000"), "http://127.0.0.1:9000");
  assert.equal(parseDaemonOrigin("http://[::1]:9000/"), "http://[::1]:9000");
});

test("rejects unsupported protocols, credentials, invalid ports and URL suffixes", () => {
  for (const value of [
    "ftp://daemon:9000", "ws://daemon:9000", "file:///tmp/daemon",
    "http://user:password@daemon:9000", "http://daemon:9000/api",
    "http://daemon:9000?key=value", "http://daemon:9000/#secret",
    "http://daemon:99999", "", "http://",
  ]) assert.throws(() => parseDaemonOrigin(value));
});

test("a stalled operation has a bounded deadline", async () => {
  await assert.rejects(
    withDaemonDeadline(new Promise<never>(() => {}), "lock query", 20),
    /Daemon operation timed out: lock query/,
  );
});

test("successful and failed I/O preserve their results", async () => {
  assert.equal(await withDaemonDeadline(Promise.resolve(17), "query", 20), 17);
  const error = new Error("database disconnected");
  await assert.rejects(withDaemonDeadline(Promise.reject(error), "query", 20), error);
});

test("late query rejection after timeout does not become an unhandled rejection", async () => {
  const late = new Promise((_resolve, reject) => setTimeout(() => reject(new Error("late failure")), 40));
  await assert.rejects(withDaemonDeadline(late, "query", 10), /timed out/);
  await new Promise(resolve => setTimeout(resolve, 50));
});

test("startup deadman reports the actual blocked phase", async () => {
  const phases: string[] = [];
  const guard = createDaemonStartupGuard(phase => phases.push(phase), 20);
  guard.enter("leadership-lock-attempt-2");
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(phases, ["leadership-lock-attempt-2"]);
  guard.complete();
});

test("a ready startup cancels the deadman", async () => {
  let expired = false;
  const guard = createDaemonStartupGuard(() => { expired = true; }, 20);
  guard.enter("broadcast-engine-start");
  guard.complete();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(expired, false);
  assert.equal(guard.phase(), "ready");
});

test("scratch monitoring repairs a missing leaf and samples the real filesystem", async () => {
  const parent = await mkdtemp(join(tmpdir(), "temple-scratch-test-"));
  try {
    const scratch = join(parent, "scratch");
    const first = await statScratchFilesystem(scratch);
    assert.ok(first.blocks > 0);
    await access(scratch);
    assert.ok((await statScratchFilesystem(scratch)).blocks > 0);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("scratch monitoring does not fabricate a missing mount hierarchy", async () => {
  const parent = await mkdtemp(join(tmpdir(), "temple-scratch-test-"));
  try {
    const missingMount = join(parent, "missing-mount");
    await assert.rejects(statScratchFilesystem(join(missingMount, "scratch")), { code: "ENOENT" });
    await assert.rejects(access(missingMount), { code: "ENOENT" });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("unready daemon serves health but rejects REST, SSE and WS paths until ready", async () => {
  const app = Fastify();
  let ready = false;
  installDaemonRuntimeGate(app, () => ({ ready, phase: "leadership-lock-attempt-1" }));
  app.get("/healthz", async () => ({ status: "ok", runtimeReady: ready }));
  for (const path of ["/api/broadcast-v2/state", "/api/v1/broadcast-v2/events", "/api/broadcast-v2/ws"]) {
    app.get(path, async () => ({ state: "real-runtime" }));
  }
  try {
    assert.equal((await app.inject("/healthz")).statusCode, 200);
    for (const path of ["/api/broadcast-v2/state", "/api/v1/broadcast-v2/events", "/api/broadcast-v2/ws"]) {
      const response = await app.inject(path);
      assert.equal(response.statusCode, 503);
      assert.equal(response.headers["retry-after"], "5");
      assert.equal(response.json().code, "BROADCAST_DAEMON_NOT_READY");
      assert.equal(response.json().startupPhase, "leadership-lock-attempt-1");
    }
    ready = true;
    const restored = await app.inject("/api/broadcast-v2/state");
    assert.equal(restored.statusCode, 200);
    assert.equal(restored.json().state, "real-runtime");
  } finally {
    await app.close();
  }
});
