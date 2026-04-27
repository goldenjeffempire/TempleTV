import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { adminGet, AdminApiError } from "@/services/adminApi";
import { usePollingWhenVisible } from "@/hooks/usePollingWhenVisible";
import { ErrorAlert } from "@/components/shared/error-alert";
import {
  AlertTriangle,
  BellRing,
  CheckCircle2,
  Cloud,
  Loader2,
  Lock,
  RefreshCw,
  Rocket,
  Server,
  Tv2,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";

type LaunchStatus = "ready" | "warning" | "blocked";

interface LaunchCheck {
  key: string;
  label: string;
  status: LaunchStatus;
  detail: string;
  action?: string;
}

interface LaunchCategory {
  key: string;
  label: string;
  checks: LaunchCheck[];
}

interface LaunchReadiness {
  generatedAt: string;
  environment: string;
  overallStatus: LaunchStatus;
  summary: {
    ready: number;
    warnings: number;
    blocked: number;
    total: number;
  };
  counts: {
    totalVideos: number;
    localVideos: number;
    hlsReadyLocalVideos: number;
    activeScheduleEntries: number;
    activeBroadcastItems: number;
    registeredDevices: number;
    failedTranscodes: number;
    queuedTranscodes: number;
  };
  categories: LaunchCategory[];
}

const categoryIcons: Record<string, typeof Lock> = {
  infrastructure: Server,
  security: Lock,
  content: Tv2,
  streaming: Cloud,
  growth: BellRing,
};

function statusBadge(status: LaunchStatus) {
  if (status === "ready") {
    return <Badge className="bg-emerald-500/15 text-emerald-600 border-emerald-500/25">Ready</Badge>;
  }
  if (status === "warning") {
    return <Badge className="bg-amber-500/15 text-amber-600 border-amber-500/25">Needs attention</Badge>;
  }
  return <Badge className="bg-red-500/15 text-red-600 border-red-500/25">Blocked</Badge>;
}

function statusIcon(status: LaunchStatus) {
  if (status === "ready") return <CheckCircle2 className="h-4 w-4 text-emerald-600" />;
  if (status === "warning") return <AlertTriangle className="h-4 w-4 text-amber-600" />;
  return <XCircle className="h-4 w-4 text-red-600" />;
}

export default function LaunchReadinessPage() {
  const [readiness, setReadiness] = useState<LaunchReadiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Round 4l hotfix #4: same transient-error UX pattern used on transcoding
  // and operations. The destructive toast that fired on every 15s poll
  // during a workflow restart was strictly toast spam — a single inline
  // "Reconnecting…" indicator conveys the same state without escalating
  // every cycle. Real (non-transient) failures still toast destructively.
  const [error, setError] = useState<{ message: string; transient: boolean } | null>(null);
  const { toast } = useToast();
  // Guards against overlapping fetches on slow networks and against setState
  // after the page navigates away mid-flight.
  const inFlightRef = useRef(false);
  const isMountedRef = useRef(true);

  const fetchReadiness = useCallback(async (manual = false) => {
    // Block all overlapping fetches — manual included. The Refresh button is
    // also `disabled={refreshing}`, but a manual click can race with the 15s
    // poll, and letting them overlap would let the first-completing request
    // prematurely clear `refreshing` while another is still in flight.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    if (manual) setRefreshing(true);
    try {
      const data = await adminGet<LaunchReadiness>("/admin/launch/readiness");
      if (!isMountedRef.current) return;
      setReadiness(data);
      setError(null);
    } catch (err) {
      if (!isMountedRef.current) return;
      const message = err instanceof Error ? err.message : "Could not reach the readiness endpoint.";
      const transient = err instanceof AdminApiError && err.transient === true;
      setError({ message, transient });
      // Suppress the destructive toast on transient errors — the inline
      // amber indicator already conveys "reconnecting" and the 15s poll
      // would otherwise spam a red toast every cycle during a restart.
      // Manual refresh always toasts so the operator gets feedback on
      // their explicit action.
      if (!transient || manual) {
        toast({
          title: "Launch readiness unavailable",
          description: message,
          variant: "destructive",
        });
      }
    } finally {
      inFlightRef.current = false;
      if (isMountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [toast]);

  // Visibility-aware polling — same 15s cadence when the operator is
  // looking, but pauses entirely while the tab is hidden. The readiness
  // probe is multi-stage and non-trivial; previously every backgrounded
  // launch-readiness tab kept hammering it forever.
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  usePollingWhenVisible(fetchReadiness, 15_000);

  const readinessScore = useMemo(() => {
    if (!readiness || readiness.summary.total === 0) return 0;
    return Math.round((readiness.summary.ready / readiness.summary.total) * 100);
  }, [readiness]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Launch Readiness</h1>
          <p className="text-muted-foreground mt-1">Go/no-go checklist for production, app-store, streaming, and monetization launch.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => fetchReadiness(true)} disabled={refreshing}>
          {refreshing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
          Refresh
        </Button>
      </div>

      {loading ? (
        <Card>
          <CardContent className="p-12 flex items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </CardContent>
        </Card>
      ) : !readiness && error ? (
        // First-load failure: surface the same transient/destructive
        // ErrorAlert pattern instead of a bare "Launch readiness is
        // unavailable." card. The retry button gives the operator an
        // explicit way to refresh outside the 15s poll cycle.
        error.transient ? (
          <ErrorAlert transient onRetry={() => fetchReadiness(true)} />
        ) : (
          <ErrorAlert
            title="Launch readiness unavailable"
            message={error.message}
            onRetry={() => fetchReadiness(true)}
          />
        )
      ) : readiness ? (
        <>
          <Card className="overflow-hidden">
            <CardContent className="p-0">
              <div className="p-5 border-b bg-card flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="flex items-start gap-4">
                  <div className="h-12 w-12 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
                    <Rocket className="h-6 w-6" />
                  </div>
                  <div>
                    <div className="flex items-center gap-3">
                      <h2 className="text-lg font-semibold">Production Launch Status</h2>
                      {statusBadge(readiness.overallStatus)}
                    </div>
                    <p className="text-sm text-muted-foreground mt-1">
                      {readiness.overallStatus === "ready"
                        ? "All tracked launch checks are ready."
                        : readiness.overallStatus === "warning"
                          ? "The platform can be tested, but some launch items still need attention."
                          : "Critical launch blockers must be fixed before production release."}
                    </p>
                  </div>
                </div>
                <div className="text-xs text-muted-foreground">
                  Updated {(() => {
                    const d = new Date(readiness.generatedAt);
                    return Number.isNaN(d.getTime()) ? "just now" : d.toLocaleTimeString();
                  })()} · {readiness.environment}
                </div>
              </div>
              <div className="p-5 space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Readiness score</span>
                  <span className="font-medium">{readinessScore}%</span>
                </div>
                <Progress value={readinessScore} className="h-2" />
                <div className="grid grid-cols-3 gap-3 pt-2">
                  <div className="rounded-lg border p-3">
                    <div className="text-2xl font-bold text-emerald-600">{readiness.summary.ready}</div>
                    <div className="text-xs text-muted-foreground">Ready</div>
                  </div>
                  <div className="rounded-lg border p-3">
                    <div className="text-2xl font-bold text-amber-600">{readiness.summary.warnings}</div>
                    <div className="text-xs text-muted-foreground">Warnings</div>
                  </div>
                  <div className="rounded-lg border p-3">
                    <div className="text-2xl font-bold text-red-600">{readiness.summary.blocked}</div>
                    <div className="text-xs text-muted-foreground">Blocked</div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Videos</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{readiness.counts.totalVideos}</div>
                <p className="text-xs text-muted-foreground mt-1">{readiness.counts.localVideos} local uploads</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Broadcast Items</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{readiness.counts.activeBroadcastItems}</div>
                <p className="text-xs text-muted-foreground mt-1">{readiness.counts.activeScheduleEntries} schedule entries</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">HLS Local Uploads</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{readiness.counts.hlsReadyLocalVideos}/{readiness.counts.localVideos}</div>
                <p className="text-xs text-muted-foreground mt-1">{readiness.counts.failedTranscodes} failed transcodes</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Devices</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{readiness.counts.registeredDevices}</div>
                <p className="text-xs text-muted-foreground mt-1">Registered for push alerts</p>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {(Array.isArray(readiness.categories) ? readiness.categories : []).map((category) => {
              const Icon = categoryIcons[category.key] ?? Rocket;
              return (
                <Card key={category.key}>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Icon className="h-5 w-5 text-primary" />
                      {category.label}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {(Array.isArray(category.checks) ? category.checks : []).map((check) => (
                      <div key={check.key} className="rounded-lg border p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-start gap-3">
                            <div className="mt-0.5">{statusIcon(check.status)}</div>
                            <div>
                              <div className="font-medium text-sm">{check.label}</div>
                              <div className="text-xs text-muted-foreground mt-1">{check.detail}</div>
                              {check.action && check.status !== "ready" ? (
                                <div className="text-xs mt-2 text-foreground">{check.action}</div>
                              ) : null}
                            </div>
                          </div>
                          {statusBadge(check.status)}
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </>
      ) : (
        <Card>
          <CardContent className="p-12 text-center text-muted-foreground">Launch readiness is unavailable.</CardContent>
        </Card>
      )}
    </div>
  );
}