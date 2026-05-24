import { lazy, Suspense, useEffect, Component, type ReactNode } from "react";
import { Router as WouterRouter, Route, Switch, useLocation, Redirect } from "wouter";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth } from "@/contexts/use-auth";
import { SSEProvider } from "@/contexts/sse-context";
import { AppLayout } from "@/components/layout/app-layout";
import { Skeleton } from "@/components/ui/skeleton";
import { UploadQueuePanel } from "@/components/upload/UploadQueuePanel";

const CHUNK_KEY = "ttv_chunk_reload";

function lazyPage<T extends React.ComponentType<object>>(
  factory: () => Promise<{ default: T }>,
): React.LazyExoticComponent<T> {
  return lazy(() =>
    factory().catch((err: unknown) => {
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
const Broadcast       = lazyPage(() => import("@/pages/broadcast"));
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
const AuditLog        = lazyPage(() => import("@/pages/audit-log"));
const SystemSettings  = lazyPage(() => import("@/pages/settings"));
const NotFound        = lazyPage(() => import("@/pages/not-found"));
const RadioAdmin      = lazyPage(() => import("@/pages/radio"));
const SecurityPage    = lazyPage(() => import("@/pages/security"));

// ── Error Boundary ────────────────────────────────────────────────────────────

interface EBState { error: Error | null }

class ErrorBoundary extends Component<{ children: ReactNode }, EBState> {
  state: EBState = { error: null };

  static getDerivedStateFromError(error: Error): EBState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary] Uncaught render error:", error, info.componentStack);
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
function prefetchCommonPages() {
  const schedule = (fn: () => void, delay: number) => {
    if (typeof requestIdleCallback !== "undefined") {
      setTimeout(() => requestIdleCallback(fn, { timeout: 5000 }), delay);
    } else {
      setTimeout(fn, delay);
    }
  };

  // Tier 1 (2 s): the pages ops teams open immediately after logging in.
  // `.catch(() => {})` silences unhandled-rejection noise when HMR
  // invalidates a chunk hash between prefetch scheduling and execution —
  // the lazyPage wrapper handles the actual navigation-time reload.
  schedule(() => {
    void import("@/pages/videos").catch(() => {});
    void import("@/pages/library").catch(() => {});
    void import("@/pages/broadcast").catch(() => {});
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
}

function AuthenticatedApp() {
  const [location] = useLocation();
  useEffect(() => { sessionStorage.removeItem(CHUNK_KEY); }, [location]);

  // Background-prefetch page chunks immediately after the authenticated
  // shell mounts so navigating to any admin section is near-instant.
   
  useEffect(() => { prefetchCommonPages(); }, []);

  return (
    <SSEProvider>
      <AppLayout>
        <UploadQueuePanel />
        <Suspense fallback={<PageLoader />}>
          <Switch>
            <Route path="/"                 component={Dashboard} />
            <Route path="/dashboard"        component={Dashboard} />
            <Route path="/videos"           component={Videos} />
            <Route path="/library"          component={Library} />
            <Route path="/broadcast"        component={Broadcast} />
            <Route path="/live-control"     component={LiveControl} />
            <Route path="/stream-health"    component={StreamHealth} />
            <Route path="/transcoding"      component={Transcoding} />
            <Route path="/notifications"    component={Notifications} />
            <Route path="/playlists"        component={Playlists} />
            <Route path="/schedule"         component={Schedule} />
            <Route path="/series"           component={Series} />
            <Route path="/analytics"        component={Analytics} />
            <Route path="/users"            component={Users} />
            <Route path="/prayers"          component={Prayers} />
            <Route path="/chat"             component={Chat} />
            <Route path="/operations"       component={Operations} />
            <Route path="/alerts"           component={Alerts} />
            <Route path="/live-ingest"      component={LiveIngest} />
            <Route path="/live-youtube"     component={LiveYoutube} />
            <Route path="/live-monitor"     component={LiveMonitor} />
            <Route path="/master-control">{() => <Redirect to="/broadcast-v2" />}</Route>
            <Route path="/broadcast-v2"     component={BroadcastV2} />
            <Route path="/graphics"         component={Graphics} />
            <Route path="/playback"         component={Playback} />
            <Route path="/sse-bus"          component={SseBus} />
            <Route path="/youtube-quota"    component={YoutubeQuota} />
            <Route path="/youtube-sync"     component={YoutubeSync} />
            <Route path="/launch-readiness" component={LaunchReadiness} />
            <Route path="/purge"            component={Purge} />
            <Route path="/audit-log"        component={AuditLog} />
            <Route path="/radio"            component={RadioAdmin} />
            <Route path="/settings"         component={SystemSettings} />
            <Route path="/security"         component={SecurityPage} />
            <Route component={NotFound} />
          </Switch>
        </Suspense>
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
