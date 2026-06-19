/**
 * Design tokens — Temple TV mobile app
 *
 * Single source of truth for spacing, typography, card geometry, and
 * animation timing. Import from here instead of scattering magic numbers.
 */
import { Dimensions } from "react-native";

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
