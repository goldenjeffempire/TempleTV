/**
 * Playback engine — server-side state builder.
 *
 * Reuses the canonical 3-tier resolver in `routes/broadcast.ts`
 * (`buildBroadcastCurrentPayload`) so we never duplicate the override >
 * schedule > queue precedence logic, and so the broadcast anchor's
 * "TV-station continuity" guarantee carries through unchanged.
 *
 * On top of that snapshot we:
 *   - Resolve `current` / `next` / `nextNext` into ready-to-play URLs (no 302)
 *   - Stamp wall-clock startsAtMs / endsAtMs on every item
 *   - Compute the live-override metadata window
 *   - Cache the resolved bundle for a short TTL so a burst of WS subscribers
 *     after a transition all share the same presigned URLs
 */

import { buildBroadcastCurrentPayload } from "../routes/broadcast";
import { resolvePlaybackSource } from "./signedUrls";
import type { PlaybackItem, PlaybackState } from "./types";

const STATE_CACHE_TTL_MS = 2_000;

let cached: { at: number; state: PlaybackState } | null = null;

interface BroadcastQueueLike {
  id: string;
  title: string;
  thumbnailUrl: string | null;
  durationSecs: number;
  videoSource: string;
  youtubeId: string;
  localVideoUrl: string | null;
}

async function makeItem(
  src: BroadcastQueueLike | null,
  startsAtMs: number,
): Promise<PlaybackItem | null> {
  if (!src) return null;
  const source = await resolvePlaybackSource(src);
  if (!source) return null;
  const durationSecs = Math.max(1, src.durationSecs ?? 0);
  return {
    id: src.id,
    title: src.title,
    thumbnailUrl: src.thumbnailUrl?.length ? src.thumbnailUrl : null,
    durationSecs,
    source,
    startsAtMs,
    endsAtMs: startsAtMs + durationSecs * 1000,
  };
}

/**
 * Build a fresh PlaybackState. Reads from the existing broadcast resolver,
 * resolves every item to a direct source URL, and stamps wall-clock anchors.
 *
 * `force` skips the short-lived cache — used on transition events so the
 * client receives the new lineup immediately.
 */
export async function buildPlaybackState(
  force = false,
): Promise<PlaybackState> {
  const now = Date.now();
  if (!force && cached && now - cached.at < STATE_CACHE_TTL_MS) {
    // Refresh serverTimeMs even on cached returns so clients can keep their
    // skew-correction tight without forcing a rebuild.
    return { ...cached.state, serverTimeMs: now };
  }

  const payload = await buildBroadcastCurrentPayload();

  const currentStartsAtMs =
    typeof payload.itemStartEpochSecs === "number"
      ? payload.itemStartEpochSecs * 1000
      : now;

  const current = await makeItem(
    payload.item as BroadcastQueueLike | null,
    currentStartsAtMs,
  );

  const nextStartsAtMs = current ? current.endsAtMs : now;
  const next = await makeItem(
    payload.nextItem as BroadcastQueueLike | null,
    nextStartsAtMs,
  );

  const nextNextSrc = (payload.upcomingItems?.[1] ?? null) as
    | BroadcastQueueLike
    | null;
  const nextNextStartsAtMs = next ? next.endsAtMs : nextStartsAtMs;
  const nextNext = await makeItem(nextNextSrc, nextNextStartsAtMs);

  const liveOverride = payload.liveOverride
    ? {
        title: payload.liveOverride.title,
        startedAtMs: new Date(payload.liveOverride.startedAt).getTime(),
        endsAtMs: payload.liveOverride.endsAt
          ? new Date(payload.liveOverride.endsAt).getTime()
          : null,
      }
    : null;

  let source: PlaybackState["source"];
  if (payload.liveOverride) source = "override";
  else if (payload.activeSchedule) source = "schedule";
  else if (current) source = "queue";
  else source = "empty";

  const state: PlaybackState = {
    serverTimeMs: now,
    current,
    next,
    nextNext,
    liveOverride,
    source,
  };

  cached = { at: now, state };
  return state;
}

/** Drops the in-process state cache. Call when the queue/schedule changes. */
export function invalidatePlaybackState(): void {
  cached = null;
}
