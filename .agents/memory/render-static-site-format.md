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
