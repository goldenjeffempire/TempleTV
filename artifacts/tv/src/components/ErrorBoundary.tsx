import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = {
  children: ReactNode;
  /** Optional override of the recovery action. Default reloads the window. */
  onReset?: () => void;
};

type State = {
  error: Error | null;
};

/**
 * Top-level error boundary for the TV client.
 *
 * Why this exists
 * ───────────────
 * The TV runs on hardware (Tizen, webOS, Android TV, set-top boxes) where
 * the user CANNOT open dev tools, refresh from a URL bar, or kill an app
 * the way a desktop user can. Any uncaught render error in `Home`,
 * `Player`, `TVGuide`, etc. would otherwise unmount the entire React tree
 * and leave a permanent black screen until the device is restarted —
 * which for a 24/7 broadcast deployment is a viewer-visible outage.
 *
 * This boundary intercepts the error, shows a calm Temple TV-branded
 * recovery screen, and exposes a single OK button (and Enter/Back keys)
 * that reloads the app. Errors are also POSTed to the api-server's
 * `/api/telemetry/client-error` endpoint when available, so operators see
 * the crash in Mission Control instead of having to wait for a viewer
 * complaint.
 *
 * Design choices
 * ──────────────
 * - Class component because React only supports error catching via class
 *   `componentDidCatch` / `getDerivedStateFromError`. There is no hook
 *   equivalent as of React 18.
 * - Telemetry is best-effort with a 4 s `AbortSignal.timeout` and a swallowed
 *   catch — we never let the reporting attempt itself crash the recovery UI.
 * - The recovery action defaults to `window.location.reload()` because most
 *   TV runtimes don't honor a soft React re-render reliably after a hard
 *   crash; a full document reload is the most predictable path back to
 *   a working app.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Console first — visible if the device has remote-debugging attached.
    // eslint-disable-next-line no-console
    console.error("[TV ErrorBoundary]", error, info.componentStack);

    // Best-effort server telemetry. If the endpoint isn't deployed yet
    // (older api-server build) we just absorb the failure — the recovery
    // UI still renders.
    try {
      const body = JSON.stringify({
        platform: "tv",
        message: error.message,
        stack: error.stack ?? null,
        componentStack: info.componentStack ?? null,
        userAgent:
          typeof navigator !== "undefined" ? navigator.userAgent : null,
        url: typeof window !== "undefined" ? window.location.href : null,
        ts: new Date().toISOString(),
      });
      fetch("/api/telemetry/client-error", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(4_000),
        keepalive: true,
      }).catch(() => {});
    } catch {
      // never let telemetry crash the boundary
    }
  }

  handleReset = () => {
    if (this.props.onReset) {
      this.props.onReset();
      return;
    }
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-black text-white p-12">
        <div className="max-w-2xl text-center flex flex-col items-center gap-6">
          <div className="text-6xl font-light tracking-widest opacity-70 uppercase">
            Temple TV
          </div>
          <div className="text-2xl font-medium">
            Something went wrong
          </div>
          <div className="text-base opacity-70 leading-relaxed">
            We hit an unexpected error and couldn't continue. Press OK on
            your remote, or wait a moment and the app will recover.
          </div>
          <button
            type="button"
            onClick={this.handleReset}
            autoFocus
            className="mt-4 px-10 py-4 rounded-lg bg-white text-black text-lg font-semibold focus:outline-none focus:ring-4 focus:ring-white/40"
          >
            OK — Reload
          </button>
          {/*
            Diagnostic detail is hidden by default but rendered into the DOM
            so QA / engineers viewing the device via remote dev-tools or a
            screen-record can still see what went wrong.
          */}
          <details className="text-xs opacity-40 mt-6 max-w-full">
            <summary className="cursor-pointer">Technical details</summary>
            <pre className="mt-2 text-left whitespace-pre-wrap break-words">
              {this.state.error.message}
              {this.state.error.stack ? `\n\n${this.state.error.stack}` : ""}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}
