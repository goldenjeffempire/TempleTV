import React from "react";
import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  Video,
  ListVideo,
  Calendar,
  BellRing,
  BarChart2,
  Radio,
  Tv2,
  Moon,
  Sun,
  Cpu,
  KeyRound,
  ShieldCheck,
  MonitorPlay,
  Rocket,
  Users,
  Signal,
  LogOut,
} from "lucide-react";
import { useGetLiveStatus } from "@workspace/api-client-react";
import { getLocalTimeZone, isMidnightHour } from "@/lib/theme";
import { getAdminToken, setAdminToken } from "@/lib/admin-access";
import { TempleTvLogo } from "@/components/temple-tv-logo";
import { AdminKeyDialog } from "@/components/admin-key-dialog";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [hasAdminToken, setHasAdminToken] = React.useState(() => Boolean(getAdminToken()));
  const [keyDialogOpen, setKeyDialogOpen] = React.useState(false);
  const { data: liveStatus } = useGetLiveStatus();
  const isMidnightTheme = isMidnightHour();
  const ThemeIcon = isMidnightTheme ? Moon : Sun;
  const viewerCount = liveStatus?.viewerCount ?? 0;

  React.useEffect(() => {
    const sync = () => setHasAdminToken(Boolean(getAdminToken()));
    window.addEventListener("temple-tv-admin-token-changed", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("temple-tv-admin-token-changed", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const links = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/videos", label: "Video Library", icon: Video },
    { href: "/broadcast", label: "Broadcast Queue", icon: Tv2 },
    { href: "/playlists", label: "Playlists", icon: ListVideo },
    { href: "/schedule", label: "Schedule", icon: Calendar },
    { href: "/notifications", label: "Notifications", icon: BellRing },
    { href: "/analytics", label: "Analytics", icon: BarChart2 },
    { href: "/users", label: "Registered Users", icon: Users },
    { href: "/transcoding", label: "Transcoding Queue", icon: Cpu },
    { href: "/live-control", label: "Live Control", icon: Signal },
    { href: "/live-monitor", label: "Live Monitor", icon: MonitorPlay },
    { href: "/operations", label: "Operations", icon: ShieldCheck },
    { href: "/launch-readiness", label: "Launch Readiness", icon: Rocket },
  ];

  const handleSignOut = () => {
    if (window.confirm("Sign out of the admin console? Your admin key will be removed from this browser.")) {
      setAdminToken("");
    }
  };

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden">
      <aside className="w-64 border-r bg-card flex flex-col">
        <div className="h-16 flex items-center gap-3 px-5 border-b">
          <TempleTvLogo size={36} />
          <div className="flex items-baseline gap-2">
            <span className="font-bold text-base tracking-tight">Temple TV</span>
            <span className="text-[10px] font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded-sm uppercase">
              JCTM
            </span>
          </div>
        </div>
        <nav className="flex-1 py-4 px-3 space-y-1 overflow-y-auto">
          {links.map((link) => {
            const Icon = link.icon;
            const active = location === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-colors ${
                  active
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent hover-elevate"
                }`}
              >
                <Icon className="w-4 h-4" />
                {link.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t p-3">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground px-2 mb-1">
            Session
          </div>
          <button
            type="button"
            onClick={() => setKeyDialogOpen(true)}
            className="w-full flex items-center gap-2 px-2 py-2 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <KeyRound className="w-4 h-4" />
            <span className="flex-1 text-left">{hasAdminToken ? "Admin key set" : "Set admin key"}</span>
            <span
              className={`h-2 w-2 rounded-full ${
                hasAdminToken ? "bg-emerald-500" : "bg-amber-500"
              }`}
              aria-hidden
            />
          </button>
          {hasAdminToken && (
            <button
              type="button"
              onClick={handleSignOut}
              className="w-full flex items-center gap-2 px-2 py-2 mt-1 rounded-md text-sm text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
            >
              <LogOut className="w-4 h-4" />
              Sign out
            </button>
          )}
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-16 border-b bg-card flex items-center justify-between px-6 shrink-0">
          <div className="flex items-center gap-4">
            {liveStatus?.isLive ? (
              <div className="flex items-center gap-2 bg-red-500/10 text-red-500 px-3 py-1.5 rounded-full text-xs font-medium border border-red-500/20 animate-pulse">
                <Radio className="w-3.5 h-3.5" />
                LIVE NOW
                {viewerCount > 0 && (
                  <span className="opacity-80 ml-1">• {viewerCount.toLocaleString()} viewers</span>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2 bg-muted text-muted-foreground px-3 py-1.5 rounded-full text-xs font-medium border">
                <Radio className="w-3.5 h-3.5" />
                OFF AIR
              </div>
            )}
          </div>
          <div className="flex items-center gap-3">
            <div
              className="hidden md:flex items-center gap-2 bg-muted text-muted-foreground px-3 py-1.5 rounded-full text-xs font-medium border"
              title="Theme switches automatically based on local time"
            >
              <ThemeIcon className="w-3.5 h-3.5" />
              {isMidnightTheme ? "Auto Midnight" : "Light Theme"}
              <span className="opacity-70">• {getLocalTimeZone()}</span>
            </div>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto bg-muted/30">
          <div className="p-6 max-w-6xl mx-auto">{children}</div>
        </main>
      </div>

      <AdminKeyDialog open={keyDialogOpen} onOpenChange={setKeyDialogOpen} />
    </div>
  );
}
