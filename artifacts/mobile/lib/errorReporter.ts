import { Platform } from "react-native";
import Constants from "expo-constants";
import { getApiBase } from "./apiBase";

type ClientErrorPayload = {
  errorMessage: string;
  errorName?: string;
  stack?: string;
  componentStack?: string;
  context?: Record<string, string | number | boolean | null>;
};

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

  // ── Sentry (primary — works offline, symbolicated stack traces in prod) ──
  if (process.env.EXPO_PUBLIC_SENTRY_DSN) {
    try {
      const Sentry = await import("@sentry/react-native");
      const err = new Error(input.errorMessage);
      err.name = input.errorName ?? "ClientError";
      if (input.stack) err.stack = input.stack;
      Sentry.captureException(err, {
        extra: {
          componentStack: input.componentStack,
          ...input.context,
        },
      });
    } catch {
      /* never let error reporting throw */
    }
  }

  // ── API fallback (secondary — logs to server DB for admin inspection) ──
  const base = getApiBase();
  if (!base) return;

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
