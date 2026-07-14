import * as Sentry from "@sentry/react-native";
import { Platform, ErrorUtils } from "react-native";
import { markStartupPhase } from "@/lib/startupLifecycle";

// ── AbortSignal.timeout polyfill ─────────────────────────────────────────────
// Hermes (React Native's JS engine) only added AbortSignal.timeout in very
// recent versions. On older builds — and inside Expo Go for SDK 53 — calling
// `AbortSignal.timeout(ms)` throws "AbortSignal.timeout is not a function (it
// is undefined)" and tears down every fetch that uses it. We have 30+ call
// sites across the mobile app and shared libs; polyfilling once globally is
// far safer than editing every site.
if (typeof (globalThis as { AbortSignal?: typeof AbortSignal }).AbortSignal !== "undefined") {
  const AS = (globalThis as { AbortSignal: typeof AbortSignal & { timeout?: (ms: number) => AbortSignal } }).AbortSignal;
  // Defensive: assigning a static method can throw (TypeError: Cannot assign
  // to read only property) on engines/polyfill combos where AbortSignal is
  // frozen or `timeout` is defined as a non-writable accessor. This runs
  // BEFORE Sentry.init() below, so an uncaught throw here would crash the
  // app on boot with zero error reporting. Wrap defensively — worst case we
  // silently skip the polyfill and individual fetch call sites fall back to
  // their own timeout handling.
  try {
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
  } catch {
    // Assignment threw (frozen/read-only AbortSignal.timeout on this engine).
    // Skip the polyfill silently — call sites using AbortSignal.timeout() will
    // throw at their own call site instead, which is caught by their existing
    // try/catch, rather than crashing the app during module init.
  }
}

// Record that the JS engine is up and polyfills are applied.
// This is the first breadcrumb visible in Sentry — any crash after here
// but before 'sentry_init' happened during Sentry.init() itself.
markStartupPhase("global_error_handler");

const sentryDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    enabled: !__DEV__,
    environment: (process.env.APP_ENV as string) ?? "production",
    // Crash events are ALWAYS sent at 100% regardless of tracesSampleRate.
    // This rate controls performance transactions only — raising it gives
    // richer profiling data while still being well within typical quotas.
    tracesSampleRate: 0.3,
    // Performance profiling: capture CPU/memory profiles for 10% of sessions.
    // Combined with tracesSampleRate this gives actionable performance data
    // without meaningfully impacting battery or quota.
    _experiments: { profilesSampleRate: 0.1 },
    attachStacktrace: true,
    // Attach native thread state to every event so ANR root-causes are
    // visible in the Sentry UI without symbolication guesswork.
    attachThreads: true,
    enableAutoSessionTracking: true,
    enableNativeFramesTracking: Platform.OS !== "web",
    // Track every user interaction (tap, scroll) as a Sentry transaction so
    // slow interaction traces surface in the Performance dashboard.
    enableUserInteractionTracing: true,
    // Filter transient noise that would exhaust Sentry quota without
    // providing actionable signal: network interruptions, cancelled requests,
    // and OS-level audio/background-task rejections are expected on mobile
    // and are not indicative of code bugs.
    beforeSend(event) {
      const msg = event.exception?.values?.[0]?.value ?? "";
      // Only filter if the error is EXCLUSIVELY a network/connectivity message.
      // Errors that merely CONTAIN those words but have other context (e.g. a
      // custom error wrapping a network failure) are kept.
      const isTransientNetworkNoise =
        /^(network request failed|load failed|the internet connection appears to be offline|the request timed out|could not connect to the server)$/i.test(msg.trim()) ||
        /^(aborted|cancelled)$/i.test(msg.trim());
      if (isTransientNetworkNoise) return null;
      return event;
    },
  });
}

markStartupPhase("sentry_init");

// ── Global unhandled error handler ───────────────────────────────────────────
// ErrorUtils.setGlobalHandler is the React Native / Hermes equivalent of
// window.onerror. It catches ALL uncaught JS exceptions, including:
//   • Errors thrown inside setTimeout / setInterval callbacks
//   • Errors thrown in native event callbacks (AppState, NetInfo, etc.)
//   • Unhandled Promise rejections on older Hermes builds that pre-date
//     the standard globalThis.unhandledrejection event
//
// Without this handler, such errors crash the JS thread silently in
// production — no red box, no Sentry event, no user-visible recovery.
//
// Strategy:
//   1. Immediately capture to Sentry with isFatal context (synchronous).
//   2. On fatal errors, flush the Sentry queue (2 s deadline) so the event
//      lands before the process is killed by the OS.
//   3. Hand off to the previous handler so DEV red boxes still appear and
//      PROD crash reporters (Firebase Crashlytics via Sentry native) see it.
{
  const previousHandler = typeof ErrorUtils?.getGlobalHandler === "function"
    ? ErrorUtils.getGlobalHandler()
    : null;

  if (typeof ErrorUtils?.setGlobalHandler === "function") {
    ErrorUtils.setGlobalHandler((rawError: Error, isFatal?: boolean) => {
      if (sentryDsn) {
        try {
          const err = rawError instanceof Error
            ? rawError
            : Object.assign(new Error(String(rawError)), { name: "UnhandledError" });

          Sentry.captureException(err, {
            extra: {
              isFatal: isFatal ?? false,
              source: "ErrorUtils.globalHandler",
            },
            level: isFatal ? "fatal" : "error",
          });

          if (isFatal) {
            // Best-effort flush before the OS kills the process.
            // 2 s is the maximum safe window before Android ANR threshold.
            void Sentry.flush();
          }
        } catch {
          // Absolutely cannot let the reporter itself crash — that would
          // swallow the original error AND the recovery path.
        }
      }
      previousHandler?.(rawError, isFatal);
    });
  }
}

// ── Unhandled Promise rejection (web / modern Hermes) ────────────────────────
// Newer Hermes builds (SDK 54+) and web environments surface unhandled
// rejections through the standard globalThis 'unhandledrejection' event.
// Belt-and-suspenders: capture these in Sentry in case they slip past the
// ErrorUtils global handler above.
if (typeof (globalThis as { addEventListener?: unknown }).addEventListener === "function") {
  const g = globalThis as typeof globalThis & {
    addEventListener: (type: string, listener: (event: { reason: unknown; preventDefault: () => void }) => void) => void;
  };
  g.addEventListener("unhandledrejection", (event) => {
    if (!sentryDsn) return;
    try {
      const reason = event.reason;
      const err = reason instanceof Error
        ? reason
        : Object.assign(new Error(String(reason ?? "Unhandled Promise rejection")), {
            name: "UnhandledRejection",
          });
      // Don't capture transient network noise here either.
      const msg = err.message ?? "";
      if (/network request failed|load failed|aborted|timed out/i.test(msg)) return;
      Sentry.captureException(err, {
        extra: { source: "unhandledrejection" },
        level: "error",
      });
    } catch { /* never block */ }
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
markStartupPhase("rntp_register");

import "expo-router/entry";
