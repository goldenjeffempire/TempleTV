import type { ComponentType } from "react";
import { Badge } from "@/components/ui/badge";
import { Zap, CheckCircle2, Radio, Library, AlertCircle, Clock, XCircle } from "lucide-react";

interface BroadcastReadyBadgeProps {
  videoSource: string;
  localVideoUrl: string | null | undefined;
  hlsMasterUrl: string | null | undefined;
  /**
   * FastStart state — required to gate the "MP4 Ready" label.
   * true  = moov at byte 0 → broadcast-ready
   * false = FastStart ran and failed → NOT broadcast-ready
   * null  = never attempted (still assembling or recovery pending) → NOT broadcast-ready
   * undefined = not available (legacy callers) → skip FastStart gate (backward-compat)
   */
  faststartApplied?: boolean | null;
  /** Show a longer label (default: compact) */
  verbose?: boolean;
}

export type BroadcastReadiness =
  | "mp4_and_hls"
  | "mp4_only"
  | "hls_only"
  | "library_only"
  | "faststart_pending"
  | "faststart_failed"
  | "not_ready";

export function getBroadcastReadiness(
  videoSource: string,
  localVideoUrl: string | null | undefined,
  hlsMasterUrl: string | null | undefined,
  faststartApplied?: boolean | null,
): BroadcastReadiness {
  if (videoSource === "youtube") return "library_only";
  const hasMP4 = !!(localVideoUrl && localVideoUrl.trim());
  const hasHLS = !!(hlsMasterUrl && hlsMasterUrl.trim());

  if (hasMP4) {
    // If faststartApplied is explicitly provided (not undefined), gate on it.
    // undefined = legacy caller that doesn't know about FastStart → skip gate.
    if (faststartApplied !== undefined) {
      if (faststartApplied === false) return "faststart_failed";
      if (faststartApplied !== true) return "faststart_pending";
    }
    // FastStart confirmed (or gate skipped) — video is broadcast-ready.
    if (hasHLS) return "mp4_and_hls";
    return "mp4_only";
  }

  if (hasHLS) return "hls_only";
  return "not_ready";
}

const CONFIG: Record<
  BroadcastReadiness,
  {
    label: string;
    verboseLabel: string;
    tooltip: string;
    icon: ComponentType<{ size?: number; className?: string }>;
    className: string;
  }
> = {
  mp4_and_hls: {
    label: "MP4 + HLS",
    verboseLabel: "MP4 + HLS Ready",
    tooltip:
      "Broadcast-ready at maximum quality — MP4 is the primary stream (instant start, no buffering), " +
      "HLS provides adaptive bitrate as a fallback. No transcoding required to go live.",
    icon: Zap,
    className:
      "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400",
  },
  mp4_only: {
    label: "MP4 Ready",
    verboseLabel: "MP4 Broadcast-Ready",
    tooltip:
      "Broadcast-ready — FastStart complete, moov atom is at byte 0 for instant start on all surfaces.",
    icon: CheckCircle2,
    className:
      "border-green-300 bg-green-50 text-green-700 dark:border-green-700 dark:bg-green-950/40 dark:text-green-400",
  },
  hls_only: {
    label: "HLS Only",
    verboseLabel: "HLS Broadcast-Ready",
    tooltip:
      "Broadcast-ready via HLS adaptive stream. " +
      "No raw MP4 is available — the broadcast engine will use the HLS playlist as the primary source.",
    icon: Radio,
    className:
      "border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-700 dark:bg-blue-950/40 dark:text-blue-400",
  },
  library_only: {
    label: "Library Only",
    verboseLabel: "Library Only (YouTube)",
    tooltip:
      "YouTube videos are library-only and are never inserted into the broadcast queue. " +
      "The YouTube shuffle fallback plays them automatically when the local queue is empty.",
    icon: Library,
    className:
      "border-muted-foreground/30 bg-muted/40 text-muted-foreground",
  },
  faststart_pending: {
    label: "FastStart Pending",
    verboseLabel: "Awaiting FastStart",
    tooltip:
      "Upload assembled — waiting for moov atom relocation (FastStart) to complete before this video can broadcast. " +
      "This happens automatically; no action needed.",
    icon: Clock,
    className:
      "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-500",
  },
  faststart_failed: {
    label: "FastStart Failed",
    verboseLabel: "FastStart Failed",
    tooltip:
      "Moov atom relocation failed — video cannot broadcast until fixed. " +
      "Use Actions → Re-apply faststart to retry.",
    icon: XCircle,
    className:
      "border-red-300 bg-red-50 text-red-700 dark:border-red-700 dark:bg-red-950/40 dark:text-red-400",
  },
  not_ready: {
    label: "Not Ready",
    verboseLabel: "Not Broadcast-Ready",
    tooltip:
      "No playable source URL is available. " +
      "The video cannot air until a source file is uploaded or a URL is assigned.",
    icon: AlertCircle,
    className:
      "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-500",
  },
};

export function BroadcastReadyBadge({
  videoSource,
  localVideoUrl,
  hlsMasterUrl,
  faststartApplied,
  verbose = false,
}: BroadcastReadyBadgeProps) {
  const readiness = getBroadcastReadiness(videoSource, localVideoUrl, hlsMasterUrl, faststartApplied);
  const cfg = CONFIG[readiness];
  const Icon = cfg.icon;

  return (
    <Badge
      variant="outline"
      className={`text-[10px] px-1.5 h-4 flex items-center gap-0.5 ${cfg.className}`}
      title={cfg.tooltip}
    >
      <Icon size={9} className="flex-shrink-0" />
      {verbose ? cfg.verboseLabel : cfg.label}
    </Badge>
  );
}
