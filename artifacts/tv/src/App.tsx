import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { pauseAllBroadcastSessions } from "@workspace/player-core/react";
import type { VideoItem } from "./lib/api";
import type { SeriesItem } from "./hooks/useSeries";
import { saveProgress, getProgress } from "./lib/watchProgress";
import { usePlatformInit } from "./hooks/usePlatformInit";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { TempleTvLogo } from "./components/TempleTvLogo";
import { ConnectivityBanner } from "./components/ConnectivityBanner";
import { OnAirTicker } from "./components/OnAirTicker";
import { LowerThird } from "./components/LowerThird";
import { EmergencyAlert } from "./components/EmergencyAlert";
import { useOnAirGraphics } from "./hooks/useOnAirGraphics";
import { useEmergencyAlerts } from "./hooks/useEmergencyAlerts";
import { AuthGateModal } from "./components/AuthGateModal";
import { PipIndicator } from "./components/PipIndicator";

const Home = lazy(() => import("./pages/Home").then((m) => ({ default: m.Home })));
const Search = lazy(() => import("./pages/Search").then((m) => ({ default: m.Search })));
const WatchHistory = lazy(() =>
  import("./pages/WatchHistory").then((m) => ({ default: m.WatchHistory })),
);
const VideoDetails = lazy(() =>
  import("./pages/VideoDetails").then((m) => ({ default: m.VideoDetails })),
);
const SeriesDetail = lazy(() =>
  import("./pages/SeriesDetail").then((m) => ({ default: m.SeriesDetail })),
);
const Player = lazy(() => import("./pages/Player").then((m) => ({ default: m.Player })));
const Settings = lazy(() => import("./pages/Settings").then((m) => ({ default: m.Settings })));
const Playlists = lazy(() => import("./pages/Playlists").then((m) => ({ default: m.Playlists })));

type Screen = "home" | "search" | "history" | "settings" | "playlists";

function getInitialScreen(): Screen {
  if (typeof window === "undefined") return "home";
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("screen");
  if (
    requested === "search" ||
    requested === "history" ||
    requested === "settings" ||
    requested === "playlists"
  )
    { return requested; }
  return "home";
}

/**
 * Splash fallback shown while a lazy-loaded route bundle is downloading
 * (cold visit, route switch, slow Smart-TV CPU). Renders the actual brand
 * mark instead of just a spinner + uppercase text — the logo is preloaded
 * via the `<link rel="preload">` in `index.html`, so this paints with the
 * very first frame of the SPA, not after a network round-trip.
 */
function SplashFallback() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-black text-white">
      <div className="flex flex-col items-center gap-6">
        <TempleTvLogo size={56} variant="wordmark" priority />
        <div className="h-10 w-10 rounded-full border-4 border-white/20 border-t-white animate-spin" />
      </div>
    </div>
  );
}

function OnAirOverlays() {
  const { ticker, lowerThird } = useOnAirGraphics("temple-tv-live");
  const { activeAlert, dismiss } = useEmergencyAlerts();

  return (
    <>
      {activeAlert && (
        <EmergencyAlert alert={activeAlert} onDismiss={dismiss} />
      )}
      {lowerThird && !activeAlert && (
        <LowerThird name={lowerThird.content} title={lowerThird.subContent} />
      )}
      {ticker && !activeAlert && (
        <OnAirTicker text={ticker.content} />
      )}
    </>
  );
}

export default function App() {
  usePlatformInit();

  const [screen, setScreen] = useState<Screen>(getInitialScreen);
  const [player, setPlayer] = useState<{
    videoId: string;
    title: string;
    thumbnailUrl: string;
    hlsUrl?: string;
    hlsMasterUrl?: string;
    startPositionSecs?: number;
    isLive?: boolean;
  } | null>(null);
  const [detailsVideo, setDetailsVideo] = useState<{
    video: VideoItem;
    related: VideoItem[];
  } | null>(null);
  const [seriesDetail, setSeriesDetail] = useState<SeriesItem | null>(null);
  const [showAuthGate, setShowAuthGate] = useState(false);

  // Snapshot of the player that activated PiP — used by PipIndicator's
  // "Return to Full Screen" to restore the exact broadcast session.
  const [pipSource, setPipSource] = useState<typeof player>(null);

  // Track the latest progress report so we can flush it on back (final save).
  const lastProgressRef = useRef<{ positionSecs: number; durationSecs: number } | null>(null);

  // ── History API — browser/remote Back button support ─────────────────────
  //
  // Every forward navigation pushes a new history entry. The remote Back
  // button (or browser Back) fires `popstate`, which closes the topmost
  // layer without a full page reload — critical for 24/7 TV deployments
  // where a reload means a brief black screen visible to viewers.
  //
  // Flow:
  //   play()          → pushState depth+1 → user presses Back
  //   popstate fires  → flushAndClosePlayer() → depth returns to n
  //   setScreen(x)    → pushState depth+1 → user presses Back
  //   popstate fires  → setScreen("home")
  //
  // onBack callbacks in page components call window.history.back() so the
  // popstate path is the single source of truth for state rollback.

  const navDepthRef = useRef(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    history.replaceState({ depth: 0 }, "");
    navDepthRef.current = 0;
  }, []);

  const pushHistory = useCallback(() => {
    if (typeof window === "undefined") return;
    navDepthRef.current += 1;
    history.pushState({ depth: navDepthRef.current }, "");
  }, []);

  // Shared back handler used by all page onBack callbacks.
  const handleBack = useCallback(() => {
    if (typeof window !== "undefined") window.history.back();
  }, []);

  // Flush VOD progress to localStorage on player close, then clear the player.
  const flushAndClosePlayer = useCallback(
    (currentPlayer: NonNullable<typeof player>) => {
      if (!currentPlayer.isLive && lastProgressRef.current) {
        const p = lastProgressRef.current;
        const thumbFallback =
          currentPlayer.thumbnailUrl ||
          (!currentPlayer.hlsUrl
            ? `https://img.youtube.com/vi/${currentPlayer.videoId}/mqdefault.jpg`
            : "");
        saveProgress({
          videoId: currentPlayer.videoId,
          title: currentPlayer.title,
          thumbnailUrl: thumbFallback,
          hlsUrl: currentPlayer.hlsUrl ?? null,
          hlsMasterUrl: currentPlayer.hlsMasterUrl ?? null,
          positionSecs: p.positionSecs,
          durationSecs: p.durationSecs,
          updatedAt: Date.now(),
        });
      }
      // Stop the player audio synchronously before React unmounts the player
      // and mounts the hero — prevents the player audio from bleeding into the
      // first frames of the hero transition (symmetric to the play() call below).
      pauseAllBroadcastSessions();
      setPlayer(null);
      lastProgressRef.current = null;
    },
    [],
  );

  // popstate = remote Back button press or browser Back button.
  // Close the topmost layer in LIFO order.
  useEffect(() => {
    const handlePop = () => {
      if (player !== null) {
        flushAndClosePlayer(player);
      } else if (detailsVideo !== null) {
        setDetailsVideo(null);
      } else if (seriesDetail !== null) {
        setSeriesDetail(null);
      } else if (screen !== "home") {
        setScreen("home");
      }
      // At depth 0 with screen=home the popstate fires but there is nothing
      // to close — the TV runtime or browser handles further back navigation.
    };
    window.addEventListener("popstate", handlePop);
    return () => window.removeEventListener("popstate", handlePop);
  }, [player, detailsVideo, seriesDetail, screen, flushAndClosePlayer]);

  // ── Navigation helpers ────────────────────────────────────────────────────

  const navigateScreen = useCallback(
    (s: Screen) => {
      setScreen(s);
      if (s !== "home") pushHistory();
    },
    [pushHistory],
  );

  const play = useCallback(
    (
      videoId: string,
      title: string,
      hlsUrl?: string,
      startPositionSecs?: number,
      isLive?: boolean,
      thumbnailUrl?: string,
    ) => {
      // Exit PiP before switching content. When the user picks a new video
      // (VOD or live) while the broadcast is in a PiP window, we cleanly
      // close PiP first so the orphaned HLS stream is torn down by the
      // `leavepictureinpicture` handler in usePictureInPicture.ts rather
      // than running silently in the background.
      if (typeof document !== "undefined" && document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(() => {});
      }
      // Stop any active broadcast sessions (hero, background players) in the
      // same event-loop tick as the navigation — before React re-renders or
      // runs any effect cleanup. This eliminates the overlapping-audio window
      // that would otherwise persist until React's passive effect cleanup cycle
      // (which runs after the next paint).
      pauseAllBroadcastSessions();
      lastProgressRef.current = null;
      setPlayer({ videoId, title, thumbnailUrl: thumbnailUrl ?? "", hlsUrl, hlsMasterUrl: hlsUrl, startPositionSecs, isLive });
      pushHistory();
    },
    [pushHistory],
  );

  // Called by LiveBroadcastHlsPlayer when PiP is activated — saves context
  // so the operator can return to the full player from the PipIndicator badge.
  const handlePipActivate = useCallback(() => {
    if (player) setPipSource(player);
  }, [player]);

  // Called by PipIndicator "Return to Full Screen" — exits PiP, restores player.
  const handleReturnToPlayer = useCallback(() => {
    const src = pipSource;
    if (!src) return;
    setPipSource(null);
    play(src.videoId, src.title, src.hlsUrl, src.startPositionSecs, src.isLive, src.thumbnailUrl);
  }, [pipSource, play]);

  // Called every ≈5 s by the active player for VOD content only.
  const handleProgress = useCallback(
    (positionSecs: number, durationSecs: number) => {
      lastProgressRef.current = { positionSecs, durationSecs };
      if (!player || player.isLive) return;
      const thumbFallback =
        player.thumbnailUrl ||
        (!player.hlsUrl ? `https://img.youtube.com/vi/${player.videoId}/mqdefault.jpg` : "");
      saveProgress({
        videoId: player.videoId,
        title: player.title,
        thumbnailUrl: thumbFallback,
        hlsUrl: player.hlsUrl ?? null,
        hlsMasterUrl: player.hlsMasterUrl ?? null,
        positionSecs,
        durationSecs,
        updatedAt: Date.now(),
      });
    },
    [player],
  );

  const openDetails = useCallback(
    (video: VideoItem, related: VideoItem[]) => {
      setDetailsVideo({ video, related });
      pushHistory();
    },
    [pushHistory],
  );

  const openSeries = useCallback(
    (s: SeriesItem) => {
      setSeriesDetail(s);
      pushHistory();
    },
    [pushHistory],
  );

  // ── Page rendering ────────────────────────────────────────────────────────
  // Each page is wrapped in its own ErrorBoundary so a crash in one page
  // does not tear down the entire app. onReset navigates back via history so
  // the user can recover without a full page reload.

  let content: React.ReactNode;

  if (player) {
    content = (
      <ErrorBoundary onReset={handleBack}>
        <Player
          videoId={player.videoId}
          title={player.title}
          onBack={handleBack}
          hlsUrl={player.hlsUrl}
          startPositionSecs={player.startPositionSecs}
          isLive={player.isLive ?? false}
          onProgress={handleProgress}
          onPipActivate={handlePipActivate}
        />
      </ErrorBoundary>
    );
  } else if (detailsVideo) {
    content = (
      <ErrorBoundary onReset={handleBack}>
        <VideoDetails
          video={detailsVideo.video}
          relatedVideos={detailsVideo.related}
          onPlay={(startSecs?: number) =>
            play(
              detailsVideo.video.videoId,
              detailsVideo.video.title,
              detailsVideo.video.localVideoUrl ?? undefined,
              startSecs,
              undefined,
              detailsVideo.video.thumbnailUrl || undefined,
            )
          }
          onBack={handleBack}
          onPlayRelated={(videoId, title, hlsUrl) => {
            setDetailsVideo(null);
            play(videoId, title, hlsUrl);
          }}
        />
      </ErrorBoundary>
    );
  } else if (seriesDetail) {
    content = (
      <ErrorBoundary onReset={handleBack}>
        <SeriesDetail
          series={seriesDetail}
          onBack={handleBack}
          onPlay={(videoId, title, hlsUrl, startSecs) =>
            play(videoId, title, hlsUrl, startSecs, undefined, seriesDetail.thumbnailUrl || undefined)
          }
          onEpisodeDetails={(video, related) => {
            setSeriesDetail(null);
            openDetails(video, related);
          }}
        />
      </ErrorBoundary>
    );
  } else if (screen === "settings") {
    content = (
      <ErrorBoundary onReset={handleBack}>
        <Settings
          onBack={handleBack}
          onSignIn={() => setShowAuthGate(true)}
        />
      </ErrorBoundary>
    );
  } else if (screen === "search") {
    content = (
      <ErrorBoundary onReset={handleBack}>
        <Search
          onBack={handleBack}
          onPlay={(videoId, title, hlsUrl) => {
            const saved = getProgress(videoId);
            play(videoId, title, hlsUrl, saved?.positionSecs);
          }}
          onDetails={(video) => {
            openDetails(video, []);
          }}
        />
      </ErrorBoundary>
    );
  } else if (screen === "history") {
    content = (
      <ErrorBoundary onReset={handleBack}>
        <WatchHistory
          onBack={handleBack}
          onPlay={(videoId, title, hlsUrl, startSecs) => play(videoId, title, hlsUrl, startSecs)}
        />
      </ErrorBoundary>
    );
  } else if (screen === "playlists") {
    content = (
      <ErrorBoundary onReset={handleBack}>
        <Playlists
          onBack={handleBack}
          onPlay={(videoId, title, hlsUrl, startSecs, isLive, thumbnailUrl) =>
            play(videoId, title, hlsUrl, startSecs, isLive, thumbnailUrl)
          }
        />
      </ErrorBoundary>
    );
  } else {
    content = (
      <ErrorBoundary onReset={() => { setScreen("home"); }}>
        <Home
          onNavigateSearch={() => navigateScreen("search")}
          onNavigateHistory={() => navigateScreen("history")}
          onNavigateSettings={() => navigateScreen("settings")}
          onNavigatePlaylists={() => navigateScreen("playlists")}
          onPlay={(videoId, title, hlsUrl, startPositionSecs, isLive) =>
            play(videoId, title, hlsUrl, startPositionSecs, isLive)
          }
          onDetails={(video, related) => openDetails(video, related)}
          onSeriesDetail={(s) => openSeries(s)}
        />
      </ErrorBoundary>
    );
  }

  // Derive a stable key so the tv-screen-enter animation fires whenever the
  // active surface changes (home → search, search → history, etc.). Player
  // and VideoDetails each get their own key so they fade in too.
  const screenKey = player
    ? `player-${player.videoId}`
    : detailsVideo
    ? `details-${detailsVideo.video.videoId}`
    : seriesDetail
    ? `series-${seriesDetail.id}`
    : screen;

  return (
    <ErrorBoundary>
      <ConnectivityBanner />
      <Suspense fallback={<SplashFallback />}>
        <div
          key={screenKey}
          className="tv-screen-enter"
          style={{ width: "100%", height: "100%", position: "relative" }}
        >
          {content}
          {/* Isolated boundary: a crash in graphics/emergency-alert hooks must
              not tear down the player or navigation — it only removes overlays. */}
          <ErrorBoundary>
            <OnAirOverlays />
          </ErrorBoundary>
        </div>
      </Suspense>
      {/* Global PiP indicator — persists across all screen transitions so the
          operator always sees the "Live broadcast in Picture-in-Picture" badge
          and the "Return to Full Screen" CTA no matter which page they're on */}
      <PipIndicator onReturnToPlayer={handleReturnToPlayer} />

      {/* Global auth gate modal — mounted outside the keyed screen so it
          survives screen transitions without remounting */}
      <AuthGateModal
        open={showAuthGate}
        onClose={() => setShowAuthGate(false)}
        onAuthed={() => {
          setShowAuthGate(false);
          // If the user signed in from Settings, return home so they
          // see the signed-in state on the hero
          if (screen === "settings") setScreen("home");
        }}
        reason="Sign in to sync your watch history across devices"
      />
    </ErrorBoundary>
  );
}
