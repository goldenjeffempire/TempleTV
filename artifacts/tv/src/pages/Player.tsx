/**
 * Player — TV broadcast router. Rebuilt from scratch.
 *
 * Routes:
 *   isLive + hlsUrl  → LiveBroadcastHlsPlayer  (24/7 queue, PlaybackEngine)
 *   isLive + videoId → LiveYouTubePlayer        (YT live, auto-follows useLiveSync)
 *   VOD  + hlsUrl    → HlsVideoPlayer           (VOD catalog, full controls)
 *   VOD  + videoId   → YouTubePlayer            (YT catalog, iframe embed)
 *
 * LiveBroadcastHlsPlayer wires the TV PlaybackEngine to useLiveSync so the
 * player self-advances through the broadcast queue without the parent needing
 * to re-render. The engine's proactive 8-second preload window eliminates
 * black frames between items.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { keyEventToAction } from "../lib/tvKeys";
import { HlsVideoPlayer } from "../components/HlsVideoPlayer";
import { BroadcastChannelBug } from "../components/BroadcastChannelBug";
import { BroadcastLiveCompanion } from "../components/BroadcastLiveCompanion";
import ChatOverlay from "../components/ChatOverlay";
import { useLiveSync } from "../hooks/useLiveSync";
import { reportLiveFailure, useLiveFailureFor } from "../lib/liveFailureSignal";
import { sendReaction, submitPrayerRequest } from "../lib/api";
import { LiveBroadcastV2 } from "../components/LiveBroadcastV2";
import { usePictureInPicture } from "../hooks/usePictureInPicture";


// ── Reactions & prayer ────────────────────────────────────────────────────────

const REACTIONS: { type: "amen" | "fire" | "hallelujah"; emoji: string; label: string }[] = [
  { type: "amen",       emoji: "🙏", label: "Amen"       },
  { type: "fire",       emoji: "🔥", label: "Fire"       },
  { type: "hallelujah", emoji: "🙌", label: "Hallelujah" },
];

const PRAYER_PRESETS = ["Breakthrough", "Family", "Provision", "Salvation"];

function LiveActionsPanel({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [focusIdx,      setFocusIdx]      = useState(0);
  const [prayerMode,    setPrayerMode]    = useState(false);
  const [prayerFocusIdx, setPrayerFocusIdx] = useState(0);
  const [toast,         setToast]         = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  }, []);

  const handleReaction = useCallback((type: "amen" | "fire" | "hallelujah", emoji: string) => {
    sendReaction(type);
    showToast(`${emoji} Sent!`);
  }, [showToast]);

  const handlePrayer = useCallback(async (topic: string) => {
    const ok = await submitPrayerRequest(null, `Prayer request: ${topic}`);
    showToast(ok ? "🙏 Prayer request sent!" : "Could not send — try again");
    setPrayerMode(false);
  }, [showToast]);

  const totalItems = REACTIONS.length + 1;

  useEffect(() => {
    if (!visible) return;
    const handler = (e: KeyboardEvent) => {
      const action = keyEventToAction(e);
      if (!action) return;
      if (prayerMode) {
        if (action === "back")   { e.preventDefault(); setPrayerMode(false); return; }
        if (action === "up")     { e.preventDefault(); setPrayerFocusIdx((i) => Math.max(0, i - 1)); return; }
        if (action === "down")   { e.preventDefault(); setPrayerFocusIdx((i) => Math.min(PRAYER_PRESETS.length - 1, i + 1)); return; }
        if (action === "select") { e.preventDefault(); void handlePrayer(PRAYER_PRESETS[prayerFocusIdx]); return; }
        return;
      }
      if (action === "back" || action === "info") { e.preventDefault(); onClose(); return; }
      if (action === "left")  { e.preventDefault(); setFocusIdx((i) => Math.max(0, i - 1)); return; }
      if (action === "right") { e.preventDefault(); setFocusIdx((i) => Math.min(totalItems - 1, i + 1)); return; }
      if (action === "select") {
        e.preventDefault();
        if (focusIdx < REACTIONS.length) {
          const r = REACTIONS[focusIdx];
          handleReaction(r.type, r.emoji);
        } else {
          setPrayerMode(true);
          setPrayerFocusIdx(0);
        }
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [visible, prayerMode, focusIdx, prayerFocusIdx, onClose, handleReaction, handlePrayer, totalItems]);

  if (!visible) return null;

  return (
    <div style={{ position: "absolute", bottom: 80, right: 60, zIndex: 200, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 12, pointerEvents: "none" }}>
      {toast && (
        <div style={{ background: "rgba(106,13,173,0.9)", border: "1px solid rgba(168,85,247,0.6)", borderRadius: 12, padding: "8px 18px", fontSize: 15, fontWeight: 700, color: "#fff", backdropFilter: "blur(12px)" }}>
          {toast}
        </div>
      )}
      {prayerMode && (
        <div style={{ background: "rgba(10,10,15,0.9)", border: "1px solid rgba(168,85,247,0.4)", borderRadius: 16, padding: "16px 20px", display: "flex", flexDirection: "column", gap: 8, pointerEvents: "auto", minWidth: 200 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "rgba(168,85,247,1)", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 4 }}>Prayer Request</div>
          {PRAYER_PRESETS.map((topic, idx) => (
            <div key={topic} onClick={() => void handlePrayer(topic)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 10, cursor: "pointer", background: prayerFocusIdx === idx ? "rgba(106,13,173,0.5)" : "rgba(255,255,255,0.05)", border: `1px solid ${prayerFocusIdx === idx ? "rgba(168,85,247,0.7)" : "rgba(255,255,255,0.08)"}`, color: prayerFocusIdx === idx ? "#e9d5ff" : "rgba(255,255,255,0.75)", fontWeight: prayerFocusIdx === idx ? 700 : 500, fontSize: 15 }}>
              🙏 {topic}
            </div>
          ))}
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginTop: 4, textAlign: "center" }}>↑ ↓ Navigate · ENTER Send · BACK Cancel</div>
        </div>
      )}
      {!prayerMode && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", pointerEvents: "auto", background: "rgba(10,10,15,0.85)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 50, padding: "10px 16px", backdropFilter: "blur(16px)" }}>
          {REACTIONS.map((r, idx) => (
            <button key={r.type} onClick={() => handleReaction(r.type, r.emoji)} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, background: focusIdx === idx ? "rgba(106,13,173,0.6)" : "rgba(255,255,255,0.06)", border: `1px solid ${focusIdx === idx ? "rgba(168,85,247,0.8)" : "rgba(255,255,255,0.12)"}`, borderRadius: 14, padding: "8px 14px", cursor: "pointer", transition: "all 0.15s ease", transform: focusIdx === idx ? "scale(1.12)" : "scale(1)", fontFamily: "inherit" }}>
              <span style={{ fontSize: 24 }}>{r.emoji}</span>
              <span style={{ fontSize: 11, color: focusIdx === idx ? "#e9d5ff" : "rgba(255,255,255,0.5)", fontWeight: 700 }}>{r.label}</span>
            </button>
          ))}
          <div style={{ width: 1, height: 40, background: "rgba(255,255,255,0.12)", margin: "0 4px" }} />
          <button onClick={() => { setPrayerMode(true); setPrayerFocusIdx(0); }} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, background: focusIdx === REACTIONS.length ? "rgba(106,13,173,0.6)" : "rgba(255,255,255,0.06)", border: `1px solid ${focusIdx === REACTIONS.length ? "rgba(168,85,247,0.8)" : "rgba(255,255,255,0.12)"}`, borderRadius: 14, padding: "8px 14px", cursor: "pointer", fontFamily: "inherit" }}>
            <span style={{ fontSize: 24 }}>✉️</span>
            <span style={{ fontSize: 11, color: focusIdx === REACTIONS.length ? "#e9d5ff" : "rgba(255,255,255,0.5)", fontWeight: 700 }}>Prayer</span>
          </button>
        </div>
      )}
      {!prayerMode && (
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.25)", textAlign: "center", paddingRight: 8 }}>← → Navigate · ENTER Select · INFO Close</div>
      )}
    </div>
  );
}

function LiveActionsToggle({ onOpen }: { onOpen: () => void }) {
  return (
    <button onClick={onOpen} style={{ position: "absolute", bottom: 20, right: 60, zIndex: 100, display: "flex", alignItems: "center", gap: 8, background: "rgba(10,10,15,0.7)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 50, padding: "7px 16px", cursor: "pointer", backdropFilter: "blur(12px)", fontFamily: "inherit" }}>
      <span style={{ fontSize: 16 }}>🙏</span>
      <span style={{ fontSize: 12, color: "rgba(255,255,255,0.65)", fontWeight: 600 }}>React / Pray</span>
      <kbd style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 4, padding: "1px 6px", fontFamily: "inherit" }}>INFO</kbd>
    </button>
  );
}

// ── Props ─────────────────────────────────────────────────────────────────────

export interface PlayerProps {
  videoId: string;
  title: string;
  onBack: () => void;
  hlsUrl?: string;
  startPositionSecs?: number;
  isLive?: boolean;
  onProgress?: (positionSecs: number, durationSecs: number) => void;
  /**
   * Called just after PiP entry succeeds — before `onBack()` navigates away.
   * The parent can save the current player context so `PipIndicator`'s
   * "Return to Full Screen" action can restore it exactly.
   */
  onPipActivate?: () => void;
}

// ── YouTube VOD player ────────────────────────────────────────────────────────

function YouTubePlayer({
  videoId,
  title,
  onBack,
  isLive = false,
  onLiveError,
}: {
  videoId: string;
  title: string;
  onBack: () => void;
  isLive?: boolean;
  onLiveError?: () => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [loading, setLoading] = useState(true);
  const loadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLoading(true);
    loadTimer.current = setTimeout(() => {
      if (loading) onLiveError?.();
    }, 15_000);
    return () => { if (loadTimer.current) clearTimeout(loadTimer.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const action = keyEventToAction(e);
      if (action === "back") { e.preventDefault(); onBack(); }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onBack]);

  const src = `https://www.youtube.com/embed/${videoId}?autoplay=1&controls=${isLive ? 0 : 1}&rel=0&modestbranding=1&enablejsapi=1`;

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", background: "#000" }}>
      {loading && (
        <div style={{ position: "absolute", inset: 0, zIndex: 10, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 16 }}>
          <div style={{ width: 48, height: 48, borderRadius: "50%", border: "3px solid rgba(255,0,0,0.3)", borderTopColor: "#ff0000", animation: "spin 0.9s linear infinite" }} />
          <span style={{ color: "rgba(255,255,255,0.5)", fontSize: 14 }}>Loading {title}…</span>
        </div>
      )}
      <iframe
        ref={iframeRef}
        src={src}
        style={{ width: "100%", height: "100%", border: "none", display: loading ? "none" : "block" }}
        allow="autoplay; encrypted-media; picture-in-picture"
        allowFullScreen
        onLoad={() => setLoading(false)}
      />
      <button onClick={onBack} style={{ position: "absolute", top: "var(--tv-safe-v, 24px)", left: "var(--tv-safe-h, 32px)", zIndex: 30, background: "rgba(0,0,0,0.6)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 50, width: 44, height: 44, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "#fff", fontSize: 20 }}>←</button>
      {isLive && <BroadcastChannelBug />}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ── Live YouTube player (subscribes to useLiveSync for videoId updates) ───────

function LiveYouTubePlayer({
  initialVideoId,
  initialTitle,
  onBack,
}: {
  initialVideoId: string;
  initialTitle: string;
  onBack: () => void;
}) {
  const sync = useLiveSync();
  const [actionsOpen, setActionsOpen] = useState(false);
  const [videoId, setVideoId] = useState(initialVideoId);
  const [title,   setTitle]   = useState(initialTitle);

  useEffect(() => {
    const nextId    = sync.videoId ?? null;
    const nextTitle = sync.liveOverride?.title ?? sync.ytTitle ?? sync.title ?? null;
    if (nextId    && nextId    !== videoId) setVideoId(nextId);
    if (nextTitle && nextTitle !== title)   setTitle(nextTitle);
  }, [sync.liveOverride, sync.videoId, sync.title, sync.ytTitle, videoId, title]);

  const failed = useLiveFailureFor(videoId);
  const navigatedAway = useRef(false);
  useEffect(() => {
    if (failed && !navigatedAway.current) {
      navigatedAway.current = true;
      onBack();
    }
  }, [failed, onBack]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (keyEventToAction(e) === "info") {
        e.preventDefault();
        setActionsOpen((p) => !p);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <YouTubePlayer
        videoId={videoId}
        title={title}
        onBack={onBack}
        isLive
        onLiveError={() => reportLiveFailure(videoId, "tv-player")}
      />
      <BroadcastLiveCompanion isLive={sync.isLive} viewerCount={sync.viewerCount} />
      {!actionsOpen && <LiveActionsToggle onOpen={() => setActionsOpen(true)} />}
      <LiveActionsPanel visible={actionsOpen} onClose={() => setActionsOpen(false)} />
    </div>
  );
}

// ── Live HLS broadcast player (v2 — backed by player-core) ───────────────────

/**
 * Self-advancing broadcast queue player.
 *
 * Now backed by `LiveBroadcastV2` from `@workspace/player-core` (T006/T008).
 * The v2 component owns its own transport (WS+SSE), FSM, A/B-buffer
 * management, hls.js attachment, watchdog, and overlay rendering — this
 * file only adds the TV-specific chrome (chat overlay, channel bug, viewer
 * companion, prayer/reactions panel, back button, PiP button, keyboard handling).
 *
 * `useLiveSync` is still consumed for its non-player signals (`isLive`,
 * `viewerCount`) that drive the surrounding chrome.
 */
function LiveBroadcastHlsPlayer({
  onBack,
  onPipActivate,
}: {
  onBack: () => void;
  onPipActivate?: () => void;
}) {
  const sync = useLiveSync();
  const [actionsOpen, setActionsOpen] = useState(false);
  const { isPipSupported, enterPiP } = usePictureInPicture();

  const handlePiP = useCallback(async () => {
    const ok = await enterPiP();
    if (ok && onPipActivate) {
      // Navigate away so the operator can browse the library with
      // the live broadcast floating in the OS native PiP window.
      onPipActivate();
      onBack();
    }
  }, [enterPiP, onPipActivate, onBack]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const action = keyEventToAction(e);
      if (action === "back") { e.preventDefault(); onBack(); }
      if (action === "info") { e.preventDefault(); setActionsOpen((p) => !p); }
      // P key — enter Picture-in-Picture and browse the library
      if ((e.key === "p" || e.key === "P") && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        void handlePiP();
      }
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onBack, handlePiP]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", background: "#000", overflow: "hidden" }}>
      <LiveBroadcastV2 variant="player" />

      <BroadcastChannelBug />
      <BroadcastLiveCompanion isLive={sync.isLive} viewerCount={sync.viewerCount} />
      <ChatOverlay />

      {/* Back button */}
      <button
        onClick={onBack}
        style={{ position: "absolute", top: "var(--tv-safe-v, 24px)", left: "var(--tv-safe-h, 32px)", zIndex: 50, background: "rgba(0,0,0,0.6)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 50, width: 44, height: 44, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "#fff", fontSize: 20 }}
        aria-label="Back"
      >
        ←
      </button>

      {/* Picture-in-Picture button — only on supported browsers */}
      {isPipSupported && (
        <button
          onClick={() => void handlePiP()}
          style={{
            position: "absolute",
            top: 24,
            left: 86,
            zIndex: 50,
            background: "rgba(0,0,0,0.6)",
            border: "1px solid rgba(255,255,255,0.15)",
            borderRadius: 50,
            width: 44,
            height: 44,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            color: "#fff",
            transition: "background 150ms ease, border-color 150ms ease",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = "rgba(109,40,217,0.75)";
            (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(167,139,250,0.5)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.6)";
            (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(255,255,255,0.15)";
          }}
          title="Picture-in-Picture (P)"
          aria-label="Watch in Picture-in-Picture"
        >
          {/* PiP icon — small screen inside larger frame */}
          <svg viewBox="0 0 20 20" fill="currentColor" style={{ width: 18, height: 18 }}>
            <rect x="1" y="3" width="18" height="12" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <rect x="10" y="8.5" width="8" height="5.5" rx="1" fill="currentColor" opacity="0.9" />
          </svg>
        </button>
      )}

      {!actionsOpen && <LiveActionsToggle onOpen={() => setActionsOpen(true)} />}
      <LiveActionsPanel visible={actionsOpen} onClose={() => setActionsOpen(false)} />
    </div>
  );
}

// ── Public router ─────────────────────────────────────────────────────────────

export function Player({
  videoId,
  title,
  onBack,
  hlsUrl,
  startPositionSecs = 0,
  isLive = false,
  onProgress,
  onPipActivate,
}: PlayerProps) {
  if (hlsUrl) {
    if (isLive) {
      return (
        <LiveBroadcastHlsPlayer
          onBack={onBack}
          onPipActivate={onPipActivate}
        />
      );
    }
    return (
      <HlsVideoPlayer
        hlsUrl={hlsUrl}
        title={title}
        onBack={onBack}
        startPositionSecs={startPositionSecs}
        isLive={false}
        onProgress={onProgress}
      />
    );
  }

  if (isLive) {
    return (
      <LiveYouTubePlayer
        initialVideoId={videoId}
        initialTitle={title}
        onBack={onBack}
      />
    );
  }

  return (
    <YouTubePlayer
      videoId={videoId}
      title={title}
      onBack={onBack}
      isLive={false}
    />
  );
}

