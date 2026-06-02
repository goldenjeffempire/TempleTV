/**
 * Single source of truth for the API base URL used by the admin SPA.
 *
 * In dev (and any deployment where the admin SPA and API are served from the
 * same origin via path-routing) this resolves to a relative `/api` path so the
 * browser stays same-origin and cookies/credentials work without CORS.
 *
 * In a split-domain production setup (e.g. a separate API host), the build
 * SHOULD set `VITE_API_BASE_URL` OR `VITE_API_URL` to the API origin
 * (e.g. `https://admin.templetv.org.ng`). The canonical unified deployment
 * serves both the SPA and the API from admin.templetv.org.ng on the same
 * origin, in which case no override is needed.
 * Both names are accepted to tolerate variation in deployment env-var naming
 * conventions. The value may include or omit a trailing slash; we normalize.
 * Either name may also include or omit a trailing `/api` path component —
 * we strip it so callers always see a normalized origin-only base.
 *
 * Without this override the SPA's `/api/...` calls would resolve to the
 * static admin host, where the catch-all SPA rewrite returns `index.html`
 * for every path. To prevent that misconfiguration from breaking the entire
 * admin console (the AuthGate's first /api call returns HTML, retries
 * forever, and the page never advances past "Verifying admin access..."),
 * we infer the API origin from the SPA hostname when no override is set:
 * a hostname beginning with `admin.` is rewritten to `api.<rest>` (a
 * convention that matches how the production deploy is laid out). Explicit
 * overrides always win.
 *
 * See uploadEngine.ts for the defensive JSON-content validation that
 * rejects HTML-from-SPA-fallback responses at the network layer regardless
 * of whether the override is set.
 */
const RAW_OVERRIDE = (
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ??
  (import.meta.env.VITE_API_URL as string | undefined)
)?.trim();

// Which env var name was actually used (for diagnostic messages).
const ACTIVE_ENV_VAR_NAME: string | null = import.meta.env.VITE_API_BASE_URL
  ? "VITE_API_BASE_URL"
  : import.meta.env.VITE_API_URL
  ? "VITE_API_URL"
  : null;

function inferProductionApiOrigin(): string | null {
  // SSR/Node contexts have no window; relative paths are correct there.
  if (typeof window === "undefined") return null;
  const { hostname } = window.location;
  // Convention: a host of `admin.<domain>` implies the API lives at
  // `api.<domain>`. Only triggered when the hostname literally begins with
  // `admin.` so dev URLs (replit-dev domains, localhost, path-routed
  // workspace previews) keep using the relative same-origin /api path.
  //
  // Explicitly excluded: *.replit.dev and *.worf.replit.dev — Replit's dev
  // proxy may assign a subdomain beginning with "admin" to the admin artifact,
  // but the Vite dev server already proxies /api → localhost:5000, so we must
  // use the relative path here rather than rewriting to api.templetv.org.ng.
  // NOTE: The canonical production domain is admin.templetv.org.ng which
  // serves BOTH the admin SPA and the API on the same origin — no cross-origin
  // rewrite is needed. The old admin.* → api.* inference was for a deprecated
  // split-domain Render setup and has been removed. When the SPA is served at
  // admin.templetv.org.ng, all /api/* calls resolve to the same host correctly
  // via the relative base. Set VITE_API_BASE_URL explicitly for any
  // non-unified deployment where the API lives on a separate subdomain.

  // Legacy fallback: deprecated Render auto-generated admin service URLs.
  // These point at admin.templetv.org.ng (the canonical unified domain).
  if (/(^|\.)temple-tv-admin[^.]*\.onrender\.com$/i.test(hostname)) {
    return "https://admin.templetv.org.ng";
  }
  return null;
}

const INFERRED_ORIGIN = !RAW_OVERRIDE ? inferProductionApiOrigin() : null;

const ABSOLUTE_BASE = RAW_OVERRIDE
  ? RAW_OVERRIDE
      .replace(/\/+$/, "")        // strip trailing slashes
      .replace(/\/api$/, "")      // strip trailing /api so callers can supply either form
  : INFERRED_ORIGIN;

const RELATIVE_BASE = (() => {
  const b = import.meta.env.BASE_URL.replace(/\/$/, "").replace(/\/admin\/?$/, "");
  return b;
})();

// ── Diagnostic metadata ─────────────────────────────────────────────────────
// Exposed for the startup logger in `main.tsx`. Computed once at module
// init so the warning fires even if nothing calls apiBase() early enough.

export type ApiBaseSource =
  /** VITE_API_BASE_URL or VITE_API_URL was set at build time — most reliable. */
  | "env-var"
  /** No env var set; hostname began with `admin.` so origin was inferred. */
  | "inferred"
  /** Dev / same-origin: all /api calls go to the same host. */
  | "relative";

export interface ApiBaseInfo {
  /** The fully-resolved API root (no trailing slash). */
  resolvedBase: string;
  /** How the base URL was determined. */
  source: ApiBaseSource;
  /** The env var name that supplied the value, or null when not from an env var. */
  envVarName: string | null;
  /** The hostname that triggered inference, or null when not inferred. */
  inferredFromHostname: string | null;
}

export function getApiBaseInfo(): ApiBaseInfo {
  const resolvedBase = ABSOLUTE_BASE ? `${ABSOLUTE_BASE}/api` : `${RELATIVE_BASE}/api`;
  if (RAW_OVERRIDE) {
    return {
      resolvedBase,
      source: "env-var",
      envVarName: ACTIVE_ENV_VAR_NAME,
      inferredFromHostname: null,
    };
  }
  if (INFERRED_ORIGIN) {
    return {
      resolvedBase,
      source: "inferred",
      envVarName: null,
      inferredFromHostname: typeof window !== "undefined" ? window.location.hostname : null,
    };
  }
  return {
    resolvedBase,
    source: "relative",
    envVarName: null,
    inferredFromHostname: null,
  };
}

/**
 * Returns the API root, with no trailing slash. Examples:
 *   apiBase() === "/api"                                 (dev / same-origin)
 *   apiBase() === "https://admin.templetv.org.ng/api"     (split-domain prod)
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
