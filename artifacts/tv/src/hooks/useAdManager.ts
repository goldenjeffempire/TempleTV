/**
 * useAdManager — React hook that manages the Google IMA HTML5 SDK lifecycle
 * for the Temple TV Smart TV broadcast surface.
 *
 * Usage:
 *   const { adContainerRef, isAdActive } = useAdManager({ videoRefA, videoRefB, variant });
 *
 * Behaviour:
 *   • Creates and initializes an AdManager instance once per mount.
 *   • Fires the first ad request when the broadcast enters PLAYING state
 *     (i.e. once the live stream is actually running) to maximize preroll
 *     fill rate — the SDK loads the ad in the background and plays it as
 *     soon as it's ready.
 *   • While an ad is active, sets `isAdActive = true` so the parent can
 *     show the ad container and visually suppress any conflicting overlays.
 *   • Mutes the A and B video buffers during ad playback (via muteVolume)
 *     and restores their volume when the ad break ends. This avoids
 *     interfering with the broadcast FSM (no pause/play calls).
 *   • Cleans up the AdManager on component unmount.
 *   • Only runs in the "player" variant — the "hero" background variant is
 *     an ambient preview and should never play ads.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AdManager } from "../lib/adManager";
import type { AdManagerCallbacks } from "../lib/adManager";

// ── Env configuration ────────────────────────────────────────────────────────
// Set VITE_IMA_AD_TAG_URL in .env (or as a Replit secret) to a GAM VMAP URL.
// Leave unset (or empty) to disable all ads — the hook becomes a no-op.
//
// Example VMAP ad tag URL (replace NETWORK_CODE and AD_UNIT_PATH):
//   https://pubads.g.doubleclick.net/gampad/ads?iu=/NETWORK_CODE/AD_UNIT_PATH
//     &sz=640x480&ciu_szs=300x250&ad_type=both&output=vmap
//     &unviewed_position_start=1&env=vp&impl=s&correlator=
//
// Google sample VMAP tags for testing:
//   https://developers.google.com/interactive-media-ads/docs/sdks/html5/tags
const IMA_AD_TAG_URL = import.meta.env.VITE_IMA_AD_TAG_URL ?? "";

interface UseAdManagerOptions {
  /** Ref to the A-slot live video element (primary HLS buffer). */
  videoRefA: React.RefObject<HTMLVideoElement | null>;
  /** Ref to the B-slot live video element (secondary HLS buffer). */
  videoRefB: React.RefObject<HTMLVideoElement | null>;
  /** Component variant — ads only run in the "player" variant. */
  variant: "player" | "hero";
  /**
   * Current broadcast FSM state. The hook fires the first ad request once
   * the broadcast enters "PLAYING" state so prerolls load against a live stream.
   */
  broadcastState?: string;
}

interface UseAdManagerResult {
  /** Attach this ref to the ad container div in JSX. */
  adContainerRef: React.RefCallback<HTMLDivElement>;
  /** True while a linear ad is playing — use to show the ad container. */
  isAdActive: boolean;
}

export function useAdManager({
  videoRefA,
  videoRefB,
  variant,
  broadcastState,
}: UseAdManagerOptions): UseAdManagerResult {
  const [isAdActive, setIsAdActive] = useState(false);
  const adContainerElRef = useRef<HTMLDivElement | null>(null);
  const adManagerRef = useRef<AdManager | null>(null);
  const adsRequestedRef = useRef(false);
  const hasReachedPlayingRef = useRef(false);

  // Stable ref callbacks so the ad container's DOM element is captured even
  // when it mounts after the hook initialises.
  const adContainerRef = useCallback((el: HTMLDivElement | null) => {
    adContainerElRef.current = el;
  }, []);

  // ── Mute helpers ──────────────────────────────────────────────────────────
  // We mute/unmute the live video buffers during ad playback rather than
  // pausing them. This keeps the broadcast FSM undisturbed while the ad
  // plays its own audio through the IMA SDK's internal video element.
  const muteBuffers = useCallback(() => {
    if (videoRefA.current) videoRefA.current.muted = true;
    if (videoRefB.current) videoRefB.current.muted = true;
  }, [videoRefA, videoRefB]);

  const unmuteActiveBuffer = useCallback(() => {
    // Only unmute the visually active buffer (opacity: 1). The inactive
    // buffer stays muted — it's always muted per the A/B buffer design.
    if (videoRefA.current && videoRefA.current.style.opacity !== "0") {
      videoRefA.current.muted = false;
    } else if (videoRefB.current && videoRefB.current.style.opacity !== "0") {
      videoRefB.current.muted = false;
    } else {
      // Fallback: unmute A if we can't determine which is active.
      if (videoRefA.current) videoRefA.current.muted = false;
    }
  }, [videoRefA, videoRefB]);

  // ── AdManager lifecycle ───────────────────────────────────────────────────
  useEffect(() => {
    // Skip the "hero" background variant — it's an ambient preview and
    // should never interrupt the user with ads.
    if (variant !== "player") return;

    // Skip if IMA is not configured.
    if (!IMA_AD_TAG_URL) return;

    // Delay init until the ad container div is in the DOM. Poll with rAF to
    // avoid flaky timing when the hook fires before the first paint.
    let rafHandle: number | null = null;
    let destroyed = false;

    const tryInit = () => {
      if (destroyed) return;

      const container = adContainerElRef.current;
      if (!container) {
        // Container not yet mounted — retry on the next frame.
        rafHandle = requestAnimationFrame(tryInit);
        return;
      }

      const callbacks: AdManagerCallbacks = {
        onContentPauseRequested: () => {
          setIsAdActive(true);
          muteBuffers();
        },
        onContentResumeRequested: () => {
          setIsAdActive(false);
          unmuteActiveBuffer();
        },
        onAdError: (_code, _message) => {
          // Always resume content on error — never leave the broadcast muted.
          setIsAdActive(false);
          unmuteActiveBuffer();
        },
        onAdStarted: () => {
          // Nothing extra needed — isAdActive is already set by
          // onContentPauseRequested which fires just before this.
        },
        onAllAdsCompleted: () => {
          setIsAdActive(false);
          unmuteActiveBuffer();
        },
      };

      const manager = new AdManager({
        adTagUrl: IMA_AD_TAG_URL,
        adContainer: container,
        videoElement: videoRefA.current,
        callbacks,
      });

      manager.init();
      adManagerRef.current = manager;
    };

    rafHandle = requestAnimationFrame(tryInit);

    // Handle window resize to keep ad rendering pixel-perfect.
    const onResize = () => {
      adManagerRef.current?.resize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener("resize", onResize, { passive: true });

    return () => {
      destroyed = true;
      if (rafHandle !== null) cancelAnimationFrame(rafHandle);
      window.removeEventListener("resize", onResize);
      adManagerRef.current?.destroy();
      adManagerRef.current = null;
      adsRequestedRef.current = false;
      hasReachedPlayingRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant]);

  // ── Ad request trigger ────────────────────────────────────────────────────
  // Fire the VMAP request once the broadcast is in PLAYING state. Waiting for
  // PLAYING ensures the live stream is established before the preroll tries to
  // load, which avoids a race where the SDK requests an ad before the video
  // element is bound to the live manifest.
  useEffect(() => {
    if (variant !== "player") return;
    if (!IMA_AD_TAG_URL) return;
    if (adsRequestedRef.current) return;

    if (broadcastState === "PLAYING") {
      hasReachedPlayingRef.current = true;
    }

    if (!hasReachedPlayingRef.current) return;

    const manager = adManagerRef.current;
    if (!manager) return;

    adsRequestedRef.current = true;
    manager.requestAds();
  }, [variant, broadcastState]);

  return { adContainerRef, isAdActive };
}
