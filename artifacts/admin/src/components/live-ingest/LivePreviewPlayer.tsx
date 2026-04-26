import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { Loader2, AlertTriangle, VideoOff } from "lucide-react";

interface LivePreviewPlayerProps {
  hlsUrl: string;
  /** Show only on demand (button click) — saves bandwidth for ops dashboards. */
  enabled: boolean;
}

/**
 * Tiny embedded HLS preview used inside an endpoint card. This is *not* the
 * production playback path — it exists so the operator can confirm an ingest
 * is producing frames before promoting it to primary. Keeps bandwidth
 * footprint low (auto-pauses, low-resolution variant, muted by default).
 */
export function LivePreviewPlayer({ hlsUrl, enabled }: LivePreviewPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "playing" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !videoRef.current) {
      // Tear down on disable to free the network connection.
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      setState("idle");
      return;
    }
    const video = videoRef.current;
    setState("loading");
    setErrorMsg(null);

    // Safari / iOS support HLS natively — skip hls.js to avoid double-buffering.
    const canNative = video.canPlayType("application/vnd.apple.mpegurl");
    if (canNative) {
      video.src = hlsUrl;
      video.play().catch(() => {});
      const onPlaying = () => setState("playing");
      const onError = () => {
        setState("error");
        setErrorMsg("Native HLS playback failed");
      };
      video.addEventListener("playing", onPlaying);
      video.addEventListener("error", onError);
      return () => {
        video.removeEventListener("playing", onPlaying);
        video.removeEventListener("error", onError);
        video.removeAttribute("src");
        video.load();
      };
    }

    if (!Hls.isSupported()) {
      setState("error");
      setErrorMsg("HLS is not supported in this browser");
      return;
    }

    const hls = new Hls({
      // Aggressive low-latency settings — this is preview, not archive playback,
      // so we always want to be at the live edge.
      liveSyncDurationCount: 2,
      liveMaxLatencyDurationCount: 4,
      lowLatencyMode: true,
      maxBufferLength: 8,
      enableWorker: true,
    });
    hlsRef.current = hls;
    hls.loadSource(hlsUrl);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => {});
    });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) {
        setState("error");
        setErrorMsg(`${data.type}: ${data.details}`);
      }
    });
    const onPlaying = () => setState("playing");
    video.addEventListener("playing", onPlaying);
    return () => {
      video.removeEventListener("playing", onPlaying);
      hls.destroy();
      hlsRef.current = null;
    };
  }, [hlsUrl, enabled]);

  if (!enabled) {
    return (
      <div className="rounded-md bg-black/80 border border-border aspect-video flex flex-col items-center justify-center text-muted-foreground gap-2">
        <VideoOff className="w-8 h-8" />
        <div className="text-xs">Preview off — click Preview to start</div>
      </div>
    );
  }

  return (
    <div className="rounded-md bg-black border border-border aspect-video relative overflow-hidden">
      <video
        ref={videoRef}
        muted
        playsInline
        autoPlay
        controls={false}
        className="w-full h-full object-contain"
      />
      {state === "loading" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-white/80 gap-2 bg-black/60">
          <Loader2 className="w-6 h-6 animate-spin" />
          <div className="text-xs">Connecting to ingest…</div>
        </div>
      )}
      {state === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-red-500/20 text-white p-4 text-center">
          <AlertTriangle className="w-6 h-6 text-red-400" />
          <div className="text-xs font-mono leading-snug">{errorMsg ?? "Playback failed"}</div>
        </div>
      )}
      {state === "playing" && (
        <div className="absolute top-2 left-2 inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-red-500 text-white text-[10px] font-bold tracking-wider uppercase shadow-lg">
          <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
          Live Preview
        </div>
      )}
    </div>
  );
}
