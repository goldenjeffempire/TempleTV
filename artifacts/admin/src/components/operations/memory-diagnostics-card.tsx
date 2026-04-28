/**
 * MemoryDiagnosticsCard — live process-memory + middleware-cache panel.
 *
 * Polls `/api/admin/diagnostics/memory` every 30 s (in sync with the other
 * operations sub-cards on this page) and renders:
 *   - A 60-sample rolling sparkline of RSS / heap-used / external in MiB
 *   - The latest values as numeric tiles
 *   - The per-cache entry-count table for the BoundedTtlMaps that protect
 *     the `/api/uploads/*` chain (s3RedirectFirst HEAD/error/signed-URL,
 *     staticWithS3Fallback signed-URL, uploadRangeGuard inflight)
 *
 * Sparkline is hand-drawn SVG to keep this card off the recharts critical
 * path and inside the SPA's existing recharts-shim contract (see
 * verify:recharts-shim) — the card needs no chart library.
 *
 * Buffer is capped at 60 samples (= 30 minutes at the 30 s poll cadence)
 * so the in-tab memory footprint of this card is bounded regardless of how
 * long an operator leaves the operations page open.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, MemoryStick, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { memoryDiagnosticsApi, type MemoryDiagnostics } from "@/services/adminApi";

const POLL_INTERVAL_MS = 30_000;
const MAX_SAMPLES = 60;
const SPARKLINE_WIDTH = 320;
const SPARKLINE_HEIGHT = 80;

interface Sample {
  at: number;
  rssMb: number;
  heapUsedMb: number;
  externalMb: number;
  externalGrowthMbPerMin: number | null;
}

function formatUptime(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${h}h ${m}m`;
}

interface SparklineProps {
  samples: Sample[];
  field: "rssMb" | "heapUsedMb" | "externalMb" | "externalGrowthMbPerMin";
  colorClass: string;
  label: string;
  current: number | null;
  unit: string;
  /**
   * If provided, draw a horizontal threshold line at this value (same units
   * as the samples). Used to surface the watchdog's alert threshold so the
   * sparkline visually shows headroom against the pager.
   */
  threshold?: number;
  /** Allow negative values (e.g. growth-rate sparkline can dip below zero). */
  allowNegative?: boolean;
}

function Sparkline({
  samples,
  field,
  colorClass,
  label,
  current,
  unit,
  threshold,
  allowNegative,
}: SparklineProps) {
  const valid = samples.filter((s): s is Sample & Record<typeof field, number> => {
    const v = s[field];
    return typeof v === "number" && Number.isFinite(v);
  });
  if (valid.length < 2) {
    return (
      <div>
        <div className="mb-1 flex items-center justify-between text-xs">
          <span className="text-muted-foreground">{label}</span>
          <span className="tabular-nums font-mono text-muted-foreground">
            {current === null ? "—" : `${current} ${unit}`}
          </span>
        </div>
        <div className="flex h-[60px] items-center justify-center rounded-md border border-dashed bg-muted/10 text-[11px] text-muted-foreground">
          Collecting samples ({valid.length}/2)…
        </div>
      </div>
    );
  }
  const values = valid.map((s) => s[field] as number);
  const peak = Math.max(...values, threshold ?? -Infinity, 1);
  const trough = allowNegative ? Math.min(...values, 0) : 0;
  const range = peak - trough || 1;
  const yFor = (v: number) => SPARKLINE_HEIGHT - ((v - trough) / range) * SPARKLINE_HEIGHT;
  const points = values
    .map((v, i) => `${((i / (values.length - 1)) * SPARKLINE_WIDTH).toFixed(1)},${yFor(v).toFixed(1)}`)
    .join(" ");
  const thresholdY = threshold !== undefined ? yFor(threshold) : null;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums font-mono">
          {current === null ? "—" : `${current} ${unit}`}{" "}
          <span className="text-muted-foreground">(peak {Math.round(peak)})</span>
        </span>
      </div>
      <svg
        viewBox={`0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}`}
        preserveAspectRatio="none"
        className="h-[60px] w-full rounded-md border bg-muted/5"
        aria-label={`${label} over the last ${valid.length} samples`}
      >
        {thresholdY !== null && (
          <line
            x1="0"
            y1={thresholdY}
            x2={SPARKLINE_WIDTH}
            y2={thresholdY}
            strokeWidth="1"
            strokeDasharray="3 3"
            className="text-red-500/50"
            stroke="currentColor"
          />
        )}
        {allowNegative && (
          <line
            x1="0"
            y1={yFor(0)}
            x2={SPARKLINE_WIDTH}
            y2={yFor(0)}
            strokeWidth="0.5"
            className="text-muted-foreground/30"
            stroke="currentColor"
          />
        )}
        <polyline
          points={points}
          fill="none"
          strokeWidth="1.5"
          className={colorClass}
          stroke="currentColor"
        />
      </svg>
    </div>
  );
}

export function MemoryDiagnosticsCard() {
  const [snapshot, setSnapshot] = useState<MemoryDiagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const samplesRef = useRef<Sample[]>([]);
  const [, forceRender] = useState(0);

  const load = useCallback(async () => {
    try {
      const data = await memoryDiagnosticsApi.get();
      setSnapshot(data);
      setErr(null);
      samplesRef.current = [
        ...samplesRef.current,
        {
          at: Date.parse(data.generatedAt),
          rssMb: data.memory.rssMb,
          heapUsedMb: data.memory.heapUsedMb,
          externalMb: data.memory.externalMb,
          externalGrowthMbPerMin: data.watchdog.current.externalGrowthMbPerMin,
        },
      ].slice(-MAX_SAMPLES);
      forceRender((n) => n + 1);
    } catch (e) {
      setErr((e as Error)?.message ?? "Unable to load memory diagnostics");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = window.setInterval(load, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [load]);

  if (loading && !snapshot) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <MemoryStick className="w-4 h-4 text-primary" />
            Process Memory
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-48 rounded-md" />
        </CardContent>
      </Card>
    );
  }

  if (err && !snapshot) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <MemoryStick className="w-4 h-4 text-primary" />
            Process Memory
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">{err}</div>
        </CardContent>
      </Card>
    );
  }

  if (!snapshot) return null;

  const samples = samplesRef.current;

  return (
    <Card data-testid="memory-diagnostics-card">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          <MemoryStick className="w-4 h-4 text-primary" />
          Process Memory
          {snapshot.watchdog.alerts.rssAlertActive && (
            <Badge
              variant="destructive"
              className="text-[10px] font-mono"
              data-testid="memory-rss-alert-badge"
            >
              <AlertTriangle className="w-3 h-3 mr-1" />
              RSS alert active
            </Badge>
          )}
          {snapshot.watchdog.alerts.slopeAlertActive && (
            <Badge
              variant="destructive"
              className="text-[10px] font-mono bg-amber-600 hover:bg-amber-600"
              data-testid="memory-slope-alert-badge"
            >
              <TrendingUp className="w-3 h-3 mr-1" />
              Growth-rate alert active
            </Badge>
          )}
          <Badge
            variant="outline"
            className="ml-auto text-[10px] font-mono border-muted text-muted-foreground"
          >
            uptime {formatUptime(snapshot.uptimeSecs)} · {samples.length}/{MAX_SAMPLES} samples
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <div className="rounded-md border bg-muted/5 p-3">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">RSS</div>
            <div className="mt-1 text-lg font-semibold tabular-nums">
              {snapshot.memory.rssMb}
              <span className="ml-1 text-xs font-normal text-muted-foreground">MiB</span>
            </div>
          </div>
          <div className="rounded-md border bg-muted/5 p-3">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Heap used</div>
            <div className="mt-1 text-lg font-semibold tabular-nums">
              {snapshot.memory.heapUsedMb}
              <span className="ml-1 text-xs font-normal text-muted-foreground">MiB</span>
            </div>
          </div>
          <div className="rounded-md border bg-muted/5 p-3">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Heap total</div>
            <div className="mt-1 text-lg font-semibold tabular-nums">
              {snapshot.memory.heapTotalMb}
              <span className="ml-1 text-xs font-normal text-muted-foreground">MiB</span>
            </div>
          </div>
          <div className="rounded-md border bg-muted/5 p-3">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">External</div>
            <div className="mt-1 text-lg font-semibold tabular-nums">
              {snapshot.memory.externalMb}
              <span className="ml-1 text-xs font-normal text-muted-foreground">MiB</span>
            </div>
          </div>
          <div className="rounded-md border bg-muted/5 p-3">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">ArrayBuffers</div>
            <div className="mt-1 text-lg font-semibold tabular-nums">
              {snapshot.memory.arrayBuffersMb}
              <span className="ml-1 text-xs font-normal text-muted-foreground">MiB</span>
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <Sparkline
            samples={samples}
            field="rssMb"
            colorClass="text-primary"
            label={`RSS (resident set size, alert ≥ ${snapshot.watchdog.thresholds.rssAlertMb} MiB)`}
            current={snapshot.memory.rssMb}
            unit="MiB"
            threshold={snapshot.watchdog.thresholds.rssAlertMb}
          />
          <Sparkline
            samples={samples}
            field="heapUsedMb"
            colorClass="text-emerald-600 dark:text-emerald-400"
            label="Heap used"
            current={snapshot.memory.heapUsedMb}
            unit="MiB"
          />
          <Sparkline
            samples={samples}
            field="externalMb"
            colorClass="text-amber-600 dark:text-amber-400"
            label="External (off-heap Buffers / native)"
            current={snapshot.memory.externalMb}
            unit="MiB"
          />
          <Sparkline
            samples={samples}
            field="externalGrowthMbPerMin"
            colorClass="text-rose-600 dark:text-rose-400"
            label={`External growth rate (alert ≥ ${snapshot.watchdog.thresholds.externalGrowthAlertMbPerMin} MiB/min)`}
            current={snapshot.watchdog.current.externalGrowthMbPerMin}
            unit="MiB/min"
            threshold={snapshot.watchdog.thresholds.externalGrowthAlertMbPerMin}
            allowNegative
          />
        </div>

        <div>
          <div className="mb-2 text-xs font-medium text-muted-foreground">
            Middleware caches (entry counts)
          </div>
          {snapshot.caches.length === 0 ? (
            <div className="rounded-md border border-dashed bg-muted/10 p-4 text-center text-xs text-muted-foreground">
              No caches registered.
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="py-2 text-left font-medium">Cache</th>
                  <th className="py-2 text-right font-medium">Entries</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.caches.map((c) => (
                  <tr key={c.name} className="border-b last:border-0">
                    <td className="py-2 font-mono text-[11px]">{c.name}</td>
                    <td className="py-2 text-right tabular-nums">
                      {c.size < 0 ? <span className="text-red-500">err</span> : c.size}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
