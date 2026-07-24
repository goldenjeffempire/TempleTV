/**
 * navLogger — centralized navigation event tracer
 *
 * Tracks every router.push/replace attempt across the app:
 *  • Writes Sentry breadcrumbs for the session timeline
 *  • Captures failures as Sentry exceptions with full context
 *  • Maintains a 30-event ring buffer for local debug sessions
 *  • Logs to console in __DEV__ mode
 *
 * Usage:
 *   navLogger.logAttempt("/player", { isLive: "true" }, "hero-cta");
 *   navLogger.logSuccess("/player", elapsedMs, "hero-cta");
 *   navLogger.logFailure("/player", error, "hero-cta", 1);
 *
 * Consumers that need the ring buffer (e.g. a debug panel):
 *   const events = navLogger.getRecentEvents();
 */

const MAX_RING = 30;

export type NavEventType = "attempt" | "success" | "failure";

export interface NavEvent {
  type: NavEventType;
  pathname: string;
  params?: Record<string, unknown>;
  source: string;
  timestamp: number;
  elapsedMs?: number;
  error?: string;
  attempt?: number;
}

const _ring: NavEvent[] = [];

function _push(evt: NavEvent): void {
  _ring.push(evt);
  if (_ring.length > MAX_RING) _ring.shift();
}

function _sentry(evt: NavEvent): void {
  try {
    // Dynamic require keeps Sentry tree-shakeable and prevents crashes when
    // the module isn't linked (e.g. Expo Go or jest test environment).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const S = require("@sentry/react-native") as {
      addBreadcrumb: (b: object) => void;
      captureException: (e: unknown, ctx?: object) => void;
    };

    S.addBreadcrumb({
      category: "navigation",
      message: `[nav:${evt.type}] ${evt.pathname}`,
      level: evt.type === "failure" ? "error" : "info",
      data: {
        source: evt.source,
        params: evt.params,
        elapsedMs: evt.elapsedMs,
        attempt: evt.attempt,
        error: evt.error,
      },
      timestamp: evt.timestamp / 1000, // Sentry wants seconds
    });

    if (evt.type === "failure") {
      S.captureException(
        new Error(`Navigation failure → ${evt.pathname}: ${evt.error ?? "unknown"}`),
        {
          tags: {
            nav_source: evt.source,
            nav_route: evt.pathname,
            nav_attempt: String(evt.attempt ?? 1),
          },
          extra: {
            params: evt.params,
            recentNavEvents: _ring.slice(-10).map((e) => ({
              type: e.type,
              pathname: e.pathname,
              source: e.source,
              tsRelative: evt.timestamp - e.timestamp,
            })),
          },
          level: "error",
        },
      );
    }
  } catch {
    // Sentry unavailable (Expo Go, tests) — non-fatal
  }
}

export const navLogger = {
  /**
   * Call immediately before every router.push / router.replace.
   * Returns the event timestamp so callers can compute elapsed time.
   */
  logAttempt(
    pathname: string,
    params?: Record<string, unknown>,
    source = "unknown",
  ): number {
    const ts = Date.now();
    const evt: NavEvent = { type: "attempt", pathname, params, source, timestamp: ts };
    _push(evt);
    if (__DEV__) {
      console.log(`[nav:attempt] ${pathname}`, { source, params });
    }
    _sentry(evt);
    return ts;
  },

  /**
   * Call once the destination screen has confirmed mount (or immediately
   * after a successful synchronous router call if you don't have a mount
   * confirmation signal).
   */
  logSuccess(pathname: string, startTs: number, source = "unknown"): void {
    const elapsedMs = Date.now() - startTs;
    const evt: NavEvent = {
      type: "success",
      pathname,
      source,
      timestamp: Date.now(),
      elapsedMs,
    };
    _push(evt);
    if (__DEV__) {
      console.log(`[nav:success] ${pathname} in ${elapsedMs}ms`, { source });
    }
    _sentry(evt);
  },

  /**
   * Call in the catch block of a router.push/replace.
   */
  logFailure(
    pathname: string,
    error: unknown,
    source = "unknown",
    attempt = 1,
  ): void {
    const errMsg =
      error instanceof Error ? error.message : String(error ?? "unknown");
    const evt: NavEvent = {
      type: "failure",
      pathname,
      source,
      timestamp: Date.now(),
      error: errMsg,
      attempt,
    };
    _push(evt);
    // Always warn — failure is unconditional (not __DEV__ guarded).
    console.warn(`[nav:failure] attempt=${attempt} → ${pathname}`, {
      source,
      error: errMsg,
    });
    _sentry(evt);
  },

  /** Returns an immutable snapshot of the ring buffer for debugging. */
  getRecentEvents(): readonly NavEvent[] {
    return _ring;
  },
};
