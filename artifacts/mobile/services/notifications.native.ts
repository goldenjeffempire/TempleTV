// Type-only import — stripped by the TS compiler, never evaluated at runtime.
// All runtime access to `expo-notifications` goes through `getNotifications()`,
// which only loads the module when we're NOT in Expo Go.
import type * as NotificationsModule from "expo-notifications";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { getApiBase } from "@/lib/apiBase";
import { fetchWithRetry } from "@/lib/fetchWithRetry";

const PUSH_TOKEN_KEY = "@temple_tv/push_token";
const ANDROID_CHANNEL_ID = "temple-tv-default";
const EMERGENCY_CHANNEL_ID = "temple-tv-emergency";

// Expo Go (Constants.executionEnvironment === "storeClient") dropped remote
// push support in SDK 53. Importing `expo-notifications` there at module-eval
// time prints a noisy red Console Error on every cold start. Treat unknown
// environments conservatively as Expo Go so we never touch the module unless
// we're positively in a dev-client / standalone / bare build.
const ENV: unknown = Constants?.executionEnvironment;
const OWNERSHIP: unknown = (Constants as { appOwnership?: unknown })?.appOwnership;
const IS_NATIVE_BUILD =
  ENV === "standalone" || ENV === "bare" || OWNERSHIP === "standalone";
const IS_EXPO_GO = !IS_NATIVE_BUILD;

let _Notifications: typeof NotificationsModule | null = null;
let _handlerInstalled = false;

function getNotifications(): typeof NotificationsModule | null {
  if (IS_EXPO_GO) return null;
  if (_Notifications) return _Notifications;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _Notifications = require("expo-notifications") as typeof NotificationsModule;
    if (!_handlerInstalled && _Notifications) {
      _Notifications.setNotificationHandler({
        handleNotification: async () => ({
          shouldShowBanner: true,
          shouldPlaySound: true,
          shouldSetBadge: true,
          shouldShowList: true,
        }),
      });
      _handlerInstalled = true;
    }
    return _Notifications;
  } catch {
    return null;
  }
}

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
  const N = getNotifications();
  if (!N) return;
  try {
    await N.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
      name: "Temple TV",
      importance: N.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#9B30FF",
      sound: "default",
      enableVibrate: true,
    });
    await N.setNotificationChannelAsync(EMERGENCY_CHANNEL_ID, {
      name: "Temple TV — Emergency Alerts",
      importance: N.AndroidImportance.MAX,
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
  const N = getNotifications();
  if (!N) return null;

  try {
    await setupAndroidNotificationChannel();

    const { status: existingStatus } = await N.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== "granted") {
      const { status } = await N.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== "granted") return null;

    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      (Constants as { easConfig?: { projectId?: string } }).easConfig?.projectId ??
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
                "  Firebase Console → Project Settings → Your Apps → Android (com.templetv.app)\n" +
                "and replace artifacts/mobile/google-services.json before building.",
              );
            }
          } catch {
            // File not bundled in this build config — not an error.
          }
        }
      }
    }

    const { data: token } = await N.getExpoPushTokenAsync(
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
  const N = getNotifications();
  if (!N) return false;

  try {
    await setupAndroidNotificationChannel();

    const { status: existingStatus } = await N.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== "granted") {
      const { status } = await N.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus === "granted") {
      const projectId =
        Constants.expoConfig?.extra?.eas?.projectId ??
        (Constants as { easConfig?: { projectId?: string } }).easConfig?.projectId ??
        undefined;
      const { data: token } = await N.getExpoPushTokenAsync(
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

export async function getNotificationPermissionStatus(): Promise<NotificationsModule.PermissionStatus | null> {
  if (Platform.OS === "web") return null;
  const N = getNotifications();
  if (!N) return null;
  try {
    const { status } = await N.getPermissionsAsync();
    return status;
  } catch {
    return null;
  }
}

export async function sendLiveServiceNotification(title: string): Promise<void> {
  if (Platform.OS === "web") return;
  const N = getNotifications();
  if (!N) return;

  try {
    const hasPermission = await requestNotificationPermissions();
    if (!hasPermission) return;

    await N.scheduleNotificationAsync({
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
  const N = getNotifications();
  if (!N) return;

  try {
    const hasPermission = await requestNotificationPermissions();
    if (!hasPermission) return;

    await N.scheduleNotificationAsync({
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
  const N = getNotifications();
  if (!N) return;

  try {
    const hasPermission = await requestNotificationPermissions();
    if (!hasPermission) return;

    await N.scheduleNotificationAsync({
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
  const N = getNotifications();
  if (!N) return;
  try {
    await N.cancelAllScheduledNotificationsAsync();
  } catch {
    //
  }
}
