/**
 * Canonical API base URL resolver for the mobile/web bundle.
 *
 * Resolution order:
 *   1. EXPO_PUBLIC_API_URL — explicit override. Set by EAS build profiles
 *      (production / preview / development) and production render.yaml.
 *      Takes precedence on every platform so EAS builds always hit the
 *      intended API endpoint.
 *   2. EXPO_PUBLIC_DOMAIN — preferred env for Replit dev and native Expo Go.
 *      When the Expo dev server is accessed directly at its own port (e.g.
 *      port 18115 in Replit), window.location.origin resolves to the Expo
 *      server, NOT the API server. EXPO_PUBLIC_DOMAIN is set by the dev
 *      script to REPLIT_DEV_DOMAIN (the main Replit domain) which proxies
 *      /api/* through to the API server on port 8080. Checking this before
 *      window.location.origin ensures the correct API URL regardless of
 *      which port the app is accessed from.
 *   3. window.location.origin — same-origin fallback for static deployments
 *      where the Expo web build is served directly by the API server and
 *      neither EXPO_PUBLIC_API_URL nor EXPO_PUBLIC_DOMAIN is set.
 *
 * Returns "" when none of the above yield a value, so callers can
 * early-return on no-op builds without throwing.
 */
export function getApiBase(): string {
  // 1. Explicit API URL — always wins (EAS build profiles, Render, production).
  const apiUrl = process.env.EXPO_PUBLIC_API_URL;
  if (apiUrl) {
    const trimmed = apiUrl.replace(/\/$/, "");
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    // Common mistake: someone set EXPO_PUBLIC_API_URL to a bare domain.
    if (__DEV__ && typeof console !== "undefined") {
      console.warn(
        `[apiBase] EXPO_PUBLIC_API_URL "${apiUrl}" is missing a protocol; ignoring.`,
      );
    }
  }

  // 2. Explicit domain env var — covers Replit dev + native Expo Go builds.
  // Must be checked before window.location.origin: in Replit dev the Expo
  // bundler serves from a different port than the API, so window.location.origin
  // points to the Expo dev server (returns HTML for /api/* paths).
  // EXPO_PUBLIC_DOMAIN = REPLIT_DEV_DOMAIN, whose port-80 vhost proxies /api/*
  // to the API server, giving correct JSON responses.
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  if (domain) return `https://${domain.replace(/^https?:\/\//i, "").replace(/\/$/, "")}`;

  // 3. Same-origin fallback for static deployments where the Expo web build is
  // served directly by the API server (no EXPO_PUBLIC_DOMAIN set).
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }

  return "";
}
