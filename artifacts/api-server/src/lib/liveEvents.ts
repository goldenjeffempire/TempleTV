import type { Response } from "express";
import { randomUUID } from "crypto";

export interface LiveStatusSnapshot {
  isLive: boolean;
  ytLive: boolean;
  ytVideoId: string | null;
  ytTitle: string | null;
  checkedAt: number;
  liveOverride: {
    id: string;
    title: string;
    startedAt: string;
    endsAt: string | null;
    elapsedSecs: number;
    remainingSecs: number | null;
  } | null;
}

export type SSEPlatform = "tv" | "mobile" | "admin" | "unknown";

interface SSEClient {
  id: string;
  res: Response;
  connectedAt: number;
  lastWriteAt: number;
  platform: SSEPlatform;
  ip: string;
  /**
   * Count of consecutive `res.write()` calls that returned `false`
   * (Node has queued bytes waiting for the kernel TCP send buffer to
   * drain). Reset to 0 on any successful write. When this exceeds
   * MAX_CONSECUTIVE_BACKPRESSURED_WRITES the client is treated as
   * wedged and dropped — without this, a slow mobile/TV consumer
   * accumulates the per-second `stream-health` frames in its
   * user-space socket buffer until the process OOMs (the cause of
   * the 2026-04-27 production RSS bloat).
   */
  consecutiveBackpressuredWrites: number;
}

const clients = new Set<SSEClient>();

/**
 * Hard cap on the user-space socket write buffer per SSE client (bytes).
 * Once `socket.writableLength` exceeds this, the client is treated as
 * wedged and dropped — bounded by `MAX_SSE_CLIENTS_GLOBAL` × this value
 * gives the worst-case external-memory footprint of the SSE subsystem
 * (5000 × 512 KiB ≈ 2.5 GiB worst case if every client is exactly at
 * the cap, but in practice clients drop the moment they cross). The
 * default 512 KiB comfortably absorbs a transient ~30 stream-health
 * frames or a multi-second TCP RTT spike without false positives.
 */
const MAX_SOCKET_BUFFER_BYTES = Math.max(
  64 * 1024,
  Number(process.env.MAX_SSE_SOCKET_BUFFER_BYTES ?? String(512 * 1024)),
);

/**
 * After this many consecutive backpressured (write→false) frames,
 * declare the client wedged. With the stream-health emitter at 1 Hz,
 * 8 frames is ~8 s of unrelieved buffer pressure — long enough to
 * absorb a brief WAN hiccup, short enough that we don't accumulate
 * many MB of buffered data per slow client.
 */
const MAX_CONSECUTIVE_BACKPRESSURED_WRITES = Math.max(
  3,
  Number(process.env.MAX_SSE_BACKPRESSURED_WRITES ?? "8"),
);

function getSocketWritableLength(client: SSEClient): number {
  try {
    const sock = (client.res as unknown as {
      socket?: { writableLength?: number };
    }).socket;
    return sock?.writableLength ?? 0;
  } catch {
    return 0;
  }
}

function destroySSEClientSocket(client: SSEClient): void {
  try { client.res.end(); } catch {}
  try {
    const sock = (client.res as unknown as { socket?: { destroy?: () => void } }).socket;
    sock?.destroy?.();
  } catch {}
}

// Defence-in-depth caps for SSE so the per-process clients Set cannot grow
// unbounded under a misbehaving client or low-effort DoS attempt. The per-IP
// cap blocks a single host from monopolising the budget; the global cap keeps
// the entire server within memory budget even under multi-IP fan-out. Both
// are tunable via env vars for ops-driven scaling. The global cap is sized
// for the realistic peak of ~3-4k concurrent live viewers with admin and TV
// dashboards on top, with headroom.
const MAX_SSE_CLIENTS_GLOBAL = Math.max(
  64,
  Number(process.env.MAX_SSE_CLIENTS_GLOBAL ?? "5000"),
);
const MAX_SSE_CLIENTS_PER_IP = Math.max(
  4,
  Number(process.env.MAX_SSE_CLIENTS_PER_IP ?? "32"),
);

function normalizePlatform(raw: unknown): SSEPlatform {
  if (raw === "tv" || raw === "mobile" || raw === "admin") return raw;
  return "unknown";
}

function flushClient(client: SSEClient): void {
  try {
    const r = client.res as unknown as { flush?: () => void };
    if (typeof r.flush === "function") r.flush();
  } catch {}
}

function countClientsByIp(ip: string): number {
  let n = 0;
  for (const c of clients) if (c.ip === ip) n++;
  return n;
}

/**
 * Errors thrown from this function MUST be handled by the calling route — they
 * indicate the client should be rejected (e.g. 503 Service Unavailable or
 * 429 Too Many Requests) rather than added to the broadcast set.
 */
export class SSECapacityError extends Error {
  constructor(
    public readonly reason: "global_cap" | "per_ip_cap",
    public readonly retryAfterSecs: number,
  ) {
    super(reason === "global_cap" ? "Server SSE capacity reached" : "Per-IP SSE limit reached");
    this.name = "SSECapacityError";
  }
}

export function addSSEClient(
  res: Response,
  platform: unknown = "unknown",
  ip: string = "unknown",
): SSEClient {
  if (clients.size >= MAX_SSE_CLIENTS_GLOBAL) {
    throw new SSECapacityError("global_cap", 30);
  }
  if (ip !== "unknown" && countClientsByIp(ip) >= MAX_SSE_CLIENTS_PER_IP) {
    throw new SSECapacityError("per_ip_cap", 10);
  }
  const client: SSEClient = {
    id: randomUUID(),
    res,
    connectedAt: Date.now(),
    lastWriteAt: Date.now(),
    platform: normalizePlatform(platform),
    ip,
    consecutiveBackpressuredWrites: 0,
  };
  clients.add(client);
  return client;
}

export function removeSSEClient(client: SSEClient): void {
  clients.delete(client);
}

let eventSequence = 0;

// Observer hook so other modules (e.g. streamHealth) can compute connection
// stability from real write outcomes without re-wrapping the broadcast path.
type WriteObserver = (ok: number, failed: number) => void;
const writeObservers = new Set<WriteObserver>();

export function registerSSEWriteObserver(observer: WriteObserver): () => void {
  writeObservers.add(observer);
  return () => writeObservers.delete(observer);
}

// ─── Cross-instance bus integration ──────────────────────────────────────
//
// `liveEventsBus.ts` registers itself here on startup so this module can
// notify the bus on every (non-local-only) broadcast WITHOUT importing the
// bus module directly (one-way imports prevent a circular dep — the bus
// imports the local fanout function below; we only know about it via this
// settable hook).
//
// When the hook is null (REDIS_URL unset, or before the bus is armed, or
// after `stopLiveEventsBus()`), `broadcastLiveEvent` behaves identically
// to the pre-bus implementation: local-only fanout, no Redis traffic. The
// 36 existing call sites of `broadcastLiveEvent` need no changes — bus
// integration is purely additive.
type BusPublishHook = (event: string, data: unknown) => void;
let busPublishHook: BusPublishHook | null = null;

/** Called by `liveEventsBus.startLiveEventsBus()` / `stopLiveEventsBus()`. */
export function setBusPublishHook(hook: BusPublishHook | null): void {
  busPublishHook = hook;
}

/**
 * Local fanout — deliver an event to all SSE clients connected to THIS
 * process only. Public so `liveEventsBus.ts` can call it on inbound
 * cross-instance frames without re-publishing them (which would loop
 * forever). Most code should call `broadcastLiveEvent` (cross-instance)
 * or `broadcastLiveEventLocal` (explicit local-only) instead.
 */
export function localBroadcastLiveEvent(event: string, data: unknown): void {
  const id = ++eventSequence;
  const payload = `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const dead: SSEClient[] = [];
  let ok = 0;
  for (const client of clients) {
    // Pre-write backpressure check: if Node's user-space TCP write
    // buffer for this socket already has more than MAX_SOCKET_BUFFER_BYTES
    // queued, the client is consuming bytes slower than we're producing
    // them. Continuing to push would just grow the buffer forever
    // (Buffer memory shows up in `process.memoryUsage().external`,
    // outside the V8 heap cap). Drop the client now.
    if (getSocketWritableLength(client) > MAX_SOCKET_BUFFER_BYTES) {
      dead.push(client);
      continue;
    }
    try {
      const writeOk = client.res.write(payload);
      flushClient(client);
      if (writeOk) {
        client.consecutiveBackpressuredWrites = 0;
        client.lastWriteAt = Date.now();
        ok++;
      } else {
        // write() returned false → bytes are queued waiting for drain.
        // Keep `lastWriteAt` UNCHANGED so the 20 s heartbeat stale-check
        // can still catch a permanently wedged socket; only update
        // lastWriteAt on a clean write. Track a counter so a steady
        // stream of `false` returns drops the client well before the
        // socket buffer hits the hard cap above.
        client.consecutiveBackpressuredWrites++;
        if (client.consecutiveBackpressuredWrites >= MAX_CONSECUTIVE_BACKPRESSURED_WRITES) {
          dead.push(client);
        }
      }
    } catch {
      dead.push(client);
    }
  }
  for (const c of dead) {
    clients.delete(c);
    // Tear the socket down explicitly. Without end()+destroy() Node
    // holds the Response and its queued buffers alive until the OS
    // TCP keepalive eventually times out (minutes), which would
    // re-create exactly the leak this whole patch is fixing.
    destroySSEClientSocket(c);
  }
  // Fire observers outside the hot loop. Skip self-emitted health pings so
  // the stability metric doesn't measure itself recursively.
  if (event !== "stream-health" && (ok > 0 || dead.length > 0)) {
    for (const obs of writeObservers) {
      try { obs(ok, dead.length); } catch {}
    }
  }
}

/**
 * Broadcast an SSE event to all clients across ALL instances.
 *
 * Behavior:
 *   1. Always fans out to local SSE clients first (synchronous, fast path).
 *   2. If the cross-instance bus is armed (REDIS_URL set + bus started),
 *      ALSO publishes to the bus so other instances deliver it to their
 *      local clients. Fire-and-forget — bus failures never throw here
 *      and never delay the local fanout.
 *
 * This is the function 36 call sites across the codebase already use.
 * It keeps the same name and signature as the pre-bus implementation —
 * the cross-instance behavior is added transparently when REDIS_URL is
 * set in the deploy environment.
 *
 * For events that should NOT propagate cross-instance (per-instance
 * heartbeats, per-instance pipeline health), use `broadcastLiveEventLocal`
 * instead.
 */
export function broadcastLiveEvent(event: string, data: unknown): void {
  localBroadcastLiveEvent(event, data);
  // Notify the cross-instance bus AFTER local delivery so a slow Redis
  // can never delay an admin-action's user-visible feedback. The hook
  // is null when the bus is disabled — zero overhead in single-instance
  // deployments.
  if (busPublishHook) {
    try {
      busPublishHook(event, data);
    } catch {
      // The hook implementation is itself fire-and-forget (returns void,
      // catches its own promise rejections); reaching this catch means
      // a synchronous throw inside the hook setter — should not happen
      // but we swallow it to guarantee local fanout is never disturbed
      // by bus errors.
    }
  }
}

/**
 * Broadcast an SSE event to local clients ONLY. Never published to the
 * cross-instance bus.
 *
 * Use this for events that describe per-instance state (e.g. heartbeats
 * carrying per-instance client counts, per-instance pipeline-health
 * snapshots). Cross-publishing those would just have every other instance
 * receive a snapshot of THIS instance's state, which is at best useless
 * and at worst misleading on the receiver's dashboards.
 */
export function broadcastLiveEventLocal(event: string, data: unknown): void {
  localBroadcastLiveEvent(event, data);
}

export function writeSingleClient(client: SSEClient, event: string, data: unknown): void {
  const id = ++eventSequence;
  const payload = `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  if (getSocketWritableLength(client) > MAX_SOCKET_BUFFER_BYTES) {
    clients.delete(client);
    destroySSEClientSocket(client);
    return;
  }
  try {
    const writeOk = client.res.write(payload);
    flushClient(client);
    if (writeOk) {
      client.consecutiveBackpressuredWrites = 0;
      client.lastWriteAt = Date.now();
    } else {
      client.consecutiveBackpressuredWrites++;
      if (client.consecutiveBackpressuredWrites >= MAX_CONSECUTIVE_BACKPRESSURED_WRITES) {
        clients.delete(client);
        destroySSEClientSocket(client);
      }
    }
  } catch {
    clients.delete(client);
    destroySSEClientSocket(client);
  }
}

export function getSSEClientCount(): number {
  return clients.size;
}

export function getSSEClientCountsByPlatform(): Record<SSEPlatform, number> {
  const counts: Record<SSEPlatform, number> = { tv: 0, mobile: 0, admin: 0, unknown: 0 };
  for (const c of clients) counts[c.platform]++;
  return counts;
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

export function startSSEHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    const now = Date.now();
    const staleThreshold = 90_000;
    const dead: SSEClient[] = [];

    const payload = `: heartbeat\n\n`;
    for (const client of clients) {
      if (now - client.lastWriteAt > staleThreshold) {
        dead.push(client);
        continue;
      }
      try {
        // write() returns false when the socket buffer is full (backpressure).
        // A client whose buffer keeps filling is already wedged — refusing to
        // accept more bytes — and continuing to push payloads at it just
        // grows our process memory until OOM. Treat it as dead so the next
        // tick reclaims the FD.
        const ok = client.res.write(payload);
        if (!ok) {
          dead.push(client);
          continue;
        }
        flushClient(client);
      } catch {
        dead.push(client);
      }
    }
    // Drop dead clients from the broadcast set AND tear down their underlying
    // socket. Without the explicit res.end()/destroy(), Node holds the
    // Response object alive until the OS TCP keepalive eventually times out
    // (minutes to hours), leaking memory and file descriptors per stale
    // connection. Under sustained reconnect churn this exhausts the FD limit.
    for (const c of dead) {
      clients.delete(c);
      try { c.res.end(); } catch {}
      try {
        const sock = (c.res as unknown as { socket?: { destroy?: () => void } }).socket;
        sock?.destroy?.();
      } catch {}
    }

    // Heartbeat is per-instance state (carries this instance's local
    // client count). Cross-publishing it would have every other instance
    // receive a heartbeat with a count that doesn't describe their own
    // clients, polluting telemetry and wasting bus bandwidth.
    broadcastLiveEventLocal("heartbeat", { ts: now, clients: clients.size });
  }, 20_000);

  heartbeatTimer.unref();
}

export function stopSSEHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

export function closeAllSSEClients(): void {
  for (const client of clients) {
    try {
      client.res.end();
    } catch {}
  }
  clients.clear();
}
