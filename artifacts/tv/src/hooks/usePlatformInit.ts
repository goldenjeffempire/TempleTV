/**
 * usePlatformInit — Smart TV platform bootstrap
 * ================================================
 * Runs once on app mount. Handles:
 *  • Tizen media-key registration (colour/media/exit keys)
 *  • LG webOS back-key and Magic Remote hover→focus
 *  • Platform lifecycle (suspend/resume) via lifecycle.ts
 *  • Scroll prevention (D-pad arrows should not scroll the page)
 *  • Context-menu suppression
 *  • data-tv attribute for CSS platform selectors
 */

import { useEffect } from "react";
import { isTizen, isWebOS } from "../lib/platform";
import { initLifecycle } from "../lib/lifecycle";

declare global {
  interface Window {
    tizen?: {
      tvinputdevice: {
        registerKey: (name: string) => void;
        unregisterKey: (name: string) => void;
        getSupportedKeys: () => Array<{ name: string; code: number }>;
      };
      application?: {
        getCurrentApplication: () => {
          exit: () => void;
          getRequestedAppControl?: () => unknown;
        };
      };
    };
    webOS?: {
      fetchAppInfo: (callback: (info: Record<string, string>) => void) => void;
      platformBack: () => void;
    };
    webOSDev?: unknown;
  }
}

// Keys to register on Tizen (Samsung remote color/media/number keys).
const TIZEN_MEDIA_KEYS = [
  "MediaPlayPause", "MediaPlay", "MediaPause", "MediaStop",
  "MediaFastForward", "MediaRewind", "MediaTrackPrevious", "MediaTrackNext",
  "ColorF0Red", "ColorF1Green", "ColorF2Yellow", "ColorF3Blue",
  "Exit", "Info", "Menu",
  "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
];

function registerTizenKeys(): void {
  if (!window.tizen?.tvinputdevice) return;
  const supported = new Set(
    window.tizen.tvinputdevice.getSupportedKeys().map((k) => k.name),
  );
  for (const key of TIZEN_MEDIA_KEYS) {
    if (supported.has(key)) {
      try { window.tizen.tvinputdevice.registerKey(key); } catch { /* already registered */ }
    }
  }
}

// Each register* helper now returns a teardown closure so the calling
// useEffect can cleanly remove the listener it added. Without this, hot-
// reload (Vite HMR) and any future code path that re-mounts the App root
// would stack duplicate handlers on `document`, leaking handler closures
// and double-firing every preventDefault on every keypress.
function suppressContextMenu(): () => void {
  const handler = (e: Event) => e.preventDefault();
  document.addEventListener("contextmenu", handler, { capture: true });
  return () => document.removeEventListener("contextmenu", handler, { capture: true });
}

function preventDefaultTVScrolling(): () => void {
  const handler = (e: KeyboardEvent) => {
    if ([37, 38, 39, 40].includes(e.keyCode)) e.preventDefault();
  };
  document.addEventListener("keydown", handler, { capture: true, passive: false });
  return () => document.removeEventListener("keydown", handler, { capture: true });
}

/**
 * LG Magic Remote — Pointer → Focus
 * ====================================
 * LG's Magic Remote has a laser-pointer cursor. Elements that receive
 * `mouseover` while the cursor is active should receive keyboard focus so
 * the D-pad navigation system stays in sync.
 *
 * Strategy: any element with tabIndex >= 0 (or role=button) that receives a
 * mouseover fires .focus() — this lets SermonCard and button elements
 * auto-focus when hovered by the Magic Remote pointer.
 *
 * We only enable this on webOS to avoid interfering with mouse users on
 * desktop/generic browsers.
 */
function initMagicRemoteHoverFocus(): void {
  if (!isWebOS) return;

  let pointerVisible = false;

  // webOS fires a "cursorStateChange" custom event when the Magic Remote
  // pointer appears/disappears (the user puts it down or picks it up).
  document.addEventListener("cursorStateChange", (e: Event) => {
    pointerVisible = (e as CustomEvent).detail?.visibility ?? false;
  });

  document.addEventListener(
    "mouseover",
    (e: MouseEvent) => {
      // Only honour hover→focus when the pointer is visible.
      // Without this, touch/keyboard navigation triggers spurious focus changes.
      if (!pointerVisible) return;
      const el = e.target as HTMLElement | null;
      if (!el) return;
      // Walk up the DOM to find the nearest focusable ancestor (including the
      // element itself) — this handles nested SVGs and img tags inside cards.
      let node: HTMLElement | null = el;
      while (node && node !== document.body) {
        const ti = parseInt(node.getAttribute("tabindex") ?? "-1", 10);
        const role = node.getAttribute("role");
        if (ti >= 0 || role === "button" || node.tagName === "BUTTON" || node.tagName === "A") {
          node.focus({ preventScroll: true });
          break;
        }
        node = node.parentElement;
      }
    },
    { capture: false, passive: true },
  );
}

export function usePlatformInit(): void {
  useEffect(() => {
    // ── Universal ────────────────────────────────────────────────────────
    const teardownContextMenu = suppressContextMenu();
    const teardownTVScrolling = preventDefaultTVScrolling();

    // ── Tizen ────────────────────────────────────────────────────────────
    if (isTizen) {
      registerTizenKeys();
    }

    // ── LG webOS ─────────────────────────────────────────────────────────
    let teardownWebOSBack: (() => void) | null = null;
    if (isWebOS) {
      // Back key → system if no more history. Capture the handler in a named
      // const so the cleanup can remove the exact same reference (anonymous
      // arrow functions cannot be removed).
      const backHandler = (e: KeyboardEvent) => {
        if (e.keyCode === 461 || e.key === "GoBack") {
          e.preventDefault();
          window.history.back();
        }
      };
      document.addEventListener("keydown", backHandler);
      teardownWebOSBack = () => document.removeEventListener("keydown", backHandler);
      initMagicRemoteHoverFocus();
    }

    // ── Platform lifecycle (suspend / resume / deep-links) ────────────────
    initLifecycle();

    // ── CSS data attribute for platform-specific styles ───────────────────
    document.documentElement.setAttribute(
      "data-tv",
      isTizen ? "tizen" : isWebOS ? "webos" : "generic",
    );

    // Cleanup on unmount (HMR re-mount, or future App-level teardown). The
    // Magic Remote hover→focus listeners and the lifecycle subscriber are
    // process-lifetime by design and don't need teardown — once the TV app
    // is running, those are always-on.
    return () => {
      teardownContextMenu();
      teardownTVScrolling();
      teardownWebOSBack?.();
    };
  }, []);
}
