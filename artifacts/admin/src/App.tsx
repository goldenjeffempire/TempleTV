import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Layout } from "@/components/layout";
import { AuthGate } from "@/components/auth-gate";
import { ErrorBoundary } from "@/components/error-boundary";
import { Skeleton } from "@/components/ui/skeleton";
import { applyAutoTheme } from "@/lib/theme";
import { SSEProvider } from "@/contexts/SSEContext";
import { ApiHealthProvider } from "@/contexts/ApiHealthContext";
import { ApiReconnectionBanner } from "@/components/api-reconnection-banner";
import { YouTubeQuotaBanner } from "@/components/youtube-quota-banner";
import { Suspense, lazy, useEffect } from "react";

const Dashboard = lazy(() => import("@/pages/dashboard"));
const Videos = lazy(() => import("@/pages/videos"));
const Playlists = lazy(() => import("@/pages/playlists"));
const Schedule = lazy(() => import("@/pages/schedule"));
const Notifications = lazy(() => import("@/pages/notifications"));
const Analytics = lazy(() => import("@/pages/analytics"));
const Broadcast = lazy(() => import("@/pages/broadcast"));
const Transcoding = lazy(() => import("@/pages/transcoding"));
const Operations = lazy(() => import("@/pages/operations"));
const LiveMonitor = lazy(() => import("@/pages/live-monitor"));
const LaunchReadiness = lazy(() => import("@/pages/launch-readiness"));
const UsersPage = lazy(() => import("@/pages/users"));
const LiveControl = lazy(() => import("@/pages/live-control"));
const LiveIngest = lazy(() => import("@/pages/live-ingest"));
const Prayers = lazy(() => import("@/pages/prayers"));
const NotFound = lazy(() => import("@/pages/not-found"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      gcTime: 5 * 60_000,
    },
  },
});

function PageFallback() {
  return (
    <div className="container mx-auto p-6 max-w-6xl space-y-4">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-4 w-96" />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-6">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}

function RoutedContent() {
  const [location] = useLocation();
  return (
    <ErrorBoundary resetKey={location}>
      <Suspense fallback={<PageFallback />}>
        <Switch>
          <Route path="/" component={Dashboard} />
          <Route path="/videos" component={Videos} />
          <Route path="/playlists" component={Playlists} />
          <Route path="/schedule" component={Schedule} />
          <Route path="/broadcast" component={Broadcast} />
          <Route path="/notifications" component={Notifications} />
          <Route path="/analytics" component={Analytics} />
          <Route path="/transcoding" component={Transcoding} />
          <Route path="/operations" component={Operations} />
          <Route path="/live-monitor" component={LiveMonitor} />
          <Route path="/users" component={UsersPage} />
          <Route path="/launch-readiness" component={LaunchReadiness} />
          <Route path="/live-control" component={LiveControl} />
          <Route path="/live-ingest" component={LiveIngest} />
          <Route path="/prayers" component={Prayers} />
          <Route component={NotFound} />
        </Switch>
      </Suspense>
    </ErrorBoundary>
  );
}

function Router() {
  return (
    // ApiHealthProvider must wrap AuthGate so the auth probe's failures (which
    // dispatch the same window events via adminApi) are picked up. The banner
    // sits inside the provider but outside Layout so it floats above all page
    // chrome regardless of which route is mounted.
    <ApiHealthProvider>
      <ApiReconnectionBanner />
      <AuthGate>
        <SSEProvider>
          {/* Quota banner lives inside SSEProvider so it can subscribe to
              real-time `youtube-quota-exhausted` events. Sits below the API
              reconnection banner (lower z) so a connectivity issue takes
              visual priority. */}
          <YouTubeQuotaBanner />
          <Layout>
            <RoutedContent />
          </Layout>
        </SSEProvider>
      </AuthGate>
    </ApiHealthProvider>
  );
}

function App() {
  useEffect(() => {
    applyAutoTheme();
    const interval = window.setInterval(applyAutoTheme, 60000);
    return () => window.clearInterval(interval);
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
