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

## App Structure

### Mobile App (`artifacts/mobile`)
- **Watch Tab** — Live stream banner, recent sermons, categorized sections (Faith, Healing, Deliverance, Worship, Teachings, Special Programs)
- **Library Tab** — Full sermon library with search (title/keyword/speaker), category filter, sort (Newest/Oldest/Popular), favorites, and watch history
- **Radio Tab** — Audio-only mode with disc animation, shuffle/loop controls, category filter (Sermons, Worship, Teachings, etc.), up-next queue
- **Settings Tab** — Playback settings, shuffle/loop mode, notifications toggle, data saver, watch history management

### Player Screen
- In-app YouTube video player (react-native-youtube-iframe on iOS/Android, external browser on web)
- Auto-advance to next related sermon when current video ends
- "Up Next" banner with quick-play button
- Favorites, share, watch history tracking
- Related sermons list

### Services
- **YouTube** (`services/youtube.ts`) — Live status, embed URLs, RSS feed
- **Notifications** (`services/notifications.native.ts`) — Push notifications for live alerts and new sermons; web-safe stub in `notifications.ts`

### Context
- **PlayerContext** — Queue management, shuffle mode, loop mode (none/one/all), play/pause/next/previous

### Design
- Dark mode with deep blacks (#000000) and Royal Purple (#6A0DAD)
- Glassmorphism-style UI with semi-transparent containers
- Neon pulse animation for live status indicator

## Content Categories
- Faith, Healing, Deliverance, Worship, Prophecy, Teachings, Special Programs

## Key Features Implemented
1. **In-app video player** — react-native-youtube-iframe with play/pause/fullscreen/quality
2. **Auto-play next** — Video end triggers automatic next sermon
3. **Continuous streaming engine** — Queue with shuffle and loop modes
4. **Push notifications** — Live service alerts, new sermon alerts
5. **Sermon Library** — Search by title/keyword/speaker, filter by category, sort by newest/oldest/popular
6. **Radio Mode** — Background audio, category filter, shuffle/loop
7. **User personalization** — Favorites (AsyncStorage), watch history, history tracking
8. **Teachings & Special Programs** — New content categories added

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
