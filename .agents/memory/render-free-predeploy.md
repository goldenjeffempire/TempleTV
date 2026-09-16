---
name: Render free-tier migrations
description: Render free-tier web services reject preDeployCommand, so runtime schema pushes need a startup wrapper.
---

Render free-tier web services do not support `preDeployCommand`. Run idempotent database schema synchronization from the service startup command instead, after the build and with runtime environment variables available.

**Why:** Render rejects the entire Blueprint when `preDeployCommand` is present on a free-tier service.

**How to apply:** Keep the build focused on install, validation, and compilation; use a startup wrapper that runs the schema push and then `exec`s the API process.