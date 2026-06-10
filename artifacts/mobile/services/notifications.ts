import { getApiBase } from "@/lib/apiBase";
import { fetchWithRetry } from "@/lib/fetchWithRetry";

const SW_PATH = "/sw-temple-push.js";

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) output[i] = rawData.charCodeAt(i);
  return output;
}

function arrayBufferToBase64Url(buffer: ArrayBuffer | null): string {
  if (!buffer) return "";
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function isWebPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

async function fetchVapidPublicKey(): Promise<string | null> {
  try {
    const res = await fetchWithRetry(`${getApiBase()}/api/push/web-vapid-public-key`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { publicKey?: string };
    return data.publicKey ?? null;
  } catch {
    return null;
  }
}

async function sendSubscriptionToServer(sub: PushSubscription): Promise<void> {
  const json = sub.toJSON();
  const endpoint = json.endpoint || sub.endpoint;
  const p256dh = json.keys?.p256dh ?? arrayBufferToBase64Url(sub.getKey("p256dh"));
  const auth = json.keys?.auth ?? arrayBufferToBase64Url(sub.getKey("auth"));
  if (!endpoint || !p256dh || !auth) return;

  await fetchWithRetry(`${getApiBase()}/api/push/web-subscriptions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      endpoint,
      keys: { p256dh, auth },
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
    }),
    signal: AbortSignal.timeout(10000),
  });
}

export async function registerForPushTokenAsync(): Promise<string | null> {
  if (!isWebPushSupported()) return null;

  try {
    const permission =
      Notification.permission === "default"
        ? await Notification.requestPermission()
        : Notification.permission;
    if (permission !== "granted") return null;

    const registration = await navigator.serviceWorker.register(SW_PATH);
    await navigator.serviceWorker.ready;

    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      const vapidKey = await fetchVapidPublicKey();
      if (!vapidKey) return null;
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey) as BufferSource,
      });
    }

    await sendSubscriptionToServer(subscription);
    return subscription.endpoint;
  } catch {
    return null;
  }
}

export async function getStoredPushToken(): Promise<string | null> {
  if (!isWebPushSupported()) return null;
  try {
    const registration = await navigator.serviceWorker.getRegistration(SW_PATH);
    if (!registration) return null;
    const sub = await registration.pushManager.getSubscription();
    return sub?.endpoint ?? null;
  } catch {
    return null;
  }
}

export async function requestNotificationPermissions(): Promise<boolean> {
  if (!isWebPushSupported()) return false;
  try {
    const permission =
      Notification.permission === "default"
        ? await Notification.requestPermission()
        : Notification.permission;
    if (permission !== "granted") return false;
    const endpoint = await registerForPushTokenAsync();
    return Boolean(endpoint);
  } catch {
    return false;
  }
}

export async function getNotificationPermissionStatus(): Promise<NotificationPermission | null> {
  if (!isWebPushSupported()) return null;
  return Notification.permission;
}

export async function sendLiveServiceNotification(_title: string): Promise<void> {
  // Native-only — web pushes are dispatched from the server.
}

export async function sendNewSermonNotification(_sermonTitle: string): Promise<void> {
  // Native-only — web pushes are dispatched from the server.
}

export async function sendEmergencyBroadcastNotification(_message: string): Promise<void> {
  // Native-only — web pushes are dispatched from the server.
}

export async function cancelAllNotifications(): Promise<void> {
  // Native-only — web notifications expire on their own.
}

export async function setupAndroidNotificationChannel(): Promise<void> {
  // Native-only.
}

export async function unregisterCurrentPushToken(): Promise<void> {
  // Web push subscriptions expire or are cleaned up by the browser automatically.
}
