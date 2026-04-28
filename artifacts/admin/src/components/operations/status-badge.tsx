import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";

/**
 * Three-tier health classification used across the Operations page and any
 * extracted tile components. Kept in this small shared module so that
 * tile-shaped infra status displays don't have to redeclare the union or
 * re-implement the badge palette.
 *
 * Convention:
 *   - "ok"       → emerald  ("Healthy")
 *   - "degraded" → amber    ("Degraded") — informational, self-heals
 *   - "critical" → red      ("Critical") — page-worthy
 *
 * If a tile has a fourth state that doesn't fit (e.g. the SSE bus "off"
 * state which is intentionally NOT amber/red), render its own neutral
 * Badge inline rather than extending this union — the three-tier scale
 * is stable and well-understood across the dashboard.
 */
export type CheckStatus = "ok" | "degraded" | "critical";

export function StatusBadge({ status }: { status: CheckStatus }) {
  if (status === "ok") {
    return (
      <Badge className="bg-emerald-500/15 text-emerald-700 border-emerald-500/30 dark:text-emerald-400">
        Healthy
      </Badge>
    );
  }
  if (status === "degraded") {
    return (
      <Badge className="bg-amber-500/15 text-amber-700 border-amber-500/30 dark:text-amber-400">
        Degraded
      </Badge>
    );
  }
  return (
    <Badge className="bg-red-500/15 text-red-700 border-red-500/30 dark:text-red-400">
      Critical
    </Badge>
  );
}

export function StatusIcon({ status }: { status: CheckStatus }) {
  if (status === "ok") return <CheckCircle2 className="w-4 h-4 text-emerald-600" />;
  if (status === "degraded") return <AlertTriangle className="w-4 h-4 text-amber-600" />;
  return <XCircle className="w-4 h-4 text-red-600" />;
}
