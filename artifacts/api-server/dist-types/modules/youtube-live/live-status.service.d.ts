/**
 * YouTube Live Status Service
 *
 * Subscribes to the ytPoller singleton and keeps the `youtube_live_status`
 * column on `managed_videos` rows consistent with real-time YouTube live state.
 *
 * State machine:
 *   null        ← initial / not applicable (non-YouTube or never went live)
 *   'live'      ← stream is actively airing on YouTube right now
 *   'rebroadcast' ← stream ended; video is available as a VOD/replay
 *
 * Event flow:
 *   ytPoller emits "change" whenever isLive / videoId changes.
 *
 *   • live start  → UPDATE rows WHERE youtube_id = videoId → 'live'
 *                   Also demote any OTHER rows still at 'live' → 'rebroadcast'
 *                   (handles channel switching mid-stream)
 *
 *   • live end    → UPDATE all rows WHERE youtube_live_status = 'live' → 'rebroadcast'
 *
 *   • sweep (2min) → reconcile:
 *       - if NOT live:  any row at 'live' → heal to 'rebroadcast'
 *       - if live:      any row at 'live' WHERE youtube_id ≠ currentVideoId → 'rebroadcast'
 *
 * Wire-in: call installYoutubeLiveStatusService() from broadcast-v2 index.ts
 * after installYouTubeAutoOverride() — both subscribe to the same poller.
 */
export declare function installYoutubeLiveStatusService(): void;
export declare function uninstallYoutubeLiveStatusService(): void;
