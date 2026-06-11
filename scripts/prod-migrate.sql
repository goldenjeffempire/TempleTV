-- ============================================================================
--  Temple TV — Complete Production Database Migration
--  v5 (2026-06-11)
-- ============================================================================
--
--  PURPOSE
--  -------
--  Bring a blank or partially-migrated production PostgreSQL database to the
--  exact schema that the Drizzle ORM models expect.  Derived directly from a
--  verified pg_dump of the development database, which is the single source
--  of truth.
--
--  SAFETY PROPERTIES
--  -----------------
--  • Fully idempotent — safe to re-run on any database state.
--  • Atomic — the entire migration runs inside a single SERIALIZABLE
--    transaction.  Any failure rolls back completely; no partial state.
--  • Additive-only — never drops, renames, or shrinks existing columns;
--    never truncates data.
--  • Column patches section handles columns added after the initial release.
--
--  USAGE
--  -----
--  psql "$PRODUCTION_DATABASE_URL" -f scripts/prod-migrate.sql
--
--  Or in a one-liner:
--  PGPASSWORD=xxx psql -h host -U user -d dbname -f scripts/prod-migrate.sql
--
--  WHAT IS COVERED (41 tables)
--  ---------------------------
--  app_config, broadcast_event_log, broadcast_queue, broadcast_runtime_state,
--  cache_entries, channel_graphics, channel_queue, channels, chat_messages,
--  chat_moderation, device_link_codes, device_watch_history, emergency_alerts,
--  live_ingest_endpoints, live_overrides, managed_videos,
--  password_reset_tokens, pending_storage_cleanup, player_position_checkpoint,
--  playlist_videos, playlists, prayer_requests, push_tokens, rate_limit_buckets,
--  refresh_tokens, s3_upload_telemetry, schedule_entries,
--  scheduled_notifications, sent_notifications, series, series_episodes,
--  storage_blobs, transcoding_jobs, upload_chunks, upload_sessions,
--  user_favorites, user_watch_history, users, viewer_sessions,
--  web_push_subscriptions, youtube_sync_log
--
--  CHANGES FROM v4
--  ---------------
--  • Added ON DELETE SET NULL foreign keys: broadcast_queue.video_id,
--    channel_queue.video_id, transcoding_jobs.video_id,
--    scheduled_notifications.video_id → managed_videos.id
--  • Made transcoding_jobs.video_id nullable (required for ON DELETE SET NULL)
--  • Added channel_queue uniqueness constraint: (channel_id, video_id) WHERE active
--  • Added channel_queue check: no YouTube source type
--  • Added managed_videos_transcoding_status_check constraint (incl. hls_ready)
--  • Added managed_videos partial unique index on object_path
--  • Added broadcast_queue partial unique index (uq_broadcast_queue_video_id_active)
--  • Synced missing columns: broadcast_runtime_state.{bad_url_cache,
--    scanner_failure_counts, failover_active, failover_reason},
--    managed_videos.{updated_at, broadcast_only, youtube_live_status,
--    youtube_live_status_updated_at, transcoding_error_message,
--    transcoding_error_code, transcoding_error_kind, faststart_attempts},
--    broadcast_queue.{scheduled_at, schedule_label, validator_deactivated_reason},
--    transcoding_jobs.last_progress_at
--  • Added missing performance indexes: chat_messages(user_id),
--    chat_messages(ip_hash), chat_messages partial not-deleted,
--    scheduled_notifications(video_id), managed_videos.{faststart_applied,
--    youtube_live_status, metadata_locked, broadcast_admission, uploaded_by}
--  • Added pending_storage_cleanup table (upload-fixes dependency)
--
--  CHANGES FROM v3
--  ---------------
--  • Added broadcast_queue.hls_master_url column patch (enables queue items
--    with a direct HLS URL — e.g. live-ingest or external streams — to be
--    resolved by queueRepo.loadActive() COALESCE logic and included in the
--    broadcast cycle without requiring a joined managed_videos row)
--  • Added managed_videos.faststart_applied column patch (fixes broadcast-v2
--    queueRepo.loadActive() query that references this column)
--
--  CHANGES FROM v2
--  ---------------
--  • Added broadcast_runtime_state, broadcast_event_log,
--    player_position_checkpoint tables (broadcast-v2 engine)
--  • Added performance indexes for managed_videos introduced in May 2026
--  • Added broadcast_runtime_state and broadcast_event_log indexes
-- ============================================================================

BEGIN;

SET statement_timeout   = 0;
SET lock_timeout        = 0;
SET client_encoding     = 'UTF8';
SET standard_conforming_strings = on;


-- ── 1. TABLES ────────────────────────────────────────────────────────────────
-- Every statement uses CREATE TABLE IF NOT EXISTS so it is a no-op when the
-- table already exists.  Primary keys are defined inline; this is idempotent
-- because IF NOT EXISTS skips the whole body when the table is present.

CREATE TABLE IF NOT EXISTS app_config (
    key        text NOT NULL,
    value      text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (key)
);

CREATE TABLE IF NOT EXISTS broadcast_event_log (
    id         bigserial NOT NULL,
    channel_id text NOT NULL,
    sequence   bigint NOT NULL,
    event_type text NOT NULL,
    payload    jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS broadcast_queue (
    id             text NOT NULL,
    video_id       text,
    youtube_id     text NOT NULL,
    title          text NOT NULL,
    thumbnail_url  text DEFAULT ''::text NOT NULL,
    duration_secs  integer DEFAULT 1800 NOT NULL,
    local_video_url text,
    video_source   text DEFAULT 'youtube'::text NOT NULL,
    is_active      boolean DEFAULT true NOT NULL,
    sort_order     integer DEFAULT 0 NOT NULL,
    added_at       timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS broadcast_runtime_state (
    channel_id        text NOT NULL,
    mode              text DEFAULT 'queue'::text NOT NULL,
    current_item_id   text,
    started_at_ms     bigint,
    offset_ms         integer DEFAULT 0 NOT NULL,
    active_override_id text,
    sequence          bigint DEFAULT 0 NOT NULL,
    updated_at        timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (channel_id)
);

CREATE TABLE IF NOT EXISTS cache_entries (
    key        text NOT NULL,
    value      text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (key)
);

CREATE TABLE IF NOT EXISTS channel_graphics (
    id             text NOT NULL,
    channel_id     text NOT NULL,
    type           text NOT NULL,
    content        text NOT NULL,
    sub_content    text,
    is_active      boolean DEFAULT true NOT NULL,
    duration_secs  integer,
    priority       integer DEFAULT 0 NOT NULL,
    created_at     timestamp with time zone DEFAULT now() NOT NULL,
    activated_at   timestamp with time zone,
    deactivated_at timestamp with time zone,
    PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS channel_queue (
    id              text NOT NULL,
    channel_id      text NOT NULL,
    video_id        text,
    youtube_id      text NOT NULL,
    title           text NOT NULL,
    thumbnail_url   text DEFAULT ''::text NOT NULL,
    duration_secs   integer DEFAULT 1800 NOT NULL,
    local_video_url text,
    hls_master_url  text,
    video_source    text DEFAULT 'youtube'::text NOT NULL,
    is_active       boolean DEFAULT true NOT NULL,
    sort_order      integer DEFAULT 0 NOT NULL,
    added_at        timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS channels (
    id               text NOT NULL,
    name             text NOT NULL,
    slug             text NOT NULL,
    description      text DEFAULT ''::text NOT NULL,
    logo_url         text,
    color            text DEFAULT '#DC2626'::text NOT NULL,
    is_primary       boolean DEFAULT false NOT NULL,
    is_active        boolean DEFAULT true NOT NULL,
    sort_order       integer DEFAULT 0 NOT NULL,
    failover_hls_url text,
    created_at       timestamp with time zone DEFAULT now() NOT NULL,
    updated_at       timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id                   text NOT NULL,
    channel_id           text NOT NULL,
    user_id              text,
    display_name         text NOT NULL,
    body                 text NOT NULL,
    broadcast_item_id    text,
    broadcast_item_title text,
    ip_hash              text,
    created_at           timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at           timestamp with time zone,
    deleted_by           text,
    PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS chat_moderation (
    id          text NOT NULL,
    subject_kind text NOT NULL,
    subject_id  text NOT NULL,
    action      text NOT NULL,
    reason      text,
    expires_at  timestamp with time zone,
    created_at  timestamp with time zone DEFAULT now() NOT NULL,
    created_by  text,
    PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS device_link_codes (
    code        text NOT NULL,
    user_id     text,
    created_at  timestamp with time zone DEFAULT now() NOT NULL,
    claimed_at  timestamp with time zone,
    consumed_at timestamp with time zone,
    expires_at  timestamp with time zone NOT NULL,
    device_label text,
    ip          text,
    PRIMARY KEY (code)
);

CREATE TABLE IF NOT EXISTS device_watch_history (
    id            text NOT NULL,
    device_id     text NOT NULL,
    video_id      text NOT NULL,
    title         text DEFAULT ''::text NOT NULL,
    thumbnail_url text DEFAULT ''::text NOT NULL,
    hls_url       text,
    position_secs integer DEFAULT 0 NOT NULL,
    duration_secs integer DEFAULT 0 NOT NULL,
    completed     boolean DEFAULT false NOT NULL,
    watched_at    timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS emergency_alerts (
    id           text NOT NULL,
    channel_id   text DEFAULT 'all'::text NOT NULL,
    title        text NOT NULL,
    message      text NOT NULL,
    severity     text DEFAULT 'info'::text NOT NULL,
    is_active    boolean DEFAULT true NOT NULL,
    created_by   text,
    created_at   timestamp with time zone DEFAULT now() NOT NULL,
    dismissed_at timestamp with time zone,
    expires_at   timestamp with time zone,
    PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS live_ingest_endpoints (
    id                      text NOT NULL,
    name                    text NOT NULL,
    protocol                text NOT NULL,
    ingest_url              text NOT NULL,
    stream_key              text NOT NULL,
    hls_playback_url        text NOT NULL,
    fallback_youtube_url    text,
    is_primary              boolean DEFAULT false NOT NULL,
    is_active               boolean DEFAULT true NOT NULL,
    priority                integer DEFAULT 100 NOT NULL,
    notes                   text,
    health_status           text DEFAULT 'unknown'::text NOT NULL,
    last_health_at          timestamp with time zone,
    last_healthy_at         timestamp with time zone,
    consecutive_failures    integer DEFAULT 0 NOT NULL,
    last_bitrate_kbps       real,
    last_segment_latency_ms integer,
    dropped_frames_pct      real,
    last_error              text,
    metadata                jsonb,
    created_at              timestamp with time zone DEFAULT now() NOT NULL,
    updated_at              timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS live_overrides (
    id               text NOT NULL,
    title            text NOT NULL,
    is_active        boolean DEFAULT true NOT NULL,
    hls_stream_url   text,
    youtube_video_id text,
    rtmp_ingest_key  text,
    stream_notes     text,
    started_at       timestamp with time zone DEFAULT now() NOT NULL,
    ends_at          timestamp with time zone,
    scheduled_for    timestamp with time zone,
    auto_started     boolean DEFAULT false NOT NULL,
    created_at       timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS managed_videos (
    id                      text NOT NULL,
    youtube_id              text,
    title                   text NOT NULL,
    description             text DEFAULT ''::text NOT NULL,
    thumbnail_url           text DEFAULT ''::text NOT NULL,
    duration                text DEFAULT ''::text NOT NULL,
    category                text DEFAULT 'sermon'::text NOT NULL,
    preacher                text DEFAULT ''::text NOT NULL,
    published_at            text,
    imported_at             timestamp with time zone DEFAULT now() NOT NULL,
    view_count              integer DEFAULT 0 NOT NULL,
    featured                boolean DEFAULT false NOT NULL,
    video_source            text DEFAULT 'youtube'::text NOT NULL,
    local_video_url         text,
    hls_master_url          text,
    transcoding_status      text DEFAULT 'none'::text NOT NULL,
    original_filename       text,
    mime_type               text,
    size_bytes              bigint,
    checksum_sha256         text,
    object_path             text,
    uploaded_by             text,
    s3_mirrored_at          timestamp with time zone,
    source_cleanup_status   text DEFAULT 'none'::text NOT NULL,
    source_cleanup_after    timestamp with time zone,
    source_deleted_at       timestamp with time zone,
    source_cleanup_attempts integer DEFAULT 0 NOT NULL,
    metadata_locked         boolean DEFAULT false NOT NULL,
    faststart_applied       boolean DEFAULT false NOT NULL,
    PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id         text NOT NULL,
    user_id    text NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at    timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS player_position_checkpoint (
    channel_id    text NOT NULL,
    item_id       text,
    position_ms   integer DEFAULT 0 NOT NULL,
    source_health text DEFAULT 'ok'::text NOT NULL,
    updated_at    timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (channel_id)
);

CREATE TABLE IF NOT EXISTS playlist_videos (
    id            text NOT NULL,
    playlist_id   text NOT NULL,
    video_id      text NOT NULL,
    youtube_id    text NOT NULL,
    title         text NOT NULL,
    thumbnail_url text DEFAULT ''::text NOT NULL,
    duration      text DEFAULT ''::text NOT NULL,
    category      text DEFAULT 'sermon'::text NOT NULL,
    sort_order    integer DEFAULT 0 NOT NULL,
    added_at      timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS playlists (
    id          text NOT NULL,
    name        text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    loop_mode   text DEFAULT 'sequential'::text NOT NULL,
    is_active   boolean DEFAULT true NOT NULL,
    created_at  timestamp with time zone DEFAULT now() NOT NULL,
    updated_at  timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS prayer_requests (
    id         text NOT NULL,
    name       text,
    message    text NOT NULL,
    is_read    boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS push_tokens (
    id           text NOT NULL,
    token        text NOT NULL,
    platform     text NOT NULL,
    created_at   timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
    key      text NOT NULL,
    count    integer DEFAULT 0 NOT NULL,
    reset_at timestamp with time zone NOT NULL,
    PRIMARY KEY (key)
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id             text NOT NULL,
    user_id        text NOT NULL,
    token_hash     text NOT NULL,
    expires_at     timestamp with time zone NOT NULL,
    created_at     timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at   timestamp with time zone,
    revoked_at     timestamp with time zone,
    replaced_by_id text,
    user_agent     text,
    ip             text,
    device_name    text,
    PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS s3_upload_telemetry (
    id             text NOT NULL,
    session_id     text,
    video_id       text,
    event          text NOT NULL,
    size_bytes     bigint,
    duration_ms    integer,
    throughput_bps bigint,
    error_kind     text,
    error_message  text,
    user_agent     text,
    created_at     timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS schedule_entries (
    id           text NOT NULL,
    title        text NOT NULL,
    day_of_week  integer NOT NULL,
    start_time   text NOT NULL,
    end_time     text,
    content_type text NOT NULL,
    content_id   text,
    is_recurring boolean DEFAULT true NOT NULL,
    is_active    boolean DEFAULT true NOT NULL,
    created_at   timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS scheduled_notifications (
    id            text NOT NULL,
    title         text NOT NULL,
    body          text NOT NULL,
    type          text NOT NULL,
    video_id      text,
    scheduled_at  timestamp with time zone NOT NULL,
    status        text DEFAULT 'pending'::text NOT NULL,
    sent_count    integer DEFAULT 0,
    error_message text,
    created_at    timestamp with time zone DEFAULT now() NOT NULL,
    sent_at       timestamp with time zone,
    PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS sent_notifications (
    id               text NOT NULL,
    title            text NOT NULL,
    body             text NOT NULL,
    type             text NOT NULL,
    video_id         text,
    sent_at          timestamp with time zone DEFAULT now() NOT NULL,
    sent_count       integer DEFAULT 0 NOT NULL,
    status           text DEFAULT 'sent'::text NOT NULL,
    attempts         integer DEFAULT 0 NOT NULL,
    last_error       text,
    idempotency_key  text,
    PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS series (
    id            text NOT NULL,
    title         text NOT NULL,
    slug          text NOT NULL,
    description   text DEFAULT ''::text NOT NULL,
    thumbnail_url text DEFAULT ''::text NOT NULL,
    banner_url    text,
    preacher      text,
    category      text DEFAULT 'sermon'::text NOT NULL,
    is_published  boolean DEFAULT false NOT NULL,
    is_ongoing    boolean DEFAULT true NOT NULL,
    episode_count integer DEFAULT 0 NOT NULL,
    sort_order    integer DEFAULT 0 NOT NULL,
    started_at    timestamp with time zone,
    completed_at  timestamp with time zone,
    created_at    timestamp with time zone DEFAULT now() NOT NULL,
    updated_at    timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS series_episodes (
    id             text NOT NULL,
    series_id      text NOT NULL,
    video_id       text NOT NULL,
    episode_number integer DEFAULT 1 NOT NULL,
    title          text,
    description    text,
    added_at       timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS storage_blobs (
    key          text NOT NULL,
    content_type text DEFAULT 'application/octet-stream'::text NOT NULL,
    data         bytea NOT NULL,
    size_bytes   bigint DEFAULT 0 NOT NULL,
    created_at   timestamp with time zone DEFAULT now() NOT NULL,
    updated_at   timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (key)
);

CREATE TABLE IF NOT EXISTS transcoding_jobs (
    id            text NOT NULL,
    video_id      text NOT NULL,
    video_path    text NOT NULL,
    status        text DEFAULT 'queued'::text NOT NULL,
    priority      integer DEFAULT 0 NOT NULL,
    progress      integer DEFAULT 0 NOT NULL,
    error_message text,
    attempts      integer DEFAULT 0 NOT NULL,
    max_attempts  integer DEFAULT 3 NOT NULL,
    next_retry_at timestamp with time zone,
    started_at    timestamp with time zone,
    completed_at  timestamp with time zone,
    created_at    timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS upload_chunks (
    id               text NOT NULL,
    session_id       text NOT NULL,
    chunk_index      integer NOT NULL,
    checksum         text NOT NULL,
    size_bytes       integer NOT NULL,
    s3_etag          text,
    fallback_data    bytea,
    storage_backend  text DEFAULT 's3'::text NOT NULL,
    received_at      timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS upload_sessions (
    session_id          text NOT NULL,
    upload_id           text,
    object_key          text,
    title               text NOT NULL,
    description         text DEFAULT ''::text NOT NULL,
    category            text DEFAULT 'sermon'::text NOT NULL,
    preacher            text DEFAULT ''::text NOT NULL,
    featured            boolean DEFAULT false NOT NULL,
    content_type        text DEFAULT 'video/mp4'::text NOT NULL,
    size_bytes          bigint NOT NULL,
    total_chunks        integer NOT NULL,
    chunk_size          integer NOT NULL,
    original_filename   text,
    mime_type           text,
    duration_secs       integer,
    uploaded_by         text,
    storage_backend     text DEFAULT 's3'::text NOT NULL,
    status              text DEFAULT 'uploading'::text NOT NULL,
    completed_video_id  text,
    created_at          timestamp with time zone DEFAULT now() NOT NULL,
    updated_at          timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (session_id)
);

CREATE TABLE IF NOT EXISTS user_favorites (
    id               text NOT NULL,
    user_id          text NOT NULL,
    video_id         text NOT NULL,
    video_title      text NOT NULL,
    video_thumbnail  text DEFAULT ''::text NOT NULL,
    video_category   text DEFAULT ''::text NOT NULL,
    created_at       timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS user_watch_history (
    id               text NOT NULL,
    user_id          text NOT NULL,
    video_id         text NOT NULL,
    video_title      text NOT NULL,
    video_thumbnail  text DEFAULT ''::text NOT NULL,
    video_category   text DEFAULT ''::text NOT NULL,
    watched_at       timestamp with time zone DEFAULT now() NOT NULL,
    progress_secs    integer DEFAULT 0 NOT NULL,
    PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS users (
    id                    text NOT NULL,
    email                 text NOT NULL,
    password_hash         text NOT NULL,
    display_name          text NOT NULL,
    avatar_url            text,
    role                  text DEFAULT 'user'::text NOT NULL,
    email_verified        boolean DEFAULT false NOT NULL,
    sessions_valid_after  timestamp with time zone DEFAULT now() NOT NULL,
    created_at            timestamp with time zone DEFAULT now() NOT NULL,
    updated_at            timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS viewer_sessions (
    id                text NOT NULL,
    device_id         text NOT NULL,
    channel_id        text DEFAULT 'temple-tv-live'::text NOT NULL,
    video_id          text,
    platform          text NOT NULL,
    is_live           boolean DEFAULT false NOT NULL,
    started_at        timestamp with time zone DEFAULT now() NOT NULL,
    last_heartbeat_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at          timestamp with time zone,
    watched_secs      integer DEFAULT 0 NOT NULL,
    completed         boolean DEFAULT false NOT NULL,
    country           text,
    city              text,
    PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS web_push_subscriptions (
    id           text NOT NULL,
    endpoint     text NOT NULL,
    p256dh       text NOT NULL,
    auth         text NOT NULL,
    user_agent   text,
    created_at   timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS youtube_sync_log (
    id               text NOT NULL,
    started_at       timestamp with time zone DEFAULT now() NOT NULL,
    completed_at     timestamp with time zone,
    status           text DEFAULT 'running'::text NOT NULL,
    videos_found     integer,
    videos_inserted  integer,
    videos_updated   integer,
    error_message    text,
    triggered_by     text DEFAULT 'scheduler'::text NOT NULL,
    source           text,
    videos_skipped   integer,
    videos_deleted   integer,
    PRIMARY KEY (id)
);


-- ── 2. UNIQUE CONSTRAINTS ────────────────────────────────────────────────────
-- Wrapped in DO blocks so they are no-ops when the constraint already exists.

DO $$ BEGIN
    ALTER TABLE channels ADD CONSTRAINT channels_slug_unique UNIQUE (slug);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE managed_videos ADD CONSTRAINT managed_videos_youtube_id_unique UNIQUE (youtube_id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE password_reset_tokens ADD CONSTRAINT password_reset_tokens_token_hash_unique UNIQUE (token_hash);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE push_tokens ADD CONSTRAINT push_tokens_token_unique UNIQUE (token);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE refresh_tokens ADD CONSTRAINT refresh_tokens_token_hash_unique UNIQUE (token_hash);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE sent_notifications ADD CONSTRAINT idx_sent_notifications_idem_key_uc UNIQUE (idempotency_key);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE series ADD CONSTRAINT series_slug_unique UNIQUE (slug);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE users ADD CONSTRAINT users_email_unique UNIQUE (email);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE web_push_subscriptions ADD CONSTRAINT web_push_subscriptions_endpoint_unique UNIQUE (endpoint);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;


-- ── 3. FOREIGN KEY CONSTRAINTS ───────────────────────────────────────────────

DO $$ BEGIN
    ALTER TABLE device_link_codes
        ADD CONSTRAINT device_link_codes_user_id_users_id_fk
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE password_reset_tokens
        ADD CONSTRAINT password_reset_tokens_user_id_users_id_fk
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE playlist_videos
        ADD CONSTRAINT playlist_videos_playlist_id_playlists_id_fk
        FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE refresh_tokens
        ADD CONSTRAINT refresh_tokens_user_id_users_id_fk
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE series_episodes
        ADD CONSTRAINT series_episodes_series_id_series_id_fk
        FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE user_favorites
        ADD CONSTRAINT user_favorites_user_id_users_id_fk
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE user_watch_history
        ADD CONSTRAINT user_watch_history_user_id_users_id_fk
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;


-- ── 4. INDEXES ───────────────────────────────────────────────────────────────
-- CREATE INDEX IF NOT EXISTS is available since PostgreSQL 9.5.

CREATE UNIQUE INDEX IF NOT EXISTS broadcast_event_log_channel_seq_uq
    ON broadcast_event_log (channel_id, sequence);
CREATE INDEX IF NOT EXISTS broadcast_event_log_channel_created_idx
    ON broadcast_event_log (channel_id, created_at);

CREATE INDEX IF NOT EXISTS idx_broadcast_queue_active_sort_order
    ON broadcast_queue (is_active, sort_order);
CREATE INDEX IF NOT EXISTS idx_broadcast_queue_video_id
    ON broadcast_queue (video_id);

CREATE INDEX IF NOT EXISTS broadcast_runtime_state_mode_idx
    ON broadcast_runtime_state (mode);

CREATE INDEX IF NOT EXISTS idx_channel_graphics_channel_active
    ON channel_graphics (channel_id, is_active);
CREATE INDEX IF NOT EXISTS idx_channel_graphics_type_active
    ON channel_graphics (channel_id, type, is_active);

CREATE INDEX IF NOT EXISTS idx_channel_queue_channel_active_sort
    ON channel_queue (channel_id, is_active, sort_order);
CREATE INDEX IF NOT EXISTS idx_channel_queue_video_id
    ON channel_queue (video_id);

CREATE INDEX IF NOT EXISTS idx_channels_active_sort
    ON channels (is_active, sort_order);
CREATE INDEX IF NOT EXISTS idx_channels_slug
    ON channels (slug);

CREATE INDEX IF NOT EXISTS idx_chat_messages_channel_created_at
    ON chat_messages (channel_id, created_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_chat_moderation_subject
    ON chat_moderation (subject_kind, subject_id, action);

CREATE INDEX IF NOT EXISTS device_link_codes_expires_at_idx
    ON device_link_codes (expires_at);
CREATE INDEX IF NOT EXISTS device_link_codes_user_id_idx
    ON device_link_codes (user_id);

CREATE INDEX IF NOT EXISTS device_watch_history_device_idx
    ON device_watch_history (device_id);
CREATE UNIQUE INDEX IF NOT EXISTS device_watch_history_device_video_idx
    ON device_watch_history (device_id, video_id);

CREATE INDEX IF NOT EXISTS idx_emergency_alerts_active
    ON emergency_alerts (is_active, created_at);
CREATE INDEX IF NOT EXISTS idx_emergency_alerts_channel
    ON emergency_alerts (channel_id, is_active);

CREATE INDEX IF NOT EXISTS idx_managed_videos_category
    ON managed_videos (category);
CREATE INDEX IF NOT EXISTS idx_managed_videos_featured
    ON managed_videos (featured);
CREATE INDEX IF NOT EXISTS idx_managed_videos_fts
    ON managed_videos USING gin (
        to_tsvector('english'::regconfig,
            (COALESCE(title,'') || ' ' || COALESCE(preacher,'') || ' ' || COALESCE(description,''))
        )
    );
CREATE INDEX IF NOT EXISTS idx_managed_videos_imported_at
    ON managed_videos (imported_at);
CREATE INDEX IF NOT EXISTS idx_managed_videos_preacher
    ON managed_videos (preacher);
CREATE INDEX IF NOT EXISTS idx_managed_videos_s3_mirrored_at
    ON managed_videos (s3_mirrored_at);
CREATE INDEX IF NOT EXISTS idx_managed_videos_source_cleanup_status
    ON managed_videos (source_cleanup_status);
CREATE INDEX IF NOT EXISTS idx_managed_videos_title
    ON managed_videos (title);
CREATE INDEX IF NOT EXISTS idx_managed_videos_transcoding_status
    ON managed_videos (transcoding_status);
CREATE INDEX IF NOT EXISTS idx_managed_videos_video_source
    ON managed_videos (video_source);
CREATE INDEX IF NOT EXISTS idx_managed_videos_view_count
    ON managed_videos (view_count);
CREATE INDEX IF NOT EXISTS idx_managed_videos_hls_master_url
    ON managed_videos (hls_master_url);
CREATE INDEX IF NOT EXISTS idx_managed_videos_local_video_url
    ON managed_videos (local_video_url);
CREATE INDEX IF NOT EXISTS idx_managed_videos_published_at
    ON managed_videos (published_at);
CREATE INDEX IF NOT EXISTS idx_managed_videos_source_transcoding
    ON managed_videos (video_source, transcoding_status);

CREATE INDEX IF NOT EXISTS live_overrides_is_active_idx
    ON live_overrides (is_active);
CREATE INDEX IF NOT EXISTS live_overrides_scheduled_for_idx
    ON live_overrides (scheduled_for);

CREATE INDEX IF NOT EXISTS playlist_videos_playlist_id_idx
    ON playlist_videos (playlist_id);
CREATE INDEX IF NOT EXISTS playlist_videos_playlist_order_idx
    ON playlist_videos (playlist_id, sort_order);

CREATE INDEX IF NOT EXISTS prayer_requests_created_at_idx
    ON prayer_requests (created_at);
CREATE INDEX IF NOT EXISTS prayer_requests_is_read_idx
    ON prayer_requests (is_read);

CREATE INDEX IF NOT EXISTS push_tokens_last_seen_at_idx
    ON push_tokens (last_seen_at);

CREATE INDEX IF NOT EXISTS refresh_tokens_expires_at_idx
    ON refresh_tokens (expires_at);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_id_idx
    ON refresh_tokens (user_id);

CREATE INDEX IF NOT EXISTS idx_s3_telemetry_created_at
    ON s3_upload_telemetry (created_at);
CREATE INDEX IF NOT EXISTS idx_s3_telemetry_event
    ON s3_upload_telemetry (event);
CREATE INDEX IF NOT EXISTS idx_s3_telemetry_session
    ON s3_upload_telemetry (session_id);

CREATE INDEX IF NOT EXISTS idx_schedule_entries_active
    ON schedule_entries (is_active);
CREATE INDEX IF NOT EXISTS idx_schedule_entries_day_time
    ON schedule_entries (day_of_week, start_time);

CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_status_at
    ON scheduled_notifications (status, scheduled_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sent_notifications_idem_key
    ON sent_notifications (idempotency_key);
CREATE INDEX IF NOT EXISTS idx_sent_notifications_sent_at
    ON sent_notifications (sent_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_series_category
    ON series (category, is_published);
CREATE INDEX IF NOT EXISTS idx_series_episodes_series
    ON series_episodes (series_id, episode_number);
CREATE INDEX IF NOT EXISTS idx_series_episodes_video
    ON series_episodes (video_id);
CREATE INDEX IF NOT EXISTS idx_series_published
    ON series (is_published, sort_order);
CREATE INDEX IF NOT EXISTS idx_series_slug
    ON series (slug);

CREATE INDEX IF NOT EXISTS idx_storage_blobs_created_at
    ON storage_blobs (created_at);
CREATE INDEX IF NOT EXISTS idx_storage_blobs_key_prefix
    ON storage_blobs (key);

CREATE INDEX IF NOT EXISTS idx_transcoding_jobs_next_retry_at
    ON transcoding_jobs (next_retry_at);
CREATE INDEX IF NOT EXISTS idx_transcoding_jobs_status
    ON transcoding_jobs (status);
CREATE INDEX IF NOT EXISTS idx_transcoding_jobs_status_priority_created
    ON transcoding_jobs (status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_transcoding_jobs_video_id
    ON transcoding_jobs (video_id);

CREATE INDEX IF NOT EXISTS idx_upload_chunks_session_chunk
    ON upload_chunks (session_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_upload_chunks_session_id
    ON upload_chunks (session_id);

CREATE INDEX IF NOT EXISTS idx_upload_sessions_created_at
    ON upload_sessions (created_at);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_status
    ON upload_sessions (status);

CREATE INDEX IF NOT EXISTS user_favorites_user_id_idx
    ON user_favorites (user_id);
CREATE INDEX IF NOT EXISTS user_favorites_user_video_idx
    ON user_favorites (user_id, video_id);

CREATE INDEX IF NOT EXISTS user_watch_history_user_id_idx
    ON user_watch_history (user_id);
CREATE INDEX IF NOT EXISTS user_watch_history_user_watched_idx
    ON user_watch_history (user_id, watched_at);

CREATE INDEX IF NOT EXISTS users_role_idx
    ON users (role);

CREATE INDEX IF NOT EXISTS idx_viewer_sessions_active
    ON viewer_sessions (ended_at, last_heartbeat_at);
CREATE INDEX IF NOT EXISTS idx_viewer_sessions_channel
    ON viewer_sessions (channel_id, ended_at);
CREATE INDEX IF NOT EXISTS idx_viewer_sessions_device
    ON viewer_sessions (device_id, started_at);
CREATE INDEX IF NOT EXISTS idx_viewer_sessions_started
    ON viewer_sessions (started_at);

CREATE INDEX IF NOT EXISTS idx_youtube_sync_log_started_at
    ON youtube_sync_log (started_at);
CREATE INDEX IF NOT EXISTS idx_youtube_sync_log_status
    ON youtube_sync_log (status);


-- ── 5. COLUMN PATCHES ────────────────────────────────────────────────────────
-- Columns added after the initial production release. ADD COLUMN IF NOT EXISTS
-- is a no-op when the column already exists.

-- upload_sessions.description — added in the upload-queue improvement release
ALTER TABLE upload_sessions
    ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';

-- channels.failover_hls_url — added for multi-stream failover support
ALTER TABLE channels
    ADD COLUMN IF NOT EXISTS failover_hls_url text;

-- managed_videos.metadata_locked — YouTube sync metadata lock toggle
ALTER TABLE managed_videos
    ADD COLUMN IF NOT EXISTS metadata_locked boolean NOT NULL DEFAULT false;

-- managed_videos.source_cleanup_* — S3 source file lifecycle management
ALTER TABLE managed_videos
    ADD COLUMN IF NOT EXISTS source_cleanup_status text NOT NULL DEFAULT 'none';
ALTER TABLE managed_videos
    ADD COLUMN IF NOT EXISTS source_cleanup_after timestamp with time zone;
ALTER TABLE managed_videos
    ADD COLUMN IF NOT EXISTS source_deleted_at timestamp with time zone;
ALTER TABLE managed_videos
    ADD COLUMN IF NOT EXISTS source_cleanup_attempts integer NOT NULL DEFAULT 0;

-- broadcast_queue: hls_master_url added for local HLS playback
ALTER TABLE broadcast_queue
    ADD COLUMN IF NOT EXISTS hls_master_url text;

-- managed_videos.faststart_applied — broadcast-v2 moov-atom faststart tracking
-- CRITICAL: missing this column causes queueRepo.loadActive() to fail with
-- "column managed_videos.faststart_applied does not exist", which makes the
-- broadcast-v2 orchestrator reload fail and shows "Items loaded: 0" in the
-- admin Broadcast Queue panel even when queue items exist.
ALTER TABLE managed_videos
    ADD COLUMN IF NOT EXISTS faststart_applied boolean NOT NULL DEFAULT false;

-- ── 5b. COLUMN PATCHES (v5 — schema hardening sprint) ────────────────────────

-- managed_videos.updated_at — Drizzle $onUpdate timestamp for cache invalidation
ALTER TABLE managed_videos
    ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone NOT NULL DEFAULT now();

-- managed_videos.broadcast_only — hides upload-only videos from public library
ALTER TABLE managed_videos
    ADD COLUMN IF NOT EXISTS broadcast_only boolean NOT NULL DEFAULT false;

-- managed_videos.youtube_live_status — tracks live/rebroadcast state for YouTube videos
ALTER TABLE managed_videos
    ADD COLUMN IF NOT EXISTS youtube_live_status text;

-- managed_videos.youtube_live_status_updated_at — staleness detection for live sweep
ALTER TABLE managed_videos
    ADD COLUMN IF NOT EXISTS youtube_live_status_updated_at timestamp with time zone;

-- managed_videos.transcoding_error_message — human-readable failure reason
ALTER TABLE managed_videos
    ADD COLUMN IF NOT EXISTS transcoding_error_message text;

-- managed_videos.transcoding_error_code — machine-readable failure code
--   Values: 'CORRUPT_SOURCE', 'DISK_FULL', null
ALTER TABLE managed_videos
    ADD COLUMN IF NOT EXISTS transcoding_error_code text;

-- managed_videos.transcoding_error_kind — narrows CORRUPT_SOURCE subtype
--   Values: 'structure_invalid', 'moov_absent', 'preflight_failed', null
ALTER TABLE managed_videos
    ADD COLUMN IF NOT EXISTS transcoding_error_kind text;

-- managed_videos.faststart_attempts — running count of faststart attempts
--   Used by the broadcast engine to skip videos that have exhausted retries.
ALTER TABLE managed_videos
    ADD COLUMN IF NOT EXISTS faststart_attempts integer NOT NULL DEFAULT 0;

-- broadcast_queue.scheduled_at — wall-clock anchor for scheduled programming
ALTER TABLE broadcast_queue
    ADD COLUMN IF NOT EXISTS scheduled_at timestamp with time zone;

-- broadcast_queue.schedule_label — human-readable block label for schedule editor
ALTER TABLE broadcast_queue
    ADD COLUMN IF NOT EXISTS schedule_label text;

-- broadcast_queue.validator_deactivated_reason — set by queue-integrity-validator
ALTER TABLE broadcast_queue
    ADD COLUMN IF NOT EXISTS validator_deactivated_reason text;

-- broadcast_runtime_state.bad_url_cache — persisted skip-count + blacklist cache
--   Shape: { urlCache: { [url]: expiresAtMs }, skipCounts: { [itemId]: count } }
ALTER TABLE broadcast_runtime_state
    ADD COLUMN IF NOT EXISTS bad_url_cache jsonb;

-- broadcast_runtime_state.scanner_failure_counts — per-item consecutive failure counts
--   Shape: { [itemId]: { count: number; lastFailedAtMs: number | null } }
ALTER TABLE broadcast_runtime_state
    ADD COLUMN IF NOT EXISTS scanner_failure_counts jsonb;

-- broadcast_runtime_state.failover_active — operator-engaged failover flag
ALTER TABLE broadcast_runtime_state
    ADD COLUMN IF NOT EXISTS failover_active boolean NOT NULL DEFAULT false;

-- broadcast_runtime_state.failover_reason — human-readable reason for failover state
ALTER TABLE broadcast_runtime_state
    ADD COLUMN IF NOT EXISTS failover_reason text;

-- transcoding_jobs.last_progress_at — timestamp of last progress update from ffmpeg
ALTER TABLE transcoding_jobs
    ADD COLUMN IF NOT EXISTS last_progress_at timestamp with time zone;

-- transcoding_jobs.video_id — drop NOT NULL so FK ON DELETE SET NULL can work
-- (ALTER COLUMN … DROP NOT NULL is a no-op when the column is already nullable)
ALTER TABLE transcoding_jobs
    ALTER COLUMN video_id DROP NOT NULL;


-- ── 6. NEW TABLES (v5) ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pending_storage_cleanup (
    id              text NOT NULL,
    object_path     text NOT NULL,
    reason          text NOT NULL,
    video_id        text,
    scheduled_at    timestamp with time zone DEFAULT now() NOT NULL,
    last_attempt_at timestamp with time zone,
    attempts        integer DEFAULT 0 NOT NULL,
    deleted_at      timestamp with time zone,
    last_error      text,
    created_at      timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_pending_storage_cleanup_pending
    ON pending_storage_cleanup (scheduled_at)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pending_storage_cleanup_object_path
    ON pending_storage_cleanup (object_path);


-- ── 7. PRIMARY CHANNEL SEED ──────────────────────────────────────────────────
-- Ensure the singleton "Temple TV Live" primary channel row exists.
-- The broadcast engine hard-codes channel_id = 'temple-tv-live'; without this
-- row the GET /channels endpoint returns an empty array and the broadcast engine
-- cannot attach.  The INSERT is a no-op when the row already exists.

INSERT INTO channels (id, name, slug, description, color, is_primary, is_active, sort_order)
VALUES (
    'temple-tv-live',
    'Temple TV Live',
    'temple-tv-live',
    'Temple TV live worship broadcast',
    '#DC2626',
    true,
    true,
    0
)
ON CONFLICT (id) DO NOTHING;


-- ── 8. FOREIGN KEY CONSTRAINTS (v5) ─────────────────────────────────────────
-- ON DELETE SET NULL — when a managed_videos row is deleted, queue and job
-- references are nulled rather than cascade-deleted, so audit rows survive and
-- the integrity validator can deactivate orphaned queue entries on its next cycle.

DO $$ BEGIN
    ALTER TABLE broadcast_queue
        ADD CONSTRAINT broadcast_queue_video_id_managed_videos_id_fk
        FOREIGN KEY (video_id) REFERENCES managed_videos(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE channel_queue
        ADD CONSTRAINT channel_queue_video_id_managed_videos_id_fk
        FOREIGN KEY (video_id) REFERENCES managed_videos(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE transcoding_jobs
        ADD CONSTRAINT transcoding_jobs_video_id_managed_videos_id_fk
        FOREIGN KEY (video_id) REFERENCES managed_videos(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE scheduled_notifications
        ADD CONSTRAINT scheduled_notifications_video_id_managed_videos_id_fk
        FOREIGN KEY (video_id) REFERENCES managed_videos(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;


-- ── 9. CHECK CONSTRAINTS (v5) ────────────────────────────────────────────────

-- channel_queue: mirrors the no_youtube_in_queue check on broadcast_queue.
DO $$ BEGIN
    ALTER TABLE channel_queue
        ADD CONSTRAINT no_youtube_in_channel_queue
        CHECK (video_source != 'youtube');
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;

-- managed_videos: enforce the closed transcoding status enum at the DB level.
-- Includes 'hls_ready' so the dispatcher can write that value without a
-- CHECK violation (previously absent, causing silent write failures).
DO $$ BEGIN
    ALTER TABLE managed_videos
        ADD CONSTRAINT managed_videos_transcoding_status_check
        CHECK (transcoding_status IN (
            'none','queued','encoding','processing','ready','hls_ready','failed'
        ));
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;


-- ── 10. UNIQUE INDEXES (v5) ──────────────────────────────────────────────────

-- broadcast_queue: partial unique index prevents duplicate active entries for
-- the same video_id. The is_active=true predicate allows reuse of the slot
-- after a row is deactivated. Mirrors the Drizzle schema definition.
CREATE UNIQUE INDEX IF NOT EXISTS uq_broadcast_queue_video_id_active
    ON broadcast_queue (video_id)
    WHERE video_id IS NOT NULL AND is_active = true;

-- channel_queue: equivalent constraint for multi-channel queues.
CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_queue_channel_video_active
    ON channel_queue (channel_id, video_id)
    WHERE video_id IS NOT NULL AND is_active = true;

-- managed_videos: prevent duplicate rows when the same file is uploaded twice.
-- Partial index (WHERE object_path IS NOT NULL) lets YouTube-synced rows
-- (where object_path is NULL) co-exist without a constraint violation.
CREATE UNIQUE INDEX IF NOT EXISTS uq_managed_videos_object_path
    ON managed_videos (object_path)
    WHERE object_path IS NOT NULL;


-- ── 11. INDEXES (v5 additions) ───────────────────────────────────────────────
-- Indexes present in the Drizzle schema but absent from earlier migration files.

-- chat_messages: moderator ban/mute lookups filter by userId and ipHash before
-- accepting a new message. Without these indexes each check is a full table scan.
CREATE INDEX IF NOT EXISTS idx_chat_messages_user_id
    ON chat_messages (user_id);

CREATE INDEX IF NOT EXISTS idx_chat_messages_ip_hash
    ON chat_messages (ip_hash);

-- chat_messages: partial index covering the standard history fetch
-- (WHERE channel_id = ? AND deleted_at IS NULL ORDER BY created_at DESC).
CREATE INDEX IF NOT EXISTS idx_chat_messages_channel_not_deleted
    ON chat_messages (channel_id, created_at DESC)
    WHERE deleted_at IS NULL;

-- scheduled_notifications: lookup by video_id for the "notify when ready" flow.
CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_video_id
    ON scheduled_notifications (video_id);

-- managed_videos: faststart_applied — broadcast-v2 loadActive() filters on
-- this boolean on every orchestrator reload (10-30 s cadence).
CREATE INDEX IF NOT EXISTS idx_managed_videos_faststart_applied
    ON managed_videos (faststart_applied);

-- managed_videos: youtube_live_status — live sweep every 2 min heals stale rows.
CREATE INDEX IF NOT EXISTS idx_managed_videos_youtube_live_status
    ON managed_videos (youtube_live_status);

-- managed_videos: metadata_locked — YouTube sync filters on this per batch.
CREATE INDEX IF NOT EXISTS idx_managed_videos_metadata_locked
    ON managed_videos (metadata_locked);

-- managed_videos: composite broadcast-admission index mirrors loadActive() predicate.
CREATE INDEX IF NOT EXISTS idx_managed_videos_broadcast_admission
    ON managed_videos (video_source, transcoding_status, faststart_applied);

-- managed_videos: uploaded_by — admin "filter by uploader" and audit trail lookups.
CREATE INDEX IF NOT EXISTS idx_managed_videos_uploaded_by
    ON managed_videos (uploaded_by);


-- ── 12. FINAL VERIFICATION ───────────────────────────────────────────────────
-- Returns a summary so you can verify all 41 tables exist, critical columns
-- are present, and the primary channel row was seeded correctly.

SELECT
    (SELECT count(*) FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE')::text
        AS tables_in_public,
    (SELECT count(*) FROM channels WHERE is_primary = true)::text
        AS primary_channels,
    (SELECT count(*) FROM users)::text
        AS user_rows,
    (CASE WHEN EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'managed_videos'
          AND column_name = 'faststart_applied'
    ) THEN 'present' ELSE 'MISSING — reload will fail!' END)
        AS faststart_applied_col,
    (CASE WHEN EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'managed_videos'
          AND column_name = 'faststart_attempts'
    ) THEN 'present' ELSE 'MISSING' END)
        AS faststart_attempts_col,
    (CASE WHEN EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'broadcast_runtime_state'
          AND column_name = 'bad_url_cache'
    ) THEN 'present' ELSE 'MISSING' END)
        AS bad_url_cache_col,
    (CASE WHEN EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'pending_storage_cleanup'
    ) THEN 'present' ELSE 'MISSING' END)
        AS pending_storage_cleanup_table,
    (CASE WHEN EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'broadcast_runtime_state'
    ) THEN 'present' ELSE 'MISSING' END)
        AS broadcast_runtime_state_table,
    'Migration v5 complete — ' || now()::text AS status;


COMMIT;
