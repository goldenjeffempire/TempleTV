/**
 * InterstitialAdController — app-level interstitial + rewarded-interstitial
 * ad orchestration for Temple TV.
 *
 * Mounted once at the root layout (inside PlayerProvider, alongside
 * AppOpenAdController). Manages:
 *   • Preloading interstitial and rewarded-interstitial ads in the background.
 *   • Exposing `showInterstitial()` via InterstitialAdContext so any screen can
 *     request an ad at a safe navigation moment.
 *   • Self-enforced policy: ads are NEVER shown when live broadcast is active,
 *     when the app is backgrounded, or when the frequency cap has been reached.
 *
 * Integration pattern (consumer):
 *   ```tsx
 *   const { showInterstitial } = useInterstitialAdContext();
 *   // Call after video ends, before navigating away from a completed VOD:
 *   showInterstitial(); // returns true if shown, false if suppressed
 *   ```
 *
 * Why the Inner/Outer split:
 *   React's rules of hooks prohibit conditional hook calls. Because this
 *   component must work even if PlayerContext is somehow absent, the context
 *   read is isolated in `InterstitialAdInner` which only mounts when the
 *   context is known to be present (this component is always placed inside
 *   PlayerProvider in the layout tree). The outer shell just provides the
 *   context to children unconditionally.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useRef,
} from "react";
import { usePlayer } from "@/context/PlayerContext";
import { useInterstitialAd } from "./useInterstitialAd";
import { useRewardedInterstitialAd } from "./useRewardedInterstitialAd";

// ── Context ───────────────────────────────────────────────────────────────────

interface InterstitialAdContextValue {
  /**
   * Request to show an interstitial ad at the current moment.
   * Returns true if the ad was displayed, false if suppressed (playback active,
   * frequency cap, not loaded, backgrounded, consent required, etc.).
   * Never throws.
   */
  showInterstitial: () => boolean;

  /**
   * Request to show a rewarded interstitial ad.
   * Returns true if the ad was displayed.
   */
  showRewardedInterstitial: () => boolean;

  /** True when an interstitial ad is preloaded and ready to show. */
  isInterstitialReady: boolean;
}

const InterstitialAdContext = createContext<InterstitialAdContextValue>({
  showInterstitial: () => false,
  showRewardedInterstitial: () => false,
  isInterstitialReady: false,
});

export function useInterstitialAdContext(): InterstitialAdContextValue {
  return useContext(InterstitialAdContext);
}

// ── Inner component — reads PlayerContext (hooks called unconditionally) ───────

interface InnerProps {
  children?: React.ReactNode;
}

function InterstitialAdInner({ children }: InnerProps): React.ReactElement {
  // usePlayer() is safe here because InterstitialAdController always sits
  // inside <PlayerProvider> in the root layout.
  const { isPlaying: isLivePlaying } = usePlayer();

  const { isLoaded: isInterstitialReady, show: showInterstitialAd } =
    useInterstitialAd({ isPlaybackActive: isLivePlaying });

  const { show: showRewardedInterstitialAd } = useRewardedInterstitialAd({
    isPlaybackActive: isLivePlaying,
  });

  // Stable refs so context callbacks never change identity on re-render.
  const showInterstitialRef = useRef(showInterstitialAd);
  showInterstitialRef.current = showInterstitialAd;

  const showRewardedInterstitialRef = useRef(showRewardedInterstitialAd);
  showRewardedInterstitialRef.current = showRewardedInterstitialAd;

  const showInterstitial = useCallback((): boolean => {
    try {
      return showInterstitialRef.current();
    } catch {
      return false;
    }
  }, []);

  const showRewardedInterstitial = useCallback((): boolean => {
    try {
      return showRewardedInterstitialRef.current();
    } catch {
      return false;
    }
  }, []);

  return (
    <InterstitialAdContext.Provider
      value={{ showInterstitial, showRewardedInterstitial, isInterstitialReady }}
    >
      {children}
    </InterstitialAdContext.Provider>
  );
}

// ── Public shell — renders children via Inner ─────────────────────────────────

interface InterstitialAdControllerProps {
  children?: React.ReactNode;
}

/**
 * Mount once at the root layout, inside <PlayerProvider>.
 * Provides InterstitialAdContext to the entire subtree.
 */
export function InterstitialAdController({
  children,
}: InterstitialAdControllerProps): React.ReactElement {
  return <InterstitialAdInner>{children}</InterstitialAdInner>;
}

export default InterstitialAdController;
