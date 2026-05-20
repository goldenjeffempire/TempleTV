/**
 * Navigation parameter coercion utilities.
 *
 * Expo Router serialises all route params as strings (or string arrays).
 * These helpers centralise the type conversions so boolean/number params
 * are parsed consistently and never require ad-hoc `=== "true"` checks
 * scattered across screens.
 *
 * Usage:
 *   const params = useLocalSearchParams<{ isLive?: string; startPositionSecs?: string }>();
 *   const isLive = parseBoolParam(params.isLive);
 *   const startSecs = parseNumberParam(params.startPositionSecs, 0);
 */

type RawParam = string | string[] | undefined;

/** Coerce a string param to boolean. Accepts "true", "1", "yes" (case-insensitive). */
export function parseBoolParam(v: RawParam): boolean {
  if (v === undefined || v === null) return false;
  const s = (Array.isArray(v) ? v[0] : v) ?? "";
  return s.toLowerCase() === "true" || s === "1" || s.toLowerCase() === "yes";
}

/** Coerce a string param to string with an optional fallback. */
export function parseStringParam(v: RawParam, fallback = ""): string {
  if (v === undefined || v === null) return fallback;
  return (Array.isArray(v) ? v[0] : v) ?? fallback;
}

/** Coerce a string param to a finite number with an optional fallback. */
export function parseNumberParam(v: RawParam, fallback = 0): number {
  const s = parseStringParam(v, "");
  if (!s) return fallback;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : fallback;
}
