export interface Sermon {
  id: string;
  title: string;
  description: string;
  youtubeId: string;
  thumbnailUrl: string;
  duration: string;
  category: SermonCategory;
  preacher: string;
  date: string;
  views?: number;
  videoSource?: "youtube" | "local";
  /** HLS master playlist URL, if the video has been transcoded. Takes precedence over localVideoUrl for playback. */
  hlsMasterUrl?: string;
  /** Raw upload/legacy URL. Prefer hlsMasterUrl when both are present. Populated by useVideos as hlsMasterUrl ?? localVideoUrl. */
  localVideoUrl?: string;
}

export type SermonCategory =
  | "Deliverance"
  | "Sermons"
  | "Prayers"
  | "Crusades"
  | "Conferences"
  | "Testimonies"
  | "All";

export interface PlaybackState {
  currentSermon: Sermon | null;
  isPlaying: boolean;
  isRadioMode: boolean;
  isLive: boolean;
  queue: Sermon[];
  currentIndex: number;
}

export interface LiveStatus {
  isLive: boolean;
  liveVideoId: string | null;
  liveTitle: string | null;
}

export type SortMode = "newest" | "oldest" | "popular";
export type LoopMode = "none" | "one" | "all";

export interface PlayerNavParams {
  id: string;
  title: string;
  youtubeId?: string;
  hlsUrl?: string;
  thumbnailUrl?: string;
  preacher?: string;
  duration?: string;
  category?: string;
  description?: string;
  isLive?: string;
  startPositionSecs?: string;
}
