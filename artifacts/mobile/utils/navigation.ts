import { router } from "expo-router";
import type { Sermon } from "@/types";

export function navigateToSermon(
  sermon: Sermon,
  extraParams: Record<string, string> = {},
) {
  if (sermon.videoSource === "local" && sermon.localVideoUrl) {
    router.push({
      pathname: "/player",
      params: {
        localVideoUrl: sermon.localVideoUrl,
        title: sermon.title,
        preacher: sermon.preacher,
        duration: sermon.duration,
        thumbnail: sermon.thumbnailUrl,
        category: sermon.category,
        ...extraParams,
      },
    });
  } else {
    router.push({
      pathname: "/player",
      params: {
        videoId: sermon.youtubeId,
        title: sermon.title,
        preacher: sermon.preacher,
        duration: sermon.duration,
        thumbnail: sermon.thumbnailUrl,
        category: sermon.category,
        ...extraParams,
      },
    });
  }
}
