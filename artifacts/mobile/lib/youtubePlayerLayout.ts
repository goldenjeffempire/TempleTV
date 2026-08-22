export const YOUTUBE_ASPECT_RATIO = 16 / 9;

/**
 * Resolve the exact height of the visible YouTube surface.
 *
 * The route owns the player shell size and passes it as explicitHeight. The
 * native iframe, loading thumbnail, and fallback state must all use that same
 * rectangle so no wrapper background can appear as a horizontal band.
 */
export function resolveYouTubePlayerHeight(
  containerWidth: number,
  explicitHeight?: number,
): number {
  if (
    typeof explicitHeight === "number"
    && Number.isFinite(explicitHeight)
    && explicitHeight > 0
  ) {
    return Math.max(1, Math.round(explicitHeight));
  }

  return Math.max(
    1,
    Math.round(containerWidth / YOUTUBE_ASPECT_RATIO),
  );
}