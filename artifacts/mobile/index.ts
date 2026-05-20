import * as Sentry from "@sentry/react-native";
import { Platform } from "react-native";

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

if (Platform.OS !== "web") {
  try {
    const TrackPlayer = require("react-native-track-player").default;
    const { PlaybackService } = require("./services/PlayerService");
    TrackPlayer.registerPlaybackService(() => PlaybackService);
  } catch {
    // TrackPlayer not available — graceful degradation
  }
}

import "expo-router/entry";
