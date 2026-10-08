/**
 * Broadcast playback bypasses PlayerContext's VOD/YouTube controls. Its own
 * FSM must determine presence; a stale context flag cannot gate heartbeats.
 */
export function isLiveViewerWatching({
  isLive,
  isBroadcast,
  contextPlaying,
  broadcastState,
}: {
  isLive: boolean;
  isBroadcast: boolean;
  contextPlaying: boolean;
  broadcastState: string;
}): boolean {
  if (!isLive) return false;
  if (!isBroadcast) return contextPlaying;
  return broadcastState === "PLAYING" ||
    broadcastState === "PREPARING_NEXT" ||
    broadcastState === "HANDOFF" ||
    broadcastState === "LIVE_OVERRIDE_ACTIVE";
}
