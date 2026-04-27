import { useEffect, useState, useCallback } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  renderDeployHealthApi,
  type RenderDeployHealth,
} from "@/services/adminApi";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Cpu,
  GitCommit,
  Server,
  ShieldAlert,
  XCircle,
} from "lucide-react";

// Render Deploy Health — Mission Control panel.
//
// One-glance answer to "is my deploy healthy right now?":
//   ┌──────────────────────────────────────────────────────────────────┐
//   │ Render deploy health    [commit a1b2c3d · prod]  [API ok · WORK ok] │
//   ├──────────────────────────────────────────────────────────────────┤
//   │ API process card  │  Worker process card                         │
//   ├──────────────────────────────────────────────────────────────────┤
//   │ Recent fatal logs (last 24h, capped at 10)                       │
//   │   - 12s ago  worker  Refusing to start: AWS S3…  [stack]         │
//   │   - 4m ago   api     DB connection lost                          │
//   └──────────────────────────────────────────────────────────────────┘
//
// Polled every 15s (more aggressive than ProcessStatusPanel's 10s pacing
// to avoid hammering — fatals don't change that fast). When `fatals` is
// non-empty the panel header turns amber/red so it grabs attention even
// if the operator scrolls past the cards.

const POLL_MS = 15_000;

function formatAge(sec: number): string {
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86_400)}d ago`;
}

function formatUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

export function RenderDeployHealthPanel() {
  const [data, setData] = useState<RenderDeployHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const fresh = await renderDeployHealthApi.get(signal);
      setData(fresh);
      setError(null);
    } catch (err) {
      if (signal?.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    const ctl = new AbortController();
    void refresh(ctl.signal);
    const id = setInterval(() => void refresh(ctl.signal), POLL_MS);
    return () => {
      ctl.abort();
      clearInterval(id);
    };
  }, [refresh]);

  if (error && !data) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-amber-600 dark:text-amber-300 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" />
          Render deploy health unavailable: {error}
        </CardContent>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">
          Loading Render deploy health…
        </CardContent>
      </Card>
    );
  }

  const { api, worker, fatals, deploy, sentry } = data;

  const apiHealthy = api.lifecycle.phase === "ready";
  const workerHealthy = worker.alive;
  const hasFatals = fatals.length > 0;

  // Header tone: red if any process is unhealthy, amber if there are
  // recent fatals but processes are up, emerald if everything's clean.
  const headerTone: "ok" | "warn" | "err" =
    !apiHealthy || !workerHealthy ? "err" : hasFatals ? "warn" : "ok";

  const headerToneClass =
    headerTone === "err"
      ? "border-red-500/40 bg-red-500/5"
      : headerTone === "warn"
        ? "border-amber-500/40 bg-amber-500/5"
        : "";

  return (
    <Card className={headerToneClass}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-sm font-medium gap-3 flex-wrap">
          <span className="flex items-center gap-2">
            <ShieldAlert
              className={
                headerTone === "err"
                  ? "h-4 w-4 text-red-500"
                  : headerTone === "warn"
                    ? "h-4 w-4 text-amber-500"
                    : "h-4 w-4 text-emerald-500"
              }
            />
            Render deploy health
          </span>
          <div className="flex items-center gap-2 flex-wrap">
            {deploy.commitShort && (
              <Badge
                variant="outline"
                className="font-mono text-[10px] gap-1.5"
                title={`Commit ${deploy.commit ?? deploy.commitShort}${
                  deploy.branch ? ` on ${deploy.branch}` : ""
                }`}
              >
                <GitCommit className="h-3 w-3" />
                {deploy.commitShort}
                {deploy.nodeEnv && (
                  <span className="text-muted-foreground">
                    · {deploy.nodeEnv}
                  </span>
                )}
              </Badge>
            )}
            <StatusPill label="API" healthy={apiHealthy} />
            <StatusPill label="Worker" healthy={workerHealthy} />
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* ── Process cards ────────────────────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* API process — uses the literal /healthz state */}
          <div className="rounded-md border bg-card/50 p-3 space-y-1.5">
            <div className="flex items-center justify-between mb-1">
              <span className="flex items-center gap-2 text-sm font-medium">
                <Server className="h-4 w-4 text-primary" />
                API service
              </span>
              <Badge
                variant="outline"
                className={
                  apiHealthy
                    ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40 text-[10px]"
                    : "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40 text-[10px]"
                }
              >
                /healthz {api.healthzStatus}
              </Badge>
            </div>
            <Row label="Phase" value={api.lifecycle.phase} />
            <Row label="Uptime" value={formatUptime(api.lifecycle.uptimeSec)} />
            <Row label="Run mode" value={api.runMode} />
            <Row label="PID" value={String(api.pid)} mono />
            <Row label="RSS" value={`${api.rssMb} MB`} />
          </div>

          {/* Worker — heartbeat-derived (no HTTP on Render workers) */}
          <div className="rounded-md border bg-card/50 p-3 space-y-1.5">
            <div className="flex items-center justify-between mb-1">
              <span className="flex items-center gap-2 text-sm font-medium">
                <Cpu className="h-4 w-4 text-primary" />
                Worker service
                {worker.sameProcess && (
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    (co-located)
                  </span>
                )}
              </span>
              <Badge
                variant="outline"
                className={
                  workerHealthy
                    ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40 text-[10px]"
                    : "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/40 text-[10px]"
                }
              >
                {workerHealthy ? "alive" : "stale"}
              </Badge>
            </div>
            {worker.heartbeat ? (
              <>
                <Row
                  label="Last heartbeat"
                  value={formatAge(worker.heartbeat.ageSec)}
                  emphasis={
                    worker.heartbeat.ageSec >= 90 ? "warn" : undefined
                  }
                />
                <Row label="Run mode" value={worker.heartbeat.runMode} />
                <Row label="PID" value={String(worker.heartbeat.pid)} mono />
                <Row label="RSS" value={`${worker.heartbeat.rssMb} MB`} />
              </>
            ) : (
              <div className="text-xs text-amber-600 dark:text-amber-300/80 flex items-center gap-2 pt-1">
                <AlertTriangle className="h-3.5 w-3.5" />
                No worker heartbeat yet — worker may be down or hasn't booted.
              </div>
            )}
            <div className="text-[10px] text-muted-foreground pt-1 leading-snug">
              Render workers don't expose HTTP, so liveness is derived from
              the worker's heartbeat written to shared cache every 30s.
            </div>
          </div>
        </div>

        {/* ── Recent fatals feed ──────────────────────────────────── */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground/80">
              <Activity className="h-3 w-3" />
              Recent fatal log lines
              <span className="lowercase">(24 h, last 10)</span>
            </span>
            {!sentry.configured && (
              <span className="text-[10px] text-muted-foreground">
                Sentry not configured
              </span>
            )}
          </div>

          {fatals.length === 0 ? (
            <div className="rounded-md border bg-emerald-500/5 border-emerald-500/30 p-3 text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4" />
              No fatal log lines captured in the last 24 hours.
            </div>
          ) : (
            <ul className="space-y-1.5">
              {fatals.map((f, idx) => {
                const expanded = expandedIdx === idx;
                const hasDetails = Boolean(f.err || f.stack);
                return (
                  <li
                    key={`${f.ts}-${idx}`}
                    className="rounded-md border border-red-500/30 bg-red-500/5 text-xs"
                  >
                    <button
                      type="button"
                      className="w-full text-left p-2.5 flex items-start gap-2 hover:bg-red-500/10 transition-colors"
                      onClick={() =>
                        hasDetails
                          ? setExpandedIdx(expanded ? null : idx)
                          : undefined
                      }
                      disabled={!hasDetails}
                    >
                      {hasDetails ? (
                        expanded ? (
                          <ChevronDown className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
                        )
                      ) : (
                        <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-red-500" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                          <Badge
                            variant="outline"
                            className="text-[10px] py-0 px-1.5 font-mono uppercase border-red-500/40 text-red-700 dark:text-red-300"
                          >
                            {f.role}
                          </Badge>
                          <span className="text-[10px] text-muted-foreground font-mono">
                            pid {f.pid}
                          </span>
                          <span className="text-[10px] text-muted-foreground">
                            {formatAge(f.ageSec)}
                          </span>
                          <span
                            className="text-[10px] text-muted-foreground/70 font-mono"
                            title={f.ts}
                          >
                            {new Date(f.ts).toLocaleTimeString()}
                          </span>
                        </div>
                        <div className="text-foreground break-words">
                          {f.msg}
                        </div>
                        {f.err && !expanded && (
                          <div className="text-red-700 dark:text-red-300/90 mt-0.5 truncate">
                            {f.err}
                          </div>
                        )}
                      </div>
                    </button>
                    {expanded && (f.err || f.stack) && (
                      <div className="border-t border-red-500/20 px-2.5 py-2 space-y-1.5">
                        {f.err && (
                          <div className="text-red-700 dark:text-red-300">
                            <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">
                              Error
                            </div>
                            <div className="font-mono text-[11px] break-words">
                              {f.err}
                            </div>
                          </div>
                        )}
                        {f.stack && (
                          <div>
                            <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">
                              Stack
                            </div>
                            <pre className="font-mono text-[10px] text-muted-foreground whitespace-pre-wrap break-words max-h-60 overflow-y-auto bg-muted/30 rounded p-2">
                              {f.stack}
                            </pre>
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* ── Footer: deploy metadata ─────────────────────────────── */}
        {(deploy.serviceName || deploy.instanceId) && (
          <div className="text-[10px] text-muted-foreground pt-1 border-t flex items-center gap-3 flex-wrap">
            {deploy.serviceName && (
              <span>
                service:{" "}
                <span className="font-mono">{deploy.serviceName}</span>
              </span>
            )}
            {deploy.instanceId && (
              <span>
                instance:{" "}
                <span className="font-mono">{deploy.instanceId}</span>
              </span>
            )}
            {deploy.branch && (
              <span>
                branch: <span className="font-mono">{deploy.branch}</span>
              </span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StatusPill({ label, healthy }: { label: string; healthy: boolean }) {
  return (
    <Badge
      variant="outline"
      className={
        healthy
          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40 text-[10px] gap-1"
          : "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/40 text-[10px] gap-1"
      }
    >
      {healthy ? (
        <CheckCircle2 className="h-3 w-3" />
      ) : (
        <XCircle className="h-3 w-3" />
      )}
      {label} {healthy ? "ok" : "down"}
    </Badge>
  );
}

function Row({
  label,
  value,
  mono,
  emphasis,
}: {
  label: string;
  value: string;
  mono?: boolean;
  emphasis?: "warn";
}) {
  return (
    <div className="flex items-center justify-between text-xs text-muted-foreground">
      <span>{label}</span>
      <span
        className={
          emphasis === "warn"
            ? "font-mono text-amber-600 dark:text-amber-300"
            : mono
              ? "font-mono text-foreground"
              : "text-foreground"
        }
      >
        {value}
      </span>
    </div>
  );
}
