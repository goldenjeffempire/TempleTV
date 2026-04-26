import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Gauge,
  RefreshCw,
  TrendingUp,
} from "lucide-react";
import {
  youtubeQuotaApi,
  type YouTubeQuotaHistory,
  type YouTubeQuotaStatus,
} from "@/services/adminApi";
import { Button } from "@/components/ui/button";
import { useSSEEvent } from "@/contexts/SSEContext";

/**
 * YouTube Data API quota detail page.
 *
 * Three sections:
 *   1. Headline status card — current usage, daily limit, exhaustion state.
 *   2. Last-7-days bar chart — visual trend so an operator can spot a
 *      gradual creep upwards before it triggers exhaustion.
 *   3. Per-context breakdown table — shows which API call site is burning
 *      units today (e.g. `playlistItems` vs `yt-status` vs `videos.details`).
 *
 * Subscribes to `youtube-quota-exhausted` SSE so the page refreshes the
 * instant the gate engages.
 */
export default function YouTubeQuotaPage() {
  const [status, setStatus] = useState<YouTubeQuotaStatus | null>(null);
  const [history, setHistory] = useState<YouTubeQuotaHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, h] = await Promise.all([
        youtubeQuotaApi.get(),
        youtubeQuotaApi.getHistory(),
      ]);
      setStatus(s);
      setHistory(h);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load quota data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  useSSEEvent("youtube-quota-exhausted", () => { void load(); });

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Gauge className="w-6 h-6" /> YouTube API Quota
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Best-effort tracking of the daily YouTube Data API v3 quota.
            Each successful call is attributed by its documented cost
            (search.list = 100, list endpoints = 1). Counter resets at
            midnight Pacific time (~08:00 UTC).
          </p>
        </div>
        <Button variant="outline" onClick={load} disabled={loading} className="gap-2">
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </header>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {status && <StatusCard status={status} />}
      {history && <HistoryChart history={history} />}
      {history && <ContextBreakdown history={history} />}
    </div>
  );
}

function StatusCard({ status }: { status: YouTubeQuotaStatus }) {
  const isWarn = !status.exhausted && status.percentUsed >= 80;
  const tone = status.exhausted
    ? { ring: "ring-red-500/40", icon: AlertTriangle, color: "text-red-600 dark:text-red-400", bar: "bg-red-500" }
    : isWarn
      ? { ring: "ring-amber-500/40", icon: AlertTriangle, color: "text-amber-600 dark:text-amber-400", bar: "bg-amber-500" }
      : { ring: "ring-emerald-500/40", icon: CheckCircle2, color: "text-emerald-600 dark:text-emerald-400", bar: "bg-emerald-500" };
  const Icon = tone.icon;
  return (
    <div className={`rounded-lg border bg-card p-6 ring-2 ${tone.ring}`}>
      <div className="flex items-start gap-4">
        <Icon className={`w-8 h-8 ${tone.color}`} />
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-semibold">
            {status.exhausted
              ? "Quota exhausted"
              : isWarn
                ? "Approaching daily limit"
                : "Within budget"}
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            <span className="font-mono font-semibold text-foreground">
              {status.estimatedUsedToday.toLocaleString()}
            </span>{" "}
            /{" "}
            <span className="font-mono">{status.dailyLimit.toLocaleString()}</span>{" "}
            units used today (
            <span className={tone.color}>{status.percentUsed}%</span>)
          </p>
          {status.exhausted && status.exhaustedUntil && (
            <p className="text-sm text-red-700 dark:text-red-400 mt-2 flex items-center gap-1.5">
              <Clock className="w-4 h-4" /> Resets at{" "}
              {new Date(status.exhaustedUntil).toLocaleString()}
            </p>
          )}
          {!status.exhausted && (
            <p className="text-xs text-muted-foreground mt-2">
              Next reset: {new Date(status.nextResetAt).toLocaleString()}
            </p>
          )}
          <div className="mt-4 h-2 rounded-full bg-muted overflow-hidden">
            <div
              className={`h-full transition-all ${tone.bar}`}
              style={{ width: `${Math.min(100, status.percentUsed)}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function HistoryChart({ history }: { history: YouTubeQuotaHistory }) {
  const maxUnits = Math.max(
    history.dailyLimit,
    ...history.dailyTotals.map((d) => d.units),
    1,
  );
  return (
    <div className="rounded-lg border bg-card p-6">
      <h2 className="text-base font-semibold mb-4 flex items-center gap-2">
        <TrendingUp className="w-4 h-4" /> Last 7 days
      </h2>
      <div className="flex items-end justify-between gap-2 h-40 px-1">
        {history.dailyTotals.map((d) => {
          const heightPct = Math.max(2, (d.units / maxUnits) * 100);
          const overLimit = d.units >= history.dailyLimit;
          const dayLabel = new Date(`${d.date}T00:00:00Z`).toLocaleDateString(
            undefined,
            { weekday: "short", day: "numeric" },
          );
          return (
            <div key={d.date} className="flex-1 flex flex-col items-center gap-1.5 min-w-0">
              <div className="text-[11px] text-muted-foreground font-mono tabular-nums">
                {d.units.toLocaleString()}
              </div>
              <div className="w-full flex-1 flex items-end">
                <div
                  className={`w-full rounded-t transition-all ${
                    overLimit ? "bg-red-500" : d.units >= history.dailyLimit * 0.8 ? "bg-amber-500" : "bg-emerald-500"
                  }`}
                  style={{ height: `${heightPct}%` }}
                  title={`${d.date}: ${d.units.toLocaleString()} units`}
                />
              </div>
              <div className="text-[11px] text-muted-foreground truncate w-full text-center">
                {dayLabel}
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground mt-4">
        Daily limit:{" "}
        <span className="font-mono">{history.dailyLimit.toLocaleString()}</span>{" "}
        units. Bars turn amber at 80% and red when the limit is reached.
      </p>
    </div>
  );
}

function ContextBreakdown({ history }: { history: YouTubeQuotaHistory }) {
  const total = history.todayByContext.reduce((s, c) => s + c.units, 0);
  return (
    <div className="rounded-lg border bg-card p-6">
      <h2 className="text-base font-semibold mb-4">Today by call type</h2>
      {history.todayByContext.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No YouTube API calls recorded today yet.
        </p>
      ) : (
        <div className="space-y-2">
          {history.todayByContext.map((c) => {
            const pct = total > 0 ? (c.units / total) * 100 : 0;
            return (
              <div key={c.context} className="space-y-1">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-mono">{c.context}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {c.units.toLocaleString()} units{" "}
                    <span className="text-xs">({pct.toFixed(1)}%)</span>
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
