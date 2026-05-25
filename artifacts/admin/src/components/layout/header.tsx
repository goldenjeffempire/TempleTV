import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/use-auth";
import { useTheme } from "@/contexts/theme-context";
import { useSSE } from "@/contexts/sse-context";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Menu, Radio, Users, Wifi, WifiOff, Loader, LogOut, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";

const PAGE_TITLES: Record<string, string> = {
  "/": "Dashboard", "/dashboard": "Dashboard",
  "/videos": "Videos",
  "/broadcast-v2": "Master Control",
  "/live-control": "Live Control", "/stream-health": "Stream Health",
  "/transcoding": "Transcoding", "/notifications": "Notifications",
  "/playlists": "Playlists", "/schedule": "Schedule", "/series": "Series",
  "/analytics": "Analytics", "/users": "Users", "/prayers": "Prayers",
  "/chat": "Live Chat", "/operations": "Operations", "/alerts": "Alerts",
  "/live-ingest": "Live Ingest", "/live-youtube": "YouTube Live",
  "/live-monitor": "Live Monitor", "/master-control": "Master Control",
  "/graphics": "Graphics & Overlays", "/playback": "Playback Engine",
  "/sse-bus": "SSE Event Bus", "/youtube-quota": "YouTube Quota",
  "/launch-readiness": "Launch Readiness", "/purge": "Data Purge",
  "/library": "YouTube Library", "/youtube-sync": "YouTube Sync",
  "/radio": "Radio Station", "/audit-log": "Audit Log",
  "/settings": "System Settings",
};

function SSEIndicator() {
  const { state } = useSSE();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className={cn(
          "flex items-center gap-1.5 text-xs px-2 py-1 rounded-full border transition-colors select-none",
          state === "connected"
            ? "bg-green-500/10 border-green-500/20 text-green-600 dark:text-green-400"
            : (state === "connecting" || state === "reconnecting")
              ? "bg-yellow-500/10 border-yellow-500/20 text-yellow-600"
              : state === "degraded"
                ? "bg-amber-500/10 border-amber-500/20 text-amber-600 dark:text-amber-400"
                : "bg-red-500/10 border-red-500/20 text-red-600",
        )}>
          {state === "connected" && <Wifi size={12} />}
          {(state === "connecting" || state === "reconnecting") && <Loader size={12} className="animate-spin" />}
          {state === "degraded" && <Loader size={12} />}
          {state === "offline" && <WifiOff size={12} />}
          <span className="hidden sm:inline capitalize">{state}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent>Real-time connection: {state}</TooltipContent>
    </Tooltip>
  );
}

function LivePill() {
  const { lastStatusPayload } = useSSE();
  const isLive = lastStatusPayload?.isLive;
  const viewerCount = lastStatusPayload?.deviceCount ?? 0;

  if (!isLive) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1.5 bg-red-600 text-white text-xs font-bold uppercase tracking-widest px-2.5 py-1 rounded-full animate-pulse cursor-default select-none">
          <Radio size={11} />
          ON AIR
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <span className="flex items-center gap-1">
          <Users size={12} /> {viewerCount} viewer{viewerCount !== 1 ? "s" : ""}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

function ThemeToggle() {
  const { resolvedTheme, toggleTheme } = useTheme();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={toggleTheme}
          aria-label={resolvedTheme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        >
          {resolvedTheme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {resolvedTheme === "dark" ? "Light mode" : "Dark mode"}
      </TooltipContent>
    </Tooltip>
  );
}

interface HeaderProps {
  onMenuClick: () => void;
}

export function Header({ onMenuClick }: HeaderProps) {
  const { user, logout } = useAuth();
  const qc = useQueryClient();
  const [location] = useLocation();
  const title = PAGE_TITLES[location] ?? "Admin Panel";

  const initials = user?.name
    ? user.name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()
    : (user?.email?.slice(0, 2).toUpperCase() ?? "??");

  const handleLogout = async () => {
    qc.clear();
    await logout();
  };

  return (
    <header className="h-14 flex items-center gap-3 px-4 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 z-40 shrink-0">
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 lg:hidden"
        onClick={onMenuClick}
        aria-label="Open menu"
      >
        <Menu size={18} />
      </Button>

      <h1 className="font-semibold text-sm flex-1 truncate">{title}</h1>

      <div className="flex items-center gap-2">
        <LivePill />
        <SSEIndicator />
        <ThemeToggle />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-8 w-8 rounded-full p-0" aria-label="Account menu">
              <Avatar className="h-7 w-7">
                <AvatarFallback className="text-xs bg-primary text-primary-foreground">
                  {initials}
                </AvatarFallback>
              </Avatar>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="pb-2">
              <p className="text-sm font-medium truncate">{user?.name ?? user?.email}</p>
              {user?.name && (
                <p className="text-xs text-muted-foreground truncate">{user.email}</p>
              )}
              <Badge variant="outline" className="mt-1.5 text-[10px] capitalize">
                {user?.role}
              </Badge>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="cursor-pointer text-red-600 focus:text-red-600 focus:bg-red-50 dark:focus:bg-red-950/30"
              onClick={() => void handleLogout()}
            >
              <LogOut size={14} className="mr-2" /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
