import { useEffect, useRef, useState } from "react";
import { secureStorage } from "@/lib/secureStorage";
import { getApiBase } from "@/lib/apiBase";

/**
 * Per-device "live YouTube embed failed" signal — mobile twin of
 * `artifacts/tv/src/lib/liveFailureSignal.ts`. See that file for the
 * full design rationale.
 *
 * On mobile the consumers are:
 *   • `app/(tabs)/index.tsx`'s hero iframe (web only) — reports on
 *     iframe `onError` / load watchdog timeout.
 *   • `app/player.tsx` when `isLive=true` and the underlying
 *     `<YoutubePlayer>` fires `onError`.
 *
 * Both surfaces also read the signal: the hero treats `isLive=false` so
 * `showBroadcast` activates and renders the broadcast queue fallback;
 * the player auto-navigates back to home (where the hero now shows the
 * fallback) instead of staring at a broken iframe.
 */

const FAILURE_TTL_MS = 60_000;

interface FailureRecord {
  videoId: string;
  failedAt: number;
}

let current: FailureRecord | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

export type LiveFailureSurface = "mobile-hero" | "mobile-player";

export function reportLiveFailure(
  videoId: string | null | undefined,
  surface: LiveFailureSurface = "mobile-hero",
): void {
  if (!videoId) return;
  current = { videoId, failedAt: Date.now() };
  notify();
  // Fire-and-forget telemetry to the backend — the local fallback already
  // happened, this is bonus intel for the admin Live Control page.
  postFailureReport(videoId, surface).catch(() => {});
}

const DEVICE_ID_STORAGE_KEY = "mobile.liveFailure.deviceId";

let cachedDeviceIdPromise: Promise<string> | null = null;

async function getOrCreateDeviceId(): Promise<string> {
  if (cachedDeviceIdPromise) return cachedDeviceIdPromise;
  cachedDeviceIdPromise = (async () => {
    try {
      const existing = await secureStorage.getItem(DEVICE_ID_STORAGE_KEY);
      if (existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing)) return existing;
      const fresh = generateDeviceId();
      await secureStorage.setItem(DEVICE_ID_STORAGE_KEY, fresh);
      return fresh;
    } catch {
      // Storage unavailable — return an ephemeral ID so the request still
      // aggregates within this process.
      return `mobile-eph-${Math.random().toString(36).slice(2, 12)}-${Date.now().toString(36)}`;
    }
  })();
  return cachedDeviceIdPromise;
}

function generateDeviceId(): string {
  // React Native does not always have crypto.randomUUID — Math.random is
  // fine for an opaque, non-cryptographic device tag.
  return `mobile-${Math.random().toString(36).slice(2, 14)}${Date.now().toString(36)}`;
}

async function postFailureReport(videoId: string, surface: LiveFailureSurface): Promise<void> {
  const base = getApiBase();
  if (!base) return;
  const deviceId = await getOrCreateDeviceId();
  await fetch(`${base}/api/live/report-failure`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId, deviceId, surface }),
  });
}

export function clearLiveFailure(): void {
  if (!current) return;
  current = null;
  notify();
}

export function useLiveFailureFor(videoId: string | null | undefined): boolean {
  const [, setTick] = useState(0);

  useEffect(() => {
    const fn = () => setTick((n) => n + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);

  useEffect(() => {
    if (!current || current.videoId !== videoId) return;
    const elapsed = Date.now() - current.failedAt;
    const remaining = FAILURE_TTL_MS - elapsed;
    if (remaining <= 0) return;
    const t = setTimeout(() => setTick((n) => n + 1), remaining);
    return () => clearTimeout(t);
  }, [videoId, current?.failedAt]);

  if (!current || !videoId) return false;
  if (current.videoId !== videoId) {
    current = null;
    return false;
  }
  return Date.now() - current.failedAt < FAILURE_TTL_MS;
}

/**
 * Edge-triggered hook: returns `true` for `BANNER_VISIBLE_MS` ms after a
 * fresh failure is reported for `videoId`, then auto-flips back to `false`.
 * Used to flash a one-shot fallback banner on the home hero.
 *
 * "Fresh" is keyed by `failedAt` so re-mounting the consumer after the
 * banner already played won't re-flash it.
 */
const BANNER_VISIBLE_MS = 5_000;

export function useLiveFallbackJustTriggered(videoId: string | null | undefined): boolean {
  const [visible, setVisible] = useState(false);
  const lastSeenAtRef = useRef<number | null>(null);

  useEffect(() => {
    const evaluate = () => {
      if (!videoId || !current || current.videoId !== videoId) return;
      if (lastSeenAtRef.current === current.failedAt) return;
      lastSeenAtRef.current = current.failedAt;
      setVisible(true);
      const t = setTimeout(() => setVisible(false), BANNER_VISIBLE_MS);
      return () => clearTimeout(t);
    };
    const cleanup = evaluate();
    const fn = () => evaluate();
    listeners.add(fn);
    return () => {
      if (typeof cleanup === "function") cleanup();
      listeners.delete(fn);
    };
  }, [videoId]);

  return visible;
}
