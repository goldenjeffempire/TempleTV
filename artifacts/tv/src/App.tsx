import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import type { VideoItem } from "./lib/api";
import { isLoggedIn as readIsLoggedIn, subscribeAuth } from "./lib/auth";
import { AuthGateModal } from "./components/AuthGateModal";
import { usePlatformInit } from "./hooks/usePlatformInit";

const Home = lazy(() => import("./pages/Home").then((m) => ({ default: m.Home })));
const TVGuide = lazy(() => import("./pages/TVGuide").then((m) => ({ default: m.TVGuide })));
const Search = lazy(() => import("./pages/Search").then((m) => ({ default: m.Search })));
const VideoDetails = lazy(() =>
  import("./pages/VideoDetails").then((m) => ({ default: m.VideoDetails })),
);
const Player = lazy(() => import("./pages/Player").then((m) => ({ default: m.Player })));

type Screen = "home" | "guide" | "search";

function getInitialScreen(): Screen {
  if (typeof window === "undefined") return "home";
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("screen");
  if (requested === "guide" || requested === "search") return requested;
  return "home";
}

function SplashFallback() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-black text-white">
      <div className="flex flex-col items-center gap-4">
        <div className="h-12 w-12 rounded-full border-4 border-white/20 border-t-white animate-spin" />
        <div className="text-sm tracking-widest opacity-70 uppercase">Temple TV</div>
      </div>
    </div>
  );
}

export default function App() {
  // Initialize platform-specific key registration and body classes
  usePlatformInit();

  const [screen, setScreen] = useState<Screen>(getInitialScreen);
  const [player, setPlayer] = useState<{
    videoId: string;
    title: string;
    hlsUrl?: string;
    startPositionSecs?: number;
  } | null>(null);
  const [detailsVideo, setDetailsVideo] = useState<{
    video: VideoItem;
    related: VideoItem[];
  } | null>(null);

  const [authed, setAuthed] = useState<boolean>(readIsLoggedIn);
  const [pendingPlay, setPendingPlay] = useState<{
    videoId: string;
    title: string;
    hlsUrl?: string;
    startPositionSecs?: number;
  } | null>(null);
  const [gateOpen, setGateOpen] = useState(false);

  useEffect(() => subscribeAuth((next) => setAuthed(next)), []);

  const gatedPlay = useCallback(
    (videoId: string, title: string, hlsUrl?: string, startPositionSecs?: number) => {
      if (authed) {
        setPlayer({ videoId, title, hlsUrl, startPositionSecs });
        return;
      }
      setPendingPlay({ videoId, title, hlsUrl, startPositionSecs });
      setGateOpen(true);
    },
    [authed],
  );

  const handleGateClose = useCallback(() => {
    setGateOpen(false);
    setPendingPlay(null);
  }, []);

  const handleGateAuthed = useCallback(() => {
    setGateOpen(false);
    if (pendingPlay) {
      setPlayer(pendingPlay);
      setPendingPlay(null);
    }
  }, [pendingPlay]);

  let content: React.ReactNode;

  if (player) {
    content = (
      <Player
        videoId={player.videoId}
        title={player.title}
        onBack={() => setPlayer(null)}
        hlsUrl={player.hlsUrl}
        startPositionSecs={player.startPositionSecs}
      />
    );
  } else if (detailsVideo) {
    content = (
      <VideoDetails
        video={detailsVideo.video}
        relatedVideos={detailsVideo.related}
        onPlay={() =>
          gatedPlay(
            detailsVideo.video.videoId,
            detailsVideo.video.title,
            detailsVideo.video.localVideoUrl ?? undefined,
          )
        }
        onBack={() => setDetailsVideo(null)}
        onPlayRelated={(videoId, title, hlsUrl) => {
          setDetailsVideo(null);
          gatedPlay(videoId, title, hlsUrl);
        }}
      />
    );
  } else if (screen === "guide") {
    content = (
      <TVGuide
        onBack={() => setScreen("home")}
        onPlay={(videoId, title, hlsUrl, startSecs) => gatedPlay(videoId, title, hlsUrl, startSecs)}
      />
    );
  } else if (screen === "search") {
    content = (
      <Search
        onBack={() => setScreen("home")}
        onPlay={(videoId, title, hlsUrl) => gatedPlay(videoId, title, hlsUrl)}
        onDetails={(video) => {
          setDetailsVideo({ video, related: [] });
        }}
      />
    );
  } else {
    content = (
      <Home
        onNavigateGuide={() => setScreen("guide")}
        onNavigateSearch={() => setScreen("search")}
        onPlay={(videoId, title, hlsUrl, startPositionSecs) => gatedPlay(videoId, title, hlsUrl, startPositionSecs)}
        onDetails={(video, related) => setDetailsVideo({ video, related })}
      />
    );
  }

  return (
    <>
      <Suspense fallback={<SplashFallback />}>{content}</Suspense>
      <AuthGateModal
        open={gateOpen}
        onClose={handleGateClose}
        onAuthed={handleGateAuthed}
        reason={pendingPlay ? `Sign in to watch "${pendingPlay.title}"` : undefined}
      />
    </>
  );
}
