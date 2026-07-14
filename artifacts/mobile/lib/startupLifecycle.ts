/**
 * Startup Lifecycle Tracker
 *
 * Lightweight phase tracer for the mobile app cold-start pipeline.
 * Each phase is timestamped relative to module-load time and attached
 * as a Sentry breadcrumb, so when a crash occurs during startup the
 * Sentry event shows exactly which phase completed last — making it
 * trivial to identify the stuck/crashing phase without a device attached.
 *
 * Usage:
 *   import { markStartupPhase } from '@/lib/startupLifecycle';
 *   markStartupPhase('sentry_init');
 *
 * Breadcrumbs appear in Sentry under category "startup" and show
 * cumulative elapsed ms since JS module load.
 */

export type StartupPhase =
  | "sentry_init"            // Sentry.init() completed in index.ts
  | "global_error_handler"   // ErrorUtils.setGlobalHandler wired
  | "rntp_register"          // TrackPlayer.registerPlaybackService called (or skipped)
  | "layout_module_load"     // _layout.tsx module evaluated (top-level side-effects run)
  | "layout_mount"           // RootLayout component first rendered
  | "fonts_loaded"           // useFonts resolved (or timed out)
  | "splash_hidden"          // SplashScreen.hideAsync() called
  | "audio_session"          // setupAudioSession() kicked off
  | "track_player_setup"     // setupTrackPlayer() completed (or skipped)
  | "auth_restore_start"     // AuthProvider restore() begin
  | "auth_restore_done"      // AuthProvider restore() finished (success or error)
  | "providers_ready";       // All root providers mounted (first render complete)

interface PhaseRecord {
  phase: StartupPhase;
  /** Milliseconds since JS module load (Date.now() - _startedAt). */
  elapsedMs: number;
  /** Wall-clock timestamp for correlation with system logs. */
  timestamp: number;
}

const _startedAt = Date.now();
const _phases: PhaseRecord[] = [];

/**
 * Mark a startup phase as complete.
 * Safe to call from any context (module-level, effect, async, etc.).
 * Never throws — errors are silently swallowed so the phase marker
 * itself can never become a source of startup crashes.
 */
export function markStartupPhase(phase: StartupPhase): void {
  try {
    const now = Date.now();
    const elapsedMs = now - _startedAt;
    _phases.push({ phase, elapsedMs, timestamp: now });

    // ── Sentry breadcrumb ───────────────────────────────────────────────────
    // Lazy require so this module can be imported at the very top of index.ts
    // (before Sentry.init) without pulling in the full Sentry bundle at
    // module-eval time. Sentry queues breadcrumbs internally once init runs.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Sentry = require("@sentry/react-native") as {
        addBreadcrumb?: (b: {
          category: string;
          message: string;
          data?: Record<string, unknown>;
          level: string;
        }) => void;
      };
      if (typeof Sentry?.addBreadcrumb === "function") {
        Sentry.addBreadcrumb({
          category: "startup",
          message: `phase: ${phase}`,
          data: { elapsedMs, phaseCount: _phases.length },
          level: "info",
        });
      }
    } catch {
      // Sentry not available yet — breadcrumb silently dropped
    }

    // ── Dev logging ─────────────────────────────────────────────────────────
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      // eslint-disable-next-line no-console
      console.log(`[startup] ✓ ${phase}  +${elapsedMs}ms`);
    }
  } catch {
    // Absolutely never let a phase marker crash the app.
  }
}

/**
 * Returns a copy of the recorded phases for diagnostic use.
 * Useful in error reporters and crash-dump utilities.
 */
export function getStartupTrace(): readonly PhaseRecord[] {
  return [..._phases];
}

/**
 * Returns the elapsed ms since JS module load.
 * Useful for one-off timing without recording a named phase.
 */
export function startupElapsedMs(): number {
  return Date.now() - _startedAt;
}

/**
 * Returns the last completed startup phase, or null if none recorded yet.
 */
export function getLastStartupPhase(): StartupPhase | null {
  return _phases.length > 0 ? (_phases[_phases.length - 1]!.phase) : null;
}
