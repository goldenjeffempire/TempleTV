import { useEffect, useMemo, useState } from "react";

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

export function useColors(): Palette & { radius: number; themeMode: "light" | "midnight"; isMidnightTheme: boolean; timeZone: string } {
  const [hour, setHour] = useState(() => getLocalHour());

  useEffect(() => {
    const interval = setInterval(() => setHour(getLocalHour()), 60000);
    return () => clearInterval(interval);
  }, []);

  const isMidnightTheme = isMidnightHour(hour);
  const palette: Palette = isMidnightTheme ? colors.midnight : colors.light;
  const timeZone = useMemo(() => getTimeZone(), []);

  return {
    ...palette,
    radius: colors.radius,
    themeMode: isMidnightTheme ? "midnight" : "light",
    isMidnightTheme,
    timeZone,
  };
}
