/**
 * useBreakpoint — responsive layout helpers
 *
 * Reads the current window width once per render and returns a stable
 * set of boolean flags + the raw width value. All flags are derived from
 * the BREAKPOINT constants in `constants/design.ts` so changes there
 * propagate automatically.
 *
 * Usage:
 *   const { isTablet, isLargePhone, columnCount } = useBreakpoint();
 */
import { useWindowDimensions } from "react-native";
import { BREAKPOINT, getColumnCount, getGridCardWidth } from "@/constants/design";

export interface BreakpointInfo {
  /** Raw window width in logical pixels */
  width: number;
  /** Raw window height in logical pixels */
  height: number;
  /** true for large phones (≥ 480 px) and tablets */
  isLargePhone: boolean;
  /** true for small tablets and larger (≥ 768 px) */
  isTablet: boolean;
  /** true for large tablets / iPad Pro landscape (≥ 1024 px) */
  isLargeTablet: boolean;
  /** Recommended number of grid columns at the current width */
  columnCount: number;
  /**
   * Compute a card width that fills the grid at the current breakpoint.
   * Pass an explicit column count to override the automatic value.
   */
  getCardWidth: (cols?: number) => number;
}

export function useBreakpoint(): BreakpointInfo {
  const { width, height } = useWindowDimensions();

  return {
    width,
    height,
    isLargePhone: width >= BREAKPOINT.sm,
    isTablet: width >= BREAKPOINT.md,
    isLargeTablet: width >= BREAKPOINT.lg,
    columnCount: getColumnCount(width),
    getCardWidth: (cols?: number) => getGridCardWidth(width, cols),
  };
}
