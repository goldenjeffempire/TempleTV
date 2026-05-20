/**
 * Canonical API base URL resolver for the mobile/web bundle.
 *
 * Resolution order:
 *   1. EXPO_PUBLIC_API_URL — set by EAS profiles (production / preview /
 *      development) and by the web service in render.yaml. This is the
 *      authoritative value going forward.
 *   2. EXPO_PUBLIC_DOMAIN — legacy env from earlier Expo Go builds. Kept as
 *      a fallback so existing CI / dev environments keep working.
 *
 * Returns "" when neither is set, so callers can early-return on no-op
 * builds without throwing.
 */
export function getApiBase(): string {
  const apiUrl = process.env.EXPO_PUBLIC_API_URL;
  if (apiUrl) {
    const trimmed = apiUrl.replace(/\/$/, "");
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    // Common mistake: someone set EXPO_PUBLIC_API_URL to a bare domain.
    // Fall through to the EXPO_PUBLIC_DOMAIN branch below rather than
    // emit a malformed `api.example.com/api/...` request.
    if (__DEV__ && typeof console !== "undefined") {
      console.warn(
        `[apiBase] EXPO_PUBLIC_API_URL "${apiUrl}" is missing a protocol; ignoring.`,
      );
    }
  }
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  if (domain) return `https://${domain.replace(/^https?:\/\//i, "").replace(/\/$/, "")}`;

  // Web-origin fallback: when the Expo web bundle is co-hosted with the API
  // at the same origin (Replit published deployment, Render monorepo, etc.),
  // relative /api/... paths already resolve correctly in the browser, but we
  // also need an explicit base so that:
  //   • the broadcast-sync WebSocket URL is not an empty string (which would
  //     silently prevent the WS from connecting at all), and
  //   • normalizeUrl() can convert relative storage paths to absolute URLs.
  // This fallback is safe on native because `window` is undefined there.
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }
  return "";
}
