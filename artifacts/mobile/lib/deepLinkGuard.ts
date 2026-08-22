/**
 * Known app paths — any incoming deep-link whose pathname starts with one
 * of these is a valid app route. Everything else is a web-only path that may
 * have opened the app through Android's broad pathPrefix "/" intent filter.
 */
const KNOWN_APP_PATH_PREFIXES = [
  "/channels",
  "/library",
  "/player",
  "/live",
  "/video",
  "/search",
  "/playlists",
  "/series",
  "/favorites",
  "/history",
  "/watch-later",
  "/downloads",
  "/notifications",
  "/login",
  "/signup",
  "/donate",
  "/settings",
  "/radio",
  "/account",
  "/change-password",
  "/forgot-password",
  "/reset-password",
  "/link",
  "/contact",
];

/** Returns true when the pathname could be an in-app route. */
export function isKnownAppPath(pathname: string): boolean {
  if (pathname === "/" || pathname === "") return true;
  return KNOWN_APP_PATH_PREFIXES.some((prefix) =>
    pathname === prefix || pathname.startsWith(prefix + "/"),
  );
}

/**
 * Convert an initial/incoming URL into the pathname Expo Router will treat as
 * the app route. Standard URL parsing stores `templetv://player` in the
 * hostname with an empty pathname, so the custom scheme needs the hostname
 * folded back into the route.
 */
export function getAppPathFromUrl(url: string): string {
  const parsed = new URL(url);
  const pathname = parsed.pathname ?? "";

  if (parsed.protocol.toLowerCase() === "templetv:") {
    const hostPath = parsed.hostname ? `/${parsed.hostname}` : "";
    return `${hostPath}${pathname}` || "/";
  }

  return pathname || "/";
}

/**
 * Unknown-link recovery must never overwrite a valid in-app route or an
 * in-flight user navigation. It is only needed when Expo Router has actually
 * landed on an unknown path and the app needs to recover to Home.
 */
export function shouldRecoverUnknownDeepLink(
  currentPathname: string,
  navigationPushActive: boolean,
): boolean {
  return !navigationPushActive && !isKnownAppPath(currentPathname);
}