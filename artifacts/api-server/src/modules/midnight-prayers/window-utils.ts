/**
 * window-utils.ts — Pure, dependency-free time-window helpers for the
 * Midnight Prayers channel.
 *
 * Kept in a separate module so they can be imported by unit tests without
 * pulling in Drizzle, Fastify, or any other server infrastructure.
 */

export interface MPWindowConfig {
  enabled: boolean;
  startHour: number; // 0–23
  endHour: number;   // 1–24 (exclusive bound; 24 = end of day, same as 0 next day)
  timezone: string;  // IANA timezone string, e.g. "Africa/Lagos"
}

/**
 * Returns the local hour (0–23) for the given IANA timezone at the given
 * timestamp. Uses Intl.DateTimeFormat to avoid third-party dependencies.
 *
 * Falls back to UTC if the timezone string is invalid.
 */
export function getLocalHour(tz: string, nowMs: number = Date.now()): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      hour12: false,
    }).formatToParts(new Date(nowMs));
    // Intl may return "24" for midnight in some environments — normalise.
    return parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10) % 24;
  } catch {
    return new Date(nowMs).getUTCHours();
  }
}

/**
 * Returns the local minute (0–59) for the given IANA timezone at the given
 * timestamp.
 */
export function getLocalMinute(tz: string, nowMs: number = Date.now()): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      minute: "2-digit",
    }).formatToParts(new Date(nowMs));
    return parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  } catch {
    return new Date(nowMs).getUTCMinutes();
  }
}

/**
 * Returns true when the given timestamp falls strictly within the midnight
 * prayer window [startHour, endHour) in the configured IANA timezone.
 *
 * Semantics:
 *   - Window is [startHour, endHour) — start is inclusive, end is EXCLUSIVE.
 *   - 3:00:00 AM with endHour=3 → BLOCKED (hour === endHour, not < endHour).
 *   - Wraparound windows (e.g. startHour=22, endHour=2) are supported.
 *   - If config.enabled is false → always returns false.
 *
 * @param nowMs    Unix timestamp in ms to evaluate (defaults to Date.now()).
 * @param config   Midnight prayers window configuration.
 */
export function isWindowActive(
  nowMs: number,
  config: MPWindowConfig,
): boolean {
  if (!config.enabled) return false;

  const h = getLocalHour(config.timezone, nowMs);
  const { startHour, endHour } = config;

  // Normal window: e.g. 0–3 (midnight to 3 AM)
  if (endHour > startHour) {
    return h >= startHour && h < endHour;
  }

  // Wraparound window: e.g. 22–2 (10 PM to 2 AM)
  // The window crosses midnight, so we split it into two ranges:
  //   [startHour, 24) OR [0, endHour)
  if (endHour < startHour) {
    return h >= startHour || h < endHour;
  }

  // startHour === endHour — zero-length window, always inactive
  return false;
}

/**
 * Detects whether `nowMs` is within `leadMs` of the next hour-boundary AND
 * that boundary will actually flip the window's active/inactive state (the
 * config is hour-granular, so "approaching a boundary" only matters when it
 * changes something).
 *
 * Used to proactively preload the Midnight Prayers transition item (or the
 * resume item) a lead window ahead of the hard swap, giving clients the same
 * head start on the boundary item that the normal mid-rotation preload gives
 * every other item — eliminating the black-frame/buffering moment that a
 * cold, no-warning swap would otherwise cause.
 *
 * Approximate by design: config granularity is whole hours, so treating the
 * local minute-of-hour as "seconds into hour" (ignoring seconds) is accurate
 * to within 60 s, comfortably inside a multi-minute lead window.
 */
export function isApproachingTransition(
  nowMs: number,
  config: MPWindowConfig,
  leadMs: number,
): { approaching: boolean; willActivate: boolean } {
  if (!config.enabled) return { approaching: false, willActivate: false };

  const minute = getLocalMinute(config.timezone, nowMs);
  const msIntoHour = minute * 60_000;
  const msToNextHour = 60 * 60_000 - msIntoHour;
  if (msToNextHour > leadMs) return { approaching: false, willActivate: false };

  const nowActive = isWindowActive(nowMs, config);
  const futureActive = isWindowActive(nowMs + msToNextHour + 1000, config);
  return { approaching: nowActive !== futureActive, willActivate: futureActive };
}

/**
 * Human-readable description of the window state for log messages.
 */
export function windowDescription(config: MPWindowConfig): string {
  return `[${config.startHour}:00–${config.endHour}:00) ${config.timezone}`;
}
