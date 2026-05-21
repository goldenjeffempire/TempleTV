import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { getApiBase } from "@/lib/apiBase";
import { fetchWithRetry } from "@/lib/fetchWithRetry";

const PUSH_TOKEN_KEY = "@temple_tv/push_token";
const ANDROID_CHANNEL_ID = "temple-tv-default";
const EMERGENCY_CHANNEL_ID = "temple-tv-emergency";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowList: true,
  }),
});

async function registerTokenWithServer(token: string): Promise<void> {
  try {
    const platform = Platform.OS as "ios" | "android";
    const baseUrl = getApiBase();
    await fetchWithRetry(`${baseUrl}/api/push-tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, platform }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    // Non-critical — will retry on next launch
  }
}

export async function setupAndroidNotificationChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
      name: "Temple TV",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#9B30FF",
      sound: "default",
      enableVibrate: true,
    });
    await Notifications.setNotificationChannelAsync(EMERGENCY_CHANNEL_ID, {
      name: "Temple TV — Emergency Alerts",
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 500, 250, 500],
      lightColor: "#FF3B3B",
      sound: "default",
      enableVibrate: true,
      bypassDnd: true,
    });
  } catch {
    // Non-critical
  }
}

export async function registerForPushTokenAsync(): Promise<string | null> {
  if (Platform.OS === "web") return null;

  try {
    await setupAndroidNotificationChannel();

    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== "granted") {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== "granted") return null;

    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      (Constants as any).easConfig?.projectId ??
      undefined;

    // The canonical EAS project ID for Temple TV (templetv Expo account).
    // When this is present and matches, cross-validate Firebase credentials so
    // push tokens don't silently fail with a cryptic FCM error on first build.
    const TEMPLE_TV_EAS_PROJECT_ID = "f0137848-bf77-486f-b1ff-0fbadc6b7840";

    if (__DEV__) {
      if (!projectId) {
        console.warn(
          "[notifications] EAS projectId not found in Constants.expoConfig.extra.eas.projectId.\n" +
          "Push tokens will fail on production builds. Expected projectId:\n" +
          `  "${TEMPLE_TV_EAS_PROJECT_ID}"\n` +
          "Ensure app.json extra.eas.projectId is set and google-services.json /\n" +
          "GoogleService-Info.plist contain real Firebase credentials.",
        );
      } else if (projectId === TEMPLE_TV_EAS_PROJECT_ID) {
        // EAS project ID is correctly set — cross-check Firebase credentials.
        // Detect placeholder google-services.json at runtime so engineers get an
        // explicit error instead of a cryptic FCM auth failure at build time.
        // google-services.json is bundled by Metro in dev builds; on production
        // native builds it is embedded by the Gradle Firebase plugin and this
        // __DEV__ branch is stripped by Hermes dead-code elimination.
        if (Platform.OS === "android") {
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const gServices = require("../google-services.json") as {
              project_info?: { project_id?: string; project_number?: string };
            };
            const pid = gServices.project_info?.project_id ?? "";
            const pnum = gServices.project_info?.project_number ?? "";
            const isPlaceholder = (s: string) =>
              s.startsWith("REPLACE_WITH_") || s.startsWith("YOUR_");
            if (isPlaceholder(pid) || isPlaceholder(pnum)) {
              console.error(
                "[notifications] EAS project ID is set but google-services.json still\n" +
                "contains REPLACE_WITH_... placeholder values — push notifications WILL FAIL.\n" +
                "Download the real file from:\n" +
                "  Firebase Console → Project Settings → Your Apps → Android (com.templetv.jctm)\n" +
                "and replace artifacts/mobile/google-services.json before building.",
              );
            }
          } catch {
            // File not bundled in this build config — not an error.
          }
        }
      }
    }

    const { data: token } = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
    if (token) {
      await AsyncStorage.setItem(PUSH_TOKEN_KEY, token);
      await registerTokenWithServer(token);
    }
    return token ?? null;
  } catch (err) {
    if (__DEV__) {
      console.warn("[notifications] registerForPushTokenAsync failed:", err);
    }
    return null;
  }
}

export async function getStoredPushToken(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(PUSH_TOKEN_KEY);
  } catch {
    return null;
  }
}

export async function requestNotificationPermissions(): Promise<boolean> {
  if (Platform.OS === "web") return false;

  try {
    await setupAndroidNotificationChannel();

    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== "granted") {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus === "granted") {
      const projectId =
        Constants.expoConfig?.extra?.eas?.projectId ??
        (Constants as any).easConfig?.projectId ??
        undefined;
      // Re-register token with server in case it changed
      const { data: token } = await Notifications.getExpoPushTokenAsync(
        projectId ? { projectId } : undefined,
      );
      if (token) {
        await AsyncStorage.setItem(PUSH_TOKEN_KEY, token);
        await registerTokenWithServer(token);
      }
    }

    return finalStatus === "granted";
  } catch {
    return false;
  }
}

export async function getNotificationPermissionStatus(): Promise<Notifications.PermissionStatus | null> {
  if (Platform.OS === "web") return null;
  try {
    const { status } = await Notifications.getPermissionsAsync();
    return status;
  } catch {
    return null;
  }
}

export async function sendLiveServiceNotification(title: string): Promise<void> {
  if (Platform.OS === "web") return;

  try {
    const hasPermission = await requestNotificationPermissions();
    if (!hasPermission) return;

    await Notifications.scheduleNotificationAsync({
      content: {
        title: "🔴 Temple TV is LIVE!",
        body: title || "Temple TV JCTM is streaming live right now. Tap to join!",
        sound: true,
        data: { type: "live_service" },
        ...(Platform.OS === "android" ? { channelId: ANDROID_CHANNEL_ID } : {}),
      },
      trigger: null,
    });
  } catch {
    // Silently fail — notifications are non-critical
  }
}

export async function sendNewSermonNotification(sermonTitle: string): Promise<void> {
  if (Platform.OS === "web") return;

  try {
    const hasPermission = await requestNotificationPermissions();
    if (!hasPermission) return;

    await Notifications.scheduleNotificationAsync({
      content: {
        title: "📺 New Sermon Available",
        body: sermonTitle,
        sound: true,
        data: { type: "new_sermon" },
        ...(Platform.OS === "android" ? { channelId: ANDROID_CHANNEL_ID } : {}),
      },
      trigger: null,
    });
  } catch {
    // Silently fail
  }
}

export async function sendEmergencyBroadcastNotification(message: string): Promise<void> {
  if (Platform.OS === "web") return;

  try {
    const hasPermission = await requestNotificationPermissions();
    if (!hasPermission) return;

    await Notifications.scheduleNotificationAsync({
      content: {
        title: "🚨 Urgent Announcement",
        body: message || "Temple TV has an important message. Tap to read it.",
        sound: true,
        data: { type: "emergency_broadcast" },
        ...(Platform.OS === "android"
          ? { channelId: EMERGENCY_CHANNEL_ID }
          : {}),
      },
      trigger: null,
    });
  } catch {
    // Silently fail
  }
}

export async function cancelAllNotifications(): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    await Notifications.cancelAllScheduledNotificationsAsync();
  } catch {
    //
  }
}
