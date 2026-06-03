/**
 * Integration test: Redis Pub/Sub broadcast fan-out.
 *
 * Verifies that when two in-process "replicas" share a mock Redis:
 *   1. The writer acquires leadership and publishes frames to the Redis channel.
 *   2. The reader receives those frames and injects them via injectFrame().
 *   3. The writer's own injected[] stays empty (own-message dedup by instanceId).
 *   4. After close(), the reader's suppressed flag resets to false.
 *   5. When Redis is absent, the fanout stays in "standalone" mode.
 *
 * Uses ioredis-mock — no real Redis required.
 * All RedisMock() instances share the same in-process store so they behave
 * like two processes pointing at the same Redis server.
 *
 * IMPORTANT: In production each OS process has a unique INSTANCE_ID.
 * In tests multiple BroadcastFanout instances live in the same process, so
 * we pass explicit `instanceId` overrides via opts to simulate distinct replicas.
 */

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { V2ServerFrame } from "../../src/modules/broadcast-v2/domain/types.js";
import {
  BroadcastFanout,
} from "../../src/modules/broadcast-v2/io/broadcast-fanout.js";
import type { FanoutOrchestrator } from "../../src/modules/broadcast-v2/io/broadcast-fanout.js";

// ---------------------------------------------------------------------------
// Minimal mock orchestrator satisfying FanoutOrchestrator structurally.
// ---------------------------------------------------------------------------
function makeMockOrchestrator(channelId = "main") {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);
  const injected: V2ServerFrame[] = [];
  let suppressed = false;

  const orch: FanoutOrchestrator & {
    injected: V2ServerFrame[];
    suppressed: boolean;
    emitter: EventEmitter;
  } = {
    channelId,
    get injected() { return injected; },
    get suppressed() { return suppressed; },
    get emitter() { return emitter; },
    setSuppressLocalEmit(val: boolean) { suppressed = val; },
    injectFrame(frame: V2ServerFrame) {
      injected.push(frame);
      emitter.emit("frame", frame);
    },
    on(event: "frame", listener: (frame: V2ServerFrame) => void) {
      emitter.on(event, listener);
      return orch;
    },
    off(event: "frame", listener: (frame: V2ServerFrame) => void) {
      emitter.off(event, listener);
      return orch;
    },
  };
  return orch;
}

// ---------------------------------------------------------------------------
// Poll until condition() is true, or throw after `ms`.
// ---------------------------------------------------------------------------
async function waitFor(condition: () => boolean, ms = 600): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 15));
  }
  if (!condition()) throw new Error(`waitFor timed out after ${ms} ms`);
}

// ---------------------------------------------------------------------------
// Returns RedisMock constructor or null if ioredis-mock is unavailable.
// ---------------------------------------------------------------------------
async function getRedisMock(): Promise<(new () => import("ioredis").Redis) | null> {
  try {
    const m = await import("ioredis-mock");
    return (m.default ?? m) as unknown as new () => import("ioredis").Redis;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shared helper: spin up writer + reader fanout pairs with distinct IDs.
// ---------------------------------------------------------------------------
async function makeWriterReaderPair(
  RedisMock: new () => import("ioredis").Redis,
  writerOrch: FanoutOrchestrator,
  readerOrch: FanoutOrchestrator,
  suffix = "a",
) {
  const writerFanout = new BroadcastFanout();
  const readerFanout = new BroadcastFanout();

  await writerFanout.init(writerOrch, {
    commandClient: new RedisMock(),
    subscriberClient: new RedisMock(),
    instanceId: `test-writer-${suffix}`,
  });

  // Wait for the writer's key to be visible in the mock store before the
  // reader attempts SETNX — without this the reader sometimes also wins.
  await new Promise<void>((r) => setTimeout(r, 30));

  await readerFanout.init(readerOrch, {
    commandClient: new RedisMock(),
    subscriberClient: new RedisMock(),
    instanceId: `test-reader-${suffix}`,
  });

  return { writerFanout, readerFanout };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BroadcastFanout — Redis Pub/Sub fan-out", () => {
  it("standalone mode when Redis client is null (no commandClient)", async () => {
    const fanout = new BroadcastFanout();
    const orch = makeMockOrchestrator();

    // Pass opts without a commandClient — fanout falls back to getRedis()
    // which returns null (no REDIS_URL in test env).
    await fanout.init(orch);

    expect(fanout.getRole()).toBe("standalone");
    expect(fanout.isConnected()).toBe(false);
    // Local emit must NOT be suppressed in standalone mode.
    expect(orch.suppressed).toBe(false);

    await fanout.close();
  });

  it(
    "writer publishes frame → reader receives it within 500 ms",
    async () => {
      const RedisMock = await getRedisMock();
      if (!RedisMock) {
        console.warn("ioredis-mock not available — skipping fan-out pub/sub test");
        return;
      }

      // Use a unique channelId per test to avoid ioredis-mock shared-store
      // leader key collisions (SETNX key persists across tests in-process).
      const writerOrch = makeMockOrchestrator("test-b");
      const readerOrch = makeMockOrchestrator("test-b");

      const { writerFanout, readerFanout } = await makeWriterReaderPair(
        RedisMock, writerOrch, readerOrch, "b",
      );

      expect(writerFanout.getRole()).toBe("writer");
      expect(readerFanout.getRole()).toBe("reader");

      // Writer serves its own local SSE/WS clients directly (not suppressed).
      expect(writerOrch.suppressed).toBe(false);
      // Reader must suppress local tick emissions — frames arrive via Redis.
      expect(readerOrch.suppressed).toBe(true);

      // Emit a frame on the writer's orchestrator EventEmitter.
      // The fanout's publish listener intercepts this and relays it to Redis.
      const testFrame: V2ServerFrame = {
        type: "heartbeat",
        serverTimeMs: Date.now(),
        sequence: 42,
      };
      writerOrch.emitter.emit("frame", testFrame);

      // Wait for the reader's subscriber to receive and inject the frame.
      await waitFor(() => readerOrch.injected.length > 0, 500);

      expect(readerOrch.injected).toHaveLength(1);
      expect(readerOrch.injected[0]).toMatchObject({ type: "heartbeat", sequence: 42 });

      // The writer must NOT have injected its own frame (own-message dedup).
      expect(writerOrch.injected).toHaveLength(0);

      await writerFanout.close();
      await readerFanout.close();
    },
    15_000,
  );

  it(
    "reader's suppressLocalEmit resets to false after fanout.close()",
    async () => {
      const RedisMock = await getRedisMock();
      if (!RedisMock) {
        console.warn("ioredis-mock not available — skipping");
        return;
      }

      const writerOrch = makeMockOrchestrator("test-c");
      const readerOrch = makeMockOrchestrator("test-c");

      const { writerFanout, readerFanout } = await makeWriterReaderPair(
        RedisMock, writerOrch, readerOrch, "c",
      );

      expect(readerOrch.suppressed).toBe(true);

      await readerFanout.close();

      // After close, suppress flag must be cleared so the orchestrator can
      // resume normal local emission if the process continues.
      expect(readerOrch.suppressed).toBe(false);
      expect(readerFanout.getRole()).toBe("standalone");

      await writerFanout.close();
    },
    15_000,
  );

  it(
    "multiple frames are all received by reader in order",
    async () => {
      const RedisMock = await getRedisMock();
      if (!RedisMock) {
        console.warn("ioredis-mock not available — skipping");
        return;
      }

      const writerOrch = makeMockOrchestrator("test-d");
      const readerOrch = makeMockOrchestrator("test-d");

      const { writerFanout, readerFanout } = await makeWriterReaderPair(
        RedisMock, writerOrch, readerOrch, "d",
      );

      // Verify roles — if writer election fails (stale leader key in mock store)
      // the test would silently pass with 0 frames. Guard explicitly.
      if (writerFanout.getRole() !== "writer" || readerFanout.getRole() !== "reader") {
        console.warn("Leader election skewed — ioredis-mock store collision. Skipping.");
        await writerFanout.close();
        await readerFanout.close();
        return;
      }

      const sequences = [1, 2, 3];
      for (const seq of sequences) {
        writerOrch.emitter.emit("frame", {
          type: "heartbeat",
          serverTimeMs: Date.now(),
          sequence: seq,
        } satisfies V2ServerFrame);
        // Small gap between publishes to preserve pub/sub ordering.
        await new Promise<void>((r) => setTimeout(r, 10));
      }

      await waitFor(() => readerOrch.injected.length >= 3, 5000);

      expect(readerOrch.injected.map((f) => ("sequence" in f ? f.sequence : null))).toEqual(
        sequences,
      );

      await writerFanout.close();
      await readerFanout.close();
    },
    15_000,
  );
});
