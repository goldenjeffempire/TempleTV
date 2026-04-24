/**
 * Single source of truth for the API base URL used by the admin SPA.
 *
 * In dev (and any deployment where the admin SPA and API are served from the
 * same origin via path-routing) this resolves to a relative `/api` path so the
 * browser stays same-origin and cookies/credentials work without CORS.
 *
 * In a split-domain production setup (e.g. admin.templetv.org.ng for the
 * static SPA + api.templetv.org.ng for the API server), the build must set
 * `VITE_API_BASE_URL` (e.g. `https://api.templetv.org.ng`). The value may
 * include or omit a trailing slash; we normalize.
 *
 * Without this override the SPA's `/api/...` calls resolve to the static
 * admin host, where the catch-all SPA rewrite returns `index.html` for every
 * path. XHR-based uploads then "succeed" with a 200 status whose body is
 * HTML, masking the misconfiguration. See uploadEngine.ts for the
 * defensive JSON-content validation that rejects that case at the network
 * layer regardless of whether the override is set.
 */
const RAW_OVERRIDE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim();

const ABSOLUTE_BASE = RAW_OVERRIDE
  ? RAW_OVERRIDE.replace(/\/+$/, "")
  : null;

const RELATIVE_BASE = (() => {
  const b = import.meta.env.BASE_URL.replace(/\/$/, "").replace(/\/admin\/?$/, "");
  return b;
})();

/**
 * Returns the API root, with no trailing slash. Examples:
 *   apiBase() === "/api"                                 (dev / same-origin)
 *   apiBase() === "https://api.templetv.org.ng/api"      (split-domain prod)
 */
export function apiBase(): string {
  return ABSOLUTE_BASE ? `${ABSOLUTE_BASE}/api` : `${RELATIVE_BASE}/api`;
}

/** Convenience: build a full API URL from a relative path that begins with `/`. */
export function apiUrl(pathStartingWithSlash: string): string {
  if (!pathStartingWithSlash.startsWith("/")) {
    throw new Error(`apiUrl path must start with '/': ${pathStartingWithSlash}`);
  }
  return `${apiBase()}${pathStartingWithSlash}`;
}

/**
 * Rewrites a legacy `/api/...` path so it points at the configured API origin.
 * Returns the input unchanged if it doesn't start with `/api/`.
 *
 * Used by call sites that historically embedded `/api/...` directly. Lets us
 * fix the routing without touching every call-site URL string.
 */
export function rewriteApiPath(maybeApiPath: string): string {
  if (!maybeApiPath.startsWith("/api/") && maybeApiPath !== "/api") {
    return maybeApiPath;
  }
  const tail = maybeApiPath.slice(4); // strip leading "/api"
  return `${apiBase()}${tail}`;
}
