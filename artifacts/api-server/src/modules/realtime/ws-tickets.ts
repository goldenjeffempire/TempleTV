import { randomBytes, createHash } from "node:crypto";

const TICKET_TTL_MS = 30_000;
const MAX_TICKETS = 10_000;

interface TicketRecord {
  channelId: string;
  userId: string;
  email: string;
  role: string | null;
  expiresAt: number;
}

// Opaque tickets are deliberately kept only as hashes. They are single-use,
// short-lived, and scoped to this websocket audience and channel.
// This store is process-local because chat rooms are currently process-local
// and production runs one API instance. Before horizontal chat scaling this
// must move to Redis with atomic GETDEL/Lua consumption.
const tickets = new Map<string, TicketRecord>();

function digest(ticket: string): string {
  return createHash("sha256").update(ticket).digest("hex");
}

function prune(now = Date.now()): void {
  for (const [key, record] of tickets) {
    if (record.expiresAt <= now) tickets.delete(key);
  }
  while (tickets.size > MAX_TICKETS) {
    const oldest = tickets.keys().next().value;
    if (oldest === undefined) break;
    tickets.delete(oldest);
  }
}

export function issueChatWsTicket(input: {
  channelId: string;
  userId: string;
  email: string;
  role?: string | null;
}, ttlMs = TICKET_TTL_MS): { ticket: string; expiresInMs: number } {
  prune();
  const ticket = randomBytes(32).toString("base64url");
  tickets.set(digest(ticket), {
    channelId: input.channelId,
    userId: input.userId,
    email: input.email,
    role: input.role ?? null,
    expiresAt: Date.now() + ttlMs,
  });
  return { ticket, expiresInMs: ttlMs };
}

export function consumeChatWsTicket(
  ticket: string | null,
  channelId: string,
): TicketRecord | null {
  if (!ticket || ticket.length > 256) return null;
  prune();
  const key = digest(ticket);
  const record = tickets.get(key);
  // Delete before returning: even concurrent upgrade handlers cannot replay it.
  if (!record) return null;
  tickets.delete(key);
  if (record.expiresAt <= Date.now() || record.channelId !== channelId) return null;
  return record;
}

export function clearChatWsTicketsForTests(): void {
  tickets.clear();
}
