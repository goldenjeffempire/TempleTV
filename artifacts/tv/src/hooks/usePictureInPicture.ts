/**
 * usePictureInPicture — native browser Picture-in-Picture for broadcast monitoring.
 *
 * Finds the active (non-muted, playing) video from the LiveBroadcastV2 dual-buffer
 * surfaces and requests PiP entry. Tracks state via the `enterpictureinpicture` /
 * `leavepictureinpicture` DOM events so the indicator badge stays accurate even when
 * the user closes the native PiP window via OS chrome rather than the in-app button.
 *
 * Supported browsers: Chromium ≥70, Edge ≥79, Safari ≥13.1, Firefox 116+.
 * Samsung Tizen ≥5 / LG webOS ≥6 both ship Chromium-based browsers that support it.
 * Older Smart TV firmware degrades gracefully — `isPipSupported` is false and the
 * PiP button simply does not render.
 */
import { useState, useEffect, useCallback } from "react";
import { cleanupPiPReservedStream } from "@workspace/player-core/react";

export interface PictureInPictureHook {
  /** Whether a PiP window is currently open. */
  isPipActive: boolean;
  /** Whether the browser supports the native PiP API at all. */
  isPipSupported: boolean;
  /**
   * Find the active broadcast video and request PiP entry.
   * Resolves `true` on success, `false` if the API is unsupported or no
   * suitable video element is found / ready.
   */
  enterPiP: () => Promise<boolean>;
  /**
   * Close the active PiP window programmatically.
   * No-op if PiP is not currently active.
   */
  exitPiP: () => void;
}

export function usePictureInPicture(): PictureInPictureHook {
  const [isPipActive, setIsPipActive] = useState(false);

  const isPipSupported =
    typeof document !== "undefined" && !!document.pictureInPictureEnabled;

  useEffect(() => {
    const onEnter = () => setIsPipActive(true);
    const onLeave = () => {
      setIsPipActive(false);
      // Destroy the HLS stream that was preserved for the PiP window so it
      // doesn't keep downloading segments after the window closes.  The
      // cleanup is a no-op when no stream was preserved (e.g. the video's
      // src was a plain MP4 managed entirely by the browser).
      cleanupPiPReservedStream();
    };
    document.addEventListener("enterpictureinpicture", onEnter);
    document.addEventListener("leavepictureinpicture", onLeave);
    return () => {
      document.removeEventListener("enterpictureinpicture", onEnter);
      document.removeEventListener("leavepictureinpicture", onLeave);
    };
  }, []);

  useEffect(() => {
    setIsPipActive(!!document.pictureInPictureElement);
  }, []);

  const enterPiP = useCallback(async (): Promise<boolean> => {
    if (!isPipSupported) return false;
    if (document.pictureInPictureElement) return true;

    const videos = Array.from(
      document.querySelectorAll<HTMLVideoElement>("video"),
    );
    // Only select an unmuted, actively-playing video. The hero / background
    // preview buffers are always muted — capturing one would give the user a
    // silent PiP window with no audio even though the live stream is audible.
    const target = videos.find((v) => !v.muted && !v.paused && v.readyState >= 2);
    if (!target) return false;

    try {
      await target.requestPictureInPicture();
      setIsPipActive(true);
      return true;
    } catch {
      return false;
    }
  }, [isPipSupported]);

  const exitPiP = useCallback(() => {
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(() => {});
    }
    setIsPipActive(false);
  }, []);

  return { isPipActive, isPipSupported, enterPiP, exitPiP };
}
