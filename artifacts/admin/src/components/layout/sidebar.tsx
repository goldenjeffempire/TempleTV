import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/use-auth";
import { useSSE } from "@/contexts/sse-context";
import {
  LayoutDashboard, Radio, Activity, MessageSquare,
  Video, ListMusic, BookOpen, CalendarDays, Clapperboard,
  Bell, BarChart2, Users, Heart, Settings, Shield,
  Zap, Cpu, Signal, Layers, Tv2, Wifi, WifiOff, Loader, ChevronRight, X, Youtube,
  Image, Gauge, Rss, ClipboardList, Settings2, RefreshCw, Trash2, Headphones, Lock,
  SignalLow, Moon, ScanSearch, Smartphone, ShieldAlert, Rocket, Bot, HardDrive, HeartPulse,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
  adminOnly?: boolean;
  badge?: React.ReactNode;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

// ── Persistent broadcast status strip ────────────────────────────────────────
// Polls the v2 health endpoint every 10 s so operators always see whether the
// broadcast is on-air, the current item title, and the live sequence number
// without navigating to the Master Control page.
interface BroadcastHealthData {
  mode: string;
  sequence: number;
  uptimeMs: number;
  currentTitle: string | null;
  currentKind: string | null;
  hasOverride: boolean;
  hasCurrent: boolean;
  offAirReason: string | null;
}

function parseBroadcastHealth(raw: Record<string, unknown>): BroadcastHealthData {
  return {
    mode:         typeof raw["mode"] === "string"        ? raw["mode"]        : "normal",
    sequence:     typeof raw["sequence"] === "number"    ? raw["sequence"]    : 0,
    uptimeMs:     typeof raw["uptimeMs"] === "number"    ? raw["uptimeMs"]    : 0,
    currentTitle: typeof raw["currentTitle"] === "string" ? raw["currentTitle"] : null,
    currentKind:  null,
    hasOverride:  raw["hasOverride"] === true,
    hasCurrent:   raw["hasCurrent"]  === true,
    offAirReason: typeof raw["offAirReason"] === "string" ? raw["offAirReason"] : null,
  };
}

function useBroadcastBlockedCount(): number {
  const [blocked, setBlocked] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/broadcast-v2/automation-status", { credentials: "include", cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json() as { assetHealth?: { blocked?: number } };
        if (!cancelled) setBlocked(data.assetHealth?.blocked ?? 0);
      } catch { /* noop */ }
    };
    void poll();
    const id = setInterval(() => { void poll(); }, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);
  return blocked;
}

function BroadcastStatusStrip() {
  const [health, setHealth] = useState<BroadcastHealthData | null>(null);
  const [error, setError] = useState(false);
  const blockedCount = useBroadcastBlockedCount();

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/broadcast-v2/health", { cache: "no-store" });
        if (!res.ok) { setError(true); return; }
        const data = await res.json() as Record<string, unknown>;
        if (!cancelled) {
          setHealth(parseBroadcastHealth(data));
          setError(false);
        }
      } catch {
        if (!cancelled) setError(true);
      }
    };
    void poll();
    const id = setInterval(() => { void poll(); }, 10_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (error || !health) return null;

  const isOverride = health.hasOverride || health.mode === "override";
  const isOnAir    = health.hasCurrent || isOverride;

  return (
    <div className="px-3 pt-0 pb-1 border-t border-sidebar-border">
      <Link href="/broadcast-v2" className="block group">
        <div className={cn(
          "flex items-start gap-2 px-2.5 py-2 rounded-md text-xs transition-colors",
          isOnAir
            ? "bg-green-500/8 border border-green-500/15 hover:bg-green-500/12"
            : "bg-muted/40 border border-border hover:bg-muted/60",
        )}>
          {/* Status dot */}
          <span className={cn(
            "mt-0.5 w-1.5 h-1.5 rounded-full flex-shrink-0",
            isOnAir ? "bg-green-500 animate-pulse" : "bg-muted-foreground/30",
          )} />

          <div className="flex-1 min-w-0">
            {/* Row 1: ON AIR / OFF AIR + sequence */}
            <div className="flex items-center gap-1">
              <span className={cn(
                "font-bold uppercase tracking-widest text-[9px]",
                isOnAir
                  ? "text-green-600 dark:text-green-400"
                  : "text-muted-foreground/50",
              )}>
                {isOnAir ? "On Air" : "Off Air"}
              </span>
              {isOverride && (
                <span className="text-[9px] font-semibold text-amber-500 uppercase tracking-widest">
                  · Override
                </span>
              )}
              {health.sequence > 0 && (
                <span className="ml-auto text-[9px] text-muted-foreground/40 tabular-nums">
                  #{health.sequence}
                </span>
              )}
            </div>

            {/* Row 2: Current title or off-air reason */}
            {isOnAir && health.currentTitle && (
              <p className="text-[10px] text-sidebar-foreground/70 truncate leading-tight mt-0.5">
                {health.currentTitle}
              </p>
            )}
            {!isOnAir && health.offAirReason && (
              <p className="text-[10px] text-muted-foreground/45 truncate leading-tight mt-0.5">
                {health.offAirReason}
              </p>
            )}
            {!isOnAir && !health.offAirReason && (
              <p className="text-[10px] text-muted-foreground/40 leading-tight mt-0.5">
                No content queued
              </p>
            )}
            {/* Blocked badge */}
            {blockedCount > 0 && (
              <span className="inline-flex items-center gap-0.5 mt-1 text-[9px] font-semibold text-amber-500 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded">
                <ShieldAlert size={8} /> {blockedCount} blocked
              </span>
            )}
          </div>

          <ChevronRight
            size={11}
            className="flex-shrink-0 mt-0.5 text-muted-foreground/30 group-hover:text-primary transition-colors"
          />
        </div>
      </Link>
    </div>
  );
}

function LiveBadge() {
  const { lastStatusPayload } = useSSE();
  if (!lastStatusPayload?.isLive) return null;
  return (
    <span className="ml-auto flex items-center gap-1 text-[10px] font-semibold uppercase tracking-widest text-white bg-red-600 px-1.5 py-0.5 rounded animate-pulse">
      Live
    </span>
  );
}

function ConnectionStatus() {
  const { state } = useSSE();

  const config = {
    connected:    { icon: <Wifi size={11} />,                                      label: "Live",         cls: "text-green-600 dark:text-green-400 bg-green-500/10 border-green-500/20" },
    connecting:   { icon: <Loader size={11} className="animate-spin" />,           label: "Connecting",   cls: "text-yellow-600 dark:text-yellow-400 bg-yellow-500/10 border-yellow-500/20" },
    reconnecting: { icon: <Loader size={11} className="animate-spin" />,           label: "Reconnecting", cls: "text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/20" },
    degraded:     { icon: <SignalLow size={11} />,                                 label: "Degraded",     cls: "text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/30" },
    offline:      { icon: <WifiOff size={11} />,                                   label: "Offline",      cls: "text-red-600 dark:text-red-400 bg-red-500/10 border-red-500/20" },
  }[state];

  const tooltip = {
    connected:    "Real-time updates are live",
    connecting:   "Establishing real-time connection…",
    reconnecting: "Connection lost — attempting to reconnect",
    degraded:     "Server reachable but live-update stream unavailable — data updates via polling",
    offline:      "Server unreachable — dashboard data may be stale",
  }[state];

  return (
    <div className="px-3 py-3 border-t border-sidebar-border">
      <Tooltip>
        <TooltipTrigger asChild>
          <div className={cn(
            "flex items-center gap-2 px-2.5 py-1.5 rounded-md border text-xs select-none cursor-default w-full",
            config.cls,
          )}>
            {config.icon}
            <span className="font-medium">{config.label}</span>
            <span className="ml-auto text-[10px] opacity-60">Real-time</span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" align="start">{tooltip}</TooltipContent>
      </Tooltip>
    </div>
  );
}

export function Sidebar({ onClose }: { onClose?: () => void }) {
  const [location] = useLocation();
  const { isAdmin } = useAuth();
  const automationBlocked = useBroadcastBlockedCount();

  const sections: NavSection[] = [
    {
      title: "Broadcast",
      items: [
        { href: "/", label: "Dashboard", icon: <LayoutDashboard size={16} /> },
        { href: "/live-control", label: "Live Control", icon: <Radio size={16} />, badge: <LiveBadge /> },
        { href: "/broadcast-v2",      label: "Master Control",    icon: <Layers size={16} /> },
        {
          href: "/self-healing",
          label: "Automation Center",
          icon: <Bot size={16} />,
          adminOnly: true,
          badge: automationBlocked > 0 ? (
            <span className="ml-auto text-[10px] font-semibold text-white bg-amber-500 px-1.5 py-0.5 rounded-full leading-none">
              {automationBlocked}
            </span>
          ) : undefined,
        },
        { href: "/midnight-prayers",  label: "Midnight Prayers",  icon: <Moon size={16} /> },
        { href: "/radio",             label: "Radio Station",      icon: <Headphones size={16} /> },
        { href: "/stream-health", label: "Stream Health", icon: <Activity size={16} /> },
        { href: "/chat", label: "Live Chat", icon: <MessageSquare size={16} /> },
      ],
    },
    {
      title: "Content",
      items: [
        { href: "/videos", label: "Videos", icon: <Video size={16} /> },
        { href: "/library", label: "YouTube Library", icon: <Youtube size={16} /> },
        { href: "/youtube-sync", label: "YouTube Sync", icon: <RefreshCw size={16} /> },
        { href: "/playlists", label: "Playlists", icon: <ListMusic size={16} /> },
        { href: "/series", label: "Series", icon: <BookOpen size={16} /> },
        { href: "/schedule", label: "Schedule", icon: <CalendarDays size={16} /> },
        { href: "/transcoding", label: "Transcoding", icon: <Clapperboard size={16} /> },
      ],
    },
    {
      title: "Engage",
      items: [
        { href: "/notifications", label: "Notifications", icon: <Bell size={16} /> },
        { href: "/prayers", label: "Prayers", icon: <Heart size={16} /> },
        { href: "/feedback", label: "Feedback", icon: <MessageSquare size={16} /> },
        { href: "/analytics", label: "Analytics", icon: <BarChart2 size={16} /> },
      ],
    },
    {
      title: "System",
      items: [
        { href: "/auto-monitor", label: "Auto-Heal Monitor", icon: <HeartPulse size={16} />, adminOnly: true },
        { href: "/system-health", label: "System Health", icon: <Activity size={16} />, adminOnly: true },
        { href: "/operations", label: "Operations", icon: <Cpu size={16} />, adminOnly: true },
        { href: "/diagnostics", label: "Diagnostics", icon: <ScanSearch size={16} />, adminOnly: true },
        { href: "/live-ingest", label: "Live Ingest", icon: <Wifi size={16} />, adminOnly: true },
        { href: "/live-monitor", label: "Live Monitor", icon: <Signal size={16} /> },
        { href: "/live-youtube", label: "YouTube Live", icon: <Tv2 size={16} /> },
        { href: "/playback", label: "Playback Engine", icon: <Zap size={16} /> },
        { href: "/graphics", label: "Graphics & Overlays", icon: <Image size={16} /> },
        { href: "/youtube-quota", label: "YouTube Quota", icon: <Gauge size={16} /> },
        { href: "/sse-bus", label: "SSE Event Bus", icon: <Rss size={16} />, adminOnly: true },
        { href: "/users", label: "Users", icon: <Users size={16} />, adminOnly: true },
        { href: "/security", label: "Security (MFA)", icon: <Lock size={16} /> },
        { href: "/alerts", label: "Alerts", icon: <Shield size={16} /> },
        { href: "/storage-health", label: "Storage Health", icon: <HardDrive size={16} />, adminOnly: true },
        { href: "/corrupt-media", label: "Corrupt Media", icon: <ShieldAlert size={16} /> },
        { href: "/audit-log", label: "Audit Log", icon: <ClipboardList size={16} />, adminOnly: true },
        { href: "/settings", label: "System Settings", icon: <Settings2 size={16} />, adminOnly: true },
        { href: "/launch-readiness", label: "Launch Check", icon: <Settings size={16} /> },
        { href: "/purge", label: "Storage Purge", icon: <Trash2 size={16} />, adminOnly: true },
        { href: "/app-versions", label: "App Versions", icon: <Smartphone size={16} />, adminOnly: true },
        { href: "/ota-updates",  label: "OTA Updates",  icon: <Rocket size={16} />,    adminOnly: true },
      ],
    },
  ];

  const isActive = (href: string) => {
    if (href === "/") return location === "/" || location === "/dashboard";
    return location === href || location.startsWith(href + "/");
  };

  return (
    <div className="flex flex-col h-full bg-sidebar border-r border-sidebar-border">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-4 border-b border-sidebar-border">
        <Link href="/" className="flex items-center gap-2.5 min-w-0">
          <img src="/temple-tv-logo.png" alt="Temple TV" className="h-7 w-auto object-contain flex-shrink-0" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
          <div className="min-w-0">
            <p className="text-[10px] text-sidebar-foreground/50 uppercase tracking-widest">Admin Panel</p>
          </div>
        </Link>
        {onClose && (
          <Button variant="ghost" size="icon" className="h-7 w-7 lg:hidden" onClick={onClose} aria-label="Close menu">
            <X size={14} />
          </Button>
        )}
      </div>

      {/* Nav */}
      <ScrollArea className="flex-1 px-2 py-3">
        <nav className="space-y-5">
          {sections.map((section) => {
            const visibleItems = section.items.filter((item) => !item.adminOnly || isAdmin);
            if (visibleItems.length === 0) return null;
            return (
              <div key={section.title}>
                <p className="px-2 mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-sidebar-foreground/40">
                  {section.title}
                </p>
                <ul className="space-y-0.5">
                  {visibleItems.map((item) => (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={onClose}
                        className={cn(
                          "flex items-center gap-2.5 px-2 py-2 rounded-md text-sm transition-colors group",
                          isActive(item.href)
                            ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                            : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
                        )}
                      >
                        <span className={cn(
                          "flex-shrink-0 transition-colors",
                          isActive(item.href) ? "text-primary" : "text-sidebar-foreground/40 group-hover:text-sidebar-foreground/70",
                        )}>
                          {item.icon}
                        </span>
                        <span className="truncate flex-1">{item.label}</span>
                        {item.badge}
                        {isActive(item.href) && <ChevronRight size={12} className="flex-shrink-0 text-primary" />}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </nav>
      </ScrollArea>

      {/* Broadcast status — always-visible on-air indicator */}
      <BroadcastStatusStrip />

      {/* Connection status footer */}
      <ConnectionStatus />
    </div>
  );
}
