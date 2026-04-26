import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bell,
  BellOff,
  CheckCircle2,
  Filter,
  Info,
  RefreshCw,
  Send,
  Siren,
  XCircle,
} from "lucide-react";
import {
  opsAlertsApi,
  type AlertChannelStatus,
  type AlertHistoryEntry,
  type AlertingStatus,
  type AlertTestResult,
} from "@/services/adminApi";
import { Button } from "@/components/ui/button";
import { useSSEEvent } from "@/contexts/SSEContext";

type SeverityFilter = "all" | "info" | "warning" | "critical";

/**
 * Unified ops alerts history page.
 *
 * Shows the last 100 alerts (real or dedup-suppressed) the API has raised,
 * across every source (YouTube quota, live ingest, future integrations).
 * Subscribes to `ops-alert-sent` SSE so the timeline updates in real time as
 * new alerts fire — no need to refresh.
 */
export default function AlertsHistoryPage() {
  const [entries, setEntries] = useState<AlertHistoryEntry[]>([]);
  const [status, setStatus] = useState<AlertingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [testResult, setTestResult] = useState<AlertTestResult | null>(null);
  const [filter, setFilter] = useState<SeverityFilter>("all");
  const [showDeduped, setShowDeduped] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [history, st] = await Promise.all([
        opsAlertsApi.getHistory(100),
        opsAlertsApi.getStatus(),
      ]);
      setEntries(history.entries);
      setStatus(st);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load alerts");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  // Real-time push: prepend the new alert without refetching the entire
  // history. The server already trims to 100 — we mirror that here.
  useSSEEvent("ops-alert-sent", (payload: AlertHistoryEntry) => {
    setEntries((prev) => {
      // De-dupe by `at + title` in case the server replays during reconnect.
      const seen = new Set(prev.map((e) => e.at + "|" + e.title));
      if (seen.has(payload.at + "|" + payload.title)) return prev;
      return [payload, ...prev].slice(0, 100);
    });
  });

  const sendTest = useCallback(async () => {
    setSending(true);
    setTestResult(null);
    try {
      const r = await opsAlertsApi.sendTest();
      setTestResult(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Test alert failed");
    } finally {
      setSending(false);
    }
  }, []);

  const filtered = useMemo(() => {
    return entries.filter((e) => {
      if (filter !== "all" && e.severity !== filter) return false;
      if (!showDeduped && e.deduped) return false;
      return true;
    });
  }, [entries, filter, showDeduped]);

  const counts = useMemo(() => {
    const c = { critical: 0, warning: 0, info: 0, deduped: 0 };
    for (const e of entries) {
      c[e.severity]++;
      if (e.deduped) c.deduped++;
    }
    return c;
  }, [entries]);

  const configured = status?.configured ?? false;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Siren className="w-6 h-6" /> Ops Alerts
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Unified timeline of every alert the API has raised across YouTube
            quota, live ingest, and other monitored systems. Real-time
            updates via SSE — page refreshes on every new alert.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={sendTest}
            disabled={sending || !configured}
            className="gap-2"
            title={
              configured
                ? "Send a test alert through every configured channel"
                : "No channels configured — set ALERT_SLACK_WEBHOOK_URL or ALERT_WEBHOOK_URL"
            }
          >
            <Send className={`w-4 h-4 ${sending ? "animate-pulse" : ""}`} />
            Send test
          </Button>
          <Button
            variant="outline"
            onClick={load}
            disabled={loading}
            className="gap-2"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </header>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      <ChannelsCard status={status} testResult={testResult} />

      <CountsBar counts={counts} total={entries.length} />

      <FilterBar
        filter={filter}
        setFilter={setFilter}
        showDeduped={showDeduped}
        setShowDeduped={setShowDeduped}
      />

      {filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-muted/30 p-12 text-center text-sm text-muted-foreground">
          {entries.length === 0
            ? "No alerts have been raised yet — this is the calm before the storm."
            : "No alerts match the current filter."}
        </div>
      ) : (
        <ol className="space-y-2">
          {filtered.map((entry, i) => (
            <Timeline key={`${entry.at}-${i}`} entry={entry} />
          ))}
        </ol>
      )}
    </div>
  );
}

function ChannelsCard({
  status,
  testResult,
}: {
  status: AlertingStatus | null;
  testResult: AlertTestResult | null;
}) {
  if (!status) return null;
  const Icon = status.configured ? Bell : BellOff;
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-start gap-3">
        <Icon
          className={`w-5 h-5 mt-0.5 ${
            status.configured
              ? "text-blue-600 dark:text-blue-400"
              : "text-muted-foreground"
          }`}
        />
        <div className="flex-1">
          <h2 className="text-sm font-semibold mb-1.5">Channels</h2>
          <div className="flex flex-wrap gap-2">
            <ChannelChip
              label="Slack-style webhook"
              configured={status.channels.slack}
            />
            <ChannelChip
              label="Generic JSON webhook"
              configured={status.channels.webhook}
            />
          </div>
          {!status.configured && (
            <p className="text-xs text-muted-foreground mt-2">
              Set <code className="text-[11px]">ALERT_SLACK_WEBHOOK_URL</code>{" "}
              and/or <code className="text-[11px]">ALERT_WEBHOOK_URL</code>{" "}
              to start delivering alerts. Until then, alerts are recorded in
              this timeline but not sent anywhere.
            </p>
          )}
          {testResult && (
            <div className="mt-2 text-xs">
              <span className="text-muted-foreground mr-2">
                Last test result:
              </span>
              <ChannelStatusChip channel="Slack" status={testResult.slack} />
              <span className="mx-1" />
              <ChannelStatusChip
                channel="Webhook"
                status={testResult.webhook}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ChannelChip({
  label,
  configured,
}: {
  label: string;
  configured: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs ${
        configured
          ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-400"
          : "bg-muted/40 text-muted-foreground"
      }`}
    >
      {configured ? (
        <CheckCircle2 className="w-3 h-3" />
      ) : (
        <XCircle className="w-3 h-3" />
      )}
      {label}
    </span>
  );
}

function ChannelStatusChip({
  channel,
  status,
}: {
  channel: string;
  status: AlertChannelStatus;
}) {
  const cls =
    status === "sent"
      ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-400"
      : status === "failed"
        ? "bg-red-500/10 border-red-500/30 text-red-700 dark:text-red-400"
        : status === "skipped"
          ? "bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-400"
          : "bg-muted/40 text-muted-foreground";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] ${cls}`}
    >
      {channel}: {status}
    </span>
  );
}

function CountsBar({
  counts,
  total,
}: {
  counts: { critical: number; warning: number; info: number; deduped: number };
  total: number;
}) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      <CountTile label="Critical" value={counts.critical} tone="critical" />
      <CountTile label="Warning" value={counts.warning} tone="warning" />
      <CountTile label="Info" value={counts.info} tone="info" />
      <CountTile
        label={`Deduped of ${total}`}
        value={counts.deduped}
        tone="muted"
      />
    </div>
  );
}

function CountTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "critical" | "warning" | "info" | "muted";
}) {
  const cls =
    tone === "critical"
      ? "border-red-500/30 bg-red-500/5"
      : tone === "warning"
        ? "border-amber-500/30 bg-amber-500/5"
        : tone === "info"
          ? "border-blue-500/30 bg-blue-500/5"
          : "border-border bg-muted/20";
  return (
    <div className={`rounded-lg border ${cls} px-4 py-3`}>
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
    </div>
  );
}

function FilterBar({
  filter,
  setFilter,
  showDeduped,
  setShowDeduped,
}: {
  filter: SeverityFilter;
  setFilter: (f: SeverityFilter) => void;
  showDeduped: boolean;
  setShowDeduped: (v: boolean) => void;
}) {
  const options: { v: SeverityFilter; label: string }[] = [
    { v: "all", label: "All" },
    { v: "critical", label: "Critical" },
    { v: "warning", label: "Warning" },
    { v: "info", label: "Info" },
  ];
  return (
    <div className="flex items-center justify-between flex-wrap gap-2">
      <div className="flex items-center gap-1 rounded-md border bg-card p-1">
        <Filter className="w-3.5 h-3.5 mx-1.5 text-muted-foreground" />
        {options.map((o) => (
          <button
            key={o.v}
            onClick={() => setFilter(o.v)}
            className={`px-2.5 py-1 text-xs rounded ${
              filter === o.v
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
        <input
          type="checkbox"
          checked={showDeduped}
          onChange={(e) => setShowDeduped(e.target.checked)}
          className="h-3.5 w-3.5"
        />
        Show deduped (suppressed) entries
      </label>
    </div>
  );
}

function severityVisual(severity: AlertHistoryEntry["severity"]) {
  switch (severity) {
    case "critical":
      return {
        Icon: Siren,
        wrap: "border-red-500/40 bg-red-500/5",
        chip: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30",
        iconCls: "text-red-600 dark:text-red-400",
      };
    case "warning":
      return {
        Icon: AlertTriangle,
        wrap: "border-amber-500/40 bg-amber-500/5",
        chip: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
        iconCls: "text-amber-600 dark:text-amber-400",
      };
    case "info":
    default:
      return {
        Icon: Info,
        wrap: "border-blue-500/30 bg-blue-500/5",
        chip: "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30",
        iconCls: "text-blue-600 dark:text-blue-400",
      };
  }
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 24 * 60 * 60_000) return `${Math.round(ms / (60 * 60_000))}h ago`;
  return `${Math.round(ms / (24 * 60 * 60_000))}d ago`;
}

function Timeline({ entry }: { entry: AlertHistoryEntry }) {
  const v = severityVisual(entry.severity);
  return (
    <li
      className={`rounded-lg border ${v.wrap} ${
        entry.deduped ? "opacity-60" : ""
      } p-4`}
    >
      <div className="flex items-start gap-3">
        <v.Icon className={`w-5 h-5 mt-0.5 shrink-0 ${v.iconCls}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <h3 className="font-semibold text-sm">{entry.title}</h3>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span
                className={`uppercase font-mono text-[10px] px-1.5 py-0.5 rounded border ${v.chip}`}
              >
                {entry.severity}
              </span>
              {entry.deduped && (
                <span className="uppercase font-mono text-[10px] px-1.5 py-0.5 rounded border bg-muted/40">
                  deduped
                </span>
              )}
              <span title={new Date(entry.at).toLocaleString()}>
                {relativeTime(entry.at)}
              </span>
            </div>
          </div>
          <p className="text-sm text-muted-foreground mt-1">{entry.message}</p>
          {entry.fields.length > 0 && (
            <dl className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs">
              {entry.fields.map((f, i) => (
                <div key={i} className="flex gap-2 min-w-0">
                  <dt className="text-muted-foreground shrink-0">{f.label}:</dt>
                  <dd className="font-mono truncate" title={f.value}>
                    {f.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5 items-center">
            <ChannelStatusChip channel="Slack" status={entry.slack} />
            <ChannelStatusChip channel="Webhook" status={entry.webhook} />
            {entry.dedupKey && (
              <span
                className="text-[10px] font-mono text-muted-foreground truncate"
                title={`dedup key: ${entry.dedupKey}`}
              >
                · {entry.dedupKey}
              </span>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}
