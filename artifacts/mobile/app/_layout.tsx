import * as Sentry from "@sentry/react-native";
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect, useRef, useState } from "react";
import { Linking, Platform, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

// ── Sentry crash reporting ────────────────────────────────────────────────────
// Initialise after all imports so Platform is resolved before this block runs.
// @sentry/react-native ships a browser-compatible build (used by Expo web).
// We guard init() to native-only: the RN SDK's native crash integrations and
// session tracking are no-ops on web and add unnecessary overhead.
if (Platform.OS !== "web" && process.env.EXPO_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
    enabled: true,
    environment: process.env.APP_ENV ?? "development",
    tracesSampleRate: 0.1,
    attachStacktrace: true,
    enableAutoSessionTracking: true,
    debug: false,
    ignoreErrors: [
      "Non-Error promise rejection captured",
      "Network request failed",
      "AbortError",
      "Load failed",
    ],
  });
}

let KeyboardProvider: React.ComponentType<{ children: React.ReactNode }> | null = null;
try {
  KeyboardProvider = require("react-native-keyboard-controller").KeyboardProvider;
} catch {
  KeyboardProvider = null;
}

function SafeKeyboardProvider({ children }: { children: React.ReactNode }) {
  if (!KeyboardProvider) return <View style={{ flex: 1 }}>{children}</View>;
  try {
    return <KeyboardProvider>{children}</KeyboardProvider>;
  } catch {
    return <View style={{ flex: 1 }}>{children}</View>;
  }
}

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { NotificationOptInModal } from "@/components/NotificationOptInModal";
import { reportClientError } from "@/lib/errorReporter";
import { LiveBroadcastSupervisor } from "@/components/LiveBroadcastSupervisor";
import { PersistentAudioPlayer } from "@/components/PersistentAudioPlayer";
import { AuthGateModal } from "@/components/AuthGateModal";
import { PlayerProvider } from "@/context/PlayerContext";
import { AuthProvider } from "@/context/AuthContext";
import { ThemeProvider } from "@/context/ThemeContext";
import { RadioStreamProvider } from "@/context/RadioStreamContext";
import { NetworkProvider } from "@/context/NetworkContext";
import { NetworkBanner } from "@/components/NetworkBanner";
import { useNetworkStatus } from "@/hooks/useNetworkStatus";
import { setupTrackPlayer } from "@/services/nowPlaying";
import { useNotificationPreferences } from "@/hooks/useNotificationPreferences";

/**
 * Global offline/recovery banner — mounted once at the root so every screen
 * gets coverage without each screen needing its own NetworkBanner instance.
 * Reads from the singleton NetworkContext (one poll interval for the whole app).
 */
function GlobalNetworkBanner() {
  const { isOnline, justRecovered } = useNetworkStatus();
  return <NetworkBanner visible={!isOnline} recovered={justRecovered} />;
}

SplashScreen.preventAutoHideAsync().catch(() => {});

// Safety net: if the JS tree never renders (e.g. a production font-load
// hang or a pre-render native exception), force-hide the splash screen
// after 8 s so the OS doesn't ANR-kill the app. Fonts are bundled and
// load in <100 ms in practice — this only fires on pathological failures.
const _splashSafetyTimer = setTimeout(() => {
  SplashScreen.hideAsync().catch(() => {});
}, 8000);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      // 5-minute stale window — content changes infrequently enough that
      // navigating between tabs does not need a fresh network round-trip.
      staleTime: 5 * 60 * 1000,
      // Keep data alive in the cache for 15 minutes. Mobile users frequently
      // background the app and return; keeping query results avoids a cold
      // paint on resume. SSE-driven invalidation handles real-time updates.
      gcTime: 15 * 60 * 1000,
      // App focus/resume events must NOT trigger automatic refetches on mobile.
      // The AsyncStorage instant-paint cache and the SSE/WS live-sync pipeline
      // already keep data fresh without noisy polling. Disable focus-based
      // refetch to prevent the broadcast screen from stuttering when the app
      // comes to the foreground mid-playback.
      refetchOnWindowFocus: false,
      // Reconnect refetch remains enabled: when the device regains a network
      // connection after being offline, queries should refresh automatically.
      refetchOnReconnect: true,
    },
  },
});

async function setupAudioSession() {
  if (Platform.OS === "web") return;
  try {
    const { Audio, InterruptionModeIOS, InterruptionModeAndroid } = await import("expo-av");
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      staysActiveInBackground: true,
      playsInSilentModeIOS: true,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false,
      interruptionModeIOS: InterruptionModeIOS.DoNotMix,
      interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
    });
  } catch {
    // Non-critical
  }
}

/**
 * Shown once on first launch (after fonts load) to ask the user whether they
 * want to receive push notifications. Requesting OS permission without
 * explicit user consent is a guideline violation on both iOS and Android.
 * Once dismissed (allowed OR deferred), the flag is stored in AsyncStorage
 * and the modal never appears again.
 */
function NotificationOptInGate() {
  const { hasSeenOptIn, optInLoaded, markOptInSeen, syncWithPermissionStatus } =
    useNotificationPreferences();
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    if (Platform.OS === "web") return;
    if (!optInLoaded || hasSeenOptIn) return;
    // Small delay so the splash screen fade finishes before the modal appears
    const timer = setTimeout(() => setShowModal(true), 1800);
    return () => clearTimeout(timer);
  }, [optInLoaded, hasSeenOptIn]);

  const handleAllow = async () => {
    setShowModal(false);
    await markOptInSeen();
    try {
      const { registerForPushTokenAsync } = await import("@/services/notifications");
      const token = await registerForPushTokenAsync();
      if (token) {
        await syncWithPermissionStatus(true);
      }
    } catch {
      //
    }
  };

  const handleDismiss = async () => {
    setShowModal(false);
    await markOptInSeen();
  };

  if (Platform.OS === "web") return null;

  return (
    <NotificationOptInModal
      visible={showModal}
      onAllow={handleAllow}
      onDismiss={handleDismiss}
    />
  );
}

/**
 * Known app paths — any incoming deep-link whose pathname starts with one
 * of these is a valid app route. Everything else is a web-only path that
 * happened to open the app via the broad `pathPrefix "/"` intent filter.
 * Unrecognised paths are redirected to channels so the user never sees a
 * 404 screen, even before +not-found.tsx has had a chance to mount.
 */
const KNOWN_APP_PATH_PREFIXES = [
  "/channels",
  "/library",
  "/player",
  "/search",
  "/playlists",
  "/series",
  "/favorites",
  "/history",
  "/login",
  "/signup",
  "/donate",
  "/settings",
  "/radio",
  "/account",
  "/change-password",
  "/link",
];

/**
 * Returns true when the pathname could be an in-app route.
 * The root "/" is also valid — it resolves to the tabs group.
 */
function isKnownAppPath(pathname: string): boolean {
  if (pathname === "/" || pathname === "") return true;
  return KNOWN_APP_PATH_PREFIXES.some((prefix) =>
    pathname === prefix || pathname.startsWith(prefix + "/"),
  );
}

function RootLayoutNav() {
  const notifListenerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Deep-link safety net ────────────────────────────────────────────────────
  // On cold start, Android may deliver the initial URL from:
  //  • A Play Store referral link
  //  • A shared https://templetv.org.ng/* link (autoVerify catches all paths)
  //  • An OTA update channel redirect
  //
  // If the path doesn't map to a known app route, Expo Router falls back to
  // +not-found.tsx (which now auto-redirects). As a belt-and-suspenders guard,
  // we also intercept here so the redirect happens even earlier — before the
  // not-found component has mounted — eliminating any possibility of a flash.
  useEffect(() => {
    if (Platform.OS === "web") return;

    // ── Initial URL (cold start) ────────────────────────────────────────────
    Linking.getInitialURL().then((url) => {
      if (!url) return;
      try {
        // Strip the custom scheme (templetv://) or https origin to get the path.
        const parsed = new URL(url);
        const path = parsed.pathname ?? "/";
        if (!isKnownAppPath(path)) {
          // Unknown path — redirect to the safe home screen immediately.
          router.replace("/(tabs)/channels");
        }
      } catch {
        // Malformed URL — navigate to safe home.
        router.replace("/(tabs)/channels");
      }
    }).catch(() => {
      // getInitialURL failure is non-fatal — the route resolver handles it.
    });

    // ── Subsequent incoming links (while app is foregrounded) ───────────────
    const sub = Linking.addEventListener("url", ({ url: incomingUrl }) => {
      if (!incomingUrl) return;
      try {
        const parsed = new URL(incomingUrl);
        const path = parsed.pathname ?? "/";
        if (!isKnownAppPath(path)) {
          // Unknown external path — redirect to home so the user is never
          // stranded on a 404 by a stale web link or Play Store referral URL.
          router.replace("/(tabs)/channels");
        }
        // Known paths fall through — Expo Router's built-in handler processes them.
      } catch { /* ignore malformed URLs */ }
    });

    return () => sub.remove();
  }, []);

  // ── Push notification tap handler ──────────────────────────────────────────
  useEffect(() => {
    if (Platform.OS === "web") return;

    let subscription: { remove: () => void } | null = null;

    import("expo-notifications").then((Notifications) => {
      subscription = Notifications.addNotificationResponseReceivedListener((response) => {
        const data = response.notification.request.content.data as Record<string, unknown>;
        const type = data?.type as string | undefined;

        if (!type) return;

        // Route the user to the most relevant screen based on notification type.
        switch (type) {
          case "live_started":
          case "live_now":
          case "live": {
            // Live-stream alert — open the player in live mode immediately.
            router.push({
              pathname: "/player",
              params: {
                live: "true",
                title: "Temple TV Live",
                preacher: "Temple TV JCTM",
              },
            });
            break;
          }
          case "new_video":
          case "new_sermon":
          case "video": {
            // New-content alert — deep-link to specific video if id is attached.
            const videoId = data?.videoId as string | undefined;
            const title   = (data?.title as string | undefined) ?? "Temple TV";
            if (videoId) {
              router.push({
                pathname: "/player",
                params: { id: videoId, title },
              });
            } else {
              router.push("/(tabs)/library");
            }
            break;
          }
          case "prayer":
          case "announcement":
          default:
            // General or unrecognised type — land on the channel hub.
            router.push("/(tabs)/channels");
        }
      });
    });

    return () => {
      subscription?.remove();
      if (notifListenerRef.current) clearTimeout(notifListenerRef.current);
    };
  }, []);

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen
        name="player"
        options={{
          headerShown: false,
          presentation: "modal",
          animation: "slide_from_bottom",
        }}
      />
      <Stack.Screen
        name="login"
        options={{
          headerShown: false,
          presentation: "modal",
          animation: "slide_from_bottom",
        }}
      />
      <Stack.Screen
        name="signup"
        options={{
          headerShown: false,
          presentation: "modal",
          animation: "slide_from_bottom",
        }}
      />
      <Stack.Screen
        name="donate"
        options={{
          headerShown: false,
          presentation: "modal",
          animation: "slide_from_bottom",
        }}
      />
      <Stack.Screen
        name="change-password"
        options={{
          headerShown: false,
          presentation: "modal",
          animation: "slide_from_bottom",
        }}
      />
      <Stack.Screen
        name="link"
        options={{
          headerShown: false,
          presentation: "modal",
          animation: "slide_from_bottom",
        }}
      />
      <Stack.Screen
        name="favorites"
        options={{
          headerShown: false,
          animation: "slide_from_right",
        }}
      />
      <Stack.Screen
        name="history"
        options={{
          headerShown: false,
          animation: "slide_from_right",
        }}
      />
      <Stack.Screen
        name="series/[slug]"
        options={{
          headerShown: false,
          animation: "slide_from_right",
        }}
      />
      <Stack.Screen
        name="search"
        options={{
          headerShown: false,
          presentation: "modal",
          animation: "slide_from_bottom",
        }}
      />
      <Stack.Screen
        name="account"
        options={{
          headerShown: false,
          presentation: "modal",
          animation: "slide_from_bottom",
        }}
      />
      <Stack.Screen
        name="playlists"
        options={{
          headerShown: false,
          animation: "slide_from_right",
        }}
      />
      <Stack.Screen
        name="playlists/[id]"
        options={{
          headerShown: false,
          animation: "slide_from_right",
        }}
      />
    </Stack>
  );
}

function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  // ── Font-load timeout ───────────────────────────────────────────────────────
  // On web the Inter fonts are fetched from the Google Fonts CDN. In restricted
  // environments (Replit sandbox, corporate proxies) that CDN may be unreachable,
  // causing useFonts() to stay pending indefinitely. Without this guard the app
  // renders nothing — a permanent blank white screen. After 2 s we proceed with
  // system fonts rather than waiting forever. On native, fonts are bundled and
  // load in < 100 ms, so this timer never fires in practice.
  const [fontTimedOut, setFontTimedOut] = useState(false);
  useEffect(() => {
    if (fontsLoaded || fontError) return;
    const t = setTimeout(() => setFontTimedOut(true), 2000);
    return () => clearTimeout(t);
  }, [fontsLoaded, fontError]);

  const fontReady = fontsLoaded || !!fontError || fontTimedOut;

  useEffect(() => {
    if (fontReady) {
      clearTimeout(_splashSafetyTimer);
      SplashScreen.hideAsync().catch(() => {});
      setupAudioSession();
      if (Platform.OS !== "web") {
        setupTrackPlayer().catch(() => {});
        // Android notification channels need to exist before any notification
        // can be delivered. We set them up here (non-blocking) instead of at
        // registration time so that server-sent push notifications that arrive
        // before the user has opted in still land in the right channel.
        import("@/services/notifications")
          .then(({ setupAndroidNotificationChannel }) => {
            if (typeof setupAndroidNotificationChannel === "function") {
              setupAndroidNotificationChannel().catch(() => {});
            }
          })
          .catch(() => {});
      } else {
        // Web: if the user already granted permission in a previous session,
        // re-register the service worker and re-send the subscription to the
        // server. This is idempotent — pushManager.getSubscription() returns
        // the existing subscription without re-prompting, and the backend
        // upserts on endpoint so no duplicate rows are created. This ensures
        // the subscription persists across page refresh and re-login.
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          import("@/services/notifications")
            .then(({ registerForPushTokenAsync }) => registerForPushTokenAsync())
            .catch(() => {});
        }
      }
    }
  }, [fontReady]);

  if (!fontReady) return null;

  return (
    <SafeAreaProvider style={{ flex: 1 }}>
      <ThemeProvider>
      <NetworkProvider>
      <ErrorBoundary
        onError={(error, stackTrace) => {
          reportClientError({
            errorName: error.name,
            errorMessage: error.message,
            stack: error.stack,
            componentStack: stackTrace,
            context: { boundary: "root" },
          });
        }}
      >
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <RadioStreamProvider>
            <PlayerProvider>
              <LiveBroadcastSupervisor />
              <GestureHandlerRootView style={{ flex: 1 }}>
                <SafeKeyboardProvider>
                  <RootLayoutNav />
                  <PersistentAudioPlayer />
                  {/*
                   * AuthGateModal is rendered at the root so it can be
                   * triggered from any screen (including non-React utility
                   * functions) and overlays every navigation surface.
                   */}
                  <AuthGateModal />
                  {/*
                   * NotificationOptInGate shows a one-time bottom-sheet asking
                   * the user to opt in to push notifications. It fires after
                   * the splash screen fades, never before. Only shown on native.
                   */}
                  <NotificationOptInGate />
                  {/*
                   * GlobalNetworkBanner overlays every screen with an amber
                   * "No connection" strip when the device goes offline, and a
                   * brief green "Back online" flash when connectivity returns.
                   * Reads from the singleton NetworkContext — one poll interval
                   * for the whole app, no per-screen duplication.
                   */}
                  <GlobalNetworkBanner />
                </SafeKeyboardProvider>
              </GestureHandlerRootView>
            </PlayerProvider>
            </RadioStreamProvider>
          </AuthProvider>
        </QueryClientProvider>
      </ErrorBoundary>
      </NetworkProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

// Wrap with Sentry so uncaught JS exceptions are captured with full context,
// touch-event breadcrumbs, and session tracking in production builds.
// When EXPO_PUBLIC_SENTRY_DSN is unset (local dev without Sentry), Sentry.wrap
// is a transparent pass-through that returns the component unchanged.
export default Sentry.wrap(RootLayout);
