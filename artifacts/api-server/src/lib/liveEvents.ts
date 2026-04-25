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
}

const clients = new Set<SSEClient>();

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

export function addSSEClient(res: Response, platform: unknown = "unknown"): SSEClient {
  const client: SSEClient = {
    id: randomUUID(),
    res,
    connectedAt: Date.now(),
    lastWriteAt: Date.now(),
    platform: normalizePlatform(platform),
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
        client.res.write(payload);
        flushClient(client);
      } catch {
        dead.push(client);
      }
    }
    for (const c of dead) clients.delete(c);

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
