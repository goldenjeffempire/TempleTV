import React, { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import * as WebBrowser from "expo-web-browser";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";

let YoutubeIframe: any = null;
try {
  YoutubeIframe = require("react-native-youtube-iframe").default;
} catch {
  YoutubeIframe = null;
}

interface YoutubePlayerProps {
  videoId?: string;
  isLive?: boolean;
  thumbnailUrl?: string;
  channelHandle?: string;
  autoPlay?: boolean;
  onEnd?: () => void;
  onPlay?: () => void;
  onPause?: () => void;
}

export function YoutubePlayer({
  videoId,
  isLive,
  thumbnailUrl,
  channelHandle = "templetvjctm",
  autoPlay = true,
  onEnd,
  onPlay,
  onPause,
}: YoutubePlayerProps) {
  const c = useColors();
  const { width } = useWindowDimensions();
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(autoPlay);
  const [playerReady, setPlayerReady] = useState(false);
  const [playerError, setPlayerError] = useState(false);

  const playerHeight = Math.min(Math.round(width * (9 / 16)), 260);

  const onChangeState = useCallback(
    (state: string) => {
      if (state === "ended") {
        setPlaying(false);
        onEnd?.();
      } else if (state === "playing") {
        setPlaying(true);
        onPlay?.();
      } else if (state === "paused") {
        setPlaying(false);
        onPause?.();
      }
    },
    [onEnd, onPlay, onPause],
  );

  const openExternal = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setLoading(true);
    try {
      let url: string;
      if (isLive) {
        url = `https://www.youtube.com/@${channelHandle}/live`;
      } else if (videoId) {
        if (Platform.OS !== "web") {
          const ytUrl = `youtube://watch?v=${videoId}`;
          const canOpen = await Linking.canOpenURL(ytUrl);
          if (canOpen) {
            await Linking.openURL(ytUrl);
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

  if (Platform.OS !== "web" && YoutubeIframe && videoId && !playerError) {
    return (
      <View style={[styles.container, { height: playerHeight }]}>
        {!playerReady && (
          <View style={[styles.loadingOverlay, { backgroundColor: "#0a0a0a" }]}>
            {thumb && <Image source={{ uri: thumb }} style={styles.thumbnail} resizeMode="cover" />}
            <View style={styles.loadingCenter}>
              <ActivityIndicator color={c.primary} size="large" />
              <Text style={[styles.loadingText, { color: "rgba(255,255,255,0.6)" }]}>Loading player...</Text>
            </View>
          </View>
        )}
        <YoutubeIframe
          videoId={videoId}
          height={playerHeight}
          play={playing}
          onChangeState={onChangeState}
          onReady={() => setPlayerReady(true)}
          onError={() => setPlayerError(true)}
          initialPlayerParams={{
            modestbranding: true,
            rel: false,
            preventFullScreen: false,
            cc_load_policy: false,
            iv_load_policy: 3,
          }}
          webViewProps={{
            allowsFullscreenVideo: true,
            allowsInlineMediaPlayback: true,
            mediaPlaybackRequiresUserAction: false,
            javaScriptEnabled: true,
            bounces: false,
          }}
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {thumb && (
        <Image source={{ uri: thumb }} style={styles.thumbnail} resizeMode="cover" />
      )}
      <View style={[styles.overlay, { backgroundColor: "rgba(0,0,0,0.38)" }]}>
        <Pressable
          onPress={openExternal}
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
        <Text style={styles.tapHint}>
          {Platform.OS === "web" ? "Opens on YouTube" : "Opens in YouTube app"}
        </Text>
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
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.5,
        shadowRadius: 12,
      },
      android: { elevation: 8 },
      web: { boxShadow: "0 4px 12px rgba(0,0,0,0.5)" },
    }),
  },
  tapHint: {
    color: "rgba(255,255,255,0.5)",
    fontSize: 12,
    fontFamily: "Inter_400Regular",
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  loadingCenter: {
    position: "absolute",
    alignItems: "center",
    gap: 10,
    backgroundColor: "rgba(0,0,0,0.5)",
    padding: 20,
    borderRadius: 12,
  },
  loadingText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
  },
});
