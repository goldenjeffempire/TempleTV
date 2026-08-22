---
name: Managed artifact workflow bootstrap
description: How to handle pnpm install collisions in artifact-managed Replit workflows.
---

Artifact-managed workflows prepend their own workspace-level `pnpm install --ignore-scripts` bootstrap and reject direct command overrides. A matching `.replit` workflow edit does not replace the managed artifact command.

**Why:** Starting several artifact workflows together can make their shared pnpm installs race and fail with `ERR_PNPM_ENOTEMPTY`. Trying to remove the install through workflow configuration or `.replit` creates an ineffective change because the artifact owns the runtime command.

**How to apply:** When an artifact fails with this pnpm rename collision, let competing installs settle and restart the affected managed workflow by its exact name. Revert any ineffective `.replit` or lockfile normalization drift. Treat a successful serialized restart as recovery unless the artifact bootstrap itself reports a repeatable package error.