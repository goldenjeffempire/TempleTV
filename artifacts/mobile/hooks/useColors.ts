import { useContext, useEffect, useMemo, useState } from "react";
import { ThemeContext } from "@/context/ThemeContext";
import colors from "@/constants/colors";

type Palette = typeof colors.light;
let cachedTimeZone: string | undefined;

function getLocalHour() {
  return new Date().getHours();
}

function getTimeZone() {
  if (cachedTimeZone) return cachedTimeZone;
  try {
    cachedTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return cachedTimeZone;
  } catch {
    return "Local time";
  }
}

function isMidnightHour(hour: number) {
  return hour >= 20 || hour < 6;
}

export function useColors(): Palette & {
  radius: number;
  themeMode: "light" | "midnight";
  isMidnightTheme: boolean;
  timeZone: string;
} {
  // Safe: returns null when rendered outside ThemeProvider (test envs, storybook)
  const themeCtx = useContext(ThemeContext);
  const [hour, setHour] = useState(() => getLocalHour());

  useEffect(() => {
    // ThemeProvider owns OS appearance changes. Once loaded, every card
    // no longer needs its own minute timer for the startup-only fallback.
    if (themeCtx?.isLoaded) return;
    const interval = setInterval(() => setHour(getLocalHour()), 60_000);
    return () => clearInterval(interval);
  }, [themeCtx?.isLoaded]);

  const timeZone = useMemo(() => getTimeZone(), []);

  // Priority: explicit user preference (light/dark/system) > time-of-day fallback.
  // When theme is "system", resolvedTheme already mirrors the OS colour scheme
  // (handled by ThemeContext + Appearance.addChangeListener), so we use it
  // directly rather than the legacy time-of-day heuristic.
  const isMidnightTheme: boolean =
    themeCtx?.isLoaded
      ? themeCtx.resolvedTheme === "dark"
      : isMidnightHour(hour);

  const palette: Palette = isMidnightTheme ? colors.midnight : colors.light;

  return {
    ...palette,
    radius: colors.radius,
    themeMode: isMidnightTheme ? "midnight" : "light",
    isMidnightTheme,
    timeZone,
  };
}
