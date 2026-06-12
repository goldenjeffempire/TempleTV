---
name: render.yaml SMTP + env defaults pattern
description: Non-sensitive env vars with known defaults must use value: not sync: false in render.yaml or they arrive as undefined on fresh deploys.
---

## Rule

Any `envVar` in `render.yaml` that has a sensible non-sensitive default must declare it with `value: "..."`. Using `sync: false` without a `value:` means the env var is entirely absent on a fresh Render deployment — the code's Zod `.default()` in `env.ts` will apply, but production pre-flight may log "missing vars" warnings and operators are left guessing.

**Affected keys (as of v1.0.20):**
- `SMTP_SECURE: "false"` (STARTTLS, port 587)
- `SMTP_FROM_NAME: "Temple TV | JCTM"`
- `QUEUE_MIN_ITEMS: "5"`
- `STORAGE_HEALTH_INTERVAL_MS: "120000"`

**Why:** The production deployment log showed `"missingVars":["SMTP_HOST","SMTP_USER"]` alongside the implicit absence of SMTP_SECURE and SMTP_FROM_NAME — all four were `sync: false`. SMTP_SECURE and SMTP_FROM_NAME have zero-sensitivity defaults; there is no reason to require manual operator setup for them.

**How to apply:** Before adding any new `sync: false` envVar entry to render.yaml, check whether `env.ts` declares a `.default()` for it. If yes, and the default is non-sensitive, use `value:` instead.

**Sensitive exceptions** (correctly remain `sync: false`): `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `CORS_ORIGINS`, `APP_BASE_URL` — these require site-specific values and must be operator-configured.
