# `@workspace/db` — Drizzle ORM schema & client

The single source of truth for the Temple TV PostgreSQL schema. Owns the
table definitions, the typed Drizzle client, and the schema-push script used
by every other package.

---

## 1. What this package exports

```ts
import {
  db,                       // Drizzle client (NodePostgres adapter)
  videosTable,              // and every other *Table
  playlistsTable,
  playlistVideosTable,
  scheduleTable,
  notificationsTable,
  scheduledNotificationsTable,
  pushTokensTable,
  liveOverridesTable,
  transcodingJobsTable,
  broadcastQueueTable,
  usersTable,
  refreshTokensTable,
  favoritesTable,
  watchHistoryTable,
  subscriptionTiersTable,
  userSubscriptionsTable,
} from "@workspace/db";
```

`db` is connected lazily on first use, reading `DATABASE_URL` from the
environment. SSL is auto-enabled for cloud Postgres providers.

---

## 2. Tables (high-level)

| Table | Purpose |
|---|---|
| `users` | Authenticated viewers (email, hashed password, display name) |
| `refresh_tokens` | Long-lived JWT refresh tokens, revocable per device |
| `videos` | The catalog — YouTube + locally uploaded videos |
| `playlists` / `playlist_videos` | Curated collections, ordered |
| `schedule` | Time-of-day broadcast slots (live / playlist / single video) |
| `broadcast_queue` | The 24/7 channel order |
| `live_overrides` | Manual “Go Live” entries (HLS or RTMP) with start / end |
| `transcoding_jobs` | FFmpeg pipeline state per video, per quality variant |
| `notifications` | Sent push history |
| `scheduled_notifications` | Future push deliveries |
| `push_tokens` | Registered Expo push tokens (one per device) |
| `favorites` / `watch_history` | Cloud-synced personalisation |
| `subscription_tiers` / `user_subscriptions` | Subscription plans + members |

Detailed column-level schema lives in `src/schema.ts`.

---

## 3. Working with the schema

```bash
# DEV ONLY — push schema directly (overwrites without migration history)
pnpm --filter @workspace/db run push
```

The `push` command uses `drizzle-kit push` against `DATABASE_URL`. For
production, use Drizzle's standard migration generator:

```bash
pnpm --filter @workspace/db exec drizzle-kit generate
# review the SQL in ./drizzle/, commit it, then apply via your migration runner
```

---

## 4. Source layout

```
lib/db/
├── package.json
├── tsconfig.json
├── drizzle.config.ts             ← drizzle-kit configuration
├── drizzle/                      ← generated migrations (when used)
└── src/
    ├── index.ts                  ← re-exports db + every table
    ├── client.ts                 ← lazy pg pool + Drizzle adapter
    └── schema.ts                 ← every pgTable definition
```

---

## 5. Required env

```env
DATABASE_URL=postgres://user:pass@host:5432/templetv
```

In production we use a Neon Postgres branch. Connection pooling and SSL
are negotiated automatically.

---

## 6. Related

- [`@workspace/api-server`](../../artifacts/api-server/README.md) — the only
  consumer of `db` directly.
- [`@workspace/api-zod`](../api-zod/README.md) — generates Zod from the
  schema via `drizzle-zod`.
- Project [README](../../README.md)
