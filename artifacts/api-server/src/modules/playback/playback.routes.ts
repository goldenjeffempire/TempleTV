import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  broadcastEngine,
  type BroadcastEvent,
} from "../broadcast/queue.engine.js";
import type { BroadcastItemDto } from "../broadcast/broadcast.schemas.js";

// ── Wire types ────────────────────────────────────────────────────────────
// The TV bundle (`artifacts/tv/src/hooks/useLiveSync.ts`) and admin
// playback engine duplicate this shape on the client side. Keep field
// names + nullability stable — drift here is an instant runtime break
// on cold-launched smart-TV runtimes that can't be hot-patched.

const PlaybackSourceSchema = z.object({
  kind: z.enum(["hls", "mp4", "youtube"]),
  url: z.string(),
  expiresAtMs: z.number().nullable(),
});

const PlaybackItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  thumbnailUrl: z.string().nullable(),
  durationSecs: z.number().int().positive(),
  source: PlaybackSourceSchema,
  startsAtMs: z.number(),
  endsAtMs: z.number(),
});

const PlaybackStateSchema = z.object({
  serverTimeMs: z.number(),
  current: PlaybackItemSchema.nullable(),
  next: PlaybackItemSchema.nullable(),
  nextNext: PlaybackItemSchema.nullable(),
  liveOverride: z
    .object({
      title: z.string(),
      startedAtMs: z.number(),
      endsAtMs: z.number().nullable(),
    })
    .nullable(),
  source: z.enum(["override", "schedule", "queue", "empty"]),
});

type WireItem = z.infer<typeof PlaybackItemSchema>;
type WireState = z.infer<typeof PlaybackStateSchema>;

// Project a `BroadcastItemDto` (the engine's native format) into the
// `WireItem` shape the new playback gateway speaks. The engine already
// resolves `youtubeId` / `localVideoUrl` for us; we just classify the
// source kind from `videoSource` and pick the correct URL field.
function projectItem(it: BroadcastItemDto | null): WireItem | null {
  if (!it) return null;
  const startsAtMs = Date.parse(it.startsAt);
  const endsAtMs = Date.parse(it.endsAt);
  const kind: "hls" | "mp4" | "youtube" =
    it.videoSource === "youtube"
      ? "youtube"
      : it.videoSource === "hls" ||
        (it.localVideoUrl?.endsWith(".m3u8") ?? false)
      ? "hls"
      : "mp4";
  // For YouTube, callers expect the bare 11-char videoId in `url`.
  // For local/HLS, surface the direct (already-signed if applicable) URL.
  const url =
    kind === "youtube"
      ? it.youtubeId
      : it.localVideoUrl ?? "";
  return {
    id: it.id,
    title: it.title,
    thumbnailUrl: it.thumbnailUrl || null,
    durationSecs: it.durationSecs,
    source: { kind, url, expiresAtMs: null },
    startsAtMs,
    endsAtMs,
  };
}

function buildState(): WireState {
  const snap = broadcastEngine.snapshot();
  const current = projectItem(snap.current);
  const next = projectItem(snap.next);
  const nextNext = projectItem(snap.upcoming[1] ?? null);
  return {
    serverTimeMs: Date.now(),
    current,
    next,
    nextNext,
    // The new server doesn't yet emit override events through the
    // broadcast engine — overrides live in the `live-overrides` module
    // and are surfaced separately by the admin Live Control panel. The
    // playback gateway therefore reports `null` here; the TV's
    // `useUnifiedLive` falls back to its own resolver in that case.
    liveOverride: null,
    source: current ? "queue" : "empty",
  };
}

export async function playbackRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // Snapshot endpoint — what the TV/admin reach for on (re)connect, and
  // the dual-buffer player polls on cold-start. Cheap: just projects
  // the in-memory broadcast engine state, no DB hit.
  r.get(
    "/state",
    {
      schema: {
        tags: ["playback"],
        summary:
          "Current playback snapshot (current/next/nextNext) for the new dual-buffer player",
        response: { 200: PlaybackStateSchema },
      },
    },
    async () => buildState(),
  );

  // WebSocket push channel. Mirrors the broadcast engine's event stream
  // (`snapshot`, `preload`, `advance`, `viewer-count`) but reshaped into
  // the `state | preload | ping` envelope the new client expects.
  app.get("/ws", { websocket: true }, (socket, _req) => {
    const send = (msg: unknown) => {
      try {
        socket.send(JSON.stringify(msg));
      } catch {
        /* socket already closed; cleanup runs in the close handler */
      }
    };

    // Initial snapshot on connect — clients use this to seed their
    // dual-buffer pipeline before any change events arrive.
    send({ type: "state", reason: "initial", state: buildState() });

    const onEvent = (e: BroadcastEvent) => {
      switch (e.type) {
        case "snapshot":
          send({ type: "state", reason: "snapshot", state: buildState() });
          break;
        case "advance":
          send({ type: "state", reason: "advance", state: buildState() });
          break;
        case "preload":
          send({
            type: "preload",
            // Lead time matches the engine's BROADCAST_PRELOAD_LEAD_MS
            // setting; clients use it to start fetching the next buffer.
            leadMs: 15_000,
            state: buildState(),
          });
          break;
        case "viewer-count":
          // Not part of the playback push contract; ignore.
          break;
      }
    };
    broadcastEngine.on("event", onEvent);

    // Heartbeat so smart-TV / mobile NATs don't drop the socket.
    const heartbeat = setInterval(() => {
      send({ type: "ping", serverTimeMs: Date.now() });
    }, 25_000);

    socket.on("message", (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type?: string };
        if (msg.type === "ping") {
          send({ type: "ping", serverTimeMs: Date.now() });
        }
      } catch {
        /* ignore malformed */
      }
    });

    const cleanup = () => {
      clearInterval(heartbeat);
      broadcastEngine.off("event", onEvent);
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });
}
