import type { BufferOptions } from "expo-video";

/**
 * Per-player media allocation target, not a total process/decoder memory cap.
 * Both broadcast slots need this policy: a hidden preloader still owns a buffer.
 * Prefer the byte target over filling the entire time window on high-bitrate
 * sources. Keep the usual 20-second window and 2-second playback threshold.
 */
export const ANDROID_VIDEO_BUFFER_OPTIONS = {
  preferredForwardBufferDuration: 20,
  minBufferForPlayback: 2,
  maxBufferBytes: 24 * 1024 * 1024,
  prioritizeTimeOverSizeThreshold: false,
} satisfies BufferOptions;
