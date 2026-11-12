import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("official Daily Devotion integration", async () => {
const core = await import("../services/dailyDevotionCore.js");
const { DailyDevotionRepository, normalizeDailyDevotion, devotionLink, devotionText, DEVOTION_PAGE } = core;
const payload = { devotion: {
  date: "2026-11-12", title: "Test fixture devotion", reflection: "<p>A fixture reflection &amp; prayer.</p>",
} };

function fixture(initial: string | null = null) {
  let stored = initial;
  let now = Date.parse("2026-11-12T08:00:00Z");
  let calls = 0;
  let fail = false;
  let writeFail = false;
  let response: unknown = payload;
  const repository = new DailyDevotionRepository({
    now: () => now, read: async () => stored,
    write: async value => { if (writeFail) throw new Error("Disk full"); stored = value; },
    fetch: async () => { calls++; if (fail) throw new Error("Offline"); return response; },
  });
  return { repository, calls: () => calls, stored: () => stored,
    advance: (ms: number) => { now += ms; }, setTime: (ms: number) => { now = ms; },
    fail: () => { fail = true; }, full: () => { writeFail = true; }, respond: (value: unknown) => { response = value; } };
}

  it("normalizes the verified official API envelope without invented dates/images/links", () => {
    const devotion = normalizeDailyDevotion(payload);
    assert.equal(devotion.title, "Test fixture devotion");
    assert.equal(devotion.excerpt, "A fixture reflection & prayer.");
    assert.equal(devotion.publishedAt, "2026-11-12");
    assert.equal(devotion.imageUrl, null);
    assert.equal(devotion.url, DEVOTION_PAGE);
  });
  it("uses actual metadata when available and rejects private-network images", () => {
    const devotion = normalizeDailyDevotion({ devotion: { ...payload.devotion,
      imageUrl: "/uploads/devotion.webp", url: "/devotion/a-published-message" } });
    assert.equal(devotion.imageUrl, "https://jctm.org.ng/uploads/devotion.webp");
    assert.equal(devotion.url, "https://jctm.org.ng/devotion/a-published-message");
    assert.equal(normalizeDailyDevotion({ devotion: { ...payload.devotion,
      imageUrl: "https://192.168.1.1/private" } }).imageUrl, null);
  });
  it("does not open unsafe external links or alternate ports", () => {
    for (const url of ["javascript:alert(1)", "//evil.test/devotion", "https://jctm.org.ng.evil.test/devotion",
      "https://jctm.org.ng:8443/devotion", "https://user:password@jctm.org.ng/devotion", "/not-a-devotion"]) {
      assert.equal(devotionLink(url), DEVOTION_PAGE);
    }
  });
  it("rejects missing titles, unpublished content and broken API envelopes", () => {
    for (const value of [null, {}, { devotion: null }, { devotion: { title: " " } },
      { devotion: { title: "Draft", status: "draft" } }]) assert.throws(() => normalizeDailyDevotion(value));
  });
  it("sanitizes bounded plain text and invalid date values", () => {
    assert.equal(devotionText('<script>evil()</script><p>Faith&nbsp;&#x26; Hope</p>', 100), "Faith & Hope");
    assert.equal(devotionText("x".repeat(1000), 200).length, 200);
    assert.equal(normalizeDailyDevotion({ devotion: { title: "Fixture", date: "2026-02-31" } }).publishedAt, null);
  });
  it("formats the publisher calendar day without shifting its date", () => {
    assert.match(core.formatDevotionDate("2026-11-12", "en-US")!, /November 12, 2026/);
    assert.equal(core.formatDevotionDate("invalid"), null);
    assert.equal(core.formatDevotionDate(null), null);
  });
  it("persists real fetched metadata and reuses a fresh copy without another request", async () => {
    const f = fixture();
    const first = await f.repository.load();
    const second = await f.repository.load();
    assert.equal(f.calls(), 1);
    assert.equal(first.devotion.title, second.devotion.title);
    assert.ok(f.stored()?.includes('"version":1'));
    assert.equal(second.stale, false);
  });
  it("coalesces simultaneous refreshes into one public request", async () => {
    const f = fixture();
    await Promise.all(Array.from({ length: 20 }, () => f.repository.load(true)));
    assert.equal(f.calls(), 1);
  });
  it("automatically replaces old data after the freshness interval", async () => {
    const f = fixture();
    await f.repository.load();
    f.advance(core.DEVOTION_REFRESH_MS + 1);
    f.respond({ devotion: { ...payload.devotion, title: "Newly published fixture" } });
    assert.equal((await f.repository.load()).devotion.title, "Newly published fixture");
    assert.equal(f.calls(), 2);
  });
  it("refreshes across Lagos midnight even if the interval has not expired", async () => {
    const f = fixture();
    f.setTime(Date.parse("2026-11-12T22:59:00Z"));
    await f.repository.load();
    f.advance(2 * 60_000);
    await f.repository.load();
    assert.equal(f.calls(), 2);
  });
  it("restores saved content after an app restart with no network", async () => {
    const f = fixture();
    await f.repository.load();
    const restarted = fixture(f.stored());
    restarted.advance(core.DEVOTION_REFRESH_MS + 1);
    restarted.fail();
    const restored = await restarted.repository.load();
    assert.equal(restored.devotion.title, payload.devotion.title);
    assert.equal(restored.stale, true);
    assert.ok(restored.error);
  });
  it("retains previous content on invalid new responses, without resetting its timestamp", async () => {
    const f = fixture();
    const first = await f.repository.load();
    f.advance(core.DEVOTION_REFRESH_MS + 1);
    f.respond({ error: "temporarily unavailable" });
    const next = await f.repository.load();
    assert.equal(next.fetchedAt, first.fetchedAt);
    assert.equal(next.stale, true);
    assert.equal(next.devotion.title, first.devotion.title);
  });
  it("does not crash on a corrupt cache or a full device", async () => {
    const f = fixture("{invalid json");
    f.full();
    assert.equal((await f.repository.load()).devotion.title, payload.devotion.title);
  });
  it("rejects a future-dated cache rather than suppressing updates indefinitely", async () => {
    const f = fixture(JSON.stringify({ version: 1, devotion: { title: "Bad cache" },
      fetchedAt: Date.parse("2030-01-01T00:00:00Z") }));
    assert.equal(await f.repository.cached(), null);
    assert.equal((await f.repository.load()).devotion.title, payload.devotion.title);
  });
  it("manual refresh bypasses the cache", async () => {
    const f = fixture();
    await f.repository.load();
    await f.repository.load(true);
    assert.equal(f.calls(), 2);
  });
  it("does not fetch when the lifecycle cancelled the request", async () => {
    const f = fixture();
    const controller = new AbortController(); controller.abort();
    await assert.rejects(f.repository.load(false, controller.signal), { name: "AbortError" });
    assert.equal(f.calls(), 0);
  });
  it("fails explicitly on the first offline launch without creating a fake devotion", async () => {
    const f = fixture(); f.fail();
    await assert.rejects(f.repository.load(), /Offline/);
    assert.equal(await f.repository.cached(), null);
  });
  it("preserves stale relay freshness instead of presenting cached source content as new", async () => {
    const f = fixture();
    const old = Date.parse("2026-11-11T12:00:00Z");
    f.respond({ ...payload, stale: true, fetchedAt: old });
    const result = await f.repository.load();
    assert.equal(result.fetchedAt, old);
    assert.equal(result.stale, true);
  });
});
