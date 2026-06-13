import { useContext, useEffect, useMemo, useState } from "react";
import { ThemeContext } from "@/context/ThemeContext";
import colors from "@/constants/colors";

type Palette = typeof colors.light;

function getLocalHour() {
  return new Date().getHours();
}

function getTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
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
    const interval = setInterval(() => setHour(getLocalHour()), 60_000);
    return () => clearInterval(interval);
  }, []);

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
