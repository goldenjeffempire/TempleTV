import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  broadcastEngine,
  type BroadcastEvent,
} from "../broadcast/queue.engine.js";
import type { BroadcastItemDto } from "../broadcast/broadcast.schemas.js";
import { overrideBus } from "../live-overrides/override-bus.js";
import type { OverrideBusChange } from "../live-overrides/override-bus.js";
import { signalBus, type OmegaSignal } from "../network/signal-bus.js";
import { adminEventBus } from "../admin-ops/admin-event-bus.js";
import { logger } from "../../infrastructure/logger.js";
import { env } from "../../config/env.js";

// Module-level monotonic counter for library revision bumps.
// Incremented every time adminEventBus fires "videos-library-updated".
// Sent to WS clients so they can bump their local libraryRevision and
// trigger a catalog refetch — closing the mobile gap where EventSource
// is unavailable and the SSE sidecar is silently skipped.
let _libraryRevision = 0;
adminEventBus.on("admin-event", (event: { type: string; data: unknown }) => {
  if (event.type === "videos-library-updated") _libraryRevision += 1;
});

// Cold-start recovery: if the engine is empty (DB was slow at boot), try a
// background reload at most once every 30 s. The current request still receives
// the empty state so it can display a "no content" screen — the next poll or
// WS reconnect will see the freshly-loaded queue.
let lastEmptyReloadAttemptMs = 0;
const EMPTY_RELOAD_DEBOUNCE_MS = 30_000;

function maybeRecoverEmptyEngine(): void {
  const now = Date.now();
  if (now - lastEmptyReloadAttemptMs < EMPTY_RELOAD_DEBOUNCE_MS) return;
  lastEmptyReloadAttemptMs = now;
  broadcastEngine.reload().catch((err) => {
    logger.warn({ err }, "[playback] cold-start engine reload failed");
  });
}

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
  /** HLS URL clients should fall back to when primary playback fails. */
  failoverHlsUrl: z.string().nullable().optional(),
});

type WireItem = z.infer<typeof PlaybackItemSchema>;
type WireState = z.infer<typeof PlaybackStateSchema>;

// Strip the origin from any absolute URL whose path begins with `/api/`, and
// convert S3/CDN-hosted HLS transcoded URLs into the authenticated proxy path.
//
// Background: older database rows store `localVideoUrl` as absolute URLs
// pointing at the production hostname, e.g.
//   https://api.templetv.org.ng/api/uploads/uuid.mp4
//   https://api.templetv.org.ng/api/videos/id/source
//
// Additionally, `hlsMasterUrl` values written before the transcoder was fixed
// may be raw S3/CDN URLs, e.g.
//   https://bucket.s3.us-east-1.amazonaws.com/transcoded/{videoId}/master.m3u8
//   https://cdn.example.com/transcoded/{videoId}/master.m3u8
//
// These must be converted to the authenticated proxy path /api/hls/:videoId/…
// because the S3 bucket is private — a direct client fetch returns 403.
//
// Converting to relative paths means:
//   • In dev: the Vite dev-proxy rewrites `/api/…` → `localhost:5000`
//   • In production: the same API server handles the request directly
function toRelativeApiUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.pathname.startsWith("/api/")) {
      return u.pathname + u.search;
    }
    // Convert any S3/CDN URL pointing to a transcoded HLS asset into the
    // authenticated API proxy path so the private bucket is always reached
    // through the server-side credential chain, not as a direct client fetch.
    // Matches: /transcoded/{videoId}/{rest} in the URL path.
    const m = u.pathname.match(/\/transcoded\/([^/]+)\/(.+)$/);
    if (m) return `/api/hls/${m[1]}/${m[2]}`;
  } catch {
    // `raw` is already a relative path — nothing to strip.
  }
  return raw;
}

// Project a `BroadcastItemDto` (the engine's native format) into the
// `WireItem` shape the new playback gateway speaks. The engine already
// resolves `youtubeId` / `localVideoUrl` for us; we just classify the
// source kind from `videoSource` and pick the correct URL field.
//
// Returns null when the item has no playable URL so callers can skip it
// rather than sending an empty `url` that makes players throw errors.
function projectItem(it: BroadcastItemDto | null): WireItem | null {
  if (!it) return null;
  const startsAtMs = Date.parse(it.startsAt);
  const endsAtMs = Date.parse(it.endsAt);
  // Prefer hlsMasterUrl (HLS) over localVideoUrl (raw MP4) when available.
  // HLS supports adaptive bitrate, mid-stream joining, and reliable seeking —
  // all essential for the live broadcast player. Raw MP4 may fail in-browser
  // without moov-at-start (faststart) and causes black screens when seeking.
  const effectiveLocalUrl = it.hlsMasterUrl || it.localVideoUrl;
  const kind: "hls" | "mp4" | "youtube" =
    it.videoSource === "youtube"
      ? "youtube"
      : it.videoSource === "hls" ||
        it.hlsMasterUrl ||
        (effectiveLocalUrl?.endsWith(".m3u8") ?? false)
      ? "hls"
      : "mp4";

  // For YouTube, callers expect the bare 11-char videoId in `url`.
  // For local/HLS, surface the direct (already-signed if applicable) URL,
  // converting any absolute `https://api.templetv.org.ng/api/…` URL to its
  // relative `/api/…` equivalent so the client always hits the correct host.
  // Guard: return null when neither youtubeId nor localVideoUrl is set so
  // clients never receive an empty url="" that makes HLS.js / <video> throw.
  let url: string;
  if (kind === "youtube") {
    if (!it.youtubeId) return null;
    url = it.youtubeId;
  } else {
    if (!effectiveLocalUrl) return null;
    url = toRelativeApiUrl(effectiveLocalUrl);
  }

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

/**
 * Build the WireState that the TV and admin clients receive via WS or
 * GET /state. When a live override is active we:
 *
 *   1. Synthesise a `current` WireItem from the override's playable source
 *      (YouTube videoId or HLS URL) so the TV's `useLiveSync.projectState()`
 *      can derive `overrideYoutubeId` / `overrideHlsUrl` from
 *      `current.source` — the exact fields it checks when `source === "override"`.
 *
 *   2. Promote the broadcast-queue's current item into `next` so the player
 *      knows what to buffer after the live stream ends.
 *
 *   3. Set `source: "override"` and populate `liveOverride` with the metadata
 *      window the TV uses for countdown/title display.
 *
 * When no override is active we fall through to the normal queue projection.
 */
function buildState(): WireState {
  const now = Date.now();
  const snap = broadcastEngine.snapshot();
  const active = overrideBus.active;

  if (active) {
    // Determine the playable source for the override stream.
    const hasYoutube = Boolean(active.youtubeVideoId);
    const hasHls = Boolean(active.hlsStreamUrl);

    if (hasYoutube || hasHls) {
      const kind: "youtube" | "hls" = hasYoutube ? "youtube" : "hls";
      const url = (hasYoutube ? active.youtubeVideoId : active.hlsStreamUrl)!;

      const startedAtMs = Date.parse(active.startedAt);
      // If the admin didn't set an end time, assume a 4-hour window so the
      // player's progress bar has something reasonable to show.
      const endsAtMs = active.endsAt
        ? Date.parse(active.endsAt)
        : startedAtMs + 4 * 60 * 60 * 1000;
      const durationSecs = Math.max(1, Math.round((endsAtMs - startedAtMs) / 1000));

      const currentOverride: WireItem = {
        id: `override-${active.id}`,
        title: active.title,
        thumbnailUrl: null,
        durationSecs,
        source: { kind, url, expiresAtMs: null },
        startsAtMs: startedAtMs,
        endsAtMs,
      };

      // Promote the broadcast queue into the preload slots so the player
      // can warm the next buffer while the live stream is playing.
      const next = projectItem(snap.current);
      const nextNext = projectItem(snap.next);

      return {
        serverTimeMs: now,
        current: currentOverride,
        next,
        nextNext,
        liveOverride: {
          title: active.title,
          startedAtMs,
          endsAtMs: active.endsAt ? Date.parse(active.endsAt) : null,
        },
        source: "override",
        failoverHlsUrl: snap.failoverHlsUrl ?? null,
      };
    }
  }

  // No active override (or override has no playable source) — serve queue.
  const current = projectItem(snap.current);
  const next = projectItem(snap.next);
  const nextNext = projectItem(snap.upcoming[1] ?? null);
  return {
    serverTimeMs: now,
    current,
    next,
    nextNext,
    liveOverride: null,
    source: current ? "queue" : "empty",
    failoverHlsUrl: snap.failoverHlsUrl ?? null,
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
      // 60/min: called on every TV/mobile (re)connect and cold-start poll.
      // In-memory projection only (no DB) but still rate-limited to prevent
      // a runaway client from hammering the event loop.
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },      schema: {
        tags: ["playback"],
        summary:
          "Current playback snapshot (current/next/nextNext) for the new dual-buffer player",
        response: { 200: PlaybackStateSchema, 429: z.object({ error: z.string() }) },
      },
    },
    async (_req, reply) => {
      reply.header("Cache-Control", "no-cache, no-store, must-revalidate");
      const state = buildState();
      // If the engine is empty (e.g. DB was slow at startup), kick off a
      // background reload so the next request sees real data.
      if (state.source === "empty") maybeRecoverEmptyEngine();
      return state;
    },
  );

  // WebSocket push channel. Mirrors the broadcast engine's event stream
  // (`snapshot`, `preload`, `advance`, `viewer-count`) but reshaped into
  // the `state | preload | ping` envelope the new client expects.
  // Rate-limit the initial WS upgrade (30/min per IP) to prevent exhaustion.
  app.get("/ws", { websocket: true, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, (socket, _req) => {
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
            // Lead time mirrors the engine's BROADCAST_PRELOAD_LEAD_MS env
            // setting — the single source of truth for the preload window.
            leadMs: env.BROADCAST_PRELOAD_LEAD_MS,
            state: buildState(),
          });
          break;
        case "viewer-count":
          // Not part of the playback push contract; ignore.
          break;
      }
    };
    broadcastEngine.on("event", onEvent);

    // Push a fresh state whenever an admin starts or stops a live override.
    // `overrideBus.active` is already updated before this fires, so
    // `buildState()` immediately returns the correct "override" or "queue" state.
    const onOverrideChange = (_change: OverrideBusChange) => {
      send({ type: "state", reason: "override-change", state: buildState() });
    };
    overrideBus.on("change", onOverrideChange);

    // Library-updated push: forward admin video-library events to this WS
    // client as a { type: "library-updated", revision: N } frame. Mobile
    // clients (React Native) cannot open an EventSource and never receive
    // the SSE sidecar's "videos-library-updated" named event. This WS frame
    // fills that gap — useBroadcastSync handles it by bumping libraryRevision
    // so catalog consumers trigger an immediate refetch.
    const onAdminEvent = (event: { type: string; data: unknown }) => {
      if (event.type === "videos-library-updated") {
        send({ type: "library-updated", revision: _libraryRevision });
      }
    };
    adminEventBus.on("admin-event", onAdminEvent);

    // OMEGA Signal Bus: forward typed network signals (PROGRAM_CHANGED,
    // STREAM_FAILED, SYNC_REQUIRED, EMERGENCY_BROADCAST, FAILOVER_ACTIVATED,
    // BROADCAST_LOCKED/UNLOCKED, NODE_HEALTH_CHANGED) to this WS client.
    // The TV's useLiveSync handles them to force a resync or surface an
    // emergency overlay without waiting for the next engine tick.
    const onSignal = (signal: OmegaSignal) => {
      send({ type: "signal", signal });
    };
    signalBus.on("signal", onSignal);

    // Track last pong/message time for zombie detection.
    // Initialised to now so a freshly-opened socket is never immediately killed.
    let lastPongAtMs = Date.now();

    // Heartbeat: app-level JSON ping + native WS-level ping every 25 s.
    //   • JSON ping: TV / mobile clients respond with { type: "ping" } which
    //     resets lastPongAtMs (app-level liveness confirmation).
    //   • socket.ping(): the `ws` library handles the WS protocol pong response
    //     transparently, firing the "pong" event below. OS TCP stack also uses
    //     these to detect dead connections without application involvement.
    //   • Zombie check: if neither native nor app-level pong has arrived in
    //     60 s (≥ 2 missed cycles), the socket is half-open — terminate it so
    //     the dangling event listeners (broadcastEngine, overrideBus, signalBus,
    //     adminEventBus) are freed.
    const heartbeat = setInterval(() => {
      send({ type: "ping", serverTimeMs: Date.now() });
      try { socket.ping(); } catch { /* client already gone */ }

      if (Date.now() - lastPongAtMs > 60_000) {
        logger.warn("[playback/ws] terminating zombie session — no pong for 60 s");
        try { (socket as { terminate?: () => void }).terminate?.(); } catch { /* already closed */ }
      }
    }, 25_000);
    // unref() so this timer does not prevent graceful SIGTERM shutdown if the
    // socket is the last thing keeping the event loop alive.
    heartbeat.unref?.();

    // Native WS pong: fired automatically by the `ws` library when the remote
    // end responds to our socket.ping() frames.
    socket.on("pong", () => {
      lastPongAtMs = Date.now();
    });

    socket.on("message", (raw: Buffer | string) => {
      lastPongAtMs = Date.now(); // any message = live client
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
      overrideBus.off("change", onOverrideChange);
      signalBus.off("signal", onSignal);
      adminEventBus.off("admin-event", onAdminEvent);
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });
}
