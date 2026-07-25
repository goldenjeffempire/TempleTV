/**
 * useInterstitialAd — web platform stub.
 *
 * react-native-google-mobile-ads is a native-only module; importing it in a
 * web bundle pulls in react-native internals that Metro cannot resolve for
 * web ("Importing react-native internals is not supported on web") and the
 * whole bundle fails. Metro's platform resolution picks this `.web.ts` file
 * for web builds, so the native hook (useInterstitialAd.ts) is untouched on
 * iOS/Android.
 *
 * Interstitial ads are a mobile-app concept — on web this is a complete no-op.
 */

interface UseBroadcastInterstitialAdOptions {
  broadcastState: string;
  activeBufferId: "A" | "B";
  isYouTubeOverride: boolean;
  enabled?: boolean;
}

export function useBroadcastInterstitialAd(
  _options: UseBroadcastInterstitialAdOptions,
): void {
  // No-op on web.
}
