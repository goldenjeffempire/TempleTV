// Round 4h: theme management.
//
// The original design was time-of-day auto theming: light during operator
// daytime hours, dark ("midnight") after 8pm or before 6am, refreshed once a
// minute. Round 4h adds an explicit mode override on top of that — operators
// who want to lock light or dark (e.g. a control-room console with a fixed
// dim/bright environment) can do so via the badge in the layout header. The
// stored choice persists across sessions in localStorage and survives the
// 60-second auto-refresh interval.
//
// Modes:
//   - "auto"  → falls back to time-of-day detection (legacy behavior)
//   - "light" → forces the light theme
//   - "dark"  → forces the dark/midnight theme
//
// `applyAutoTheme()` honors the stored mode without breaking any caller —
// existing call sites in App.tsx don't need to change.

const STORAGE_KEY = "temple-tv-admin-theme-mode";

export type ThemeMode = "auto" | "light" | "dark";

export function getLocalHour() {
  return new Date().getHours();
}

export function isMidnightHour(hour = getLocalHour()) {
  return hour >= 20 || hour < 6;
}

export function getLocalTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "Local time";
  }
}

export function getThemeMode(): ThemeMode {
  if (typeof window === "undefined") return "auto";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "auto") return stored;
  } catch {
    // localStorage may throw in private mode / cross-origin iframes; fall back.
  }
  return "auto";
}

export function setThemeMode(mode: ThemeMode): void {
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, mode);
      // Notify other tabs / hooks listening for the override.
      window.dispatchEvent(new CustomEvent("temple-tv-theme-mode-changed", { detail: mode }));
    }
  } catch {
    // Best-effort; ignore quota / permission errors.
  }
  applyAutoTheme();
}

/**
 * Apply the active theme to the document.
 *
 * - When mode is "auto", falls back to time-of-day detection (legacy behavior
 *   so the existing 60s polling tick keeps working without modification).
 * - When mode is "light" or "dark", honors the stored override.
 *
 * Returns the resolved theme name ("midnight" or "light") so callers that
 * want to render an icon can use the result directly.
 */
export function applyAutoTheme(): "midnight" | "light" {
  const mode = getThemeMode();
  let resolved: "midnight" | "light";
  if (mode === "light") resolved = "light";
  else if (mode === "dark") resolved = "midnight";
  else resolved = isMidnightHour() ? "midnight" : "light";

  if (typeof document !== "undefined") {
    document.documentElement.classList.toggle("dark", resolved === "midnight");
    document.documentElement.dataset.theme = resolved;
  }
  return resolved;
}

/**
 * Compute the next mode in the cycle: auto → light → dark → auto.
 * Centralized so the toggle button and any future keyboard shortcut stay
 * in sync.
 */
export function nextThemeMode(current: ThemeMode): ThemeMode {
  if (current === "auto") return "light";
  if (current === "light") return "dark";
  return "auto";
}
