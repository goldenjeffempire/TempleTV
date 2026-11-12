import { useEffect, useState } from "react";
import { useSSE } from "@/contexts/sse-context";
import { Users, RefreshCcw } from "lucide-react";

function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

/** Presentation-only: connected administrators + last live sync from SSE context. */
export function ControlRoomPresence() {
  const ctx = useSSE();
  const admins = typeof ctx.connectedAdministrators === "number" ? ctx.connectedAdministrators : null;
  const sync = typeof ctx.lastSyncAtMs === "number" ? ctx.lastSyncAtMs : null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="grid grid-cols-2 divide-x divide-border panel-surface text-xs" data-testid="panel-control-room-presence">
      <div className="px-3 py-2">
        <p className="eyebrow flex items-center gap-1.5"><Users size={11} aria-hidden /> Admin consoles</p>
        <p className="mt-0.5 font-mono text-base font-semibold tabular-nums" data-testid="text-connected-admins">
          {admins ?? "—"}
        </p>
        <p className="text-[10px] text-muted-foreground">Authenticated connections · this API instance</p>
      </div>
      <div className="px-3 py-2">
        <p className="eyebrow flex items-center gap-1.5"><RefreshCcw size={11} aria-hidden /> Last live sync</p>
        <p className="mt-0.5 font-mono text-base font-semibold tabular-nums" data-testid="text-last-sync">
          {sync === null ? "—" : ago(sync, now)}
        </p>
        <p className="text-[10px] text-muted-foreground">
          {sync === null ? "No sync recorded yet" : new Date(sync).toLocaleTimeString()}
        </p>
      </div>
    </div>
  );
}
