import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";

describe("admin live viewer query contract", () => {
  const events = new Map<string, (data: unknown) => void>();
  const invalidations: unknown[] = [];
  let query: { queryKey: unknown; queryFn: () => Promise<unknown>; refetchInterval: number };
  let url = "";
  const expected = { streams: [], totalCurrent: 7, totalPeak: 9 };
  const code = transformSync(readFileSync(
    new URL("./useViewerTracking.ts", import.meta.url), "utf8",
  ), { loader: "ts", format: "cjs" }).code;
  const mod = { exports: {} as { useViewerTracking(streamId?: string): { data: typeof expected } } };
  new Function("require", "module", "exports", code)((id: string) => {
    if (id === "@tanstack/react-query") return {
      useQueryClient: () => ({ invalidateQueries: (value: unknown) => invalidations.push(value) }),
      useQuery: (options: typeof query) => {
        query = options;
        return { data: expected, isLoading: false, error: null };
      },
    };
    if (id.includes("sse-context")) return {
      useSSEEvent: (event: string, callback: (data: unknown) => void) => events.set(event, callback),
    };
    if (id.includes("useSseGatedInterval")) return {
      useSseGatedInterval: (connected: number, disconnected: number) => {
        assert.equal(connected, 15_000);
        assert.equal(disconnected, 15_000);
        return connected;
      },
    };
    if (id === "@/lib/api") return { api: { get: async (path: string) => {
      url = `/api${path}`;
      return expected;
    } } };
    throw new Error(`Unexpected dependency ${id}`);
  }, mod, mod.exports);

  it("uses one API prefix and the authoritative aggregate count", async () => {
    const result = mod.exports.useViewerTracking();
    assert.equal(result.data.totalCurrent, 7);
    await query.queryFn();
    assert.equal(url, "/api/viewer-tracking/stats");
  });

  it("encodes stream IDs without introducing a second API prefix", async () => {
    mod.exports.useViewerTracking("stream/name");
    await query.queryFn();
    assert.equal(url, "/api/viewer-tracking/stats/stream%2Fname");
  });

  it("refreshes on both immediate engine and tracking-service events", () => {
    mod.exports.useViewerTracking();
    invalidations.length = 0;
    events.get("viewer-count")!({ count: 2 });
    events.get("viewer-count-updated")!({ streamId: "temple-tv-live", current: 2 });
    assert.deepEqual(invalidations, [
      { queryKey: ["viewer-tracking"] }, { queryKey: ["viewer-tracking"] },
    ]);
    assert.equal(query.refetchInterval, 15_000);
  });
});
