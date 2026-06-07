/**
 * LiveStatusBadge
 *
 * Displays the YouTube live broadcast state of a video:
 *   'live'        → pulsing red pill  "LIVE"
 *   'rebroadcast' → solid amber pill  "REBROADCAST"
 *   null / other  → renders nothing
 *
 * Usage:
 *   <LiveStatusBadge status={video.youtubeLiveStatus} />
 *   <LiveStatusBadge status="live" size="sm" />
 */

import { cn } from "@/lib/utils";

type LiveStatus = "live" | "rebroadcast" | null | undefined;
type BadgeSize = "sm" | "md";

interface LiveStatusBadgeProps {
  status: LiveStatus;
  size?: BadgeSize;
  className?: string;
}

export function LiveStatusBadge({ status, size = "md", className }: LiveStatusBadgeProps) {
  if (!status) return null;

  const isLive = status === "live";
  const isSmall = size === "sm";

  if (isLive) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full font-bold tracking-widest uppercase",
          "bg-red-600 text-white",
          isSmall ? "px-2 py-0.5 text-[9px]" : "px-3 py-1 text-[10px]",
          className,
        )}
        aria-label="Live broadcast"
      >
        <span
          className={cn(
            "rounded-full bg-white animate-pulse",
            isSmall ? "w-1.5 h-1.5" : "w-2 h-2",
          )}
          aria-hidden
        />
        LIVE
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full font-bold tracking-widest uppercase",
        "bg-amber-500 text-white",
        isSmall ? "px-2 py-0.5 text-[9px]" : "px-3 py-1 text-[10px]",
        className,
      )}
      aria-label="Rebroadcast"
    >
      REBROADCAST
    </span>
  );
}
