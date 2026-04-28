/**
 * Playback REST surface.
 *
 * Exactly ONE endpoint, intentionally:
 *
 *   GET /api/playback/state
 *     Returns a complete PlaybackState (current + next + nextNext, each with
 *     a direct, ready-to-play source URL — no 302, no second hop). Used by
 *     clients ONLY for the initial paint and for resync after a WS
 *     disconnect; steady-state updates flow over the WebSocket gateway at
 *     `/api/playback/ws`.
 *
 * The legacy polling endpoints (`/broadcast/current`, `/broadcast/events`)
 * are deleted. The new contract is push-first.
 */

import { Router } from "express";
import { buildPlaybackState } from "../playback/playbackEngine";
import { getPlaybackWsStats } from "../playback/wsGateway";

const router: ReturnType<typeof Router> = Router();

router.get("/playback/state", async (_req, res) => {
  try {
    const state = await buildPlaybackState();
    // Short shared-cache window absorbs subscriber bursts after a transition
    // (every WS client also re-pulls on reconnect). The TTL matches the
    // engine's internal cache so the round-trip path is ~free.
    res.setHeader("Cache-Control", "public, max-age=0, s-maxage=2");
    res.json(state);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.get("/playback/diagnostics", (_req, res) => {
  res.json({
    ws: getPlaybackWsStats(),
  });
});

export default router;
