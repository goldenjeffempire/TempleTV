export const APP_CONFIG = {
  channelHandle: "templetvjctm",
  channelName: "JCTM Broadcasting",
  channelUrl: "https://www.youtube.com/@templetvjctm",
  channelLiveUrl: "https://www.youtube.com/@templetvjctm/live",
  rssUrl: "https://www.youtube.com/feeds/videos.xml?channel_id=UCPFFvkE-KGpR37qJgvYriJg",
  defaultHlsStream: "https://www.youtube.com/@templetvjctm/live",
  fallbackStreamUrl: "https://www.youtube.com/@templetvjctm",
  maxHistoryItems: 50,
  rssCacheMinutes: 10,
};

export const STORAGE_KEYS = {
  watchHistory: "@temple_tv/watch_history",
  favorites: "@temple_tv/favorites",
  watchLater: "@temple_tv/watch_later",
  settings: "@temple_tv/settings",
  playbackSettings: "@temple_tv/playback_settings",
  lastLiveCheck: "@temple_tv/last_live_check",
  rssCache: "@temple_tv/rss_cache",
  authToken: "@temple_tv/auth_token",
  authRefreshToken: "@temple_tv/auth_refresh_token",
  authUser: "@temple_tv/auth_user",
};

// expo-secure-store rejects any key containing characters outside of
// [A-Za-z0-9._-]. The legacy STORAGE_KEYS use "@" and "/" which work fine for
// AsyncStorage (web) but throw "Invalid key provided to SecureStore" on
// native, blocking login/signup entirely. These safe-character mirrors are
// used by every native SecureStore call. AuthContext migrates any previously
// stored AsyncStorage auth values from the legacy keys to these on cold start.
export const SECURE_KEYS = {
  authToken: "temple_tv.auth_token",
  authRefreshToken: "temple_tv.auth_refresh_token",
  authUser: "temple_tv.auth_user",
};
