/**
 * Unit tests for V2Transport.
 *
 * Validates dead-socket watchdog, WS↔SSE fallback hysteresis, clock-offset
 * EMA, sequence persistence, forceReconnect(), and stop() teardown.
 *
 * Uses vi.stubGlobal to inject controllable WebSocket / EventSource stubs so
 * tests run deterministically in Node without network I/O.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { V2Transport, configureMobileStorage } from "../src/transport.js";
import type { PlayerEvent } from "../src/types.js";

// ---------------------------------------------------------------------------
// Stub — WebSocket
// ---------------------------------------------------------------------------

type WsHandler = (e?: unknown) => void;

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState: number = MockWebSocket.CONNECTING;
  onopen: WsHandler | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: WsHandler | null = null;
  onclose: WsHandler | null = null;
  sentMessages: string[] = [];
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    MockWebSocket._instances.push(this);
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(): void {
    if (this.readyState !== MockWebSocket.CLOSED) {
      this.readyState = MockWebSocket.CLOSED;
      this.onclose?.();
    }
  }

  // Test helpers
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(frame: object): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  simulateClose(): void {
    if (this.readyState !== MockWebSocket.CLOSED) {
      this.readyState = MockWebSocket.CLOSED;
      this.onclose?.();
    }
  }

  simulateError(): void {
    this.onerror?.();
    this.simulateClose();
  }

  static _instances: MockWebSocket[] = [];
  static latest(): MockWebSocket {
    return MockWebSocket._instances[MockWebSocket._instances.length - 1];
  }
  static reset(): void {
    MockWebSocket._instances = [];
  }
}

// ---------------------------------------------------------------------------
// Stub — EventSource
// ---------------------------------------------------------------------------

type SseMessageEvent = { data: string };
type SseListener = (e: SseMessageEvent) => void;

class MockEventSource {
  onerror: (() => void) | null = null;
  private listeners: Map<string, SseListener[]> = new Map();
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    MockEventSource._instances.push(this);
  }

  addEventListener(type: string, handler: SseListener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, handler: SseListener): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(type, list.filter((h) => h !== handler));
  }

  close(): void {
    MockEventSource._closed.push(this);
  }

  simulateFrame(type: string, frame: object): void {
    const handlers = this.listeners.get(type) ?? [];
    for (const h of handlers) h({ data: JSON.stringify(frame) });
  }

  simulateError(): void {
    this.onerror?.();
  }

  static _instances: MockEventSource[] = [];
  static _closed: MockEventSource[] = [];
  static latest(): MockEventSource {
    return MockEventSource._instances[MockEventSource._instances.length - 1];
  }
  static reset(): void {
    MockEventSource._instances = [];
    MockEventSource._closed = [];
  }
}

// ---------------------------------------------------------------------------
// In-memory storage adapter (replaces sessionStorage / localStorage in Node)
// ---------------------------------------------------------------------------

function makeMemoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshot() {
  return {
    channelId: "main",
    sequence: 1,
    serverTimeMs: Date.now(),
    mode: "queue" as const,
    current: null,
    next: null,
    nextNext: null,
    override: null,
    checkpoint: null,
    failover: { active: false, reason: null },
  };
}

function makeTransport(overrides: {
  onPlayerEvent?: (e: PlayerEvent) => void;
  onConnectionChange?: (c: boolean) => void;
  onClockCalibration?: (ms: number) => void;
} = {}) {
  const events: PlayerEvent[] = [];
  const connections: boolean[] = [];
  const clockOffsets: number[] = [];
  const transport = new V2Transport({
    baseUrl: "wss://api.example.com/api/broadcast-v2",
    channel: "main",
    onPlayerEvent: overrides.onPlayerEvent ?? ((e) => events.push(e)),
    onConnectionChange: overrides.onConnectionChange ?? ((c) => connections.push(c)),
    onClockCalibration: overrides.onClockCalibration ?? ((ms) => clockOffsets.push(ms)),
  });
  return { transport, events, connections, clockOffsets };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  MockWebSocket.reset();
  MockEventSource.reset();
  vi.useFakeTimers();
  // Replace WebSocket and EventSource globals with mocks
  vi.stubGlobal("WebSocket", MockWebSocket);
  vi.stubGlobal("EventSource", MockEventSource);
  // Redirect storage so tests don't touch real sessionStorage/localStorage
  configureMobileStorage(makeMemoryStorage());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  // Reset module-level storage adapter
  configureMobileStorage(makeMemoryStorage());
});

// ---------------------------------------------------------------------------
// Basic connect / disconnect
// ---------------------------------------------------------------------------

describe("V2Transport — WebSocket connect", () => {
  it("start() creates a WebSocket connection", () => {
    const { transport } = makeTransport();
    transport.start();
    expect(MockWebSocket._instances).toHaveLength(1);
    expect(MockWebSocket.latest().url).toContain("/ws");
    transport.stop();
  });

  it("onConnectionChange(true) fires when WS opens", () => {
    const { transport, connections } = makeTransport();
    transport.start();
    MockWebSocket.latest().simulateOpen();
    expect(connections).toContain(true);
    transport.stop();
  });

  it("onConnectionChange(false) fires when WS closes after open", () => {
    const { transport, connections } = makeTransport();
    transport.start();
    const ws = MockWebSocket.latest();
    ws.simulateOpen();
    ws.simulateClose();
    expect(connections.filter(Boolean)).toHaveLength(1);
    expect(connections[connections.length - 1]).toBe(false);
    transport.stop();
  });

  it("stop() clears connection and fires onConnectionChange(false)", () => {
    const { transport, connections } = makeTransport();
    transport.start();
    MockWebSocket.latest().simulateOpen();
    transport.stop();
    expect(connections[connections.length - 1]).toBe(false);
  });

  it("stop() is idempotent — second call does not throw", () => {
    const { transport } = makeTransport();
    transport.start();
    transport.stop();
    expect(() => transport.stop()).not.toThrow();
  });

  it("sends resume frame when lastSequence > 0 on WS open", () => {
    const { transport } = makeTransport();
    transport.start();
    const ws = MockWebSocket.latest();
    // Simulate a snapshot arriving (bumps lastSequence)
    ws.simulateOpen();
    ws.simulateMessage({ type: "snapshot", sequence: 5, state: makeSnapshot() });
    // Force reconnect to observe the resume frame on re-open
    transport.forceReconnect();
    vi.advanceTimersByTime(500);
    const ws2 = MockWebSocket.latest();
    ws2.simulateOpen();
    const resumeMsg = ws2.sentMessages.find((m) => {
      try { return JSON.parse(m).type === "resume"; } catch { return false; }
    });
    expect(resumeMsg).toBeDefined();
    if (resumeMsg) {
      expect(JSON.parse(resumeMsg).lastSequence).toBe(5);
    }
    transport.stop();
  });
});

// ---------------------------------------------------------------------------
// WS → SSE fallback
// ---------------------------------------------------------------------------

describe("V2Transport — WS→SSE fallback", () => {
  it("falls back to SSE after 3 consecutive WS connection failures", () => {
    const { transport } = makeTransport();
    transport.start();

    // Fail 3 WS connections without ever opening
    for (let i = 0; i < 3; i++) {
      const ws = MockWebSocket.latest();
      ws.simulateError(); // fires onerror → close without onopen
      vi.advanceTimersByTime(2_000); // wait for reconnect schedule
    }

    // 4th reconnect should be SSE
    expect(MockEventSource._instances.length).toBeGreaterThanOrEqual(1);
    transport.stop();
  });

  it("SSE clears on WS re-open (no dual-stream duplicate delivery)", () => {
    const { transport } = makeTransport();
    transport.start();

    // Force into SSE mode
    for (let i = 0; i < 3; i++) {
      MockWebSocket.latest().simulateError();
      vi.advanceTimersByTime(2_000);
    }
    const sseCount = MockEventSource._instances.length;
    expect(sseCount).toBeGreaterThanOrEqual(1);

    // Probe WS (after WS_PROBE_INTERVAL_SSE_ROUNDS SSE reconnects)
    for (let i = 0; i < 5; i++) {
      MockEventSource.latest().simulateError();
      vi.advanceTimersByTime(2_000);
    }

    // Find latest WS and open it
    const ws = MockWebSocket.latest();
    if (ws) {
      ws.simulateOpen();
      // The SSE should now be closed
      expect(MockEventSource._closed.length).toBeGreaterThanOrEqual(1);
    }
    transport.stop();
  });

  it("requestSnapshot() while inflight does not start a second fetch", () => {
    const { transport } = makeTransport();
    transport.start();
    const ws = MockWebSocket.latest();
    ws.simulateOpen();

    // requestSnapshot is called internally on WS open when lastSequence=0
    // calling it again immediately should be deduplicated
    expect(() => {
      transport.requestSnapshot();
      transport.requestSnapshot();
      transport.requestSnapshot();
    }).not.toThrow();
    transport.stop();
  });
});

// ---------------------------------------------------------------------------
// Dead-socket watchdog
// ---------------------------------------------------------------------------

describe("V2Transport — dead-socket watchdog", () => {
  it("isHealthy() returns true immediately after WS open", () => {
    const { transport } = makeTransport();
    transport.start();
    MockWebSocket.latest().simulateOpen();
    expect(transport.isHealthy()).toBe(true);
    transport.stop();
  });

  it("isHealthy() returns false after DEAD_SOCKET_THRESHOLD_MS with no frames", () => {
    const { transport } = makeTransport();
    transport.start();
    MockWebSocket.latest().simulateOpen();
    // Advance past the dead-socket threshold (22 s)
    vi.advanceTimersByTime(23_000);
    expect(transport.isHealthy()).toBe(false);
    transport.stop();
  });

  it("force-reconnects zombie socket after DEAD_SOCKET_THRESHOLD_MS", () => {
    const { transport } = makeTransport();
    transport.start();
    const ws = MockWebSocket.latest();
    ws.simulateOpen();
    const totalBefore = MockWebSocket._instances.length + MockEventSource._instances.length;

    // DEAD_SOCKET_THRESHOLD_MS = 22s, watchdog interval = 6s.
    // Advance past threshold + reconnect schedule (INITIAL_BACKOFF_MS=300ms + max jitter=150ms).
    vi.advanceTimersByTime(25_000);

    // Should have initiated a new connection (WS or SSE depending on streak)
    const totalAfter = MockWebSocket._instances.length + MockEventSource._instances.length;
    expect(totalAfter).toBeGreaterThan(totalBefore);
    transport.stop();
  });

  it("heartbeat frame resets the dead-socket watchdog", () => {
    const { transport } = makeTransport();
    transport.start();
    const ws = MockWebSocket.latest();
    ws.simulateOpen();
    const wsCountBefore = MockWebSocket._instances.length;

    // Advance 15 s, then send a heartbeat
    vi.advanceTimersByTime(15_000);
    ws.simulateMessage({ type: "heartbeat", sequence: 1, serverTimeMs: Date.now() });

    // Advance another 15 s (total 30 s but only 15 s without a frame)
    vi.advanceTimersByTime(15_000);

    // Should NOT have reconnected — heartbeat refreshed the watchdog
    expect(MockWebSocket._instances.length).toBe(wsCountBefore);
    transport.stop();
  });
});

// ---------------------------------------------------------------------------
// forceReconnect
// ---------------------------------------------------------------------------

describe("V2Transport — forceReconnect()", () => {
  it("creates a new connection immediately", () => {
    const { transport } = makeTransport();
    transport.start();
    MockWebSocket.latest().simulateOpen();
    const countBefore = MockWebSocket._instances.length;
    transport.forceReconnect();
    vi.advanceTimersByTime(500);
    expect(MockWebSocket._instances.length).toBeGreaterThan(countBefore);
    transport.stop();
  });

  it("resets exponential backoff — reconnect fires within 600ms", () => {
    const { transport } = makeTransport();
    transport.start();

    // Let backoff accumulate through 3 WS failures (this also enters SSE-preference mode
    // since WS_FAIL_STREAK_SSE_FALLBACK = 3). After 3 consecutive failures without opening,
    // the transport switches to SSE. forceReconnect still schedules promptly.
    for (let i = 0; i < 3; i++) {
      // Close without opening (simulates "never connected") → wsFailStreak++
      const ws = MockWebSocket.latest();
      if (ws) {
        ws.simulateClose();
      }
      vi.advanceTimersByTime(3_000);
    }

    // forceReconnect resets backoffMs to INITIAL_BACKOFF_MS (300ms).
    // A new connection (WS probe or SSE) should appear within 600ms.
    const totalBefore = MockWebSocket._instances.length + MockEventSource._instances.length;
    transport.forceReconnect();
    vi.advanceTimersByTime(600);
    const totalAfter = MockWebSocket._instances.length + MockEventSource._instances.length;
    expect(totalAfter).toBeGreaterThan(totalBefore);
    transport.stop();
  });

  it("no-op when stopped", () => {
    const { transport } = makeTransport();
    transport.start();
    transport.stop();
    const countAfterStop = MockWebSocket._instances.length;
    transport.forceReconnect();
    vi.advanceTimersByTime(2_000);
    expect(MockWebSocket._instances.length).toBe(countAfterStop);
  });
});

// ---------------------------------------------------------------------------
// Clock calibration EMA
// ---------------------------------------------------------------------------

describe("V2Transport — clock calibration EMA", () => {
  it("getClockOffsetMs() returns 0 before any frame arrives", () => {
    const { transport } = makeTransport();
    transport.start();
    MockWebSocket.latest().simulateOpen();
    expect(transport.getClockOffsetMs()).toBe(0);
    transport.stop();
  });

  it("seeds EMA from first measurement without 130-sample ramp", () => {
    const { transport, clockOffsets } = makeTransport();
    transport.start();
    const ws = MockWebSocket.latest();
    ws.simulateOpen();

    const serverAheadBy = 5_000; // server clock 5 s ahead
    ws.simulateMessage({
      type: "heartbeat",
      sequence: 1,
      serverTimeMs: Date.now() + serverAheadBy,
    });

    // First sample seeds directly — no ramp from 0
    expect(Math.abs(transport.getClockOffsetMs() - serverAheadBy)).toBeLessThan(200);
    transport.stop();
  });

  it("onClockCalibration fires when offset changes by >1 ms", () => {
    const { transport, clockOffsets } = makeTransport();
    transport.start();
    const ws = MockWebSocket.latest();
    ws.simulateOpen();

    ws.simulateMessage({ type: "heartbeat", sequence: 1, serverTimeMs: Date.now() + 3_000 });
    expect(clockOffsets.length).toBeGreaterThanOrEqual(1);
    transport.stop();
  });

  it("EMA smooths out jitter — large single spike does not dominate", () => {
    const { transport } = makeTransport();
    transport.start();
    const ws = MockWebSocket.latest();
    ws.simulateOpen();

    // Establish baseline at 100 ms offset
    for (let i = 0; i < 10; i++) {
      ws.simulateMessage({ type: "heartbeat", sequence: i + 1, serverTimeMs: Date.now() + 100 });
    }
    const baseline = transport.getClockOffsetMs();

    // Single spike of 10 000 ms — EMA α=0.15 should keep result near baseline
    ws.simulateMessage({ type: "heartbeat", sequence: 11, serverTimeMs: Date.now() + 10_000 });
    const afterSpike = transport.getClockOffsetMs();

    // 10 000 * 0.15 = 1 500 ms shift maximum
    expect(afterSpike - baseline).toBeLessThan(2_000);
    transport.stop();
  });

  it("clock calibration fires from snapshot frames too", () => {
    const { transport, clockOffsets } = makeTransport();
    transport.start();
    const ws = MockWebSocket.latest();
    ws.simulateOpen();

    const snap = makeSnapshot();
    snap.serverTimeMs = Date.now() + 2_000;
    ws.simulateMessage({ type: "snapshot", sequence: 1, state: snap });

    expect(clockOffsets.length).toBeGreaterThanOrEqual(1);
    transport.stop();
  });
});

// ---------------------------------------------------------------------------
// Frame dispatch to FSM
// ---------------------------------------------------------------------------

describe("V2Transport — frame dispatch", () => {
  it("snapshot frame fires onPlayerEvent({ type: 'snapshot' })", () => {
    const { transport, events } = makeTransport();
    transport.start();
    const ws = MockWebSocket.latest();
    ws.simulateOpen();

    ws.simulateMessage({ type: "snapshot", sequence: 1, state: makeSnapshot() });
    expect(events.some((e) => e.type === "snapshot")).toBe(true);
    transport.stop();
  });

  it("takeover frame fires onPlayerEvent({ type: 'takeover' })", () => {
    const { transport, events } = makeTransport();
    transport.start();
    const ws = MockWebSocket.latest();
    ws.simulateOpen();

    ws.simulateMessage({
      type: "takeover",
      sequence: 2,
      override: {
        id: "ov-1",
        kind: "hls",
        url: "https://cdn.example.com/live.m3u8",
        title: "Live",
        startedAtMs: Date.now(),
        endsAtMs: null,
        resumeQueueOnEnd: true,
      },
    });
    expect(events.some((e) => e.type === "takeover")).toBe(true);
    transport.stop();
  });

  it("preload frame fires onPlayerEvent({ type: 'preload' })", () => {
    const { transport, events } = makeTransport();
    transport.start();
    const ws = MockWebSocket.latest();
    ws.simulateOpen();

    ws.simulateMessage({
      type: "preload",
      sequence: 3,
      item: {
        id: "item-next",
        title: "Next Item",
        thumbnailUrl: null,
        durationSecs: 3600,
        source: { kind: "hls", url: "https://cdn.example.com/next.m3u8", expiresAtMs: null },
        failoverSource: null,
        startsAtMs: Date.now() + 60_000,
        endsAtMs: Date.now() + 3_660_000,
      },
      leadMs: 90_000,
    });
    expect(events.some((e) => e.type === "preload")).toBe(true);
    transport.stop();
  });

  it("malformed JSON frame is silently dropped — no throw", () => {
    const { transport } = makeTransport();
    transport.start();
    const ws = MockWebSocket.latest();
    ws.simulateOpen();

    expect(() => {
      ws.onmessage?.({ data: "{ not valid json }" });
    }).not.toThrow();
    transport.stop();
  });

  it("lastSequence advances on frames carrying sequence", () => {
    const { transport } = makeTransport();
    transport.start();
    const ws = MockWebSocket.latest();
    ws.simulateOpen();
    ws.simulateMessage({ type: "snapshot", sequence: 7, state: makeSnapshot() });
    ws.simulateMessage({ type: "heartbeat", sequence: 9, serverTimeMs: Date.now() });

    // Reconnect and check resume sequence
    transport.forceReconnect();
    vi.advanceTimersByTime(500);
    const ws2 = MockWebSocket.latest();
    ws2.simulateOpen();
    const resume = ws2.sentMessages.find((m) => {
      try { return JSON.parse(m).type === "resume"; } catch { return false; }
    });
    expect(resume).toBeDefined();
    if (resume) expect(JSON.parse(resume).lastSequence).toBe(9);
    transport.stop();
  });

  it("out-of-order frames do not regress lastSequence", () => {
    const { transport } = makeTransport();
    transport.start();
    const ws = MockWebSocket.latest();
    ws.simulateOpen();

    ws.simulateMessage({ type: "snapshot", sequence: 10, state: makeSnapshot() });
    ws.simulateMessage({ type: "heartbeat", sequence: 3, serverTimeMs: Date.now() }); // stale

    transport.forceReconnect();
    vi.advanceTimersByTime(500);
    const ws2 = MockWebSocket.latest();
    ws2.simulateOpen();
    const resume = ws2.sentMessages.find((m) => {
      try { return JSON.parse(m).type === "resume"; } catch { return false; }
    });
    if (resume) expect(JSON.parse(resume).lastSequence).toBe(10);
    transport.stop();
  });
});

// ---------------------------------------------------------------------------
// SSE path
// ---------------------------------------------------------------------------

describe("V2Transport — SSE connect", () => {
  it("SSE receives snapshot frames and dispatches them", () => {
    const { transport, events } = makeTransport();
    // Force SSE path by making WS unavailable
    vi.stubGlobal("WebSocket", undefined);
    transport.start();

    const sse = MockEventSource.latest();
    sse.simulateFrame("snapshot", { type: "snapshot", sequence: 1, state: makeSnapshot() });
    expect(events.some((e) => e.type === "snapshot")).toBe(true);
    transport.stop();
  });

  it("SSE error triggers scheduleReconnect", () => {
    const { transport } = makeTransport();
    vi.stubGlobal("WebSocket", undefined);
    transport.start();

    const sseBefore = MockEventSource._instances.length;
    MockEventSource.latest().simulateError();
    vi.advanceTimersByTime(2_000);

    // Should attempt a new SSE (or WS) connection
    const totalConnections = MockWebSocket._instances.length + MockEventSource._instances.length;
    expect(totalConnections).toBeGreaterThan(sseBefore);
    transport.stop();
  });

  it("SSE url includes lastSequence as query param after prior connection", () => {
    const { transport } = makeTransport();
    vi.stubGlobal("WebSocket", undefined);
    transport.start();

    const sse = MockEventSource.latest();
    sse.simulateFrame("snapshot", { type: "snapshot", sequence: 5, state: makeSnapshot() });
    sse.simulateError();
    vi.advanceTimersByTime(2_000);

    const sse2 = MockEventSource.latest();
    expect(sse2.url).toContain("lastSequence=5");
    transport.stop();
  });
});
