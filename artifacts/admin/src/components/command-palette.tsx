import { useEffect, useState, useCallback } from "react";
import { useLocation } from "wouter";
import { fetchWithTransientRetry } from "@/services/adminApi";
import { rewriteApiPath } from "@/lib/api-base";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  LayoutDashboard,
  Video,
  ListVideo,
  Calendar,
  BellRing,
  BarChart2,
  Tv2,
  Cpu,
  ShieldCheck,
  MonitorPlay,
  Rocket,
  Users,
  Signal,
  Radio,
  RefreshCw,
  Search,
  StopCircle,
  Send,
  Youtube,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { useSSE } from "@/contexts/SSEContext";

async function adminFetch(url: string, opts?: RequestInit): Promise<Response> {
  const token = window.localStorage.getItem("temple-tv-admin-token")?.trim();
  const headers: Record<string, string> = { ...(opts?.headers as Record<string, string>) };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  // Round 4l: idempotent reads route through the shared retry wrapper.
  const method = (opts?.method ?? "GET").toUpperCase();
  const isIdempotent = method === "GET" || method === "HEAD";
  const resolvedUrl = rewriteApiPath(url);
  const factory = () => fetch(resolvedUrl, { ...opts, headers });
  return isIdempotent
    ? fetchWithTransientRetry(factory, opts?.signal ?? undefined)
    : factory();
}

type NavTarget = {
  id: string;
  label: string;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
  href: string;
};

const NAV_TARGETS: NavTarget[] = [
  { id: "nav-dashboard", label: "Dashboard", icon: LayoutDashboard, href: "/", hint: "Mission Control" },
  { id: "nav-live-control", label: "Live Control", icon: Signal, href: "/live-control", hint: "Go live · stop override" },
  { id: "nav-live-youtube", label: "Live YouTube", icon: Youtube, href: "/live-youtube", hint: "Paste a YouTube live URL · go live in one click" },
  { id: "nav-broadcast", label: "Broadcast Queue", icon: Tv2, href: "/broadcast" },
  { id: "nav-live-monitor", label: "Live Monitor", icon: MonitorPlay, href: "/live-monitor", hint: "Stream health & viewers" },
  { id: "nav-schedule", label: "Schedule", icon: Calendar, href: "/schedule" },
  { id: "nav-videos", label: "Video Library", icon: Video, href: "/videos" },
  { id: "nav-playlists", label: "Playlists", icon: ListVideo, href: "/playlists" },
  { id: "nav-transcoding", label: "Transcoding", icon: Cpu, href: "/transcoding" },
  { id: "nav-analytics", label: "Analytics", icon: BarChart2, href: "/analytics" },
  { id: "nav-users", label: "Registered Users", icon: Users, href: "/users" },
  { id: "nav-notifications", label: "Notifications", icon: BellRing, href: "/notifications" },
  { id: "nav-operations", label: "Operations", icon: ShieldCheck, href: "/operations", hint: "System health" },
  { id: "nav-launch", label: "Launch Readiness", icon: Rocket, href: "/launch-readiness" },
];

export function CommandPaletteTrigger({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      className="h-8 gap-2 text-muted-foreground hover:text-foreground"
      title="Open command palette (⌘K)"
    >
      <Search className="h-3.5 w-3.5" />
      <span className="hidden sm:inline text-xs">Quick actions…</span>
      <Kbd className="hidden md:inline-flex">⌘K</Kbd>
    </Button>
  );
}

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { lastStatusPayload } = useSSE();

  const hasOverride = Boolean(lastStatusPayload?.liveOverride);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  const go = useCallback(
    (href: string) => {
      navigate(href);
      close();
    },
    [navigate, close],
  );

  const refreshTranscoding = useCallback(() => {
    queryClient.invalidateQueries({ predicate: (q) => {
      const key = q.queryKey?.[0];
      return typeof key === "string" && key.includes("transcoding");
    } });
    toast({ title: "Refreshing transcoding queue" });
    close();
  }, [queryClient, toast, close]);

  const stopOverride = useCallback(async () => {
    try {
      // The api-server exposes overrides as POST start/stop/extend actions —
      // there is no bare DELETE /admin/live/override route. Use the documented
      // stop endpoint (artifacts/api-server/src/routes/admin.ts ~/admin/live/override/stop).
      const res = await adminFetch("/api/admin/live/override/stop", { method: "POST" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      toast({ title: "Live override stopped" });
    } catch (e) {
      toast({
        title: "Failed to stop override",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      close();
    }
  }, [toast, close]);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Search pages and actions…" />
      <CommandList className="max-h-[60vh]">
        <CommandEmpty>No matches.</CommandEmpty>

        <CommandGroup heading="Quick Actions">
          <CommandItem onSelect={() => go("/live-control")} value="go live broadcast control">
            <Radio className="mr-2 h-4 w-4 text-red-500" />
            <span className="flex-1">Open Live Control</span>
            <span className="text-xs text-muted-foreground">Go live</span>
          </CommandItem>
          {hasOverride && (
            <CommandItem onSelect={stopOverride} value="stop end live override broadcast">
              <StopCircle className="mr-2 h-4 w-4 text-red-500" />
              <span className="flex-1">Stop live override</span>
              <span className="text-xs text-muted-foreground">End broadcast</span>
            </CommandItem>
          )}
          <CommandItem onSelect={() => go("/notifications")} value="send push notification">
            <Send className="mr-2 h-4 w-4 text-primary" />
            <span className="flex-1">Send push notification</span>
          </CommandItem>
          <CommandItem onSelect={refreshTranscoding} value="refresh transcoding queue jobs">
            <RefreshCw className="mr-2 h-4 w-4" />
            <span className="flex-1">Refresh transcoding queue</span>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Navigate">
          {NAV_TARGETS.map((target) => {
            const Icon = target.icon;
            return (
              <CommandItem
                key={target.id}
                value={`${target.label} ${target.hint ?? ""} ${target.href}`}
                onSelect={() => go(target.href)}
              >
                <Icon className="mr-2 h-4 w-4" />
                <span className="flex-1">{target.label}</span>
                {target.hint && (
                  <span className="text-xs text-muted-foreground">{target.hint}</span>
                )}
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

export function useCommandPalette() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMac =
        typeof navigator !== "undefined" &&
        navigator.platform.toLowerCase().includes("mac");
      const mod = isMac ? e.metaKey : e.ctrlKey;
      // Only react to a clean Cmd/Ctrl+K (no Alt/Shift) and ignore when the
      // user is typing into an editable surface so we don't steal keystrokes.
      if (
        mod &&
        !e.altKey &&
        !e.shiftKey &&
        (e.key === "k" || e.key === "K")
      ) {
        if (isEditableTarget(e.target)) return;
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return { open, setOpen };
}
