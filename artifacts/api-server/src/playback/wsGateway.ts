/**
 * Playback WebSocket gateway.
 *
 * Mounts a `ws.Server` in `noServer` mode and is plugged into the existing
 * `http.Server` instance via the `upgrade` event in `index.ts`. We don't
 * spin up a separate listener — sharing the API port keeps CORS, mTLS,
 * proxy rules, and Render's port allocation aligned across HTTP and WS.
 *
 * Per-client behaviour:
 *   1. On open, immediately send a `state` frame with `reason: "subscribe"`
 *      so the client paints without a round-trip.
 *   2. Subscribe the socket to the playback bus; every published event is
 *      JSON-encoded and pushed.
 *   3. A 25s ping/pong heartbeat detects dead clients and bounds idle-kill
 *      windows on intermediaries (Render LB drops idle WS at 60s by default).
 *   4. On any error or close, unsubscribe and clean up timers.
 *
 * Capacity is bounded by `MAX_PLAYBACK_WS_CLIENTS` (default 5000, overridable
 * via env). Above that we close incoming sockets with code 1013 (Try Again
 * Later) and a Retry-After hint in the close reason.
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { logger } from "../lib/logger";
import { getPlaybackBus } from "./eventBus";
import { buildPlaybackState } from "./playbackEngine";
import type { PlaybackEvent } from "./types";

const MAX_CLIENTS = Math.max(
  16,
  Number(process.env.MAX_PLAYBACK_WS_CLIENTS ?? "5000"),
);

const HEARTBEAT_MS = 25_000;
const PATH = "/api/playback/ws";

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
let connectedCount = 0;

function safeSend(ws: WebSocket, frame: PlaybackEvent): void {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(frame));
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "playback.ws send failed (client likely gone)",
    );
  }
}

wss.on("connection", (ws: WebSocket) => {
  connectedCount += 1;
  let alive = true;

  // 1. Initial state frame so the client paints without a REST round-trip.
  buildPlaybackState()
    .then((state) =>
      safeSend(ws, { type: "state", reason: "subscribe", state }),
    )
    .catch((err) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "playback.ws initial-state send failed",
      );
    });

  // 2. Bus subscription. Captured for cleanup in close().
  const unsub = getPlaybackBus().subscribe((event) => safeSend(ws, event));

  // 3. Ping/pong heartbeat.
  const heartbeat = setInterval(() => {
    if (!alive) {
      try { ws.terminate(); } catch { /* noop */ }
      return;
    }
    alive = false;
    try {
      ws.ping();
    } catch { /* noop */ }
    safeSend(ws, { type: "ping", serverTimeMs: Date.now() });
  }, HEARTBEAT_MS);
  heartbeat.unref();

  ws.on("pong", () => {
    alive = true;
  });

  ws.on("error", (err) => {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "playback.ws client error",
    );
  });

  ws.on("close", () => {
    clearInterval(heartbeat);
    unsub();
    connectedCount -= 1;
  });
});

/**
 * Register the WS server with an existing http.Server. Only handles upgrades
 * for the `/api/playback/ws` path so the rest of the server's HTTP routes
 * (and any future WS endpoints) are unaffected.
 */
export function attachPlaybackWs(server: import("node:http").Server): void {
  server.on(
    "upgrade",
    (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = req.url ?? "";
      const pathOnly = url.split("?")[0];
      if (pathOnly !== PATH) return;

      if (connectedCount >= MAX_CLIENTS) {
        try {
          socket.write(
            "HTTP/1.1 503 Service Unavailable\r\n" +
              "Retry-After: 30\r\n" +
              "Content-Length: 0\r\n" +
              "Connection: close\r\n\r\n",
          );
          socket.destroy();
        } catch { /* noop */ }
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    },
  );
  logger.info(
    { path: PATH, maxClients: MAX_CLIENTS },
    "Playback WebSocket gateway mounted",
  );
}

export function getPlaybackWsStats(): { connected: number; max: number } {
  return { connected: connectedCount, max: MAX_CLIENTS };
}
