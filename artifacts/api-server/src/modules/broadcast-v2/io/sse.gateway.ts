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

    // Forward reference: cleanup() is defined after the async event-log
    // replay gap. Stored here so send() can trigger teardown when it detects
    // sustained write backpressure on a zombie/slow client.
    let cleanupRef: (() => void) | null = null;

    // Track consecutive write() → false returns (TCP send-buffer full).
    // After WRITE_STALL_MAX consecutive false returns — each separated by at
    // least one heartbeat interval (10 s) — the client is not draining its
    // receive buffer. We close the connection proactively to free the in-kernel
    // send buffer before it grows large enough to OOM the Node.js process.
    // A single false is normal on a momentary network blip; only sustained
    // stalls warrant closure.
    const WRITE_STALL_MAX = 3;
    let writeStallCount = 0;

    const send = (frame: V2ServerFrame) => {
      try {
        const seq = "sequence" in frame ? frame.sequence : Date.now();
        const ok = reply.raw.write(`id: ${seq}\nevent: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
        if (ok) {
          writeStallCount = 0; // buffer drained — reset stall counter
        } else {
          writeStallCount++;
          if (writeStallCount >= WRITE_STALL_MAX && cleanupRef) {
            // Sustained backpressure: client is not reading. Close now so the
            // kernel TCP send buffer is freed before it consumes Node RSS.
            logger.warn(
              { ip, stallCount: writeStallCount },
              "[broadcast-v2] SSE client stalled — closing zombie connection",
            );
            cleanupRef();
          }
        }
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
    //
    // Cap: a slow DB query under burst activity could accumulate many live frames
    // before replay completes. We keep only the last 500 — older ones are
    // superseded by the snapshot sent above, so dropping the oldest is safe.
    const FRAME_QUEUE_MAX = 500;
    const frameQueue: V2ServerFrame[] = [];
    const bufferFrame = (f: V2ServerFrame) => {
      if (frameQueue.length >= FRAME_QUEUE_MAX) frameQueue.shift();
      frameQueue.push(f);
    };
    broadcastOrchestrator.on("frame", bufferFrame);

    // Early-disconnect sentinel: if the client closes the connection DURING the
    // async replayFrom call below, the `close` event fires before `cleanup()`
    // is registered further down. Without this sentinel we would leak both the
    // `onFrame` listener and the `heartbeat` interval into the orchestrator for
    // the entire lifetime of the process. The `aborted` flag lets us detect this
    // race after the await and perform an inline teardown instead.
    let aborted = false;
    const markAborted = () => { aborted = true; };
    req.raw.once("close", markAborted);

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

    // Remove the early-disconnect sentinel: from this point the full cleanup()
    // function registered below takes ownership of connection teardown.
    req.raw.off("close", markAborted);

    // Switch from the buffer to the live listener, flushing any frames that
    // arrived during the DB replay await so no events are silently dropped.
    const onFrame = (frame: V2ServerFrame) => send(frame);
    broadcastOrchestrator.off("frame", bufferFrame);
    for (const f of frameQueue) send(f);
    broadcastOrchestrator.on("frame", onFrame);

    // Guard: if the client disconnected during the async replay phase, `req.raw`
    // is already destroyed. The `close` event already fired (setting `aborted`)
    // before `cleanup()` existed. Perform an inline teardown here so neither
    // `onFrame` nor the heartbeat interval are registered against a dead stream.
    if (aborted) {
      broadcastOrchestrator.off("frame", onFrame);
      releaseCounter();
      sseCounter.dec();
      activeSseConnections.dec({ surface: "broadcast-v2", ...SERVICE_LABELS });
      return;
    }

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

    // Wire the forward reference so send() can call cleanup() when it detects
    // sustained TCP backpressure from a zombie / slow-reading client.
    cleanupRef = cleanup;

    openSseCleanups.add(cleanup);
    req.raw.on("close", cleanup);

    // Narrow-race guard: `markAborted` was removed from req.raw at line 189,
    // so a "close" event that fires AFTER the `aborted` check above (line 202)
    // but BEFORE `req.raw.on("close", cleanup)` above cannot set `aborted` and
    // would therefore leave `heartbeat` + `onFrame` registered against a dead
    // socket. Checking `req.raw.destroyed` here — which is set synchronously by
    // Node when the socket closes — catches that window and performs a safe
    // inline teardown via the now-registered `cleanup()`.
    if (req.raw.destroyed) {
      cleanup();
      return;
    }
  });
}
