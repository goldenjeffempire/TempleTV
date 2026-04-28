# Deployment Guide

## Targets

The API is single-process, stateless, and horizontally scalable
(provided you set `REDIS_URL` so the cache + future event-bus run on
shared infrastructure). Below are the supported deploy targets.

## 1. Replit (development + staging)

The `Start application` workflow already does this:

```sh
pnpm install
pnpm --filter @workspace/db run push
pnpm --filter @workspace/api-server run build
PORT=8080 node --enable-source-maps \
  --import ./artifacts/api-server/dist/instrument.mjs \
  ./artifacts/api-server/dist/index.mjs
```

## 2. Render

`render.yaml` (root) describes the web service. Two env vars are
required at minimum:

- `DATABASE_URL`
- `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` (generate with `openssl rand -hex 64`)
- `S3_BUCKET` + AWS credentials for media uploads
- `REDIS_URL` if you want multi-instance fan-out

Recommended runtime flags (already in the deploy command):

```sh
MALLOC_ARENA_MAX=2 \
NODE_OPTIONS="--max-old-space-size=1536" \
node --enable-source-maps \
  --import ./dist/instrument.mjs \
  ./dist/index.mjs
```

## 3. Docker

```sh
docker build -f artifacts/api-server/Dockerfile -t templetv/api .
docker run -p 8080:8080 \
  -e DATABASE_URL=... \
  -e JWT_ACCESS_SECRET=... \
  -e JWT_REFRESH_SECRET=... \
  templetv/api
```

The image is multi-stage, alpine-based, runs as non-root, and ships a
`HEALTHCHECK` against `/healthz`.

## 4. Kubernetes (sketch)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: temple-tv-api }
spec:
  replicas: 3
  selector: { matchLabels: { app: temple-tv-api } }
  template:
    metadata: { labels: { app: temple-tv-api } }
    spec:
      containers:
      - name: api
        image: templetv/api:1.0.0
        ports: [{ containerPort: 8080 }]
        envFrom: [{ secretRef: { name: temple-tv-api-env } }]
        readinessProbe: { httpGet: { path: /readyz, port: 8080 } }
        livenessProbe:  { httpGet: { path: /healthz, port: 8080 } }
        resources:
          requests: { memory: "512Mi", cpu: "250m" }
          limits:   { memory: "2Gi",   cpu: "2"    }
```

Provision Redis and Postgres separately (managed services preferred).

## CI/CD

Recommended pipeline:

```
checkout
  → pnpm install --frozen-lockfile
  → pnpm --filter @workspace/api-server run typecheck
  → pnpm --filter @workspace/api-server run test
  → pnpm --filter @workspace/api-server run build
  → pnpm --filter @workspace/api-server run openapi   # publish contract
  → docker build --tag $REGISTRY/api:$GIT_SHA
  → docker push
  → deploy (Render webhook / kubectl apply / etc.)
```

## Database migrations

Schema lives in `lib/db/src/schema/` (Drizzle ORM). To apply:

```sh
pnpm --filter @workspace/db run push
```

`drizzle-kit push` is idempotent and inspects the live DB before
issuing DDL; safe to run on every deploy.

For destructive changes (column drops, type narrowing), generate a
migration file with `drizzle-kit generate` and review the SQL by hand.

## Rollback

The API is forward+backward compatible across one minor version
because routes are versioned at `/api/v1`. Roll back by redeploying
the previous image tag — no schema rollback required for additive
changes.
