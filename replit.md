# Temple TV (JCTM) Broadcasting Platform

## Overview

A mobile broadcasting platform for Temple TV (JCTM) built with Expo/React Native. Features Live TV, Video-on-Demand sermon library, 24/7 Radio mode, push notifications, and continuous streaming engine.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **Mobile**: Expo (React Native) with expo-router
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **In-app player**: react-native-youtube-iframe (native only)
- **Notifications**: expo-notifications
- **Keyboard**: react-native-keyboard-controller v1.18.5 (pinned to expo-compatible version)

## App Structure

### Mobile App (`artifacts/mobile`)
- **Watch Tab** — Live stream banner, recent sermons, categorized sections (Faith, Healing, Deliverance, Worship, Teachings, Special Programs)
- **Library Tab** — Full sermon library with search (title/keyword/speaker), category filter, sort (Newest/Oldest/Popular), favorites, and watch history
- **Radio Tab** — Audio-only mode with disc animation, shuffle/loop controls, category filter, up-next queue
- **Settings Tab** — Playback settings, shuffle/loop, Live Alerts (separate from New Sermon Alerts), data saver, history management, Share app, Contact support

### Player Screen
- In-app YouTube video player (react-native-youtube-iframe on iOS/Android, external browser on web)
- Auto-advance to next related sermon when current video ends
- "Up Next" banner with quick-play button
- Favorites, share, watch history tracking
- Related sermons list

### MiniPlayer
- Floating persistent mini-player across all tabs
- Tappable — navigates to full player screen for the current sermon/live stream
- Play/pause control without leaving current tab

### Services
- **YouTube** (`services/youtube.ts`) — Live status, embed URLs, RSS feed
- **Notifications** (`services/notifications.native.ts`) — Push notifications for live alerts and new sermons; web-safe stub in `notifications.ts`

### Context
- **PlayerContext** — Queue management, shuffle mode, loop mode (none/one/all), play/pause/next/previous, data saver

### Design
- Dark mode with deep blacks (#000000) and Royal Purple (#6A0DAD / #9B30FF dark variant)
- Glassmorphism-style UI with semi-transparent containers
- Platform-specific shadow styles (ios/android/web) via Platform.select
- pointerEvents as style property (not prop) for React Native 0.81+ compatibility

## Content Categories
- Faith, Healing, Deliverance, Worship, Prophecy, Teachings, Special Programs

## Key Features Implemented
1. **In-app video player** — react-native-youtube-iframe with play/pause/fullscreen/quality
2. **Continuous Streaming Engine** — Zero dead-air auto-advance; PlayerContext is single source of truth:
   - Pre-computed `nextSermon` available before current video ends
   - Sequential and shuffle playback (Fisher-Yates stable shuffled queue)
   - Loop modes: None / Loop All / Loop One
   - `advanceToNext()` swaps video in-place — no screen navigation on auto-advance
   - Animated fade transition overlay between videos on native
3. **Push notifications** — Live service alerts and new sermon alerts (separate toggles)
4. **Sermon Library** — Search by title/keyword/speaker, filter by category, sort by newest/oldest/popular
5. **Radio Mode** — Background audio, category filter, shuffle/loop with proper animation lifecycle
6. **Player controls bar** — Skip forward/back, shuffle toggle, loop cycle — all in the player screen
7. **User personalization** — Favorites (AsyncStorage), watch history, history tracking
8. **MiniPlayer navigation** — Tap mini-player to open full player
9. **Share & Support** — Share app, contact support from Settings

## Continuous Streaming Engine Details
- **`PlayerContext.tsx`** manages: `currentSermon`, `nextSermon` (pre-computed), `queue`, `shuffledQueue`, `shufflePosition`, `loopMode`
- **`playNext()`** advances `shufflePosition` in shuffle mode (stable, avoids repeats); restarts shuffled queue when exhausted
- **`advanceToNext()`** — alias of `playNext()`, called from the player screen's `onEnd` callback
- **`playSermon(sermon, newQueue?)`** — registers a sermon and optionally replaces the queue
- **`YoutubePlayer.native.tsx`** uses `key={videoId}` to force clean iframe reinitialize; animated overlay fades in/out during transitions
- **`player.tsx`** watches `PlayerContext.currentSermon` via `useEffect` and updates `activeSermon` state in-place with a 150ms title fade animation

## App Store Configuration (`app.json`)
- **iOS bundle ID**: `com.templetv.jctm`
- **Android package**: `com.templetv.jctm`
- **URL scheme**: `templetv`
- **iOS background modes**: audio, fetch, remote-notification
- **Android permissions**: POST_NOTIFICATIONS, INTERNET, FOREGROUND_SERVICE, WAKE_LOCK
- **Notification icon/color**: purple (#6A0DAD) matching brand
- **supportsTablet**: true

## Running Services (Workflows)
- **Start application** — Expo dev server on port 18115 (mobile app)
- **API Server** — Express API server on port 8080 (YouTube RSS proxy for web)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

## Architecture Notes

### RSS Data Flow
- **Native (iOS/Android)**: Fetches YouTube RSS directly from `https://www.youtube.com/feeds/videos.xml?channel_id=...`
- **Web**: Proxies through API server at `/api/youtube/rss` to avoid CORS
- **Fallback**: Local `data/sermons.ts` fallback if RSS or network fails
- **Cache**: AsyncStorage caches RSS results for 10 minutes

### Category Auto-Detection
RSS videos are auto-categorized using keyword matching in `hooks/useYouTubeChannel.ts`. Keywords like "heal", "worship", "prophecy" map to categories.

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
