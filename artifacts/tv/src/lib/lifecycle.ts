/**
 * Platform Lifecycle Manager — Temple TV Smart TV
 * ================================================
 * Handles app lifecycle events for Samsung Tizen, LG webOS, and Amazon Fire TV:
 *
 *  • Tizen: tizenhwkey (Exit key), AppControl (deep-link on relaunch),
 *           visibilitychange → stream pause/resume
 *  • webOS: webOSRelaunch (app re-opened from launcher), visibilitychange
 *  • Fire TV/generic: visibilitychange (browser tab/overlay hide)
 *
 * Usage:
 *   import { initLifecycle, onResumed, onSuspended, onDeepLink } from './lifecycle';
 *   initLifecycle();                              // call once on app mount
 *   const off = onResumed(() => player.reload()); // called after foreground resume
 */

import { isTizen, isWebOS } from "./platform";

type LifecycleCallback = () => void;
type DeepLinkCallback = (params: Record<string, string>) => void;

const resumeListeners: Set<LifecycleCallback> = new Set();
const suspendListeners: Set<LifecycleCallback> = new Set();
const deepLinkListeners: Set<DeepLinkCallback> = new Set();
const exitListeners: Set<LifecycleCallback> = new Set();

let initialized = false;

// ── Public subscription API ────────────────────────────────────────────────

export function onResumed(cb: LifecycleCallback): () => void {
  resumeListeners.add(cb);
  return () => resumeListeners.delete(cb);
}

export function onSuspended(cb: LifecycleCallback): () => void {
  suspendListeners.add(cb);
  return () => suspendListeners.delete(cb);
}

export function onDeepLink(cb: DeepLinkCallback): () => void {
  deepLinkListeners.add(cb);
  return () => deepLinkListeners.delete(cb);
}

export function onExit(cb: LifecycleCallback): () => void {
  exitListeners.add(cb);
  return () => exitListeners.delete(cb);
}

// ── Internal dispatch ──────────────────────────────────────────────────────

function dispatchResumed(): void {
  for (const cb of resumeListeners) {
    try { cb(); } catch {}
  }
}

function dispatchSuspended(): void {
  for (const cb of suspendListeners) {
    try { cb(); } catch {}
  }
}

function dispatchDeepLink(params: Record<string, string>): void {
  for (const cb of deepLinkListeners) {
    try { cb(params); } catch {}
  }
}

function dispatchExit(): void {
  for (const cb of exitListeners) {
    try { cb(); } catch {}
  }
}

// ── Tizen lifecycle ────────────────────────────────────────────────────────

function parseRequestedAppControl(requestedAppControl: any): Record<string, string> {
  const params: Record<string, string> = {};
  try {
    const data = requestedAppControl?.getExtraData?.("params");
    if (data) Object.assign(params, JSON.parse(data));
  } catch {}
  try {
    // Common Tizen launch params via application control data
    const operationResult = requestedAppControl?.getOperation?.();
    if (operationResult) params["operation"] = operationResult;
  } catch {}
  return params;
}

function initTizen(): void {
  // ── Exit key (Red / Exit button on Samsung remote) ────────────────────
  window.addEventListener("tizenhwkey", (e: Event) => {
    const keyEvent = e as any;
    if (keyEvent.keyName === "back") {
      // Let the React router handle back first; only exit if at root
      if (window.history.length <= 1) {
        dispatchExit();
        try { window.tizen?.application?.getCurrentApplication()?.exit(); } catch {}
      }
    }
    if (keyEvent.keyName === "menu") {
      // Optional: open app menu
    }
  });

  // ── AppControl: deep link when app is relaunched from smart hub card ──
  const tryHandleAppControl = () => {
    try {
      const tizen = (window as any).tizen;
      if (!tizen?.application) return;
      const requestedAppControl =
        tizen.application.getCurrentApplication().getRequestedAppControl?.();
      if (requestedAppControl) {
        const params = parseRequestedAppControl(requestedAppControl);
        if (Object.keys(params).length > 0) dispatchDeepLink(params);
      }
    } catch {}
  };
  tryHandleAppControl();

  // ── Visibility change → pause/resume streams ──────────────────────────
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      dispatchSuspended();
    } else {
      dispatchResumed();
    }
  });
}

// ── LG webOS lifecycle ─────────────────────────────────────────────────────

function initWebOS(): void {
  // ── webOSRelaunch: app was already running and user relaunches from launcher ──
  document.addEventListener("webOSRelaunch", (e: Event) => {
    const detail = (e as CustomEvent).detail as Record<string, string> | undefined;
    if (detail && Object.keys(detail).length > 0) {
      dispatchDeepLink(detail);
    }
    // Always resume on relaunch (e.g. user switched away and came back)
    dispatchResumed();
  });

  // ── Visibility change → pause/resume ─────────────────────────────────
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      dispatchSuspended();
    } else {
      dispatchResumed();
    }
  });

  // ── webOS.platformBack() for back-key to system ───────────────────────
  // The back-key handler in usePlatformInit calls window.history.back().
  // When history runs out, we call platformBack() to hand control to webOS.
  window.addEventListener("keydown", (e: KeyboardEvent) => {
    if ((e.keyCode === 461 || e.key === "GoBack") && window.history.length <= 1) {
      try { window.webOS?.platformBack?.(); } catch {}
    }
  });

  // ── Fetch and log app info once (useful for debugging in production) ──
  try {
    window.webOS?.fetchAppInfo?.((info) => {
      // Store for potential future use (version, vendor, etc.)
      (window as any).__webosAppInfo = info;
    });
  } catch {}
}

// ── Generic / Fire TV lifecycle ────────────────────────────────────────────

function initGeneric(): void {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      dispatchSuspended();
    } else {
      dispatchResumed();
    }
  });
}

// ── Public init (call once on app mount) ───────────────────────────────────

export function initLifecycle(): void {
  if (initialized) return;
  initialized = true;

  if (isTizen) {
    initTizen();
  } else if (isWebOS) {
    initWebOS();
  } else {
    initGeneric();
  }
}

// ── Stream reconnection helper ─────────────────────────────────────────────
// Call this with a reconnect callback to automatically re-initialise the stream
// after the app resumes from background (useful for HLS players).

export function registerStreamReconnect(reconnect: () => void): () => void {
  return onResumed(reconnect);
}
