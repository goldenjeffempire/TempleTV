import React, { useEffect, useRef } from "react";
import { Platform, View } from "react-native";
import { usePathname } from "expo-router";
import { YoutubePlayer } from "@/components/YoutubePlayer";
import { usePlayer } from "@/context/PlayerContext";

/**
 * Persistent root-level YouTube audio engine.
 *
 * Mounts a hidden YoutubePlayer at the app root so playback continues
 * across screen navigation (Radio tab, Library, Settings, etc).
 *
 * Suppressed when the visible /player route is active so its visible
 * YoutubePlayer owns the audio (prevents double-playback / overlap).
 *
 * This is the standard "always-on player" pattern used by Spotify,
 * YouTube Music, and Apple Music — controls in any tab dispatch through
 * PlayerContext refs which point at this hidden engine.
 */
export function PersistentAudioPlayer() {
  const pathname = usePathname();
  const { currentSermon, isPlaying, advanceToNext } = usePlayer();

  // The visible /player route owns its own YoutubePlayer; don't double-mount.
  const onVisibleRoute =
    pathname?.startsWith("/player") === true || pathname === "/login" || pathname === "/signup";

  // Nothing to play — don't render the iframe at all.
  //
  // Pure-live mode (`isLive=true, currentSermon=null`) is intentionally NOT
  // handled here. Live broadcasts are owned exclusively by the `/player`
  // route — `LiveBroadcastSupervisor` always navigates there after calling
  // `playLive()`, and `PlayerContext` never stores the live videoId. If the
  // user then navigated AWAY from `/player` while still in pure-live state,
  // this surface used to mount a YoutubePlayer with `videoId=undefined`,
  // which on native (YoutubePlayer.native.tsx:414 requires `activeVideoId`)
  // rendered nothing at all, and on web only "worked" by coincidence — the
  // YoutubePlayer's default `channelHandle` prop accidentally produced a
  // channel-live embed. The cross-platform inconsistency was the actual
  // bug. PersistentAudioPlayer is the persistent SERMON (VOD) background-
  // audio surface; live audio is the `/player` surface's job. Consistent
  // and explicit beats accidentally-different.
  if (!currentSermon) return null;
  if (onVisibleRoute) return null;

  const videoId = currentSermon.youtubeId;

  // Position offscreen rather than 0×0 — YouTube iframes need real dimensions
  // to initialize playback reliably across browsers.
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={
        Platform.OS === "web"
          ? ({
              position: "absolute",
              left: -10000,
              top: 0,
              width: 320,
              height: 180,
              opacity: 0,
              overflow: "hidden",
            } as any)
          : {
              position: "absolute",
              left: -10000,
              top: 0,
              width: 1,
              height: 1,
              opacity: 0,
              overflow: "hidden",
            }
      }
    >
      <YoutubePlayer
        videoId={videoId}
        isLive={false}
        autoPlay={isPlaying}
        title={currentSermon.title}
        preacher={currentSermon.preacher}
        thumbnailUrl={currentSermon.thumbnailUrl}
        playerHeight={Platform.OS === "web" ? 180 : 1}
        onEnd={advanceToNext}
        // If this background iframe fails to load (network error, CSP block,
        // video removed, YouTube CDN unreachable) advance to the next sermon
        // rather than silently stalling on a track the user can't interact with.
        onError={advanceToNext}
      />
    </View>
  );
}
