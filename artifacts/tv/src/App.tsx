import { useState } from "react";
import { Home } from "./pages/Home";
import { TVGuide } from "./pages/TVGuide";
import { Player } from "./pages/Player";

type Screen = "home" | "guide";

export default function App() {
  const [screen, setScreen] = useState<Screen>("home");
  const [player, setPlayer] = useState<{ videoId: string; title: string } | null>(null);

  if (player) {
    return (
      <Player
        videoId={player.videoId}
        title={player.title}
        onBack={() => setPlayer(null)}
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

  return (
    <Home
      onNavigateGuide={() => setScreen("guide")}
      onPlay={(videoId, title) => setPlayer({ videoId, title })}
    />
  );
}
