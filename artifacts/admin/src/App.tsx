import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Layout } from "@/components/layout";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/dashboard";
import Videos from "@/pages/videos";
import Playlists from "@/pages/playlists";
import Schedule from "@/pages/schedule";
import Notifications from "@/pages/notifications";
import Analytics from "@/pages/analytics";
import Broadcast from "@/pages/broadcast";
import Transcoding from "@/pages/transcoding";
import Operations from "@/pages/operations";
import LiveMonitor from "@/pages/live-monitor";
import LaunchReadiness from "@/pages/launch-readiness";
import UsersPage from "@/pages/users";
import { applyAutoTheme } from "@/lib/theme";
import { useEffect } from "react";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function Router() {
  return (
    <Layout>
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
        <Route component={NotFound} />
      </Switch>
    </Layout>
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
