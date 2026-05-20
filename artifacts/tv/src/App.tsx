import { Suspense, lazy, useCallback, useRef, useState } from "react";
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

type Screen = "home" | "search" | "history" | "settings";

function getInitialScreen(): Screen {
  if (typeof window === "undefined") return "home";
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("screen");
  if (
    requested === "search" ||
    requested === "history" ||
    requested === "settings"
  )
    {return requested;}
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
    startPositionSecs?: number;
    isLive?: boolean;
  } | null>(null);
  const [detailsVideo, setDetailsVideo] = useState<{
    video: VideoItem;
    related: VideoItem[];
  } | null>(null);
  const [seriesDetail, setSeriesDetail] = useState<SeriesItem | null>(null);
  const [showAuthGate, setShowAuthGate] = useState(false);

  // Track the latest progress report so we can flush it on back (final save).
  const lastProgressRef = useRef<{ positionSecs: number; durationSecs: number } | null>(null);

  const play = useCallback(
    (videoId: string, title: string, hlsUrl?: string, startPositionSecs?: number, isLive?: boolean, thumbnailUrl?: string) => {
      lastProgressRef.current = null;
      setPlayer({ videoId, title, thumbnailUrl: thumbnailUrl ?? "", hlsUrl, startPositionSecs, isLive });
    },
    [],
  );

  // Called every ≈5 s by the active player for VOD content only.
  const handleProgress = useCallback(
    (positionSecs: number, durationSecs: number) => {
      lastProgressRef.current = { positionSecs, durationSecs };
      if (!player || player.isLive) return;
      // Derive YouTube thumbnail as fallback when no local thumbnailUrl is set.
      const thumbFallback =
        player.thumbnailUrl ||
        (!player.hlsUrl ? `https://img.youtube.com/vi/${player.videoId}/mqdefault.jpg` : "");
      saveProgress({
        videoId: player.videoId,
        title: player.title,
        thumbnailUrl: thumbFallback,
        hlsUrl: player.hlsUrl ?? null,
        positionSecs,
        durationSecs,
        updatedAt: Date.now(),
      });
    },
    [player],
  );

  // Flush the last known position when the viewer navigates back from the player.
  const handlePlayerBack = useCallback(() => {
    if (player && !player.isLive && lastProgressRef.current) {
      const p = lastProgressRef.current;
      const thumbFallback =
        player.thumbnailUrl ||
        (!player.hlsUrl ? `https://img.youtube.com/vi/${player.videoId}/mqdefault.jpg` : "");
      saveProgress({
        videoId: player.videoId,
        title: player.title,
        thumbnailUrl: thumbFallback,
        hlsUrl: player.hlsUrl ?? null,
        positionSecs: p.positionSecs,
        durationSecs: p.durationSecs,
        updatedAt: Date.now(),
      });
    }
    setPlayer(null);
  }, [player]);

  let content: React.ReactNode;

  if (player) {
    content = (
      <Player
        videoId={player.videoId}
        title={player.title}
        onBack={handlePlayerBack}
        hlsUrl={player.hlsUrl}
        startPositionSecs={player.startPositionSecs}
        isLive={player.isLive ?? false}
        onProgress={handleProgress}
      />
    );
  } else if (detailsVideo) {
    content = (
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
        onBack={() => setDetailsVideo(null)}
        onPlayRelated={(videoId, title, hlsUrl) => {
          setDetailsVideo(null);
          play(videoId, title, hlsUrl);
        }}
      />
    );
  } else if (seriesDetail) {
    content = (
      <SeriesDetail
        series={seriesDetail}
        onBack={() => setSeriesDetail(null)}
        onPlay={(videoId, title, hlsUrl, startSecs) => play(videoId, title, hlsUrl, startSecs, undefined, seriesDetail.thumbnailUrl || undefined)}
        onEpisodeDetails={(video, related) => {
          setSeriesDetail(null);
          setDetailsVideo({ video, related });
        }}
      />
    );
  } else if (screen === "settings") {
    content = (
      <Settings
        onBack={() => setScreen("home")}
        onSignIn={() => setShowAuthGate(true)}
      />
    );
  } else if (screen === "search") {
    content = (
      <Search
        onBack={() => setScreen("home")}
        onPlay={(videoId, title, hlsUrl) => {
          const saved = getProgress(videoId);
          play(videoId, title, hlsUrl, saved?.positionSecs);
        }}
        onDetails={(video) => {
          setDetailsVideo({ video, related: [] });
        }}
      />
    );
  } else if (screen === "history") {
    content = (
      <WatchHistory
        onBack={() => setScreen("home")}
        onPlay={(videoId, title, hlsUrl, startSecs) => play(videoId, title, hlsUrl, startSecs)}
      />
    );
  } else {
    content = (
      <Home
        onNavigateSearch={() => setScreen("search")}
        onNavigateHistory={() => setScreen("history")}
        onNavigateSettings={() => setScreen("settings")}
        onPlay={(videoId, title, hlsUrl, startPositionSecs, isLive) => play(videoId, title, hlsUrl, startPositionSecs, isLive)}
        onDetails={(video, related) => setDetailsVideo({ video, related })}
        onSeriesDetail={(s) => setSeriesDetail(s)}
      />
    );
  }

  // Derive a stable key so the tv-screen-enter animation fires whenever the
  // active surface changes (home → search, search → history, etc.). Player and
  // VideoDetails each get their own key so they fade in too.
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
        <div key={screenKey} className="tv-screen-enter" style={{ width: "100%", height: "100%", position: "relative" }}>
          {content}
          <OnAirOverlays />
        </div>
      </Suspense>
      {/* Global auth gate modal — mounted outside the keyed screen so it
          survives screen transitions without remounting */}
      <AuthGateModal
        open={showAuthGate}
        onClose={() => setShowAuthGate(false)}
        onAuthed={() => {
          setShowAuthGate(false);
          // If the user signed in from Settings, return to home so they
          // see the signed-in state on the hero
          if (screen === "settings") setScreen("home");
        }}
        reason="Sign in to sync your watch history across devices"
      />
    </ErrorBoundary>
  );
}
