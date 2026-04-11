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

interface SSEClient {
  id: string;
  res: Response;
  connectedAt: number;
  lastWriteAt: number;
}

const clients = new Set<SSEClient>();

function flushClient(client: SSEClient): void {
  try {
    const r = client.res as unknown as { flush?: () => void };
    if (typeof r.flush === "function") r.flush();
  } catch {}
}

export function addSSEClient(res: Response): SSEClient {
  const client: SSEClient = {
    id: randomUUID(),
    res,
    connectedAt: Date.now(),
    lastWriteAt: Date.now(),
  };
  clients.add(client);
  return client;
}

export function removeSSEClient(client: SSEClient): void {
  clients.delete(client);
}

export function broadcastLiveEvent(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const dead: SSEClient[] = [];
  for (const client of clients) {
    try {
      client.res.write(payload);
      flushClient(client);
      client.lastWriteAt = Date.now();
    } catch {
      dead.push(client);
    }
  }
  for (const c of dead) clients.delete(c);
}

export function writeSingleClient(client: SSEClient, event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
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
}
