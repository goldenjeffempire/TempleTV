import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
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
  const [activeVideoId, setActiveVideoId] = useState(videoId);
  const transitionOpacity = useRef(new Animated.Value(0)).current;
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (videoId && videoId !== activeVideoId) {
      setPlayerReady(false);
      setPlayerError(false);
      setPlaying(false);

      transitionOpacity.setValue(1);
      setActiveVideoId(videoId);

      requestAnimationFrame(() => {
        if (isMountedRef.current) {
          setPlaying(true);
        }
      });
    } else if (videoId && !activeVideoId) {
      setActiveVideoId(videoId);
      setPlaying(autoPlay);
    }
  }, [videoId]);

  const onPlayerReady = useCallback(() => {
    if (!isMountedRef.current) return;
    setPlayerReady(true);
    Animated.timing(transitionOpacity, {
      toValue: 0,
      duration: 350,
      useNativeDriver: true,
    }).start();
  }, [transitionOpacity]);

  const onChangeState = useCallback(
    (state: string) => {
      if (!isMountedRef.current) return;
      if (state === "ended") {
        setPlaying(false);
        onEnd?.();
      } else if (state === "playing") {
        setPlaying(true);
        onPlay?.();
        if (!playerReady) {
          setPlayerReady(true);
          Animated.timing(transitionOpacity, {
            toValue: 0,
            duration: 350,
            useNativeDriver: true,
          }).start();
        }
      } else if (state === "paused") {
        setPlaying(false);
        onPause?.();
      }
    },
    [onEnd, onPlay, onPause, playerReady, transitionOpacity],
  );

  const openExternal = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setLoading(true);
    try {
      let url: string;
      if (isLive) {
        url = `https://www.youtube.com/@${channelHandle}/live`;
      } else if (activeVideoId) {
        if (Platform.OS !== "web") {
          const ytUrl = `youtube://watch?v=${activeVideoId}`;
          const canOpen = await Linking.canOpenURL(ytUrl);
          if (canOpen) {
            await Linking.openURL(ytUrl);
            return;
          }
        }
        url = `https://www.youtube.com/watch?v=${activeVideoId}`;
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
      if (isMountedRef.current) setLoading(false);
    }
  };

  const playerHeight = Math.min(Math.round(width * (9 / 16)), 260);
  const thumb =
    thumbnailUrl ?? (activeVideoId ? `https://img.youtube.com/vi/${activeVideoId}/hqdefault.jpg` : null);

  if (Platform.OS !== "web" && YoutubeIframe && activeVideoId && !playerError) {
    return (
      <View style={[styles.container, { height: playerHeight }]}>
        <YoutubeIframe
          key={activeVideoId}
          videoId={activeVideoId}
          height={playerHeight}
          play={playing}
          onChangeState={onChangeState}
          onReady={onPlayerReady}
          onError={() => {
            if (isMountedRef.current) setPlayerError(true);
          }}
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

        <Animated.View
          style={[
            styles.transitionOverlay,
            { opacity: transitionOpacity },
          ]}
          pointerEvents="none"
        >
          {thumb && (
            <Image source={{ uri: thumb }} style={styles.thumbnail} resizeMode="cover" />
          )}
          <View style={[styles.loadingCenter, { backgroundColor: "rgba(0,0,0,0.5)" }]}>
            <ActivityIndicator color={c.primary} size="large" />
            <Text style={[styles.loadingText, { color: "rgba(255,255,255,0.6)" }]}>
              Loading next video...
            </Text>
          </View>
        </Animated.View>
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
  transitionOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#0a0a0a",
  },
  loadingCenter: {
    position: "absolute",
    alignItems: "center",
    gap: 10,
    padding: 20,
    borderRadius: 12,
  },
  loadingText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
  },
});
