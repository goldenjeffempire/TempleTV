/**
 * Server-side watch history sync for the TV app.
 *
 * Dual-write strategy: localStorage is the primary store (instant, works offline);
 * the server is the secondary store (cross-device continuity, survives localStorage
 * wipe). All server calls are fire-and-forget — they never block the player or UI.
 *
 * The device is identified by the stable UUID in localStorage (getDeviceId).
 * No authentication is required for the TV history endpoint.
 */

import { getDeviceId } from "./deviceId";
import { resolveApiOrigin } from "./api";

function tvHistoryUrl(path = ""): string {
  return `${resolveApiOrigin()}/api/tv/history${path}`;
}

export interface ServerHistoryEntry {
  id: string;
  deviceId: string;
  videoId: string;
  title: string;
  thumbnailUrl: string;
  hlsUrl: string | null;
  positionSecs: number;
  durationSecs: number;
  completed: boolean;
  watchedAt: string;
}

/**
 * Fire-and-forget upsert. Called every ~5 s during playback and on completion.
 * Never throws — network failures are silently swallowed.
 */
export function syncProgressToServer(entry: {
  videoId: string;
  title: string;
  thumbnailUrl: string;
  hlsUrl: string | null;
  positionSecs: number;
  durationSecs: number;
  completed: boolean;
  watchedAt?: number;
}): void {
  const deviceId = getDeviceId();
  const body = JSON.stringify({
    deviceId,
    videoId: entry.videoId,
    title: entry.title,
    thumbnailUrl: entry.thumbnailUrl,
    hlsUrl: entry.hlsUrl ?? null,
    positionSecs: Math.floor(entry.positionSecs),
    durationSecs: Math.floor(entry.durationSecs),
    completed: entry.completed,
    watchedAt: entry.watchedAt
      ? new Date(entry.watchedAt).toISOString()
      : new Date().toISOString(),
  });

  fetch(tvHistoryUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(8000),
  }).catch(() => {
    /* fire-and-forget — network failures are expected on embedded TVs */
  });
}

/**
 * Fetch the server-side watch history for this device and return it sorted
 * newest-first. Called on app startup to hydrate localStorage from the server
 * (covers devices where localStorage was wiped or the user moved to a new TV).
 *
 * Returns [] on any error so callers can always use the result safely.
 */
export async function fetchHistoryFromServer(): Promise<ServerHistoryEntry[]> {
  const deviceId = getDeviceId();
  try {
    const res = await fetch(tvHistoryUrl(`/${encodeURIComponent(deviceId)}`), {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as ServerHistoryEntry[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/**
 * Delete all server-side history for this device.
 * Fire-and-forget — called when the user clears history locally.
 */
export function clearServerHistory(): void {
  const deviceId = getDeviceId();
  fetch(tvHistoryUrl(`/${encodeURIComponent(deviceId)}`), {
    method: "DELETE",
    signal: AbortSignal.timeout(8000),
  }).catch(() => {});
}
