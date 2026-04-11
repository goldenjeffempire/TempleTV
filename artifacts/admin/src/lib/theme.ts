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

export function applyAutoTheme() {
  const midnight = isMidnightHour();
  document.documentElement.classList.toggle("dark", midnight);
  document.documentElement.dataset.theme = midnight ? "midnight" : "light";
  return midnight ? "midnight" : "light";
}