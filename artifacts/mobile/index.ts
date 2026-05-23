import * as Sentry from "@sentry/react-native";
import { Platform } from "react-native";

// ── AbortSignal.timeout polyfill ─────────────────────────────────────────────
// Hermes (React Native's JS engine) only added AbortSignal.timeout in very
// recent versions. On older builds — and inside Expo Go for SDK 53 — calling
// `AbortSignal.timeout(ms)` throws "AbortSignal.timeout is not a function (it
// is undefined)" and tears down every fetch that uses it. We have 30+ call
// sites across the mobile app and shared libs; polyfilling once globally is
// far safer than editing every site.
if (typeof (globalThis as { AbortSignal?: typeof AbortSignal }).AbortSignal !== "undefined") {
  const AS = (globalThis as { AbortSignal: typeof AbortSignal & { timeout?: (ms: number) => AbortSignal } }).AbortSignal;
  if (typeof AS.timeout !== "function") {
    AS.timeout = (ms: number): AbortSignal => {
      const controller = new AbortController();
      const id = setTimeout(() => {
        // Hermes does NOT reliably expose `DOMException` as a global — earlier
        // versions of this polyfill assumed it did and crashed with
        // "ReferenceError: Property 'DOMException' doesn't exist". We now
        // always abort with a plain Error shaped like a TimeoutError so
        // userland `.name === "TimeoutError"` checks still match.
        //
        // We also deliberately avoid the no-arg `controller.abort()`
        // fallback: on some Hermes builds, AbortController internally
        // constructs `new DOMException(...)` to fill in a default reason,
        // re-triggering the same ReferenceError from inside the engine —
        // which is uncatchable from JS userland.
        const reason = Object.assign(new Error("The operation timed out."), {
          name: "TimeoutError",
        });
        try {
          controller.abort(reason);
        } catch {
          // Swallow — if abort itself throws, the signal will simply
          // never fire and downstream fetches will use their own timeouts.
        }
      }, ms);
      // Don't keep the JS runtime awake just for the timeout.
      if (typeof (id as unknown as { unref?: () => void })?.unref === "function") {
        (id as unknown as { unref: () => void }).unref();
      }
      return controller.signal;
    };
  }
}

const sentryDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    enabled: !__DEV__,
    environment: (process.env.APP_ENV as string) ?? "production",
    tracesSampleRate: 0.1,
    attachStacktrace: true,
    enableAutoSessionTracking: true,
    enableNativeFramesTracking: Platform.OS !== "web",
    // Filter transient noise that would exhaust Sentry quota without
    // providing actionable signal: network interruptions, cancelled requests,
    // and OS-level audio/background-task rejections are expected on mobile
    // and are not indicative of code bugs.
    beforeSend(event) {
      const msg = event.exception?.values?.[0]?.value ?? "";
      if (/network request failed|load failed|the internet connection appears to be offline|aborted|cancelled|the request timed out|could not connect to the server/i.test(msg)) {
        return null;
      }
      return event;
    },
  });
}

// react-native-track-player has a native TurboModule that is NOT linked in
// Expo Go (the JS shim still loads and eagerly reads CAPABILITY_PLAY from the
// null TurboModule during module init, producing an uncaught
// "Cannot read property 'CAPABILITY_PLAY' of null" that the outer try/catch
// cannot reliably suppress on Hermes). Skip RNTP entirely in Expo Go and on
// web — it is only useful in custom dev clients and standalone/store builds.
if (Platform.OS !== "web") {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ConstantsModule = require("expo-constants");
    const Constants = ConstantsModule?.default ?? ConstantsModule;
    const env: unknown = Constants?.executionEnvironment;
    const ownership: unknown = Constants?.appOwnership;

    // DEFAULT DENY: only load RNTP when we can positively confirm we are in a
    // dev-client / standalone / bare build (where the native TurboModule is
    // linked). If the environment is unknown ("" / undefined / null) — which
    // happens in Expo Go variants and inside the Replit web preview — skip the
    // require entirely. Touching `react-native-track-player`'s JS shim with no
    // native module mounted eagerly evaluates `Capability.ts` and throws an
    // UNCATCHABLE "Cannot read property 'CAPABILITY_PLAY' of null" before
    // Hermes can return control to this try/catch.
    const isNativeBuild =
      env === "standalone" ||
      env === "bare" ||
      ownership === "standalone";

    if (isNativeBuild) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { NativeModules } = require("react-native");
      // Final safety check: the native module must actually be registered.
      if (NativeModules?.TrackPlayerModule) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const TrackPlayerModule = require("react-native-track-player");
        const TrackPlayer = TrackPlayerModule?.default ?? TrackPlayerModule;
        if (TrackPlayer && typeof TrackPlayer.registerPlaybackService === "function") {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { PlaybackService } = require("./services/PlayerService");
          TrackPlayer.registerPlaybackService(() => PlaybackService);
        }
      }
    }
  } catch {
    // TrackPlayer not available — graceful degradation
  }
}

import "expo-router/entry";
