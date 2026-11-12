/* Browser-only, fixed-upstream relay. Native Android talks to JCTM directly. */
const SOURCE = "https://jctm.org.ng/api/devotion/daily";
const PATHS = new Set(["/mobile/temple-content/devotion", "/temple-content/devotion"]);

function isDevotionRequest(req) {
  return PATHS.has((req.url || "").split("?")[0]);
}

function createDevotionRelay({ fetcher = fetch, now = Date.now } = {}) {
  let cached = null;
  let pending = null;
  async function latest() {
    const checkedAt = now();
    const stationDay = timestamp => new Date(timestamp + 3_600_000).toISOString().slice(0, 10);
    if (cached && checkedAt >= cached.fetchedAt && checkedAt - cached.fetchedAt < 5_000 &&
        stationDay(checkedAt) === stationDay(cached.fetchedAt)) return { ...cached, stale: false };
    if (pending) return pending;
    pending = (async () => {
      try {
        const response = await fetcher(SOURCE, {
          cache: "no-store",
          headers: { Accept: "application/json", "Cache-Control": "no-cache" },
          signal: AbortSignal.timeout(10_000), redirect: "error",
        });
        if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
          throw new Error("Official devotion service unavailable");
        }
        if (Number(response.headers.get("content-length") || 0) > 128_000) throw new Error("Response too large");
        let text = "";
        if (response.body?.getReader) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let bytes = 0;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              bytes += value.length;
              if (bytes > 128_000) { await reader.cancel(); throw new Error("Response too large"); }
              text += decoder.decode(value, { stream: true });
            }
            text += decoder.decode();
          } finally { reader.releaseLock(); }
        } else {
          text = await response.text();
          if (text.length > 128_000) throw new Error("Response too large");
        }
        const data = JSON.parse(text);
        if (!data?.devotion || typeof data.devotion.title !== "string") throw new Error("Invalid devotion response");
        cached = { devotion: data.devotion, fetchedAt: now() };
        return { ...cached, stale: false };
      } catch (error) {
        if (cached) return { ...cached, stale: true };
        throw error;
      } finally { pending = null; }
    })();
    return pending;
  }
  return async function serveDevotion(req, res) {
    if (!["GET", "HEAD"].includes(req.method)) {
      res.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "application/json" });
      res.end('{"error":"Method not allowed"}'); return;
    }
    try {
      const result = await latest();
      if (res.destroyed) return;
      const body = JSON.stringify(result);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store, max-age=0",
        "Content-Length": Buffer.byteLength(body),
        "X-Content-Type-Options": "nosniff",
      });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      if (res.destroyed) return;
      res.writeHead(502, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : '{"error":"The official devotion service is temporarily unavailable."}');
    }
  };
}
module.exports = { isDevotionRequest, createDevotionRelay };
