---
name: Render Blueprint static site format
description: Correct YAML format for static site services in render.yaml Blueprints — two wrong variants documented.
---

## The Rule

Render Blueprint static sites must use `type: web` + `env: static`. Neither `type: static` nor `type: web` + `runtime: static` is accepted.

```yaml
# CORRECT
- type: web
  name: my-static-site
  env: static
  branch: main
  buildCommand: pnpm --filter @workspace/admin run build
  staticPublishPath: ./artifacts/admin/dist/public
  envVars: ...
  headers: ...
  routes: ...

# WRONG — "unknown type 'static'"
- type: static
  name: my-static-site

# WRONG — Blueprint parse error (no message, just "issue found")
- type: web
  name: my-static-site
  runtime: static
```

**Why:** Render's Blueprint parser only recognises `type: web | worker | cron | pserv`. Static sites are web services with `env: static` — this routes the service through Render's static CDN pipeline instead of a dyno. `type: static` and `runtime: static` are not valid Blueprint schema values.

**How to apply:** Any time a render.yaml has a static site (admin SPA, TV SPA, Expo Web), it must use `type: web` + `env: static`. Dynamic Node.js services use `type: web` + `runtime: node`.

## Fields NOT supported on static services (`env: static`)

- `filter` / `filter.paths` — NOT supported on ANY service type in Render Blueprints (web, static, worker). Render's dashboard has a separate "Deploy Filters" UI for path-based triggers. Causes "field filter not found in type file.Service" on web services too.
- `runtime` — must be omitted entirely; `env: static` implies the build target.
- `plan` — static sites are always free; a `plan` field is ignored or rejected.
- `numInstances` — static sites are CDN-served, not instanced.
- `healthCheckPath` — only valid on web services with a running process.

## Fields supported on static services

`name`, `type: web`, `env: static`, `branch`, `rootDir`, `autoDeploy`, `pullRequestPreviewsEnabled`, `buildCommand`, `staticPublishPath`, `envVars`, `headers`, `routes`.
