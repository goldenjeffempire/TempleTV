/**
 * Module-level binder so plain utility functions (e.g. navigateToSermon)
 * can consult the live auth state without being React hooks themselves.
 *
 * AuthProvider keeps these bindings up to date on every render. Anything
 * that needs to gate a navigation can call `gatePlayback(target, run)`
 * — if the user is signed in, `run()` executes immediately; otherwise
 * the pending target is stored and the modal is opened so the user can
 * sign up or log in without losing context.
 */
export interface PendingPlayback {
  /** A single Expo Router push target. Restored verbatim after auth. */
  pathname: string;
  params: Record<string, string>;
  /** UI hint shown above the gate buttons (e.g. "Sign up to watch this sermon"). */
  reason?: string;
}

interface AuthGateBindings {
  isLoggedIn: boolean;
  isLoading: boolean;
  openGate: (target: PendingPlayback) => void;
}

let bindings: AuthGateBindings = {
  isLoggedIn: false,
  isLoading: true,
  openGate: () => {},
};

export function setAuthGateBindings(next: AuthGateBindings): void {
  bindings = next;
}

export function getIsLoggedInSnapshot(): boolean {
  return bindings.isLoggedIn;
}

/**
 * Gate an action behind authentication. If the user is signed in (or
 * the auth state is still loading — we err on the side of "let them
 * through" so first-paint after a token-restore doesn't briefly show
 * the modal), the action runs immediately. Otherwise the pending
 * playback target is captured and the AuthGateModal is opened.
 */
export function gatePlayback(target: PendingPlayback, run: () => void): void {
  if (bindings.isLoggedIn || bindings.isLoading) {
    run();
    return;
  }
  bindings.openGate(target);
}
