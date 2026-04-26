import React from "react";
import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  Video,
  ListVideo,
  Calendar,
  BellRing,
  BarChart2,
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
  Radio,
  Wifi,
  WifiOff,
  Loader2,
  ChevronRight,
  HandHeart,
} from "lucide-react";
import {
  applyAutoTheme,
  getLocalTimeZone,
  getThemeMode,
  isMidnightHour,
  nextThemeMode,
  setThemeMode,
  type ThemeMode,
} from "@/lib/theme";
import { getAdminToken, setAdminToken } from "@/lib/admin-access";
import { TempleTvLogo } from "@/components/temple-tv-logo";
import { AdminKeyDialog } from "@/components/admin-key-dialog";
import { CommandPalette, CommandPaletteTrigger, useCommandPalette } from "@/components/command-palette";
import { useSSE } from "@/contexts/SSEContext";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: React.ReactNode;
}

interface NavSection {
  label: string;
  items: NavItem[];
}

function SSEIndicator() {
  const { state } = useSSE();
  if (state === "connected") {
    return (
      <div className="flex items-center gap-1.5 text-xs text-emerald-600 font-medium">
        <Wifi className="w-3 h-3" />
        Live sync
      </div>
    );
  }
  if (state === "reconnecting" || state === "connecting") {
    return (
      <div className="flex items-center gap-1.5 text-xs text-amber-500 font-medium">
        <Loader2 className="w-3 h-3 animate-spin" />
        Reconnecting
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium">
      <WifiOff className="w-3 h-3" />
      Offline
    </div>
  );
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className={cn(
        "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-all duration-150",
        active
          ? "bg-primary text-primary-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground hover:bg-accent",
      )}
    >
      <Icon className="w-4 h-4 shrink-0" />
      <span className="flex-1 truncate">{item.label}</span>
      {item.badge}
      {active && <ChevronRight className="w-3.5 h-3.5 opacity-60 shrink-0" />}
    </Link>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [hasAdminToken, setHasAdminToken] = React.useState(() => Boolean(getAdminToken()));
  const [keyDialogOpen, setKeyDialogOpen] = React.useState(false);
  const { lastStatusPayload } = useSSE();
  const { open: paletteOpen, setOpen: setPaletteOpen } = useCommandPalette();
  const [themeMode, setThemeModeState] = React.useState<ThemeMode>(() => getThemeMode());
  // Re-render whenever the resolved theme changes (auto-tick at midnight, or
  // operator override). Listen for storage events so a toggle in another tab
  // is reflected here too.
  React.useEffect(() => {
    const customHandler = (e: Event) => {
      // Validate the payload before trusting it — anything could dispatch a
      // CustomEvent at this name, and an invalid value would crash the
      // resolver downstream.
      if (e instanceof CustomEvent) {
        const v = e.detail;
        if (v === "auto" || v === "light" || v === "dark") {
          setThemeModeState(v);
          return;
        }
      }
      setThemeModeState(getThemeMode());
    };
    const storageHandler = (e: StorageEvent) => {
      // Only react when our specific key changed; other admin localStorage
      // writes (admin token, viewer history, etc.) shouldn't trigger a
      // theme re-render.
      if (e.key === null || e.key === "temple-tv-admin-theme-mode") {
        setThemeModeState(getThemeMode());
      }
    };
    window.addEventListener("temple-tv-theme-mode-changed", customHandler);
    window.addEventListener("storage", storageHandler);
    return () => {
      window.removeEventListener("temple-tv-theme-mode-changed", customHandler);
      window.removeEventListener("storage", storageHandler);
    };
  }, []);
  const isMidnightTheme =
    themeMode === "dark" || (themeMode === "auto" && isMidnightHour());
  const ThemeIcon = isMidnightTheme ? Moon : Sun;
  const themeLabel =
    themeMode === "auto"
      ? `Auto · ${isMidnightTheme ? "Midnight" : "Light"}`
      : themeMode === "dark"
        ? "Dark"
        : "Light";
  const themeTooltip =
    themeMode === "auto"
      ? "Theme switches automatically based on your local time. Click to override."
      : themeMode === "dark"
        ? "Forced dark mode. Click to switch to Auto."
        : "Forced light mode. Click to switch to Dark.";
  const cycleTheme = () => {
    const next = nextThemeMode(themeMode);
    // setThemeMode already calls applyAutoTheme() and dispatches the
    // cross-tab event — calling either again here would just be a redundant
    // DOM write.
    setThemeMode(next);
    setThemeModeState(next);
  };

  const isLive = lastStatusPayload?.isLive ?? false;
  const hasLiveOverride = Boolean(lastStatusPayload?.liveOverride);
  const sourceLabel = hasLiveOverride
    ? "Override"
    : lastStatusPayload?.ytLive
      ? "YouTube"
      : null;

  React.useEffect(() => {
    const sync = () => setHasAdminToken(Boolean(getAdminToken()));
    window.addEventListener("temple-tv-admin-token-changed", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("temple-tv-admin-token-changed", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const navSections: NavSection[] = [
    {
      label: "Overview",
      items: [
        { href: "/", label: "Dashboard", icon: LayoutDashboard },
      ],
    },
    {
      label: "Broadcast",
      items: [
        {
          href: "/live-control",
          label: "Live Control",
          icon: Signal,
          badge: hasLiveOverride ? (
            <span className="inline-flex items-center gap-0.5 text-[9px] font-bold bg-red-500 text-white px-1.5 py-0.5 rounded-full leading-none">
              ON AIR
            </span>
          ) : undefined,
        },
        { href: "/live-ingest", label: "Live Ingest", icon: Radio },
        { href: "/broadcast", label: "Broadcast Queue", icon: Tv2 },
        { href: "/live-monitor", label: "Live Monitor", icon: MonitorPlay },
        { href: "/schedule", label: "Schedule", icon: Calendar },
      ],
    },
    {
      label: "Media",
      items: [
        { href: "/videos", label: "Video Library", icon: Video },
        { href: "/playlists", label: "Playlists", icon: ListVideo },
        { href: "/transcoding", label: "Transcoding", icon: Cpu },
      ],
    },
    {
      label: "Audience",
      items: [
        { href: "/analytics", label: "Analytics", icon: BarChart2 },
        { href: "/users", label: "Registered Users", icon: Users },
        { href: "/notifications", label: "Notifications", icon: BellRing },
        { href: "/prayers", label: "Prayer Requests", icon: HandHeart },
      ],
    },
    {
      label: "System",
      items: [
        { href: "/operations", label: "Operations", icon: ShieldCheck },
        { href: "/launch-readiness", label: "Launch Readiness", icon: Rocket },
      ],
    },
  ];

  const handleSignOut = () => {
    if (window.confirm("Sign out of the admin console? Your admin key will be removed from this browser.")) {
      setAdminToken("");
    }
  };

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden">
      <aside className="w-60 border-r bg-card flex flex-col shrink-0">
        <div className="h-14 flex items-center gap-3 px-4 border-b shrink-0">
          <TempleTvLogo size={32} />
          <div className="flex items-baseline gap-1.5 min-w-0">
            <span className="font-bold text-sm tracking-tight truncate">Temple TV</span>
            <span className="text-[9px] font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded-sm uppercase shrink-0">
              JCTM
            </span>
          </div>
        </div>

        <nav className="flex-1 py-3 overflow-y-auto">
          {navSections.map((section) => (
            <div key={section.label} className="mb-2">
              <div className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                {section.label}
              </div>
              <div className="px-2 space-y-0.5">
                {section.items.map((item) => (
                  <NavLink
                    key={item.href}
                    item={item}
                    active={
                      item.href === "/"
                        ? location === "/"
                        : location === item.href || location.startsWith(item.href + "/")
                    }
                  />
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="border-t p-3 space-y-1">
          <div className="px-3 py-1">
            <SSEIndicator />
          </div>
          <button
            type="button"
            onClick={() => setKeyDialogOpen(true)}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <KeyRound className="w-4 h-4 shrink-0" />
            <span className="flex-1 text-left text-sm truncate">
              {hasAdminToken ? "Admin key set" : "Set admin key"}
            </span>
            <span
              className={cn(
                "h-2 w-2 rounded-full shrink-0",
                hasAdminToken ? "bg-emerald-500" : "bg-amber-500",
              )}
              aria-hidden
            />
          </button>
          {hasAdminToken && (
            <button
              type="button"
              onClick={handleSignOut}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
            >
              <LogOut className="w-4 h-4 shrink-0" />
              Sign out
            </button>
          )}
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 border-b bg-card flex items-center justify-between px-5 shrink-0">
          <div className="flex items-center gap-3">
            {isLive || hasLiveOverride ? (
              <Link
                href="/live-control"
                className="flex items-center gap-2 bg-red-500/10 text-red-500 px-3 py-1.5 rounded-full text-xs font-semibold border border-red-500/20 hover:bg-red-500/15 transition-colors"
                title="Open Live Control"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
                ON AIR
                {sourceLabel && (
                  <span className="opacity-70 font-normal uppercase tracking-wide text-[10px]">
                    · {sourceLabel}
                  </span>
                )}
                {hasLiveOverride && lastStatusPayload?.liveOverride?.title && (
                  <span className="opacity-70 font-normal max-w-[140px] truncate hidden lg:inline">
                    — {lastStatusPayload.liveOverride.title}
                  </span>
                )}
              </Link>
            ) : (
              <Link
                href="/live-control"
                className="flex items-center gap-2 bg-muted text-muted-foreground px-3 py-1.5 rounded-full text-xs font-medium border hover:bg-accent hover:text-foreground transition-colors"
                title="Open Live Control"
              >
                <Radio className="w-3 h-3" />
                OFF AIR
              </Link>
            )}
            {(isLive || hasLiveOverride) && lastStatusPayload && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="hidden sm:flex items-center gap-1.5 text-xs text-red-500/90 font-medium cursor-default">
                    <Users className="w-3.5 h-3.5" />
                    {(lastStatusPayload.deviceCount ?? 0).toLocaleString()}
                    <span className="opacity-60 font-normal hidden md:inline">watching</span>
                  </div>
                </TooltipTrigger>
                <TooltipContent>Live viewer estimate (connected devices)</TooltipContent>
              </Tooltip>
            )}
            {!(isLive || hasLiveOverride) && lastStatusPayload && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="hidden md:flex items-center gap-1.5 text-xs text-muted-foreground cursor-default">
                    <Users className="w-3.5 h-3.5" />
                    {(lastStatusPayload.deviceCount ?? 0).toLocaleString()} devices
                  </div>
                </TooltipTrigger>
                <TooltipContent>Registered devices</TooltipContent>
              </Tooltip>
            )}
          </div>

          <div className="flex items-center gap-2">
            <CommandPaletteTrigger onClick={() => setPaletteOpen(true)} />
            <button
              type="button"
              onClick={cycleTheme}
              className="hidden md:flex items-center gap-1.5 bg-muted text-muted-foreground hover:text-foreground hover:bg-muted/80 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
              title={themeTooltip}
              aria-label={`Theme: ${themeLabel}. Click to cycle.`}
            >
              <ThemeIcon className="w-3.5 h-3.5" />
              {themeLabel}
              <span className="opacity-60">· {getLocalTimeZone()}</span>
            </button>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto bg-muted/20">
          <div className="p-6 max-w-screen-xl mx-auto">{children}</div>
        </main>
      </div>

      <AdminKeyDialog open={keyDialogOpen} onOpenChange={setKeyDialogOpen} />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
