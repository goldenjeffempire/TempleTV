-- =============================================================================
-- Temple TV — PostgreSQL initialization script
-- =============================================================================
-- Runs once inside the Docker postgres container on first boot.
-- (Mounted at /docker-entrypoint-initdb.d/init.sql via docker-compose.prod.yml)
--
-- This script is idempotent — safe to re-run on a clean volume.
-- For schema migrations after first boot, use: pnpm --filter @workspace/db run push
-- =============================================================================

-- Enforce UTF-8 (sanity check — postgres image defaults to UTF-8)
SET client_encoding = 'UTF8';

-- Extensions required by the application
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";     -- trigram index for full-text search
CREATE EXTENSION IF NOT EXISTS "btree_gin";   -- GIN index on regular columns

-- Performance tuning for the Temple TV workload
-- (Tune per your host RAM; these are conservative defaults for 1–2 GiB RAM)
ALTER SYSTEM SET shared_buffers         = '256MB';
ALTER SYSTEM SET effective_cache_size   = '768MB';
ALTER SYSTEM SET maintenance_work_mem   = '64MB';
ALTER SYSTEM SET checkpoint_completion_target = '0.9';
ALTER SYSTEM SET wal_buffers            = '16MB';
ALTER SYSTEM SET default_statistics_target    = '100';
ALTER SYSTEM SET random_page_cost       = '1.1';   -- SSD host assumed
ALTER SYSTEM SET effective_io_concurrency      = '200';
ALTER SYSTEM SET work_mem               = '8MB';
ALTER SYSTEM SET max_connections        = '100';

-- Logging — write slow queries (≥500 ms) to the log for visibility
ALTER SYSTEM SET log_min_duration_statement = '500';
ALTER SYSTEM SET log_line_prefix = '%t [%p]: db=%d,user=%u,app=%a ';

-- Apply changes (requires superuser on the initdb user)
SELECT pg_reload_conf();

-- Grant full privileges to the application user on the database
-- ($POSTGRES_USER is set by the Docker entrypoint; it owns the DB by default)
DO $$
BEGIN
  IF current_user <> 'templetv' THEN
    GRANT ALL PRIVILEGES ON DATABASE templetv TO templetv;
  END IF;
END;
$$;
