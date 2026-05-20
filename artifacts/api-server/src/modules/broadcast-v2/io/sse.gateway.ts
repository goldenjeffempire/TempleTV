import type { FastifyInstance } from "fastify";
import { broadcastOrchestrator } from "../engine/broadcast-orchestrator.js";
import { eventLogRepo } from "../repository/event-log.repo.js";
import type { V2EventType, V2ServerFrame } from "../domain/types.js";
import { activeSseConnections, SERVICE_LABELS } from "../../../infrastructure/metrics.js";

/**
 * Per-IP SSE connection counter. Prevents a single client or runaway browser
 * tab loop from exhausting server file descriptors. The limit is read from the
 * MAX_SSE_PER_IP environment variable (default: 8). Set to 0 to disable.
 */
const sseConnectionsPerIp = new Map<string, number>();

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

    // Replay any events the client missed while disconnected.
    // The EventSource API automatically carries the last `id:` value as
    // `Last-Event-ID` on reconnect so clients don't lose events across
    // brief network drops. We replay up to 200 events from the persistent
    // event log; anything older than what the log retains is covered by
    // the snapshot frame above (which always reflects current state).
    if (lastSeq > 0) {
      try {
        const missed = await eventLogRepo.replayFrom(broadcastOrchestrator.channelId, lastSeq, 200);
        for (const e of missed) {
          send({
            type: "event" as const,
            sequence: e.sequence,
            eventType: e.eventType as V2EventType,
            payload: e.payload,
          });
        }
      } catch {
        // Replay failure is non-fatal — the snapshot above already gives
        // the client authoritative current state.
      }
    }

    const onFrame = (frame: V2ServerFrame) => send(frame);
    broadcastOrchestrator.on("frame", onFrame);

    const heartbeat = setInterval(() => {
      send({ type: "heartbeat", serverTimeMs: Date.now(), sequence: broadcastOrchestrator.getSequence() });
    }, 10_000);
    heartbeat.unref?.();

    req.raw.on("close", () => {
      clearInterval(heartbeat);
      broadcastOrchestrator.off("frame", onFrame);
      // releaseCounter is idempotent — safe even if the early handler already
      // fired (e.g. client disconnected during event log replay above).
      releaseCounter();
      activeSseConnections.dec({ surface: "broadcast-v2", ...SERVICE_LABELS });
      try {
        reply.raw.end();
      } catch {
        /* noop */
      }
    });
  });
}
