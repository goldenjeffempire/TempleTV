/**
 * Mirror of the server `PlaybackEvent` / `PlaybackState` types.
 *
 * Kept in lockstep manually rather than codegen'd because (a) we want the
 * admin SPA to compile even if the codegen step is broken / pending, and
 * (b) this contract is small and stable. If you change a field on the
 * server, change it here too — the discriminated unions on both sides will
 * surface the mismatch as a type error in the next typecheck.
 */

export type PlaybackSourceKind = "hls" | "mp4" | "youtube";

export interface PlaybackSource {
  kind: PlaybackSourceKind;
  url: string;
  expiresAtMs: number | null;
}

export interface PlaybackItem {
  id: string;
  title: string;
  thumbnailUrl: string | null;
  durationSecs: number;
  source: PlaybackSource;
  startsAtMs: number;
  endsAtMs: number;
}

export interface PlaybackState {
  serverTimeMs: number;
  current: PlaybackItem | null;
  next: PlaybackItem | null;
  nextNext: PlaybackItem | null;
  liveOverride: {
    title: string;
    startedAtMs: number;
    endsAtMs: number | null;
  } | null;
  source: "override" | "schedule" | "queue" | "empty";
}

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
      type: "preload";
      leadMs: 15000 | 10000 | 5000;
      state: PlaybackState;
    }
  | {
      type: "ping";
      serverTimeMs: number;
    };

export type PlaybackConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline";
