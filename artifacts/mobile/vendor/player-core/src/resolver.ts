import type { V2Source } from "./types.js";

/**
 * Client-side source classifier. The server already produces the v2 source
 * with `kind` populated, so the only thing the client decides is which
 * playback strategy to use (native HLS vs hls.js, native vs YouTube iframe).
 */

export interface ClientCapabilities {
  /** True if the platform plays `application/vnd.apple.mpegurl` natively. */
  nativeHls: boolean;
  /** True if the platform supports MSE (needed for hls.js / dash.js). */
  mse: boolean;
  /** True if running in React Native (no DOM). */
  reactNative: boolean;
}

export type PlaybackStrategy =
  | "native-hls"
  | "hlsjs"
  | "dash"
  | "html5-video"
  | "youtube-iframe"
  | "expo-video"
  | "youtube-embed-rn";

export function detectCapabilitiesWeb(): ClientCapabilities {
  if (typeof document === "undefined") {
    return { nativeHls: false, mse: false, reactNative: true };
  }
  const v = document.createElement("video");
  return {
    nativeHls: v.canPlayType("application/vnd.apple.mpegurl") !== "",
    mse: typeof (globalThis as { MediaSource?: unknown }).MediaSource !== "undefined",
    reactNative: false,
  };
}

export function pickStrategy(source: V2Source, caps: ClientCapabilities): PlaybackStrategy {
  if (caps.reactNative) {
    if (source.kind === "youtube") return "youtube-embed-rn";
    return "expo-video";
  }
  switch (source.kind) {
    case "youtube":
      return "youtube-iframe";
    case "dash":
      return caps.mse ? "dash" : "html5-video";
    case "hls":
      if (caps.nativeHls) return "native-hls";
      return caps.mse ? "hlsjs" : "html5-video";
    case "mp4":
    default:
      return "html5-video";
  }
}
