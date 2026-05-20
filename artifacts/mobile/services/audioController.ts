/**
 * audioController — module-level mutual-exclusion singleton.
 *
 * Prevents simultaneous radio + VOD playback without creating circular
 * React context imports. Both RadioStreamContext and PlayerContext
 * register their respective stop callbacks here at provider mount time.
 *
 * Design contract:
 *   • Only one "audio lane" may play at a time: radio OR VOD.
 *   • When radio turns ON  → requestVodStop()  is called first.
 *   • When VOD turns ON   → requestRadioStop() is called first.
 *   • Callers update their own React state; this module only dispatches.
 *   • No React imports — pure module-level singletons, zero overhead.
 */

type StopFn = () => void;

let stopRadioFn: StopFn | null = null;
let stopVodFn:   StopFn | null = null;

/** RadioStreamContext registers its stop callback here on mount. */
export function registerRadioStop(fn: StopFn): void {
  stopRadioFn = fn;
}

/** PlayerContext registers its stopPlayback callback here on mount. */
export function registerVodStop(fn: StopFn): void {
  stopVodFn = fn;
}

/**
 * Called from PlayerContext when a sermon / live broadcast starts.
 * Stops radio (if on) so only VOD audio plays.
 */
export function requestRadioStop(): void {
  stopRadioFn?.();
}

/**
 * Called from RadioStreamContext when radio turns ON.
 * Stops VOD (if playing) so only radio audio plays.
 */
export function requestVodStop(): void {
  stopVodFn?.();
}
