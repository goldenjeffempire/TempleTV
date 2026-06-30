/**
 * Shared audio session coordination module.
 *
 * The root layout (_layout.tsx) calls setAudioSessionPromise() with the
 * promise returned by its setupAudioSession() invocation.  Any screen that
 * also needs to configure the audio session (e.g. player.tsx) calls
 * waitForAudioSession() to await that promise before issuing its own
 * Audio.setAudioModeAsync() call.
 *
 * Without this coordination, a deep-link cold start can render the player
 * screen before the layout's useEffect has fired, causing two concurrent
 * Audio.setAudioModeAsync() calls that can fail with "Audio session already
 * active" on iOS.
 */

let _promise: Promise<void> | null = null;

/** Called once by the root layout immediately before setupAudioSession(). */
export function setAudioSessionPromise(p: Promise<void>): void {
  _promise = p;
}

/**
 * Returns the root layout's audio setup promise (or a resolved promise when
 * called before the layout has run, e.g. during static analysis).
 */
export function waitForAudioSession(): Promise<void> {
  return _promise ?? Promise.resolve();
}
