import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Bell,
  BellOff,
  CheckCircle2,
  Clock,
  Gauge,
  PauseCircle,
  RefreshCw,
  Send,
  TrendingUp,
} from "lucide-react";
import {
  opsAlertsApi,
  youtubeQuotaApi,
  type AlertChannelStatus,
  type AlertingStatus,
  type AlertTestResult,
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
  useSSEEvent("youtube-quota-throttled", () => { void load(); });

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
      {status && <ThrottleCard status={status} />}
      <AlertsCard />
      {history && <HistoryChart history={history} />}
      {history && <ContextBreakdown history={history} />}
    </div>
  );
}

function channelLabel(s: AlertChannelStatus): {
  text: string;
  className: string;
} {
  switch (s) {
    case "sent":
      return {
        text: "sent",
        className:
          "text-emerald-700 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/30",
      };
    case "failed":
      return {
        text: "failed",
        className:
          "text-red-700 dark:text-red-400 bg-red-500/10 border-red-500/30",
      };
    case "skipped":
      return {
        text: "skipped (deduped)",
        className:
          "text-amber-700 dark:text-amber-400 bg-amber-500/10 border-amber-500/30",
      };
    case "disabled":
    default:
      return {
        text: "not configured",
        className:
          "text-muted-foreground bg-muted/40 border-border",
      };
  }
}

function AlertsCard() {
  const [alerts, setAlerts] = useState<AlertingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [testResult, setTestResult] = useState<AlertTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await opsAlertsApi.getStatus();
      setAlerts(s);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load alert status");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sendTest = useCallback(async () => {
    setSending(true);
    setTestResult(null);
    try {
      const r = await opsAlertsApi.sendTest();
      setTestResult(r);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Test alert failed");
    } finally {
      setSending(false);
    }
  }, [load]);

  if (loading) return null;

  const configured = alerts?.configured ?? false;
  const Icon = configured ? Bell : BellOff;

  return (
    <div className="rounded-lg border bg-card p-5">
      <div className="flex items-start gap-3">
        <Icon
          className={`w-5 h-5 mt-0.5 ${
            configured ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground"
          }`}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h2 className="text-base font-semibold">Ops alerting</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Auto-throttle and quota-exhausted events fire warning /
                critical alerts to your configured channels (de-duped per
                day so on-call is never spammed).
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={sendTest}
              disabled={sending || !configured}
              className="gap-2"
              title={
                configured
                  ? "Send a test alert through every configured channel"
                  : "Configure ALERT_SLACK_WEBHOOK_URL or ALERT_WEBHOOK_URL first"
              }
            >
              <Send className={`w-4 h-4 ${sending ? "animate-pulse" : ""}`} />
              Send test alert
            </Button>
          </div>

          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div
              className={`rounded-md border px-3 py-2 text-sm flex items-center justify-between ${
                alerts?.channels.slack
                  ? "bg-emerald-500/10 border-emerald-500/30"
                  : "bg-muted/40"
              }`}
            >
              <span className="font-medium">Slack-style webhook</span>
              <span className="text-xs">
                {alerts?.channels.slack ? "configured" : "not configured"}
              </span>
            </div>
            <div
              className={`rounded-md border px-3 py-2 text-sm flex items-center justify-between ${
                alerts?.channels.webhook
                  ? "bg-emerald-500/10 border-emerald-500/30"
                  : "bg-muted/40"
              }`}
            >
              <span className="font-medium">Generic JSON webhook</span>
              <span className="text-xs">
                {alerts?.channels.webhook ? "configured" : "not configured"}
              </span>
            </div>
          </div>

          {!configured && (
            <p className="text-xs text-muted-foreground mt-3">
              Set <code className="text-[11px]">ALERT_SLACK_WEBHOOK_URL</code>{" "}
              (Slack/Discord/MS Teams incoming webhook) and/or{" "}
              <code className="text-[11px]">ALERT_WEBHOOK_URL</code> (any
              JSON receiver — Zapier, n8n, custom) to enable alerting. For
              email, point the generic webhook at a Zapier "Webhook → Email"
              zap.
            </p>
          )}

          {testResult && (
            <div className="mt-3 rounded-md border bg-muted/40 px-3 py-2 text-xs">
              <div className="font-medium mb-1">Last test result</div>
              <div className="flex flex-wrap gap-2">
                <span
                  className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 ${
                    channelLabel(testResult.slack).className
                  }`}
                >
                  Slack: {channelLabel(testResult.slack).text}
                </span>
                <span
                  className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 ${
                    channelLabel(testResult.webhook).className
                  }`}
                >
                  Webhook: {channelLabel(testResult.webhook).text}
                </span>
              </div>
            </div>
          )}

          {alerts?.lastDelivery && (
            <div className="mt-3 rounded-md border bg-muted/30 px-3 py-2 text-xs">
              <div className="font-medium mb-1">
                Last real delivery —{" "}
                <span className="text-muted-foreground font-normal">
                  {new Date(alerts.lastDelivery.at).toLocaleString()}
                </span>
              </div>
              <div className="text-muted-foreground mb-1.5 truncate">
                <span
                  className={`mr-2 uppercase font-mono text-[10px] px-1.5 py-0.5 rounded ${
                    alerts.lastDelivery.severity === "critical"
                      ? "bg-red-500/15 text-red-700 dark:text-red-400"
                      : alerts.lastDelivery.severity === "warning"
                      ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                      : "bg-blue-500/15 text-blue-700 dark:text-blue-400"
                  }`}
                >
                  {alerts.lastDelivery.severity}
                </span>
                {alerts.lastDelivery.title}
              </div>
              <div className="flex flex-wrap gap-2">
                <span
                  className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 ${
                    channelLabel(alerts.lastDelivery.slack).className
                  }`}
                >
                  Slack: {channelLabel(alerts.lastDelivery.slack).text}
                </span>
                <span
                  className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 ${
                    channelLabel(alerts.lastDelivery.webhook).className
                  }`}
                >
                  Webhook: {channelLabel(alerts.lastDelivery.webhook).text}
                </span>
              </div>
            </div>
          )}

          {error && (
            <p className="text-xs text-red-600 dark:text-red-400 mt-2">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function ThrottleCard({ status }: { status: YouTubeQuotaStatus }) {
  const t = status.throttle;
  if (!t || !t.enabled) return null;
  const active = t.contexts.length > 0;
  return (
    <div
      className={`rounded-lg border bg-card p-5 ${
        active ? "ring-2 ring-amber-500/40" : ""
      }`}
    >
      <div className="flex items-start gap-3">
        <PauseCircle
          className={`w-5 h-5 mt-0.5 ${
            active ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
          }`}
        />
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-semibold">
            Auto-throttle{" "}
            <span className="text-xs font-normal text-muted-foreground">
              (T1 {t.t1Pct}% → pause #1, T2 {t.t2Pct}% → pause top 2)
            </span>
          </h2>
          {active ? (
            <>
              <p className="text-sm text-amber-700 dark:text-amber-400 mt-1">
                Currently throttling {t.contexts.length} call type
                {t.contexts.length === 1 ? "" : "s"} at {t.percentUsed}% usage.
              </p>
              <ul className="mt-2 space-y-1">
                {t.contexts.map((c) => (
                  <li
                    key={c}
                    className="text-xs font-mono inline-flex items-center gap-1.5 mr-2 rounded-md bg-amber-500/15 border border-amber-500/30 px-2 py-1"
                  >
                    <PauseCircle className="w-3 h-3" /> {c}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground mt-2">
                These call sites will resume automatically at the next UTC day
                boundary. Override via the{" "}
                <code className="text-[11px]">YOUTUBE_QUOTA_AUTO_THROTTLE</code>{" "}
                env var.
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground mt-1">
              Inactive — usage is below the {t.t1Pct}% throttle threshold.
              Will engage automatically if the noisiest call site pushes
              usage over the line.
            </p>
          )}
        </div>
      </div>
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
