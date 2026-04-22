export type TVPlatform = "tizen" | "webos" | "firetv" | "androidtv" | "generic";

function detect(): TVPlatform {
  if (typeof navigator === "undefined") return "generic";
  const ua = navigator.userAgent;
  if (/Tizen/i.test(ua)) return "tizen";
  if (/Web0S|WebOS|webOS/i.test(ua)) return "webos";
  if (/AFT[A-Z0-9]/i.test(ua)) return "firetv";
  if (/Android TV/i.test(ua)) return "androidtv";
  return "generic";
}

export const platform: TVPlatform = detect();
export const isTizen = platform === "tizen";
export const isWebOS = platform === "webos";
export const isFireTV = platform === "firetv";
export const isAndroidTV = platform === "androidtv";
export const isNativeTV = isTizen || isWebOS || isFireTV || isAndroidTV;
