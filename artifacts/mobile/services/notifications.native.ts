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
    const { data: token } = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
    if (token) {
      await AsyncStorage.setItem(PUSH_TOKEN_KEY, token);
      await registerTokenWithServer(token);
    }
    return token ?? null;
  } catch {
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
