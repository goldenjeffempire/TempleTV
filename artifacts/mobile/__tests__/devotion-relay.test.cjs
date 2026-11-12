const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { createDevotionRelay, isDevotionRequest } = require("../server/devotion-relay");
function reply() {
  return { status: 0, body: "", destroyed: false, headers: {},
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body = "") { this.body = body; } };
}
describe("fixed public devotion relay", () => {
  it("matches only the dedicated paths", () => {
    assert.ok(isDevotionRequest({ url: "/mobile/temple-content/devotion" }));
    assert.equal(isDevotionRequest({ url: "/api/admin" }), false);
    assert.equal(isDevotionRequest({ url: "/temple-content/devotion/other" }), false);
  });
  it("does not forward credentials or accept a client-supplied URL", async () => {
    let called;
    const relay = createDevotionRelay({ fetcher: async (...args) => {
      called = args;
      return new Response(JSON.stringify({ devotion: { title: "Fixture" } }), {
        headers: { "Content-Type": "application/json" } });
    } });
    const res = reply();
    await relay({ method: "GET", url: "/temple-content/devotion?url=https://evil.test",
      headers: { authorization: "NOT_A_REAL_TOKEN", cookie: "fake=test" } }, res);
    assert.equal(called[0], "https://jctm.org.ng/api/devotion/daily");
    assert.deepEqual(called[1].headers, { Accept: "application/json", "Cache-Control": "no-cache" });
    assert.equal(called[1].cache, "no-store");
    assert.equal(res.status, 200);
    assert.equal(res.headers["Cache-Control"], "no-store, max-age=0");
  });
  it("caches and coalesces requests without hammering the website", async () => {
    let calls = 0;
    const relay = createDevotionRelay({ fetcher: async () => {
      calls++;
      return new Response('{"devotion":{"title":"Fixture"}}', { headers: { "Content-Type": "application/json" } });
    } });
    await Promise.all(Array.from({ length: 20 }, () => relay({ method: "GET" }, reply())));
    assert.equal(calls, 1);
  });
  it("serves a stale copy when the publisher has an interruption", async () => {
    let now = 1_000_000, calls = 0;
    const relay = createDevotionRelay({ now: () => now, fetcher: async () => {
      if (++calls > 1) throw new Error("offline");
      return new Response('{"devotion":{"title":"Fixture"}}', { headers: { "Content-Type": "application/json" } });
    } });
    await relay({ method: "GET" }, reply());
    now += 300_001;
    const res = reply();
    await relay({ method: "GET" }, res);
    assert.equal(JSON.parse(res.body).stale, true);
    assert.equal(JSON.parse(res.body).fetchedAt, 1_000_000);
  });
  it("shows a new publication without the previous five-minute delay", async () => {
    let now = 1_000_000, title = "Earlier fixture", calls = 0;
    const relay = createDevotionRelay({ now: () => now, fetcher: async () => {
      calls++;
      return new Response(JSON.stringify({ devotion: { title } }), { headers: { "Content-Type": "application/json" } });
    } });
    await relay({ method: "GET" }, reply());
    title = "Latest official fixture"; now += 6_000;
    const res = reply(); await relay({ method: "GET" }, res);
    assert.equal(JSON.parse(res.body).devotion.title, title);
    assert.equal(calls, 2);
  });
  it("revalidates at Lagos midnight even during the short deduplication window", async () => {
    let now = Date.parse("2026-11-12T22:59:59Z"), calls = 0;
    const relay = createDevotionRelay({ now: () => now, fetcher: async () => {
      calls++;
      return new Response('{"devotion":{"title":"Fixture"}}', { headers: { "Content-Type": "application/json" } });
    } });
    await relay({ method: "GET" }, reply());
    now += 2_000; await relay({ method: "GET" }, reply());
    assert.equal(calls, 2);
  });
  it("rejects mutations without contacting the publisher", async () => {
    const relay = createDevotionRelay({ fetcher: async () => { throw new Error("Must not fetch"); } });
    const res = reply();
    await relay({ method: "POST" }, res);
    assert.equal(res.status, 405);
  });
  it("bounds response bytes and returns an explicit gateway error", async () => {
    const relay = createDevotionRelay({ fetcher: async () =>
      new Response("x".repeat(128_001), { headers: { "Content-Type": "application/json" } }) });
    const res = reply();
    await relay({ method: "GET" }, res);
    assert.equal(res.status, 502);
    assert.ok(JSON.parse(res.body).error);
  });
});
