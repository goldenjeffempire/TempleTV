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
}

const clients = new Set<SSEClient>();

export function addSSEClient(res: Response): SSEClient {
  const client: SSEClient = { id: randomUUID(), res, connectedAt: Date.now() };
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
    } catch {
      dead.push(client);
    }
  }
  for (const c of dead) clients.delete(c);
}

export function getSSEClientCount(): number {
  return clients.size;
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

export function startSSEHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    broadcastLiveEvent("heartbeat", { ts: Date.now(), clients: clients.size });
  }, 25000);
}
