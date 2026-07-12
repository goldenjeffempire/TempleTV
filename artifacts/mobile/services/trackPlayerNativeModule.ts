/**
 * Modern TurboModule-based presence check for react-native-track-player's
 * native module ("TrackPlayerModule", registered by both the Android
 * (MusicModule.kt) and iOS (RNTrackPlayerBridge.m) native implementations).
 *
 * Why not `NativeModules.TrackPlayerModule`:
 * `NativeModules` is the legacy bridge registry. It still resolves TurboModules
 * through React Native's bridgeless interop layer, but it is not the sanctioned
 * New Architecture API and newer RN versions warn on direct property access to
 * it outside of codegen'd specs. `TurboModuleRegistry.get(name)` is the modern,
 * architecture-agnostic replacement: it checks the bridgeless TurboModule proxy
 * first (Fabric / New Architecture, the default since RN 0.86) and transparently
 * falls back to the legacy bridge registry for old-architecture builds — same
 * safety guarantee (returns `null`/`undefined` instead of throwing when the
 * native module isn't linked), single sanctioned code path either way.
 *
 * RNTP does not ship its own "is the native module linked" API, so this
 * positive-registration check remains necessary to avoid eagerly evaluating
 * RNTP's JS shim (which reads `CAPABILITY_PLAY` off the native module during
 * import and throws an uncatchable error in Expo Go / when unlinked).
 */
export function isTrackPlayerNativeModuleLinked(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { TurboModuleRegistry } = require("react-native");
    return TurboModuleRegistry?.get("TrackPlayerModule") != null;
  } catch {
    return false;
  }
}
