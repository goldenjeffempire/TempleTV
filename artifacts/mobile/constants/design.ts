/**
 * Design tokens — Temple TV mobile app
 *
 * Single source of truth for spacing, typography, card geometry, and
 * animation timing. Import from here instead of scattering magic numbers.
 */
import { Dimensions, useWindowDimensions } from "react-native";

/** 16:9 canonical video aspect ratio */
export const CARD_ASPECT_RATIO = 16 / 9;

/**
 * Compute the card width that guarantees two cards + 12 px gap fit within the
 * scroll view on any phone from 320 px up, with 16 px side padding each side.
 *
 *   2 × card + 12 gap + 16 × 2 padding = screen
 *   card = (screen − 44) / 2
 *
 * Clamped: 148 px (min — 320 px phone) … 220 px (max — wide tablet card row).
 */
export function getCardWidth(screenWidth: number = Dimensions.get("window").width): number {
  const computed = Math.floor((screenWidth - 44) / 2);
  return Math.max(148, Math.min(computed, 220));
}

/** Default card width at module load time (updates on component render via useWindowDimensions) */
export const CARD_WIDTH = getCardWidth();

/** Spacing scale — multiples of 4, aligned with React Native's default density */
export const SPACING = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  section: 28,
} as const;

/** Typography scale */
export const FONT_SIZE = {
  xxs: 10,
  xs: 11,
  sm: 12,
  md: 13,
  base: 14,
  lg: 16,
  xl: 18,
  xxl: 22,
  hero: 28,
} as const;

/**
 * Line height scale — paired with FONT_SIZE.
 * Ratio: ~1.4× for UI labels, ~1.6× for body copy.
 */
export const LINE_HEIGHT = {
  xxs: 14,
  xs: 15,
  sm: 17,
  md: 19,
  base: 20,
  lg: 22,
  xl: 26,
  xxl: 30,
  hero: 36,
} as const;

/** Tab bar icon area height (excludes device safe-area bottom inset) */
export const TAB_BAR_CONTENT_HEIGHT = 49;

/**
 * Standard bottom padding for any scrollable screen.
 * Tab bar + device inset + comfortable overscroll gap.
 */
export function getScrollPaddingBottom(bottomInset: number): number {
  return TAB_BAR_CONTENT_HEIGHT + bottomInset + 24;
}

/** Animation durations */
export const DURATION = {
  fast: 150,
  normal: 250,
  slow: 450,
  skeleton: 900,
} as const;

/** Border radii */
export const RADIUS = {
  sm: 6,
  md: 10,
  lg: 12,
  xl: 16,
  card: 12,
  full: 9999,
} as const;

/**
 * Responsive breakpoints (width in logical pixels).
 *
 * - `sm`  480  — large phone (iPhone Pro Max, Galaxy Ultra)
 * - `md`  768  — small tablet / iPad mini in portrait
 * - `lg`  1024 — iPad in landscape / iPad Pro portrait
 *
 * Usage:
 *   const { width } = useWindowDimensions();
 *   const isTablet = width >= BREAKPOINT.md;
 */
export const BREAKPOINT = {
  sm: 480,
  md: 768,
  lg: 1024,
} as const;

/**
 * Returns the number of columns a horizontal card grid should use
 * based on the available screen width.
 *
 *   < 480   → 2 cols  (phone portrait)
 *   480–767 → 2 cols  (large phone / compact tablet)
 *   768–    → 3 cols  (tablet)
 *   1024–   → 4 cols  (large tablet / iPad Pro landscape)
 */
export function getColumnCount(screenWidth: number): number {
  if (screenWidth >= BREAKPOINT.lg) return 4;
  if (screenWidth >= BREAKPOINT.md) return 3;
  return 2;
}

/**
 * Returns the card width for a given column count and screen width,
 * accounting for the standard 16 px side padding and 12 px column gap.
 *
 *   availableWidth = screenWidth − 2 × 16 (h-padding)
 *   card = (availableWidth − (cols − 1) × 12 (gaps)) / cols
 */
export function getGridCardWidth(screenWidth: number, cols?: number): number {
  const columns = cols ?? getColumnCount(screenWidth);
  const available = screenWidth - 32;
  const gaps = (columns - 1) * 12;
  return Math.floor((available - gaps) / columns);
}

/**
 * Vertical rhythm helpers — use these to derive consistent section
 * spacing rather than hard-coding pixel values in each screen.
 */
export const VERTICAL_RHYTHM = {
  /** Gap between a section header and its first content row */
  sectionHeaderGap: SPACING.sm,
  /** Gap between two adjacent content sections */
  sectionGap: SPACING.xl,
  /** Inset padding at the very top of a scroll view body */
  screenTopPad: SPACING.lg,
  /** Standard list-item vertical padding (half above, half below) */
  listItemV: SPACING.md,
  /** Hero component bottom margin before the first content section */
  heroBelowGap: SPACING.xl,
} as const;
