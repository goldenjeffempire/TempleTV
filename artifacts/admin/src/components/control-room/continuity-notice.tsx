import { useSSE } from "@/contexts/sse-context";
import { RadioTower } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Honest continuity statement: the admin dashboard connection and the
 * audience broadcast runtime are independent systems. A disconnected
 * dashboard never means the station is off air.
 */
export function ContinuityNotice({ className }: { className?: string }) {
  const { state } = useSSE();
  const linked = state === "connected";
  return (
    <div
      role="note"
      data-testid="status-continuity"
      className={cn(
        "flex items-start gap-3 rounded-[var(--radius)] border px-3.5 py-2.5 text-xs leading-relaxed",
        linked ? "border-border bg-card/60 text-muted-foreground" : "border-amber-500/40 bg-amber-500/8 text-foreground",
        className,
      )}
    >
      <RadioTower size={14} className={cn("mt-0.5 shrink-0", linked ? "text-primary" : "text-amber-600 dark:text-amber-400")} aria-hidden />
      <p>
        <span className="font-semibold text-foreground">Broadcast continuity: </span>
        {linked
          ? "closing or logging out of this page does not stop the server-managed broadcast. Dashboard connectivity and audience media delivery are monitored separately."
          : "this dashboard's live link is interrupted. That alone does not mean the station is off air. Status below may be out of date; check runtime and media health before restarting the broadcast."}
      </p>
    </div>
  );
}
