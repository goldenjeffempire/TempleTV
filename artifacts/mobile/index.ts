import { Platform } from "react-native";

if (Platform.OS !== "web") {
  try {
    const TrackPlayer = require("react-native-track-player").default;
    const { PlaybackService } = require("./services/PlayerService");
    TrackPlayer.registerPlaybackService(() => PlaybackService);
  } catch {
    // TrackPlayer not available — graceful degradation
  }
}

import "expo-router/entry";
