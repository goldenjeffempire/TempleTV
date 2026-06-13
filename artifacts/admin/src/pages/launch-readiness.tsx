import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, isTransientError} from "@/lib/api";
import { useSSEEvent } from "@/contexts/sse-context";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorAlert } from "@/components/shared/error-alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckCircle2, XCircle, AlertCircle, RefreshCw, Rocket, ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";

type CheckStatus = "ready" | "warning" | "blocked";

interface Check {
  key: string;
  label: string;
  status: CheckStatus;
  detail: string;
  action?: string;
}

interface Category {
  key: string;
  label: string;
  checks: Check[];
}

interface ReadinessResponse {
  generatedAt: string;
  environment: string;
  overallStatus: CheckStatus;
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
    encodingLocalVideos: number;
    activeScheduleEntries: number;
    activeBroadcastItems: number;
    registeredDevices: number;
    failedTranscodes: number;
    queuedTranscodes: number;
  };
  categories: Category[];
}

const STATUS_CONFIG: Record<CheckStatus, { icon: React.ReactNode; color: string; variant: "outline" | "secondary" | "destructive" }> = {
  ready: { icon: <CheckCircle2 size={15} />, color: "text-green-500", variant: "outline" },
  warning: { icon: <AlertCircle size={15} />, color: "text-amber-500", variant: "secondary" },
  blocked: { icon: <XCircle size={15} />, color: "text-red-500", variant: "destructive" },
};

const CATEGORY_WORST: Record<CheckStatus, number> = { ready: 0, warning: 1, blocked: 2 };

function categoryStatus(checks: Check[]): CheckStatus {
  const worst = checks.reduce((acc, c) => Math.max(acc, CATEGORY_WORST[c.status]), 0);
  return worst === 2 ? "blocked" : worst === 1 ? "warning" : "ready";
}

function CategoryCard({ cat }: { cat: Category }) {
  const [open, setOpen] = useState(true);
  const status = categoryStatus(cat.checks);
  const cfg = STATUS_CONFIG[status];

  return (
    <Card>
      <CardHeader
        className="pb-2 cursor-pointer select-none"
        onClick={() => setOpen((o) => !o)}
      >
        <CardTitle className="text-sm flex items-center justify-between">
          <span className="flex items-center gap-2">
            <span className={cfg.color}>{cfg.icon}</span>
            {cat.label}
          </span>
          <span className="flex items-center gap-2">
            <span className="text-xs font-normal text-muted-foreground">
              {cat.checks.filter(c => c.status === "ready").length}/{cat.checks.length} ready
            </span>
            {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </span>
        </CardTitle>
      </CardHeader>
      {open && (
        <CardContent className="p-0 divide-y">
          {cat.checks.map((c) => {
            const icfg = STATUS_CONFIG[c.status];
            return (
              <div key={c.key} className="flex items-start gap-3 px-4 py-3">
                <span className={`flex-shrink-0 mt-0.5 ${icfg.color}`}>{icfg.icon}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{c.label}</p>
                  <p className="text-xs text-muted-foreground">{c.detail}</p>
                  {c.action && (
                    <p className="text-xs text-muted-foreground/70 mt-0.5 italic">→ {c.action}</p>
                  )}
                </div>
                <Badge
                  variant={icfg.variant}
                  className="capitalize text-[10px] flex-shrink-0"
                >
                  {c.status}
                </Badge>
              </div>
            );
          })}
        </CardContent>
      )}
    </Card>
  );
}

export default function LaunchReadinessPage() {
  const qc = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["launch-readiness"],
    queryFn: () => api.get<ReadinessResponse>("/admin/launch/readiness"),
    refetchInterval: 60_000,
    staleTime: 55_000,
  });

  // SSE-driven invalidation — any of these events can change the readiness
  // report (new/failed transcodes, queue changes, library additions).
  const invalidateReadiness = () => { void qc.invalidateQueries({ queryKey: ["launch-readiness"] }); };
  useSSEEvent("broadcast-queue-updated", invalidateReadiness);
  useSSEEvent("videos-library-updated",  invalidateReadiness);
  useSSEEvent("transcoding-update",      invalidateReadiness);

  const { overallStatus, summary, categories, counts, environment } = data ?? {};

  const bannerColor =
    overallStatus === "ready"
      ? "border-green-500/40 bg-green-500/5"
      : overallStatus === "blocked"
      ? "border-red-500/40 bg-red-500/5"
      : "border-amber-500/40 bg-amber-500/5";

  const bannerIcon =
    overallStatus === "ready"
      ? <Rocket size={20} className="text-green-500" />
      : overallStatus === "blocked"
      ? <XCircle size={20} className="text-red-500" />
      : <AlertCircle size={20} className="text-amber-500" />;

  const bannerText =
    overallStatus === "ready"
      ? "Ready to launch!"
      : overallStatus === "blocked"
      ? "Not ready — fix failures first"
      : "Mostly ready — review warnings";

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-6">
      <PageHeader
        title="Launch Readiness"
        description="Pre-launch checklist for going live safely."
        actions={
          <Button variant="outline" size="sm" onClick={() => void refetch()} className="gap-1.5">
            <RefreshCw size={13} /> Re-check
          </Button>
        }
      />

      {error && (
        <ErrorAlert
          message={(error as Error).message}
          onRetry={() => void refetch()}
          transient={isTransientError(error)}
        />
      )}

      {isLoading && (
        <div className="space-y-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="flex items-center gap-3 p-4 rounded-xl border bg-card">
              <Skeleton className="h-5 w-5 rounded-full" />
              <Skeleton className="h-4 w-48" />
            </div>
          ))}
        </div>
      )}

      {!isLoading && data && (
        <>
          <div className={`flex items-start gap-3 p-4 rounded-xl border-2 ${bannerColor}`}>
            {bannerIcon}
            <div className="flex-1">
              <p className="font-bold">{bannerText}</p>
              <p className="text-xs text-muted-foreground">
                {summary?.ready}/{summary?.total} checks passing
                {(summary?.warnings ?? 0) > 0 ? `, ${summary!.warnings} warning${summary!.warnings !== 1 ? "s" : ""}` : ""}
                {(summary?.blocked ?? 0) > 0 ? `, ${summary!.blocked} blocker${summary!.blocked !== 1 ? "s" : ""}` : ""}
                {environment ? ` · ${environment}` : ""}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            {[
              { label: "Total Videos", value: counts?.totalVideos ?? 0 },
              { label: "HLS Ready", value: counts?.hlsReadyLocalVideos ?? 0 },
              { label: "Push Subscribers", value: counts?.registeredDevices ?? 0 },
              { label: "Broadcast Items", value: counts?.activeBroadcastItems ?? 0 },
              { label: "Schedule Entries", value: counts?.activeScheduleEntries ?? 0 },
              { label: "Failed Encodes", value: counts?.failedTranscodes ?? 0 },
            ].map((m) => (
              <div key={m.label} className="rounded-lg border bg-card p-3 text-center">
                <p className="text-xl font-bold">{m.value}</p>
                <p className="text-xs text-muted-foreground">{m.label}</p>
              </div>
            ))}
          </div>

          <div className="space-y-3">
            {(categories ?? []).map((cat) => (
              <CategoryCard key={cat.key} cat={cat} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
