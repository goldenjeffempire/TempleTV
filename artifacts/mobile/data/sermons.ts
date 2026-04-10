import type { Sermon } from "@/types";
import { getThumbnailUrl } from "@/services/youtube";

const makeThumb = (id: string) => getThumbnailUrl(id, "hq");

export const SERMONS: Sermon[] = [
  {
    id: "1",
    title: "Walking by Faith, Not by Sight",
    description:
      "A powerful message on trusting God even when the path is unclear. Prophet Amos delivers a stirring word on the foundations of faith that will strengthen your walk with God.",
    youtubeId: "MCNxWsGMR7c",
    thumbnailUrl: makeThumb("MCNxWsGMR7c"),
    duration: "1:23:45",
    category: "Faith",
    preacher: "Prophet Amos",
    date: "2026-03-15",
  },
  {
    id: "2",
    title: "The Healing Power of Prayer",
    description:
      "Discover the transformative power of prayer in healing. A testimony-filled service with demonstrations of God's healing power that will increase your faith for miracles.",
    youtubeId: "ZbZSe6N_BXs",
    thumbnailUrl: makeThumb("ZbZSe6N_BXs"),
    duration: "1:45:00",
    category: "Healing",
    preacher: "Prophet Amos",
    date: "2026-03-08",
  },
  {
    id: "3",
    title: "Breaking Every Chain",
    description:
      "A deliverance session that will set you free from every bondage. Come expecting your breakthrough as Prophet Amos ministers with power and authority.",
    youtubeId: "kffacxfA7G4",
    thumbnailUrl: makeThumb("kffacxfA7G4"),
    duration: "2:10:30",
    category: "Deliverance",
    preacher: "Prophet Amos",
    date: "2026-02-28",
  },
  {
    id: "4",
    title: "Atmosphere of Worship",
    description:
      "Enter into deep worship and experience the presence of God. A special worship session with the Temple TV worship team that will transform your atmosphere.",
    youtubeId: "iYYRH4apXDo",
    thumbnailUrl: makeThumb("iYYRH4apXDo"),
    duration: "1:30:00",
    category: "Worship",
    preacher: "Temple TV Worship Team",
    date: "2026-02-20",
  },
  {
    id: "5",
    title: "The Voice of the Prophet",
    description:
      "A prophetic word for the nations. Prophet Amos speaks about what the Lord is revealing for this season and how believers can position themselves for divine favor.",
    youtubeId: "vNqNnQ79S_8",
    thumbnailUrl: makeThumb("vNqNnQ79S_8"),
    duration: "1:55:15",
    category: "Prophecy",
    preacher: "Prophet Amos",
    date: "2026-02-14",
  },
  {
    id: "6",
    title: "Foundations of Unshakeable Faith",
    description:
      "Learn to build your faith on the solid rock. This message will strengthen your spiritual foundations and equip you to stand in the day of adversity.",
    youtubeId: "SWEkHp33R84",
    thumbnailUrl: makeThumb("SWEkHp33R84"),
    duration: "1:15:00",
    category: "Faith",
    preacher: "Prophet Amos",
    date: "2026-02-07",
  },
  {
    id: "7",
    title: "Divine Health Declaration",
    description:
      "Declare healing scriptures and receive your healing. A powerful session of faith declarations that activates the healing power of God in your life.",
    youtubeId: "DL7-CKirWZE",
    thumbnailUrl: makeThumb("DL7-CKirWZE"),
    duration: "1:40:20",
    category: "Healing",
    preacher: "Prophet Amos",
    date: "2026-01-30",
  },
  {
    id: "8",
    title: "Freedom from Generational Curses",
    description:
      "Break free from generational patterns and step into your divine destiny. A life-changing deliverance message that brings permanent freedom.",
    youtubeId: "2Vv-BfVoq4g",
    thumbnailUrl: makeThumb("2Vv-BfVoq4g"),
    duration: "2:05:00",
    category: "Deliverance",
    preacher: "Prophet Amos",
    date: "2026-01-22",
  },
  {
    id: "9",
    title: "Prophetic Fire Service",
    description:
      "An intense prophetic service where the fire of God falls. Expect personal prophetic words, breakthroughs, and supernatural encounters.",
    youtubeId: "QH2-TGUlwu4",
    thumbnailUrl: makeThumb("QH2-TGUlwu4"),
    duration: "3:15:00",
    category: "Prophecy",
    preacher: "Prophet Amos",
    date: "2026-01-15",
  },
  {
    id: "10",
    title: "The Power of Praise",
    description:
      "Discover how praise unlocks heaven's doors and defeats the enemy. A dynamic worship message that will transform your prayer life.",
    youtubeId: "cnqU7wCB1-c",
    thumbnailUrl: makeThumb("cnqU7wCB1-c"),
    duration: "1:20:00",
    category: "Worship",
    preacher: "Temple TV Worship Team",
    date: "2026-01-08",
  },
];

export const CATEGORIES = ["All", "Faith", "Healing", "Deliverance", "Worship", "Prophecy"] as const;

export const JCTM_CHANNEL_ID = "UCsXVk37biltHxV1aGl-AAxg";
