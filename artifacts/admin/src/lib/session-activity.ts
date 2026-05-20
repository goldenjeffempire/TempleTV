/**
 * Session keep-alive monitor — upload-aware.
 *
 * Tokens live in `sessionStorage`, so closing the tab/window already ends
 * the session naturally. While the tab is open we keep the access JWT
 * refreshed forever — there is no inactivity timeout. The admin is only
 * logged out by:
 *   • closing the tab/browser (sessionStorage drops the tokens), or
 *   • explicitly clicking "Sign out", or
 *   • the refresh token being genuinely revoked by the server (hard 401/403
 *     from /auth/refresh) AND the BroadcastChannel grace period expired
 *     without a sibling tab delivering fresh tokens, AND no uploads are
 *     running.
 *
 * Behaviour
 * ─────────
 * • A periodic timer calls ensureFreshToken() so the access JWT stays
 *   valid even if the admin walks away and the tab sits idle overnight.
 *
 * • The interval cadence is upload-aware:
 *     - idle:      REFRESH_INTERVAL_IDLE_MS   = 3 min  (reduced from 5 min
 *                                                       to give more buffer
 *                                                       vs browser throttling)
 *     - uploading: REFRESH_INTERVAL_UPLOAD_MS = 60 s   (fast cadence for
 *                                                       active transfers)
 *
 * • ensureFreshToken() uses an 8-minute proactive threshold (see api.ts).
 *   Combined with the 3-minute check interval, the access token is refreshed
 *   well before it expires even when the browser throttles background timers
 *   to fire once per minute (standard Chrome behaviour).
 *
 * • Any user gesture triggers a throttled pulse (max once / 30 s).
 *
 * • Visibility restore: when the tab returns to the foreground, a refresh
 *   check fires IMMEDIATELY and the periodic interval is rescheduled from
 *   now, preventing a stale token from surviving an extended background stay.
 *
 * • Network recovery: an `online` event triggers an immediate refresh check
 *   so the session is verified the moment connectivity is restored.
 *
 * • While uploads are active:
 *     - `beforeunload` is armed so the browser warns before closing the tab.
 *     - The api layer (api.ts) suppresses ttv:auth-expired and defers the
 *       hard-logout until after the transfer completes.
 *
 * Public API
 * ──────────
 *   startSessionActivity()   — start keep-alive, returns stop()
 *   notifyUploadActivity()   — opportunistic refresh pulse (legacy alias)
 *   setUploadActive(active)  — wire upload-queue → session lifecycle
 *   isUploadActive()         — read flag (used by api.ts probe)
 */

import { ensureFreshToken, tokenStore, registerUploadActiveProbe } from "./api";

// Wire the upload-active probe into the api layer so the request() 401 path
// can shield the session from a hard logout while uploads are in flight.
// Module-level so it runs once on first import — before any component mounts.
registerUploadActiveProbe(() => _uploadActive);

// ── Timing constants ──────────────────────────────────────────────────────────
//
// IDLE interval reduced from 5 min → 3 min. Combined with ensureFreshToken()'s
// 8-minute proactive threshold (was 5 min), there are now at least 2–3 check
// opportunities before a token ever reaches its expiry window. This survives
// Chrome's 1-minute background timer throttle with plenty of margin.
const REFRESH_INTERVAL_IDLE_MS   = 3 * 60 * 1000;  // 3 minutes
const REFRESH_INTERVAL_UPLOAD_MS = 60 * 1000;       // 60 seconds during uploads
const REFRESH_THROTTLE_MS        = 30 * 1000;       // pulse: at most once / 30 s

const WATCHED_EVENTS = [
  "mousedown",
  "keydown",
  "scroll",
  "click",
  "touchstart",
  "pointermove",
] as const;

let stopFn: (() => void) | null = null;
let _intervalTimer: ReturnType<typeof setInterval> | null = null;
let _lastRefreshAt = 0;
let _uploadActive = false;
let _beforeUnloadHandler: ((e: BeforeUnloadEvent) => void) | null = null;

export function notifyUploadActivity(): void {
  if (stopFn) _pulse();
}

export function isUploadActive(): boolean {
  return _uploadActive;
}

/**
 * Called by the upload-queue whenever its active+pending count crosses
 * the zero boundary. Switches the refresh cadence and arms/disarms the
 * `beforeunload` guard.
 */
export function setUploadActive(active: boolean): void {
  if (_uploadActive === active) return;
  _uploadActive = active;

  // Re-arm the interval at the new cadence so a long idle wait does not
  // delay the first fast-mode tick.
  if (_intervalTimer !== null) {
    clearInterval(_intervalTimer);
    const ms = active ? REFRESH_INTERVAL_UPLOAD_MS : REFRESH_INTERVAL_IDLE_MS;
    _intervalTimer = setInterval(_refresh, ms);
    // Force one immediate refresh on entering upload mode so we start
    // the transfer with maximally fresh credentials.
    if (active) _refresh();
  }

  if (typeof window === "undefined") return;
  if (active && !_beforeUnloadHandler) {
    _beforeUnloadHandler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "Uploads are still in progress. Closing this tab will interrupt them.";
      return e.returnValue;
    };
    window.addEventListener("beforeunload", _beforeUnloadHandler);
  } else if (!active && _beforeUnloadHandler) {
    window.removeEventListener("beforeunload", _beforeUnloadHandler);
    _beforeUnloadHandler = null;
  }
}

function _refresh(): void {
  if (!tokenStore.getAccess()) return;
  _lastRefreshAt = Date.now();
  ensureFreshToken().catch(() => {
    // Non-fatal: network failures and transient server errors are swallowed
    // here. Hard auth failures (genuine 401/403 from /auth/refresh) surface
    // via the ttv:auth-expired event dispatched inside api.ts — only after
    // the BroadcastChannel grace period confirms no sibling tab has fresh
    // tokens, and only when no uploads are active.
  });
}

function _pulse(): void {
  const now = Date.now();
  if (now - _lastRefreshAt < REFRESH_THROTTLE_MS) return;
  _refresh();
}

// Reschedule the periodic interval, starting the countdown from now.
// Called after a forced refresh (visibility restore, online event) so the
// next scheduled tick is a full interval away — prevents a "double tick"
// where the forced refresh and the regular interval both fire within seconds.
function _rescheduleInterval(): void {
  if (_intervalTimer === null) return;
  clearInterval(_intervalTimer);
  const ms = _uploadActive ? REFRESH_INTERVAL_UPLOAD_MS : REFRESH_INTERVAL_IDLE_MS;
  _intervalTimer = setInterval(_refresh, ms);
}

export function startSessionActivity(): () => void {
  if (stopFn) return stopFn;

  _lastRefreshAt = 0;

  const ms = _uploadActive ? REFRESH_INTERVAL_UPLOAD_MS : REFRESH_INTERVAL_IDLE_MS;
  _intervalTimer = setInterval(_refresh, ms);

  const gestureHandler = () => _pulse();
  for (const ev of WATCHED_EVENTS) {
    document.addEventListener(ev, gestureHandler, { passive: true, capture: true });
  }

  // ── Visibility restore ─────────────────────────────────────────────────────
  //
  // Background tabs are subject to aggressive timer throttling:
  //   Chrome: minimum 1-second, but often 1-minute for timers > 30 s
  //   Safari: even more restrictive; may suspend timers entirely
  //   Firefox: similar to Chrome
  //
  // When the tab returns to the foreground we therefore fire a refresh
  // immediately (don't wait for the next scheduled tick, which could be
  // minutes away) AND reschedule the interval from now so the next tick
  // is a full 3 minutes in the future instead of arriving seconds later.
  const onVisible = () => {
    if (document.visibilityState !== "visible") return;
    _refresh();
    _rescheduleInterval();
  };
  document.addEventListener("visibilitychange", onVisible);

  // ── Network recovery ───────────────────────────────────────────────────────
  //
  // When the device loses and regains connectivity the token may have silently
  // expired while the network was down and the keep-alive couldn't reach the
  // server. An immediate refresh check on `online` ensures the session is
  // validated the moment the network comes back.
  const onOnline = () => {
    _refresh();
    _rescheduleInterval();
  };
  window.addEventListener("online", onOnline);

  const stop = () => {
    if (_intervalTimer !== null) {
      clearInterval(_intervalTimer);
      _intervalTimer = null;
    }
    for (const ev of WATCHED_EVENTS) {
      document.removeEventListener(ev, gestureHandler, { capture: true });
    }
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("online", onOnline);
    if (_beforeUnloadHandler) {
      window.removeEventListener("beforeunload", _beforeUnloadHandler);
      _beforeUnloadHandler = null;
    }
    stopFn = null;
  };

  stopFn = stop;
  return stop;
}
