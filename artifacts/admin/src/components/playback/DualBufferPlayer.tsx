/**
 * DualBufferPlayer — the ONLY component that mounts the two persistent
 * <video> surfaces driven by the PlaybackEngine. They are mounted exactly
 * once for the lifetime of the page; the engine mutates their attributes
 * to swap items in place. This is the structural guarantee behind
 * "zero black frames between items".
 *
 * The component is intentionally dumb. It receives a PlaybackEngine
 * instance from the page above (so the hook+engine wiring stays at the
 * page level and tests can inject a mock engine). Layout is a 16:9 stage
 * with a YouTube iframe overlay for items whose source.kind === "youtube".
 */

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import type { PlaybackEngine } from "@/playback/PlaybackEngine";
import type { PlaybackItem } from "@/playback/types";

export interface DualBufferPlayerProps {
  engine: PlaybackEngine;
  current: PlaybackItem | null;
  className?: string;
}

export function DualBufferPlayer({ engine, current, className }: DualBufferPlayerProps) {
  const videoARef = useRef<HTMLVideoElement | null>(null);
  const videoBRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const a = videoARef.current;
    const b = videoBRef.current;
    if (!a || !b) return;
    engine.attach(a, b);
    return () => engine.detach();
  }, [engine]);

  const isYouTube = current?.source.kind === "youtube";
  const ytId = isYouTube ? current!.source.url : null;

  return (
    <div
      className={cn(
        "relative aspect-video w-full overflow-hidden rounded-lg bg-black",
        className,
      )}
      data-testid="dual-buffer-stage"
    >
      <video
        ref={videoARef}
        playsInline
        autoPlay
        controls={false}
        className="absolute inset-0 h-full w-full object-contain transition-opacity duration-200 ease-out"
        data-testid="surface-a"
      />
      <video
        ref={videoBRef}
        playsInline
        autoPlay
        controls={false}
        className="absolute inset-0 h-full w-full object-contain transition-opacity duration-200 ease-out"
        data-testid="surface-b"
      />
      {ytId && (
        <iframe
          key={ytId}
          src={`https://www.youtube.com/embed/${encodeURIComponent(ytId)}?autoplay=1&modestbranding=1&rel=0&playsinline=1`}
          title={current!.title}
          className="absolute inset-0 z-10 h-full w-full"
          allow="autoplay; encrypted-media; picture-in-picture"
          allowFullScreen
          data-testid="youtube-overlay"
        />
      )}
    </div>
  );
}
