import { useEffect } from "react";
import { isTizen, isWebOS } from "../lib/platform";

declare global {
  interface Window {
    tizen?: {
      tvinputdevice: {
        registerKey: (name: string) => void;
        unregisterKey: (name: string) => void;
        getSupportedKeys: () => Array<{ name: string; code: number }>;
      };
    };
    webOS?: {
      fetchAppInfo: (callback: (info: Record<string, string>) => void) => void;
      platformBack: () => void;
    };
    webOSDev?: unknown;
  }
}

const TIZEN_MEDIA_KEYS = [
  "MediaPlayPause",
  "MediaPlay",
  "MediaPause",
  "MediaStop",
  "MediaFastForward",
  "MediaRewind",
  "MediaTrackPrevious",
  "MediaTrackNext",
  "ColorF0Red",
  "ColorF1Green",
  "ColorF2Yellow",
  "ColorF3Blue",
  "Exit",
  "Info",
  "Menu",
  "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
];

function registerTizenKeys(): void {
  if (!window.tizen?.tvinputdevice) return;
  const supported = new Set(
    window.tizen.tvinputdevice.getSupportedKeys().map((k) => k.name),
  );
  for (const key of TIZEN_MEDIA_KEYS) {
    if (supported.has(key)) {
      try {
        window.tizen.tvinputdevice.registerKey(key);
      } catch {
        // Key may already be registered — safe to ignore.
      }
    }
  }
}

function suppressContextMenu(): void {
  document.addEventListener("contextmenu", (e) => e.preventDefault(), {
    capture: true,
  });
}

function preventDefaultTVScrolling(): void {
  document.addEventListener(
    "keydown",
    (e) => {
      if ([37, 38, 39, 40].includes(e.keyCode)) {
        e.preventDefault();
      }
    },
    { capture: true, passive: false },
  );
}

export function usePlatformInit(): void {
  useEffect(() => {
    suppressContextMenu();
    preventDefaultTVScrolling();

    if (isTizen) {
      registerTizenKeys();
    }

    if (isWebOS) {
      document.addEventListener("keydown", (e) => {
        if (e.keyCode === 461 || e.key === "GoBack") {
          e.preventDefault();
          window.history.back();
        }
      });
    }

    document.documentElement.setAttribute(
      "data-tv",
      isTizen ? "tizen" : isWebOS ? "webos" : "generic",
    );
  }, []);
}
