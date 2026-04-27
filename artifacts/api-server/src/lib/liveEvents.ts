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
}

const clients = new Set<SSEClient>();

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

export function broadcastLiveEvent(event: string, data: unknown): void {
  const id = ++eventSequence;
  const payload = `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const dead: SSEClient[] = [];
  let ok = 0;
  for (const client of clients) {
    try {
      client.res.write(payload);
      flushClient(client);
      client.lastWriteAt = Date.now();
      ok++;
    } catch {
      dead.push(client);
    }
  }
  for (const c of dead) clients.delete(c);
  // Fire observers outside the hot loop. Skip self-emitted health pings so
  // the stability metric doesn't measure itself recursively.
  if (event !== "stream-health" && (ok > 0 || dead.length > 0)) {
    for (const obs of writeObservers) {
      try { obs(ok, dead.length); } catch {}
    }
  }
}

export function writeSingleClient(client: SSEClient, event: string, data: unknown): void {
  const id = ++eventSequence;
  const payload = `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  try {
    client.res.write(payload);
    flushClient(client);
    client.lastWriteAt = Date.now();
  } catch {
    clients.delete(client);
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

    broadcastLiveEvent("heartbeat", { ts: now, clients: clients.size });
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
