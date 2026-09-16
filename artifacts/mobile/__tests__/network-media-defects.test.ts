/// <reference types="node" />
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
let fetchWithRetry: typeof import("../lib/fetchWithRetry.js").fetchWithRetry;
let deriveConnectivityStatus:
  typeof import("../lib/connectivityStatus.js").deriveConnectivityStatus;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchWithRetry per-attempt cancellation", async () => {
  fetchWithRetry = (await import("../lib/fetchWithRetry.js")).fetchWithRetry;
  it("retries after an attempt timeout with a fresh signal", async () => {
    let calls = 0;
    globalThis.fetch = (async (_input, init) => {
      calls++;
      if (calls === 1) {
        await new Promise<void>((resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "TimeoutError")));
        });
      }
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const response = await fetchWithRetry("https://example.test", undefined, {
      maxRetries: 1,
      baseDelayMs: 0,
      timeoutMs: 5,
    });
    assert.equal(response.status, 200);
    assert.equal(calls, 2);
  });

  it("preserves caller cancellation instead of retrying", async () => {
    const controller = new AbortController();
    let calls = 0;
    globalThis.fetch = (async (_input, init) => {
      calls++;
      await new Promise<void>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")));
      });
      return new Response("unexpected", { status: 200 });
    }) as typeof fetch;

    const request = fetchWithRetry("https://example.test", { signal: controller.signal }, {
      maxRetries: 2,
      baseDelayMs: 0,
      timeoutMs: 100,
    });
    controller.abort();
    await assert.rejects(request);
    assert.equal(calls, 1);
  });
});

describe("native connectivity classification", async () => {
  deriveConnectivityStatus = (
    await import("../lib/connectivityStatus.js")
  ).deriveConnectivityStatus;

  it("stays online when the Temple TV API works but third-party probes are blocked", () => {
    assert.deepEqual(deriveConnectivityStatus(true, [false, false]), {
      online: true,
      apiUnreachable: false,
    });
  });

  it("identifies an API outage when another internet probe succeeds", () => {
    assert.deepEqual(deriveConnectivityStatus(false, [true, false]), {
      online: false,
      apiUnreachable: true,
    });
  });

  it("reports a full outage only when every probe fails", () => {
    assert.deepEqual(deriveConnectivityStatus(false, [false, false]), {
      online: false,
      apiUnreachable: false,
    });
  });
});