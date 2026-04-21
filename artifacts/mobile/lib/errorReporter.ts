import { Platform } from "react-native";
import Constants from "expo-constants";

type ClientErrorPayload = {
  errorMessage: string;
  errorName?: string;
  stack?: string;
  componentStack?: string;
  context?: Record<string, string | number | boolean | null>;
};

function getApiBase(): string {
  // EXPO_PUBLIC_API_URL is the canonical EAS-profile-driven API URL
  // (production / preview / development). EXPO_PUBLIC_DOMAIN is a legacy
  // fallback for early Expo Go builds and the web export.
  const apiUrl = process.env.EXPO_PUBLIC_API_URL;
  if (apiUrl) return apiUrl.replace(/\/$/, "");
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  if (domain) return `https://${domain}`;
  return "";
}

function getPlatform(): "ios" | "android" | "web" | "unknown" {
  if (Platform.OS === "ios") return "ios";
  if (Platform.OS === "android") return "android";
  if (Platform.OS === "web") return "web";
  return "unknown";
}

let lastReportAt = 0;
const MIN_INTERVAL_MS = 1000; // simple client-side throttle to avoid floods

export async function reportClientError(input: ClientErrorPayload): Promise<void> {
  const now = Date.now();
  if (now - lastReportAt < MIN_INTERVAL_MS) return;
  lastReportAt = now;

  const base = getApiBase();
  if (!base) return; // No-op when API base is unknown (e.g. early boot)

  const expoConfig = Constants.expoConfig;
  const payload = {
    platform: getPlatform(),
    appVersion: expoConfig?.version,
    buildNumber:
      Platform.OS === "ios"
        ? expoConfig?.ios?.buildNumber
        : String(expoConfig?.android?.versionCode ?? ""),
    errorName: input.errorName,
    errorMessage: input.errorMessage.slice(0, 2048),
    stack: input.stack?.slice(0, 8192),
    componentStack: input.componentStack?.slice(0, 8192),
    context: input.context,
    occurredAt: new Date().toISOString(),
  };

  try {
    await fetch(`${base}/api/client-errors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    /* swallow — never let error reporting throw */
  }
}
