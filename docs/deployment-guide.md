# Deployment Guide

## What exists today vs. what this guide covers

`docker-compose.yml` is the only deployment target actually built and
exercised so far — local development, and CI's `docker-build` job builds
the same image. There is no Terraform, no Kubernetes manifests, and no
cloud-specific configuration anywhere in this repo yet
(`infrastructure/terraform/` is still an empty scaffold). This guide
covers (a) running the Docker Compose stack correctly, since that's real,
and (b) what a first production deployment needs to actually change,
since "just run docker compose in prod" is not a real production
deployment — but it stops short of prescribing a specific cloud/orchestration
target this project hasn't chosen yet.

## Local / staging: Docker Compose

```bash
cp .env.example .env       # then edit — see below
docker compose up --build
docker compose exec api alembic upgrade head
docker compose exec api python -m scripts.seed_roles_permissions
docker compose exec api python -m scripts.seed_nigeria_business_registration
```

Services started: `api` (FastAPI, port 8000), `db` (Postgres 17, port
5432), `redis` (port 6379), `rabbitmq` (ports 5672/15672 — not yet
consumed by anything, see `docs/architecture.md`), `minio` (ports
9000/9001 — not yet consumed by anything either). Healthchecks are
configured on every service; `api` waits for `db`/`redis` to report
healthy before starting.

Verify:
```bash
curl -f http://localhost:8000/v1/health   # {"data":{"status":"healthy",...}}
curl -f http://localhost:8000/metrics     # Prometheus text format
```

## Before this touches production traffic

None of the following is built yet — this is the honest gap list, not a
claim that it's handled:

1. **Secrets.** `.env` is git-ignored and that's the extent of secret
   management today. `JWT_SECRET_KEY`, `POSTGRES_PASSWORD`,
   `MINIO_SECRET_KEY` all need to come from a real secrets manager (AWS
   Secrets Manager / GCP Secret Manager / Vault / your platform's
   equivalent) in any environment that isn't a single developer's laptop.
   `config.py`'s `Settings` reads from environment variables regardless of
   *where* those variables come from, so this is a deployment-platform
   change, not an application-code change.
2. **TLS.** The app itself serves plain HTTP. `SecurityHeadersMiddleware`
   sends `Strict-Transport-Security` unconditionally (browsers ignore it
   over plain HTTP per the HSTS spec, so this is safe to leave as-is), but
   actual TLS termination needs to happen at a load balancer/reverse proxy
   in front of this — nothing in this repo does that today.
3. **Migrations as a deploy step, not a manual command.** `alembic upgrade
   head` is currently something a human runs by hand
   (`docker compose exec api alembic upgrade head`). A real deploy
   pipeline needs this as an automated pre-deploy or init-container step,
   with a rollback plan if a migration fails partway.
4. **Multiple API replicas.** Nothing in the current design assumes a
   single instance — sessions are per-request, JWT validation is
   stateless, rate limiting is Redis-backed (shared across replicas by
   construction, not per-process) — but this has never actually been
   tested with more than one `api` container running, and
   `docker-compose.yml` only ever starts one.
5. **Database connection pooling at scale.** `create_async_engine` uses
   SQLAlchemy's default pool settings. Fine for development; a real
   production load profile needs actual sizing (`pool_size`,
   `max_overflow`) based on real traffic, not defaults.
6. **Log shipping.** Logs are structured JSON to stdout
   (`core/logging.py`) — correct *input* for Loki/CloudWatch/Datadog/etc.,
   but nothing ships them anywhere yet; that's still a platform-level
   configuration, not application code.
7. **A real Prometheus + Grafana deployment.** `GET /metrics` exists and
   is correct (Milestone 6); `infrastructure/monitoring/prometheus.yml` is
   a sample config for a local Prometheus, not a deployed one. No
   dashboards, no alerting rules exist yet.

## Environment variables reference

See `.env.example` for the full list with inline documentation. The ones
most likely to need real values (not the checked-in defaults) before any
non-local deployment:

| Variable | Why it must change |
|---|---|
| `JWT_SECRET_KEY` | Default is `insecure-dev-secret-change-me` in `config.py`. Anyone with this value can forge valid access tokens for any user. |
| `POSTGRES_PASSWORD` | Default is a placeholder. |
| `MINIO_SECRET_KEY` | Same. |
| `CORS_ALLOWED_ORIGINS` | Default is `http://localhost:3000` (the not-yet-built frontend's dev URL). |
| `APP_ENV` | Controls `debug`/SQL echo behavior via `Settings.is_production`; should be `production`, not the default `development`. |

## Database migrations

```bash
# Apply all pending migrations
alembic upgrade head

# Roll back the most recent migration
alembic downgrade -1

# Generate a new migration after changing models (review the output —
# autogenerate is a starting point, not a guarantee)
alembic revision --autogenerate -m "describe the change"
```

Current migration chain (see `alembic/versions/`, or run `alembic
history`): knowledge domain schema → auth domain schema → search vector
column. Each was written and reviewed against the models it corresponds
to; see each milestone's commit message for what was specifically
verified before it was considered done.
