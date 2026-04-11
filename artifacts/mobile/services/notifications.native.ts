import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

const PUSH_TOKEN_KEY = "@temple_tv/push_token";
const ANDROID_CHANNEL_ID = "temple-tv-default";

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
    const domain = process.env.EXPO_PUBLIC_DOMAIN ?? "";
    const baseUrl = domain ? `https://${domain}` : "";
    await fetch(`${baseUrl}/api/push-tokens`, {
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

    const { data: token } = await Notifications.getExpoPushTokenAsync();
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

export async function cancelAllNotifications(): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    await Notifications.cancelAllScheduledNotificationsAsync();
  } catch {
    //
  }
}
