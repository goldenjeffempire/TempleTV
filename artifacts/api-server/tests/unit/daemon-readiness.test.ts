import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { createDaemonReadinessProbe } from "../../src/modules/health/daemon-readiness.js";

const healthy = {
  ok: true, mode: "queue", hasCurrent: true, itemCount: 54,
  sequence: 57646, uptimeMs: 104108479, stuck: false, sequenceStale: false,
  boot: { started: true }, runtime: { role: "broadcast-daemon" },
};

function responseProbe(body: unknown, status = 200) {
  return createDaemonReadinessProbe(
    async () => new Response(JSON.stringify(body), { status }),
  );
}

test("proxy readiness uses actual daemon metrics, not a stopped local engine", async () => {
  const result = await responseProbe(healthy)("http://daemon:9000/");
  assert.deepEqual(result, {
    status: "ok", hasCurrent: true,
    engine: { ok: true, mode: "queue", sequence: 57646, uptimeMs: 104108479, itemCount: 54 },
  });
});

test("starting, stuck, and unhealthy daemons are not reported ready", async () => {
  for (const [patch, expected] of [
    [{ boot: { started: false } }, "down"],
    [{ ok: false }, "down"],
    [{ stuck: true }, "stuck"],
    [{ sequenceStale: true }, "stuck"],
  ] as const) {
    const result = await responseProbe({ ...healthy, ...patch })("http://daemon:9000");
    assert.equal(result?.status, expected);
    assert.equal(result?.engine.ok, false);
  }
});

test("rejects unreachable, malformed, wrong-runtime, and incomplete daemon responses", async () => {
  const cases = [
    responseProbe(healthy, 503),
    responseProbe({}),
    responseProbe({ ...healthy, runtime: { role: "api" } }),
    responseProbe({ ...healthy, sequence: "57646" }),
    responseProbe({ ...healthy, uptimeMs: -1 }),
    createDaemonReadinessProbe(async () => new Response("")),
    createDaemonReadinessProbe(async () => { throw new Error("ECONNREFUSED"); }),
  ];
  for (const probe of cases) assert.equal(await probe("http://daemon:9000"), null);
});

test("concurrent probes share one request and target the correct endpoint", async () => {
  let calls = 0;
  const probe = createDaemonReadinessProbe(async (url) => {
    calls++;
    assert.equal(url, "http://daemon:9000/api/v1/broadcast-v2/health");
    return new Response(JSON.stringify(healthy));
  });
  await Promise.all(Array.from({ length: 25 }, () => probe("http://daemon:9000/")));
  assert.equal(calls, 1);
});

test("expired failure cache allows recovery without an API restart", async () => {
  let calls = 0;
  const probe = createDaemonReadinessProbe(async () => {
    calls++;
    return new Response(JSON.stringify(healthy), { status: calls === 1 ? 503 : 200 });
  }, 2_000, 5);
  assert.equal(await probe("http://daemon:9000"), null);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal((await probe("http://daemon:9000"))?.status, "ok");
});

test("bounds real HTTP timeout and recovers after the daemon responds again", async () => {
  let respond = false;
  const server = createServer((_req, res) => {
    if (respond) res.end(JSON.stringify(healthy));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const probe = createDaemonReadinessProbe(fetch, 100, 0);
  try {
    const url = `http://127.0.0.1:${address.port}`;
    assert.equal(await probe(url), null);
    respond = true;
    assert.equal((await probe(url))?.status, "ok");
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
