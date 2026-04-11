import React, { useState } from "react";
import {
  ActivityIndicator,
  Image,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import * as WebBrowser from "expo-web-browser";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";

interface YoutubePlayerProps {
  videoId?: string;
  isLive?: boolean;
  thumbnailUrl?: string;
  channelHandle?: string;
  autoPlay?: boolean;
  title?: string;
  preacher?: string;
  onEnd?: () => void;
  onPlay?: () => void;
  onPause?: () => void;
  onToggleAudioMode?: () => void;
}

export function YoutubePlayer({
  videoId,
  isLive,
  thumbnailUrl,
  channelHandle = "templetvjctm",
  autoPlay,
  onEnd,
  onPlay,
  onPause,
}: YoutubePlayerProps) {
  const c = useColors();
  const [loading, setLoading] = useState(false);

  const openVideo = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setLoading(true);
    try {
      let url: string;
      if (isLive) {
        url = `https://www.youtube.com/@${channelHandle}/live`;
      } else if (videoId) {
        if (Platform.OS !== "web") {
          const youtubeApp = `youtube://watch?v=${videoId}`;
          const canOpen = await Linking.canOpenURL(youtubeApp);
          if (canOpen) {
            await Linking.openURL(youtubeApp);
            return;
          }
        }
        url = `https://www.youtube.com/watch?v=${videoId}`;
      } else {
        url = `https://www.youtube.com/@${channelHandle}`;
      }

      if (Platform.OS === "web") {
        window.open(url, "_blank");
      } else {
        await WebBrowser.openBrowserAsync(url, {
          toolbarColor: "#000000",
          controlsColor: "#6A0DAD",
          presentationStyle: WebBrowser.WebBrowserPresentationStyle.FULL_SCREEN,
        });
      }
    } finally {
      setLoading(false);
    }
  };

  const thumb = thumbnailUrl ?? (videoId ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` : null);

  return (
    <View style={styles.container}>
      {thumb && (
        <Image source={{ uri: thumb }} style={styles.thumbnail} resizeMode="cover" />
      )}
      <View style={[styles.overlay, { backgroundColor: "rgba(0,0,0,0.35)" }]}>
        <Pressable
          onPress={openVideo}
          style={({ pressed }) => [
            styles.playButton,
            {
              backgroundColor: loading ? c.primary : "#FF0000",
              opacity: pressed ? 0.8 : 1,
              transform: [{ scale: pressed ? 0.92 : 1 }],
            },
          ]}
        >
          {loading ? (
            <ActivityIndicator color="#FFF" size="small" />
          ) : (
            <Feather name="play" size={28} color="#FFF" />
          )}
        </Pressable>
        <Text style={styles.tapHint}>Opens on YouTube</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0a0a0a",
    position: "relative",
  },
  thumbnail: {
    ...StyleSheet.absoluteFillObject,
    width: "100%",
    height: "100%",
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  playButton: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    paddingLeft: 4,
    boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
  },
  tapHint: {
    color: "rgba(255,255,255,0.5)",
    fontSize: 12,
    fontFamily: "Inter_400Regular",
  },
});
