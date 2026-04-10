# Temple TV (JCTM) Broadcasting Platform

## Overview

A mobile broadcasting platform for Temple TV (JCTM) built with Expo/React Native. Features Live TV, Video-on-Demand sermon library, and 24/7 Radio mode.

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

## App Structure

### Mobile App (`artifacts/mobile`)
- **Watch Tab** — Home screen with live stream banner, recent sermons, categorized content
- **Library Tab** — Full sermon library with search and category filtering (Faith, Healing, Deliverance, Worship, Prophecy)
- **Radio Tab** — Audio-only playback mode with controls, queue, data saver toggle
- **Components** — GlassCard, LiveBadge, SermonCard, MiniPlayer, CategoryPills, NowPlayingBar
- **Context** — PlayerContext manages playback state, queue, radio mode, data saver

### Design
- Dark mode with deep blacks (#000000) and Royal Purple (#6A0DAD)
- Glassmorphism-style UI with semi-transparent containers
- Neon pulse animation for live status indicator

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
