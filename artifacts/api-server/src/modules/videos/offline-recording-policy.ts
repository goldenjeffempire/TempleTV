/** Offline access is for first-party, public recordings only, never providers. */
export function offlineRecordingKey(video: {
  videoSource: string;
  localVideoUrl: string | null;
  objectPath: string | null;
  checksumSha256: string | null;
  validationStatus: string | null;
  transcodingErrorCode: string | null;
}): string | null {
  if (video.videoSource !== "local" ||
      (video.checksumSha256 !== null && !/^[a-f0-9]{64}$/i.test(video.checksumSha256))) return null;
  if (video.validationStatus === "failed" ||
      ["CORRUPT_SOURCE", "SOURCE_MISSING", "ASSEMBLY_FAILED", "STORAGE_LOST"].includes(video.transcodingErrorCode ?? "")) return null;
  // Never fetch or authorize a URL supplied by the caller, YouTube, an HLS
  // manifest, or an external origin. objectPath is an internal storage key.
  const key = video.objectPath;
  if (!key || !/^uploads\/[a-zA-Z0-9/_-]+\.(mp4|m4v|mov)$/i.test(key) ||
      key.includes("..")) return null;
  return key;
}
