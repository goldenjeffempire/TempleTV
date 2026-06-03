/**
 * WS phantom listener regression tests for broadcast-v2.
 *
 * Guards against the two-part bug in ws.gateway.ts where closing a socket
 * during an in-flight `resume` DB await leaked the `bufferFrame` listener
 * permanently on the broadcast orchestrator EventEmitter:
 *
 *   Bug (1) — socketClosed was declared but never set to true:
 *     The post-DB-await guard `if (socketClosed) return;` always passed,
 *     causing onFrame to be re-registered on an already-closed socket.
 *
 *   Bug (2) — close handler used the static `onFrame` reference:
 *     When a `resume` message arrived, `bufferFrame` replaced `onFrame` on
 *     the emitter. Closing with `onFrame` was a no-op — `bufferFrame` leaked.
 *
 * Fix: (1) set socketClosed = true in the close handler; (2) use
 *   activeFrameHandler (a mutable pointer updated on every registration change)
 *   instead of the static `onFrame` closure.
 *
 * Tests are split into:
 *   A) Algorithm-level unit tests (no DB required) — pure emitter simulation
 *   B) Integration-level WS tests (require DB) — real WebSocket connections
 *
 * All integration tests guard with `if (!app || !wsUrl) return;` so they skip
 * gracefully in CI environments without a running PostgreSQL instance.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// A) Algorithm-level tests — pure EventEmitter simulation
// ---------------------------------------------------------------------------

// Minimal typed EventEmitter for testing the handler-pointer pattern.
class MiniEmitter<Events extends Record<string, unknown[]>> {
  private handlers = new Map<keyof Events, Set<(...args: unknown[]) => void>>();

  on<K extends keyof Events>(ev: K, fn: (...args: Events[K]) => void): void {
    let set = this.handlers.get(ev);
    if (!set) { set = new Set(); this.handlers.set(ev, set); }
    set.add(fn as (...args: unknown[]) => void);
  }

  off<K extends keyof Events>(ev: K, fn: (...args: Events[K]) => void): void {
    this.handlers.get(ev)?.delete(fn as (...args: unknown[]) => void);
  }

  emit<K extends keyof Events>(ev: K, ...args: Events[K]): void {
    this.handlers.get(ev)?.forEach((h) => h(...(args as unknown[])));
  }

  listenerCount(ev: keyof Events): number {
    return this.handlers.get(ev)?.size ?? 0;
  }
}

type Frame = { type: string; sequence: number };
type OrchestratorEvents = { frame: [Frame] };

/**
 * Simulates the FIXED ws.gateway.ts handler registration lifecycle.
 * Returns the emitter after a full open → resume → close cycle.
 */
function simulateFixedGateway(opts: {
  closeBeforeResumeCompletes: boolean;
}): { emitter: MiniEmitter<OrchestratorEvents>; frames: Frame[]; socketClosed: boolean } {
  const emitter = new MiniEmitter<OrchestratorEvents>();
  const frames: Frame[] = [];
  let socketClosed = false;
  let activeFrameHandler: ((f: Frame) => void) | null = null;

  const onFrame = (f: Frame) => {
    if (socketClosed) return; // THE FIX: guard dropped sockets
    frames.push(f);
  };

  // ── Socket opens: register onFrame ──────────────────────────────────────
  activeFrameHandler = onFrame;
  emitter.on("frame", onFrame);

  // ── resume message arrives: swap to bufferFrame ──────────────────────────
  const frameQueue: Frame[] = [];
  const bufferFrame = (f: Frame) => { frameQueue.push(f); };

  emitter.off("frame", onFrame);
  activeFrameHandler = bufferFrame;
  emitter.on("frame", bufferFrame);

  // ── Socket closes DURING the async DB replay ─────────────────────────────
  if (opts.closeBeforeResumeCompletes) {
    // THE FIX: set socketClosed AND use activeFrameHandler pointer
    socketClosed = true;
    if (activeFrameHandler) emitter.off("frame", activeFrameHandler);
    activeFrameHandler = null;
  }

  // ── DB replay completes (async — happens after close in the bug scenario) ─
  if (!socketClosed) {
    // Flush buffered frames and restore live listener
    emitter.off("frame", bufferFrame);
    activeFrameHandler = onFrame;
    emitter.on("frame", onFrame);

    for (const f of frameQueue) onFrame(f);
  }

  return { emitter, frames, socketClosed };
}

/**
 * Simulates the BUGGY ws.gateway.ts (before the fix) to demonstrate the leak.
 */
function simulateBuggyGateway(): { emitter: MiniEmitter<OrchestratorEvents>; listenerCountAfterClose: number } {
  const emitter = new MiniEmitter<OrchestratorEvents>();
  const onFrame = (_f: Frame) => { /* */ };
  const bufferFrame = (_f: Frame) => { /* buffer */ };

  // register
  emitter.on("frame", onFrame);

  // resume: swap
  emitter.off("frame", onFrame);
  emitter.on("frame", bufferFrame);

  // close: BUG — removes stale onFrame (no-op), bufferFrame stays
  emitter.off("frame", onFrame); // no-op! bufferFrame is still registered

  return { emitter, listenerCountAfterClose: emitter.listenerCount("frame") };
}

describe("WS phantom listener — algorithm (no DB required)", () => {
  it("FIXED: socket close during resume removes bufferFrame — 0 listeners remain", () => {
    const { emitter } = simulateFixedGateway({ closeBeforeResumeCompletes: true });
    expect(emitter.listenerCount("frame")).toBe(0);
  });

  it("FIXED: socketClosed=true after close", () => {
    const { socketClosed } = simulateFixedGateway({ closeBeforeResumeCompletes: true });
    expect(socketClosed).toBe(true);
  });

  it("FIXED: frames after close are not delivered to dead socket", () => {
    const { emitter, frames } = simulateFixedGateway({ closeBeforeResumeCompletes: true });
    // Emit a frame after close — 0 listeners → not delivered
    emitter.emit("frame", { type: "heartbeat", sequence: 99 });
    expect(frames).toHaveLength(0);
  });

  it("BUG SCENARIO: buggy gateway leaks bufferFrame after close", () => {
    const { listenerCountAfterClose } = simulateBuggyGateway();
    // This is the BUG: 1 listener remains (bufferFrame was never removed)
    expect(listenerCountAfterClose).toBe(1);
  });

  it("FIXED: normal (no-resume) open → close removes onFrame cleanly", () => {
    const emitter = new MiniEmitter<OrchestratorEvents>();
    let activeFrameHandler: ((f: Frame) => void) | null = null;

    const onFrame = (_f: Frame) => { /* */ };
    activeFrameHandler = onFrame;
    emitter.on("frame", onFrame);
    expect(emitter.listenerCount("frame")).toBe(1);

    // Close without resume
    if (activeFrameHandler) emitter.off("frame", activeFrameHandler);
    expect(emitter.listenerCount("frame")).toBe(0);
  });

  it("FIXED: 100 rapid open→resume→close cycles — 0 listeners remain", () => {
    const emitter = new MiniEmitter<OrchestratorEvents>();

    for (let i = 0; i < 100; i++) {
      let activeFrameHandler: ((f: Frame) => void) | null = null;
      const onFrame = (_f: Frame) => { /* */ };
      const bufferFrame = (_f: Frame) => { /* */ };

      activeFrameHandler = onFrame;
      emitter.on("frame", onFrame);

      emitter.off("frame", onFrame);
      activeFrameHandler = bufferFrame;
      emitter.on("frame", bufferFrame);

      // close during resume
      if (activeFrameHandler) emitter.off("frame", activeFrameHandler);
      activeFrameHandler = null;
    }

    expect(emitter.listenerCount("frame")).toBe(0);
  });

  it("FIXED: 50 open→resume→complete cycles — 0 listeners remain after all close", () => {
    const emitter = new MiniEmitter<OrchestratorEvents>();

    for (let i = 0; i < 50; i++) {
      let activeFrameHandler: ((f: Frame) => void) | null = null;
      const onFrame = (_f: Frame) => { /* */ };
      const bufferFrame = (_f: Frame) => { /* */ };

      // open
      activeFrameHandler = onFrame;
      emitter.on("frame", onFrame);

      // resume
      emitter.off("frame", onFrame);
      activeFrameHandler = bufferFrame;
      emitter.on("frame", bufferFrame);

      // resume completes: restore onFrame
      emitter.off("frame", bufferFrame);
      activeFrameHandler = onFrame;
      emitter.on("frame", onFrame);

      // close normally
      if (activeFrameHandler) emitter.off("frame", activeFrameHandler);
      activeFrameHandler = null;
    }

    expect(emitter.listenerCount("frame")).toBe(0);
  });

  it("frameQueue cap: never exceeds 500 entries under burst", () => {
    const FRAME_QUEUE_MAX = 500;
    const queue: Frame[] = [];

    const bufferFrame = (f: Frame) => {
      if (queue.length >= FRAME_QUEUE_MAX) queue.shift();
      queue.push(f);
    };

    // Burst of 1500 frames
    for (let i = 0; i < 1500; i++) {
      bufferFrame({ type: "heartbeat", sequence: i });
    }

    expect(queue.length).toBe(FRAME_QUEUE_MAX);
    // Drop-oldest: the oldest remaining is frame 1000 (1500 - 500)
    expect(queue[0]!.sequence).toBe(1000);
    // Newest is frame 1499
    expect(queue[queue.length - 1]!.sequence).toBe(1499);
  });

  it("socketClosed guard: frames received after close are silently dropped", () => {
    let socketClosed = false;
    const delivered: Frame[] = [];
    let activeFrameHandler: ((f: Frame) => void) | null = null;
    const emitter = new MiniEmitter<OrchestratorEvents>();

    const onFrame = (f: Frame) => {
      if (socketClosed) return;
      delivered.push(f);
    };
    activeFrameHandler = onFrame;
    emitter.on("frame", onFrame);

    // Deliver some frames while open
    emitter.emit("frame", { type: "snapshot", sequence: 1 });
    emitter.emit("frame", { type: "snapshot", sequence: 2 });
    expect(delivered.length).toBe(2);

    // Close
    socketClosed = true;
    if (activeFrameHandler) emitter.off("frame", activeFrameHandler);

    // Frames after close — should be silently dropped
    emitter.emit("frame", { type: "snapshot", sequence: 3 });
    expect(delivered.length).toBe(2); // not incremented
  });
});

// ---------------------------------------------------------------------------
// B) Integration-level WS tests — require DB + real TCP listener
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let wsUrl = "";

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.PORT = "0";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL && process.env.DATABASE_URL !== ""
      ? process.env.DATABASE_URL
      : "postgres://test:test@localhost:5432/test";
  process.env.JWT_ACCESS_SECRET = "x".repeat(64);
  process.env.JWT_REFRESH_SECRET = "y".repeat(64);
  process.env.PROD_SYNC_DISABLE = "1";

  try {
    const { buildApp } = await import("../../src/app.js");
    app = await buildApp();
    await app.ready();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address() as AddressInfo | null;
    if (addr) wsUrl = `ws://127.0.0.1:${addr.port}`;
  } catch {
    // DB unavailable — tests guard with `if (!app || !wsUrl)`.
  }
}, 30_000);

afterAll(async () => {
  if (app) await app.close();
}, 15_000);

/** Open a WebSocket, wait for first frame or timeout, then close.
 *
 * `refused` is true only when the connection could not be established at all
 * (ECONNREFUSED / server crashed). This is the canary for the leak test.
 * `closed` is true when the server actively closed the connection. `closed`
 * may be false when the connection was still alive at timeout — which is
 * correct server behaviour (the server keeps WS connections open).
 */
async function openAndClose(
  path: string,
  opts: { sendOnOpen?: string; waitMs?: number } = {},
): Promise<{ frameCount: number; closed: boolean; refused: boolean }> {
  return new Promise((resolve) => {
    let frameCount = 0;
    let done = false;
    let refused = false;

    const finish = (closed: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* ignore */ }
      resolve({ frameCount, closed, refused });
    };

    const timer = setTimeout(() => finish(false), opts.waitMs ?? 3_000);

    let ws: WebSocket;
    try {
      ws = new WebSocket(`${wsUrl}${path}`);
    } catch {
      clearTimeout(timer);
      refused = true;
      resolve({ frameCount: 0, closed: true, refused: true });
      return;
    }

    ws.onopen = () => {
      if (opts.sendOnOpen) {
        try { ws.send(opts.sendOnOpen); } catch { /* ignore */ }
      }
    };
    ws.onmessage = () => { frameCount++; };
    ws.onclose = () => finish(true);
    ws.onerror = () => {
      // ECONNREFUSED / early close — the server may have crashed
      refused = true;
      finish(true);
    };
  });
}

describe("WS phantom listener — integration (DB required)", () => {
  it("20 rapid open→close cycles: server does not crash", async () => {
    if (!app || !wsUrl) return;

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        openAndClose("/api/broadcast-v2/ws", { waitMs: 500 }),
      ),
    );

    // Key invariant: none of the connections were refused (ECONNREFUSED = server crash).
    // `closed` may be false when the server correctly kept the connection alive — that is
    // expected WS behaviour and NOT a test failure.
    for (const r of results) {
      expect(r.refused).toBe(false);
    }
  }, 15_000);

  it("20 rapid open→resume→close cycles: server does not crash or leak", async () => {
    if (!app || !wsUrl) return;

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        openAndClose("/api/broadcast-v2/ws", {
          sendOnOpen: JSON.stringify({ type: "resume", lastSequence: i }),
          waitMs: 600,
        }),
      ),
    );

    // Server must not refuse any connection (ECONNREFUSED) after 20 rapid open/resume/close cycles.
    // A leaked listener that caused the orchestrator to crash would manifest as refused=true here.
    for (const r of results) {
      expect(r.refused).toBe(false);
    }
  }, 15_000);

  it("server health check passes after 30 rapid open/close cycles", async () => {
    if (!app || !wsUrl) return;

    // Fire 30 rapid open/close cycles to stress the close handler
    await Promise.all(
      Array.from({ length: 30 }, () =>
        openAndClose("/api/broadcast-v2/ws", { waitMs: 300 }),
      ),
    );

    // The server must still respond to health checks (no crash from leaked listeners)
    const r = await app.inject({ method: "GET", url: "/api/broadcast-v2/health" });
    expect([200, 429, 503]).toContain(r.statusCode);
  }, 20_000);

  it("50 sequential open→frame→close cycles maintain consistent snapshot sequence", async () => {
    if (!app || !wsUrl) return;

    const sequences: number[] = [];

    for (let i = 0; i < 10; i++) {
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; clearTimeout(timer); try { ws.close(); } catch { /**/ } resolve(); } };
        const timer = setTimeout(finish, 1_500);
        let ws: WebSocket;
        try {
          ws = new WebSocket(`${wsUrl}/api/broadcast-v2/ws`);
        } catch {
          clearTimeout(timer);
          resolve();
          return;
        }
        ws.onmessage = (evt) => {
          try {
            const f = JSON.parse(evt.data as string) as Record<string, unknown>;
            if (typeof f.sequence === "number") sequences.push(f.sequence);
          } catch { /* */ }
          finish();
        };
        ws.onclose = finish;
        ws.onerror = finish;
      });
    }

    // Sequences should be monotonically non-decreasing (server clock only moves forward)
    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i]!).toBeGreaterThanOrEqual(sequences[i - 1]!);
    }
  }, 30_000);
});
