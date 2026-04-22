import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import type { VideoItem } from "./lib/api";
import { isLoggedIn as readIsLoggedIn, subscribeAuth } from "./lib/auth";
import { AuthGateModal } from "./components/AuthGateModal";

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
  const [screen, setScreen] = useState<Screen>(getInitialScreen);
  const [player, setPlayer] = useState<{ videoId: string; title: string } | null>(null);
  const [detailsVideo, setDetailsVideo] = useState<{
    video: VideoItem;
    related: VideoItem[];
  } | null>(null);

  // ── Auth gating ──────────────────────────────────────────────────
  // Track auth as React state so re-renders happen when the user pairs
  // their device. The pending playback target is captured the moment
  // gating happens so we can resume the exact same video on success.
  const [authed, setAuthed] = useState<boolean>(readIsLoggedIn);
  const [pendingPlay, setPendingPlay] = useState<
    | { videoId: string; title: string }
    | null
  >(null);
  const [gateOpen, setGateOpen] = useState(false);

  useEffect(() => subscribeAuth((next) => setAuthed(next)), []);

  // gatedPlay() is the single funnel for ALL playback intents on the
  // TV. If signed in we just open the player; otherwise we capture
  // the target and pop the pairing modal.
  const gatedPlay = useCallback(
    (videoId: string, title: string) => {
      if (authed) {
        setPlayer({ videoId, title });
        return;
      }
      setPendingPlay({ videoId, title });
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
      />
    );
  } else if (detailsVideo) {
    content = (
      <VideoDetails
        video={detailsVideo.video}
        relatedVideos={detailsVideo.related}
        onPlay={() =>
          gatedPlay(detailsVideo.video.videoId, detailsVideo.video.title)
        }
        onBack={() => setDetailsVideo(null)}
        onPlayRelated={(videoId, title) => {
          setDetailsVideo(null);
          gatedPlay(videoId, title);
        }}
      />
    );
  } else if (screen === "guide") {
    content = (
      <TVGuide
        onBack={() => setScreen("home")}
        onPlay={(videoId, title) => gatedPlay(videoId, title)}
      />
    );
  } else if (screen === "search") {
    content = (
      <Search
        onBack={() => setScreen("home")}
        onPlay={(videoId, title) => gatedPlay(videoId, title)}
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
        onPlay={(videoId, title) => gatedPlay(videoId, title)}
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
