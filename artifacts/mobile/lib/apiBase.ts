/**
 * Canonical API base URL resolver for the mobile/web bundle.
 *
 * Resolution order:
 *   1. EXPO_PUBLIC_API_URL — explicit override. Set by EAS build profiles
 *      (production / preview / development) and production render.yaml.
 *      Takes precedence on every platform so EAS builds always hit the
 *      intended API endpoint.
 *   2. window.location.origin — web runtime only. When the Expo web bundle
 *      is co-hosted with the API server (Replit dev proxy, published
 *      deployment, Render monorepo) the browser's own origin is always the
 *      correct same-origin base — even when EXPO_PUBLIC_DOMAIN is set to
 *      a domain on a different port. Evaluated before EXPO_PUBLIC_DOMAIN so
 *      Replit's per-port dev-domain never shadows the live origin.
 *   3. EXPO_PUBLIC_DOMAIN — legacy env for native Expo Go builds. Used when
 *      EXPO_PUBLIC_API_URL is absent and there is no browser window (native).
 *
 * Returns "" when none of the above yield a value, so callers can
 * early-return on no-op builds without throwing.
 */
export function getApiBase(): string {
  const apiUrl = process.env.EXPO_PUBLIC_API_URL;
  if (apiUrl) {
    const trimmed = apiUrl.replace(/\/$/, "");
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    // Common mistake: someone set EXPO_PUBLIC_API_URL to a bare domain.
    // Fall through to the window.location branch rather than emit a
    // malformed `api.example.com/api/...` request.
    if (__DEV__ && typeof console !== "undefined") {
      console.warn(
        `[apiBase] EXPO_PUBLIC_API_URL "${apiUrl}" is missing a protocol; ignoring.`,
      );
    }
  }

  // Web-origin fallback: use the browser's own origin so that API calls are
  // always same-origin when the bundle is served by the API server. This is
  // correct for Replit dev (API server on port 8080 proxies /mobile/* to the
  // Expo dev server; window.location.origin = the API server's domain),
  // published deployments, and Render monorepos. Must come before
  // EXPO_PUBLIC_DOMAIN so a mismatched dev-domain env var doesn't shadow it.
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }

  // Native fallback: no window available — use the explicit domain env var.
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  if (domain) return `https://${domain.replace(/^https?:\/\//i, "").replace(/\/$/, "")}`;

  return "";
}
