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
}

export type SermonCategory = "Faith" | "Healing" | "Deliverance" | "Worship" | "Prophecy" | "All";

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
