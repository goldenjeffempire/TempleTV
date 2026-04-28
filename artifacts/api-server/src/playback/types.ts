/**
 * Playback engine — wire types.
 *
 * This module is the public contract between the server playback engine and
 * every client (web admin, TV, mobile). It is intentionally MINIMAL and
 * source-resolved: a client never has to follow a 302, never has to call a
 * second endpoint to "resolve" the actual video URL. Everything needed to
 * play (current + the next two preload candidates) ships in one frame.
 */

export type PlaybackSourceKind = "hls" | "mp4" | "youtube";

export interface PlaybackSource {
  kind: PlaybackSourceKind;
  /**
   * Direct, ready-to-play URL.
   *  - hls    → fully-signed master.m3u8 URL the player can pass straight to HLS.js
   *  - mp4    → fully-signed S3 GET URL (no API hop, no 302)
   *  - youtube→ 11-character YouTube videoId (used by the YouTube player)
   */
  url: string;
  /** When `url` becomes invalid (epoch ms). Null for youtube. */
  expiresAtMs: number | null;
}

export interface PlaybackItem {
  /** Stable id usable as a React key and for telemetry. */
  id: string;
  title: string;
  thumbnailUrl: string | null;
  durationSecs: number;
  source: PlaybackSource;
  /** Wall-clock epoch (ms) when this item is expected to start. */
  startsAtMs: number;
  /** Wall-clock epoch (ms) when this item is expected to end. */
  endsAtMs: number;
}

export interface PlaybackState {
  /** Server's authoritative wall clock, ms. Clients use this to skew-correct. */
  serverTimeMs: number;
  /** Currently on-air item. Null if the lineup is empty. */
  current: PlaybackItem | null;
  /** Next item to air after `current`. Null if there is none. */
  next: PlaybackItem | null;
  /** Item after `next`. Used by the dual-buffer engine for the next-next preload slot. */
  nextNext: PlaybackItem | null;
  /**
   * Live override metadata when an admin has pinned a live source.
   * When set, `current` mirrors the override; clients display "LIVE" chrome.
   */
  liveOverride: {
    title: string;
    startedAtMs: number;
    endsAtMs: number | null;
  } | null;
  /** Diagnostic — why the resolver picked this item (override / schedule / queue). */
  source: "override" | "schedule" | "queue" | "empty";
}

/** Discriminated event union pushed over the WS gateway. */
export type PlaybackEvent =
  | {
      type: "state";
      reason:
        | "subscribe"
        | "queue-updated"
        | "schedule-updated"
        | "override-started"
        | "override-stopped"
        | "transition";
      state: PlaybackState;
    }
  | {
      /**
       * Pre-transition hint emitted by the scheduler at T-15s, T-10s, T-5s.
       * Lets the dual-buffer engine pre-attach the source on the preload
       * surface so the swap at T-0 is frame-accurate. The full state is
       * included so a freshly-connected client can warm immediately even
       * if it missed the most recent `state` frame.
       */
      type: "preload";
      leadMs: 15000 | 10000 | 5000;
      state: PlaybackState;
    }
  | {
      /** Heartbeat — keeps proxies/load-balancers from idle-killing the WS. */
      type: "ping";
      serverTimeMs: number;
    };
