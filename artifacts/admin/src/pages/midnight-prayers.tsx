import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import {
  Moon,
  Clock,
  Film,
  RefreshCw,
  Play,
  Video,
  Globe,
  Settings,
  AlertCircle,
  CheckCircle2,
  Timer,
  SkipForward,
} from "lucide-react";
import { Link } from "wouter";

// ── Types ─────────────────────────────────────────────────────────────────────

interface MPConfig {
  enabled: boolean;
  startHour: number;
  endHour: number;
  timezone: string;
  updatedAt: string;
}

interface MPVideo {
  id: string;
  title: string;
  thumbnailUrl: string | null;
  durationSecs: number;
  localVideoUrl: string | null;
  hlsMasterUrl: string | null;
}

interface MPQueueResponse {
  config: MPConfig;
  videos: MPVideo[];
  totalVideos: number;
  totalDurationSecs: number;
  cycleLengthHours: number;
}

interface MPStateResponse {
  state: {
    mode: string;
    current: { title: string; durationSecs: number; startsAtMs: number; endsAtMs: number } | null;
    next: { title: string; durationSecs: number } | null;
    meta: { totalVideos: number; cycleLengthMs: number };
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const TIMEZONES = [
  { value: "Africa/Lagos",       label: "Lagos (WAT, UTC+1)" },
  { value: "Africa/Abidjan",     label: "Abidjan (GMT, UTC+0)" },
  { value: "Africa/Accra",       label: "Accra (GMT, UTC+0)" },
  { value: "Africa/Nairobi",     label: "Nairobi (EAT, UTC+3)" },
  { value: "Africa/Johannesburg",label: "Johannesburg (SAST, UTC+2)" },
  { value: "America/New_York",   label: "New York (EST/EDT)" },
  { value: "America/Chicago",    label: "Chicago (CST/CDT)" },
  { value: "America/Los_Angeles",label: "Los Angeles (PST/PDT)" },
  { value: "America/Sao_Paulo",  label: "São Paulo (BRT)" },
  { value: "Europe/London",      label: "London (GMT/BST)" },
  { value: "Europe/Paris",       label: "Paris (CET/CEST)" },
  { value: "Asia/Dubai",         label: "Dubai (GST, UTC+4)" },
  { value: "Asia/Kolkata",       label: "India (IST, UTC+5:30)" },
  { value: "Asia/Singapore",     label: "Singapore (SGT, UTC+8)" },
  { value: "Asia/Tokyo",         label: "Tokyo (JST, UTC+9)" },
  { value: "Australia/Sydney",   label: "Sydney (AEST/AEDT)" },
  { value: "UTC",                label: "UTC" },
];

const HOURS = Array.from({ length: 24 }, (_, i) => ({
  value: String(i),
  label: i === 0 ? "12:00 AM (Midnight)" :
         i < 12  ? `${i}:00 AM` :
         i === 12 ? "12:00 PM (Noon)" :
                    `${i - 12}:00 PM`,
}));

function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function isCurrentlyInWindow(startHour: number, endHour: number): boolean {
  const hour = new Date().getHours();
  if (endHour > startHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

function getLocalHour(): number {
  return new Date().getHours();
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function MidnightPrayersPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [localHour, setLocalHour] = useState(getLocalHour);
  const [pendingConfig, setPendingConfig] = useState<Partial<MPConfig>>({});

  // Keep local clock display updated
  useEffect(() => {
    const t = setInterval(() => setLocalHour(getLocalHour()), 15_000);
    return () => clearInterval(t);
  }, []);

  const { data: queueData, isLoading: queueLoading, error: queueError, refetch: refetchQueue } = useQuery<MPQueueResponse>({
    queryKey: ["midnight-prayers/queue"],
    queryFn: () => api.get<MPQueueResponse>("/midnight-prayers/queue"),
    staleTime: 60_000,
  });

  const { data: stateData } = useQuery<MPStateResponse>({
    queryKey: ["midnight-prayers/state"],
    queryFn: () => api.get<MPStateResponse>("/midnight-prayers/state"),
    refetchInterval: 10_000,
    staleTime: 5_000,
  });

  const config = queueData?.config;
  const mergedConfig = config ? { ...config, ...pendingConfig } : undefined;
  const inWindow = mergedConfig
    ? isCurrentlyInWindow(mergedConfig.startHour, mergedConfig.endHour)
    : false;

  const updateConfigMutation = useMutation({
    mutationFn: (patch: Partial<MPConfig>) =>
      api.patch<MPConfig>("/midnight-prayers/config", patch),
    onSuccess: () => {
      setPendingConfig({});
      qc.invalidateQueries({ queryKey: ["midnight-prayers/queue"] });
      // Also invalidate state so the "In Window / Out of Window" badge and
      // current/next track display reflect the new start/end hours immediately —
      // without this, the state query keeps showing the previous window until
      // its 10 s refetchInterval fires.
      qc.invalidateQueries({ queryKey: ["midnight-prayers/state"] });
      toast({ title: "Schedule saved", description: "Midnight Prayers schedule updated." });
    },
    onError: () => toast({ title: "Save failed", variant: "destructive" }),
  });

  const refreshQueueMutation = useMutation({
    mutationFn: () => api.post<{ videoCount: number }>("/midnight-prayers/queue/refresh"),
    onSuccess: (data: { videoCount: number }) => {
      qc.invalidateQueries({ queryKey: ["midnight-prayers/queue"] });
      qc.invalidateQueries({ queryKey: ["midnight-prayers/state"] });
      toast({ title: "Queue refreshed", description: `${data.videoCount} videos loaded.` });
    },
    onError: () => toast({ title: "Refresh failed", variant: "destructive" }),
  });

  const hasUnsavedChanges = Object.keys(pendingConfig).length > 0;
  const saving = updateConfigMutation.isPending;

  function patchLocal(key: keyof MPConfig, value: unknown) {
    setPendingConfig((prev) => ({ ...prev, [key]: value }));
  }

  function saveChanges() {
    updateConfigMutation.mutate(pendingConfig);
  }

  const current = stateData?.state?.current;
  const next = stateData?.state?.next;
  const nowMs = Date.now();
  const progressPct = current
    ? Math.min(100, Math.max(0, ((nowMs - current.startsAtMs) / ((current.endsAtMs - current.startsAtMs) || 1)) * 100))
    : 0;

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Moon className="h-6 w-6 text-indigo-500" />
            Midnight Prayers
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Auto-broadcasts prayer content at midnight for every viewer, based on their local timezone.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Badge
            variant={mergedConfig?.enabled ? (inWindow ? "default" : "secondary") : "outline"}
            className={mergedConfig?.enabled && inWindow ? "bg-indigo-600 text-white animate-pulse" : ""}
          >
            {mergedConfig?.enabled
              ? inWindow ? "● Broadcasting Now" : "Scheduled"
              : "Disabled"}
          </Badge>
        </div>
      </div>

      {queueError && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <span>Failed to load queue: {queueError instanceof Error ? queueError.message : String(queueError)}</span>
          <Button variant="ghost" size="sm" className="ml-auto h-6 px-2" onClick={() => void refetchQueue()}>
            Retry
          </Button>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* ── Live Status ─────────────────────────────────────────────────── */}
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Play className="h-4 w-4 text-indigo-500" />
                Live Playback Status
              </CardTitle>
              <CardDescription>
                {inWindow
                  ? "Midnight Prayers is active for your local timezone right now."
                  : `Currently ${localHour}:00 local — window opens at ${mergedConfig?.startHour ?? 0}:00.`}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {stateData?.state?.mode === "offline_hold" || !current ? (
                <div className="flex items-center gap-3 p-4 rounded-lg bg-muted text-muted-foreground">
                  <AlertCircle className="h-5 w-5 shrink-0" />
                  <div>
                    <p className="font-medium text-sm">No content available</p>
                    <p className="text-xs mt-0.5">
                      Upload videos with the <strong>Midnight Prayers</strong> category to populate the queue.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {/* Current item */}
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Now Playing</p>
                    <div className="flex items-start gap-3">
                      <div className="mt-1 h-2 w-2 rounded-full bg-indigo-500 animate-pulse shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold truncate">{current.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatDuration(current.durationSecs)} · {Math.round(progressPct)}% complete
                        </p>
                        {/* Progress bar */}
                        <div className="mt-2 h-1.5 w-full rounded-full bg-muted overflow-hidden">
                          <div
                            className="h-full rounded-full bg-indigo-500 transition-all duration-1000"
                            style={{ width: `${progressPct}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Next item */}
                  {next && (
                    <div className="flex items-start gap-3 opacity-60">
                      <SkipForward className="h-3.5 w-3.5 mt-1 shrink-0 text-muted-foreground" />
                      <div>
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Up Next</p>
                        <p className="text-sm truncate">{next.title}</p>
                        <p className="text-xs text-muted-foreground">{formatDuration(next.durationSecs)}</p>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <Separator />

              {/* Stats row */}
              <div className="grid grid-cols-3 gap-4 text-center">
                <div>
                  <p className="text-2xl font-bold text-indigo-600">{queueData?.totalVideos ?? "—"}</p>
                  <p className="text-xs text-muted-foreground">Videos</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-indigo-600">
                    {queueData?.totalDurationSecs ? formatDuration(queueData.totalDurationSecs) : "—"}
                  </p>
                  <p className="text-xs text-muted-foreground">Total Duration</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-indigo-600">
                    {queueData?.cycleLengthHours ? `${queueData.cycleLengthHours}h` : "—"}
                  </p>
                  <p className="text-xs text-muted-foreground">Cycle Length</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* ── Video Queue ─────────────────────────────────────────────────── */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2">
                  <Film className="h-4 w-4 text-indigo-500" />
                  Content Queue ({queueData?.totalVideos ?? 0} videos)
                </CardTitle>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => refreshQueueMutation.mutate()}
                    disabled={refreshQueueMutation.isPending}
                  >
                    <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${refreshQueueMutation.isPending ? "animate-spin" : ""}`} />
                    Refresh
                  </Button>
                  <Button variant="outline" size="sm" asChild>
                    <Link href="/videos">
                      <Video className="h-3.5 w-3.5 mr-1.5" />
                      Upload
                    </Link>
                  </Button>
                </div>
              </div>
              <CardDescription>
                All locally-uploaded videos assigned to the <strong>Midnight Prayers</strong> category. They play in rotation, looping continuously throughout the window.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {queueLoading ? (
                <div className="space-y-2">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="h-12 rounded-md bg-muted animate-pulse" />
                  ))}
                </div>
              ) : !queueData?.videos?.length ? (
                <div className="flex flex-col items-center justify-center py-10 text-center text-muted-foreground gap-3">
                  <Moon className="h-10 w-10 opacity-30" />
                  <div>
                    <p className="font-medium">No Midnight Prayers videos yet</p>
                    <p className="text-sm mt-1">
                      Upload videos and assign the <strong>Midnight Prayers</strong> category to add them here.
                    </p>
                  </div>
                  <Button variant="outline" size="sm" asChild>
                    <Link href="/videos">Upload Videos</Link>
                  </Button>
                </div>
              ) : (
                <div className="space-y-1.5 max-h-80 overflow-y-auto pr-1">
                  {queueData.videos.map((v, idx) => (
                    <div
                      key={v.id}
                      className="flex items-center gap-3 p-2.5 rounded-md hover:bg-muted/50 transition-colors"
                    >
                      <span className="text-xs text-muted-foreground w-5 text-right shrink-0 font-mono">
                        {idx + 1}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{v.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatDuration(v.durationSecs)}
                          {v.hlsMasterUrl
                            ? <span className="ml-2 text-green-600 dark:text-green-400">HLS</span>
                            : v.localVideoUrl
                              ? <span className="ml-2 text-blue-600 dark:text-blue-400">MP4</span>
                              : <span className="ml-2 text-yellow-600">No source</span>}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── Schedule Config ──────────────────────────────────────────────── */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Settings className="h-4 w-4 text-indigo-500" />
                Schedule Configuration
              </CardTitle>
              <CardDescription>
                Controls when Midnight Prayers activates for each viewer based on their local clock.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {/* Enable / Disable */}
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="mp-enabled" className="font-medium">Enable Midnight Prayers</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    When off, all devices stay on the main broadcast.
                  </p>
                </div>
                <Switch
                  id="mp-enabled"
                  checked={mergedConfig?.enabled ?? true}
                  onCheckedChange={(v) => patchLocal("enabled", v)}
                  disabled={!config}
                />
              </div>

              <Separator />

              {/* Start hour */}
              <div className="space-y-1.5">
                <Label className="font-medium flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5" /> Start Hour
                </Label>
                <Select
                  value={String(mergedConfig?.startHour ?? 0)}
                  onValueChange={(v) => patchLocal("startHour", Number(v))}
                  disabled={!config}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HOURS.map((h) => (
                      <SelectItem key={h.value} value={h.value}>{h.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* End hour */}
              <div className="space-y-1.5">
                <Label className="font-medium flex items-center gap-1.5">
                  <Timer className="h-3.5 w-3.5" /> End Hour
                </Label>
                <Select
                  value={String(mergedConfig?.endHour ?? 3)}
                  onValueChange={(v) => patchLocal("endHour", Number(v))}
                  disabled={!config}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HOURS.filter((h) => Number(h.value) >= 1).map((h) => (
                      <SelectItem key={h.value} value={h.value}>{h.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Timezone */}
              <div className="space-y-1.5">
                <Label className="font-medium flex items-center gap-1.5">
                  <Globe className="h-3.5 w-3.5" /> Server Reference Timezone
                </Label>
                <p className="text-xs text-muted-foreground">
                  Used to anchor the cycle epoch. Viewers always use their own local clock for the window.
                </p>
                <Select
                  value={mergedConfig?.timezone ?? "Africa/Lagos"}
                  onValueChange={(v) => patchLocal("timezone", v)}
                  disabled={!config}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TIMEZONES.map((tz) => (
                      <SelectItem key={tz.value} value={tz.value}>{tz.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Save */}
              {hasUnsavedChanges && (
                <Button
                  className="w-full bg-indigo-600 hover:bg-indigo-700"
                  onClick={saveChanges}
                  disabled={saving}
                >
                  {saving ? (
                    <><RefreshCw className="h-4 w-4 mr-2 animate-spin" /> Saving…</>
                  ) : (
                    <><CheckCircle2 className="h-4 w-4 mr-2" /> Save Changes</>
                  )}
                </Button>
              )}
            </CardContent>
          </Card>

          {/* Info card */}
          <Card className="bg-indigo-50 dark:bg-indigo-950/30 border-indigo-200 dark:border-indigo-800">
            <CardContent className="pt-5 text-sm text-indigo-800 dark:text-indigo-200 space-y-2">
              <p className="font-semibold flex items-center gap-1.5">
                <Moon className="h-4 w-4" /> How it works
              </p>
              <ul className="space-y-1.5 text-xs leading-relaxed text-indigo-700 dark:text-indigo-300">
                <li>• Every viewer's device checks their local clock.</li>
                <li>• Between the configured hours, the player switches automatically to the Midnight Prayers channel.</li>
                <li>• All videos in the queue loop continuously until the window ends.</li>
                <li>• At end time, the main broadcast resumes seamlessly.</li>
                <li>• Viewers in different timezones get Midnight Prayers at their own local midnight.</li>
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
