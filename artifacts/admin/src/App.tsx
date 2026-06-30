import { lazy, Suspense, useEffect, useRef, useCallback, Component, type ReactNode } from "react";
import { Router as WouterRouter, Route, Switch, useLocation, Redirect } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth } from "@/contexts/use-auth";
import { SSEProvider, useSSE, useSSEEvent } from "@/contexts/sse-context";
import { AppLayout } from "@/components/layout/app-layout";
import { Skeleton } from "@/components/ui/skeleton";
import { UploadQueuePanel } from "@/components/upload/UploadQueuePanel";
import { uploadQueue } from "@/lib/upload-queue";
import { toast } from "sonner";

const CHUNK_KEY = "ttv_chunk_reload";

function lazyPage<T extends React.ComponentType<object>>(
  factory: () => Promise<{ default: T }>,
): React.LazyExoticComponent<T> {
  return lazy(() =>
    factory()
      .then((mod) => {
        // A successful dynamic import means the chunk is now in the browser's
        // module registry. Clear the one-shot reload sentinel so that if a
        // DIFFERENT page's chunk subsequently fails to load it still gets its
        // own reload attempt. Without this clear, the sentinel set by page A's
        // failure permanently blocks any future reload for page B's failure in
        // the same browser session.
        sessionStorage.removeItem(CHUNK_KEY);
        return mod;
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        const isChunk = msg.includes("dynamically imported") || msg.includes("Loading chunk") || msg.includes("Failed to fetch");
        if (isChunk && !sessionStorage.getItem(CHUNK_KEY)) {
          sessionStorage.setItem(CHUNK_KEY, "1");
          window.location.reload();
          return new Promise<{ default: T }>(() => {});
        }
        throw err;
      }),
  );
}

const LoginPage       = lazyPage(() => import("@/pages/login"));
const Dashboard       = lazyPage(() => import("@/pages/dashboard"));
const Videos          = lazyPage(() => import("@/pages/videos"));
const LiveControl     = lazyPage(() => import("@/pages/live-control"));
const StreamHealth    = lazyPage(() => import("@/pages/stream-health"));
const Transcoding     = lazyPage(() => import("@/pages/transcoding"));
const Notifications   = lazyPage(() => import("@/pages/notifications"));
const Playlists       = lazyPage(() => import("@/pages/playlists"));
const Schedule        = lazyPage(() => import("@/pages/schedule"));
const Series          = lazyPage(() => import("@/pages/series"));
const Analytics       = lazyPage(() => import("@/pages/analytics"));
const Users           = lazyPage(() => import("@/pages/users"));
const Prayers         = lazyPage(() => import("@/pages/prayers"));
const Feedback        = lazyPage(() => import("@/pages/feedback"));
const Chat            = lazyPage(() => import("@/pages/chat"));
const Operations      = lazyPage(() => import("@/pages/operations"));
const Alerts          = lazyPage(() => import("@/pages/alerts"));
const LiveIngest      = lazyPage(() => import("@/pages/live-ingest"));
const LiveYoutube     = lazyPage(() => import("@/pages/live-youtube"));
const LiveMonitor     = lazyPage(() => import("@/pages/live-monitor"));
const BroadcastV2     = lazyPage(() => import("@/pages/broadcast-v2"));
const Graphics        = lazyPage(() => import("@/pages/graphics"));
const Playback        = lazyPage(() => import("@/pages/playback"));
const SseBus          = lazyPage(() => import("@/pages/sse-bus"));
const YoutubeQuota    = lazyPage(() => import("@/pages/youtube-quota"));
const YoutubeSync     = lazyPage(() => import("@/pages/youtube-sync"));
const Library         = lazyPage(() => import("@/pages/library"));
const LaunchReadiness = lazyPage(() => import("@/pages/launch-readiness"));
const Purge           = lazyPage(() => import("@/pages/purge"));
const CorruptMedia    = lazyPage(() => import("@/pages/corrupt-media"));
const AuditLog        = lazyPage(() => import("@/pages/audit-log"));
const SystemSettings  = lazyPage(() => import("@/pages/settings"));
const NotFound        = lazyPage(() => import("@/pages/not-found"));
const RadioAdmin        = lazyPage(() => import("@/pages/radio"));
const SecurityPage      = lazyPage(() => import("@/pages/security"));
const MidnightPrayers   = lazyPage(() => import("@/pages/midnight-prayers"));
const Diagnostics       = lazyPage(() => import("@/pages/diagnostics"));
const SystemHealth      = lazyPage(() => import("@/pages/system-health"));
const SelfHealing       = lazyPage(() => import("@/pages/self-healing"));
const AppVersions       = lazyPage(() => import("@/pages/app-versions"));
const OtaUpdates        = lazyPage(() => import("@/pages/ota-updates"));
const StorageHealth     = lazyPage(() => import("@/pages/storage-health"));
const AutoMonitor       = lazyPage(() => import("@/pages/auto-monitor"));

// ── Error Boundary ────────────────────────────────────────────────────────────

interface EBState { error: Error | null }

class ErrorBoundary extends Component<{ children: ReactNode }, EBState> {
  state: EBState = { error: null };

  static getDerivedStateFromError(error: Error): EBState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    const S = (window as unknown as { Sentry?: { captureException?: (e: unknown, ctx?: unknown) => void } }).Sentry;
    if (S?.captureException) {
      S.captureException(error, { contexts: { react: { componentStack: info.componentStack } } });
    } else if (import.meta.env.DEV) {
      console.error("[ErrorBoundary] Uncaught render error:", error, info.componentStack);
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background p-6">
          <div className="w-full max-w-md flex flex-col items-center gap-5 text-center">
            <div className="w-12 h-12 rounded-full bg-destructive/15 border border-destructive/30 flex items-center justify-center">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-destructive" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </div>
            <div className="space-y-1.5">
              <h1 className="text-base font-semibold tracking-tight">Something went wrong</h1>
              <p className="text-sm text-muted-foreground leading-relaxed font-mono text-xs">
                {this.state.error.message}
              </p>
            </div>
            <button
              type="button"
              onClick={() => { this.setState({ error: null }); window.location.reload(); }}
              className="h-9 px-6 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity"
            >
              Reload page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Panel-level error boundary ─────────────────────────────────────────────
// Lightweight boundary for persistent widgets like UploadQueuePanel that
// should NOT take the entire admin down when a render error occurs. Instead
// the panel silently disappears so operators can keep working; the error is
// logged to the console for engineers.
class PanelErrorBoundary extends Component<{ children: ReactNode }, EBState> {
  state: EBState = { error: null };

  static getDerivedStateFromError(error: Error): EBState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    const S = (window as unknown as { Sentry?: { captureException?: (e: unknown, ctx?: unknown) => void } }).Sentry;
    if (S?.captureException) {
      S.captureException(error, { contexts: { react: { componentStack: info.componentStack } } });
    } else if (import.meta.env.DEV) {
      console.error("[PanelErrorBoundary] Panel render error:", error, info.componentStack);
    }
  }

  render() {
    if (this.state.error) return null;
    return this.props.children;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function PageLoader() {
  return (
    <div className="p-6 space-y-4 max-w-6xl mx-auto">
      <Skeleton className="h-8 w-48" />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[1,2,3].map(i => <Skeleton key={i} className="h-28" />)}
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}

// Prefetch the most-visited page chunks 2 seconds after the dashboard
// renders so that navigation to any of them is effectively instant —
// the dynamic `import()` has already settled and the module is in the
// browser's module registry before the user clicks a nav link.
// Runs once after login completes (component mount). Uses requestIdleCallback
// where available so the prefetch yields to any pending user interaction
// frames first, falling back to a simple setTimeout on older browsers.
// Returns the outer setTimeout IDs so callers can cancel them on unmount,
// preventing orphaned timers when the user logs out before they fire.
function prefetchCommonPages(): ReturnType<typeof setTimeout>[] {
  const ids: ReturnType<typeof setTimeout>[] = [];

  const schedule = (fn: () => void, delay: number) => {
    const id = setTimeout(() => {
      if (typeof requestIdleCallback !== "undefined") {
        requestIdleCallback(fn, { timeout: 5000 });
      } else {
        fn();
      }
    }, delay);
    ids.push(id);
  };

  // Tier 1 (2 s): the pages ops teams open immediately after logging in.
  // `.catch(() => {})` silences unhandled-rejection noise when HMR
  // invalidates a chunk hash between prefetch scheduling and execution —
  // the lazyPage wrapper handles the actual navigation-time reload.
  schedule(() => {
    void import("@/pages/videos").catch(() => {});
    void import("@/pages/library").catch(() => {});
    void import("@/pages/dashboard").catch(() => {});
  }, 2000);

  // Tier 2 (5 s): secondary pages — loaded after the highest-priority chunks
  schedule(() => {
    void import("@/pages/live-control").catch(() => {});
    void import("@/pages/analytics").catch(() => {});
    void import("@/pages/users").catch(() => {});
    void import("@/pages/transcoding").catch(() => {});
  }, 5000);

  // Tier 3 (10 s): lower-frequency pages
  schedule(() => {
    void import("@/pages/notifications").catch(() => {});
    void import("@/pages/schedule").catch(() => {});
    void import("@/pages/stream-health").catch(() => {});
  }, 10000);

  return ids;
}

// ── SSEReconnectSync ──────────────────────────────────────────────────────────
// Must render inside SSEProvider.
//
// Two responsibilities:
//
//  1. SSE outage catch-up — When SSE transitions from a degraded/offline state
//     back to "connected", invalidate all active TanStack Query entries so any
//     server-side changes that arrived as SSE events while we were disconnected
//     are immediately reflected in the UI. Individual page-level useSSEEvent
//     handlers cover the steady-state case; this covers the gap left by a
//     missed-event window.
//
//  2. Long-idle-tab freshness — When the admin tab was hidden for more than
//     5 minutes and comes back into focus, force-invalidate all queries
//     regardless of SSE state. This catches pages (e.g. analytics, users) that
//     don't subscribe to SSE events and can silently serve hours-old data
//     without the operator noticing.
//
function SSEReconnectSync() {
  const qc = useQueryClient();
  const { state } = useSSE();
  const prevStateRef = useRef(state);

  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = state;
    if (state === "connected" && prev !== "connected" && prev !== "connecting") {
      void qc.invalidateQueries();
    }
  }, [state, qc]);

  useEffect(() => {
    let hiddenAt = 0;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
      } else if (hiddenAt > 0 && Date.now() - hiddenAt > 5 * 60 * 1_000) {
        void qc.invalidateQueries();
        hiddenAt = 0;
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [qc]);

  return null;
}

// Listens for YouTube quota threshold SSE events and surfaces them as
// persistent toasts so operators are alerted in real-time — no polling needed.
// Must render inside SSEProvider (done below in AuthenticatedApp).
function YouTubeQuotaMonitor() {
  useSSEEvent("youtube-quota-warning", (data: unknown) => {
    const d = data as { level?: string; pct?: number; used?: number; total?: number; resetsAt?: string } | undefined;
    const pct = d?.pct ?? 0;
    const resetsAt = d?.resetsAt ? new Date(d.resetsAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "midnight UTC";
    if (d?.level === "critical") {
      toast.error(`YouTube API quota CRITICAL — ${pct}% used. Syncs are falling back to RSS (last ~15 videos only). Quota resets at ${resetsAt}.`, {
        duration: Infinity,
        id: "yt-quota-critical",
      });
    } else {
      toast.warning(`YouTube API quota at ${pct}% — approaching daily limit. Quota resets at ${resetsAt}.`, {
        duration: 30_000,
        id: "yt-quota-warning",
      });
    }
  });
  return null;
}

// ── OpsAlertMonitor ───────────────────────────────────────────────────────────
// Surfaces server-side ops-alert SSE events as Sonner toasts so operators
// receive critical system alerts (storage failures, DB pool exhaustion,
// broadcast errors) regardless of which page they're on. The Operations page
// shows the same events in its local event log; this component adds the
// real-time toast layer that works across all admin pages.
//
// Deduplication: uses a stable key (level + message prefix) with a 2-minute
// cooldown so a flapping alert doesn't spam the toast stack. Critical alerts
// persist until manually dismissed; warnings auto-dismiss after 30 s.
function OpsAlertMonitor() {
  const seenRef = useRef<Map<string, number>>(new Map());

  useSSEEvent("ops-alert", (data: unknown) => {
    const d = data as { level?: string; message?: string; component?: string; code?: string } | undefined;
    const level = d?.level === "critical" ? "critical" : "warn";
    const message = d?.message ?? "System alert";
    const component = d?.component ? ` [${d.component}]` : "";
    // Prefer the structured `code` field (e.g. "memory-pressure") as the
    // dedup/toast key so repeated alerts with changing metric values in their
    // message text (e.g. "RSS still elevated: 414 MB … 415 MB … 419 MB") all
    // map to the SAME key. This collapses them into a single toast that updates
    // in place rather than stacking a new notification every emission.
    // Fall back to message prefix for legacy events that have no code field.
    const code = typeof d?.code === "string" && d.code.length > 0 ? d.code : null;
    const key = code ? `${level}:${code}` : `${level}:${message.slice(0, 60)}`;
    const now = Date.now();
    const lastAt = seenRef.current.get(key) ?? 0;
    if (now - lastAt < 120_000) return;
    seenRef.current.set(key, now);

    if (level === "critical") {
      toast.error(`${message}${component}`, {
        description: "Check the Operations page for details.",
        duration: Infinity,
        id: `ops-alert:${key}`,
      });
    } else {
      toast.warning(`${message}${component}`, {
        duration: 30_000,
        id: `ops-alert:${key}`,
      });
    }
  });
  return null;
}

// ── SessionExpiredBanner ──────────────────────────────────────────────────────
// Must render inside SSEProvider. Shows an in-app overlay when the SSE
// provider has exhausted its token-refresh budget (session truly dead),
// instead of silently redirecting. The user sees a clear "Session expired"
// message and an explicit "Sign in again" button.
function SessionExpiredBanner() {
  const { sessionExpired } = useSSE();
  if (!sessionExpired) return null;
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-background/80 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="session-expired-title">
      <div className="w-full max-w-sm mx-4 flex flex-col items-center gap-5 text-center bg-card border rounded-xl p-8 shadow-xl">
        <div className="w-12 h-12 rounded-full bg-amber-500/15 border border-amber-500/30 flex items-center justify-center">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-amber-500" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
        <div className="space-y-1.5">
          <h2 id="session-expired-title" className="text-base font-semibold tracking-tight">Session expired</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">Your session has ended. Please sign in again to continue.</p>
        </div>
        <button
          type="button"
          onClick={() => {
            try { sessionStorage.setItem("ttv_session_expired", "1"); } catch { /* ignore */ }
            window.location.assign("/login");
          }}
          className="w-full h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity"
        >
          Sign in again
        </button>
      </div>
    </div>
  );
}

// ── StreamHealthMonitor ───────────────────────────────────────────────────────
// Surfaces stream-health-degraded / stream-health-recovered SSE events as
// toasts. Using the same toast id for degraded and recovered means the
// recovery toast automatically replaces the warning — no manual dismiss needed.
function StreamHealthMonitor() {
  useSSEEvent("stream-health-degraded", (data: unknown) => {
    const d = data as { dropPercent?: number; slopePct?: number } | undefined;
    const drop = Math.round(d?.dropPercent ?? d?.slopePct ?? 0);
    toast.warning(
      drop > 0 ? `Stream health degraded — ${drop}% viewer drop detected` : "Stream health degraded",
      { duration: Infinity, id: "stream-health-state" },
    );
  });
  useSSEEvent("stream-health-recovered", (data: unknown) => {
    const d = data as { count?: number } | undefined;
    const cnt = Number(d?.count ?? 0);
    toast.success(
      cnt > 0 ? `Stream health recovered — ${cnt} viewers active` : "Stream health recovered",
      { duration: 10_000, id: "stream-health-state" },
    );
  });
  return null;
}

// ── DeadAirMonitor ────────────────────────────────────────────────────────────
// Surfaces dead-air escalation and fallback SSE events as toasts so operators
// immediately know when all content sources are blocked. Uses a stable id so
// recovery/fallback events replace the escalation alert rather than stacking.
function DeadAirMonitor() {
  useSSEEvent("dead-air-escalation", (data: unknown) => {
    const d = data as { allBlockedRecoveryCycles?: number } | undefined;
    const cycles = Number(d?.allBlockedRecoveryCycles ?? 1);
    toast.error(
      `Dead air — all content sources blocked (recovery cycle ${cycles})`,
      { description: "Open Master Control or Stream Health to investigate.", duration: Infinity, id: "dead-air-state" },
    );
  });
  useSSEEvent("broadcast-dead-air-fallback", (data: unknown) => {
    const d = data as { title?: string; kind?: string } | undefined;
    const title = typeof d?.title === "string" ? d.title : null;
    const kind = typeof d?.kind === "string" ? d.kind : "fallback";
    toast.warning(
      title ? `Dead-air ${kind} active: ${title}` : `Dead-air ${kind} activated`,
      { duration: 30_000, id: "dead-air-state" },
    );
  });
  useSSEEvent("broadcast-dead-air-recovered", () => {
    toast.success("Dead-air cleared — content queue recovered", {
      duration: 10_000,
      id: "dead-air-state",
    });
  });
  return null;
}

// ── UploadCompleteNotifier ────────────────────────────────────────────────────
// Listens for the "upload-assembly-complete" SSE event and shows a sonner toast
// so editors working in a background tab know when a new video is ready to
// broadcast without having to switch back to the upload tab.
//
// Suppression rule: if the upload was initiated from THIS browser tab the
// UploadQueuePanel already shows the completion state, so we skip the toast.
// We detect this by checking whether the server-generated sessionId is present
// in the current tab's upload queue — each tab maintains its own in-memory
// queue, so a session from another tab will never appear here.
function UploadCompleteNotifier() {
  const [, navigate] = useLocation();
  useSSEEvent(
    "upload-assembly-complete",
    useCallback(
      (data: unknown) => {
        const d = (data ?? {}) as { videoId?: string; title?: string; sessionId?: string };
        // Skip if this tab owns the session — the upload panel already reflects it.
        if (d.sessionId && uploadQueue.getItems().some((i) => i.sessionId === d.sessionId)) return;
        const title = d.title?.trim() || "Video";
        const videoId = d.videoId;
        toast.success(`"${title}" is ready to broadcast`, {
          description: "Upload assembly complete — the video has been added to the broadcast queue.",
          action: videoId
            ? { label: "View in Library", onClick: () => navigate("/library") }
            : undefined,
          duration: 10_000,
        });
      },
      [navigate],
    ),
  );
  return null;
}

// ── Admin-only route guard ────────────────────────────────────────────────────
// Wraps admin-only pages so that editors / moderators who navigate directly
// to a protected URL (e.g. by bookmarking /users) are redirected to the
// dashboard instead of seeing a server-level 403 or a blank page.
// The sidebar already hides these links for non-admins; this is the
// defence-in-depth layer at the router level.
function AdminRoute({ component: Comp }: { component: React.ComponentType<object> }) {
  const { isAdmin } = useAuth();
  if (!isAdmin) return <Redirect to="/dashboard" />;
  return <Comp />;
}

function AuthenticatedApp() {
  const [location] = useLocation();
  useEffect(() => { sessionStorage.removeItem(CHUNK_KEY); }, [location]);

  // Resume any uploads that were interrupted by a page reload, browser close,
  // network drop, or auth expiry. Items explicitly paused by the user
  // (wasUserPaused=true) are left alone; only interrupted ones auto-resume.
  // Defers until IDB loading is complete via the internal _storageReady gate.
  useEffect(() => { uploadQueue.autoResumeInterrupted(); }, []);

  // Background-prefetch page chunks immediately after the authenticated
  // shell mounts so navigating to any admin section is near-instant.
  // We store all timer IDs and clear them on unmount so that a rapid
  // login → logout cycle doesn't leave orphaned timers referencing
  // module-import calls for chunks that will never be needed.
  useEffect(() => {
    const ids = prefetchCommonPages();
    return () => { for (const id of ids) clearTimeout(id); };
  }, []);

  return (
    <SSEProvider>
      <SessionExpiredBanner />
      <SSEReconnectSync />
      <YouTubeQuotaMonitor />
      <OpsAlertMonitor />
      <StreamHealthMonitor />
      <DeadAirMonitor />
      <UploadCompleteNotifier />
      <AppLayout>
        <PanelErrorBoundary>
          <UploadQueuePanel />
        </PanelErrorBoundary>
        <ErrorBoundary>
        <Suspense fallback={<PageLoader />}>
          <Switch>
            <Route path="/"                 component={Dashboard} />
            <Route path="/dashboard"        component={Dashboard} />
            <Route path="/videos"           component={Videos} />
            <Route path="/library"          component={Library} />
            <Route path="/live-control"     component={LiveControl} />
            <Route path="/stream-health"    component={StreamHealth} />
            <Route path="/transcoding"      component={Transcoding} />
            <Route path="/notifications"    component={Notifications} />
            <Route path="/playlists"        component={Playlists} />
            <Route path="/schedule"         component={Schedule} />
            <Route path="/series"           component={Series} />
            <Route path="/analytics"        component={Analytics} />
            <Route path="/users">{() => <AdminRoute component={Users} />}</Route>
            <Route path="/prayers"          component={Prayers} />
            <Route path="/feedback"         component={Feedback} />
            <Route path="/chat"             component={Chat} />
            <Route path="/operations">{() => <AdminRoute component={Operations} />}</Route>
            <Route path="/alerts"           component={Alerts} />
            <Route path="/live-ingest">{() => <AdminRoute component={LiveIngest} />}</Route>
            <Route path="/live-youtube"     component={LiveYoutube} />
            <Route path="/live-monitor"     component={LiveMonitor} />
            <Route path="/master-control">{() => <Redirect to="/broadcast-v2" />}</Route>
            <Route path="/broadcast">{() => <Redirect to="/broadcast-v2" />}</Route>
            <Route path="/broadcast-v2"     component={BroadcastV2} />
            <Route path="/graphics"         component={Graphics} />
            <Route path="/playback"         component={Playback} />
            <Route path="/sse-bus">{() => <AdminRoute component={SseBus} />}</Route>
            <Route path="/youtube-quota"    component={YoutubeQuota} />
            <Route path="/youtube-sync"     component={YoutubeSync} />
            <Route path="/launch-readiness" component={LaunchReadiness} />
            <Route path="/purge">{() => <AdminRoute component={Purge} />}</Route>
            <Route path="/audit-log">{() => <AdminRoute component={AuditLog} />}</Route>
            <Route path="/corrupt-media"     component={CorruptMedia} />
            <Route path="/radio"             component={RadioAdmin} />
            <Route path="/settings">{() => <AdminRoute component={SystemSettings} />}</Route>
            <Route path="/security">{() => <AdminRoute component={SecurityPage} />}</Route>
            <Route path="/midnight-prayers"  component={MidnightPrayers} />
            <Route path="/system-health">{() => <AdminRoute component={SystemHealth} />}</Route>
            <Route path="/self-healing">{() => <AdminRoute component={SelfHealing} />}</Route>
            <Route path="/auto-monitor">{() => <AdminRoute component={AutoMonitor} />}</Route>
            <Route path="/diagnostics">{() => <AdminRoute component={Diagnostics} />}</Route>
            <Route path="/app-versions">{() => <AdminRoute component={AppVersions} />}</Route>
            <Route path="/ota-updates">{() => <AdminRoute component={OtaUpdates} />}</Route>
            <Route path="/storage-health">{() => <AdminRoute component={StorageHealth} />}</Route>
            <Route component={NotFound} />
          </Switch>
        </Suspense>
        </ErrorBoundary>
      </AppLayout>
    </SSEProvider>
  );
}

function AppRoutes() {
  const { isAuthenticated, isLoading, restoreError, retryRestore, forceSignOut } = useAuth();
  const [location] = useLocation();

  if (isLoading) {
    // restoreError is set after the 2nd consecutive transient failure
    // (~3 s elapsed). When it's set we swap the bare spinner for a
    // recoverable error UI so the admin is never stranded waiting forever
    // for an unreachable API. The background restore loop keeps trying
    // either way; these buttons just give the user explicit control.
    if (restoreError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background p-6">
          <div className="w-full max-w-md flex flex-col items-center gap-5 text-center">
            <div className="w-12 h-12 rounded-full bg-amber-500/15 border border-amber-500/30 flex items-center justify-center">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-amber-500" aria-hidden="true">
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            </div>
            <div className="space-y-1.5">
              <h1 className="text-base font-semibold tracking-tight">Can't reach the server</h1>
              <p className="text-sm text-muted-foreground leading-relaxed">{restoreError}</p>
            </div>
            <div className="flex items-center gap-2 w-full">
              <button
                type="button"
                onClick={retryRestore}
                className="flex-1 h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity"
              >
                Retry now
              </button>
              <button
                type="button"
                onClick={forceSignOut}
                className="flex-1 h-9 rounded-md border border-input bg-background text-sm font-medium hover:bg-accent transition-colors"
              >
                Sign out
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground/60">
              Auto-retrying in the background.
            </p>
          </div>
        </div>
      );
    }
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-muted-foreground">Loading…</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    if (location !== "/login") return <Redirect to="/login" />;
    return <Suspense fallback={<PageLoader />}><LoginPage /></Suspense>;
  }

  if (location === "/login") return <Redirect to="/" />;
  return <AuthenticatedApp />;
}

export default function App() {
  return (
    <ErrorBoundary>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <AppRoutes />
        </WouterRouter>
      </TooltipProvider>
    </ErrorBoundary>
  );
}
