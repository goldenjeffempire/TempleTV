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
} from "lucide-react";
import { useGetLiveStatus } from "@workspace/api-client-react";
import { getLocalTimeZone, isMidnightHour } from "@/lib/theme";
import { getAdminToken, setAdminToken } from "@/lib/admin-access";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [hasAdminToken, setHasAdminToken] = React.useState(() => Boolean(getAdminToken()));
  const { data: liveStatus } = useGetLiveStatus();
  const isMidnightTheme = isMidnightHour();
  const ThemeIcon = isMidnightTheme ? Moon : Sun;

  React.useEffect(() => {
    const sync = () => setHasAdminToken(Boolean(getAdminToken()));
    window.addEventListener("temple-tv-admin-token-changed", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("temple-tv-admin-token-changed", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const updateAdminToken = () => {
    const current = getAdminToken();
    const next = window.prompt(
      current
        ? "Admin access key is set. Enter a new key, or leave blank to remove it."
        : "Enter the admin access key for protected production API actions.",
      current,
    );
    if (next === null) return;
    setAdminToken(next);
  };

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
    { href: "/live-monitor", label: "Live Monitor", icon: MonitorPlay },
    { href: "/operations", label: "Operations", icon: ShieldCheck },
    { href: "/launch-readiness", label: "Launch Readiness", icon: Rocket },
  ];

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden">
      <aside className="w-64 border-r bg-card flex flex-col">
        <div className="h-16 flex items-center px-6 border-b">
          <span className="font-bold text-lg tracking-tight">Temple TV</span>
          <span className="ml-2 text-xs font-mono text-muted-foreground bg-muted px-2 py-0.5 rounded-sm">JCTM</span>
        </div>
        <nav className="flex-1 py-4 px-3 space-y-1">
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
      </aside>
      
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-16 border-b bg-card flex items-center justify-between px-6 shrink-0">
          <div className="flex items-center gap-4">
            {liveStatus?.isLive ? (
              <div className="flex items-center gap-2 bg-red-500/10 text-red-500 px-3 py-1.5 rounded-full text-xs font-medium border border-red-500/20 animate-pulse">
                <Radio className="w-3.5 h-3.5" />
                LIVE NOW
                {liveStatus.viewerCount > 0 && <span className="opacity-80 ml-1">• {liveStatus.viewerCount} viewers</span>}
              </div>
            ) : (
              <div className="flex items-center gap-2 bg-muted text-muted-foreground px-3 py-1.5 rounded-full text-xs font-medium border">
                <Radio className="w-3.5 h-3.5" />
                OFF AIR
              </div>
            )}
          </div>
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={updateAdminToken}
              className={`hidden md:flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                hasAdminToken
                  ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/20"
                  : "bg-amber-500/10 text-amber-600 border-amber-500/20"
              }`}
            >
              <KeyRound className="w-3.5 h-3.5" />
              {hasAdminToken ? "Admin key set" : "Admin key"}
            </button>
            <div className="hidden md:flex items-center gap-2 bg-muted text-muted-foreground px-3 py-1.5 rounded-full text-xs font-medium border">
              <ThemeIcon className="w-3.5 h-3.5" />
              {isMidnightTheme ? "Auto Midnight" : "Light Theme"}
              <span className="opacity-70">• {getLocalTimeZone()}</span>
            </div>
            <div className="w-8 h-8 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center text-primary text-sm font-medium">
              AD
            </div>
          </div>
        </header>
        
        <main className="flex-1 overflow-y-auto bg-muted/30">
          <div className="p-6 max-w-6xl mx-auto">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
