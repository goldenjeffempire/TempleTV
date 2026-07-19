/**
 * window-utils.ts — Pure, dependency-free time-window helpers for the
 * Midnight Prayers channel.
 *
 * Kept in a separate module so they can be imported by unit tests without
 * pulling in Drizzle, Fastify, or any other server infrastructure.
 */
export interface MPWindowConfig {
    enabled: boolean;
    startHour: number;
    endHour: number;
    timezone: string;
}
/**
 * Returns the local hour (0–23) for the given IANA timezone at the given
 * timestamp. Uses Intl.DateTimeFormat to avoid third-party dependencies.
 *
 * Falls back to UTC if the timezone string is invalid.
 */
export declare function getLocalHour(tz: string, nowMs?: number): number;
/**
 * Returns the local minute (0–59) for the given IANA timezone at the given
 * timestamp.
 */
export declare function getLocalMinute(tz: string, nowMs?: number): number;
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
export declare function isWindowActive(nowMs: number, config: MPWindowConfig): boolean;
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
export declare function isApproachingTransition(nowMs: number, config: MPWindowConfig, leadMs: number): {
    approaching: boolean;
    willActivate: boolean;
};
/**
 * Human-readable description of the window state for log messages.
 */
export declare function windowDescription(config: MPWindowConfig): string;
