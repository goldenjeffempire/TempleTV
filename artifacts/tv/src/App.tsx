import { useState } from "react";
import { Home } from "./pages/Home";
import { TVGuide } from "./pages/TVGuide";
import { Search } from "./pages/Search";
import { VideoDetails } from "./pages/VideoDetails";
import { Player } from "./pages/Player";
import type { VideoItem } from "./lib/api";

type Screen = "home" | "guide" | "search";

export default function App() {
  const [screen, setScreen] = useState<Screen>("home");
  const [player, setPlayer] = useState<{ videoId: string; title: string } | null>(null);
  const [detailsVideo, setDetailsVideo] = useState<{ video: VideoItem; related: VideoItem[] } | null>(null);

  if (player) {
    return (
      <Player
        videoId={player.videoId}
        title={player.title}
        onBack={() => setPlayer(null)}
      />
    );
  }

  if (detailsVideo) {
    return (
      <VideoDetails
        video={detailsVideo.video}
        relatedVideos={detailsVideo.related}
        onPlay={() => setPlayer({ videoId: detailsVideo.video.videoId, title: detailsVideo.video.title })}
        onBack={() => setDetailsVideo(null)}
        onPlayRelated={(videoId, title) => { setDetailsVideo(null); setPlayer({ videoId, title }); }}
      />
    );
  }

  if (screen === "guide") {
    return (
      <TVGuide
        onBack={() => setScreen("home")}
        onPlay={(videoId, title) => setPlayer({ videoId, title })}
      />
    );
  }

  if (screen === "search") {
    return (
      <Search
        onBack={() => setScreen("home")}
        onPlay={(videoId, title) => setPlayer({ videoId, title })}
        onDetails={(video) => { setDetailsVideo({ video, related: [] }); }}
      />
    );
  }

  return (
    <Home
      onNavigateGuide={() => setScreen("guide")}
      onNavigateSearch={() => setScreen("search")}
      onPlay={(videoId, title) => setPlayer({ videoId, title })}
      onDetails={(video, related) => setDetailsVideo({ video, related })}
    />
  );
}
