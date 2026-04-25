import { Suspense, lazy, useCallback, useState } from "react";
import type { VideoItem } from "./lib/api";
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
  usePlatformInit();

  const [screen, setScreen] = useState<Screen>(getInitialScreen);
  const [player, setPlayer] = useState<{
    videoId: string;
    title: string;
    hlsUrl?: string;
    startPositionSecs?: number;
    isLive?: boolean;
  } | null>(null);
  const [detailsVideo, setDetailsVideo] = useState<{
    video: VideoItem;
    related: VideoItem[];
  } | null>(null);

  const play = useCallback(
    (videoId: string, title: string, hlsUrl?: string, startPositionSecs?: number, isLive?: boolean) => {
      setPlayer({ videoId, title, hlsUrl, startPositionSecs, isLive });
    },
    [],
  );

  let content: React.ReactNode;

  if (player) {
    content = (
      <Player
        videoId={player.videoId}
        title={player.title}
        onBack={() => setPlayer(null)}
        hlsUrl={player.hlsUrl}
        startPositionSecs={player.startPositionSecs}
        isLive={player.isLive ?? false}
      />
    );
  } else if (detailsVideo) {
    content = (
      <VideoDetails
        video={detailsVideo.video}
        relatedVideos={detailsVideo.related}
        onPlay={() =>
          play(
            detailsVideo.video.videoId,
            detailsVideo.video.title,
            detailsVideo.video.localVideoUrl ?? undefined,
          )
        }
        onBack={() => setDetailsVideo(null)}
        onPlayRelated={(videoId, title, hlsUrl) => {
          setDetailsVideo(null);
          play(videoId, title, hlsUrl);
        }}
      />
    );
  } else if (screen === "guide") {
    content = (
      <TVGuide
        onBack={() => setScreen("home")}
        onPlay={(videoId, title, hlsUrl, startSecs, isLive) => play(videoId, title, hlsUrl, startSecs, isLive)}
      />
    );
  } else if (screen === "search") {
    content = (
      <Search
        onBack={() => setScreen("home")}
        onPlay={(videoId, title, hlsUrl) => play(videoId, title, hlsUrl)}
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
        onPlay={(videoId, title, hlsUrl, startPositionSecs, isLive) => play(videoId, title, hlsUrl, startPositionSecs, isLive)}
        onDetails={(video, related) => setDetailsVideo({ video, related })}
      />
    );
  }

  return (
    <Suspense fallback={<SplashFallback />}>{content}</Suspense>
  );
}
