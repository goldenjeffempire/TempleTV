/**
 * Keep the metadata/session subscription alive without retaining Android
 * preview decoders behind the full player or an unfocused tab.
 * Preserve the existing iOS/web preview behavior.
 */
export function shouldMountHeroPreview(
  platform: string,
  isFocused: boolean,
  isBroadcastMode: boolean,
): boolean {
  return platform !== "android" || (isFocused && !isBroadcastMode);
}
