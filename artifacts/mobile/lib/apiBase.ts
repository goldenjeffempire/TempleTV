/**
 * Canonical API base URL resolver for the mobile/web bundle.
 *
 * Resolution order:
 *   1. EXPO_PUBLIC_API_URL — explicit override. Set by EAS build profiles
 *      (production / preview / development) and production render.yaml.
 *      Takes precedence on every platform so EAS builds always hit the
 *      intended API endpoint.
 *   2. EXPO_PUBLIC_DOMAIN — explicit domain override for custom dev environments
 *      and native Expo Go. When the Expo dev server is accessed from a different
 *      port than the API, window.location.origin resolves to the Expo server,
 *      NOT the API server. EXPO_PUBLIC_DOMAIN overrides this to route API calls
 *      correctly regardless of which port the app is accessed from.
 *   3. window.location.origin — same-origin fallback for static deployments
 *      where the Expo web build is served directly by the API server and
 *      neither EXPO_PUBLIC_API_URL nor EXPO_PUBLIC_DOMAIN is set.
 *
 * Returns "" when none of the above yield a value, so callers can
 * early-return on no-op builds without throwing.
 *
 * Module-level cache: env vars are baked at bundle time on native (constant).
 * On web, window.location.origin is stable within a session.  The cache is
 * therefore safe and eliminates repeated string ops on the hot API call path.
 */
let _cachedBase: string | undefined;

export function getApiBase(): string {
  if (_cachedBase !== undefined) return _cachedBase;
  // 1. Explicit API URL — always wins (EAS build profiles, Render, production).
  const apiUrl = process.env.EXPO_PUBLIC_API_URL;
  if (apiUrl) {
    const trimmed = apiUrl.replace(/\/$/, "");
    if (/^https?:\/\//i.test(trimmed)) {
      _cachedBase = trimmed;
      return _cachedBase;
    }
    // Auto-fix: bare domain without a protocol prefix — assume https://.
    // This recovers from the common mistake of setting EXPO_PUBLIC_API_URL
    // to "api.templetv.org.ng" instead of "https://api.templetv.org.ng".
    // Failing silently here would make every API call fail on native with a
    // cryptic "Network request failed" error, so we fix and warn instead.
    // Guard with __DEV__ — production builds have the correct protocol set by
    // EAS build profiles and should not emit console noise on any mis-hit.
    if (__DEV__ && typeof console !== "undefined") {
      console.warn(
        `[apiBase] EXPO_PUBLIC_API_URL "${apiUrl}" is missing a protocol; ` +
        `auto-fixing with https://. Update the env var to silence this warning.`,
      );
    }
    _cachedBase = `https://${trimmed}`;
    return _cachedBase;
  }

  // 2. Explicit domain env var — covers custom dev environments and native Expo Go builds.
  // Must be checked before window.location.origin: when the Expo bundler serves
  // from a different port than the API, window.location.origin points to the
  // Expo dev server (returns HTML for /api/* paths). EXPO_PUBLIC_DOMAIN overrides
  // this so API calls route to the correct host.
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  if (domain) {
    _cachedBase = `https://${domain.replace(/^https?:\/\//i, "").replace(/\/$/, "")}`;
    return _cachedBase;
  }

  // 3. Same-origin fallback for static deployments where the Expo web build is
  // served directly by the API server (no EXPO_PUBLIC_DOMAIN set).
  // NOTE: window.location.origin is NOT cached — it is stable within any given
  // page load, but tests may reset window.location between cases.
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }

  // Native-only startup warning: if we reach here on a non-web platform,
  // push notifications, API calls, and WS connections will all fail silently
  // because every URL will be a bare path with no host. Emit once per module
  // load (the cache ensures subsequent calls skip this block) so developers
  // see it immediately rather than when the first request fails.
  if (
    __DEV__ &&
    typeof window === "undefined"
  ) {
    console.warn(
      "[apiBase] getApiBase() returned \"\" — no EXPO_PUBLIC_API_URL or EXPO_PUBLIC_DOMAIN set.\n" +
      "All API calls will use bare paths and fail on native. Set one of:\n" +
      "  EXPO_PUBLIC_API_URL=https://api.templetv.org.ng  (production / preview / device builds)\n" +
      "  EXPO_PUBLIC_API_URL=http://10.0.2.2:8080         (Android emulator, dev profile)\n" +
      "  EXPO_PUBLIC_DOMAIN=<your-dev-server-domain>      (custom dev environment)",
    );
  }

  _cachedBase = "";
  return _cachedBase;
}
