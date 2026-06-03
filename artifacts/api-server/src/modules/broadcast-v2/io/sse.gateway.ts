import type { FastifyInstance } from "fastify";
import { broadcastOrchestrator } from "../engine/broadcast-orchestrator.js";
import { eventLogRepo } from "../repository/event-log.repo.js";
import type { V2EventType, V2ServerFrame } from "../domain/types.js";
import { activeSseConnections, SERVICE_LABELS } from "../../../infrastructure/metrics.js";
import { logger } from "../../../infrastructure/logger.js";
import { sseCounter } from "../../../infrastructure/sse-counter.js";

/**
 * Per-IP SSE connection counter. Prevents a single client or runaway browser
 * tab loop from exhausting server file descriptors. The limit is read from the
 * MAX_SSE_PER_IP environment variable (default: 8). Set to 0 to disable.
 */
const sseConnectionsPerIp = new Map<string, number>();

// ── Periodic IP-map sweep ─────────────────────────────────────────────────────
// Belt-and-suspenders safety net: in a long-running server that sees many
// unique visitor IPs, any edge case where the close event doesn't fire (OS-level
// TCP RST, proxy reset, etc.) would leave a stale positive count in the map that
// never decrements, eventually preventing that IP from connecting. The normal
// releaseCounter path handles the vast majority of disconnects; this sweep
// corrects any survivors. Runs every 10 minutes, scoped to its own closure so
// it has no references outside this module.
const _sseSweep = setInterval(() => {
  for (const [ip, count] of sseConnectionsPerIp) {
    if (count <= 0) sseConnectionsPerIp.delete(ip);
  }
}, 10 * 60_000);
// unref() so this timer does not prevent the process from exiting gracefully.
(_sseSweep as unknown as { unref?: () => void }).unref?.();

// ── Open-connection registry for graceful shutdown ────────────────────────────
// Each live SSE connection registers a cleanup callback here. During shutdown,
// stopBroadcastV2() calls closeAllSseSessions() which invokes every callback,
// ending the HTTP response streams so clients reconnect cleanly and the main.ts
// drain loop sees sseCounter reach 0 before app.close() is called.
const openSseCleanups = new Set<() => void>();

/**
 * Force-close all open broadcast-v2 SSE connections.
 * Called during graceful shutdown before app.close() so the main.ts drain
 * loop can complete without waiting for the SHUTDOWN_DRAIN_MS timeout.
 */
export function closeAllSseSessions(): void {
  for (const cleanup of openSseCleanups) {
    try { cleanup(); } catch { /* noop */ }
  }
  openSseCleanups.clear();
}

function getSseLimit(): number {
  const val = process.env["MAX_SSE_PER_IP"];
  if (val === undefined || val === "") return 8;
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 ? n : 8;
}

export async function sseRoutes(app: FastifyInstance) {
  app.get("/events", async (req, reply) => {
    const ip = req.ip ?? "unknown";
    const limit = getSseLimit();

    if (limit > 0) {
      const current = sseConnectionsPerIp.get(ip) ?? 0;
      if (current >= limit) {
        return reply
          .status(429)
          .header("Retry-After", "10")
          .send({ error: "Too many SSE connections from this IP. Close existing tabs and retry." });
      }
      sseConnectionsPerIp.set(ip, current + 1);
    }
    activeSseConnections.inc({ surface: "broadcast-v2", ...SERVICE_LABELS });
    // Register with the process-wide SSE drain counter so the shutdown
    // logic in main.ts waits for this connection before calling app.close().
    sseCounter.inc();

    // Register counter cleanup IMMEDIATELY after increment — before any async
    // work (event log replay, etc.) — so a client that disconnects during
    // setup still frees its slot. An idempotent flag prevents double-decrement
    // when the main close handler below also calls releaseCounter().
    let counterReleased = false;
    const releaseCounter = () => {
      if (counterReleased || limit <= 0) return;
      counterReleased = true;
      const prev = sseConnectionsPerIp.get(ip) ?? 1;
      if (prev <= 1) {
        sseConnectionsPerIp.delete(ip);
      } else {
        sseConnectionsPerIp.set(ip, prev - 1);
      }
    };
    req.raw.on("close", releaseCounter);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const lastEventId = req.headers["last-event-id"];
    // Also accept lastSequence as a query param so page reloads (where
    // EventSource has no Last-Event-ID to send automatically) can still
    // replay missed events from the persisted event log.
    const lastSeqQuery =
      req.query &&
      typeof (req.query as Record<string, string>).lastSequence === "string"
        ? Number((req.query as Record<string, string>).lastSequence)
        : 0;
    const lastSeq = lastEventId ? Number(lastEventId) : lastSeqQuery;

    const send = (frame: V2ServerFrame) => {
      try {
        const seq = "sequence" in frame ? frame.sequence : Date.now();
        reply.raw.write(`id: ${seq}\nevent: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
      } catch {
        /* client gone */
      }
    };

    // Initial hello + snapshot (current authoritative state).
    send({ type: "hello", serverTimeMs: Date.now(), sequence: broadcastOrchestrator.getSequence() });
    send({
      type: "snapshot",
      sequence: broadcastOrchestrator.getSequence(),
      state: broadcastOrchestrator.snapshot(),
    });

    // Buffer any real-time frames that arrive while the DB replay is awaiting
    // so the client always receives events in strict order:
    //   snapshot (authoritative) → replay (history) → buffered live → live stream.
    // Without this gate, an orchestrator "frame" event emitted during the async
    // replayFrom call can arrive at the client before the replayed history,
    // causing out-of-order FSM transitions. This mirrors the same pattern used
    // by the WS gateway's `frameQueue` buffer on client "resume" messages.
    const frameQueue: V2ServerFrame[] = [];
    const bufferFrame = (f: V2ServerFrame) => { frameQueue.push(f); };
    broadcastOrchestrator.on("frame", bufferFrame);

    // Replay any events the client missed while disconnected.
    // The EventSource API automatically carries the last `id:` value as
    // `Last-Event-ID` on reconnect so clients don't lose events across
    // brief network drops. We replay up to 500 events from the persistent
    // event log; anything older than what the log retains is covered by
    // the snapshot frame above (which always reflects current state).
    if (lastSeq > 0) {
      try {
        const missed = await eventLogRepo.replayFrom(broadcastOrchestrator.channelId, lastSeq, 500);
        for (const e of missed) {
          send({
            type: "event" as const,
            sequence: e.sequence,
            eventType: e.eventType as V2EventType,
            payload: e.payload,
          });
        }
      } catch (err) {
        // Replay failure is non-fatal — the snapshot above already gives
        // the client authoritative current state. Log so operators can detect
        // if replay failures become frequent (indicates DB performance issues).
        logger.warn(
          { err, channelId: broadcastOrchestrator.channelId, lastSeq },
          "[broadcast-v2] SSE replay failed — client will rely on snapshot for missed events",
        );
      }
    }

    // Switch from the buffer to the live listener, flushing any frames that
    // arrived during the DB replay await so no events are silently dropped.
    const onFrame = (frame: V2ServerFrame) => send(frame);
    broadcastOrchestrator.off("frame", bufferFrame);
    for (const f of frameQueue) send(f);
    broadcastOrchestrator.on("frame", onFrame);

    const heartbeat = setInterval(() => {
      send({ type: "heartbeat", serverTimeMs: Date.now(), sequence: broadcastOrchestrator.getSequence() });
    }, 10_000);
    heartbeat.unref?.();

    // Idempotent cleanup: called on natural client disconnect OR by
    // closeAllSseSessions() during graceful shutdown. The `closed` flag
    // prevents double-decrement of every counter if both paths fire.
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      openSseCleanups.delete(cleanup);
      clearInterval(heartbeat);
      broadcastOrchestrator.off("frame", onFrame);
      // releaseCounter is idempotent — safe even if the early handler
      // fired (e.g. client disconnected during event log replay above).
      releaseCounter();
      sseCounter.dec();
      activeSseConnections.dec({ surface: "broadcast-v2", ...SERVICE_LABELS });
      try {
        reply.raw.end();
      } catch {
        /* noop */
      }
    };

    openSseCleanups.add(cleanup);
    req.raw.on("close", cleanup);
  });
}
