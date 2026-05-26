# `@workspace/db` — Drizzle ORM schema & PostgreSQL client

Single source of truth for the Temple TV PostgreSQL schema. Owns all table definitions, the typed Drizzle client, and the schema-push script consumed by every other package.

---

## What this package exports

```ts
import { db, schema } from "@workspace/db";

// Individual tables (also re-exported from schema)
import { schema } from "@workspace/db";
schema.videosTable
schema.broadcastQueueTable
schema.transcodingJobsTable
// ... (see Tables section below)
```

`db` is a Drizzle client backed by a `pg` pool. It connects lazily on first use, reading `DATABASE_URL` (or the individual `PG*` env vars on Replit) from the environment. SSL is auto-negotiated for cloud providers.

---

## Tables

| Table | Key columns | Purpose |
|-------|------------|---------|
| `users` | `id`, `email`, `passwordHash`, `role`, `displayName` | Authenticated viewers and operators |
| `refresh_tokens` | `jti`, `tokenHash`, `userId`, `expiresAt` | Long-lived JWT refresh tokens, revocable per device |
| `managed_videos` | `id`, `title`, `hlsMasterUrl`, `localVideoUrl`, `transcodingStatus`, `youtubeId` | The full video catalog (YouTube imports + local uploads) |
| `transcoding_jobs` | `id`, `videoId`, `status`, `attempts`, `maxAttempts`, `nextRetryAt`, `progress` | FFmpeg HLS pipeline state — queued / processing / done / failed |
| `broadcast_queue` | `id`, `videoId`, `sortOrder`, `isActive`, `durationSecs` | 24/7 channel order |
| `broadcast_runtime_state` | `channelId`, `sequence`, `mode`, `currentItemId` | v2 orchestrator live state (one row per channel) |
| `broadcast_event_log` | `sequence`, `channelId`, `eventType`, `payload` | Ordered event log for WS/SSE replay on reconnect |
| `player_position_checkpoint` | `channelId`, `itemId`, `positionSecs` | Persisted playback position for crash recovery |
| `playlists` / `playlist_videos` | — | Curated collections, ordered |
| `series` | — | Sermon series groupings |
| `schedule` | `slotId`, `timeOfDay`, `dayOfWeek`, `playlistId` | Time-of-day broadcast slots |
| `live_overrides` | `id`, `channelId`, `sourceUrl`, `startsAt`, `endsAt` | Manual Go Live entries |
| `channels` | `id`, `slug`, `displayName` | Multi-channel metadata |
| `channel_graphics` | — | Lower-third and bug graphics per channel |
| `upload_sessions` | `id`, `videoId`, `totalChunks`, `uploadedChunks` | Chunked upload state tracker |
| `storage_blobs` | `key`, `size`, `contentType`, `data` | Replit DatabaseObjectStorage blobs |
| `notifications` | — | Sent push notification history |
| `scheduled_notifications` | `id`, `sendAt`, `status` | Future push deliveries |
| `push_tokens` | `token`, `userId`, `platform` | Registered Expo + web push tokens |
| `web_push_subscriptions` | — | Browser Web Push subscriptions |
| `device_watch_history` / `user_watch_history` | — | Cloud-synced watch history |
| `user_favorites` | — | Bookmarked videos |
| `device_link_codes` | `code`, `expiresAt` | TV ↔ mobile pairing codes |
| `chat` | `id`, `channelId`, `userId`, `message` | Live chat messages |
| `prayer_requests` | — | Viewer prayer submissions |
| `midnight_prayers` | — | Scheduled midnight prayer streams |
| `emergency_alerts` | — | Emergency broadcast alert state |
| `analytics` / `viewer_sessions` | — | View counts and watch-time |
| `rate_limit` | — | In-database rate-limit counters (Redis fallback) |
| `s3_upload_telemetry` | — | Upload performance metrics |
| `live_ingest_endpoints` | — | RTMP ingest metadata |
| `youtube_sync` | — | YouTube sync cursor + last-run metadata |
| `password_reset_tokens` | — | Password reset one-time tokens |
| `app_config` | `key`, `value` | Key-value application configuration |

Full column-level definitions live in `src/schema/` (one file per domain).

---

## Development

```bash
# Push schema directly to the local database (DEV ONLY — no migration history)
pnpm --filter @workspace/db run push

# Force-push (overrides conflict warnings)
pnpm --filter @workspace/db run push-force

# Typecheck
pnpm --filter @workspace/db run typecheck
```

For production schema changes, generate a migration first and review the SQL before applying:

```bash
pnpm --filter @workspace/db exec drizzle-kit generate
# review drizzle/ directory, then apply via your migration runner
```

---

## Source layout

```
lib/db/
├── drizzle.config.ts            ← drizzle-kit configuration
├── src/
│   ├── index.ts                 ← re-exports db client + schema namespace
│   ├── client.ts                ← lazy pg pool + Drizzle NodePostgres adapter
│   └── schema/
│       ├── index.ts             ← barrel re-export of all tables
│       ├── videos.ts
│       ├── broadcast-queue.ts
│       ├── broadcast-runtime-state.ts
│       ├── broadcast-event-log.ts
│       ├── transcoding.ts
│       ├── users.ts
│       ├── channels.ts
│       └── ... (one file per domain)
└── drizzle/                     ← generated migration SQL (when used)
```

---

## Environment

```env
DATABASE_URL=postgres://user:pass@host:5432/templetv
```

On Replit, `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` are set automatically and override `DATABASE_URL` at boot (handled in `artifacts/api-server/src/config/env.ts`).

---

## Schema change checklist

1. Edit the relevant file in `src/schema/`
2. Run `pnpm --filter @workspace/db run push` (dev) or generate a migration (production)
3. If any column is added to `managed_videos`, check `toDto()` in the videos module — nullable columns must be coerced to `""` (not added as `.nullable()` to the Zod schema)
4. Re-run `pnpm run typecheck:libs`

---

## Related

- [`@workspace/api-server`](../../artifacts/api-server/README.md) — sole direct consumer of `db`
- Project [README](../../README.md)
